import { CloudError, cloudErrorCode } from "../../lib/supabase/errors";
import type { CommandIdStore } from "./commandIds";
import type {
  FinalizeIntent,
  HandoffRecord,
  HandoffService,
  HandoffVersion,
  LocalWorkState,
  InboxLocalEntry,
  PickedFile,
  PreparedResultSnapshot,
  RequestedAction,
  ResultAction,
  ResumeSummary,
  ResumeUploadResult,
  SendAction,
} from "./types";
import type { TransferHandoffView } from "./view";
import { latestHandoffVersion } from "./versions";

export type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const STORAGE_PATH_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v([1-9]\d{0,2}|1000)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function confirmedResumeStoragePath(
  resumePath: string | undefined,
  pendingPath: string | null | undefined,
  handoffId: string,
  versionNumber: number,
  objectId: string,
): string | null {
  if (!resumePath || !pendingPath || resumePath !== pendingPath) {
    return null;
  }
  const match = STORAGE_PATH_RE.exec(resumePath);
  if (!match) {
    return null;
  }
  const handoff = match[2];
  const version = Number(match[3]);
  const object = match[4];
  if (
    handoff?.toLowerCase() !== handoffId.toLowerCase() ||
    version !== versionNumber ||
    object?.toLowerCase() !== objectId.toLowerCase()
  ) {
    return null;
  }
  return resumePath;
}

export function versionFileName(version: HandoffVersion | null, fallback: string): string {
  return version?.fileName?.trim() || fallback;
}

export function resumeMatchesFinalizedVersion(
  summary: Pick<ResumeSummary, "versionNumber" | "objectId">,
  versions: HandoffVersion[] | undefined,
): "match" | "mismatch" | "absent" {
  const sameNumber = (versions ?? []).find(
    (version) => version.versionNumber === summary.versionNumber,
  );
  if (!sameNumber) {
    return "absent";
  }
  const parsed = STORAGE_PATH_RE.exec(sameNumber.storagePath);
  if (parsed?.[4]?.toLowerCase() === summary.objectId.toLowerCase()) {
    return "match";
  }
  return "mismatch";
}

export function resultActionForRequest(
  requested: RequestedAction,
  changed: boolean,
  rejected: boolean,
): ResultAction {
  if (rejected) {
    return "rejected";
  }
  if (requested === "approval") {
    return "approved";
  }
  if (requested === "review") {
    return "review_completed";
  }
  if (requested === "file_request") {
    return "returned_with_file";
  }
  return changed ? "returned_with_file" : "returned_with_reply";
}

export function inboxGenerationFor(
  entries: InboxLocalEntry[],
  handoffId: string,
): number | null {
  return entries.find((entry) => entry.handoffId === handoffId)?.generation ?? null;
}

export function workingFileChangedAfterPrepare(
  entries: InboxLocalEntry[],
  handoffId: string,
  baseline: number | null,
): boolean {
  if (baseline == null) {
    return false;
  }
  const current = inboxGenerationFor(entries, handoffId);
  return current != null && current !== baseline;
}

function isNetworkError(error: unknown): boolean {
  return cloudErrorCode(error) === "cloud_unavailable";
}

export function forgetResultUploadCommands(commands: CommandIdStore, handoffId: string): void {
  commands.forget("begin_transfer_result_upload", handoffId);
  commands.forget("finalize_transfer_result", handoffId);
  commands.forget("finalize_file_request_result", handoffId);
  commands.forget("abort_transfer_result_upload", handoffId);
}

