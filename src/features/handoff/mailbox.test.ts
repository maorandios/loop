import { describe, expect, it } from "vitest";
import { EMPTY_INBOX_FILTER } from "./inboxList";
import {
  buildFeedEvents,
  classifyMailbox,
  classifyStatus,
  isFeedEventType,
  mailboxCards,
  primaryCounts,
  visibleListItems,
  cardMatchesQuery,
  latestActivityAt,
} from "./mailbox";
import { MEMBER, memberName, v1Completed, v2Completed, v2RootActive, v2RootFailed } from "./view.fixtures";
import { projectHandoffList } from "./view";

function present(memberId: string, records = v2RootActive()) {
  return projectHandoffList([records.record], records.transfers, memberId, memberName);
}

describe("mailbox classification", () => {
  it("puts the recipient in inbox and the sender in outbox exactly once", () => {
    const { record, transfers } = v2RootActive();
    const asRecipient = projectHandoffList([record], transfers, MEMBER.recipient, memberName);
    const asSender = projectHandoffList([record], transfers, MEMBER.creator, memberName);
    expect(mailboxCards(asRecipient, "inbox", MEMBER.recipient).map((card) => card.id)).toEqual([
      record.id,
    ]);
    expect(mailboxCards(asRecipient, "outbox", MEMBER.recipient)).toEqual([]);
    expect(mailboxCards(asSender, "outbox", MEMBER.creator).map((card) => card.id)).toEqual([
      record.id,
    ]);
    expect(mailboxCards(asSender, "inbox", MEMBER.creator)).toEqual([]);
  });

  it("keeps a completed request in the original mailbox", () => {
    const { record, transfers } = v2Completed();
    const asRecipient = projectHandoffList([record], transfers, MEMBER.recipient, memberName);
    const asSender = projectHandoffList([record], transfers, MEMBER.creator, memberName);
    expect(classifyMailbox(asRecipient.cards[0]!, MEMBER.recipient)).toBe("inbox");
    expect(classifyMailbox(asSender.cards[0]!, MEMBER.creator)).toBe("outbox");
    expect(classifyStatus(asRecipient.cards[0]!, MEMBER.recipient)).toBe("completed");
  });
});

describe("status filter mapping", () => {
  it("maps a live approval to action for the recipient and info for the sender", () => {
    const active = v2RootActive();
    const asRecipient = present(MEMBER.recipient, active).cards[0]!;
    const asSender = present(MEMBER.creator, active).cards[0]!;
    expect(classifyStatus(asRecipient, MEMBER.recipient)).toBe("action");
    expect(classifyStatus(asSender, MEMBER.creator)).toBe("info");
  });

  it("maps a rejection that returned and needs a decision to action", () => {
    const active = v2RootActive();
    const rejected = {
      record: active.record,
      transfers: active.transfers.map((hop) => ({
        ...hop,
        status: "returned_to_sender" as const,
        resultAction: "rejected" as const,
      })),
    };
    const card = present(MEMBER.creator, rejected).cards[0]!;
    expect(classifyStatus(card, MEMBER.creator)).toBe("action");
    expect(classifyStatus(card, MEMBER.creator)).not.toBe("completed");
  });

  it("maps completed v2 and legacy return_received to completed", () => {
    const done = present(MEMBER.creator, v2Completed()).cards[0]!;
    expect(classifyStatus(done, MEMBER.creator)).toBe("completed");
    const legacy = projectHandoffList(
      [
        {
          ...v1Completed,
          status: "return_received",
          senderMemberId: MEMBER.creator,
          recipientMemberId: MEMBER.recipient,
        },
      ],
      [],
      MEMBER.creator,
      memberName,
    ).cards[0]!;
    expect(classifyStatus(legacy, MEMBER.creator)).toBe("completed");
  });

  it("maps a failed send to action for the sender", () => {
    const failed = present(MEMBER.creator, v2RootFailed()).cards[0]!;
    expect(classifyStatus(failed, MEMBER.creator)).toBe("action");
  });
});

