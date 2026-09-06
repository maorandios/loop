import type { HandoffStatus } from "../../copy/he";

export type HandoffVersion = {
  versionNumber: number;
  storagePath: string;
  fileSize: number;
  blake3: string;
  fileName?: string | null;
};

export type HandoffEvent = {
  id?: string | null;
  eventType: string;
  note: string | null;
  versionNumber: number | null;
  actorMemberId: string | null;
  transferId?: string | null;
  createdAt: string;
};

export type RequestedAction = "approval" | "review" | "update" | "file_request";
export type RequestStatus = "open" | "completed" | "cancelled";
export type TransferStatus =
  | "preparing"
  | "active"
  | "waiting_child"
  | "returned_to_sender"
  | "failed"
  | "closed";
export type ResultAction =
  | "approved"
  | "review_completed"
  | "returned_with_file"
  | "returned_with_reply"
  | "rejected";
export type ViewerRelation = "from" | "to" | "creator" | "prior";
export type HandoffSection = "mine" | "watching" | "done";
export type HandoffFlowVersion = 1 | 2;

export type TransferRecord = {
  id: string;
  handoffId: string;
  parentTransferId: string | null;
  fromMemberId: string;
  toMemberId: string;
  requestedAction: RequestedAction;
  instruction: string;
  dueOn: string | null;
  status: TransferStatus;
  resultAction: ResultAction | null;
  resultNote: string | null;
  resultVersionNumber: number | null;
  handlingRound?: number;
  lastReminderAt?: string | null;
  pendingObjectId?: string | null;
  pendingVersionNumber?: number | null;
  pendingStoragePath?: string | null;
  pendingUploadExpiresAt?: string | null;
  updatedAt: string;
};

export type HandoffRecord = {
  id: string;
  workspaceId: string;
  senderMemberId: string;
  recipientMemberId: string;
  originalFilename: string;
  instruction: string | null;
  dueOn: string | null;
  status: HandoffStatus | null;
  createdAt: string;
  updatedAt: string;
  fileSize: number | null;
  blake3: string | null;
  storagePath: string | null;
  returnFileSize: number | null;
  returnBlake3: string | null;
  returnStoragePath: string | null;
  versions: HandoffVersion[];
  events: HandoffEvent[];
  flowVersion?: HandoffFlowVersion;
  requestStatus?: RequestStatus | null;
  activeTransferId?: string | null;
  closedAt?: string | null;
  cancelledAt?: string | null;
};

export type HandoffSnapshot = {
  handoffs: HandoffRecord[];
  transfers: TransferRecord[];
  v2LoadFailed: boolean;
};

export type CreatedHandoff = {
  handoffId: string;
  objectId: string;
  storagePath: string;
  workspaceId: string;
};

export type CreatedHandoffV2 = {
  handoffId: string;
  transferId: string;
  objectId: string;
  storagePath: string;
  pendingUploadExpiresAt: string;
};

export type CreatedFileRequest = {
  handoffId: string;
  transferId: string;
};

export type StartedResultUpload = {
  objectId: string;
  versionNumber: number;
  storagePath: string;
  pendingUploadExpiresAt: string;
};

export type ReminderResult = {
  sentAt: string;
  nextAllowedAt: string;
};

export type FinalizeIntent = {
  resultAction: ResultAction;
  resultNote: string | null;
};

export type ResumeKind = "initial" | "result";
export type ResumeStage =
  | "reserved"
  | "snapshot_ready"
  | "tus_created"
  | "uploading"
  | "uploaded_waiting_finalize"
  | "post_response_unknown"
  | "aborting"
  | "tus_terminated"
  | "upload_completed_cleanup"
  | "storage_removed"
  | "rpc_confirmed";

export type ResumeSummary = {
  kind: ResumeKind;
  stage: ResumeStage;
  handoffId: string;
  transferId: string;
  objectId: string;
  versionNumber: number;
  fileName: string;
  storagePath: string;
  pendingUploadExpiresAt: string;
  reservationClientRequestId: string;
  lastRenewClientRequestId: string | null;
  finalizeClientRequestId: string;
  abortClientRequestId: string;
};

export type ResumeUploadResult = {
  kind: ResumeKind;
  stage: ResumeStage;
  handoffId: string;
  transferId: string;
  objectId: string;
  versionNumber: number;
  fileName: string;
  expectedSize?: number;
  blake3?: string;
  finalizeClientRequestId?: string;
  finalizeIntent?: FinalizeIntent;
};

export type PreparedResultSnapshot = {
  snapshotId: string;
  fileName: string;
  fileSize: number;
  blake3: string;
};

export type LocalWorkState =
  | "idle"
  | "sending"
  | "uploading"
  | "finalizing"
  | "resuming"
  | "waiting_reselect"
  | "file_changed"
  | "offline"
  | "retry"
  | "aborting";

export type FormMode = "send" | "file_request";
export type SendAction = "approval" | "review" | "update";

export type StartedReturn = {
  handoffId: string;
  objectId: string;
  storagePath: string;
  versionNumber: number;
};

export type PickedFile = {
  selectionId: string;
  originalFilename: string;
  size: number;
  blake3: string;
};

export type InboxLocalEntry = {
  handoffId: string;
  filename: string;
  version: string;
  contentDiffersFromV1: boolean;
  desiredStatus: string;
  pendingRecheck: boolean;
  pendingStatusSync: boolean;
  generation: number;
};

