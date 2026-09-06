import type { HandoffRecord, TransferRecord } from "./types";

export const NAMES = {
  creator: "מאור",
  sender: "מאור",
  recipient: "דני",
  prior: "נועה",
  outsider: "רותם",
} as const;

export const MEMBER = {
  creator: "member-creator",
  sender: "member-creator",
  recipient: "member-recipient",
  prior: "member-prior",
  outsider: "member-outsider",
} as const;

export function memberName(memberId: string): string {
  if (memberId === MEMBER.creator) {
    return NAMES.creator;
  }
  if (memberId === MEMBER.recipient) {
    return NAMES.recipient;
  }
  if (memberId === MEMBER.prior) {
    return NAMES.prior;
  }
  if (memberId === MEMBER.outsider) {
    return NAMES.outsider;
  }
  return "";
}

function baseRecord(partial: Partial<HandoffRecord>): HandoffRecord {
  return {
    id: "handoff-v2",
    workspaceId: "workspace-1",
    senderMemberId: MEMBER.creator,
    recipientMemberId: MEMBER.recipient,
    originalFilename: "דוח.docx",
    instruction: "נא לבדוק",
    dueOn: "2026-09-10",
    status: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    fileSize: 2048,
    blake3: "ab".repeat(32),
    storagePath: null,
    returnFileSize: null,
    returnBlake3: null,
    returnStoragePath: null,
    versions: [{ versionNumber: 1, storagePath: "p", fileSize: 2048, blake3: "ab".repeat(32) }],
    events: [],
    flowVersion: 2,
    requestStatus: "open",
    activeTransferId: "hop-root",
    ...partial,
  };
}

function hop(partial: Partial<TransferRecord> & Pick<TransferRecord, "id" | "status">): TransferRecord {
  return {
    handoffId: "handoff-v2",
    parentTransferId: null,
    fromMemberId: MEMBER.creator,
    toMemberId: MEMBER.recipient,
    requestedAction: "approval",
    instruction: "נא לאשר",
    dueOn: "2026-09-10",
    resultAction: null,
    resultNote: null,
    resultVersionNumber: null,
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...partial,
  };
}

export const v1Active: HandoffRecord = {
  ...baseRecord({
    id: "handoff-v1-active",
    flowVersion: 1,
    requestStatus: null,
    activeTransferId: null,
    status: "sent",
    originalFilename: "v1-פעיל.docx",
  }),
};

export const v1Returned: HandoffRecord = {
  ...baseRecord({
    id: "handoff-v1-returned",
    flowVersion: 1,
    requestStatus: null,
    activeTransferId: null,
    status: "returned",
    originalFilename: "v1-הוחזר.docx",
    updatedAt: "2026-09-03T00:00:00.000Z",
  }),
};

export const v1Completed: HandoffRecord = {
  ...baseRecord({
    id: "handoff-v1-completed",
    flowVersion: 1,
    requestStatus: null,
    activeTransferId: null,
    status: "completed",
    originalFilename: "v1-הושלם.docx",
  }),
};

export function v2RootPreparing() {
  return {
    record: baseRecord({
      id: "v2-preparing",
      originalFilename: "v2-preparing.docx",
      activeTransferId: "hop-prep",
    }),
    transfers: [
      hop({ id: "hop-prep", status: "preparing", handoffId: "v2-preparing" }),
    ],
  };
}

export function v2RootFailed() {
  return {
    record: baseRecord({
      id: "v2-failed",
      originalFilename: "v2-failed.docx",
      activeTransferId: "hop-fail",
    }),
    transfers: [
      hop({ id: "hop-fail", status: "failed", handoffId: "v2-failed" }),
    ],
  };
}

export function v2RootActive() {
  return {
    record: baseRecord({
      id: "v2-active",
      originalFilename: "v2-active.docx",
      activeTransferId: "hop-active",
      events: [
        {
          id: "evt-created",
          eventType: "created",
          note: null,
          versionNumber: null,
          actorMemberId: MEMBER.creator,
          transferId: "hop-active",
          createdAt: "2026-09-01T01:00:00.000Z",
        },
        {
          id: "evt-finalized",
          eventType: "finalized",
          note: null,
          versionNumber: 1,
          actorMemberId: MEMBER.creator,
          transferId: "hop-active",
          createdAt: "2026-09-01T02:00:00.000Z",
        },
      ],
    }),
    transfers: [
      hop({ id: "hop-active", status: "active", handoffId: "v2-active" }),
    ],
  };
}

export function v2ChildActive() {
  return {
    record: baseRecord({
      id: "v2-child-active",
      originalFilename: "v2-child.docx",
      activeTransferId: "hop-child",
    }),
    transfers: [
      hop({
        id: "hop-root-wait",
        status: "waiting_child",
        handoffId: "v2-child-active",
        fromMemberId: MEMBER.creator,
        toMemberId: MEMBER.prior,
      }),
      hop({
        id: "hop-child",
        status: "active",
        handoffId: "v2-child-active",
        parentTransferId: "hop-root-wait",
        fromMemberId: MEMBER.prior,
        toMemberId: MEMBER.recipient,
        requestedAction: "review",
        instruction: "נא לבדוק את הנספח",
        updatedAt: "2026-09-04T00:00:00.000Z",
      }),
    ],
  };
}

