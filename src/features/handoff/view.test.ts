import { describe, expect, it } from "vitest";
import { he } from "../../copy/he";
import { visibleHistory } from "./history";
import {
  HANDOFF_VIEW_INCONSISTENT,
  classifyTransferSection,
  holderMemberIdFromHop,
  lastActivityAtForV2,
  projectHandoffList,
  transferStatusSentence,
  validateTransferStack,
} from "./view";
import {
  MEMBER,
  memberName,
  v1Active,
  v1Completed,
  v1Returned,
  v2Cancelled,
  v2ChildActive,
  v2ChildReturned,
  v2ClosedWithLiveHop,
  v2Completed,
  v2OpenMissingPointer,
  v2ParentCycle,
  v2ParentNotWaiting,
  v2RootActive,
  v2RootFailed,
  v2RootPreparing,
  v2WaitingChildPointer,
  v2WithReminder,
} from "./view.fixtures";

const GENDERED = /החזיר|החזירה|ביקש|ביקשה/;

function project(
  records: Parameters<typeof projectHandoffList>[0],
  transfers: Parameters<typeof projectHandoffList>[1],
  memberId: string,
  options?: { v2LoadFailed?: boolean },
) {
  return projectHandoffList(records, transfers, memberId, memberName, options);
}

describe("transfer stack validation", () => {
  it("accepts a root active hop", () => {
    const { record, transfers } = v2RootActive();
    const view = validateTransferStack(record, transfers);
    expect(view).not.toBe(HANDOFF_VIEW_INCONSISTENT);
    if (view === HANDOFF_VIEW_INCONSISTENT) {
      return;
    }
    expect(view.activeHop?.id).toBe("hop-active");
    expect(view.rootHop.id).toBe("hop-active");
    expect(view.parentHop).toBeNull();
    expect(holderMemberIdFromHop(view.activeHop!)).toBe(MEMBER.recipient);
  });

  it("accepts a child active hop with waiting_child parent", () => {
    const { record, transfers } = v2ChildActive();
    const view = validateTransferStack(record, transfers);
    expect(view).not.toBe(HANDOFF_VIEW_INCONSISTENT);
    if (view === HANDOFF_VIEW_INCONSISTENT) {
      return;
    }
    expect(view.activeHop?.id).toBe("hop-child");
    expect(view.parentHop?.status).toBe("waiting_child");
    expect(view.rootHop.id).toBe("hop-root-wait");
  });

  it("accepts closed requests without activeHop", () => {
    const completed = validateTransferStack(v2Completed().record, v2Completed().transfers);
    expect(completed).not.toBe(HANDOFF_VIEW_INCONSISTENT);
    if (completed !== HANDOFF_VIEW_INCONSISTENT) {
      expect(completed.activeHop).toBeNull();
      expect(completed.holderMemberId).toBeNull();
      expect(completed.latestTransfer.status).toBe("closed");
    }
    const cancelled = validateTransferStack(v2Cancelled().record, v2Cancelled().transfers);
    expect(cancelled).not.toBe(HANDOFF_VIEW_INCONSISTENT);
    if (cancelled !== HANDOFF_VIEW_INCONSISTENT) {
      expect(cancelled.activeHop).toBeNull();
    }
  });

  it("rejects missing pointer, live hop on closed request, waiting_child pointer, cycle, and parent not waiting", () => {
    expect(validateTransferStack(v2OpenMissingPointer().record, v2OpenMissingPointer().transfers)).toBe(
      HANDOFF_VIEW_INCONSISTENT,
    );
    expect(validateTransferStack(v2ClosedWithLiveHop().record, v2ClosedWithLiveHop().transfers)).toBe(
      HANDOFF_VIEW_INCONSISTENT,
    );
    expect(validateTransferStack(v2WaitingChildPointer().record, v2WaitingChildPointer().transfers)).toBe(
      HANDOFF_VIEW_INCONSISTENT,
    );
    expect(validateTransferStack(v2ParentCycle().record, v2ParentCycle().transfers)).toBe(
      HANDOFF_VIEW_INCONSISTENT,
    );
    expect(validateTransferStack(v2ParentNotWaiting().record, v2ParentNotWaiting().transfers)).toBe(
      HANDOFF_VIEW_INCONSISTENT,
    );
  });
});

