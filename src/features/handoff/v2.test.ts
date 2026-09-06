import { describe, expect, it } from "vitest";
import { CloudError } from "../../lib/supabase/errors";
import { createCommandIdStore } from "./commandIds";
import { createMockHandoffService } from "./mock";
import {
  type InvokeFn,
  attachFileRequest,
  abortResumeRecord,
  confirmedResumeStoragePath,
  resumeMatchesFinalizedVersion,
  createFileRequest,
  openRootTransfer,
  recoverResumeRecord,
  reservationNearExpiry,
  resultActionForRequest,
  sendHandoffV2,
  workingFileChangedAfterPrepare,
  submitWithFile,
  submitWithoutFile,
  uniqueClientRequestIds,
} from "./v2";
import type { ResumeSummary } from "./types";
import { MEMBER, v2RootActive } from "./view.fixtures";

function invokeMap(handlers: Record<string, (args?: Record<string, unknown>) => unknown>) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke: InvokeFn = async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (handlers[command]) {
      return handlers[command](args) as T;
    }
    return null as T;
  };
  return { invoke, calls };
}

const picked = {
  selectionId: "sel-1",
  originalFilename: "דוח.docx",
  size: 12,
  blake3: "ab".repeat(32),
};

const RESUME_HANDOFF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESUME_TRANSFER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RESUME_OBJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RESUME_WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RESUME_PATH = `${RESUME_WORKSPACE}/${RESUME_HANDOFF}/v1/${RESUME_OBJECT}`;

function resume(partial: Partial<ResumeSummary> = {}): ResumeSummary {
  return {
    kind: "initial",
    stage: "uploading",
    handoffId: RESUME_HANDOFF,
    transferId: RESUME_TRANSFER,
    objectId: RESUME_OBJECT,
    versionNumber: 1,
    fileName: "דוח.docx",
    storagePath: RESUME_PATH,
    pendingUploadExpiresAt: "2099-01-01T00:00:00Z",
    reservationClientRequestId: "11111111-1111-4111-8111-111111111111",
    lastRenewClientRequestId: null,
    finalizeClientRequestId: "22222222-2222-4222-8222-222222222222",
    abortClientRequestId: "33333333-3333-4333-8333-333333333333",
    ...partial,
  };
}

describe("v2 result mapping", () => {
  it("maps approval, review, update, and rejection with and without a file change", () => {
    expect(resultActionForRequest("approval", false, false)).toBe("approved");
    expect(resultActionForRequest("approval", true, false)).toBe("approved");
    expect(resultActionForRequest("review", false, false)).toBe("review_completed");
    expect(resultActionForRequest("review", true, false)).toBe("review_completed");
    expect(resultActionForRequest("update", false, false)).toBe("returned_with_reply");
    expect(resultActionForRequest("update", true, false)).toBe("returned_with_file");
    expect(resultActionForRequest("approval", true, true)).toBe("rejected");
    expect(resultActionForRequest("file_request", true, false)).toBe("returned_with_file");
    const inbox = (generation: number) => [
      {
        handoffId: "h1",
        filename: "דוח.docx",
        version: "v1",
        contentDiffersFromV1: true,
        desiredStatus: "modified",
        pendingRecheck: false,
        pendingStatusSync: false,
        generation,
      },
    ];
    expect(workingFileChangedAfterPrepare(inbox(9), "h1", 8)).toBe(true);
    expect(workingFileChangedAfterPrepare(inbox(9), "h1", 9)).toBe(false);
  });
});

describe("v2 send and file request", () => {
  it("creates all four request kinds with distinct command ids", async () => {
    const service = createMockHandoffService();
    const { invoke } = invokeMap({
      tus_upload_initial_v2: () => undefined,
      ack_resume_finalized: () => undefined,
    });
    for (const action of ["approval", "review", "update"] as const) {
      const commands = createCommandIdStore();
      await sendHandoffV2({
        service,
        invoke,
        commands,
        recipientMemberId: "member-2",
        picked,
        requestedAction: action,
        instruction: "נא לטפל",
        dueOn: null,
      });
    }
    const fileCommands = createCommandIdStore();
    await createFileRequest({
      service,
      commands: fileCommands,
      recipientMemberId: "member-2",
      instruction: "נא לצרף את הדוח",
      dueOn: "2026-09-10",
    });
    expect(service.createV2Calls).toBe(3);
    expect(service.createFileRequestCalls).toBe(1);
    expect(uniqueClientRequestIds(service.clientRequestIds)).toBe(true);
    expect(service.lastFileRequest?.instruction).toBe("נא לצרף את הדוח");
  });

  it("does not fail or abort on a network error after create", async () => {
    const service = createMockHandoffService();
    const { invoke } = invokeMap({
      tus_upload_initial_v2: () => {
        throw new CloudError("cloud_unavailable");
      },
    });
    await expect(
      sendHandoffV2({
        service,
        invoke,
        commands: createCommandIdStore(),
        recipientMemberId: "member-2",
        picked,
        requestedAction: "approval",
        instruction: "נא לאשר",
        dueOn: null,
      }),
    ).rejects.toMatchObject({ code: "cloud_unavailable" });
    expect(service.failV2InitialCalls).toEqual([]);
    expect(service.failHandoffCalls).toEqual([]);
  });
});