export function v2ChildReturned() {
  return {
    record: baseRecord({
      id: "v2-child-returned",
      originalFilename: "v2-returned.docx",
      activeTransferId: "hop-returned",
    }),
    transfers: [
      hop({
        id: "hop-parent-wait",
        status: "waiting_child",
        handoffId: "v2-child-returned",
        fromMemberId: MEMBER.creator,
        toMemberId: MEMBER.prior,
      }),
      hop({
        id: "hop-returned",
        status: "returned_to_sender",
        handoffId: "v2-child-returned",
        parentTransferId: "hop-parent-wait",
        fromMemberId: MEMBER.prior,
        toMemberId: MEMBER.recipient,
        requestedAction: "update",
        resultAction: "returned_with_reply",
        resultNote: "חסר החתימה",
        updatedAt: "2026-09-05T00:00:00.000Z",
      }),
    ],
  };
}

export function v2Completed() {
  return {
    record: baseRecord({
      id: "v2-completed",
      originalFilename: "v2-completed.docx",
      requestStatus: "completed",
      activeTransferId: null,
      closedAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    }),
    transfers: [
      hop({
        id: "hop-closed-root",
        status: "closed",
        handoffId: "v2-completed",
        updatedAt: "2026-09-06T00:00:00.000Z",
      }),
    ],
  };
}

export function v2Cancelled() {
  return {
    record: baseRecord({
      id: "v2-cancelled",
      originalFilename: "v2-cancelled.docx",
      requestStatus: "cancelled",
      activeTransferId: null,
      cancelledAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    }),
    transfers: [
      hop({
        id: "hop-cancelled-root",
        status: "closed",
        handoffId: "v2-cancelled",
        updatedAt: "2026-09-06T00:00:00.000Z",
      }),
    ],
  };
}

export function v2OpenMissingPointer() {
  return {
    record: baseRecord({
      id: "v2-missing-pointer",
      originalFilename: "v2-missing.docx",
      activeTransferId: null,
    }),
    transfers: [hop({ id: "hop-orphan", status: "active", handoffId: "v2-missing-pointer" })],
  };
}

export function v2ClosedWithLiveHop() {
  return {
    record: baseRecord({
      id: "v2-closed-live",
      originalFilename: "v2-closed-live.docx",
      requestStatus: "completed",
      activeTransferId: null,
    }),
    transfers: [hop({ id: "hop-still-live", status: "active", handoffId: "v2-closed-live" })],
  };
}

export function v2WaitingChildPointer() {
  return {
    record: baseRecord({
      id: "v2-wait-pointer",
      originalFilename: "v2-wait-pointer.docx",
      activeTransferId: "hop-wait",
    }),
    transfers: [hop({ id: "hop-wait", status: "waiting_child", handoffId: "v2-wait-pointer" })],
  };
}

export function v2ParentCycle() {
  return {
    record: baseRecord({
      id: "v2-cycle",
      originalFilename: "v2-cycle.docx",
      activeTransferId: "hop-a",
    }),
    transfers: [
      hop({
        id: "hop-a",
        status: "active",
        handoffId: "v2-cycle",
        parentTransferId: "hop-b",
      }),
      hop({
        id: "hop-b",
        status: "waiting_child",
        handoffId: "v2-cycle",
        parentTransferId: "hop-a",
      }),
    ],
  };
}

export function v2ParentNotWaiting() {
  return {
    record: baseRecord({
      id: "v2-parent-active",
      originalFilename: "v2-parent-active.docx",
      activeTransferId: "hop-child-bad",
    }),
    transfers: [
      hop({
        id: "hop-parent-active",
        status: "active",
        handoffId: "v2-parent-active",
      }),
      hop({
        id: "hop-child-bad",
        status: "active",
        handoffId: "v2-parent-active",
        parentTransferId: "hop-parent-active",
        fromMemberId: MEMBER.prior,
        toMemberId: MEMBER.recipient,
      }),
    ],
  };
}

export function v2WithReminder(at = "2026-09-08T12:00:00.000Z") {
  const base = v2RootActive();
  return {
    record: {
      ...base.record,
      id: "v2-reminder",
      originalFilename: "v2-reminder.docx",
      activeTransferId: "hop-remind",
      events: [
        ...base.record.events.map((event) => ({
          ...event,
          transferId: "hop-remind",
        })),
        {
          id: "evt-reminder",
          eventType: "reminder_sent",
          note: null,
          versionNumber: null,
          actorMemberId: MEMBER.creator,
          transferId: "hop-remind",
          createdAt: at,
        },
      ],
    },
    transfers: [
      hop({
        id: "hop-remind",
        status: "active",
        handoffId: "v2-reminder",
        updatedAt: "2026-09-02T00:00:00.000Z",
      }),
    ],
  };
}
