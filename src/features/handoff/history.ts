import { he } from "../../copy/he";
import type { HandoffEvent, HandoffRecord } from "./types";

const VISIBLE_EVENTS = new Set([
  "finalized",
  "sent",
  "opened",
  "modified",
  "returned",
  "revision_requested",
  "completed",
]);

export type HistoryLine = {
  eventType: string;
  title: string;
  detail: string | null;
  actorMemberId: string | null;
  createdAt: string;
  versionNumber: number | null;
};

export function historyTitle(eventType: string, versionNumber: number | null): string {
  switch (eventType) {
    case "finalized":
    case "sent":
      return he.historySent;
    case "opened":
      return he.historyOpened;
    case "modified":
      return he.historyModified;
    case "returned":
      return versionNumber
        ? he.historyReturnedVersion.replace("{version}", String(versionNumber))
        : he.historyReturned;
    case "revision_requested":
      return he.historyRevisionRequested;
    case "completed":
      return he.historyCompleted;
    default:
      return "";
  }
}

export function visibleHistory(
  row: HandoffRecord,
): HistoryLine[] {
  const events = [...row.events].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
  const lines: HistoryLine[] = [];
  for (const event of events) {
    if (!VISIBLE_EVENTS.has(event.eventType)) {
      continue;
    }
    const title = historyTitle(event.eventType, event.versionNumber);
    if (!title) {
      continue;
    }
    let detail: string | null = null;
    if (event.eventType === "finalized" || event.eventType === "sent") {
      detail = row.instruction?.trim() || null;
    } else if (event.eventType === "revision_requested") {
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
  return VISIBLE_EVENTS.has(event.eventType);
}
