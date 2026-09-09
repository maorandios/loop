import { handoffRole } from "./buckets";
import {
  recipientPrimaryAction,
  senderReturnActions,
} from "./actions";
import { applyInboxFilter, type InboxExtraFilter } from "./inboxList";
import type { LocalWorkState } from "./types";
import type { HandoffCardView, ProjectedHandoffList } from "./view";

export type PrimaryView = "action" | "info" | "completed";
export type StatusFilter = PrimaryView;
export type Mailbox = "inbox" | "outbox";

export const PRIMARY_VIEWS: PrimaryView[] = ["action", "info", "completed"];

const FEED_EVENT_TYPES = new Set([
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
  "reminder_sent",
  "received",
]);

const HIDDEN_FEED_EVENT_TYPES = new Set([
  "uploading",
  "retry",
  "reservation",
  "returning",
  "tus_chunk",
  "resume",
  "reconciliation",
  "watcher",
  "sync",
]);

export type FeedItem = {
  id: string;
  eventType: string;
  createdAt: string;
  card: HandoffCardView;
};

export type ListItem = {
  key: string;
  card: HandoffCardView;
};

function compareStamp(left: string, right: string, leftId: string, rightId: string): number {
  const delta = Date.parse(right) - Date.parse(left);
  if (delta !== 0) {
    return delta;
  }
  return rightId.localeCompare(leftId);
}

function uniqueCards(cards: HandoffCardView[]): HandoffCardView[] {
  const seen = new Set<string>();
  const unique: HandoffCardView[] = [];
  for (const card of cards) {
    if (seen.has(card.id)) {
      continue;
    }
    seen.add(card.id);
    unique.push(card);
  }
  return unique;
}

export function isFeedEventType(eventType: string): boolean {
  return FEED_EVENT_TYPES.has(eventType) && !HIDDEN_FEED_EVENT_TYPES.has(eventType);
}

export function classifyMailbox(
  card: HandoffCardView,
  memberId: string | null | undefined,
): Mailbox | null {
  if (!memberId) {
    return null;
  }
  const record = card.source.record;
  if (record.senderMemberId === memberId) {
    return "outbox";
  }
  if (record.recipientMemberId === memberId) {
    return "inbox";
  }
  if (card.source.kind === "transfer") {
    const hop = card.source.activeHop ?? card.source.latestTransfer;
    if (hop.toMemberId === memberId) {
      return "inbox";
    }
    if (hop.fromMemberId === memberId) {
      return "outbox";
    }
    if (card.source.pathMemberIds.includes(memberId)) {
      return "inbox";
    }
  }
  const role = handoffRole(record, memberId);
  if (role === "sender") {
    return "outbox";
  }
  if (role === "recipient") {
    return "inbox";
  }
  return null;
}

function needsLocalAction(localWork: LocalWorkState): boolean {
  return localWork === "retry" || localWork === "offline" || localWork === "waiting_reselect";
}

export function itemIsCompleted(card: HandoffCardView): boolean {
  if (card.source.kind === "transfer") {
    return card.source.requestStatus === "completed" || card.source.requestStatus === "cancelled";
  }
  const status = card.source.record.status;
  return status === "completed" || status === "return_received";
}

export function itemNeedsAction(
  card: HandoffCardView,
  memberId: string | null | undefined,
  localWork: LocalWorkState = "idle",
): boolean {
  if (needsLocalAction(localWork)) {
    return true;
  }
  if (card.source.kind === "transfer") {
    if (!memberId) {
      return false;
    }
    if (recipientPrimaryAction(card.source, memberId)) {
      return true;
    }
    if (senderReturnActions(card.source, memberId).accept) {
      return true;
    }
    const hop = card.source.activeHop;
    if (
      hop &&
      (hop.status === "preparing" || hop.status === "failed") &&
      hop.fromMemberId === memberId
    ) {
      return true;
    }
    return false;
  }
  return card.section === "mine";
}

export function classifyStatus(
  card: HandoffCardView,
  memberId: string | null | undefined,
  localWork: LocalWorkState = "idle",
): StatusFilter {
  if (itemNeedsAction(card, memberId, localWork)) {
    return "action";
  }
  if (itemIsCompleted(card)) {
    return "completed";
  }
  return "info";
}

export function mailboxCards(
  projected: ProjectedHandoffList,
  mailbox: Mailbox,
  memberId: string | null | undefined,
): HandoffCardView[] {
  return uniqueCards(
    projected.cards.filter((card) => classifyMailbox(card, memberId) === mailbox),
  ).sort((left, right) =>
    compareStamp(left.lastActivityAt, right.lastActivityAt, left.id, right.id),
  );
}

export function buildFeedEvents(cards: HandoffCardView[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const card of uniqueCards(cards)) {
    const events = [...card.source.record.events].sort((left, right) =>
      compareStamp(right.createdAt, left.createdAt, right.eventType, left.eventType),
    );
    for (const event of events) {
      if (!isFeedEventType(event.eventType)) {
        continue;
      }
      items.push({
        id: `${card.id}:${event.id ?? event.eventType}:${event.createdAt}`,
        eventType: event.eventType,
        createdAt: event.createdAt,
        card,
      });
    }
  }
  items.sort((left, right) => compareStamp(left.createdAt, right.createdAt, left.id, right.id));
  return items;
}

export function primaryCounts(
  projected: ProjectedHandoffList,
  memberId: string | null | undefined,
  localWorkOf?: (handoffId: string) => LocalWorkState,
): Record<PrimaryView, number> {
  const workOf = localWorkOf ?? (() => "idle");
  const counts: Record<PrimaryView, number> = { action: 0, info: 0, completed: 0 };
  for (const card of uniqueCards(projected.cards)) {
    counts[classifyStatus(card, memberId, workOf(card.id))] += 1;
  }
  return counts;
}

export function visibleListItems(input: {
  projected: ProjectedHandoffList;
  primaryView: PrimaryView;
  extraFilter: InboxExtraFilter;
  memberId: string | null | undefined;
  localWorkOf?: (handoffId: string) => LocalWorkState;
}): ListItem[] {
  const localWorkOf = input.localWorkOf ?? (() => "idle");
  return applyInboxFilter(uniqueCards(input.projected.cards), input.extraFilter)
    .filter(
      (card) => classifyStatus(card, input.memberId, localWorkOf(card.id)) === input.primaryView,
    )
    .sort((left, right) =>
      compareStamp(left.lastActivityAt, right.lastActivityAt, left.id, right.id),
    )
    .map((card) => ({ key: card.id, card }));
}

export function latestActivityAt(items: ListItem[]): string | null {
  let latest: string | null = null;
  for (const item of items) {
    if (!latest || item.card.lastActivityAt > latest) {
      latest = item.card.lastActivityAt;
    }
  }
  return latest;
}

export function cardMatchesQuery(
  fields: Array<string | null | undefined>,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    return true;
  }
  return fields.some((field) => (field ?? "").toLocaleLowerCase().includes(needle));
}
