import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryAuthStorage } from "./tauriAuthStorage";

function collectProductionSource(relativeDir: string): string[] {
  const root = path.join(process.cwd(), relativeDir);
  const files: string[] = [];

  function walk(current: string) {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        if (entry === "node_modules" || entry === "target" || entry === "dist") {
          continue;
        }
        walk(full);
      } else if (
        /\.(ts|tsx|rs)$/.test(entry) &&
        !entry.endsWith(".d.ts") &&
        !entry.includes(".test.")
      ) {
        files.push(full);
      }
    }
  }

  walk(root);
  return files;
}

function productionRust(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8").replace(
    /#\[cfg\(test\)\][\s\S]*$/,
    "",
  );
}

describe("tauri auth storage", () => {
  it("keeps sessions isolated across two data roots", async () => {
    const rootA = new Map<string, string>();
    const rootB = new Map<string, string>();
    const storageA = createMemoryAuthStorage(rootA);
    const storageB = createMemoryAuthStorage(rootB);

    await storageA.setItem("sb-auth", "session-a");
    await storageB.setItem("sb-auth", "session-b");

    expect(await storageA.getItem("sb-auth")).toBe("session-a");
    expect(await storageB.getItem("sb-auth")).toBe("session-b");
  });

  it("restores the same session after a restart of the same data root", async () => {
    const root = new Map<string, string>();
    const firstRun = createMemoryAuthStorage(root);
    await firstRun.setItem("sb-auth", "persist-me");

    const secondRun = createMemoryAuthStorage(root);
    expect(await secondRun.getItem("sb-auth")).toBe("persist-me");
  });

  it("does not use localStorage in application source", () => {
    const files = [
      ...collectProductionSource("src"),
      ...collectProductionSource("src-tauri/src"),
    ];
    const themeFile = path.normalize(path.join(process.cwd(), "src/theme/theme.ts"));
    const designCardsFile = path.normalize(
      path.join(process.cwd(), "src/features/handoff/designCards.ts"),
    );
    const hits = files.filter((file) => {
      const normalized = path.normalize(file);
      if (normalized === themeFile) {
        const source = readFileSync(file, "utf8");
        expect(source).toContain("filerelay.theme");
        expect(source).not.toContain("access_token");
        expect(source).not.toContain("sb-auth");
        return false;
      }
      if (normalized === designCardsFile) {
        const source = readFileSync(file, "utf8");
        expect(source).toContain("filerelay.designCards");
        expect(source).not.toContain("access_token");
        expect(source).not.toContain("sb-auth");
        return false;
      }
      return readFileSync(file, "utf8").includes("localStorage");
    });
    expect(hits).toEqual([]);
  });

  it("does not put tokens in snapshots, logs, or the general store", () => {
    const snapshot = productionRust("src-tauri/src/state.rs");
    const authStore = productionRust("src-tauri/src/auth_store.rs");
    const app = readFileSync(path.join(process.cwd(), "src/App.tsx"), "utf8");
    const types = readFileSync(path.join(process.cwd(), "src/types.ts"), "utf8");
    const client = readFileSync(path.join(process.cwd(), "src/lib/supabase/client.ts"), "utf8");

    expect(snapshot).not.toContain("access_token");
    expect(snapshot).not.toContain("refresh_token");
    expect(authStore).toContain("supabase-auth.json");
    expect(authStore).not.toContain("state.json");
    expect(app).not.toContain("access_token");
    expect(app).not.toContain("refresh_token");
    expect(types).not.toContain("access_token");
    expect(client).not.toMatch(/console\.(log|debug|info|warn|error)/);
    expect(authStore).not.toMatch(/println!|eprintln!|dbg!/);
  });
});
