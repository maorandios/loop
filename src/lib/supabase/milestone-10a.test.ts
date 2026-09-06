import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");
}

function functionBody(sql: string, signatureStart: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${signatureStart}`);
  if (start === -1) {
    return "";
  }
  const end = sql.indexOf("$$;", start);
  if (end === -1) {
    return "";
  }
  return sql.slice(start, end + 3);
}

const setup = () => read("supabase/manual-setup.sql");
const patch = () => read("supabase/manual-patch-m10a.sql");
const fix1 = () => read("supabase/manual-patch-m10a-fix1.sql");

function storagePolicy(sql: string, name: string): string {
  const match = sql.match(new RegExp(`CREATE POLICY ${name}[\\s\\S]*?;`));
  return match?.[0] ?? "";
}

const M10A_BODIES = [
  "private.handoff_readable(p_handoff_id uuid)",
  "private.claim_command_receipt(",
  "private.handoffs_active_transfer_status_ok()",
  "private.handoff_transfers_active_status_ok()",
  "private.can_upload_handoff_object(object_name text)",
  "private.can_delete_handoff_object(object_name text)",
  "public.create_handoff_v2(",
  "public.finalize_handoff_v2_initial(",
  "public.fail_handoff_v2_initial(",
  "public.retry_handoff_v2_initial(",
  "public.send_transfer_reminder(",
] as const;

const GUARDED_RPCS = [
  "public.finalize_handoff_v1(",
  "public.fail_handoff(handoff_id uuid)",
  "public.mark_handoff_received(handoff_id uuid)",
  "public.mark_handoff_opened(handoff_id uuid)",
  "public.mark_handoff_modified(handoff_id uuid)",
  "public.mark_handoff_unmodified(handoff_id uuid)",
  "public.begin_handoff_return(handoff_id uuid)",
  "public.begin_handoff_return_next(handoff_id uuid)",
  "public.finalize_handoff_return_v2(",
  "public.fail_handoff_return(handoff_id uuid)",
  "public.mark_return_received(handoff_id uuid)",
  "public.finalize_handoff_return(",
  "public.complete_handoff(handoff_id uuid)",
  "public.request_revision(handoff_id uuid, note text)",
] as const;

describe("Milestone 10A SQL files", () => {
  it("keeps an idempotent patch and a full M10A setup", () => {
    const sql = setup();
    const m10a = patch();
    expect(m10a).toContain("BEGIN;");
    expect(m10a).toContain("COMMIT;");
    expect(m10a).not.toContain("service_role");
    expect(m10a).not.toContain("DROP FUNCTION");
    expect(m10a).toContain("ADD COLUMN IF NOT EXISTS flow_version");
    expect(m10a).toContain("CREATE TABLE IF NOT EXISTS public.handoff_transfers");
    expect(m10a).toContain("CREATE TABLE IF NOT EXISTS public.handoff_command_receipts");
    expect(m10a).toContain("WHERE NOT EXISTS");
    expect(m10a).toContain("AND t.parent_transfer_id IS NULL");
    expect(m10a).toContain("AND h.active_transfer_id IS NULL");
    expect(sql).toContain("flow_version smallint NOT NULL DEFAULT 1");
    expect(sql).toContain("CONSTRAINT handoffs_flow_status_check");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.handoff_transfers");
    const m10aFix1 = fix1();
    expect(m10aFix1).toContain("BEGIN;");
    expect(m10aFix1).toContain("COMMIT;");
    expect(m10aFix1).not.toContain("service_role");
    expect(m10aFix1).not.toContain("DROP FUNCTION");
    expect(m10aFix1).not.toContain("WHERE NOT EXISTS");
    expect(m10aFix1).not.toContain("UPDATE public.handoffs");
    expect(m10aFix1).not.toContain("UPDATE public.handoff_transfers");
    expect(m10aFix1).not.toContain("DELETE FROM storage.objects");
    expect(m10aFix1).toContain("CREATE POLICY filerelay_storage_select_for_delete");
  });

  it("matches M10A function bodies between setup and patch", () => {
    const sql = setup();
    const m10a = patch();
    for (const name of M10A_BODIES) {
      if (name === "public.finalize_handoff_v2_initial(") {
        continue;
      }
      const fromSetup = functionBody(sql, name);
      const fromPatch = functionBody(m10a, name);
      expect(fromSetup.length).toBeGreaterThan(80);
      expect(fromPatch).toBe(fromSetup);
    }
  });

  it("does not rewrite versions, storage paths, or existing events in the patch", () => {
    const m10a = patch();
    expect(m10a).not.toContain("UPDATE public.handoff_versions");
    expect(m10a).not.toContain("DELETE FROM public.handoff_versions");
    expect(m10a).not.toContain("DELETE FROM public.handoff_events");
    expect(m10a).not.toContain("DELETE FROM storage.objects");
    expect(m10a).not.toContain("UPDATE storage.objects");
    expect(m10a).not.toMatch(/awaiting[_]?review/i);
  });
});

describe("M10A schema and constraints", () => {
  it("requires v2 open requests to hold an active transfer pointer", () => {
    for (const source of [setup(), patch()]) {
      expect(source).toContain("request_status = 'open'");
      expect(source).toContain("active_transfer_id IS NOT NULL");
      expect(source).toContain("DEFERRABLE INITIALLY DEFERRED");
      expect(source).toContain("handoffs_active_transfer_belonging_fkey");
      expect(source).not.toContain("CHECK (...) DEFERRABLE");
    }
  });

  it("creates belonging FKs, one root hop, and one live hop", () => {
    for (const source of [setup(), patch()]) {
      expect(source).toContain("handoff_transfers_parent_belonging_fkey");
      expect(source).toContain("handoff_transfers_result_version_fkey");
      expect(source).toContain("handoff_events_transfer_belonging_fkey");
      expect(source).toContain("handoff_transfers_one_root_key");
      expect(source).toContain("handoff_transfers_one_live_key");
      expect(source).toContain("WHERE parent_transfer_id IS NULL");
    }
  });

  it("stores a precise reservation on the hop", () => {
    for (const source of [setup(), patch()]) {
      expect(source).toContain("pending_object_id");
      expect(source).toContain("pending_version_number");
      expect(source).toContain("pending_storage_path");
      expect(source).toContain("pending_upload_expires_at");
    }
  });
});

describe("M10A RPCs and idempotency", () => {
  it("creates v2 atomically with a pre-generated pointer and reservation", () => {
    const create = functionBody(setup(), "public.create_handoff_v2(");
    expect(create).toContain("private.claim_command_receipt(");
    expect(create).toContain("'create_handoff_v2'");
    expect(create).toContain("active_transfer_id");
    expect(create).toContain("v_transfer_id");
    expect(create).toContain("'preparing'");
    expect(create).toContain("flow_version");
    expect(create).toContain("'open'");
    expect(create).toContain("'created'");
    expect(create).toContain("transfer_id");
    expect(create).toContain("pending_storage_path");
    expect(create.indexOf("claim_command_receipt")).toBeLessThan(
      create.indexOf("INSERT INTO public.handoffs"),
    );
    expect(create.indexOf("INSERT INTO public.handoffs")).toBeLessThan(
      create.indexOf("INSERT INTO public.handoff_transfers"),
    );
    expect(create).not.toContain("SET active_transfer_id");
  });

  it("rejects a reused client_request_id with different parameters", () => {
    const claim = functionBody(setup(), "private.claim_command_receipt(");
    expect(claim).toContain("'idempotency_conflict'");
    expect(claim).toContain("'idempotency_incomplete'");
    expect(claim).toContain("ON CONFLICT (actor_member_id, client_request_id) DO NOTHING");
    expect(claim).toContain("FOR UPDATE");
    expect(claim).toContain("LOOP");
    expect(claim).toContain("v_command IS DISTINCT FROM p_command_name");
    expect(claim).toContain("v_fingerprint IS DISTINCT FROM p_fingerprint");
    expect(claim.indexOf("IF existing_result IS NULL")).toBeLessThan(claim.indexOf("won := false"));
  });

  it("finalizes the same reservation after a lost response", () => {
    const finalize = functionBody(setup(), "public.finalize_handoff_v2_initial(");
    expect(finalize).toContain("private.claim_command_receipt(");
    expect(finalize).toContain("IF NOT v_won THEN");
    expect(finalize).toContain("'idempotency_incomplete'");
    expect(finalize).toContain("RETURN v_existing");
    expect(finalize).toContain("pending_object_id");
    expect(finalize).toContain("'finalized'");
    expect(finalize).toContain("transfer_id");
    expect(finalize).toContain("version_number");
    expect(finalize).not.toContain("gen_random_uuid()");
    expect(finalize.indexOf("claim_command_receipt")).toBeLessThan(
      finalize.indexOf("private.insert_handoff_version("),
    );
    expect(finalize.indexOf("private.insert_handoff_version(")).toBeLessThan(
      finalize.indexOf("pending_object_id = NULL"),
    );
    expect(finalize.indexOf("pending_object_id = NULL")).toBeLessThan(
      finalize.lastIndexOf("finish_command_receipt"),
    );
  });

  it("does not clear a reservation while the object still exists", () => {
    const fail = functionBody(setup(), "public.fail_handoff_v2_initial(");
    const retry = functionBody(setup(), "public.retry_handoff_v2_initial(");
    expect(fail).toContain("'handoff_abort_cleanup_required'");
    expect(fail).toContain("FROM storage.objects o");
    expect(fail).toContain("o.bucket_id = 'filerelay'");
    expect(fail).toContain("o.name = v_pending_path");
    expect(fail).not.toContain("DELETE FROM storage.objects");
    expect(fail.indexOf("handoff_abort_cleanup_required")).toBeLessThan(
      fail.indexOf("pending_object_id = NULL"),
    );
    expect(fail.indexOf("handoff_abort_cleanup_required")).toBeLessThan(
      fail.indexOf("SET status = 'failed'"),
    );
    expect(retry).toContain("'reservation_still_held'");
    expect(retry).toContain("'failed'");
    expect(retry).toContain("'preparing'");
    expect(retry).toContain("t.pending_object_id");
    expect(retry).toContain("t.pending_version_number");
    expect(retry).toContain("t.pending_storage_path");
    expect(retry).toContain("t.pending_upload_expires_at");
    expect(retry.indexOf("reservation_still_held")).toBeLessThan(retry.indexOf("gen_random_uuid()"));
  });

  it("enforces reminder cooldown except for the same client_request_id", () => {
    const reminder = functionBody(setup(), "public.send_transfer_reminder(");
    expect(reminder).toContain("interval '10 minutes'");
    expect(reminder).toContain("'reminder_cooldown'");
    expect(reminder).toContain("'reminder_sent'");
    expect(reminder).toContain("IF NOT v_won THEN");
    expect(reminder).toContain("RETURN v_existing");
  });

  it("guards existing handoff_id RPCs and writes flow_version=1 on legacy create", () => {
    const create = functionBody(setup(), "public.create_handoff(");
    const createCtx = functionBody(setup(), "public.create_handoff_with_context(");
    expect(create).toContain("flow_version");
    expect(create).toContain(",\n    1\n  )");
    expect(create).not.toContain("reject_if_flow_v2");
    expect(createCtx).toContain("flow_version");
    expect(createCtx).not.toContain("reject_if_flow_v2");
    for (const name of GUARDED_RPCS) {
      const body = functionBody(setup(), name);
      expect(body).toContain("private.reject_if_flow_v2(");
    }
  });
});

describe("M10A RLS, storage, and realtime", () => {
  it("hides preparing and failed v2 requests from the recipient", () => {
    const readable = functionBody(setup(), "private.handoff_readable(p_handoff_id uuid)");
    expect(readable).toContain("active_hop.status IN ('preparing', 'failed')");
    expect(readable).toContain("actor.id = active_hop.from_member_id");
    expect(readable).not.toContain("to_member_id = actor.id");
    const transfers =
      setup().match(/CREATE POLICY handoff_transfers_select_participant[\s\S]*?;/)?.[0] ?? "";
    expect(transfers).toContain("private.handoff_readable(handoff_id)");
  });

  it("allows upload only for the reserved path and delete only via Storage API", () => {
    const upload = functionBody(setup(), "private.can_upload_handoff_object(object_name text)");
    const del = functionBody(
      setup(),
      "private.can_delete_reserved_handoff_object(object_name text)",
    );
    const locate = functionBody(setup(), "private.can_delete_handoff_object(object_name text)");
    const read = functionBody(setup(), "private.can_read_handoff_object(object_name text)");
    expect(upload).toContain("t.pending_storage_path = object_name");
    expect(upload).toContain("t.pending_upload_expires_at > pg_catalog.now()");
    expect(upload).toContain("h.flow_version = 1");
    expect(del).toContain("t.pending_storage_path = object_name");
    expect(del).toContain("t.status IN ('preparing', 'failed')");
    expect(del).toContain("t.from_member_id = m.id");
    expect(del).toContain("t.pending_object_id IS NOT NULL");
    expect(del).not.toContain("pending_upload_expires_at >");
    expect(locate).toContain("private.can_delete_reserved_handoff_object(object_name)");
    expect(read).toContain("JOIN public.handoff_versions hv");
    expect(read).not.toContain("pending_storage_path");
    expect(setup()).toContain("CREATE POLICY filerelay_storage_delete");
    expect(setup()).toContain("FOR DELETE");
    expect(setup()).not.toContain("DELETE FROM storage.objects");
  });

  it("publishes handoff_transfers without granting receipts", () => {
    expect(setup()).toContain("tablename = 'handoff_transfers'");
    expect(patch()).toContain("ADD TABLE public.handoff_transfers");
    expect(setup()).not.toContain("GRANT SELECT ON public.handoff_command_receipts");
    expect(setup()).not.toContain("GRANT EXECUTE ON FUNCTION private.claim_command_receipt");
  });
});

describe("M10A close-out audit cases", () => {
  it("rejects fail while the reserved object still exists and leaves the reservation", () => {
    const fail = functionBody(setup(), "public.fail_handoff_v2_initial(");
    expect(fail).toContain("SELECT EXISTS (");
    expect(fail).toContain("FROM storage.objects o");
    expect(fail).toContain("o.bucket_id = 'filerelay'");
    expect(fail).toContain("o.name = v_pending_path");
    expect(fail).toContain("'handoff_abort_cleanup_required'");
    expect(fail).not.toContain("DELETE FROM storage.objects");
    expect(fail.indexOf("IF v_object_exists THEN")).toBeLessThan(
      fail.indexOf("UPDATE public.handoff_transfers"),
    );
    expect(fail.indexOf("handoff_abort_cleanup_required")).toBeLessThan(
      fail.indexOf("UPDATE public.handoff_transfers"),
    );
  });

  it("allows fail after a successful Storage DELETE or a missing object", () => {
    const fail = functionBody(setup(), "public.fail_handoff_v2_initial(");
    expect(fail).toContain("IF v_pending_path IS NOT NULL THEN");
    expect(fail).toContain("IF v_object_exists THEN");
    expect(fail.indexOf("IF v_object_exists THEN")).toBeLessThan(
      fail.indexOf("UPDATE public.handoff_transfers"),
    );
    expect(fail).toContain("pending_object_id = NULL");
    expect(fail).toContain("pending_version_number = NULL");
    expect(fail).toContain("pending_storage_path = NULL");
    expect(fail).toContain("pending_upload_expires_at = NULL");
    expect(fail).toContain("status = 'failed'");
  });

  it("rejects retry while any reservation field is still held", () => {
    const retry = functionBody(setup(), "public.retry_handoff_v2_initial(");
    expect(retry).toContain("v_status IS DISTINCT FROM 'failed'");
    expect(retry).toContain("v_pending_object IS NOT NULL");
    expect(retry).toContain("v_pending_version IS NOT NULL");
    expect(retry).toContain("v_pending_path IS NOT NULL");
    expect(retry).toContain("v_pending_expires IS NOT NULL");
    expect(retry).toContain("'reservation_still_held'");
    expect(retry.indexOf("reservation_still_held")).toBeLessThan(retry.indexOf("gen_random_uuid()"));
    expect(retry.indexOf("gen_random_uuid()")).toBeLessThan(
      retry.indexOf("pending_object_id = v_object_id"),
    );
  });

  it("makes two parallel creates with the same key produce one request", () => {
    const claim = functionBody(setup(), "private.claim_command_receipt(");
    const create = functionBody(setup(), "public.create_handoff_v2(");
    expect(setup()).toContain("handoff_command_receipts_actor_request_key");
    expect(setup()).toContain("ON public.handoff_command_receipts (actor_member_id, client_request_id)");
    expect(claim).toContain("ON CONFLICT (actor_member_id, client_request_id) DO NOTHING");
    expect(claim).toContain("FOR UPDATE");
    expect(claim).toContain("'idempotency_incomplete'");
    expect(create.indexOf("claim_command_receipt")).toBeLessThan(
      create.indexOf("INSERT INTO public.handoffs"),
    );
    expect(create).toContain("'idempotency_incomplete'");
    expect(create).not.toContain("SET active_transfer_id");
  });

  it("returns the same finalize result after a lost response without another version", () => {
    const finalize = functionBody(setup(), "public.finalize_handoff_v2_initial(");
    expect(finalize).toContain("IF NOT v_won THEN");
    expect(finalize).toContain("RETURN v_existing");
    expect(finalize).toContain("'idempotency_incomplete'");
    expect(finalize).not.toContain("gen_random_uuid()");
    expect((finalize.match(/private\.insert_handoff_version\(/g) ?? []).length).toBe(1);
    expect(finalize.indexOf("IF NOT v_won THEN")).toBeLessThan(
      finalize.indexOf("private.insert_handoff_version("),
    );
  });

  it("hides preparing and failed hops from the recipient after v2 create", () => {
    const readable = functionBody(setup(), "private.handoff_readable(p_handoff_id uuid)");
    expect(readable).toContain("active_hop.status IN ('preparing', 'failed')");
    expect(readable).toContain("actor.id = active_hop.from_member_id");
    expect(readable).not.toMatch(
      /status IN \('preparing', 'failed'\)[\s\S]*to_member_id = actor\.id/,
    );
    expect(readable).toContain("NOT EXISTS");
    expect(setup()).toContain("CREATE POLICY handoffs_select_participant");
    expect(setup()).toContain("USING (private.handoff_readable(id))");
    expect(setup()).toContain("USING (private.handoff_readable(handoff_id))");
  });

  it("denies abort-policy DELETE after finalize clears the reservation", () => {
    const del = functionBody(
      setup(),
      "private.can_delete_reserved_handoff_object(object_name text)",
    );
    expect(del).toContain("t.status IN ('preparing', 'failed')");
    expect(del).toContain("t.pending_object_id IS NOT NULL");
    expect(del).toContain("t.pending_storage_path = object_name");
    expect(del).toContain("NOT EXISTS (");
    expect(del).toContain("FROM public.handoff_versions hv");
    const finalize = functionBody(setup(), "public.finalize_handoff_v2_initial(");
    expect(finalize).toContain("status = 'active'");
    expect(finalize).toContain("pending_object_id = NULL");
    expect(finalize).toContain("pending_storage_path = NULL");
  });

  it("fires the deferred pointer trigger on pointer, request_status, and hop status", () => {
    for (const source of [setup(), patch()]) {
      expect(source).toContain(
        "AFTER INSERT OR UPDATE OF active_transfer_id, request_status ON public.handoffs",
      );
      expect(source).toContain("AFTER UPDATE OF status ON public.handoff_transfers");
      expect(source).toContain("DEFERRABLE INITIALLY DEFERRED");
    }
    const handoffTrigger = functionBody(setup(), "private.handoffs_active_transfer_status_ok()");
    const hopTrigger = functionBody(setup(), "private.handoff_transfers_active_status_ok()");
    expect(handoffTrigger).toContain("IF NEW.flow_version = 1 THEN");
    expect(hopTrigger).toContain("h.flow_version = 1");
  });
});

describe("M10A reservation delete-only Storage SELECT", () => {
  const deleteSelectName = "filerelay_storage_select_for_delete";

  it("adds the same delete-only SELECT policy in setup, patch, and fix1", () => {
    const policies = [setup(), patch(), fix1()].map((sql) => storagePolicy(sql, deleteSelectName));
    for (const policy of policies) {
      expect(policy).toContain("FOR SELECT");
      expect(policy).toContain("TO authenticated");
      expect(policy).toContain("bucket_id = 'filerelay'");
      expect(policy).toContain("private.can_delete_handoff_object(name)");
      expect(policy).toContain("storage.allow_any_operation(ARRAY[");
      expect(policy).toContain("'storage.object.delete'");
      expect(policy).toContain("'storage.object.delete_many'");
      expect(policy).not.toContain("'storage.object.list'");
      expect(policy).not.toContain("'storage.object.list_v2'");
      expect(policy).not.toContain("'storage.object.get_authenticated'");
      expect(policy).not.toContain("'storage.object.get_signed'");
      expect(policy).not.toContain("'storage.object.sign'");
      expect(policy).not.toContain("DELETE FROM storage.objects");
    }
    expect(policies[1]).toBe(policies[0]);
    expect(policies[2]).toBe(policies[0]);
    expect(functionBody(fix1(), "private.can_delete_handoff_object(object_name text)")).toBe(
      functionBody(setup(), "private.can_delete_handoff_object(object_name text)"),
    );
  });

  it("keeps list, download, and ordinary SELECT off reserved objects", () => {
    const read = functionBody(setup(), "private.can_read_handoff_object(object_name text)");
    const locate = functionBody(setup(), "private.can_delete_handoff_object(object_name text)");
    const ordinarySelect = storagePolicy(setup(), "filerelay_storage_select");
    const deleteSelect = storagePolicy(setup(), deleteSelectName);
    expect(read).toContain("JOIN public.handoff_versions hv");
    expect(read).toContain("hv.storage_path = object_name");
    expect(read).not.toContain("pending_storage_path");
    expect(ordinarySelect).toContain("private.can_read_handoff_object(name)");
    expect(ordinarySelect).not.toContain("can_delete_handoff_object");
    expect(deleteSelect).toContain("storage.allow_any_operation");
    expect(locate).toContain("can_delete_reserved_handoff_object");
    expect(setup()).not.toContain("DELETE FROM storage.objects");
  });

  it("lets only the reserved actor remove the pending path", () => {
    const del = functionBody(
      setup(),
      "private.can_delete_reserved_handoff_object(object_name text)",
    );
    expect(del).toContain("t.from_member_id = m.id");
    expect(del).toContain("t.pending_storage_path = object_name");
    expect(del).toContain("t.status IN ('preparing', 'failed')");
    expect(del).toContain("t.pending_object_id IS NOT NULL");
    expect(setup()).toContain("CREATE POLICY filerelay_storage_delete");
    expect(setup()).toContain("private.can_delete_reserved_handoff_object(name)");
  });

  it("clears a reservation only after Storage remove and then issues a new path on retry", () => {
    const fail = functionBody(setup(), "public.fail_handoff_v2_initial(");
    const retry = functionBody(setup(), "public.retry_handoff_v2_initial(");
    expect(fail).toContain("'handoff_abort_cleanup_required'");
    expect(fail).not.toContain("DELETE FROM storage.objects");
    expect(fail.indexOf("handoff_abort_cleanup_required")).toBeLessThan(
      fail.indexOf("UPDATE public.handoff_transfers"),
    );
    expect(retry).toContain("'reservation_still_held'");
    expect(retry.indexOf("reservation_still_held")).toBeLessThan(retry.indexOf("gen_random_uuid()"));
    expect(retry.indexOf("gen_random_uuid()")).toBeLessThan(
      retry.indexOf("pending_object_id = v_object_id"),
    );
  });

  it("rejects abort-policy delete after finalize", () => {
    const del = functionBody(
      setup(),
      "private.can_delete_reserved_handoff_object(object_name text)",
    );
    const finalize = functionBody(setup(), "public.finalize_handoff_v2_initial(");
    expect(del).toContain("t.pending_object_id IS NOT NULL");
    expect(del).toContain("NOT EXISTS (");
    expect(finalize).toContain("status = 'active'");
    expect(finalize).toContain("pending_storage_path = NULL");
    expect(finalize.indexOf("private.insert_handoff_version(")).toBeLessThan(
      finalize.indexOf("pending_object_id = NULL"),
    );
  });
});

describe("M10A realtime contract", () => {
  it("signals finalize with a new handoff_events row after the hop is active", () => {
    const finalize = functionBody(setup(), "public.finalize_handoff_v2_initial(");
    expect(finalize).not.toContain("UPDATE public.handoffs");
    expect(finalize.indexOf("SET status = 'active'")).toBeLessThan(
      finalize.indexOf("INSERT INTO public.handoff_events"),
    );
    expect(finalize.indexOf("INSERT INTO public.handoff_events")).toBeLessThan(
      finalize.indexOf("'finalized'"),
    );
    expect(finalize).toContain("transfer_id");
    expect(finalize).toContain("p_handoff_id");
    expect((finalize.match(/INSERT INTO public\.handoff_events/g) ?? []).length).toBe(1);
    expect(finalize.indexOf("IF NOT v_won THEN")).toBeLessThan(
      finalize.indexOf("INSERT INTO public.handoff_events"),
    );
  });

  it("publishes handoff_events and writes reminder_sent with a transfer_id", () => {
    const reminder = functionBody(setup(), "public.send_transfer_reminder(");
    expect(setup()).toContain("ADD TABLE public.handoff_events");
    expect(reminder).toContain("'reminder_sent'");
    expect(reminder).toContain("transfer_id");
    expect(reminder).not.toContain("UPDATE public.handoffs");
  });
});