export async function sendHandoffV2(input: {
  service: HandoffService;
  invoke: InvokeFn;
  commands: CommandIdStore;
  recipientMemberId: string;
  picked: PickedFile;
  requestedAction: SendAction;
  instruction: string;
  dueOn: string | null;
  onState?: (state: LocalWorkState) => void;
}): Promise<string> {
  const scope = `send:${input.picked.selectionId}`;
  const reservationId = input.commands.id("create_handoff_v2", scope);
  const finalizeId = input.commands.id("finalize_handoff_v2_initial", scope);
  const abortId = input.commands.id("abort_handoff_v2_initial", scope);
  input.onState?.("sending");
  const created = await input.service.createHandoffV2(
    input.recipientMemberId,
    input.picked.originalFilename,
    input.requestedAction,
    input.instruction,
    input.dueOn,
    reservationId,
  );
  try {
    const accessToken = await input.service.currentAccessToken();
    input.onState?.("uploading");
    await input.invoke("tus_upload_initial_v2", {
      selectionId: input.picked.selectionId,
      accessToken,
      handoffId: created.handoffId,
      transferId: created.transferId,
      objectId: created.objectId,
      storagePath: created.storagePath,
      pendingUploadExpiresAt: created.pendingUploadExpiresAt,
      reservationClientRequestId: reservationId,
      finalizeClientRequestId: finalizeId,
      abortClientRequestId: abortId,
    });
    input.onState?.("finalizing");
    await input.service.finalizeHandoffV2Initial(
      created.handoffId,
      created.objectId,
      input.picked.size,
      input.picked.blake3,
      finalizeId,
    );
    await input.invoke("ack_resume_finalized", {
      handoffId: created.handoffId,
      versionNumber: 1,
      objectId: created.objectId,
      finalizeClientRequestId: finalizeId,
    });
    return created.handoffId;
  } catch (error) {
    if (isNetworkError(error)) {
      throw error;
    }
    throw error;
  }
}

export async function createFileRequest(input: {
  service: HandoffService;
  commands: CommandIdStore;
  recipientMemberId: string;
  instruction: string;
  dueOn: string | null;
}): Promise<string> {
  const scope = `file-request:${input.recipientMemberId}:${input.instruction}`;
  const clientRequestId = input.commands.id("create_file_request_v2", scope);
  const created = await input.service.createFileRequestV2(
    input.recipientMemberId,
    input.instruction,
    input.dueOn,
    clientRequestId,
  );
  return created.handoffId;
}

export async function submitWithoutFile(input: {
  service: HandoffService;
  commands: CommandIdStore;
  handoffId: string;
  resultAction: ResultAction;
  resultNote: string | null;
}): Promise<void> {
  const id = input.commands.id("submit_transfer_result_without_file", input.handoffId);
  await input.service.submitTransferResultWithoutFile(
    input.handoffId,
    input.resultAction,
    input.resultNote,
    id,
  );
}

export async function submitWithFile(input: {
  service: HandoffService;
  invoke: InvokeFn;
  commands: CommandIdStore;
  handoffId: string;
  transferId: string;
  intent: FinalizeIntent;
  snapshot: PreparedResultSnapshot;
  changedDuringUpload: () => Promise<boolean>;
  onState?: (state: LocalWorkState) => void;
}): Promise<void> {
  const reservationId = input.commands.id("begin_transfer_result_upload", input.handoffId);
  const finalizeId = input.commands.id("finalize_transfer_result", input.handoffId);
  const abortId = input.commands.id("abort_transfer_result_upload", input.handoffId);
  input.onState?.("sending");
  const started = await input.service.beginTransferResultUpload(input.handoffId, reservationId);
  const accessToken = await input.service.currentAccessToken();
  input.onState?.("uploading");
  await input.invoke("tus_upload_result", {
    snapshotId: input.snapshot.snapshotId,
    accessToken,
    handoffId: input.handoffId,
    transferId: input.transferId,
    objectId: started.objectId,
    storagePath: started.storagePath,
    versionNumber: started.versionNumber,
    pendingUploadExpiresAt: started.pendingUploadExpiresAt,
    reservationClientRequestId: reservationId,
    finalizeClientRequestId: finalizeId,
    abortClientRequestId: abortId,
    finalizeIntent: {
      resultAction: input.intent.resultAction,
      resultNote: input.intent.resultNote,
    },
  });
  if (await input.changedDuringUpload()) {
    throw new CloudError("file_changed_during_upload");
  }
  input.onState?.("finalizing");
  await input.service.finalizeTransferResult(
    input.handoffId,
    input.intent.resultAction,
    input.intent.resultNote,
    started.objectId,
    input.snapshot.fileSize,
    input.snapshot.blake3,
    finalizeId,
  );
  await input.invoke("ack_resume_finalized", {
    handoffId: input.handoffId,
    versionNumber: started.versionNumber,
    objectId: started.objectId,
    finalizeClientRequestId: finalizeId,
  });
  forgetResultUploadCommands(input.commands, input.handoffId);
}

