import type { WorkspaceMember } from "../workspace/types";
import type {
  HandoffEvent,
  HandoffRecord,
  HandoffVersion,
  RequestStatus,
  RequestedAction,
  ResultAction,
  TransferRecord,
  TransferStatus,
} from "./types";

export const DESIGN_CARDS_STORAGE_KEY = "filerelay.designCards";
export const DESIGN_PARTNER_ID = "design-partner";

const HASH = "ab".repeat(32);
const VERSION: HandoffVersion = {
  versionNumber: 1,
  storagePath: "design/v1",
  fileSize: 2048,
  blake3: HASH,
};

export function shouldUseDesignCards(): boolean {
  if (!import.meta.env.DEV || import.meta.env.MODE === "test") {
    return false;
  }
  try {
    return localStorage.getItem(DESIGN_CARDS_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function designPartnerMember(
  workspaceId: string,
  displayName = "דנה",
): WorkspaceMember {
  return {
    id: DESIGN_PARTNER_ID,
    workspaceId,
    userId: "design-partner-user",
    deviceId: "design-partner-device",
    displayName,
    email: "dana@drops.app",
    joinedAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-06T12:00:00.000Z",
  };
}

export function designEmailFor(member: WorkspaceMember, meId: string): string {
  if (member.email?.trim()) {
    return member.email.trim();
  }
  if (member.id === meId) {
    return "maor@drops.app";
  }
  if (member.id === DESIGN_PARTNER_ID || member.displayName === "דנה") {
    return "dana@drops.app";
  }
  return "user@drops.app";
}

export function withDesignEmails(
  members: WorkspaceMember[],
  meId: string,
): WorkspaceMember[] {
  return members.map((member) => ({
    ...member,
    email: designEmailFor(member, meId),
  }));
}

export function mergeDesignMembers(
  workspaceId: string,
  meId: string,
  members: WorkspaceMember[],
): WorkspaceMember[] {
  if (members.some((member) => member.id !== meId)) {
    return members;
  }
  return [...members, designPartnerMember(workspaceId)];
}

export type DesignInbox = {
  handoffs: HandoffRecord[];
  transfers: TransferRecord[];
};

type CardSpec = {
  id: string;
  filename: string;
  instruction: string;
  dueOn: string | null;
  action: RequestedAction;
  hopStatus: TransferStatus;
  requestStatus?: RequestStatus;
  resultAction?: ResultAction | null;
  resultNote?: string | null;
  fromMe: boolean;
  withFile: boolean;
  hoursAgo: number;
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function dayOffset(days: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function designEvents(
  spec: CardSpec,
  fromMemberId: string,
  toMemberId: string,
  createdAt: string,
  at: string,
): HandoffEvent[] {
  const events: HandoffEvent[] = [
    {
      eventType: "created",
      note: null,
      versionNumber: null,
      actorMemberId: fromMemberId,
      createdAt,
    },
    {
      eventType: "finalized",
      note: null,
      versionNumber: spec.withFile ? 1 : null,
      actorMemberId: fromMemberId,
      createdAt: hoursAgoIso(spec.hoursAgo + 4),
    },
  ];
  if (spec.withFile && spec.hopStatus === "active") {
    events.push({
      eventType: "opened",
      note: null,
      versionNumber: 1,
      actorMemberId: toMemberId,
      createdAt: hoursAgoIso(spec.hoursAgo + 1),
    });
  }
  if (spec.resultAction === "rejected") {
    events.push({
      eventType: "rejected",
      note: spec.resultNote ?? null,
      versionNumber: null,
      actorMemberId: toMemberId,
      createdAt: at,
    });
  } else if (spec.resultAction === "returned_with_file") {
    events.push({
      eventType: "returned_with_file",
      note: null,
      versionNumber: 2,
      actorMemberId: toMemberId,
      createdAt: at,
    });
  } else if (spec.resultAction === "returned_with_reply") {
    events.push({
      eventType: "returned_with_reply",
      note: spec.resultNote ?? null,
      versionNumber: null,
      actorMemberId: toMemberId,
      createdAt: at,
    });
  } else if (spec.resultAction === "review_completed") {
    events.push({
      eventType: "review_completed",
      note: spec.resultNote ?? null,
      versionNumber: null,
      actorMemberId: toMemberId,
      createdAt: at,
    });
  } else if (spec.resultAction === "approved") {
    events.push({
      eventType: "approved",
      note: null,
      versionNumber: 1,
      actorMemberId: toMemberId,
      createdAt: at,
    });
  }
  if (spec.requestStatus === "completed") {
    events.push({
      eventType: "completed",
      note: null,
      versionNumber: spec.withFile ? 1 : null,
      actorMemberId: toMemberId,
      createdAt: at,
    });
  }
  if (spec.requestStatus === "cancelled") {
    events.push({
      eventType: "cancelled",
      note: null,
      versionNumber: null,
      actorMemberId: fromMemberId,
      createdAt: at,
    });
  }
  if (spec.hopStatus === "failed") {
    events.push({
      eventType: "failed",
      note: null,
      versionNumber: null,
      actorMemberId: fromMemberId,
      createdAt: at,
    });
  }
  return events;
}

function makePair(
  spec: CardSpec,
  workspaceId: string,
  meId: string,
  partnerId: string,
): { record: HandoffRecord; hop: TransferRecord } {
  const fromMemberId = spec.fromMe ? meId : partnerId;
  const toMemberId = spec.fromMe ? partnerId : meId;
  const at = hoursAgoIso(spec.hoursAgo);
  const requestStatus = spec.requestStatus ?? "open";
  const settled = requestStatus !== "open";
  const versions = spec.withFile
    ? spec.resultAction === "returned_with_file"
      ? [
          { ...VERSION, fileName: spec.filename },
          {
            ...VERSION,
            versionNumber: 2,
            storagePath: "design/v2",
            fileName: spec.filename,
          },
        ]
      : [{ ...VERSION, fileName: spec.filename }]
    : [];
  const record: HandoffRecord = {
    id: spec.id,
    workspaceId,
    senderMemberId: fromMemberId,
    recipientMemberId: toMemberId,
    originalFilename: spec.filename,
    instruction: spec.instruction,
    dueOn: spec.dueOn,
    status: null,
    createdAt: hoursAgoIso(spec.hoursAgo + 6),
    updatedAt: at,
    fileSize: spec.withFile ? 2048 : null,
    blake3: spec.withFile ? HASH : null,
    storagePath: spec.withFile ? "design/v1" : null,
    returnFileSize: null,
    returnBlake3: null,
    returnStoragePath: null,
    versions,
    events: designEvents(spec, fromMemberId, toMemberId, hoursAgoIso(spec.hoursAgo + 6), at),
    flowVersion: 2,
    requestStatus,
    activeTransferId: settled ? null : `${spec.id}-hop`,
    closedAt: requestStatus === "completed" ? at : null,
    cancelledAt: requestStatus === "cancelled" ? at : null,
  };
  const hop: TransferRecord = {
    id: `${spec.id}-hop`,
    handoffId: spec.id,
    parentTransferId: null,
    fromMemberId,
    toMemberId,
    requestedAction: spec.action,
    instruction: spec.instruction,
    dueOn: spec.dueOn,
    status: spec.hopStatus,
    resultAction: spec.resultAction ?? null,
    resultNote: spec.resultNote ?? null,
    resultVersionNumber: spec.resultAction === "returned_with_file" ? 2 : null,
    updatedAt: at,
  };
  return { record, hop };
}

export function buildDesignInbox(input: {
  workspaceId: string;
  meId: string;
  partnerId: string;
}): DesignInbox {
  const specs: CardSpec[] = [
    {
      id: "design-mine-approval",
      filename: "דוח רבעוני.docx",
      instruction: "נא לאשר את הסכומים מול הדוח הרבעוני",
      dueOn: dayOffset(1),
      action: "approval",
      hopStatus: "active",
      fromMe: false,
      withFile: true,
      hoursAgo: 2,
    },
    {
      id: "design-mine-review",
      filename: "נספח משפטי.pdf",
      instruction: "נא לבדוק את הסעיפים החדשים",
      dueOn: dayOffset(3),
      action: "review",
      hopStatus: "active",
      fromMe: false,
      withFile: true,
      hoursAgo: 5,
    },
    {
      id: "design-mine-update",
      filename: "תחזית מכירות.xlsx",
      instruction: "עדכן את עמודת ספטמבר",
      dueOn: dayOffset(0),
      action: "update",
      hopStatus: "active",
      fromMe: false,
      withFile: true,
      hoursAgo: 8,
    },
    {
      id: "design-mine-file-request",
      filename: "unknown.txt",
      instruction: "דוח הכספים לשנת 2021",
      dueOn: dayOffset(4),
      action: "file_request",
      hopStatus: "active",
      fromMe: false,
      withFile: false,
      hoursAgo: 10,
    },
    {
      id: "design-mine-overdue",
      filename: "חוזה שכירות.pdf",
      instruction: "חובה לאשר לפני סוף השבוע",
      dueOn: dayOffset(-5),
      action: "approval",
      hopStatus: "active",
      fromMe: false,
      withFile: true,
      hoursAgo: 26,
    },
    {
      id: "design-mine-long-name",
      filename: "דוח_Q3_Financials_סופי_v12_mixed-HE-EN.docx",
      instruction: "בדוק שמות גיליונות בעברית ובאנגלית",
      dueOn: dayOffset(8),
      action: "review",
      hopStatus: "active",
      fromMe: false,
      withFile: true,
      hoursAgo: 30,
    },
    {
      id: "design-watch-approval",
      filename: "מצגת דירקטוריון.pptx",
      instruction: "ממתין לאישור שלך לגרסה האחרונה",
      dueOn: dayOffset(2),
      action: "approval",
      hopStatus: "active",
      fromMe: true,
      withFile: true,
      hoursAgo: 3,
    },
    {
      id: "design-watch-file-request",
      filename: "unknown.txt",
      instruction: "צילום תעודת זהות מעודכן",
      dueOn: dayOffset(6),
      action: "file_request",
      hopStatus: "active",
      fromMe: true,
      withFile: false,
      hoursAgo: 12,
    },
    {
      id: "design-watch-update",
      filename: "רשימת מלאי.csv",
      instruction: "עדכן כמויות אחרי הספירה",
      dueOn: dayOffset(5),
      action: "update",
      hopStatus: "active",
      fromMe: true,
      withFile: true,
      hoursAgo: 18,
    },
    {
      id: "design-returned-file",
      filename: "טיוטת מכתב.docx",
      instruction: "החזרתי גרסה מתוקנת",
      dueOn: dayOffset(2),
      action: "update",
      hopStatus: "returned_to_sender",
      resultAction: "returned_with_file",
      fromMe: true,
      withFile: true,
      hoursAgo: 4,
    },
    {
      id: "design-returned-reply",
      filename: "שאלון לקוח.pdf",
      instruction: "חסרה חתימה בעמוד האחרון",
      dueOn: null,
      action: "review",
      hopStatus: "returned_to_sender",
      resultAction: "returned_with_reply",
      resultNote: "חסרה חתימה בעמוד האחרון",
      fromMe: true,
      withFile: true,
      hoursAgo: 7,
    },
    {
      id: "design-returned-review",
      filename: "סיכום ישיבה.docx",
      instruction: "הבדיקה הסתיימה בלי שינויים",
      dueOn: dayOffset(1),
      action: "review",
      hopStatus: "returned_to_sender",
      resultAction: "review_completed",
      fromMe: true,
      withFile: true,
      hoursAgo: 9,
    },
    {
      id: "design-rejected",
      filename: "הצעת מחיר.pdf",
      instruction: "המחירים לא תואמים",
      dueOn: dayOffset(-1),
      action: "approval",
      hopStatus: "returned_to_sender",
      resultAction: "rejected",
      resultNote: "המחירים לא תואמים להצעה הקודמת",
      fromMe: true,
      withFile: true,
      hoursAgo: 14,
    },
    {
      id: "design-done-approval",
      filename: "תקציב 2026.xlsx",
      instruction: "אושר ללא הערות",
      dueOn: dayOffset(-2),
      action: "approval",
      hopStatus: "closed",
      requestStatus: "completed",
      fromMe: true,
      withFile: true,
      hoursAgo: 40,
    },
    {
      id: "design-done-other",
      filename: "פרוטוקול ועדה.docx",
      instruction: "הבקשה הושלמה אחרי הבדיקה",
      dueOn: null,
      action: "review",
      hopStatus: "closed",
      requestStatus: "completed",
      fromMe: true,
      withFile: true,
      hoursAgo: 72,
    },
    {
      id: "design-cancelled",
      filename: "טיוטה ישנה.docx",
      instruction: "כבר לא רלוונטי",
      dueOn: null,
      action: "update",
      hopStatus: "closed",
      requestStatus: "cancelled",
      fromMe: true,
      withFile: true,
      hoursAgo: 96,
    },
    {
      id: "design-failed",
      filename: "ארכיון גדול.zip",
      instruction: "השליחה נקטעה באמצע",
      dueOn: dayOffset(1),
      action: "approval",
      hopStatus: "failed",
      fromMe: true,
      withFile: true,
      hoursAgo: 1,
    },
  ];

  const handoffs: HandoffRecord[] = [];
  const transfers: TransferRecord[] = [];
  for (const spec of specs) {
    const pair = makePair(spec, input.workspaceId, input.meId, input.partnerId);
    handoffs.push(pair.record);
    transfers.push(pair.hop);
  }
  return { handoffs, transfers };
}
