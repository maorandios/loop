import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");
}

function productionRust(relativePath: string): string {
  return read(relativePath).replace(/#\[cfg\(test\)\][\s\S]*$/, "");
}

describe("Milestone 8 installer guards", () => {
  it("locks NSIS currentUser and WebView2 downloadBootstrapper", () => {
    const conf = read("src-tauri/tauri.conf.json");
    const parsed = JSON.parse(conf);
    expect(parsed.productName).toBe("FileRelay");
    expect(parsed.identifier).toBe("com.filerelay.app");
    expect(parsed.version).toBe("0.1.0");
    expect(parsed.bundle.targets).toEqual(["nsis"]);
    expect(parsed.bundle.windows.nsis.installMode).toBe("currentUser");
    expect(parsed.bundle.windows.webviewInstallMode.type).toBe("downloadBootstrapper");
    expect(conf).not.toContain("offlineInstaller");
    expect(conf).not.toContain("fixedRuntime");
    expect(conf).not.toContain("\"msi\"");
    expect(parsed.bundle.shortDescription).toBeTruthy();
    expect(parsed.bundle.publisher).toBe("FileRelay");
  });

  it("does not add updater or a toast-click handler", () => {
    const conf = read("src-tauri/tauri.conf.json");
    const cargo = read("src-tauri/Cargo.toml");
    const lib = productionRust("src-tauri/src/lib.rs");
    expect(cargo).not.toContain("tauri-plugin-updater");
    expect(conf).not.toContain("updater");
    expect(lib).not.toContain("on_notification_event");
    expect(lib).not.toContain("NotificationEvent");
  });

  it("keeps Release without a console and embeds only the project ref in Rust", () => {
    const main = read("src-tauri/src/main.rs");
    const build = read("src-tauri/build.rs");
    const gitignore = read(".gitignore");
    expect(main).toContain('windows_subsystem = "windows"');
    expect(build).toContain("VITE_SUPABASE_URL");
    expect(build).not.toContain("VITE_SUPABASE_PUBLISHABLE_KEY");
    expect(build).not.toContain("service_role");
    expect(gitignore).toContain(".env.local");
  });

  it("ships a temporary file-and-handoff icon set", () => {
    const root = process.cwd();
    for (const relative of [
      "src-tauri/icons/32x32.png",
      "src-tauri/icons/128x128.png",
      "src-tauri/icons/128x128@2x.png",
      "src-tauri/icons/icon.icns",
      "src-tauri/icons/icon.ico",
    ]) {
      expect(existsSync(path.join(root, relative)), relative).toBe(true);
    }
    const ico = readFileSync(path.join(root, "src-tauri/icons/icon.ico"));
    expect(ico.length).toBeGreaterThan(1000);
  });
});