describe("v2 classification and sentences", () => {
  it("puts preparing and failed in mine for the sender only", () => {
    for (const fixture of [v2RootPreparing(), v2RootFailed()]) {
      const mine = project([fixture.record], fixture.transfers, MEMBER.creator);
      expect(mine.counts).toEqual({ mine: 1, watching: 0, done: 0 });
      expect(mine.cards[0]?.statusSentence).toBe(he.sendIncomplete);
      const other = project([fixture.record], fixture.transfers, MEMBER.recipient);
      expect(other.cards).toHaveLength(0);
      expect(other.inconsistent).toBe(true);
    }
  });

  it("puts an active hop in mine for the recipient and watching for sender and prior", () => {
    const { record, transfers } = v2RootActive();
    const recipient = project([record], transfers, MEMBER.recipient);
    const sender = project([record], transfers, MEMBER.creator);
    expect(recipient.counts.mine).toBe(1);
    expect(sender.counts.watching).toBe(1);
    expect(recipient.cards[0]?.statusSentence).toBe(
      he.receivedRequestFrom.replace("{fromName}", "מאור").replace("{verb}", he.verbApproveFile),
    );
    expect(sender.cards[0]?.statusSentence).toBe(he.fileInCareOf.replace("{toName}", "דני"));
    expect(recipient.cards[0]?.actionLabel).toBe(he.actionApproval);
  });

  it("shows a file request by description without inventing a file name", () => {
    const { record, transfers } = v2RootActive();
    const fileRequest = {
      record: {
        ...record,
        originalFilename: "",
        versions: [],
        instruction: "נא לצרף את הדוח החתום",
      },
      transfers: [
        {
          ...transfers[0]!,
          requestedAction: "file_request" as const,
          instruction: "נא לצרף את הדוח החתום",
        },
      ],
    };
    const recipient = project([fileRequest.record], fileRequest.transfers, MEMBER.recipient);
    const sender = project([fileRequest.record], fileRequest.transfers, MEMBER.creator);
    expect(recipient.cards[0]?.filename).toBe("נא לצרף את הדוח החתום");
    expect(recipient.cards[0]?.statusSentence).toBe(
      he.receivedFileRequestFrom.replace("{fromName}", "מאור"),
    );
    expect(sender.cards[0]?.statusSentence).toBe(he.waitingForFileFrom.replace("{toName}", "דני"));
    expect(recipient.cards[0]?.actionLabel).toBe(he.actionFileRequest);
    expect(recipient.cards[0]?.filename).not.toMatch(/handoff|uuid|\.docx/i);
  });

  it("classifies a prior participant on a child hop as watching", () => {
    const { record, transfers } = v2ChildActive();
    const prior = project([record], transfers, MEMBER.prior);
    const recipient = project([record], transfers, MEMBER.recipient);
    const creator = project([record], transfers, MEMBER.creator);
    expect(recipient.counts.mine).toBe(1);
    expect(prior.counts.watching).toBe(1);
    expect(creator.counts.watching).toBe(1);
    expect(recipient.cards[0]?.statusSentence).toContain("נועה");
    expect(recipient.cards[0]?.actionLabel).toBe(he.actionReview);
  });

  it("classifies returned_to_sender by holder, returner, and prior", () => {
    const { record, transfers } = v2ChildReturned();
    const view = validateTransferStack(record, transfers);
    expect(view).not.toBe(HANDOFF_VIEW_INCONSISTENT);
    if (view === HANDOFF_VIEW_INCONSISTENT) {
      return;
    }
    expect(classifyTransferSection({ ...view, viewerRelation: "from" }, MEMBER.prior)).toBe("mine");
    const holder = project([record], transfers, MEMBER.prior);
    const returner = project([record], transfers, MEMBER.recipient);
    const creator = project([record], transfers, MEMBER.creator);
    expect(holder.counts.mine).toBe(1);
    expect(returner.counts.watching).toBe(1);
    expect(creator.counts.watching).toBe(1);
    expect(holder.cards[0]?.statusSentence).toBe(
      he.resultWaitingYourReview.replace("{toName}", "דני"),
    );
    expect(returner.cards[0]?.statusSentence).toBe(
      he.resultWaitingTheirReview.replace("{fromName}", "נועה"),
    );
    expect(creator.cards[0]?.statusSentence).toBe(
      he.resultWaitingNamedReview.replace("{toName}", "דני").replace("{fromName}", "נועה"),
    );
    expect(holder.cards[0]?.relevantNote).toBe("חסר החתימה");
    expect(holder.cards[0]?.actionLabel).toBe(he.actionUpdate);
  });

  it("puts completed and cancelled requests in done without an active hop", () => {
    const completed = project([v2Completed().record], v2Completed().transfers, MEMBER.creator);
    const cancelled = project([v2Cancelled().record], v2Cancelled().transfers, MEMBER.recipient);
    expect(completed.counts.done).toBe(1);
    expect(cancelled.counts.done).toBe(1);
    expect(completed.cards[0]?.statusSentence).toBe(he.requestCompleted);
    expect(cancelled.cards[0]?.statusSentence).toBe(he.requestCancelled);
    expect(completed.cards[0]?.source.kind === "transfer" && completed.cards[0].source.activeHop).toBeNull();
  });

  it("hides a third party and keeps every good request in one section", () => {
    const { record, transfers } = v2RootActive();
    const outsider = project([record, v1Active], transfers, MEMBER.outsider);
    expect(outsider.cards).toHaveLength(0);
    const recipient = project([record], transfers, MEMBER.recipient);
    const sections = [recipient.counts.mine, recipient.counts.watching, recipient.counts.done];
    expect(sections.filter((count) => count > 0)).toHaveLength(1);
  });

  it("keeps status sentences gender-neutral and free of English keys", () => {
    const fixtures = [v2RootActive(), v2ChildActive(), v2ChildReturned(), v2Completed(), v2Cancelled()];
    for (const fixture of fixtures) {
      for (const memberId of [MEMBER.creator, MEMBER.recipient, MEMBER.prior]) {
        const projected = project([fixture.record], fixture.transfers, memberId);
        for (const card of projected.cards) {
          expect(card.statusSentence).not.toMatch(GENDERED);
          expect(card.statusSentence).not.toMatch(
            /open|active|preparing|failed|waiting_child|returned_to_sender|completed|cancelled|mine|watching/,
          );
          expect(`${card.statusSentence} ${card.actionLabel ?? ""}`).not.toContain("handoff_view_inconsistent");
        }
      }
    }
    const view = validateTransferStack(v2RootActive().record, v2RootActive().transfers);
    if (view !== HANDOFF_VIEW_INCONSISTENT) {
      const sentence = transferStatusSentence({ ...view, viewerRelation: "to" }, memberName);
      expect(sentence).not.toMatch(GENDERED);
    }
  });
});

