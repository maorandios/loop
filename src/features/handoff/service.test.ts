import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HANDOFF_LIST_SELECT, TRANSFER_LIST_SELECT } from "./service";

describe("handoff snapshot queries", () => {
  it("loads transfers by workspace_id without a long IN list", () => {
    const source = readFileSync(path.join(process.cwd(), "src/features/handoff/service.ts"), "utf8");
    expect(HANDOFF_LIST_SELECT).toContain("flow_version");
    expect(HANDOFF_LIST_SELECT).toContain("request_status");
    expect(HANDOFF_LIST_SELECT).toContain("active_transfer_id");
    expect(HANDOFF_LIST_SELECT).toContain("handoff_events(id,");
    expect(HANDOFF_LIST_SELECT).toContain("transfer_id");
    expect(TRANSFER_LIST_SELECT).toContain("parent_transfer_id");
    expect(source).toContain('.eq("workspace_id", workspaceId)');
    expect(source).not.toMatch(/handoff_id IN/i);
    expect(source).not.toMatch(/\.in\(\s*["']handoff_id["']/);
    expect(source).toContain("create_handoff_with_context");
    expect(source).toContain("create_handoff_v2");
    expect(source).toContain("create_file_request_v2");
    expect(HANDOFF_LIST_SELECT).toContain("file_name");
  });
});
