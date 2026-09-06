import { CloudError } from "../../lib/supabase/errors";
import type {
  CreatedHandoffV2,
  HandoffRecord,
  HandoffService,
  ResultAction,
  TransferRecord,
} from "./types";

export type MockHandoffState = {
  handoffs?: HandoffRecord[];
  transfers?: TransferRecord[];
  v2LoadFailed?: boolean;
  failCreate?: CloudError;
  failSnapshot?: CloudError;
  failSession?: CloudError;
  failFinalize?: CloudError;
  failDownloadUrl?: CloudError;
  failModified?: CloudError;
  failUnmodified?: CloudError;
  signedDownloadUrl?: string;
  incomingListeners?: Array<() => void>;
  outgoingListeners?: Array<() => void>;
  eventListeners?: Array<(eventId: string | null) => void>;
  unsubscribeCount?: { value: number };
  outgoingUnsubscribeCount?: { value: number };
  eventUnsubscribeCount?: { value: number };
};

export type MockHandoffService = HandoffService & {
  emitIncoming(next: HandoffRecord[]): void;
  emitOutgoing(next: HandoffRecord[]): void;
  emitEvent(eventId?: string | null): void;
  notifyIncoming(): void;
  failNextSnapshot(error?: CloudError): void;
  lastCreated?: {
    recipientMemberId: string;
    originalFilename: string;
  };
  lastCreatedWithContext?: {
    recipientMemberId: string;
    originalFilename: string;
    instruction: string;
    dueOn: string | null;
  };
  lastCreatedV2?: {
    recipientMemberId: string;
    originalFilename: string;
    requestedAction: string;
    instruction: string;
    dueOn: string | null;
    clientRequestId: string;
  };
  lastFileRequest?: {
    recipientMemberId: string;
    instruction: string;
    dueOn: string | null;
    clientRequestId: string;
  };
  createHandoffCalls: number;
  createWithContextCalls: number;
  createV2Calls: number;
  createFileRequestCalls: number;
  failHandoffCalls: string[];
  failV2InitialCalls: Array<{ handoffId: string; clientRequestId: string }>;
  completeCalls: string[];
  revisionCalls: Array<{ handoffId: string; note: string }>;
  revisionV2Calls: Array<{ handoffId: string; note: string; clientRequestId: string }>;
  markReturnReceivedCalls: string[];
  markOpenedV2Calls: Array<{ handoffId: string; clientRequestId: string }>;
  acceptCalls: string[];
  cancelV2Calls: string[];
  reminderCalls: string[];
  submitWithoutFileCalls: Array<{
    handoffId: string;
    resultAction: ResultAction;
    resultNote: string | null;
    clientRequestId: string;
  }>;
  finalizeV2InitialCalls: string[];
  finalizeTransferCalls: string[];
  finalizeFileRequestCalls: string[];
  beginResultCalls: string[];
  abortResultCalls: string[];
  removeStorageCalls: string[];
  clientRequestIds: string[];
  modifiedCalls: string[];
  unmodifiedCalls: string[];
};

function withReturnFields(row: HandoffRecord): HandoffRecord {
  return {
    ...row,
    instruction: row.instruction ?? null,
    dueOn: row.dueOn ?? null,
    returnFileSize: row.returnFileSize ?? null,
    returnBlake3: row.returnBlake3 ?? null,
    returnStoragePath: row.returnStoragePath ?? null,
    versions: row.versions ?? [],
    events: row.events ?? [],
  };
}

