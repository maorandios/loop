import type { HandoffStatus } from "../../copy/he";
import type { HandoffRecord } from "./types";

export type HandoffView = "waiting_for_me" | "waiting_for_others" | "done";
export type HandoffRole = "sender" | "recipient";

export function handoffRole(
  row: HandoffRecord,
  memberId: string | null | undefined,
): HandoffRole | null {
  if (!memberId) {
    return null;
  }
  if (row.senderMemberId === memberId) {
    return "sender";
  }
  if (row.recipientMemberId === memberId) {
    return "recipient";
  }
  return null;
}

export function classifyHandoffView(
  status: HandoffStatus,
  role: HandoffRole,
): HandoffView | null {
  if (status === "failed") {
    return role === "sender" ? "waiting_for_me" : null;
  }
  if (status === "uploading") {
    return role === "sender" ? "waiting_for_me" : null;
  }
  if (status === "completed" || status === "return_received") {
    return "done";
  }
  if (status === "returned") {
    return role === "sender" ? "waiting_for_me" : "waiting_for_others";
  }
  if (
    status === "sent" ||
    status === "received" ||
    status === "opened" ||
    status === "modified" ||
    status === "returning" ||
    status === "revision_requested" ||
    status === "sending"
  ) {
    return role === "recipient" ? "waiting_for_me" : "waiting_for_others";
  }
  return null;
}

export function activityTime(row: HandoffRecord): number {
  const updated = Date.parse(row.updatedAt);
  if (!Number.isNaN(updated)) {
    return updated;
  }
  const created = Date.parse(row.createdAt);
  return Number.isNaN(created) ? 0 : created;
}

export function sortByRecentActivity(rows: HandoffRecord[]): HandoffRecord[] {
  return [...rows].sort((left, right) => {
    const delta = activityTime(right) - activityTime(left);
    if (delta !== 0) {
      return delta;
    }
    return right.id.localeCompare(left.id);
  });
}

export function groupHandoffsByView(
  rows: HandoffRecord[],
  memberId: string | null | undefined,
): Record<HandoffView, HandoffRecord[]> {
  const grouped: Record<HandoffView, HandoffRecord[]> = {
    waiting_for_me: [],
    waiting_for_others: [],
    done: [],
  };
  for (const row of rows) {
    if ((row.flowVersion ?? 1) === 2 || !row.status) {
      continue;
    }
    const role = handoffRole(row, memberId);
    if (!role) {
      continue;
    }
    const view = classifyHandoffView(row.status, role);
    if (!view) {
      continue;
    }
    grouped[view].push(row);
  }
  return {
    waiting_for_me: sortByRecentActivity(grouped.waiting_for_me),
    waiting_for_others: sortByRecentActivity(grouped.waiting_for_others),
    done: sortByRecentActivity(grouped.done),
  };
}

export function viewCounts(
  rows: HandoffRecord[],
  memberId: string | null | undefined,
): Record<HandoffView, number> {
  const grouped = groupHandoffsByView(rows, memberId);
  return {
    waiting_for_me: grouped.waiting_for_me.length,
    waiting_for_others: grouped.waiting_for_others.length,
    done: grouped.done.length,
  };
}
