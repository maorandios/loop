import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");
}

describe("manual-setup Milestone 6 transfer RPCs", () => {
  it("keeps an idempotent patch and the same RPCs in the full setup", () => {
    const sql = read("supabase/manual-setup.sql");
    const patch = read("supabase/manual-patch-m6.sql");
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("COMMIT;");
    expect(patch).not.toContain("service_role");
    expect(patch).not.toContain("DROP FUNCTION");
    expect(patch).toContain("CREATE OR REPLACE FUNCTION public.create_handoff(");
    expect(patch).toContain("CREATE OR REPLACE FUNCTION public.finalize_handoff_v1(");
    expect(patch).toContain("handoff_already_finalized");
    expect(patch).toContain("handoff_object_missing");
    expect(patch).toContain("handoff_object_size_mismatch");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.create_handoff(");
    expect(sql).toContain("'finalized'");
    expect(sql).not.toContain("v1_available");
    expect(sql.indexOf("CREATE TABLE IF NOT EXISTS public.handoffs")).toBeLessThan(
      sql.indexOf("CREATE INDEX IF NOT EXISTS handoffs_workspace_id_idx"),
    );
  });

  it("does not tighten event_type to an enum", () => {
    const sql = read("supabase/manual-setup.sql");
    expect(sql).toContain(
      "event_type text NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(event_type)) > 0)",
    );
    expect(sql).not.toMatch(/event_type text NOT NULL CHECK \(\s*event_type IN/i);
  });
});

describe.each(["supabase/manual-setup.sql", "supabase/manual-patch-m6.sql"] as const)(
  "SQL hardening in %s",
  (relativePath) => {
    function sql(): string {
      return read(relativePath);
    }

    it("compares Storage owner_id as text in finalize_handoff_v1", () => {
      const finalize =
        sql().match(/CREATE OR REPLACE FUNCTION public\.finalize_handoff_v1[\s\S]*?\$\$;/)?.[0] ??
        "";
      expect(finalize).toContain("v_object_owner_id text");
      expect(finalize).toContain("o.owner_id");
      expect(finalize).toContain("v_object_owner_id IS DISTINCT FROM v_user_id::text");
      expect(finalize).not.toMatch(/\bo\.owner\b/);
      expect(finalize).not.toContain("v_object_owner uuid");
    });

    it("requires a matching handoff_versions row before a Storage read", () => {
      const readFn =
        sql().match(
          /CREATE OR REPLACE FUNCTION private\.can_read_handoff_object[\s\S]*?\$\$;/,
        )?.[0] ?? "";
      expect(readFn).toContain("JOIN public.handoff_versions hv");
      expect(readFn).toContain("hv.handoff_id = v_handoff_id");
      expect(readFn).toContain("hv.version_number = v_version");
      expect(readFn).toContain("hv.storage_path = object_name");
    });

    it("revokes leftover Storage helper grants and grants EXECUTE to authenticated", () => {
      const source = sql();
      expect(source).toContain(
        "REVOKE ALL ON FUNCTION private.can_read_handoff_object(text)\n  FROM PUBLIC, anon, authenticated;",
      );
      expect(source).toContain(
        "GRANT EXECUTE ON FUNCTION private.can_read_handoff_object(text)\n  TO authenticated;",
      );
      expect(source).toContain(
        "REVOKE ALL ON FUNCTION private.can_upload_handoff_object(text)\n  FROM PUBLIC, anon, authenticated;",
      );
      expect(source).toContain(
        "GRANT EXECUTE ON FUNCTION private.can_upload_handoff_object(text)\n  TO authenticated;",
      );
      const afterRead = source.indexOf(
        "CREATE OR REPLACE FUNCTION private.can_read_handoff_object(object_name text)",
      );
      const revokeRead = source.indexOf(
        "REVOKE ALL ON FUNCTION private.can_read_handoff_object(text)",
        afterRead,
      );
      const grantRead = source.indexOf(
        "GRANT EXECUTE ON FUNCTION private.can_read_handoff_object(text)",
        revokeRead,
      );
      const afterUpload = source.indexOf(
        "CREATE OR REPLACE FUNCTION private.can_upload_handoff_object(object_name text)",
      );
      expect(afterRead).toBeGreaterThan(-1);
      expect(revokeRead).toBeGreaterThan(afterRead);
      expect(grantRead).toBeGreaterThan(revokeRead);
      expect(revokeRead).toBeLessThan(afterUpload);
    });

    it("rejects control characters, trailing dots or spaces, and Windows reserved names", () => {
      const create =
        sql().match(/CREATE OR REPLACE FUNCTION public\.create_handoff[\s\S]*?\$\$;/)?.[0] ?? "";
      expect(create).toContain("original_filename ~ '[[:cntrl:]]'");
      expect(create).toContain("original_filename ~ '[. ]$'");
      expect(create).toContain("'CON', 'PRN', 'AUX', 'NUL'");
      expect(create).toContain(
        "'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9'",
      );
      expect(create).toContain(
        "'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'",
      );
      expect(create).toContain("pg_catalog.regexp_replace(v_name, '\\.[^.]+$', '')");
    });

    it("qualifies outer-table columns in participant RLS policies", () => {
      const source = sql();
      const handoffs =
        source.match(/CREATE POLICY handoffs_select_participant[\s\S]*?;/)?.[0] ?? "";
      expect(handoffs).toContain("handoffs.sender_member_id");
      expect(handoffs).toContain("handoffs.recipient_member_id");
      expect(handoffs).toContain("handoffs.status");
      const versions =
        source.match(/CREATE POLICY handoff_versions_select_participant[\s\S]*?;/)?.[0] ?? "";
      expect(versions).toContain("handoff_versions.handoff_id");
      const events =
        source.match(/CREATE POLICY handoff_events_select_participant[\s\S]*?;/)?.[0] ?? "";
      expect(events).toContain("handoff_events.handoff_id");
    });
  },
);

describe("handoff client source", () => {
  it("does not log tokens, signed urls, or local paths", () => {
    const service = read("src/features/handoff/service.ts");
    const app = read("src/App.tsx");
    const transfer = read("src-tauri/src/transfer.rs").split("#[cfg(test)]")[0] ?? "";
    const build = read("src-tauri/build.rs");
    expect(service).not.toMatch(/console\.(log|debug|info|warn|error)/);
    expect(app).not.toMatch(/console\.(log|debug|info|warn|error)/);
    expect(service).toContain("currentAccessToken");
    expect(service).toContain("createSignedUrl");
    expect(service).not.toContain("createSignedUploadUrl");
    expect(service).not.toContain("service_role");
    expect(app).not.toContain("access_token");
    expect(app).not.toContain("uploadToSignedUrl");
    expect(app).toContain("accessToken");
    expect(app).not.toContain("signedUploadToken");
    expect(app).toContain("subscribeToIncomingHandoffs");
    expect(app).toContain("subscribeToOutgoingHandoffs");
    expect(read("src/features/workspace/WorkspaceReadyScreen.tsx")).not.toContain(
      "signedUploadToken",
    );
    expect(read("src/features/workspace/WorkspaceReadyScreen.tsx")).not.toContain(
      "signedUrl",
    );
    expect(transfer).toContain("Authorization");
    expect(transfer).not.toContain("x-signature");
    expect(transfer).not.toContain("reqwest::blocking");
    expect(transfer).toContain("async fn tus_upload_v1");
    expect(transfer).toContain("async fn download_inbox");
    expect(transfer).toContain("is_allowed_redirect_url(attempt.url()");
    expect(transfer).toContain("format_tus_post_failure_log");
    expect(build).toContain("VITE_SUPABASE_URL");
    expect(build).not.toContain("VITE_SUPABASE_PUBLISHABLE_KEY");
    expect(build).not.toContain("service_role");
  });
});
