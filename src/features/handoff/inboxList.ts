import { activityBucket, type ActivityBucket } from "../../lib/dates";
import { cardRequestedAction } from "./actions";
import type { HandoffCardView, ProjectedHandoffList } from "./view";

export type InboxTab = "mine" | "watching" | "done";

export type InboxExtraFilter = {
  memberId: string | null;
  kind: "any" | "with_file" | "file_request";
  action: "any" | "approval" | "review" | "update" | "file_request";
  due: "any" | "has" | "none";
};

export const EMPTY_INBOX_FILTER: InboxExtraFilter = {
  memberId: null,
  kind: "any",
  action: "any",
  due: "any",
};

export type InboxTimeGroup = {
  bucket: ActivityBucket;
  cards: HandoffCardView[];
};

export function isInboxFilterActive(filter: InboxExtraFilter): boolean {
  return (
    filter.memberId !== null ||
    filter.kind !== "any" ||
    filter.action !== "any" ||
    filter.due !== "any"
  );
}

export function inboxTabCounts(
  projected: ProjectedHandoffList,
): Record<InboxTab, number> {
  return {
    mine: projected.counts.mine,
    watching: projected.counts.watching,
    done: projected.counts.done,
  };
}

function uniqueById(cards: HandoffCardView[]): HandoffCardView[] {
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

function compareActivity(left: HandoffCardView, right: HandoffCardView): number {
  const delta = Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt);
  if (delta !== 0) {
    return delta;
  }
  return right.id.localeCompare(left.id);
}

function dueSortValue(dueOn: string | null): number {
  if (!dueOn) {
    return Number.POSITIVE_INFINITY;
  }
  const ms = Date.parse(`${dueOn}T00:00:00`);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

export function sortInboxCards(cards: HandoffCardView[], tab: InboxTab): HandoffCardView[] {
  const copy = uniqueById(cards);
  if (tab === "mine") {
    copy.sort((left, right) => {
      const dueDelta = dueSortValue(left.dueOn) - dueSortValue(right.dueOn);
      if (dueDelta !== 0) {
        return dueDelta;
      }
      return compareActivity(left, right);
    });
    return copy;
  }
  copy.sort(compareActivity);
  return copy;
}

export function cardsForTab(
  projected: ProjectedHandoffList,
  tab: InboxTab,
): HandoffCardView[] {
  return projected.grouped[tab];
}

function cardMemberIds(card: HandoffCardView): string[] {
  const record = card.source.record;
  const ids = [record.senderMemberId, record.recipientMemberId];
  if (card.source.kind === "transfer") {
    const hop = card.source.activeHop ?? card.source.latestTransfer;
    ids.push(hop.fromMemberId, hop.toMemberId);
    if (card.source.holderMemberId) {
      ids.push(card.source.holderMemberId);
    }
  }
  return ids;
}

function isFileRequestCard(card: HandoffCardView): boolean {
  return cardRequestedAction(card) === "file_request";
}

export function applyInboxFilter(
  cards: HandoffCardView[],
  filter: InboxExtraFilter,
): HandoffCardView[] {
  return cards.filter((card) => {
    if (filter.memberId && !cardMemberIds(card).includes(filter.memberId)) {
      return false;
    }
    if (filter.kind === "file_request" && !isFileRequestCard(card)) {
      return false;
    }
    if (filter.kind === "with_file" && isFileRequestCard(card) && !card.latestVersionNumber) {
      return false;
    }
    if (filter.action !== "any" && cardRequestedAction(card) !== filter.action) {
      return false;
    }
    if (filter.due === "has" && !card.dueOn) {
      return false;
    }
    if (filter.due === "none" && card.dueOn) {
      return false;
    }
    return true;
  });
}

export function groupInboxByTime(
  cards: HandoffCardView[],
  now = new Date(),
): InboxTimeGroup[] {
  const buckets: Record<ActivityBucket, HandoffCardView[]> = {
    today: [],
    yesterday: [],
    week: [],
    earlier: [],
  };
  for (const card of cards) {
    buckets[activityBucket(new Date(card.lastActivityAt), now)].push(card);
  }
  return (["today", "yesterday", "week", "earlier"] as const)
    .filter((bucket) => buckets[bucket].length > 0)
    .map((bucket) => ({ bucket, cards: buckets[bucket] }));
}

export function visibleInboxCards(
  projected: ProjectedHandoffList,
  tab: InboxTab,
  filter: InboxExtraFilter,
): HandoffCardView[] {
  return sortInboxCards(applyInboxFilter(cardsForTab(projected, tab), filter), tab);
}
