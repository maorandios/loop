import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");
}

describe("Milestone 10C-B Rust engine", () => {
  it("adds v2 upload commands without changing legacy signatures or React", () => {
    const transfer = read("src-tauri/src/transfer.rs");
    const watch = read("src-tauri/src/watch.rs");
    const lib = read("src-tauri/src/lib.rs");
    const app = read("src/App.tsx");

    expect(transfer).toContain("pub async fn tus_upload_v1(");
    expect(transfer).toContain("selection_id: Uuid,");
    expect(transfer).toContain("pub async fn tus_upload_initial_v2(");
    expect(transfer).toContain("reservation_client_request_id: Uuid,");
    expect(transfer).toContain("pub async fn tus_upload_result(");
    expect(transfer).toContain("prepare_result_snapshot_from_selection(");
    expect(transfer).toContain("update_resume_reservation_expiry(");
    expect(transfer).toContain("pub fn list_resume_uploads(");
    expect(transfer).toContain("pub async fn resume_tus_upload(");
    expect(transfer).toContain("pub fn restore_resume_snapshot_from_selection(");
    expect(watch).toContain("pub async fn tus_upload_v2(");
    expect(lib).toContain("transfer::tus_upload_v1,");
    expect(lib).toContain("transfer::tus_upload_initial_v2,");
    expect(lib).toContain("transfer::tus_upload_result,");
    expect(lib).toContain("transfer::list_resume_uploads,");
    expect(lib).toContain("transfer::resume_tus_upload,");
    expect(lib).toContain("transfer::restore_resume_snapshot_from_selection,");

    expect(app).toContain('invoke("tus_upload_v2"');
    expect(transfer).toContain("finalize_intent: resume::FinalizeIntent");
  });

  it("keeps inbox schema 3 and persistent resume files", () => {
    const inbox = read("src-tauri/src/inbox.rs");
    const resume = read("src-tauri/src/resume.rs").split("#[cfg(test)]")[0] ?? "";
    const paths = read("src-tauri/src/paths.rs");
    expect(inbox).toContain("pub const INBOX_SCHEMA_VERSION: u32 = 3");
    expect(inbox).toContain("fill_missing_filenames_from_local");
    expect(resume).toContain("pending_upload_expires_at");
    expect(resume).toContain("reservation_client_request_id");
    expect(resume).toContain("last_renew_client_request_id");
    expect(resume).toContain("PostResponseUnknown");
    expect(resume).toContain("UploadCompletedCleanup");
    expect(resume).toContain("mark_upload_completed_cleanup");
    expect(resume).not.toContain("legacy_return");
    expect(paths).toContain("fn resume_dir");
    expect(paths).toContain("fn resume_file_path");
  });

  it("does not put PostgREST, RPC, or a publishable key in Rust", () => {
    const rustFiles = [
      "src-tauri/src/transfer.rs",
      "src-tauri/src/tus.rs",
      "src-tauri/src/resume.rs",
      "src-tauri/src/lib.rs",
      "src-tauri/src/state.rs",
    ];
    for (const file of rustFiles) {
      const source = read(file).split("#[cfg(test)]")[0];
      expect(source).not.toContain("rest/v1/rpc");
      expect(source).not.toContain("sb_publishable");
      expect(source).not.toMatch(/\.rpc\s*\(/);
    }
  });
});