describe("v2 results and open", () => {
  it("submits without a file and reuses the same command id", async () => {
    const service = createMockHandoffService();
    const commands = createCommandIdStore();
    await submitWithoutFile({
      service,
      commands,
      handoffId: "h1",
      resultAction: "approved",
      resultNote: null,
    });
    await submitWithoutFile({
      service,
      commands,
      handoffId: "h1",
      resultAction: "approved",
      resultNote: null,
    });
    expect(service.submitWithoutFileCalls).toHaveLength(2);
    expect(service.submitWithoutFileCalls[0]?.clientRequestId).toBe(
      service.submitWithoutFileCalls[1]?.clientRequestId,
    );
  });

  it("uploads a changed result with FinalizeIntent and acks", async () => {
    const service = createMockHandoffService();
    const { invoke, calls } = invokeMap({
      tus_upload_result: () => undefined,
      ack_resume_finalized: () => undefined,
    });
    await submitWithFile({
      service,
      invoke,
      commands: createCommandIdStore(),
      handoffId: "h1",
      transferId: "t1",
      intent: { resultAction: "approved", resultNote: null },
      snapshot: {
        snapshotId: "snap-1",
        fileName: "דוח.docx",
        fileSize: 20,
        blake3: "cd".repeat(32),
      },
      changedDuringUpload: async () => false,
    });
    expect(service.beginResultCalls).toEqual(["h1"]);
    expect(service.finalizeTransferCalls).toEqual(["h1"]);
    expect(calls.some((call) => call.command === "tus_upload_result")).toBe(true);
    expect(calls.find((call) => call.command === "tus_upload_result")?.args?.finalizeIntent).toEqual({
      resultAction: "approved",
      resultNote: null,
    });
    expect(calls.some((call) => call.command === "ack_resume_finalized")).toBe(true);
    expect(uniqueClientRequestIds(service.clientRequestIds)).toBe(true);
  });

  it("attaches a file request with returned_with_file", async () => {
    const service = createMockHandoffService();
    const { invoke, calls } = invokeMap({
      prepare_result_snapshot_from_selection: () => ({
        snapshotId: "snap-fr",
        fileName: "נספח.pdf",
        fileSize: 8,
        blake3: "ee".repeat(32),
      }),
      tus_upload_result: () => undefined,
      ack_resume_finalized: () => undefined,
    });
    await attachFileRequest({
      service,
      invoke,
      commands: createCommandIdStore(),
      handoffId: "hf",
      transferId: "tf",
      picked,
    });
    expect(service.finalizeFileRequestCalls).toEqual(["hf"]);
    expect(calls.find((call) => call.command === "tus_upload_result")?.args?.finalizeIntent).toEqual({
      resultAction: "returned_with_file",
      resultNote: null,
    });
  });

  it("issues a new begin id after a successful file-request attach", async () => {
    const service = createMockHandoffService();
    const commands = createCommandIdStore();
    const { invoke } = invokeMap({
      prepare_result_snapshot_from_selection: () => ({
        snapshotId: "snap-fr-2",
        fileName: "אחר.pdf",
        fileSize: 4,
        blake3: "11".repeat(32),
      }),
      tus_upload_result: () => undefined,
      ack_resume_finalized: () => undefined,
    });
    await attachFileRequest({
      service,
      invoke,
      commands,
      handoffId: "hf",
      transferId: "tf",
      picked,
    });
    const firstBegin = service.clientRequestIds[0];
    await attachFileRequest({
      service,
      invoke,
      commands,
      handoffId: "hf",
      transferId: "tf",
      picked,
    });
    expect(service.beginResultCalls).toEqual(["hf", "hf"]);
    expect(service.clientRequestIds[0]).toBe(firstBegin);
    expect(service.clientRequestIds[2]).not.toBe(firstBegin);
  });

  it("opens the latest version once per round and never invents a file-request name", async () => {
    const { record } = v2RootActive();
    const service = createMockHandoffService();
    const { invoke, calls } = invokeMap({
      download_inbox: () => undefined,
      start_inbox_watch: () => undefined,
      recheck_inbox_file: () => undefined,
      open_inbox_file: () => undefined,
    });
    const commands = createCommandIdStore();
    await openRootTransfer({
      service,
      invoke,
      commands,
      handoff: {
        ...record,
        versions: [{ ...record.versions[0]!, fileName: "v2-active.docx" }],
      },
      memberId: MEMBER.recipient,
    });
    await openRootTransfer({
      service,
      invoke,
      commands,
      handoff: {
        ...record,
        versions: [{ ...record.versions[0]!, fileName: "v2-active.docx" }],
      },
      memberId: MEMBER.recipient,
    });
    expect(service.markOpenedV2Calls).toHaveLength(2);
    expect(service.markOpenedV2Calls[0]?.clientRequestId).toBe(
      service.markOpenedV2Calls[1]?.clientRequestId,
    );
    expect(calls[0]?.args?.originalFilename).toBe("v2-active.docx");
    expect(calls.map((call) => call.command)).toEqual([
      "download_inbox",
      "start_inbox_watch",
      "recheck_inbox_file",
      "open_inbox_file",
      "download_inbox",
      "start_inbox_watch",
      "recheck_inbox_file",
      "open_inbox_file",
    ]);
    await expect(
      openRootTransfer({
        service,
        invoke,
        commands,
        handoff: { ...record, originalFilename: "", versions: [] },
        memberId: MEMBER.recipient,
        source: {
          kind: "transfer",
          record: { ...record, originalFilename: "", versions: [] },
          requestStatus: "open",
          activeHop: {
            ...v2RootActive().transfers[0]!,
            requestedAction: "file_request",
          },
          latestTransfer: {
            ...v2RootActive().transfers[0]!,
            requestedAction: "file_request",
          },
          rootHop: v2RootActive().transfers[0]!,
          parentHop: null,
          pathMemberIds: [],
          holderMemberId: MEMBER.recipient,
          latestFinalizedVersion: null,
          lastBusinessEvent: null,
          viewerRelation: "to",
        },
      }),
    ).rejects.toMatchObject({ code: "file_request_not_yet_supplied" });
  });
});

