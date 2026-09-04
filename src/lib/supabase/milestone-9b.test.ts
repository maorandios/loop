import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");
}

describe("Milestone 9B client engine", () => {
  it("uses the dynamic return RPCs and never calls mark_return_received on the M9 path", () => {
    const app = read("src/App.tsx");
    const service = read("src/features/handoff/service.ts");
    expect(app).toContain("beginReturnNext");
    expect(app).toContain("finalizeHandoffReturn");
    expect(app).toContain("versionNumber: started.versionNumber");
    expect(app).not.toContain("finalizeReturnV2(");
    expect(app).not.toContain("beginReturn(");
    expect(app).not.toContain("markReturnReceived");
    expect(service).toContain('rpc("begin_handoff_return_next"');
    expect(service).toContain('rpc("finalize_handoff_return"');
    expect(service).toContain('rpc("create_handoff_with_context"');
    expect(service).toContain('rpc("complete_handoff"');
    expect(service).toContain('rpc("request_revision"');
    expect(service).not.toMatch(/awaiting[_]?review/i);
    expect(app).not.toMatch(/awaiting[_]?review/i);
  });

  it("always re-downloads before opening and keeps confirm_return_snapshot after TUS", () => {
    const app = read("src/App.tsx");
    const downloadOpen = app.slice(app.indexOf("async function onDownloadAndOpen"));
    expect(downloadOpen).toContain("download_inbox");
    expect(downloadOpen.indexOf("download_inbox")).toBeLessThan(
      downloadOpen.indexOf("open_inbox_file"),
    );
    expect(downloadOpen.indexOf("start_inbox_watch")).toBeLessThan(
      downloadOpen.indexOf("open_inbox_file"),
    );
    const ret = app.slice(app.indexOf("async function onReturnFile"));
    expect(ret).toContain("tus_upload_v2");
    expect(ret.indexOf("tus_upload_v2")).toBeLessThan(ret.indexOf("confirm_return_snapshot"));
    expect(ret.indexOf("confirm_return_snapshot")).toBeLessThan(ret.indexOf("finalizeHandoffReturn"));
  });

  it("keeps tokens out of React events and uses memory-only access tokens", () => {
    const app = read("src/App.tsx");
    const inbox = read("src-tauri/src/inbox.rs");
    expect(app).toContain("currentAccessToken");
    expect(app).not.toContain("access_token");
    expect(app).not.toContain("files/inbox");
    expect(inbox).toContain("event_payload_omits_path_hash_and_token");
    expect(inbox).toContain("schema_version");
    expect(inbox).toContain("INBOX_SCHEMA_VERSION");
    expect(inbox).toContain("migrate_if_needed");
    expect(inbox).toContain("recover_interrupted_save");
    expect(inbox).toContain("unsupported_inbox_schema");
    expect(inbox).toContain("rename = \"schema_version\"");
    expect(inbox).toContain("alias = \"schemaVersion\"");
  });
});
