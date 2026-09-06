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
const patch = () => read("supabase/manual-patch-m9.sql");

const LEGACY_RPCS = [
  "public.create_handoff(uuid, text)",
  "public.begin_handoff_return(uuid)",
  "public.finalize_handoff_return_v2(uuid, uuid, bigint, text)",
  "public.mark_return_received(uuid)",
] as const;

const M9_RPCS = [
  "public.create_handoff_with_context(uuid, text, text, date)",
  "public.begin_handoff_return_next(uuid)",
  "public.finalize_handoff_return(uuid, integer, uuid, bigint, text)",
  "public.complete_handoff(uuid)",
  "public.request_revision(uuid, text)",
] as const;

const SHARED_BODIES = [
  "private.try_parse_handoff_object(",
  "private.reject_if_completed(p_status text)",
] as const;

describe("Milestone 9 SQL files", () => {
  it("keeps an idempotent patch and a full M9 setup", () => {
    const sql = setup();
    const m9 = patch();
    expect(m9).toContain("BEGIN;");
    expect(m9).toContain("COMMIT;");
    expect(m9).not.toContain("service_role");
    expect(m9).not.toContain("DROP FUNCTION");
    expect(m9).not.toContain("DROP POLICY");
    expect(m9).toContain("ADD COLUMN IF NOT EXISTS instruction");
    expect(m9).toContain("ADD COLUMN IF NOT EXISTS due_on");
    expect(sql).toContain("instruction text CHECK");
    expect(sql).toContain("due_on date");
    expect(sql).toContain("version_number integer NOT NULL CHECK (version_number BETWEEN 1 AND 1000)");
  });

  it("never introduces an extra review status name", () => {
    expect(setup()).not.toMatch(/awaiting[_]?review/i);
    expect(patch()).not.toMatch(/awaiting[_]?review/i);
  });

  it("keeps return_received as a Legacy status", () => {
    for (const source of [setup(), patch()]) {
      expect(source).toContain("'return_received'");
      expect(source).toContain("'revision_requested'");
      expect(source).toContain("'completed'");
    }
    const complete = functionBody(setup(), "public.complete_handoff(handoff_id uuid)");
    const genericReturn = functionBody(setup(), "public.finalize_handoff_return(");
    expect(complete).toContain("IS DISTINCT FROM 'returned'");
    expect(complete).not.toContain("return_received");
    expect(genericReturn).toContain("status = 'returned'");
    expect(genericReturn).not.toContain("return_received");
  });
});

