import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSql(): string {
  return readFileSync(path.join(process.cwd(), "supabase/manual-setup.sql"), "utf8").replace(
    /\r\n/g,
    "\n",
  );
}

function readPatch(): string {
  return readFileSync(path.join(process.cwd(), "supabase/manual-patch-4b1.sql"), "utf8").replace(
    /\r\n/g,
    "\n",
  );
}

function definerFunctions(sql: string): Array<{ name: string; header: string; body: string }> {
  const found: Array<{ name: string; header: string; body: string }> = [];
  const re =
    /CREATE OR REPLACE FUNCTION\s+((?:private|public)\.[a-z0-9_]+)\s*\(([^)]*)\)([\s\S]*?)AS\s*\$\$([\s\S]*?)\$\$;/gi;
  for (const match of sql.matchAll(re)) {
    const header = match[3] ?? "";
    if (!/SECURITY DEFINER/i.test(header)) {
      continue;
    }
    found.push({
      name: match[1] ?? "",
      header,
      body: match[4] ?? "",
    });
  }
  return found;
}

function firstIndex(sql: string, snippet: string): number {
  const index = sql.indexOf(snippet);
  if (index < 0) {
    throw new Error(`missing snippet: ${snippet}`);
  }
  return index;
}

describe("manual-setup join code rotation", () => {
  it("adds rotate_workspace_join_code with creator-only privileges", () => {
    const sql = readSql();
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION public.rotate_workspace_join_code(workspace_id uuid)",
    );
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = ''");
    expect(sql).toContain("w.created_by = v_user_id");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.rotate_workspace_join_code(uuid) FROM PUBLIC, anon",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.rotate_workspace_join_code(uuid) TO authenticated",
    );
  });

  it("stores only a hash and returns the raw code once", () => {
    const sql = readSql();
    const workspacesTable =
      sql.match(/CREATE TABLE IF NOT EXISTS public\.workspaces \([\s\S]*?\);/)?.[0] ?? "";
    expect(workspacesTable).toContain("join_code_hash bytea NOT NULL");
    expect(workspacesTable).not.toMatch(/\bjoin_code\s+text/i);
    expect(sql).toContain("SET join_code_hash = private.hash_join_code(v_pretty)");
    const rotateFn = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.rotate_workspace_join_code"),
      sql.indexOf("CREATE OR REPLACE FUNCTION public.create_handoff"),
    );
    expect(rotateFn).toContain("RETURN pg_catalog.jsonb_build_object('join_code', v_pretty);");
    expect(rotateFn).not.toMatch(/RETURN pg_catalog\.jsonb_build_object\([^)]*join_code_hash/);
    expect(rotateFn).not.toContain("v_hash");
  });

  it("names a new workspace after the creator display name", () => {
    const sql = readSql();
    expect(sql).toContain("'הצוות של ' || v_name");
  });

  it("keeps an idempotent 4B.1 rotate patch for an older database", () => {
    const patch = readPatch();
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("COMMIT;");
    expect(patch).toContain(
      "CREATE OR REPLACE FUNCTION public.rotate_workspace_join_code(workspace_id uuid)",
    );
    expect(patch).toContain("SET search_path = ''");
    expect(patch).toContain("w.created_by = v_user_id");
    expect(patch).toContain(
      "GRANT EXECUTE ON FUNCTION public.rotate_workspace_join_code(uuid) TO authenticated",
    );
    expect(patch).not.toContain("DROP FUNCTION");
    expect(patch).not.toContain("service_role");
  });
});

