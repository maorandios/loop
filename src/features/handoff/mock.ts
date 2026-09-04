import { CloudError } from "../../lib/supabase/errors";
import type { HandoffRecord, HandoffService } from "./types";

export type MockHandoffState = {
  handoffs?: HandoffRecord[];
  failCreate?: CloudError;
  failSession?: CloudError;
  failFinalize?: CloudError;
  failDownloadUrl?: CloudError;
  failModified?: CloudError;
  failUnmodified?: CloudError;
  signedDownloadUrl?: string;
  incomingListeners?: Array<() => void>;
  outgoingListeners?: Array<() => void>;
  unsubscribeCount?: { value: number };
  outgoingUnsubscribeCount?: { value: number };
};

export type MockHandoffService = HandoffService & {
  emitIncoming(next: HandoffRecord[]): void;
  emitOutgoing(next: HandoffRecord[]): void;
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
  createHandoffCalls: number;
  createWithContextCalls: number;
  failHandoffCalls: string[];
  completeCalls: string[];
  revisionCalls: Array<{ handoffId: string; note: string }>;
  markReturnReceivedCalls: string[];
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
  const listeners = state.incomingListeners ?? [];
  const outgoingListeners = state.outgoingListeners ?? [];
  const unsubscribeCount = state.unsubscribeCount ?? { value: 0 };
  const outgoingUnsubscribeCount = state.outgoingUnsubscribeCount ?? { value: 0 };

  const service: MockHandoffService = {
    modifiedCalls: [],
    unmodifiedCalls: [],
    createHandoffCalls: 0,
    createWithContextCalls: 0,
    failHandoffCalls: [],
    completeCalls: [],
    revisionCalls: [],
    markReturnReceivedCalls: [],
    async listHandoffs() {
      return [...handoffs];
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
    async createSignedDownloadUrl() {
      if (state.failDownloadUrl) {
        throw state.failDownloadUrl;
      }
      return state.signedDownloadUrl ?? "https://example.supabase.co/sign/filerelay/x";
    },
    subscribeToIncomingHandoffs(_recipientMemberId, onChange) {
      listeners.push(onChange);
      return () => {
        const index = listeners.indexOf(onChange);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
        unsubscribeCount.value += 1;
      };
    },
    subscribeToOutgoingHandoffs(_senderMemberId, onChange) {
      outgoingListeners.push(onChange);
      return () => {
        const index = outgoingListeners.indexOf(onChange);
        if (index >= 0) {
          outgoingListeners.splice(index, 1);
        }
        outgoingUnsubscribeCount.value += 1;
      };
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
  };

  return service;
}