export function createMockHandoffService(
  state: MockHandoffState = {},
): MockHandoffService {
  let handoffs = (state.handoffs ?? []).map(withReturnFields);
  let transfers = state.transfers ?? [];
  const listeners = state.incomingListeners ?? [];
  const outgoingListeners = state.outgoingListeners ?? [];
  const eventListeners = state.eventListeners ?? [];
  const unsubscribeCount = state.unsubscribeCount ?? { value: 0 };
  const outgoingUnsubscribeCount = state.outgoingUnsubscribeCount ?? { value: 0 };
  const eventUnsubscribeCount = state.eventUnsubscribeCount ?? { value: 0 };

  const service: MockHandoffService = {
    modifiedCalls: [],
    unmodifiedCalls: [],
    createHandoffCalls: 0,
    createWithContextCalls: 0,
    createV2Calls: 0,
    createFileRequestCalls: 0,
    failHandoffCalls: [],
    failV2InitialCalls: [],
    completeCalls: [],
    revisionCalls: [],
    revisionV2Calls: [],
    markReturnReceivedCalls: [],
    markOpenedV2Calls: [],
    acceptCalls: [],
    cancelV2Calls: [],
    reminderCalls: [],
    submitWithoutFileCalls: [],
    finalizeV2InitialCalls: [],
    finalizeTransferCalls: [],
    finalizeFileRequestCalls: [],
    beginResultCalls: [],
    abortResultCalls: [],
    removeStorageCalls: [],
    clientRequestIds: [],
    async listHandoffs() {
      return [...handoffs];
    },
    async listHandoffSnapshot() {
      if (state.failSnapshot) {
        const error = state.failSnapshot;
        state.failSnapshot = undefined;
        throw error;
      }
      return {
        handoffs: [...handoffs],
        transfers: [...transfers],
        v2LoadFailed: state.v2LoadFailed === true,
      };
    },
    async createHandoff(recipientMemberId, originalFilename) {
      service.createHandoffCalls += 1;
      service.lastCreated = { recipientMemberId, originalFilename };
      if (state.failCreate) {
        throw state.failCreate;
      }
      return {
        handoffId: "handoff-1",
        objectId: "object-1",
        storagePath:
          "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/v1/33333333-3333-4333-8333-333333333333",
        workspaceId: "workspace-1",
      };
    },
    async createHandoffWithContext(recipientMemberId, originalFilename, instruction, dueOn) {
      service.createWithContextCalls += 1;
      service.lastCreatedWithContext = {
        recipientMemberId,
        originalFilename,
        instruction,
        dueOn,
      };
      if (state.failCreate) {
        throw state.failCreate;
      }
      return {
        handoffId: "handoff-1",
        objectId: "object-1",
        storagePath:
          "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/v1/33333333-3333-4333-8333-333333333333",
        workspaceId: "workspace-1",
      };
    },
    async currentAccessToken() {
      if (state.failSession) {
        throw state.failSession;
      }
      return "mock-session-token";
    },
    async finalizeHandoffV1() {
      if (state.failFinalize) {
        throw state.failFinalize;
      }
    },
    async failHandoff(handoffId) {
      service.failHandoffCalls.push(handoffId);
    },
    async markReceived(handoffId) {
      handoffs = handoffs.map((row) =>
        row.id === handoffId ? { ...row, status: "received" } : row,
      );
    },
    async markOpened(handoffId) {
      handoffs = handoffs.map((row) =>
        row.id === handoffId &&
        (row.status === "received" || row.status === "revision_requested")
          ? { ...row, status: "opened" }
          : row,
      );
    },
    async markModified(handoffId) {
      service.modifiedCalls.push(handoffId);
      if (state.failModified) {
        throw state.failModified;
      }
      handoffs = handoffs.map((row) =>
        row.id === handoffId ? { ...row, status: "modified" } : row,
      );
    },
    async markUnmodified(handoffId) {
      service.unmodifiedCalls.push(handoffId);
      if (state.failUnmodified) {
        throw state.failUnmodified;
      }
      handoffs = handoffs.map((row) =>
        row.id === handoffId ? { ...row, status: "opened" } : row,
      );
    },
    async beginReturn(handoffId) {
      handoffs = handoffs.map((row) =>
        row.id === handoffId ? { ...row, status: "returning" } : row,
      );
      return {
        handoffId,
        objectId: "object-2",
        storagePath:
          "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/v2/44444444-4444-4444-8444-444444444444",
        versionNumber: 2,
      };
    },
    async beginReturnNext(handoffId) {
      const existing = handoffs.find((row) => row.id === handoffId);
      const next =
        Math.max(1, ...(existing?.versions.map((version) => version.versionNumber) ?? [1])) + 1;
      handoffs = handoffs.map((row) =>
        row.id === handoffId ? { ...row, status: "returning" } : row,
      );
      return {
        handoffId,
        objectId: `object-${next}`,
        storagePath: `11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/v${next}/44444444-4444-4444-8444-444444444444`,
        versionNumber: next,
      };
    },
    async finalizeReturnV2(handoffId) {
      handoffs = handoffs.map((row) =>
        row.id === handoffId ? { ...row, status: "returned" } : row,
      );
    },
    async finalizeHandoffReturn(handoffId) {
      handoffs = handoffs.map((row) =>
        row.id === handoffId ? { ...row, status: "returned" } : row,
      );
    },
    async failHandoffReturn(handoffId) {
      handoffs = handoffs.map((row) =>
        row.id === handoffId ? { ...row, status: "modified" } : row,
      );
    },
    async completeHandoff(handoffId) {
      service.completeCalls.push(handoffId);
      handoffs = handoffs.map((row) =>
        row.id === handoffId ? { ...row, status: "completed" } : row,
      );
    },
    async requestRevision(handoffId, note) {
      service.revisionCalls.push({ handoffId, note });
      handoffs = handoffs.map((row) =>
        row.id === handoffId ? { ...row, status: "revision_requested" } : row,
      );
    },
    async markReturnReceived(handoffId) {
      service.markReturnReceivedCalls.push(handoffId);
      handoffs = handoffs.map((row) =>
        row.id === handoffId ? { ...row, status: "return_received" } : row,
      );
    },
    async createHandoffV2(
      recipientMemberId,
      originalFilename,
      requestedAction,
      instruction,
      dueOn,
      clientRequestId,
    ) {
      service.createV2Calls += 1;
      service.clientRequestIds.push(clientRequestId);
      service.lastCreatedV2 = {
        recipientMemberId,
        originalFilename,
        requestedAction,
        instruction,
        dueOn,
        clientRequestId,
      };
      if (state.failCreate) {
        throw state.failCreate;
      }
      return {
        handoffId: "handoff-v2",
        transferId: "transfer-v2",
        objectId: "object-v2",
        storagePath:
          "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/v1/33333333-3333-4333-8333-333333333333",
        pendingUploadExpiresAt: "2099-01-01T00:00:00Z",
      } satisfies CreatedHandoffV2;
    },
    async createFileRequestV2(recipientMemberId, instruction, dueOn, clientRequestId) {
      service.createFileRequestCalls += 1;
      service.clientRequestIds.push(clientRequestId);
      service.lastFileRequest = { recipientMemberId, instruction, dueOn, clientRequestId };
      if (state.failCreate) {
        throw state.failCreate;
      }
      return { handoffId: "handoff-file", transferId: "transfer-file" };
    },
    async finalizeHandoffV2Initial(handoffId, _objectId, _fileSize, _blake3, clientRequestId) {
      service.finalizeV2InitialCalls.push(handoffId);
      service.clientRequestIds.push(clientRequestId);
      if (state.failFinalize) {
        throw state.failFinalize;
      }
    },
    async failHandoffV2Initial(handoffId, clientRequestId) {
      service.failV2InitialCalls.push({ handoffId, clientRequestId });
      service.clientRequestIds.push(clientRequestId);
    },
    async retryHandoffV2Initial(handoffId, clientRequestId) {
      service.clientRequestIds.push(clientRequestId);
      return {
        handoffId,
        transferId: "transfer-retry",
        objectId: "object-retry",
        storagePath:
          "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/v1/99999999-9999-4999-8999-999999999999",
        pendingUploadExpiresAt: "2099-01-01T00:00:00Z",
      };
    },
    async markRootTransferOpened(handoffId, clientRequestId) {
      service.markOpenedV2Calls.push({ handoffId, clientRequestId });
      service.clientRequestIds.push(clientRequestId);
    },
    async beginTransferResultUpload(handoffId, clientRequestId) {
      service.beginResultCalls.push(handoffId);
      service.clientRequestIds.push(clientRequestId);
      return {
        objectId: "object-result",
        versionNumber: 2,
        storagePath:
          "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/v2/44444444-4444-4444-8444-444444444444",
        pendingUploadExpiresAt: "2099-01-01T00:00:00Z",
      };
    },
    async renewTransferUploadReservation(handoffId, clientRequestId) {
      service.clientRequestIds.push(clientRequestId);
      return {
        objectId: "object-result",
        versionNumber: 2,
        storagePath: `workspace/${handoffId}/v2/object-result`,
        pendingUploadExpiresAt: "2099-06-01T00:00:00Z",
      };
    },
    async finalizeTransferResult(handoffId, _action, _note, _objectId, _size, _blake3, clientRequestId) {
      service.finalizeTransferCalls.push(handoffId);
      service.clientRequestIds.push(clientRequestId);
    },
    async finalizeFileRequestResult(handoffId, _fileName, _objectId, _size, _blake3, clientRequestId) {
      service.finalizeFileRequestCalls.push(handoffId);
      service.clientRequestIds.push(clientRequestId);
    },
    async submitTransferResultWithoutFile(handoffId, resultAction, resultNote, clientRequestId) {
      service.submitWithoutFileCalls.push({
        handoffId,
        resultAction,
        resultNote,
        clientRequestId,
      });
      service.clientRequestIds.push(clientRequestId);
    },
    async abortTransferResultUpload(handoffId, clientRequestId) {
      service.abortResultCalls.push(handoffId);
      service.clientRequestIds.push(clientRequestId);
    },
    async acceptRootTransferResult(handoffId, clientRequestId) {
      service.acceptCalls.push(handoffId);
      service.clientRequestIds.push(clientRequestId);
    },
    async requestRootTransferRevision(handoffId, note, clientRequestId) {
      service.revisionV2Calls.push({ handoffId, note, clientRequestId });
      service.clientRequestIds.push(clientRequestId);
    },
    async cancelRootHandoffV2(handoffId, clientRequestId) {
      service.cancelV2Calls.push(handoffId);
      service.clientRequestIds.push(clientRequestId);
    },
    async sendTransferReminder(handoffId, clientRequestId) {
      service.reminderCalls.push(handoffId);
      service.clientRequestIds.push(clientRequestId);
      return { sentAt: "2026-09-06T00:00:00Z", nextAllowedAt: "2026-09-06T00:10:00Z" };
    },
    async removeStorageObject(storagePath) {
      service.removeStorageCalls.push(storagePath);
    },
    async createSignedDownloadUrl() {
      if (state.failDownloadUrl) {
        throw state.failDownloadUrl;
      }
      return state.signedDownloadUrl ?? "https://example.supabase.co/sign/filerelay/x";
    },
    subscribeToIncomingHandoffs(_recipientMemberId, onChange, options) {
      listeners.push(onChange);
      options?.onSubscribed?.();
      return () => {
        const index = listeners.indexOf(onChange);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
        unsubscribeCount.value += 1;
      };
    },
    subscribeToOutgoingHandoffs(_senderMemberId, onChange, options) {
      outgoingListeners.push(onChange);
      options?.onSubscribed?.();
      return () => {
        const index = outgoingListeners.indexOf(onChange);
        if (index >= 0) {
          outgoingListeners.splice(index, 1);
        }
        outgoingUnsubscribeCount.value += 1;
      };
    },
    failNextSnapshot(error = new CloudError("handoff_load_failed")) {
      state.failSnapshot = error;
    },
    notifyIncoming() {
      for (const listener of [...listeners]) {
        listener();
      }
    },
    emitIncoming(next) {
      handoffs = next.map(withReturnFields);
      state.handoffs = handoffs;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    emitOutgoing(next) {
      handoffs = next.map(withReturnFields);
      state.handoffs = handoffs;
      for (const listener of [...outgoingListeners]) {
        listener();
      }
    },
    subscribeToHandoffEvents(_memberId, onEvent, options) {
      eventListeners.push(onEvent);
      options?.onSubscribed?.();
      return () => {
        const index = eventListeners.indexOf(onEvent);
        if (index >= 0) {
          eventListeners.splice(index, 1);
        }
        eventUnsubscribeCount.value += 1;
      };
    },
    emitEvent(eventId = "evt-mock") {
      for (const listener of [...eventListeners]) {
        listener(eventId);
      }
    },
  };

  return service;
}