describe("v2 reminder, cancel, and resume", () => {
  it("renews a near-expiry reservation then resumes finalize", async () => {
    const service = createMockHandoffService();
    const { invoke, calls } = invokeMap({
      update_resume_reservation_expiry: () => undefined,
      resume_tus_upload: () => ({
        kind: "initial",
        stage: "uploaded_waiting_finalize",
        handoffId: "handoff-v2",
        transferId: "transfer-v2",
        objectId: "object-v2",
        versionNumber: 1,
        fileName: "דוח.docx",
        expectedSize: 12,
        blake3: "ab".repeat(32),
        finalizeClientRequestId: "22222222-2222-4222-8222-222222222222",
      }),
      ack_resume_finalized: () => undefined,
    });
    expect(reservationNearExpiry(new Date(Date.now() + 10_000).toISOString())).toBe(true);
    await recoverResumeRecord({
      service,
      invoke,
      commands: createCommandIdStore(),
      summary: resume({
        pendingUploadExpiresAt: new Date(Date.now() + 10_000).toISOString(),
        stage: "uploaded_waiting_finalize",
      }),
      pendingStoragePath: RESUME_PATH,
      handoff: { ...v2RootActive().record, versions: [] },
    });
    expect(calls.map((call) => call.command)).toContain("update_resume_reservation_expiry");
    expect(service.finalizeV2InitialCalls).toEqual([RESUME_HANDOFF]);
    expect(calls.map((call) => call.command)).toContain("ack_resume_finalized");
  });

  it("acks only when the version already exists after a lost finalize response", async () => {
    const service = createMockHandoffService();
    const { invoke, calls } = invokeMap({
      ack_resume_finalized: () => undefined,
    });
    const finalized = {
      ...v2RootActive().record,
      versions: [
        {
          versionNumber: 1,
          storagePath: RESUME_PATH,
          fileSize: 2048,
          blake3: "ab".repeat(32),
          fileName: "דוח.docx",
        },
      ],
    };
    await recoverResumeRecord({
      service,
      invoke,
      commands: createCommandIdStore(),
      summary: resume({ stage: "snapshot_ready" }),
      pendingStoragePath: RESUME_PATH,
      handoff: finalized,
    });
    expect(service.finalizeV2InitialCalls).toEqual([]);
    expect(calls).toEqual([
      expect.objectContaining({ command: "ack_resume_finalized" }),
    ]);
    expect(resumeMatchesFinalizedVersion(resume(), finalized.versions)).toBe("match");
  });

  it("reports a leftover resume that does not match the finalized object", async () => {
    const service = createMockHandoffService();
    const { invoke, calls } = invokeMap({
      ack_resume_finalized: () => undefined,
    });
    await expect(
      recoverResumeRecord({
        service,
        invoke,
        commands: createCommandIdStore(),
        summary: resume({ stage: "snapshot_ready" }),
        pendingStoragePath: RESUME_PATH,
        handoff: {
          ...v2RootActive().record,
          versions: [
            {
              versionNumber: 1,
              storagePath: `${RESUME_WORKSPACE}/${RESUME_HANDOFF}/v1/dddddddd-dddd-4ddd-8ddd-dddddddddddd`,
              fileSize: 17,
              blake3: "cd".repeat(32),
              fileName: "אחר.txt",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "resume_file_mismatch" });
    expect(calls).toEqual([]);
  });

  it("asks for the original file when the snapshot is missing", async () => {
    const service = createMockHandoffService();
    const { invoke, calls } = invokeMap({
      resume_tus_upload: (args) => {
        if (!calls.some((call) => call.command === "restore_resume_snapshot_from_selection")) {
          throw new CloudError("resume_snapshot_required");
        }
        return {
          kind: "initial",
          stage: "uploaded_waiting_finalize",
          ...args,
          fileName: "דוח.docx",
          expectedSize: 12,
          blake3: "ab".repeat(32),
          finalizeClientRequestId: "22222222-2222-4222-8222-222222222222",
        };
      },
      restore_resume_snapshot_from_selection: () => undefined,
      ack_resume_finalized: () => undefined,
    });
    await recoverResumeRecord({
      service,
      invoke,
      commands: createCommandIdStore(),
      summary: resume({ stage: "uploading" }),
      pendingStoragePath: RESUME_PATH,
      handoff: { ...v2RootActive().record, versions: [] },
      pickReplacement: async () => picked,
    });
    expect(calls.map((call) => call.command)).toContain("restore_resume_snapshot_from_selection");
  });

  it("continues abort from every leftover stage without early local cleanup", async () => {
    const service = createMockHandoffService();
    const { invoke, calls } = invokeMap({
      tus_abort_resume: () => undefined,
      mark_resume_storage_removed: () => undefined,
      ack_resume_aborted: () => undefined,
    });
    await abortResumeRecord({
      service,
      invoke,
      commands: createCommandIdStore(),
      summary: resume({ stage: "uploading" }),
      pendingStoragePath: RESUME_PATH,
      stillOpen: true,
    });
    expect(calls.map((call) => call.command)).toEqual([
      "tus_abort_resume",
      "mark_resume_storage_removed",
      "ack_resume_aborted",
    ]);
    expect(service.removeStorageCalls).toEqual([RESUME_PATH]);
    expect(service.failV2InitialCalls).toHaveLength(1);
    expect(service.cancelV2Calls).toEqual([RESUME_HANDOFF]);
    const later = createMockHandoffService();
    const again = invokeMap({
      mark_resume_storage_removed: () => undefined,
      ack_resume_aborted: () => undefined,
    });
    await abortResumeRecord({
      service: later,
      invoke: again.invoke,
      commands: createCommandIdStore(),
      summary: resume({ kind: "result", stage: "tus_terminated" }),
      pendingStoragePath: RESUME_PATH,
    });
    expect(again.calls.map((call) => call.command)).not.toContain("tus_abort_resume");
    expect(later.abortResultCalls).toEqual([RESUME_HANDOFF]);
  });

  it("uses the exact resume storage path and stops on mismatch", async () => {
    expect(
      confirmedResumeStoragePath(
        RESUME_PATH,
        RESUME_PATH,
        RESUME_HANDOFF,
        1,
        RESUME_OBJECT,
      ),
    ).toBe(RESUME_PATH);
    expect(
      confirmedResumeStoragePath(
        RESUME_PATH,
        `${RESUME_WORKSPACE}/${RESUME_HANDOFF}/v2/${RESUME_OBJECT}`,
        RESUME_HANDOFF,
        1,
        RESUME_OBJECT,
      ),
    ).toBeNull();
    const service = createMockHandoffService();
    const { invoke } = invokeMap({
      tus_abort_resume: () => undefined,
    });
    await expect(
      abortResumeRecord({
        service,
        invoke,
        commands: createCommandIdStore(),
        summary: resume({ stage: "uploading" }),
        pendingStoragePath: `${RESUME_WORKSPACE}/${RESUME_HANDOFF}/v9/${RESUME_OBJECT}`,
      }),
    ).rejects.toMatchObject({ code: "invalid_storage_path" });
    expect(service.removeStorageCalls).toEqual([]);
  });
});