describe("mixed list projection", () => {
  it("keeps v1 in the mapped sections and sorts by last activity", () => {
    const reminder = v2WithReminder("2026-09-08T12:00:00.000Z");
    const olderActive = v2RootActive();
    const projected = project(
      [v1Returned, v1Completed, reminder.record, olderActive.record],
      [...reminder.transfers, ...olderActive.transfers],
      MEMBER.creator,
    );
    expect(projected.grouped.mine.map((card) => card.id)).toEqual(["handoff-v1-returned"]);
    expect(projected.grouped.watching.map((card) => card.id)).toEqual(["v2-reminder", "v2-active"]);
    expect(projected.grouped.done.map((card) => card.id)).toEqual(["handoff-v1-completed"]);
    expect(lastActivityAtForV2(reminder.record, reminder.transfers)).toBe("2026-09-08T12:00:00.000Z");
  });

  it("uses reminder_sent for activity but not history", () => {
    const reminder = v2WithReminder();
    const projected = project([reminder.record], reminder.transfers, MEMBER.recipient);
    expect(projected.cards[0]?.lastActivityAt).toBe("2026-09-08T12:00:00.000Z");
    const lines = visibleHistory(reminder.record);
    expect(lines.some((line) => line.eventType === "reminder_sent")).toBe(false);
    expect(lines.map((line) => line.title)).toEqual([
      he.historyRequestSent,
      he.historyRequestSent,
    ]);
  });

  it("does not put inconsistent rows in sections or counts", () => {
    const good = v2RootActive();
    const bad = v2ParentCycle();
    const projected = project(
      [good.record, bad.record],
      [...good.transfers, ...bad.transfers],
      MEMBER.recipient,
    );
    expect(projected.counts).toEqual({ mine: 1, watching: 0, done: 0 });
    expect(projected.inconsistent).toBe(true);
    expect(projected.cards.map((card) => card.id)).toEqual(["v2-active"]);
  });

  it("keeps already-loaded v1 cards when v2 load fails", () => {
    const good = v2RootActive();
    const projected = project(
      [v1Active, good.record],
      good.transfers,
      MEMBER.recipient,
      { v2LoadFailed: true },
    );
    expect(projected.cards.map((card) => card.id)).toEqual(["handoff-v1-active"]);
    expect(projected.counts.mine).toBe(1);
    expect(projected.inconsistent).toBe(true);
  });

  it("recomputes the holder from the live hop without caching", () => {
    const first = v2RootActive();
    const second = {
      record: { ...first.record, activeTransferId: "hop-active" },
      transfers: [
        {
          ...first.transfers[0]!,
          status: "returned_to_sender" as const,
          resultAction: "returned_with_reply" as const,
          resultNote: "לבדוק שוב",
        },
      ],
    };
    const before = project([first.record], first.transfers, MEMBER.creator);
    const after = project([second.record], second.transfers, MEMBER.creator);
    expect(before.cards[0]?.source.kind === "transfer" && before.cards[0].source.holderMemberId).toBe(
      MEMBER.recipient,
    );
    expect(after.counts.mine).toBe(1);
    expect(after.cards[0]?.source.kind === "transfer" && after.cards[0].source.holderMemberId).toBe(
      MEMBER.creator,
    );
  });
});