export type LocalStateEvent = {
  handoffId: string;
  generation: number;
  contentDiffersFromV1: boolean;
  desiredStatus: "opened" | "modified";
  pendingRecheck: boolean;
};

export type PendingLocalStatus = {
  handoffId: string;
  generation: number;
  desiredStatus: string;
  contentDiffersFromV1: boolean;
  pendingRecheck: boolean;
};

export type PreparedReturnSnapshot = {
  returnSnapshotId: string;
  fileSize: number;
  blake3: string;
};

export type SendProgress = "idle" | "sending" | "uploading" | "finalizing" | "sent" | "failed";

export type HandoffSubscribeOptions = {
  onSubscribed?: () => void;
  onDisconnected?: () => void;
};

export type HandoffService = {
  listHandoffs(): Promise<HandoffRecord[]>;
  listHandoffSnapshot(workspaceId: string): Promise<HandoffSnapshot>;
  createHandoff(
    recipientMemberId: string,
    originalFilename: string,
  ): Promise<CreatedHandoff>;
  createHandoffWithContext(
    recipientMemberId: string,
    originalFilename: string,
    instruction: string,
    dueOn: string | null,
  ): Promise<CreatedHandoff>;
  currentAccessToken(): Promise<string>;
  finalizeHandoffV1(
    handoffId: string,
    objectId: string,
    fileSize: number,
    blake3: string,
  ): Promise<void>;
  failHandoff(handoffId: string): Promise<void>;
  markReceived(handoffId: string): Promise<void>;
  markOpened(handoffId: string): Promise<void>;
  markModified(handoffId: string): Promise<void>;
  markUnmodified(handoffId: string): Promise<void>;
  beginReturn(handoffId: string): Promise<StartedReturn>;
  beginReturnNext(handoffId: string): Promise<StartedReturn>;
  finalizeReturnV2(
    handoffId: string,
    objectId: string,
    fileSize: number,
    blake3: string,
  ): Promise<void>;
  finalizeHandoffReturn(
    handoffId: string,
    versionNumber: number,
    objectId: string,
    fileSize: number,
    blake3: string,
  ): Promise<void>;
  failHandoffReturn(handoffId: string): Promise<void>;
  completeHandoff(handoffId: string): Promise<void>;
  requestRevision(handoffId: string, note: string): Promise<void>;
  markReturnReceived(handoffId: string): Promise<void>;
  createHandoffV2(
    recipientMemberId: string,
    originalFilename: string,
    requestedAction: SendAction,
    instruction: string,
    dueOn: string | null,
    clientRequestId: string,
  ): Promise<CreatedHandoffV2>;
  createFileRequestV2(
    recipientMemberId: string,
    instruction: string,
    dueOn: string | null,
    clientRequestId: string,
  ): Promise<CreatedFileRequest>;
  finalizeHandoffV2Initial(
    handoffId: string,
    objectId: string,
    fileSize: number,
    blake3: string,
    clientRequestId: string,
  ): Promise<void>;
  failHandoffV2Initial(handoffId: string, clientRequestId: string): Promise<void>;
  retryHandoffV2Initial(handoffId: string, clientRequestId: string): Promise<CreatedHandoffV2>;
  markRootTransferOpened(handoffId: string, clientRequestId: string): Promise<void>;
  beginTransferResultUpload(
    handoffId: string,
    clientRequestId: string,
  ): Promise<StartedResultUpload>;
  renewTransferUploadReservation(
    handoffId: string,
    clientRequestId: string,
  ): Promise<StartedResultUpload>;
  finalizeTransferResult(
    handoffId: string,
    resultAction: ResultAction,
    resultNote: string | null,
    objectId: string,
    fileSize: number,
    blake3: string,
    clientRequestId: string,
  ): Promise<void>;
  finalizeFileRequestResult(
    handoffId: string,
    fileName: string,
    objectId: string,
    fileSize: number,
    blake3: string,
    clientRequestId: string,
  ): Promise<void>;
  submitTransferResultWithoutFile(
    handoffId: string,
    resultAction: ResultAction,
    resultNote: string | null,
    clientRequestId: string,
  ): Promise<void>;
  abortTransferResultUpload(handoffId: string, clientRequestId: string): Promise<void>;
  acceptRootTransferResult(handoffId: string, clientRequestId: string): Promise<void>;
  requestRootTransferRevision(
    handoffId: string,
    note: string,
    clientRequestId: string,
  ): Promise<void>;
  cancelRootHandoffV2(handoffId: string, clientRequestId: string): Promise<void>;
  sendTransferReminder(handoffId: string, clientRequestId: string): Promise<ReminderResult>;
  removeStorageObject(storagePath: string): Promise<void>;
  createSignedDownloadUrl(storagePath: string): Promise<string>;
  subscribeToIncomingHandoffs(
    recipientMemberId: string,
    onChange: () => void,
    options?: HandoffSubscribeOptions,
  ): () => void;
  subscribeToOutgoingHandoffs(
    senderMemberId: string,
    onChange: () => void,
    options?: HandoffSubscribeOptions,
  ): () => void;
  subscribeToHandoffEvents(
    memberId: string,
    onEvent: (eventId: string | null) => void,
    options?: HandoffSubscribeOptions,
  ): () => void;
};
