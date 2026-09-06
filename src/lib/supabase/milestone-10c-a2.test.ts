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

function createSignatures(sql: string): string[] {
  return [...sql.matchAll(/CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+((?:private|public)\.[a-z0-9_]+)\s*\(([^)]*)\)/gi)].map(
    (match) => {
      const args = (match[2] ?? "")
        .split(",")
        .map((part) => part.trim().replace(/\s+/g, " ").replace(/\s+DEFAULT\b[\s\S]*$/i, ""))
        .filter(Boolean)
        .join(", ");
      return `${(match[1] ?? "").toLowerCase()}(${args.toLowerCase()})`;
    },
  );
}

function insertBlocks(sql: string): string[] {
  return [...sql.matchAll(/INSERT INTO public\.handoff_versions\s*\(([\s\S]*?)\)\s*VALUES/gi)].map(
    (match) => match[1] ?? "",
  );
}

const setup = () => read("supabase/manual-setup.sql");
const patch = () => read("supabase/manual-patch-m10c-a2.sql");
const helpers = () => read("supabase/fragments/m10c-a2-helpers.sql");
const functions = () => read("supabase/fragments/m10c-a2-functions.sql");
const triggers = () => read("supabase/fragments/m10c-a2-triggers.sql");
const m10cFragment = () => read("supabase/fragments/m10c-functions.sql");
const SCHEMA_QUALIFIED_SYNTAX = /\bpg_catalog\.(nullif|coalesce|greatest|least)\s*\(/i;

const SHARED_BODIES = [
  "private.assert_safe_file_name(p_file_name text)",
  "private.insert_handoff_version(",
  "private.assert_reserved_upload_matches(",
  "private.assert_handoff_original_filename()",
  "public.create_file_request_v2(",
  "public.finalize_file_request_result(",
] as const;

const WRITER_BODIES = [
  "private.assert_result_matches_request(",
  "public.mark_root_transfer_opened(",
  "public.accept_root_transfer_result(",
  "public.finalize_handoff_v1(",
  "public.finalize_handoff_return_v2(",
  "public.finalize_handoff_return(",
  "public.finalize_handoff_v2_initial(",
  "public.finalize_transfer_result(",
] as const;

describe("Milestone 10C-A2 SQL files", () => {
  it("keeps an idempotent A2 patch and a full setup", () => {
    const sql = setup();
    const a2 = patch();
    expect(a2).toContain("BEGIN;");
    expect(a2).toContain("COMMIT;");
    expect(a2).not.toContain("service_role");
    expect(a2).not.toContain("DROP FUNCTION");
    expect(a2).not.toContain("CREATE FUNCTION ");
    expect(a2).toContain("ADD COLUMN IF NOT EXISTS file_name text");
    expect(a2).toContain("m10c_a2_version_file_name_unmigratable");
    expect(a2).toContain("ALTER COLUMN file_name SET NOT NULL");
    expect(sql).toContain("requested_action IN ('approval', 'review', 'update', 'file_request')");
    expect(sql).toContain("file_name text NOT NULL CHECK (");
    expect(sql).toContain("original_filename IS NULL");
  });

  it("matches A2 bodies between fragments, setup, and patch", () => {
    const sql = setup();
    const a2 = patch();
    for (const name of SHARED_BODIES) {
      const fromSetup = functionBody(sql, name);
      const fromPatch = functionBody(a2, name);
      const fromFragment = functionBody(
        name.startsWith("public.") ? functions() : helpers(),
        name,
      );
      expect(fromSetup.length).toBeGreaterThan(80);
      expect(fromPatch).toBe(fromSetup);
      expect(fromFragment).toBe(fromSetup);
    }
    for (const name of WRITER_BODIES) {
      const fromSetup = functionBody(sql, name);
      const fromPatch = functionBody(a2, name);
      expect(fromSetup.length).toBeGreaterThan(80);
      expect(fromPatch).toBe(fromSetup);
    }
    expect(functionBody(m10cFragment(), "public.finalize_transfer_result(")).toBe(
      functionBody(sql, "public.finalize_transfer_result("),
    );
    expect(triggers()).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(sql).toContain(triggers().trim());
    expect(a2).toContain(triggers().trim());
  });

  it("does not schema-qualify syntactic SQL constructs in A2 sources", () => {
    for (const source of [setup(), patch(), helpers(), functions(), triggers()]) {
      expect(source).not.toMatch(SCHEMA_QUALIFIED_SYNTAX);
    }
  });
});

describe("M10C-A2 signatures and writers", () => {
  it("keeps unique RPC signatures and the original seven-arg finalize", () => {
    const sql = setup();
    const a2 = patch();
    const finalizeHeader =
      sql.match(
        /CREATE OR REPLACE FUNCTION public\.finalize_transfer_result\s*\(([\s\S]*?)\)\s*RETURNS/,
      )?.[1] ?? "";
    expect(finalizeHeader).toContain("p_handoff_id uuid");
    expect(finalizeHeader).toContain("p_result_action text");
    expect(finalizeHeader).toContain("p_result_note text");
    expect(finalizeHeader).toContain("p_object_id uuid");
    expect(finalizeHeader).toContain("p_file_size bigint");
    expect(finalizeHeader).toContain("p_blake3 text");
    expect(finalizeHeader).toContain("p_client_request_id uuid");
    expect(finalizeHeader).not.toMatch(/\bDEFAULT\b/i);
    expect(finalizeHeader).not.toContain("p_file_name");
    expect((finalizeHeader.match(/\buuid\b/g) ?? []).length).toBe(3);
    expect((finalizeHeader.match(/\btext\b/g) ?? []).length).toBe(3);

    for (const source of [sql, a2]) {
      const signatures = createSignatures(source);
      expect(signatures).toContain(
        "public.create_file_request_v2(p_recipient_member_id uuid, p_instruction text, p_due_on date, p_client_request_id uuid)",
      );
      expect(signatures).toContain(
        "public.finalize_file_request_result(p_handoff_id uuid, p_file_name text, p_object_id uuid, p_file_size bigint, p_blake3 text, p_client_request_id uuid)",
      );
      expect(new Set(signatures).size).toBe(signatures.length);
      expect(source).not.toMatch(/CREATE\s+FUNCTION\s+/i);
    }
  });

  it("writes file_name on every handoff_versions insert through the shared helper", () => {
    const active = [setup(), patch(), helpers(), functions()];
    const inserts = active.flatMap(insertBlocks);
    expect(inserts.length).toBeGreaterThan(0);
    for (const columns of inserts) {
      expect(columns).toMatch(/\bfile_name\b/);
    }
    expect((helpers().match(/INSERT INTO public\.handoff_versions/g) ?? []).length).toBe(1);
    expect((functions().match(/INSERT INTO public\.handoff_versions/g) ?? []).length).toBe(0);
    expect((setup().match(/INSERT INTO public\.handoff_versions/g) ?? []).length).toBe(1);
    expect((patch().match(/INSERT INTO public\.handoff_versions/g) ?? []).length).toBe(1);
    expect(functionBody(setup(), "private.insert_handoff_version(")).toContain("file_name");
  });

  it("copies original_filename for legacy writers and p_file_name for file requests", () => {
    const sql = setup();
    expect(functionBody(sql, "public.finalize_handoff_v1(")).toContain("h.original_filename");
    expect(functionBody(sql, "public.finalize_handoff_v1(")).toContain("private.insert_handoff_version(");
    expect(functionBody(sql, "public.finalize_handoff_return(")).toContain("h.original_filename");
    expect(functionBody(sql, "public.finalize_handoff_return_v2(")).toContain("h.original_filename");
    expect(functionBody(sql, "public.finalize_handoff_v2_initial(")).toContain("h.original_filename");
    expect(functionBody(sql, "public.finalize_transfer_result(")).toContain("h.original_filename");
    expect(functionBody(sql, "public.finalize_transfer_result(")).toContain(
      "private.insert_handoff_version(",
    );
    expect(functionBody(sql, "public.finalize_file_request_result(")).toContain(
      "PERFORM private.insert_handoff_version(",
    );
    expect(functionBody(sql, "public.finalize_file_request_result(")).toContain("v_name");
    expect(functionBody(sql, "public.finalize_file_request_result(")).not.toContain(
      "h.original_filename",
    );
  });
});

describe("M10C-A2 migration order and idempotency", () => {
  it("adds file_name nullable, backfills, guards, replaces writers, then sets NOT NULL", () => {
    const a2 = patch();
    const order = [
      "handoff_transfers_requested_action_check",
      "ALTER COLUMN original_filename DROP NOT NULL",
      "ADD COLUMN IF NOT EXISTS file_name text",
      "SET file_name = h.original_filename",
      "AND v.file_name IS NULL",
      "m10c_a2_version_file_name_unmigratable",
      "CREATE OR REPLACE FUNCTION private.insert_handoff_version(",
      "CREATE OR REPLACE FUNCTION public.finalize_transfer_result(",
      "CREATE OR REPLACE FUNCTION public.finalize_file_request_result(",
      "ALTER COLUMN file_name SET NOT NULL",
      "handoff_versions_file_name_safe_check",
    ];
    let cursor = -1;
    for (const snippet of order) {
      const at = a2.indexOf(snippet);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(a2.indexOf("ADD COLUMN IF NOT EXISTS file_name text")).toBeLessThan(
      a2.indexOf("SET file_name = h.original_filename"),
    );
    expect(a2.indexOf("m10c_a2_version_file_name_unmigratable")).toBeLessThan(
      a2.indexOf("CREATE OR REPLACE FUNCTION public.finalize_handoff_v1("),
    );
    expect(a2.indexOf("CREATE OR REPLACE FUNCTION public.finalize_handoff_v1(")).toBeLessThan(
      a2.indexOf("ALTER COLUMN file_name SET NOT NULL"),
    );
    expect(a2).not.toContain("NOT VALID");
    expect(a2).not.toContain("unknown.txt");
    expect(a2).not.toContain("DELETE FROM public.handoff_versions");
  });

  it("is safe to re-run without dropping functions or rewriting named versions", () => {
    const a2 = patch();
    expect(a2).toContain("ADD COLUMN IF NOT EXISTS file_name text");
    expect(a2).toContain("AND v.file_name IS NULL");
    expect(a2).toContain("CREATE OR REPLACE FUNCTION");
    expect(a2).toContain("DROP TRIGGER IF EXISTS handoffs_original_filename_trg");
    expect(a2).toContain("DROP TRIGGER IF EXISTS handoff_transfers_original_filename_trg");
    expect(a2).toContain("IF NOT EXISTS (");
    expect(a2).toContain("WHERE conname = 'handoff_versions_file_name_safe_check'");
    expect((a2.match(/SET file_name = h\.original_filename/g) ?? []).length).toBe(1);
    expect(a2).not.toContain("DROP FUNCTION");
    expect(a2).not.toContain("UPDATE storage.objects");
    expect(a2).not.toContain("DELETE FROM storage.objects");
  });
});

describe("M10C-A2 file request RPCs", () => {
  it("creates an active file request without a reservation or version", () => {
    const create = functionBody(setup(), "public.create_file_request_v2(");
    expect(create).toContain("'file_request'");
    expect(create).toContain("'active'");
    expect(create).toContain("original_filename");
    expect(create).toContain("NULL");
    expect(create).toContain("'created'");
    expect(create).toContain("private.claim_command_receipt(");
    expect(create).toContain("'create_file_request_v2'");
    expect(create).not.toContain("private.insert_handoff_version(");
    expect(create).not.toContain("pending_object_id");
    expect(create).not.toContain("pending_storage_path");
    expect(create).not.toContain("'finalized'");
    expect(create).not.toContain("'preparing'");
    expect(create).not.toContain("'failed'");
    expect((create.match(/INSERT INTO public\.handoff_events/g) ?? []).length).toBe(1);
    expect(functionBody(setup(), "public.create_handoff_v2(")).toContain(
      "v_action NOT IN ('approval', 'review', 'update')",
    );
  });

  it("finalizes a supplied file on a dedicated RPC and rejects the old finalize", () => {
    const fileFinalize = functionBody(setup(), "public.finalize_file_request_result(");
    const transferFinalize = functionBody(setup(), "public.finalize_transfer_result(");
    expect(fileFinalize).toContain("NULLIF(pg_catalog.btrim(p_file_name), ''::text)");
    expect(fileFinalize).toContain("private.assert_safe_file_name(");
    expect(fileFinalize).toContain("private.assert_reserved_upload_matches(");
    expect(fileFinalize).toContain("private.insert_handoff_version(");
    expect(fileFinalize).toContain("'returned_to_sender'");
    expect(fileFinalize).toContain("'returned_with_file'");
    expect(fileFinalize).toContain("'file_request'");
    expect(fileFinalize).toContain("'result_action_mismatch'");
    expect(fileFinalize).not.toContain("request_status = 'completed'");
    expect(fileFinalize).not.toMatch(/event_type[\s\S]{0,80}'completed'/);
    expect(fileFinalize).not.toContain("h.original_filename");
    expect(transferFinalize).toContain("v_hop.requested_action = 'file_request'");
    expect(transferFinalize).toContain("'result_action_mismatch'");
    expect(transferFinalize).toContain("h.original_filename");
    expect(transferFinalize).not.toContain("p_file_name");
  });

  it("accepts a file request only after a versioned returned_with_file", () => {
    const accept = functionBody(setup(), "public.accept_root_transfer_result(");
    expect(accept).toContain("v_hop.requested_action = 'file_request'");
    expect(accept).toContain("'returned_with_file'");
    expect(accept).toContain("result_version_number IS NULL");
    expect(accept).toContain("'handoff_complete_failed'");
  });

  it("blocks opened while the file request is still active", () => {
    const opened = functionBody(setup(), "public.mark_root_transfer_opened(");
    expect(opened).toContain("'file_request_not_yet_supplied'");
    expect(opened).toContain("v_hop.requested_action = 'file_request'");
    expect(opened).toContain("v_hop.transfer_status = 'active'");
    expect(opened).toContain("'returned_to_sender'");
    expect(opened).toContain("from_member_id");
    expect(opened).toContain("result_version_number IS NOT NULL");
  });

  it("pairs file_request to returned_with_file or rejected only", () => {
    const pairing = functionBody(setup(), "private.assert_result_matches_request(");
    expect(pairing).toContain("'file_request'");
    expect(pairing).toContain("'returned_with_file'");
    expect(pairing).toContain("'rejected'");
    const submit = functionBody(setup(), "public.submit_transfer_result_without_file(");
    expect(submit).toContain("private.assert_result_matches_request(");
    expect(submit).toContain("'returned_with_file'");
    expect(submit).not.toContain("INSERT INTO public.handoff_versions");
  });

  it("keeps legacy finalize signatures and writes file_name from original_filename", () => {
    const sql = setup();
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.finalize_handoff_v1(uuid, uuid, bigint, text) TO authenticated");
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.finalize_handoff_return(uuid, integer, uuid, bigint, text) TO authenticated",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.finalize_handoff_return_v2(uuid, uuid, bigint, text) TO authenticated",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.finalize_handoff_v2_initial(uuid, uuid, bigint, text, uuid) TO authenticated",
    );
    for (const name of [
      "public.finalize_handoff_v1(",
      "public.finalize_handoff_return(",
      "public.finalize_handoff_return_v2(",
      "public.finalize_handoff_v2_initial(",
    ] as const) {
      const body = functionBody(sql, name);
      expect(body).toContain("h.original_filename");
      expect(body).toContain("private.insert_handoff_version(");
      expect(body).not.toContain("p_file_name");
    }
  });

  it("keeps approval, review, and update file results on the original seven-arg finalize", () => {
    const pairing = functionBody(setup(), "private.assert_result_matches_request(");
    const finalize = functionBody(setup(), "public.finalize_transfer_result(");
    expect(pairing).toContain("'approval'");
    expect(pairing).toContain("'approved'");
    expect(pairing).toContain("'review'");
    expect(pairing).toContain("'review_completed'");
    expect(pairing).toContain("'update'");
    expect(finalize).toContain("private.assert_result_matches_request(");
    expect(finalize).toContain("private.insert_handoff_version(");
    expect(finalize).toContain("h.original_filename");
    expect(finalize).toContain("'approved'");
    expect(finalize).not.toMatch(/\bDEFAULT\b/);
    expect(
      setup().match(
        /CREATE OR REPLACE FUNCTION public\.finalize_transfer_result\s*\(([\s\S]*?)\)\s*RETURNS/,
      )?.[1],
    ).not.toContain("p_file_name");
  });

  it("lets the recipient reserve v1 then v2 with a distinct file_name after revision", () => {
    const begin = functionBody(setup(), "public.begin_transfer_result_upload(");
    const revision = functionBody(setup(), "public.request_root_transfer_revision(");
    const fileFinalize = functionBody(setup(), "public.finalize_file_request_result(");
    const create = functionBody(setup(), "public.create_file_request_v2(");
    expect(create).not.toContain("private.insert_handoff_version(");
    expect(begin).toContain("COALESCE(pg_catalog.max(hv.version_number), 0) + 1");
    expect(begin).toContain("pending_object_id IS NOT NULL");
    expect(begin.indexOf("pending_object_id IS NOT NULL")).toBeLessThan(
      begin.indexOf("gen_random_uuid()"),
    );
    expect(revision).toContain("handling_round = v_next_round");
    expect(revision).toContain("status = 'active'");
    expect(revision).toContain("result_version_number = NULL");
    expect(revision).not.toContain("DELETE FROM public.handoff_versions");
    expect(fileFinalize).toContain("v_hop.pending_version_number");
    expect(fileFinalize).toContain("v_name");
    expect(fileFinalize).not.toContain("h.original_filename");
  });

  it("rejects a file-request success without a file", () => {
    const submit = functionBody(setup(), "public.submit_transfer_result_without_file(");
    const accept = functionBody(setup(), "public.accept_root_transfer_result(");
    const pairing = functionBody(setup(), "private.assert_result_matches_request(");
    expect(submit).toContain("IF v_action = 'returned_with_file'");
    expect(submit).toContain("'handoff_return_finalize_failed'");
    expect(submit).not.toContain("private.insert_handoff_version(");
    expect(pairing).toContain(
      "p_requested_action = 'file_request'\n     AND p_result_action IN ('returned_with_file', 'rejected')",
    );
    expect(accept).toContain("result_version_number IS NULL");
    expect(accept).toContain("'handoff_complete_failed'");
  });

  it("uses receipts and unique constraints so retries and parallel calls do not double-write", () => {
    const create = functionBody(setup(), "public.create_file_request_v2(");
    const fileFinalize = functionBody(setup(), "public.finalize_file_request_result(");
    const begin = functionBody(setup(), "public.begin_transfer_result_upload(");
    const claim = functionBody(setup(), "private.claim_command_receipt(");
    expect(create).toContain("private.claim_command_receipt(");
    expect(create).toContain("'create_file_request_v2'");
    expect(create).toContain("IF NOT v_won THEN");
    expect(create).toContain("'idempotency_incomplete'");
    expect(create).toContain("RETURN v_existing");
    expect(create.indexOf("claim_command_receipt")).toBeLessThan(
      create.indexOf("INSERT INTO public.handoffs"),
    );
    expect(fileFinalize).toContain("private.claim_command_receipt(");
    expect(fileFinalize).toContain("'finalize_file_request_result'");
    expect(fileFinalize).toContain("|| v_name ||");
    expect(fileFinalize).toContain("|| v_hash");
    expect(fileFinalize).toContain("IF NOT v_won THEN");
    expect(fileFinalize).toContain("RETURN v_existing");
    expect(fileFinalize.indexOf("claim_command_receipt")).toBeLessThan(
      fileFinalize.indexOf("private.insert_handoff_version("),
    );
    expect(begin).toContain("'reservation_still_held'");
    expect(begin).toContain("AND pending_object_id IS NULL");
    expect(claim).toContain("ON CONFLICT (actor_member_id, client_request_id) DO NOTHING");
    expect(claim).toContain("'idempotency_conflict'");
    expect(setup()).toContain("CREATE UNIQUE INDEX IF NOT EXISTS handoff_versions_handoff_version_key");
  });

  it("gives a third workspace member no read or write path", () => {
    const sql = setup();
    const a2 = patch();
    const create = functionBody(sql, "public.create_file_request_v2(");
    const fileFinalize = functionBody(sql, "public.finalize_file_request_result(");
    const readable = functionBody(sql, "private.handoff_readable(p_handoff_id uuid)");
    expect(create).toContain("v_recipient_workspace IS DISTINCT FROM v_workspace_id");
    expect(create).toContain("p_recipient_member_id = v_sender_id");
    expect(fileFinalize).toContain("v_hop.to_member_id IS DISTINCT FROM v_actor_id");
    expect(readable).toContain("m.id IN (t.from_member_id, t.to_member_id)");
    expect(sql).toContain("USING (private.handoff_readable(id))");
    expect(sql).toContain("USING (private.handoff_readable(handoff_id))");
    expect(a2).not.toContain("ADD TABLE public.");
    expect(a2).not.toContain("GRANT EXECUTE ON FUNCTION private.insert_handoff_version");
    expect(a2).not.toContain("GRANT EXECUTE ON FUNCTION private.assert_reserved_upload_matches");
    expect(a2).not.toMatch(/GRANT EXECUTE[^;]*TO anon/i);
    expect(a2).not.toContain("service_role");
  });
});

describe("M10C-A2 filename rules", () => {
  it("enforces original_filename with deferred triggers on both tables", () => {
    const triggerFn = functionBody(setup(), "private.assert_handoff_original_filename()");
    const sql = setup();
    expect(triggerFn).toContain("'original_filename_required'");
    expect(triggerFn).toContain("'original_filename_not_allowed'");
    expect(triggerFn).toContain("'file_request'");
    expect(triggerFn).toContain("TG_TABLE_NAME = 'handoffs'");
    expect(triggerFn).toContain("NEW.parent_transfer_id IS NOT NULL");
    expect(sql).toContain("CONSTRAINT TRIGGER handoffs_original_filename_trg");
    expect(sql).toContain("CONSTRAINT TRIGGER handoff_transfers_original_filename_trg");
    expect(sql).toContain("AFTER INSERT OR UPDATE OF original_filename, flow_version ON public.handoffs");
    expect(sql).toContain(
      "AFTER INSERT OR UPDATE OF requested_action, parent_transfer_id, handoff_id ON public.handoff_transfers",
    );
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
  });

  it("rejects reserved, control, path, and trailing-dot Windows names", () => {
    const safe = functionBody(setup(), "private.assert_safe_file_name(p_file_name text)");
    expect(safe).toContain("'unsafe_file_name'");
    expect(safe).toContain("[[:cntrl:]]");
    expect(safe).toContain("[. ]$");
    expect(safe).toContain("[\\\\/]");
    expect(safe).toContain("%..%");
    expect(safe).toContain("'CON'");
    expect(safe).toContain("'PRN'");
    expect(safe).toContain("'AUX'");
    expect(safe).toContain("'NUL'");
    expect(safe).toContain("'COM1'");
    expect(safe).toContain("'LPT1'");
    expect(safe).not.toContain("'_' ||");
    expect(functionBody(setup(), "public.finalize_file_request_result(")).toContain(
      "private.assert_safe_file_name(",
    );
    const reserved = functionBody(setup(), "private.assert_reserved_upload_matches(");
    expect(reserved).toContain("p_blake3 !~ '^[0-9a-f]{64}$'");
    expect(reserved).toContain("FROM storage.objects o");
    expect(reserved).toContain("v_object_owner_id IS DISTINCT FROM p_user_id::text");
    expect(reserved).toContain("handoff_object_size_mismatch");
  });
});