describe("manual-setup SECURITY DEFINER hardening", () => {
  it("sets an empty search_path on every SECURITY DEFINER function", () => {
    const sql = readSql();
    const definers = definerFunctions(sql);
    expect(definers.map((fn) => fn.name).sort()).toEqual([
      "private.can_read_handoff_object",
      "private.can_upload_handoff_object",
      "private.is_handoff_participant",
      "private.is_workspace_member",
      "private.touch_handoff_updated_at",
      "public.begin_handoff_return",
      "public.begin_handoff_return_next",
      "public.complete_handoff",
      "public.create_handoff",
      "public.create_handoff_with_context",
      "public.create_workspace",
      "public.fail_handoff",
      "public.fail_handoff_return",
      "public.finalize_handoff_return",
      "public.finalize_handoff_return_v2",
      "public.finalize_handoff_v1",
      "public.join_workspace",
      "public.mark_handoff_modified",
      "public.mark_handoff_opened",
      "public.mark_handoff_received",
      "public.mark_handoff_unmodified",
      "public.mark_return_received",
      "public.request_revision",
      "public.rotate_workspace_join_code",
    ]);
    for (const fn of definers) {
      expect(fn.header).toContain("SET search_path = ''");
      expect(fn.header).not.toContain("pg_catalog, public");
    }
    expect(sql).not.toContain("search_path = pg_catalog, public");
  });

  it("keeps helper functions in private and schema-qualifies sensitive tables", () => {
    const sql = readSql();
    expect(sql).toContain("CREATE SCHEMA IF NOT EXISTS private");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION private.is_workspace_member");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION private.normalize_join_code");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION private.hash_join_code");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION private.generate_join_code");
    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.(is_workspace_member|normalize_join_code|hash_join_code|generate_join_code)/,
    );

    const unqualified =
      /\b(?:FROM|JOIN|INTO|UPDATE)\s+(workspaces|workspace_members|handoffs|handoff_versions|handoff_events)\b/i;
    for (const fn of definerFunctions(sql)) {
      expect(fn.body).not.toMatch(unqualified);
    }
  });

  it("grants EXECUTE to authenticated only for RLS helpers and public RPCs", () => {
    const sql = readSql();
    const grants = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION (.+?) TO ([^;]+);/g)].map(
      ([, fn, role]) => ({ fn, role: role?.trim() }),
    );
    expect([...new Set(grants.map((row) => row.fn))].sort()).toEqual([
      "private.can_read_handoff_object(text)",
      "private.can_upload_handoff_object(text)",
      "private.handoff_status_visible_to_recipient(text)",
      "private.is_handoff_participant(uuid)",
      "private.is_workspace_member(uuid)",
      "public.begin_handoff_return(uuid)",
      "public.begin_handoff_return_next(uuid)",
      "public.complete_handoff(uuid)",
      "public.create_handoff(uuid, text)",
      "public.create_handoff_with_context(uuid, text, text, date)",
      "public.create_workspace(text, uuid)",
      "public.fail_handoff(uuid)",
      "public.fail_handoff_return(uuid)",
      "public.finalize_handoff_return(uuid, integer, uuid, bigint, text)",
      "public.finalize_handoff_return_v2(uuid, uuid, bigint, text)",
      "public.finalize_handoff_v1(uuid, uuid, bigint, text)",
      "public.join_workspace(text, text, uuid)",
      "public.mark_handoff_modified(uuid)",
      "public.mark_handoff_opened(uuid)",
      "public.mark_handoff_received(uuid)",
      "public.mark_handoff_unmodified(uuid)",
      "public.mark_return_received(uuid)",
      "public.request_revision(uuid, text)",
      "public.rotate_workspace_join_code(uuid)",
    ]);
    expect(grants.every((row) => row.role === "authenticated")).toBe(true);
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]*TO anon/i);
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION private.normalize_join_code(text) FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION private.hash_join_code(text) FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION private.generate_join_code() FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION private.try_parse_handoff_object(text) FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain("REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated");
    expect(sql).not.toContain("GRANT USAGE ON SCHEMA private TO anon");
  });

  it("does not use open policies or expose join_code_hash to the app role", () => {
    const sql = readSql();
    expect(sql).not.toMatch(/USING\s*\(\s*true\s*\)/i);
    expect(sql).toContain(
      "GRANT SELECT (id, name, created_by, created_at) ON public.workspaces TO authenticated",
    );
    expect(sql).not.toMatch(
      /GRANT SELECT\s*\([^)]*join_code_hash[^)]*\) ON public\.workspaces/i,
    );
    expect(sql).not.toMatch(/GRANT SELECT ON public\.workspaces TO authenticated/);
  });

  it("avoids workspace_members RLS recursion by using the private membership helper", () => {
    const sql = readSql();
    const policy =
      sql.match(
        /CREATE POLICY workspace_members_select_same_team[\s\S]*?;/,
      )?.[0] ?? "";
    expect(policy).toContain("USING (private.is_workspace_member(workspace_id))");
    expect(policy).not.toMatch(/FROM\s+public\.workspace_members/i);
    const helper =
      sql.match(
        /CREATE OR REPLACE FUNCTION private\.is_workspace_member[\s\S]*?\$\$;/,
      )?.[0] ?? "";
    expect(helper).toContain("RETURNS boolean");
    expect(helper).not.toContain("join_code_hash");
  });
});