export async function attachFileRequest(input: {
  service: HandoffService;
  invoke: InvokeFn;
  commands: CommandIdStore;
  handoffId: string;
  transferId: string;
  picked: PickedFile;
  onState?: (state: LocalWorkState) => void;
}): Promise<void> {
  input.onState?.("sending");
  const prepared = await input.invoke<PreparedResultSnapshot>(
    "prepare_result_snapshot_from_selection",
    {
      selectionId: input.picked.selectionId,
      handoffId: input.handoffId,
      transferId: input.transferId,
    },
  );
  const reservationId = input.commands.id("begin_transfer_result_upload", input.handoffId);
  const finalizeId = input.commands.id("finalize_file_request_result", input.handoffId);
  const abortId = input.commands.id("abort_transfer_result_upload", input.handoffId);
  const started = await input.service.beginTransferResultUpload(input.handoffId, reservationId);
  const accessToken = await input.service.currentAccessToken();
  input.onState?.("uploading");
  await input.invoke("tus_upload_result", {
    snapshotId: prepared.snapshotId,
    accessToken,
    handoffId: input.handoffId,
    transferId: input.transferId,
    objectId: started.objectId,
    storagePath: started.storagePath,
    versionNumber: started.versionNumber,
    pendingUploadExpiresAt: started.pendingUploadExpiresAt,
    reservationClientRequestId: reservationId,
    finalizeClientRequestId: finalizeId,
    abortClientRequestId: abortId,
    finalizeIntent: {
      resultAction: "returned_with_file",
      resultNote: null,
    },
  });
  input.onState?.("finalizing");
  await input.service.finalizeFileRequestResult(
    input.handoffId,
    prepared.fileName,
    started.objectId,
    prepared.fileSize,
    prepared.blake3,
    finalizeId,
  );
  await input.invoke("ack_resume_finalized", {
    handoffId: input.handoffId,
    versionNumber: started.versionNumber,
    objectId: started.objectId,
    finalizeClientRequestId: finalizeId,
  });
  forgetResultUploadCommands(input.commands, input.handoffId);
}

export async function openRootTransfer(input: {
  service: HandoffService;
  invoke: InvokeFn;
  commands: CommandIdStore;
  handoff: HandoffRecord;
  memberId: string | null;
  source?: TransferHandoffView | null;
}): Promise<void> {
  if (
    input.source &&
    input.source.activeHop?.requestedAction === "file_request" &&
    input.source.latestFinalizedVersion === null
  ) {
    throw new CloudError("file_request_not_yet_supplied");
  }
  const version = latestHandoffVersion(input.handoff);
  if (!version) {
    throw new CloudError("download_failed");
  }
  const fileName = versionFileName(version, input.handoff.originalFilename);
  if (!fileName) {
    throw new CloudError("file_request_not_yet_supplied");
  }
  const signedUrl = await input.service.createSignedDownloadUrl(version.storagePath);
  const role = input.handoff.senderMemberId === input.memberId ? "sender" : "recipient";
  await input.invoke("download_inbox", {
    handoffId: input.handoff.id,
    signedUrl,
    expectedSize: version.fileSize,
    expectedBlake3: version.blake3,
    originalFilename: fileName,
    version: `v${version.versionNumber}`,
    role,
  });
  if (role === "recipient") {
    await input.invoke("start_inbox_watch", { handoffId: input.handoff.id });
    await input.invoke("recheck_inbox_file", { handoffId: input.handoff.id });
  }
  await input.invoke("open_inbox_file", {
    handoffId: input.handoff.id,
    version: `v${version.versionNumber}`,
  });
  const round = input.source?.activeHop?.handlingRound ?? 1;
  const openedId = input.commands.id("mark_root_transfer_opened", `${input.handoff.id}:${round}`);
  await input.service.markRootTransferOpened(input.handoff.id, openedId);
}

