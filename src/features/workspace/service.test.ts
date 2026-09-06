import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("live workspace service source", () => {
  it("does not log tokens or raw cloud errors", () => {
    const service = readFileSync(path.join(process.cwd(), "src/features/workspace/service.ts"), "utf8");
    const auth = readFileSync(path.join(process.cwd(), "src/lib/supabase/auth.ts"), "utf8");
    const app = readFileSync(path.join(process.cwd(), "src/App.tsx"), "utf8");
    expect(service).not.toMatch(/console\.(log|debug|info|warn|error)/);
    expect(auth).not.toMatch(/console\.(log|debug|info|warn|error)/);
    expect(app).not.toMatch(/console\.(log|debug|info|warn|error)/);
    expect(service).not.toContain("access_token");
    expect(service).not.toContain("refresh_token");
    expect(service).not.toContain("service_role");
    expect(service).not.toContain("getCachedSupabaseClient");
    expect(app).toContain("refreshMembers");
    expect(app).toContain("subscribeToWorkspaceMembers");
    expect(app).toContain("subscribeToIncomingHandoffs");
    expect(app).toContain("subscribeToHandoffEvents");
  });
});