describe("0.1.0 compatibility after M9", () => {
  it("keeps legacy RPC signatures in setup and does not replace them in the patch", () => {
    const sql = setup();
    const m9 = patch();
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.create_handoff(\n  recipient_member_id uuid,\n  original_filename text\n)");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.begin_handoff_return(handoff_id uuid)");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.finalize_handoff_return_v2(");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.mark_return_received(handoff_id uuid)");
    expect(m9).not.toContain("CREATE OR REPLACE FUNCTION public.create_handoff(");
    expect(m9).not.toContain("CREATE OR REPLACE FUNCTION public.begin_handoff_return(handoff_id uuid)");
    expect(m9).not.toContain("CREATE OR REPLACE FUNCTION public.finalize_handoff_return_v2(");
    expect(m9).not.toContain("CREATE OR REPLACE FUNCTION public.mark_return_received(handoff_id uuid)");
    for (const signature of LEGACY_RPCS) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated`);
      expect(m9).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated`,
      );
      expect(m9).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated`);
    }
  });

  it("keeps the 0.1.0 v1 to v2 to return_received machine in setup", () => {
    const create = functionBody(setup(), "public.create_handoff(");
    const begin = functionBody(setup(), "public.begin_handoff_return(handoff_id uuid)");
    const finalizeV2 = functionBody(setup(), "public.finalize_handoff_return_v2(");
    const markReturn = functionBody(setup(), "public.mark_return_received(handoff_id uuid)");
    expect(create).toContain("'/v1/'");
    expect(create).not.toContain("instruction");
    expect(create).toContain("status,\n    flow_version\n  )\n  VALUES (");
    expect(create).toContain("'uploading'");
    expect(begin).toContain("'/v2/'");
    expect(begin).toContain("IS DISTINCT FROM 'modified'");
    expect(begin).toContain("status = 'returning'");
    expect(finalizeV2).toContain("version_number = 2");
    expect(finalizeV2).toContain("status = 'returned'");
    expect(finalizeV2).toContain("FOR UPDATE");
    expect(markReturn).toContain("IS DISTINCT FROM 'returned'");
    expect(markReturn).toContain("status = 'return_received'");
    expect(markReturn).toContain("FOR UPDATE");
  });
});

describe("M9 RPCs", () => {
  it("adds new RPC signatures to setup and patch with matching bodies", () => {
    const sql = setup();
    const m9 = patch();
    for (const signature of M9_RPCS) {
      expect(sql).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated`,
      );
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated`);
      expect(m9).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated`,
      );
      expect(m9).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated`);
    }
    for (const name of SHARED_BODIES) {
      const fromSetup = functionBody(sql, name);
      const fromPatch = functionBody(m9, name);
      expect(fromSetup.length).toBeGreaterThan(80);
      expect(fromPatch).toBe(fromSetup);
    }
  });

  it("validates instruction, revision notes, and sender-only completion", () => {
    const create = functionBody(setup(), "public.create_handoff_with_context(");
    const revision = functionBody(setup(), "public.request_revision(handoff_id uuid, note text)");
    const complete = functionBody(setup(), "public.complete_handoff(handoff_id uuid)");
    expect(create).toContain("char_length(v_instruction) > 280");
    expect(create).toContain("v_instruction ~ '[[:cntrl:]]'");
    expect(create).toContain("'instruction_required'");
    expect(create).toContain("create_handoff_with_context.due_on");
    expect(revision).toContain("char_length(v_note) > 500");
    expect(revision).toContain("v_note ~ '[[:cntrl:]]'");
    expect(revision).toContain("'revision_note_required'");
    expect(revision).toContain("h.sender_member_id");
    expect(revision).toContain("IS DISTINCT FROM 'returned'");
    expect(revision).toContain("FOR UPDATE");
    expect(complete).toContain("h.sender_member_id");
    expect(complete).toContain("IS DISTINCT FROM 'returned'");
    expect(complete).toContain("FOR UPDATE");
    expect(complete).toContain("status = 'completed'");
  });

  it("finalizes the next version in one transaction under FOR UPDATE", () => {
    const beginNext = functionBody(setup(), "public.begin_handoff_return_next(handoff_id uuid)");
    const finalize = functionBody(setup(), "public.finalize_handoff_return(");
    expect(beginNext).toContain("FOR UPDATE");
    expect(beginNext).toContain("COALESCE(pg_catalog.max(v.version_number), 0) + 1");
    expect(beginNext).toContain("v_next > 1000");
    expect(finalize).toContain("FOR UPDATE");
    expect(finalize).toContain("version_number IS DISTINCT FROM v_expected");
    expect(finalize).toContain("private.insert_handoff_version(");
    expect(finalize.indexOf("private.insert_handoff_version(")).toBeLessThan(
      finalize.indexOf("SET status = 'returned'"),
    );
    expect(finalize).not.toContain("UPDATE public.handoff_versions");
  });
});

const SAMPLE_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function tryParseHandoffObject(objectName: string | null): {
  workspace_id: string | null;
  handoff_id: string | null;
  version_number: number | null;
} {
  const empty = { workspace_id: null, handoff_id: null, version_number: null };
  if (objectName == null) {
    return empty;
  }
  const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const parts = objectName.split("/");
  if (parts.length !== 4) {
    return empty;
  }
  if (!parts[0] || !uuid.test(parts[0])) {
    return empty;
  }
  if (!parts[1] || !uuid.test(parts[1])) {
    return empty;
  }
  if (
    !parts[2] ||
    parts[2].length > 5 ||
    !/^v[1-9][0-9]*$/.test(parts[2])
  ) {
    return empty;
  }
  if (!parts[3] || !uuid.test(parts[3])) {
    return empty;
  }
  try {
    const version = Number.parseInt(parts[2].slice(1), 10);
    if (!Number.isInteger(version) || version < 1 || version > 1000) {
      return empty;
    }
    return {
      workspace_id: parts[0],
      handoff_id: parts[1],
      version_number: version,
    };
  } catch {
    return empty;
  }
}

function storagePath(version: string): string {
  return `${SAMPLE_UUID}/${SAMPLE_UUID}/${version}/${SAMPLE_UUID}`;
}

function helpersRejectPath(sql: string, objectName: string): boolean {
  const parse = functionBody(sql, "private.try_parse_handoff_object(");
  const readFn = functionBody(sql, "private.can_read_handoff_object(object_name text)");
  const upload = functionBody(sql, "private.can_upload_handoff_object(object_name text)");
  const parsed = tryParseHandoffObject(objectName);
  const parseRejects = parsed.version_number == null;
  const helpersReturnFalseOnNull =
    readFn.includes("v_version IS NULL THEN") &&
    readFn.includes("RETURN false") &&
    upload.includes("v_version IS NULL THEN") &&
    upload.includes("RETURN false") &&
    readFn.includes("FROM private.try_parse_handoff_object") &&
    upload.includes("FROM private.try_parse_handoff_object");
  return (
    parse.includes("pg_catalog.char_length(v_parts[3]) > 5") &&
    parse.includes("numeric_value_out_of_range") &&
    parseRejects &&
    helpersReturnFalseOnNull
  );
}

describe("canonical versions and helpers", () => {
  it("rejects non-canonical version segments before integer conversion", () => {
    const parse = functionBody(setup(), "private.try_parse_handoff_object(");
    expect(parse).toContain("pg_catalog.char_length(v_parts[3]) > 5");
    expect(parse).toContain("'^v[1-9][0-9]*$'");
    expect(parse).toContain("version_number > 1000");
    expect(parse).toContain("numeric_value_out_of_range");
    expect(parse).toContain("invalid_text_representation");
    expect(parse).toContain("array_length(v_parts, 1) IS DISTINCT FROM 4");
    expect(parse).toContain("v_parts[4] ~* v_uuid");
    expect(parse).not.toContain("NOT IN ('v1', 'v2')");
    expect(tryParseHandoffObject(storagePath("v1"))).toEqual({
      workspace_id: SAMPLE_UUID,
      handoff_id: SAMPLE_UUID,
      version_number: 1,
    });
    expect(tryParseHandoffObject(storagePath("v1000"))).toEqual({
      workspace_id: SAMPLE_UUID,
      handoff_id: SAMPLE_UUID,
      version_number: 1000,
    });
  });

  it("rejects oversized and non-canonical versions without throwing", () => {
    const rejected = [
      storagePath("v0"),
      storagePath("v01"),
      storagePath("v1001"),
      storagePath("v2147483648"),
      storagePath(`v${"9".repeat(300)}`),
    ];
    for (const objectName of rejected) {
      expect(() => tryParseHandoffObject(objectName)).not.toThrow();
      expect(tryParseHandoffObject(objectName).version_number).toBeNull();
      expect(helpersRejectPath(setup(), objectName)).toBe(true);
      expect(helpersRejectPath(patch(), objectName)).toBe(true);
    }
  });

  it("blocks third-party reads and completed uploads", () => {
    const readFn = functionBody(setup(), "private.can_read_handoff_object(object_name text)");
    const upload = functionBody(setup(), "private.can_upload_handoff_object(object_name text)");
    const visible = functionBody(
      setup(),
      "private.handoff_status_visible_to_recipient(p_status text)",
    );
    expect(readFn).toContain("private.handoff_readable(h.id)");
    expect(readFn).toContain("hv.storage_path = object_name");
    expect(upload).toContain("h.status = 'uploading'");
    expect(upload).toContain("h.status = 'returning'");
    expect(upload).toContain("COALESCE(pg_catalog.max(hv.version_number), 0) + 1");
    expect(upload).not.toContain("h.status = 'completed'");
    expect(visible).toContain("'revision_requested'");
    expect(visible).toContain("'completed'");
    expect(visible).not.toContain("'uploading'");
    expect(visible).not.toContain("'failed'");
  });

  it("keeps direct DML revoked", () => {
    const sql = setup();
    expect(sql).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.handoffs FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.handoff_versions FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.handoff_events FROM PUBLIC, anon, authenticated",
    );
    expect(patch()).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.handoffs FROM PUBLIC, anon, authenticated",
    );
  });
});
