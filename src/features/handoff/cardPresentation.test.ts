import { describe, expect, it } from "vitest";
import { he } from "../../copy/he";
import {
  counterpartHandle,
  formatCardDue,
  presentHandoffCard,
  resolveCardPrimary,
} from "./cardPresentation";
import { MEMBER, memberName, v2Completed, v2RootActive, v2RootFailed } from "./view.fixtures";
import { projectHandoffList } from "./view";
import type { HandoffRecord, TransferRecord } from "./types";

function present(
  record: HandoffRecord,
  transfers: TransferRecord[],
  memberId: string,
  useMe = false,
) {
  const projected = projectHandoffList([record], transfers, memberId, memberName);
  const card = projected.cards[0];
  if (!card) {
    throw new Error("expected card");
  }
  return presentHandoffCard(card, memberId, memberName, { useMe, now: new Date("2026-09-06") });
}

describe("card presentation", () => {
  it("maps mine approval to a short status and user-facing headline", () => {
    const { record, transfers } = v2RootActive();
    const view = present(record, transfers, MEMBER.recipient, true);
    expect(view.statusLabel).toBe(he.actionApproval);
    expect(view.headline).toBe(he.needApprove);
    expect(view.title).toBe("נא לאשר");
    expect(view.tone).toBe("action");
    expect(view.people.senderName).toBe("מאור");
    expect(view.people.recipientDisplay).toBe(he.meLabel);
    expect(view.people.recipientName).toBe("דני");
    expect(view.counterpart?.name).toBe("מאור");
    expect(view.counterpart?.email).toBeNull();
    expect(counterpartHandle(view.counterpart)).toBe("מאור");
    expect(view.versionLabel).toBe("גרסה 1");
    expect(view.dueLabel).toBe("עד 10 בספטמבר");
  });

  it("maps watching copy by request type", () => {
    const { record, transfers } = v2RootActive();
    const view = present(record, transfers, MEMBER.creator);
    expect(view.statusLabel).toBe(he.statusInProgress);
    expect(view.headline).toBe(he.recipientHandling.replace("{name}", "דני"));
    expect(view.title).toBe("נא לאשר");
    expect(view.counterpart?.name).toBe("דני");
    expect(view.tone).toBe("watch");
  });

  it("attaches the counterpart email when the roster has one", () => {
    const { record, transfers } = v2RootActive();
    const projected = projectHandoffList([record], transfers, MEMBER.recipient, memberName);
    const card = projected.cards[0];
    if (!card) {
      throw new Error("expected card");
    }
    const view = presentHandoffCard(card, MEMBER.recipient, memberName, {
      emailOf: (id) => (id === MEMBER.creator ? "maor@drops.app" : null),
    });
    expect(view.counterpart).toEqual({
      id: MEMBER.creator,
      name: "מאור",
      email: "maor@drops.app",
    });
    expect(counterpartHandle(view.counterpart)).toBe("מאור");
  });

  it("uses file-request description instead of a fake filename", () => {
    const { record, transfers } = v2RootActive();
    const fileRequest = {
      ...record,
      originalFilename: "unknown.txt",
      versions: [],
    };
    const hops = transfers.map((hop) => ({
      ...hop,
      requestedAction: "file_request" as const,
      instruction: "דוח הכספים לשנת 2021",
    }));
    const view = present(fileRequest, hops, MEMBER.recipient);
    expect(view.headline).toBe(he.needAttachFile);
    expect(view.statusLabel).toBe(he.statusNeedFile);
    expect(view.title).toBe("דוח הכספים לשנת 2021");
    expect(view.subjectKind).toBe("fileRequest");
    expect(view.subjectText).toBeNull();
    expect(view.instruction).toBeNull();
    expect(view.versionLabel).toBeNull();
    expect(view.subjectText).not.toBe("unknown.txt");
  });

  it("maps returned, rejected, completed, and failed headlines", () => {
    const active = v2RootActive();
    const returned = {
      record: active.record,
      transfers: active.transfers.map((hop) => ({
        ...hop,
        status: "returned_to_sender" as const,
        resultAction: "returned_with_file" as const,
      })),
    };
    expect(present(returned.record, returned.transfers, MEMBER.creator).headline).toBe(
      he.returnedVersion,
    );
    const reply = {
      record: active.record,
      transfers: active.transfers.map((hop) => ({
        ...hop,
        status: "returned_to_sender" as const,
        resultAction: "returned_with_reply" as const,
      })),
    };
    expect(present(reply.record, reply.transfers, MEMBER.creator).headline).toBe(
      he.receivedReplyFromNeutral.replace("{name}", "דני"),
    );
    const rejected = {
      record: active.record,
      transfers: active.transfers.map((hop) => ({
        ...hop,
        status: "returned_to_sender" as const,
        resultAction: "rejected" as const,
      })),
    };
    const rejectedView = present(rejected.record, rejected.transfers, MEMBER.creator);
    expect(rejectedView.headline).toBe(he.requestRejectedBy.replace("{name}", "דני"));
    expect(rejectedView.statusLabel).toBe(he.statusRejected);
    expect(rejectedView.tone).toBe("danger");

    const done = v2Completed();
    const doneView = present(done.record, done.transfers, MEMBER.creator);
    expect(doneView.headline).toBe(he.requestApprovedBy.replace("{name}", "דני"));
    expect(doneView.versionLabel).toMatch(/גרסה סופית/);
    expect(doneView.settled).toBe(true);

    const failed = v2RootFailed();
    expect(present(failed.record, failed.transfers, MEMBER.creator).headline).toBe(
      he.sendIncomplete,
    );
  });

  it("omits due and version when they are absent or zero", () => {
    expect(formatCardDue(null)).toBeNull();
    const { record, transfers } = v2RootActive();
    const projected = projectHandoffList(
      [{ ...record, dueOn: null }],
      transfers.map((hop) => ({ ...hop, dueOn: null })),
      MEMBER.recipient,
      memberName,
    );
    const card = {
      ...projected.cards[0]!,
      dueOn: null,
      latestVersionNumber: 0,
    };
    const view = presentHandoffCard(card, MEMBER.recipient, memberName);
    expect(view.dueLabel).toBeNull();
    expect(view.versionLabel).toBeNull();
  });

  it("marks today, tomorrow, and overdue dues", () => {
    const now = new Date("2026-09-06T12:00:00");
    expect(formatCardDue("2026-09-06", now)).toEqual({ label: he.dueTodayShort, tone: "soon" });
    expect(formatCardDue("2026-09-07", now)).toEqual({ label: he.dueTomorrow, tone: "soon" });
    expect(formatCardDue("2026-09-04", now)).toEqual({ label: he.dueOverdueTwo, tone: "overdue" });
  });

  it("picks one visual primary without inventing permissions", () => {
    expect(
      resolveCardPrimary({
        section: "watching",
        localWork: "idle",
        fileRequestPending: false,
        senderAccept: false,
        hasOpenableFile: true,
        showOpen: true,
        canReturn: false,
        legacyReturnedSender: false,
      }),
    ).toBe("openDetails");
    expect(
      resolveCardPrimary({
        section: "done",
        localWork: "idle",
        fileRequestPending: false,
        senderAccept: true,
        hasOpenableFile: true,
        showOpen: true,
        canReturn: false,
        legacyReturnedSender: false,
      }),
    ).toBe("openFile");
    expect(
      resolveCardPrimary({
        section: "done",
        localWork: "idle",
        fileRequestPending: false,
        senderAccept: false,
        hasOpenableFile: false,
        showOpen: false,
        canReturn: false,
        legacyReturnedSender: false,
      }),
    ).toBe("openDetails");
  });
});