describe("feed events", () => {
  it("sorts business events newest first and hides technical types", () => {
    const { record, transfers } = v2RootActive();
    const withNoise = {
      ...record,
      events: [
        ...record.events,
        {
          eventType: "uploading",
          note: null,
          versionNumber: null,
          actorMemberId: MEMBER.creator,
          createdAt: "2026-09-06T18:00:00.000Z",
        },
        {
          eventType: "retry",
          note: null,
          versionNumber: null,
          actorMemberId: MEMBER.creator,
          createdAt: "2026-09-06T19:00:00.000Z",
        },
        {
          eventType: "opened",
          note: null,
          versionNumber: 1,
          actorMemberId: MEMBER.recipient,
          createdAt: "2026-09-06T12:00:00.000Z",
        },
        {
          eventType: "reminder_sent",
          note: null,
          versionNumber: null,
          actorMemberId: MEMBER.creator,
          createdAt: "2026-09-05T12:00:00.000Z",
        },
      ],
    };
    const projected = projectHandoffList([withNoise], transfers, MEMBER.recipient, memberName);
    const feed = buildFeedEvents(projected.cards);
    expect(feed.map((item) => item.eventType)).toEqual([
      "opened",
      "reminder_sent",
      "finalized",
      "created",
    ]);
    expect(feed.map((item) => item.eventType)).not.toContain("uploading");
    expect(feed.map((item) => item.eventType)).not.toContain("retry");
    expect(isFeedEventType("reservation")).toBe(false);
    expect(isFeedEventType("tus_chunk")).toBe(false);
  });

  it("lets the same request appear more than once in the feed", () => {
    const projected = present(MEMBER.recipient);
    expect(buildFeedEvents(projected.cards).length).toBeGreaterThan(1);
    expect(new Set(buildFeedEvents(projected.cards).map((item) => item.card.id)).size).toBe(1);
  });
});

describe("primary counts and visible items", () => {
  it("counts unique cards by status and lists that bucket", () => {
    const projected = present(MEMBER.recipient);
    expect(primaryCounts(projected, MEMBER.recipient)).toEqual({
      action: 1,
      info: 0,
      completed: 0,
    });
    expect(
      visibleListItems({
        projected,
        primaryView: "action",
        extraFilter: EMPTY_INBOX_FILTER,
        memberId: MEMBER.recipient,
      }),
    ).toHaveLength(1);
    expect(
      visibleListItems({
        projected,
        primaryView: "completed",
        extraFilter: EMPTY_INBOX_FILTER,
        memberId: MEMBER.recipient,
      }),
    ).toHaveLength(0);
  });

  it("matches trimmed case-insensitive filename, person, instruction, and status", () => {
    expect(cardMatchesQuery(["v2-active.docx", "נא לאשר", "מאור"], "  V2-ACTIVE  ")).toBe(true);
    expect(cardMatchesQuery(["נא לאשר"], "לאשר")).toBe(true);
    expect(cardMatchesQuery(["מאור"], "מאור")).toBe(true);
    expect(cardMatchesQuery(["נדרש ממך לאשר"], "לאשר")).toBe(true);
    expect(cardMatchesQuery(["v2-active.docx"], "completed")).toBe(false);
    expect(cardMatchesQuery(["דוח.docx"], "   ")).toBe(true);
  });

  it("puts a completed request on the completed tab", () => {
    const { record, transfers } = v2Completed();
    const projected = projectHandoffList([record], transfers, MEMBER.recipient, memberName);
    expect(
      visibleListItems({
        projected,
        primaryView: "completed",
        extraFilter: EMPTY_INBOX_FILTER,
        memberId: MEMBER.recipient,
      }).map((item) => item.card.id),
    ).toEqual([record.id]);
    expect(
      visibleListItems({
        projected,
        primaryView: "action",
        extraFilter: EMPTY_INBOX_FILTER,
        memberId: MEMBER.recipient,
      }),
    ).toHaveLength(0);
  });

  it("returns the newest lastActivityAt in a list", () => {
    const projected = present(MEMBER.recipient);
    const items = visibleListItems({
      projected,
      primaryView: "action",
      extraFilter: EMPTY_INBOX_FILTER,
      memberId: MEMBER.recipient,
    });
    expect(latestActivityAt([])).toBeNull();
    expect(latestActivityAt(items)).toBe(items[0]?.card.lastActivityAt);
  });
});
