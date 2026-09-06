import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");
}

describe("Milestone 10C-C TypeScript wiring", () => {
  it("connects the v2 RPCs and keeps legacy send commands available", () => {
    const service = read("src/features/handoff/service.ts");
    const app = read("src/App.tsx");
    const types = read("src/features/handoff/types.ts");
    expect(service).toContain('rpc("create_handoff_v2"');
    expect(service).toContain('rpc("create_file_request_v2"');
    expect(service).toContain('rpc("mark_root_transfer_opened"');
    expect(service).toContain('rpc("begin_transfer_result_upload"');
    expect(service).toContain('rpc("renew_transfer_upload_reservation"');
    expect(service).toContain('rpc("finalize_transfer_result"');
    expect(service).toContain('rpc("finalize_file_request_result"');
    expect(service).toContain('rpc("submit_transfer_result_without_file"');
    expect(service).toContain('rpc("abort_transfer_result_upload"');
    expect(service).toContain('rpc("accept_root_transfer_result"');
    expect(service).toContain('rpc("request_root_transfer_revision"');
    expect(service).toContain('rpc("cancel_root_handoff_v2"');
    expect(service).toContain('rpc("fail_handoff_v2_initial"');
    expect(service).toContain('rpc("retry_handoff_v2_initial"');
    expect(service).toContain('rpc("send_transfer_reminder"');
    expect(service).toContain('rpc("finalize_handoff_v2_initial"');
    expect(service).toContain('.from("filerelay")');
    expect(service).toContain(".remove([storagePath])");
    const flows = read("src/features/handoff/v2.ts");
    expect(flows).toContain("tus_upload_initial_v2");
    expect(flows).toContain("tus_upload_result");
    expect(flows).toContain("ack_resume_finalized");
    expect(flows).toContain("forgetResultUploadCommands");
    expect(app).toContain("list_resume_uploads");
    const recover = app.slice(app.indexOf("async function recoverAllResumes"));
    expect(recover.indexOf("reloadList")).toBeLessThan(recover.indexOf("list_resume_uploads"));
    expect(app).toContain("prepare_result_snapshot_from_working_file");
    expect(app).toContain("workingFileChangedAfterPrepare");
    const cancelSend = app.slice(app.indexOf("async function onCancelSend"));
    expect(cancelSend.slice(0, 1200)).toContain("list_resume_uploads");
    expect(cancelSend.slice(0, 1200)).toContain("abortResumeRecord");
    expect(cancelSend.slice(0, 1200)).toContain("stillOpen: true");
    const remind = app.slice(app.indexOf("async function onRemind"));
    expect(remind.slice(0, 900)).toContain('forget(command, handoff.id)');
    expect(remind.slice(0, 900)).toContain("reminder_cooldown");
    expect(app).toContain("inboxAfterPrepare");
    const changedFn = app.slice(app.indexOf("async changedDuringUpload"));
    expect(changedFn.slice(0, 400)).not.toContain("recheck_inbox_file");
    expect(app).toContain("tus_upload_v2");
    const ret = app.slice(app.indexOf("async function onReturnFile"));
    expect(ret.indexOf("reconciliation.stop")).toBeLessThan(ret.indexOf("prepare_return_snapshot"));
    expect(ret.indexOf("tus_upload_v2")).toBeLessThan(ret.indexOf("confirm_return_snapshot"));
    expect(ret.indexOf("confirm_return_snapshot")).toBeLessThan(ret.indexOf("finalizeHandoffReturn"));
    expect(ret).not.toContain("resume_tus_upload");
    expect(ret).not.toContain("finalizeTransferResult");
    const ack = app.slice(app.indexOf("acknowledge: async"));
    expect(ack.slice(0, 500)).toContain("acknowledge_local_status_sync");
    expect(ack.slice(0, 500)).toContain("inbox_local_state");
    const cloudStatus = app.slice(app.indexOf("async getCloudStatus"));
    expect(cloudStatus.slice(0, 700)).toContain("applySnapshot");
    expect(cloudStatus.slice(0, 700)).toContain("statusInflight");
    expect(app).not.toContain("reservedStoragePath");
    expect(flows).not.toContain("reservedStoragePath");
    expect(flows).toContain("confirmedResumeStoragePath");
    expect(flows).toContain("start_inbox_watch");
    expect(flows).not.toContain("${workspaceId}/${handoffId}/v");
    expect(app).toContain("pick_send_file");
    expect(types).toContain('"file_request"');
    expect(read("src/features/handoff/service.ts")).toContain("createHandoffWithContext");
  });

  it("keeps FinalizeIntent off summaries, logs, and the DOM", () => {
    const resume = read("src-tauri/src/resume.rs").split("#[cfg(test)]")[0] ?? "";
    const transfer = read("src-tauri/src/transfer.rs").split("#[cfg(test)]")[0] ?? "";
    const screen = read("src/features/workspace/WorkspaceReadyScreen.tsx");
    const app = read("src/App.tsx");
    expect(resume).toContain("pub struct FinalizeIntent");
    expect(transfer).toContain("finalize_intent: resume::FinalizeIntent");
    expect(resume).toContain("skip_serializing_if = \"Option::is_none\"");
    expect(screen).not.toContain("finalizeIntent");
    expect(screen).not.toContain("result_action");
    expect(screen).not.toContain("storage_path");
    expect(app).not.toMatch(/console\.(log|info|debug).*finalizeIntent/);
    expect(app).not.toContain("sb_publishable");
  });

  it("does not add SQL, installer, or a version bump", () => {
    const conf = read("src-tauri/tauri.conf.json");
    expect(conf).toContain('"version": "0.1.0"');
    expect(read("src/features/handoff/v2.ts")).not.toContain("CREATE OR REPLACE FUNCTION");
  });
});
