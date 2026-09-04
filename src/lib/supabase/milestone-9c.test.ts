import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");
}

function productionRust(relativePath: string): string {
  return read(relativePath).replace(/#\[cfg\(test\)\][\s\S]*$/, "");
}

describe("Milestone 9C workflow UI and autostart", () => {
  it("keeps the M9 path free of mark_return_received, updater, and awaiting_review", () => {
    const app = read("src/App.tsx");
    const cargo = read("src-tauri/Cargo.toml");
    const conf = read("src-tauri/tauri.conf.json");
    const capabilities = read("src-tauri/capabilities/default.json");
    expect(app).toContain("createHandoffWithContext");
    expect(app).not.toContain("createHandoff(");
    expect(app).not.toContain("markReturnReceived");
    expect(app).not.toMatch(/awaiting[_]?review/i);
    expect(read("src/features/workspace/WorkspaceReadyScreen.tsx")).not.toMatch(
      /awaiting[_]?review/i,
    );
    expect(cargo).not.toContain("tauri-plugin-updater");
    expect(conf).not.toContain("updater");
    expect(capabilities).not.toContain("autostart");
    expect(conf).toContain("\"visible\": false");
  });

  it("registers single-instance first and keeps autostart in Rust only", () => {
    const lib = productionRust("src-tauri/src/lib.rs");
    const cargo = read("src-tauri/Cargo.toml");
    const autostart = productionRust("src-tauri/src/autostart.rs");
    expect(cargo).toContain("tauri-plugin-autostart");
    expect(lib.indexOf("with_single_instance")).toBeLessThan(
      lib.indexOf("tauri_plugin_autostart"),
    );
    expect(lib).toContain(".args([\"--background\"])");
    expect(lib).toContain("get_autostart_state");
    expect(lib).toContain("set_autostart_enabled");
    expect(autostart).toContain("argv_requests_background");
    expect(autostart).toContain("should_focus_existing_window");
    expect(autostart).toContain("#[cfg(debug_assertions)]");
    expect(autostart).toContain("#[cfg(not(debug_assertions))]");
  });
});