export async function abortResumeRecord(input: {
  service: HandoffService;
  invoke: InvokeFn;
  commands: CommandIdStore;
  summary: ResumeSummary;
  pendingStoragePath: string | null;
  stillOpen?: boolean;
}): Promise<void> {
  const accessToken = await input.service.currentAccessToken();
  const path = confirmedResumeStoragePath(
    input.summary.storagePath,
    input.pendingStoragePath,
    input.summary.handoffId,
    input.summary.versionNumber,
    input.summary.objectId,
  );
  if (!path) {
    throw new CloudError("invalid_storage_path");
  }
  if (
    input.summary.stage !== "tus_terminated" &&
    input.summary.stage !== "upload_completed_cleanup" &&
    input.summary.stage !== "storage_removed"
  ) {
    await input.invoke("tus_abort_resume", {
      handoffId: input.summary.handoffId,
      versionNumber: input.summary.versionNumber,
      objectId: input.summary.objectId,
      accessToken,
    });
  }
  if (input.summary.stage !== "storage_removed") {
    await input.service.removeStorageObject(path);
    await input.invoke("mark_resume_storage_removed", {
      handoffId: input.summary.handoffId,
      versionNumber: input.summary.versionNumber,
      objectId: input.summary.objectId,
    });
  }
  if (input.summary.kind === "initial") {
    await input.service.failHandoffV2Initial(
      input.summary.handoffId,
      input.summary.abortClientRequestId,
    );
  } else {
    await input.service.abortTransferResultUpload(
      input.summary.handoffId,
      input.summary.abortClientRequestId,
    );
  }
  await input.invoke("ack_resume_aborted", {
    handoffId: input.summary.handoffId,
    versionNumber: input.summary.versionNumber,
    objectId: input.summary.objectId,
    abortClientRequestId: input.summary.abortClientRequestId,
  });
  if (input.stillOpen) {
    const cancelId = input.commands.id("cancel_root_handoff_v2", input.summary.handoffId);
    await input.service.cancelRootHandoffV2(input.summary.handoffId, cancelId);
  }
  forgetResultUploadCommands(input.commands, input.summary.handoffId);
}

export function reservationNearExpiry(expiresAt: string, nowMs = Date.now()): boolean {
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires)) {
    return true;
  }
  return expires - nowMs <= 60_000;
}

