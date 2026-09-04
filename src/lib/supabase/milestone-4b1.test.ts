import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function productionRust(relativePath: string): string {
  return read(relativePath).replace(/#\[cfg\(test\)\][\s\S]*$/, "");
}

describe("4B.1 live-connect prerequisites", () => {
  it("keeps Tauri auth storage and the required client options", () => {
    const client = read("src/lib/supabase/client.ts");
    const storage = read("src/lib/supabase/tauriAuthStorage.ts");
    const authStore = productionRust("src-tauri/src/auth_store.rs");

    expect(storage).toContain("export function createTauriAuthStorage");
    expect(client).toContain("persistSession: true");
    expect(client).toContain("autoRefreshToken: true");
    expect(client).toContain("detectSessionInUrl: false");
    expect(client).toContain("storage");
    expect(client).not.toContain("window.localStorage");
    expect(storage).not.toContain("window.localStorage");
    expect(authStore).toContain("supabase-auth.json");
    expect(authStore).toContain("root.join(\"state\")");
  });

  it("keeps LAN fields, FILERELAY_PORT, and tokens out of the active model", () => {
    const identity = productionRust("src-tauri/src/identity.rs");
    const paths = productionRust("src-tauri/src/paths.rs");
    const lib = productionRust("src-tauri/src/lib.rs");
    const types = read("src/types.ts");

    expect(identity).not.toMatch(/pub struct LocalDevice \{[^}]*port/s);
    expect(types).not.toContain("pairingCode");
    expect(paths).not.toContain("FILERELAY_PORT");
    expect(lib).not.toContain("FILERELAY_PORT");
    expect(paths).toContain("FILERELAY_DATA_DIR");
    expect(paths).toContain("should_skip_single_instance");
    expect(lib).toContain("Release: always register");
  });

  it("keeps rotate_workspace_join_code in the current manual setup", () => {
    const sql = read("supabase/manual-setup.sql");
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION public.rotate_workspace_join_code(workspace_id uuid)",
    );
  });
});
