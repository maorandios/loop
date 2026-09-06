import { he } from "../../copy/he";
import type { HandoffEvent, HandoffRecord, RequestedAction } from "./types";

const VISIBLE_EVENTS = new Set([
  "created",
  "finalized",
  "sent",
  "failed",
  "opened",
  "modified",
  "returned",
  "approved",
  "review_completed",
  "returned_with_file",
  "returned_with_reply",
  "rejected",
  "revision_requested",
  "completed",
  "cancelled",
]);

const HIDDEN_EVENTS = new Set([
  "reminder_sent",
  "returning",
  "received",
  "uploading",
  "retry",
  "reservation",
]);

export type HistoryContext = {
  requestedAction?: RequestedAction | null;
};

export type HistoryLine = {
  eventType: string;
  title: string;
  detail: string | null;
  actorMemberId: string | null;
  createdAt: string;
  versionNumber: number | null;
};

export function historyTitle(
  eventType: string,
  versionNumber: number | null,
  row: HandoffRecord,
  context: HistoryContext = {},
): string {
  const action = context.requestedAction;
  const isV2 = (row.flowVersion ?? 1) === 2;
  const isFileRequest = action === "file_request";

  switch (eventType) {
    case "created":
      if (isFileRequest) {
        return he.historyFileRequestSent;
      }
      return isV2 ? he.historyRequestSent : he.historyCreated;
    case "finalized":
    case "sent":
      return isV2 ? he.historyRequestSent : he.historySent;
    case "failed":
      return he.sendIncomplete;
    case "opened":
      return he.historyOpened;
    case "modified":
      return he.historyModified;
    case "returned":
      return versionNumber
        ? he.historyReturnedVersion.replace("{version}", String(versionNumber))
        : he.historyReturned;
    case "approved":
      return versionNumber ? he.historyApprovedWithChanges : he.historyApproved;
    case "review_completed":
      return he.historyReviewFinished;
    case "returned_with_file":
      return isFileRequest ? he.historyFileAttached : he.historyUpdatedFileReturned;
    case "returned_with_reply":
      return he.historyReturnedWithReply;
    case "rejected":
      return isFileRequest ? he.historyCouldNotProvide : he.historyRejected;
    case "revision_requested":
      return he.historyRevisionRequested;
    case "completed":
      return isV2 ? he.historyRequestCompleted : he.historyCompleted;
    case "cancelled":
      return he.historyRequestCancelled;
    default:
      return "";
  }
}

export function visibleHistory(
  row: HandoffRecord,
  context: HistoryContext = {},
): HistoryLine[] {
  const events = [...row.events].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
  const lines: HistoryLine[] = [];
  for (const event of events) {
    if (HIDDEN_EVENTS.has(event.eventType) || !VISIBLE_EVENTS.has(event.eventType)) {
      continue;
    }
    const title = historyTitle(event.eventType, event.versionNumber, row, context);
    if (!title) {
      continue;
    }
    let detail: string | null = null;
    if (
      event.eventType === "finalized" ||
      event.eventType === "sent" ||
      event.eventType === "created"
    ) {
      detail = row.instruction?.trim() || null;
    } else if (
      event.eventType === "revision_requested" ||
      event.eventType === "rejected" ||
      event.eventType === "returned_with_reply"
    ) {
      detail = event.note?.trim() || null;
    }
    lines.push({
      eventType: event.eventType,
      title,
      detail,
      actorMemberId: event.actorMemberId,
      createdAt: event.createdAt,
      versionNumber: event.versionNumber,
    });
  }
  return lines;
}

export function isVisibleHistoryEvent(event: HandoffEvent): boolean {
  return VISIBLE_EVENTS.has(event.eventType) && !HIDDEN_EVENTS.has(event.eventType);
}
