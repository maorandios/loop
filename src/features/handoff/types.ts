import type { HandoffStatus } from "../../copy/he";

export type HandoffVersion = {
  versionNumber: number;
  storagePath: string;
  fileSize: number;
  blake3: string;
};

export type HandoffEvent = {
  eventType: string;
  note: string | null;
  versionNumber: number | null;
  actorMemberId: string | null;
  createdAt: string;
};

export type HandoffRecord = {
  id: string;
  workspaceId: string;
  senderMemberId: string;
  recipientMemberId: string;
  originalFilename: string;
  instruction: string | null;
  dueOn: string | null;
  status: HandoffStatus;
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
};

export type CreatedHandoff = {
  handoffId: string;
  objectId: string;
  storagePath: string;
  workspaceId: string;
};

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

export type SendProgress = "idle" | "sending" | "sent" | "failed";

export type HandoffService = {
  listHandoffs(): Promise<HandoffRecord[]>;
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
  createSignedDownloadUrl(storagePath: string): Promise<string>;
  subscribeToIncomingHandoffs(
    recipientMemberId: string,
    onChange: () => void,
  ): () => void;
  subscribeToOutgoingHandoffs(
    senderMemberId: string,
    onChange: () => void,
  ): () => void;
};
