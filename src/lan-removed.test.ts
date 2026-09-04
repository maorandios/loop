import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function productionRust(relativePath: string): string {
  return read(relativePath).replace(/#\[cfg\(test\)\][\s\S]*$/, "");
}

describe("LAN server removal", () => {
  it("does not keep Axum, a local listener, or FILERELAY_PORT", () => {
    const cargo = read("src-tauri/Cargo.toml");
    const lib = productionRust("src-tauri/src/lib.rs");
    const state = productionRust("src-tauri/src/state.rs");
    const paths = productionRust("src-tauri/src/paths.rs");
    const app = read("src/App.tsx");

    expect(cargo).not.toContain("axum =");
    expect(cargo).not.toContain("local-ip-address");
    expect(lib).not.toContain("start_http_server");
    expect(state).not.toContain("start_http_server");
    expect(lib).not.toContain("retry_bind");
    expect(state).not.toContain("retry_bind");
    expect(paths).not.toContain("FILERELAY_PORT");
    expect(lib).not.toContain("FILERELAY_PORT");
    expect(state).not.toContain("FILERELAY_PORT");
    expect(read("src-tauri/src/identity.rs")).not.toContain("FILERELAY_PORT");
    expect(read("src-tauri/src/auth_store.rs")).not.toContain("FILERELAY_PORT");
    expect(app).not.toContain("retry_bind");
    expect(app).not.toContain("localAddresses");
    expect(app).not.toContain("FILERELAY_PORT");
  });

  it("keeps port and pairing_code out of the active identity model", () => {
    const identity = productionRust("src-tauri/src/identity.rs");
    const types = read("src/types.ts");
    expect(identity).toContain("pub struct LocalDevice");
    expect(identity).not.toMatch(/pub struct LocalDevice \{[^}]*port/s);
    expect(types).not.toContain("pairingCode");
    expect(types).not.toContain("port:");
  });
});
