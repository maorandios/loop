import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function listSqlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSqlFiles(full));
    } else if (entry.name.endsWith(".sql")) {
      out.push(full);
    }
  }
  return out;
}

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
const patch = () => read("supabase/manual-patch-m10c.sql");
const fragment = () => read("supabase/fragments/m10c-functions.sql");
const fix1 = () => read("supabase/manual-patch-m10c-fix1.sql");
const NOTE_NULLIF = "NULLIF(pg_catalog.btrim(p_result_note), ''::text)";
const SCHEMA_QUALIFIED_SYNTAX = /\bpg_catalog\.(nullif|coalesce|greatest|least)\s*\(/i;

const M10C_BODIES = [
  "private.assert_result_matches_request(",
  "private.assert_v2_open_root(p_handoff_id uuid)",
  "private.can_delete_reserved_handoff_object(object_name text)",
  "public.mark_root_transfer_opened(",
  "public.begin_transfer_result_upload(",
  "public.renew_transfer_upload_reservation(",
  "public.finalize_transfer_result(",
  "public.submit_transfer_result_without_file(",
  "public.abort_transfer_result_upload(",
  "public.accept_root_transfer_result(",
  "public.request_root_transfer_revision(",
  "public.cancel_root_handoff_v2(",
] as const;

const M10C_A2_TOUCHED = new Set([
  "private.assert_result_matches_request(",
  "public.mark_root_transfer_opened(",
  "public.finalize_transfer_result(",
  "public.accept_root_transfer_result(",
]);

describe("Milestone 10C-A SQL files", () => {
  it("keeps an idempotent patch and a full M10C setup", () => {
    const sql = setup();
    const m10c = patch();
    expect(m10c).toContain("BEGIN;");
    expect(m10c).toContain("COMMIT;");
    expect(m10c).not.toContain("service_role");
    expect(m10c).not.toContain("DROP FUNCTION");
    expect(m10c).toContain("ADD COLUMN IF NOT EXISTS handling_round");
    expect(m10c).toContain("CREATE UNIQUE INDEX IF NOT EXISTS handoff_events_opened_round_key");
    expect(m10c).toContain("handoff_transfers_returned_with_reply_check");
    expect(m10c).toContain("handoff_transfers_returned_with_file_check");
    expect(m10c).not.toContain("ADD CONSTRAINT handoff_transfers_rejected");
    expect(sql).toContain("handling_round integer NOT NULL DEFAULT 1");
    expect(sql).toContain("handoff_events_opened_round_key");
    expect(sql).not.toContain("opened_at");
    expect(m10c).not.toContain("opened_at");
  });

  it("matches M10C function bodies between setup and patch", () => {
    const sql = setup();
    const m10c = patch();
    for (const name of M10C_BODIES) {
      if (M10C_A2_TOUCHED.has(name)) {
        continue;
      }
      const fromSetup = functionBody(sql, name);
      const fromPatch = functionBody(m10c, name);
      expect(fromSetup.length).toBeGreaterThan(80);
      expect(fromPatch).toBe(fromSetup);
    }
  });

  it("keeps an idempotent NULLIF syntax fix for result RPCs", () => {
    const m10cFix1 = fix1();
    expect(m10cFix1).toContain("BEGIN;");
    expect(m10cFix1).toContain("COMMIT;");
    expect(m10cFix1).not.toContain("service_role");
    expect(m10cFix1).not.toContain("DROP FUNCTION");
    expect(m10cFix1).not.toContain("DELETE FROM");
    expect((m10cFix1.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length).toBe(2);
    expect(m10cFix1).toContain(NOTE_NULLIF);
    expect(m10cFix1).not.toMatch(SCHEMA_QUALIFIED_SYNTAX);
    expect(m10cFix1).toContain(
      "REVOKE ALL ON FUNCTION public.finalize_transfer_result(uuid, text, text, uuid, bigint, text, uuid)",
    );
    expect(m10cFix1).toContain(
      "REVOKE ALL ON FUNCTION public.submit_transfer_result_without_file(uuid, text, text, uuid)",
    );
    expect(m10cFix1).toContain(
      "GRANT EXECUTE ON FUNCTION public.finalize_transfer_result(uuid, text, text, uuid, bigint, text, uuid) TO authenticated;",
    );
    expect(m10cFix1).toContain(
      "GRANT EXECUTE ON FUNCTION public.submit_transfer_result_without_file(uuid, text, text, uuid) TO authenticated;",
    );
    expect(functionBody(m10cFix1, "public.submit_transfer_result_without_file(")).toBe(
      functionBody(setup(), "public.submit_transfer_result_without_file("),
    );
    expect(functionBody(m10cFix1, "public.finalize_transfer_result(")).toContain(NOTE_NULLIF);
    expect(functionBody(m10cFix1, "public.finalize_transfer_result(")).not.toContain(
      "private.insert_handoff_version(",
    );
  });

  it("keeps result RPC bodies identical across fragment, setup, patch, and fix1", () => {
    const submitSources = [fragment(), setup(), patch(), fix1()];
    const [submitCanonical, ...submitRest] = submitSources.map((sql) =>
      functionBody(sql, "public.submit_transfer_result_without_file("),
    );
    expect(submitCanonical.length).toBeGreaterThan(80);
    expect(submitCanonical).toContain(NOTE_NULLIF);
    for (const body of submitRest) {
      expect(body).toBe(submitCanonical);
    }

    const finalizeSources = [fragment(), setup()];
    const [finalizeCanonical, ...finalizeRest] = finalizeSources.map((sql) =>
      functionBody(sql, "public.finalize_transfer_result("),
    );
    expect(finalizeCanonical.length).toBeGreaterThan(80);
    expect(finalizeCanonical).toContain(NOTE_NULLIF);
    expect(finalizeCanonical).toContain("private.insert_handoff_version(");
    for (const body of finalizeRest) {
      expect(body).toBe(finalizeCanonical);
    }
  });

  it("does not schema-qualify syntactic SQL constructs", () => {
    const hits = listSqlFiles(path.join(process.cwd(), "supabase"))
      .filter((file) => SCHEMA_QUALIFIED_SYNTAX.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(process.cwd(), file).replace(/\\/g, "/"));
    expect(hits).toEqual([]);
  });

  it("does not rewrite versions, storage paths, or existing events in the patch", () => {
    const m10c = patch();
    expect(m10c).not.toContain("UPDATE public.handoff_versions");
    expect(m10c).not.toContain("DELETE FROM public.handoff_versions");
    expect(m10c).not.toContain("DELETE FROM public.handoff_events");
    expect(m10c).not.toContain("DELETE FROM storage.objects");
    expect(m10c).not.toContain("UPDATE storage.objects");
  });
});

describe("M10C schema and constraints", () => {
  it("stores handling_round on hops and opened events without opened_at", () => {
    for (const source of [setup(), patch()]) {
      expect(source).toContain("handling_round");
      expect(source).toContain("handling_round BETWEEN 1 AND 1000");
      expect(source).toContain("event_type IS DISTINCT FROM 'opened'");
      expect(source).toContain("handoff_events_opened_round_key");
      expect(source).toContain("WHERE event_type = 'opened' AND transfer_id IS NOT NULL");
      expect(source).not.toContain("opened_at");
    }
  });

  it("keeps rejected+note and adds reply/file result checks", () => {
    const sql = setup();
    expect(sql).toContain(
      "CHECK (result_action IS DISTINCT FROM 'rejected' OR result_note IS NOT NULL)",
    );
    expect(sql).toContain("handoff_transfers_returned_with_reply_check");
    expect(sql).toContain("result_action IS DISTINCT FROM 'returned_with_reply'");
    expect(sql).toContain("result_version_number IS NULL");
    expect(sql).toContain("handoff_transfers_returned_with_file_check");
    expect(sql).toContain("result_action IS DISTINCT FROM 'returned_with_file'");
    expect(sql).toContain("OR result_version_number IS NOT NULL");
    expect((sql.match(/result_action IS DISTINCT FROM 'rejected'/g) ?? []).length).toBe(1);
  });

  it("repairs v1 return_received backfill before adding the file CHECK", () => {
    const sql = setup();
    const m10c = patch();
    const legacy = read("supabase/fragments/m10c-legacy-result-version.sql").trimEnd();
    expect(m10c.indexOf("BEGIN;")).toBeLessThan(m10c.indexOf("m10c_v2_returned_with_file"));
    expect(m10c.indexOf("m10c_v2_returned_with_file_missing_version")).toBeLessThan(
      m10c.indexOf("handoff_transfers_returned_with_file_check"),
    );
    expect(m10c.indexOf("AND h.flow_version = 1")).toBeLessThan(
      m10c.indexOf("ADD CONSTRAINT handoff_transfers_returned_with_file_check"),
    );
    expect(m10c.indexOf("m10c_legacy_returned_with_file_unmigratable")).toBeLessThan(
      m10c.indexOf("ADD CONSTRAINT handoff_transfers_returned_with_file_check"),
    );
    expect(m10c.indexOf("ADD CONSTRAINT handoff_transfers_returned_with_file_check")).toBeLessThan(
      m10c.lastIndexOf("COMMIT;"),
    );
    for (const source of [sql, m10c, legacy]) {
      expect(source).toContain("h.flow_version = 2");
      expect(source).toContain("'m10c_v2_returned_with_file_missing_version'");
      expect(source).toContain("h.flow_version = 1");
      expect(source).toContain("t.result_action = 'returned_with_file'");
      expect(source).toContain("t.result_version_number IS NULL");
      expect(source).toContain("h.status IN ('returned', 'return_received')");
      expect(source).toContain("hv.version_number >= 2");
      expect(source).toContain("pg_catalog.max(hv.version_number)");
      expect(source).toContain("'return_received'");
      expect(source).toContain("'m10c_legacy_returned_with_file_unmigratable'");
      expect(source).not.toContain("NOT VALID");
      expect(source).not.toContain("DELETE FROM public.handoffs");
      expect(source).not.toContain("DELETE FROM public.handoff_transfers");
      expect(source).not.toContain("DELETE FROM public.handoff_versions");
      expect(source).not.toContain("DELETE FROM public.handoff_events");
    }
    expect(m10c).toContain(legacy);
    expect(sql).toContain(legacy);
    expect(legacy).not.toContain("result_action = 'returned_with_reply'");
    expect(legacy).not.toContain("SET result_action");
    expect((m10c.match(/SET result_version_number = derived\.return_version/g) ?? []).length).toBe(1);
    expect(m10c).toContain("AND t.result_version_number IS NULL");
  });
});

describe("M10C helpers and pairing", () => {
  it("locks the open v2 root request then the hop", () => {
    const helper = functionBody(setup(), "private.assert_v2_open_root(p_handoff_id uuid)");
    expect(helper).toContain("FOR UPDATE OF h");
    expect(helper).toContain("FOR UPDATE OF t");
    expect(helper.indexOf("FOR UPDATE OF h")).toBeLessThan(helper.indexOf("FOR UPDATE OF t"));
    expect(helper).toContain("flow_version");
    expect(helper).toContain("'handoff_already_completed'");
    expect(helper).toContain("'handoff_already_cancelled'");
    expect(helper).toContain("'not_root_transfer'");
    expect(helper).toContain("t.parent_transfer_id");
    expect(helper).toContain("h.active_transfer_id");
  });

  it("pairs requested_action to result_action in the helper", () => {
    const pairing = functionBody(setup(), "private.assert_result_matches_request(");
    expect(pairing).toContain("'approval'");
    expect(pairing).toContain("'approved'");
    expect(pairing).toContain("'review'");
    expect(pairing).toContain("'review_completed'");
    expect(pairing).toContain("'update'");
    expect(pairing).toContain("'returned_with_file'");
    expect(pairing).toContain("'returned_with_reply'");
    expect(pairing).toContain("'rejected'");
    expect(pairing).toContain("'file_request'");
    expect(pairing).toContain("'result_action_mismatch'");
  });
});

describe("M10C RPCs", () => {
  it("opens a hop once per handling_round and never deletes old opened rows", () => {
    const opened = functionBody(setup(), "public.mark_root_transfer_opened(");
    expect(opened).toContain("private.claim_command_receipt(");
    expect(opened).toContain("'mark_root_transfer_opened'");
    expect(opened).toContain("private.assert_v2_open_root(");
    expect(opened).toContain("'active'");
    expect(opened).toContain("to_member_id");
    expect(opened).toContain("'opened'");
    expect(opened).toContain("handling_round");
    expect(opened).toContain("WHEN unique_violation THEN");
    expect(opened).not.toContain("DELETE FROM public.handoff_events");
    expect(opened).not.toContain("opened_at");
  });

  it("returns an existing result reservation from begin and only then creates a new path", () => {
    const begin = functionBody(setup(), "public.begin_transfer_result_upload(");
    expect(begin).toContain("private.claim_command_receipt(");
    expect(begin).toContain("'begin_transfer_result_upload'");
    expect(begin).toContain("pending_object_id IS NOT NULL");
    expect(begin).toContain("pending_upload_expires_at = v_expires");
    expect(begin).toContain("gen_random_uuid()");
    expect(begin.indexOf("pending_object_id IS NOT NULL")).toBeLessThan(
      begin.indexOf("gen_random_uuid()"),
    );
    expect(begin.indexOf("RETURN v_result")).toBeLessThan(begin.indexOf("gen_random_uuid()"));
    expect(begin).toContain("COALESCE(pg_catalog.max(hv.version_number), 0) + 1");
    expect(begin).not.toContain("SET status");
  });

  it("renews only expires_at for the current upload owner", () => {
    const renew = functionBody(setup(), "public.renew_transfer_upload_reservation(");
    expect(renew).toContain("private.claim_command_receipt(");
    expect(renew).toContain("'renew_transfer_upload_reservation'");
    expect(renew).toContain("private.assert_v2_open_root(");
    expect(renew).toContain("'preparing'");
    expect(renew).toContain("from_member_id");
    expect(renew).toContain("'active'");
    expect(renew).toContain("to_member_id");
    expect(renew).toContain("'reservation_missing'");
    expect(renew).toContain("SET pending_upload_expires_at = v_expires");
    expect(renew).not.toContain("gen_random_uuid()");
    expect(renew).not.toContain("SET pending_object_id");
    expect(renew).not.toContain("SET pending_version_number");
    expect(renew).not.toContain("SET pending_storage_path");
    expect(renew).not.toContain("SET status");
  });

  it("finalizes a file result in one transaction and writes approved without completed", () => {
    const finalize = functionBody(setup(), "public.finalize_transfer_result(");
    expect(finalize).toContain("private.claim_command_receipt(");
    expect(finalize).toContain(NOTE_NULLIF);
    expect(finalize).toContain("private.assert_result_matches_request(");
    expect(finalize).toContain("private.assert_reserved_upload_matches(");
    expect(finalize).toContain("private.insert_handoff_version(");
    expect(finalize).toContain("active_transfer_id = NULL");
    expect(finalize).toContain("request_status = 'completed'");
    expect(finalize).toContain("status = 'closed'");
    expect(finalize).toContain("'returned_to_sender'");
    expect(finalize).toContain("'approved'");
    expect(finalize).not.toContain("DELETE FROM storage.objects");
    expect(finalize.indexOf("active_transfer_id = NULL")).toBeLessThan(
      finalize.indexOf("status = 'closed'"),
    );
    expect(finalize.indexOf("private.insert_handoff_version(")).toBeLessThan(
      finalize.indexOf("pending_object_id = NULL"),
    );
    expect(finalize).not.toMatch(/event_type[\s\S]{0,80}'completed'/);
    expect((finalize.match(/INSERT INTO public\.handoff_events/g) ?? []).length).toBe(1);
  });

  it("rejects submit_without_file when a reservation is live or the action needs a file", () => {
    const submit = functionBody(setup(), "public.submit_transfer_result_without_file(");
    expect(submit).toContain(NOTE_NULLIF);
    expect(submit).toContain("'reservation_still_held'");
    expect(submit).toContain("'returned_with_file'");
    expect(submit).toContain("private.assert_result_matches_request(");
    expect(submit).toContain("'approved'");
    expect(submit).not.toContain("INSERT INTO public.handoff_versions");
    expect(submit).not.toMatch(/event_type[\s\S]{0,80}'completed'/);
    expect(submit.indexOf("active_transfer_id = NULL")).toBeLessThan(submit.indexOf("status = 'closed'"));
  });

  it("aborts a result upload without failing the hop and without SQL storage delete", () => {
    const abort = functionBody(setup(), "public.abort_transfer_result_upload(");
    expect(abort).toContain("'handoff_abort_cleanup_required'");
    expect(abort).toContain("FROM storage.objects o");
    expect(abort).toContain("'transfer_status', 'active'");
    expect(abort).toContain("pending_object_id = NULL");
    expect(abort).not.toContain("SET status = 'failed'");
    expect(abort).not.toContain("SET status = 'closed'");
    expect(abort).not.toContain("DELETE FROM storage.objects");
    expect(abort.indexOf("handoff_abort_cleanup_required")).toBeLessThan(
      abort.indexOf("pending_object_id = NULL"),
    );
  });

  it("accepts a returned result with a completed event only", () => {
    const accept = functionBody(setup(), "public.accept_root_transfer_result(");
    expect(accept).toContain("'returned_to_sender'");
    expect(accept).toContain("from_member_id");
    expect(accept).toContain("active_transfer_id = NULL");
    expect(accept).toContain("request_status = 'completed'");
    expect(accept).toContain("'completed'");
    expect(accept.indexOf("active_transfer_id = NULL")).toBeLessThan(accept.indexOf("status = 'closed'"));
    expect(accept).not.toContain("result_action = NULL");
    expect((accept.match(/INSERT INTO public\.handoff_events/g) ?? []).length).toBe(1);
  });

  it("requests a revision by incrementing handling_round and clearing result fields", () => {
    const revision = functionBody(setup(), "public.request_root_transfer_revision(");
    expect(revision).toContain("'revision_requested'");
    expect(revision).toContain("'revision_note_required'");
    expect(revision).toContain("'handling_round_limit'");
    expect(revision).toContain("handling_round = v_next_round");
    expect(revision).toContain("status = 'active'");
    expect(revision).toContain("result_action = NULL");
    expect(revision).toContain("result_note = NULL");
    expect(revision).toContain("result_version_number = NULL");
    expect(revision).not.toContain("DELETE FROM public.handoff_events");
    expect(revision).not.toContain("DELETE FROM public.handoff_versions");
    expect(revision.indexOf("'revision_requested'")).toBeLessThan(
      revision.indexOf("handling_round = v_next_round"),
    );
  });

  it("cancels only as the creator after verifying the reserved object is gone", () => {
    const cancel = functionBody(setup(), "public.cancel_root_handoff_v2(");
    expect(cancel).toContain("sender_member_id");
    expect(cancel).toContain("'handoff_abort_cleanup_required'");
    expect(cancel).toContain("request_status = 'cancelled'");
    expect(cancel).toContain("'cancelled'");
    expect(cancel).toContain("active_transfer_id = NULL");
    expect(cancel).not.toContain("result_action =");
    expect(cancel).not.toContain("DELETE FROM storage.objects");
    expect(cancel.indexOf("handoff_abort_cleanup_required")).toBeLessThan(
      cancel.indexOf("active_transfer_id = NULL"),
    );
    expect(cancel.indexOf("active_transfer_id = NULL")).toBeLessThan(cancel.indexOf("status = 'closed'"));
  });
});

describe("M10C RLS and storage helpers", () => {
  it("expands reserved delete to the recipient and the request creator without loosening upload", () => {
    const del = functionBody(setup(), "private.can_delete_reserved_handoff_object(object_name text)");
    const upload = functionBody(setup(), "private.can_upload_handoff_object(object_name text)");
    expect(del).toContain("t.status IN ('preparing', 'failed')");
    expect(del).toContain("t.from_member_id = m.id");
    expect(del).toContain("t.status = 'active'");
    expect(del).toContain("t.to_member_id = m.id");
    expect(del).toContain("m.id = h.sender_member_id");
    expect(del).toContain("h.request_status = 'open'");
    expect(del).toContain("t.parent_transfer_id IS NULL");
    expect(del).toContain("NOT EXISTS (");
    expect(del).toContain("FROM public.handoff_versions hv");
    expect(del).toContain("hv.storage_path = object_name");
    expect(del).not.toContain("pending_upload_expires_at >");
    expect(upload).toContain("t.pending_upload_expires_at > pg_catalog.now()");
    expect(upload).toContain("(t.status = 'preparing' AND m.id = t.from_member_id)");
    expect(upload).toContain("(t.status = 'active' AND m.id = t.to_member_id)");
    expect(setup()).not.toContain("ADD TABLE public.handoff_command_receipts");
  });

  it("grants the new RPCs to authenticated only and revokes the private helpers", () => {
    const sql = setup();
    const m10c = patch();
    for (const source of [sql, m10c]) {
      expect(source).toContain(
        "GRANT EXECUTE ON FUNCTION public.renew_transfer_upload_reservation(uuid, uuid) TO authenticated",
      );
      expect(source).toContain(
        "GRANT EXECUTE ON FUNCTION public.finalize_transfer_result(uuid, text, text, uuid, bigint, text, uuid) TO authenticated",
      );
      expect(source).not.toContain("GRANT EXECUTE ON FUNCTION private.assert_v2_open_root");
      expect(source).not.toContain("GRANT EXECUTE ON FUNCTION private.assert_result_matches_request");
      expect(source).not.toMatch(/GRANT EXECUTE[^;]*TO anon/i);
    }
  });
});