describe("manual-setup handoff and storage hardening", () => {
  it("creates tables before functions that depend on them and wraps the script in a transaction", () => {
    const sql = readSql();
    const withoutComments = sql
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    expect(withoutComments.startsWith("BEGIN;")).toBe(true);
    expect(withoutComments.endsWith("COMMIT;")).toBe(true);

    expect(firstIndex(sql, "CREATE TABLE IF NOT EXISTS public.workspace_members")).toBeLessThan(
      firstIndex(sql, "CREATE OR REPLACE FUNCTION private.is_workspace_member"),
    );
    expect(firstIndex(sql, "CREATE TABLE IF NOT EXISTS public.handoffs")).toBeLessThan(
      firstIndex(sql, "CREATE OR REPLACE FUNCTION private.is_handoff_participant"),
    );
    expect(firstIndex(sql, "CREATE TABLE IF NOT EXISTS public.handoffs")).toBeLessThan(
      firstIndex(sql, "CREATE OR REPLACE FUNCTION private.can_read_handoff_object"),
    );
  });

  it("enforces one workspace per user", () => {
    const sql = readSql();
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_one_workspace_per_user");
    expect(sql).toContain("ON public.workspace_members (user_id)");
    const createFn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.create_workspace"));
    const joinFn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.join_workspace"));
    expect(createFn).toContain("WHEN unique_violation THEN");
    expect(createFn).toContain("already_in_workspace");
    expect(joinFn).toContain("WHEN unique_violation THEN");
    expect(joinFn).toContain("v_existing_workspace_id = v_workspace_id");
  });

  it("revokes direct DML on transfer tables and grants SELECT only", () => {
    const sql = readSql();
    expect(sql).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.handoffs FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.handoff_versions FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.handoff_events FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain("GRANT SELECT ON public.handoffs TO authenticated");
    expect(sql).not.toContain("GRANT SELECT, INSERT ON public.handoffs TO authenticated");
    expect(sql).not.toContain("GRANT UPDATE (status) ON public.handoffs TO authenticated");
    expect(sql).not.toMatch(/CREATE POLICY handoffs_update_participant\b/);
    expect(sql).not.toMatch(/CREATE POLICY handoffs_insert_sender\b/);
    expect(sql).toContain("CREATE TRIGGER handoffs_set_updated_at");
    expect(sql).toContain("NEW.updated_at := pg_catalog.now()");
  });

  it("hides uploading and failed handoffs from the recipient and from third members", () => {
    const sql = readSql();
    const selectPolicy =
      sql.match(/CREATE POLICY handoffs_select_participant[\s\S]*?;/)?.[0] ?? "";
    expect(selectPolicy).toContain("sender.user_id = auth.uid()");
    expect(selectPolicy).toContain("recipient.user_id = auth.uid()");
    expect(selectPolicy).toContain("handoffs.sender_member_id");
    expect(selectPolicy).toContain("handoffs.recipient_member_id");
    expect(selectPolicy).toContain("private.handoff_status_visible_to_recipient(handoffs.status)");
    expect(selectPolicy).not.toContain("is_workspace_member");
    expect(selectPolicy).not.toContain("status <> 'uploading'");
    const versionsSelect =
      sql.match(/CREATE POLICY handoff_versions_select_participant[\s\S]*?;/)?.[0] ?? "";
    expect(versionsSelect).toContain("h.id = handoff_versions.handoff_id");
    expect(versionsSelect).toContain("private.handoff_status_visible_to_recipient(h.status)");
    const eventsSelect =
      sql.match(/CREATE POLICY handoff_events_select_participant[\s\S]*?;/)?.[0] ?? "";
    expect(eventsSelect).toContain("h.id = handoff_events.handoff_id");
    expect(eventsSelect).toContain("private.handoff_status_visible_to_recipient(h.status)");
  });

  it("mutates handoffs only through SECURITY DEFINER RPCs", () => {
    const sql = readSql();
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.create_handoff(");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.finalize_handoff_v1(");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.fail_handoff(");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.mark_handoff_received(");
    const finalize =
      sql.match(/CREATE OR REPLACE FUNCTION public\.finalize_handoff_v1[\s\S]*?\$\$;/)?.[0] ?? "";
    expect(finalize).toContain("FROM storage.objects o");
    expect(finalize).toContain("bucket_id = 'filerelay'");
    expect(finalize).toContain("v_object_owner_id text");
    expect(finalize).toContain("o.owner_id");
    expect(finalize).toContain("v_object_owner_id IS DISTINCT FROM v_user_id::text");
    expect(finalize).not.toMatch(/\bo\.owner\b/);
    expect(finalize).not.toContain("v_object_owner uuid");
    expect(finalize).toContain("event_type");
    expect(finalize).toContain("'finalized'");
    expect(finalize).not.toContain("v1_available");
    expect(sql).not.toMatch(/CREATE POLICY handoff_versions_insert_member\b/);
    expect(sql).not.toMatch(/CREATE POLICY handoff_events_insert_member\b/);
  });

  it("makes storage objects immutable and limits v1 upload to the sender while uploading", () => {
    const sql = readSql();
    expect(sql).toContain("DROP POLICY IF EXISTS filerelay_storage_update ON storage.objects");
    expect(sql).toContain("DROP POLICY IF EXISTS filerelay_storage_delete ON storage.objects");
    expect(sql).not.toMatch(/CREATE POLICY filerelay_storage_update\b/);
    expect(sql).not.toMatch(/CREATE POLICY filerelay_storage_delete\b/);
    expect(sql).not.toMatch(/CREATE POLICY[\s\S]*ON storage\.objects\s+FOR UPDATE/i);
    expect(sql).not.toMatch(/CREATE POLICY[\s\S]*ON storage\.objects\s+FOR DELETE/i);

    const upload =
      sql.match(
        /CREATE OR REPLACE FUNCTION private\.can_upload_handoff_object[\s\S]*?\$\$;/,
      )?.[0] ?? "";
    expect(upload).toContain("v_version = 1");
    expect(upload).toContain("m.id = h.sender_member_id");
    expect(upload).toContain("h.status = 'uploading'");
    expect(upload).not.toContain("v_version = 2 AND m.id = h.recipient_member_id");
    expect(upload).toContain("SET search_path = ''");
    expect(sql).toContain("AND private.can_read_handoff_object(name)");
    expect(sql).toContain("AND private.can_upload_handoff_object(name)");

    const read =
      sql.match(
        /CREATE OR REPLACE FUNCTION private\.can_read_handoff_object[\s\S]*?\$\$;/,
      )?.[0] ?? "";
    expect(read).toContain("JOIN public.handoff_versions hv");
    expect(read).toContain("hv.handoff_id = v_handoff_id");
    expect(read).toContain("hv.version_number = v_version");
    expect(read).toContain("hv.storage_path = object_name");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION private.can_read_handoff_object(text)\n  FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION private.can_read_handoff_object(text)\n  TO authenticated",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION private.can_upload_handoff_object(text)\n  FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION private.can_upload_handoff_object(text)\n  TO authenticated",
    );
  });
});
