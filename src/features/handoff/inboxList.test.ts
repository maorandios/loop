import { describe, expect, it } from "vitest";
import {
  applyInboxFilter,
  EMPTY_INBOX_FILTER,
  groupInboxByTime,
  inboxTabCounts,
  sortInboxCards,
} from "./inboxList";
import type { HandoffCardView } from "./view";
import { MEMBER, v2RootActive } from "./view.fixtures";
import { projectHandoffList } from "./view";

function card(partial: Partial<HandoffCardView> & Pick<HandoffCardView, "id">): HandoffCardView {
  return {
    section: "mine",
    filename: "a.bin",
    statusSentence: "נדרש ממך לאשר",
    actionLabel: null,
    instruction: null,
    dueOn: null,
    holderDisplayName: null,
    latestVersionNumber: 1,
    lastActivityAt: "2026-09-06T12:00:00.000Z",
    relevantNote: null,
    source: { kind: "legacy", record: v2RootActive().record },
    ...partial,
  };
}

describe("inbox list projection", () => {
  it("keeps one row per request", () => {
    const first = card({ id: "same", lastActivityAt: "2026-09-06T12:00:00.000Z" });
    const duplicate = card({ id: "same", lastActivityAt: "2026-09-06T08:00:00.000Z" });
    expect(sortInboxCards([first, duplicate], "watching").map((row) => row.id)).toEqual(["same"]);
  });

  it("counts the three inbox tabs from existing sections", () => {
    const { record, transfers } = v2RootActive();
    const projected = projectHandoffList([record], transfers, MEMBER.recipient, () => "מאור");
    expect(inboxTabCounts(projected)).toEqual({
      mine: 1,
      watching: 0,
      done: 0,
    });
  });

  it("sorts לטיפול by due date then activity", () => {
    const later = card({
      id: "b",
      dueOn: "2026-09-20",
      lastActivityAt: "2026-09-06T18:00:00.000Z",
    });
    const sooner = card({
      id: "a",
      dueOn: "2026-09-08",
      lastActivityAt: "2026-09-06T10:00:00.000Z",
    });
    expect(sortInboxCards([later, sooner], "mine").map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("sorts במעקב and הושלמו by latest activity", () => {
    const older = card({ id: "old", lastActivityAt: "2026-09-01T00:00:00.000Z" });
    const newer = card({ id: "new", lastActivityAt: "2026-09-06T00:00:00.000Z" });
    expect(sortInboxCards([older, newer], "watching").map((row) => row.id)).toEqual(["new", "old"]);
    expect(sortInboxCards([older, newer], "done").map((row) => row.id)).toEqual(["new", "old"]);
  });

  it("groups cards by time buckets", () => {
    const now = new Date("2026-09-06T15:00:00");
    const groups = groupInboxByTime(
      [
        card({ id: "t", lastActivityAt: "2026-09-06T10:00:00" }),
        card({ id: "y", lastActivityAt: "2026-09-05T10:00:00" }),
        card({ id: "w", lastActivityAt: "2026-09-03T10:00:00" }),
        card({ id: "e", lastActivityAt: "2026-08-01T10:00:00" }),
      ],
      now,
    );
    expect(groups.map((group) => [group.bucket, group.cards.map((row) => row.id)])).toEqual([
      ["today", ["t"]],
      ["yesterday", ["y"]],
      ["week", ["w"]],
      ["earlier", ["e"]],
    ]);
  });

  it("filters in memory without changing source cards", () => {
    const withDue = card({ id: "due", dueOn: "2026-09-10" });
    const noDue = card({ id: "none", dueOn: null });
    const filtered = applyInboxFilter([withDue, noDue], {
      ...EMPTY_INBOX_FILTER,
      due: "has",
    });
    expect(filtered.map((row) => row.id)).toEqual(["due"]);
  });
});