export async function recoverResumeRecord(input: {
  service: HandoffService;
  invoke: InvokeFn;
  commands: CommandIdStore;
  summary: ResumeSummary;
  pendingStoragePath: string | null;
  handoff: HandoffRecord | null;
  onState?: (state: LocalWorkState) => void;
  pickReplacement?: () => Promise<PickedFile | null>;
}): Promise<void> {
  const finalized = resumeMatchesFinalizedVersion(
    input.summary,
    input.handoff?.versions,
  );
  if (finalized === "match") {
    await input.invoke("ack_resume_finalized", {
      handoffId: input.summary.handoffId,
      versionNumber: input.summary.versionNumber,
      objectId: input.summary.objectId,
      finalizeClientRequestId: input.summary.finalizeClientRequestId,
    });
    return;
  }
  if (finalized === "mismatch") {
    throw new CloudError("resume_file_mismatch");
  }
  if (
    input.summary.stage === "tus_terminated" ||
    input.summary.stage === "upload_completed_cleanup" ||
    input.summary.stage === "storage_removed"
  ) {
    input.onState?.("aborting");
    await abortResumeRecord({
      service: input.service,
      invoke: input.invoke,
      commands: input.commands,
      summary: input.summary,
      pendingStoragePath: input.pendingStoragePath,
    });
    return;
  }
  if (reservationNearExpiry(input.summary.pendingUploadExpiresAt)) {
    const renewId = input.commands.id("renew_transfer_upload_reservation", input.summary.handoffId);
    const renewed = await input.service.renewTransferUploadReservation(
      input.summary.handoffId,
      renewId,
    );
    await input.invoke("update_resume_reservation_expiry", {
      handoffId: input.summary.handoffId,
      versionNumber: input.summary.versionNumber,
      objectId: input.summary.objectId,
      pendingUploadExpiresAt: renewed.pendingUploadExpiresAt,
      renewClientRequestId: renewId,
    });
  }
  const accessToken = await input.service.currentAccessToken();
  input.onState?.("resuming");
  let resumed: ResumeUploadResult;
  try {
    resumed = await input.invoke<ResumeUploadResult>("resume_tus_upload", {
      handoffId: input.summary.handoffId,
      versionNumber: input.summary.versionNumber,
      objectId: input.summary.objectId,
      accessToken,
    });
  } catch (error) {
    if (cloudErrorCode(error) === "resume_snapshot_required") {
      input.onState?.("waiting_reselect");
      const picked = (await input.pickReplacement?.()) ?? null;
      if (!picked) {
        throw error;
      }
      await input.invoke("restore_resume_snapshot_from_selection", {
        selectionId: picked.selectionId,
        handoffId: input.summary.handoffId,
        versionNumber: input.summary.versionNumber,
        objectId: input.summary.objectId,
      });
      resumed = await input.invoke<ResumeUploadResult>("resume_tus_upload", {
        handoffId: input.summary.handoffId,
        versionNumber: input.summary.versionNumber,
        objectId: input.summary.objectId,
        accessToken,
      });
    } else if (isNetworkError(error)) {
      input.onState?.("offline");
      throw error;
    } else {
      throw error;
    }
  }
  if (resumed.stage === "uploaded_waiting_finalize") {
    input.onState?.("finalizing");
    if (input.summary.kind === "initial") {
      await input.service.finalizeHandoffV2Initial(
        input.summary.handoffId,
        input.summary.objectId,
        resumed.expectedSize ?? 0,
        resumed.blake3 ?? "",
        input.summary.finalizeClientRequestId,
      );
    } else if (resumed.finalizeIntent?.resultAction === "returned_with_file" && !input.handoff?.originalFilename) {
      await input.service.finalizeFileRequestResult(
        input.summary.handoffId,
        resumed.fileName,
        input.summary.objectId,
        resumed.expectedSize ?? 0,
        resumed.blake3 ?? "",
        input.summary.finalizeClientRequestId,
      );
    } else {
      const intent = resumed.finalizeIntent;
      if (!intent) {
        throw new CloudError("finalize_intent_mismatch");
      }
      await input.service.finalizeTransferResult(
        input.summary.handoffId,
        intent.resultAction,
        intent.resultNote,
        input.summary.objectId,
        resumed.expectedSize ?? 0,
        resumed.blake3 ?? "",
        input.summary.finalizeClientRequestId,
      );
    }
    await input.invoke("ack_resume_finalized", {
      handoffId: input.summary.handoffId,
      versionNumber: input.summary.versionNumber,
      objectId: input.summary.objectId,
      finalizeClientRequestId: input.summary.finalizeClientRequestId,
    });
    forgetResultUploadCommands(input.commands, input.summary.handoffId);
  }
}

export function uniqueClientRequestIds(ids: string[]): boolean {
  return new Set(ids).size === ids.length;
}
