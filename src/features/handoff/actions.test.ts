import { describe, expect, it } from "vitest";
import {
  canCancelV2,
  canOpenV2,
  canRemind,
  isFileRequestWithoutVersion,
  noteRequiredFor,
  recipientPrimaryAction,
  resultActionFor,
  senderReturnActions,
} from "./actions";
import { MEMBER, v2RootActive } from "./view.fixtures";
import type { TransferHandoffView } from "./view";

function source(partial: Partial<TransferHandoffView> = {}): TransferHandoffView {
  const { record, transfers } = v2RootActive();
  return {
    kind: "transfer",
    record,
    requestStatus: "open",
    activeHop: transfers[0]!,
    latestTransfer: transfers[0]!,
    rootHop: transfers[0]!,
    parentHop: null,
    pathMemberIds: [MEMBER.creator, MEMBER.recipient],
    holderMemberId: MEMBER.recipient,
    latestFinalizedVersion: 1,
    lastBusinessEvent: null,
    viewerRelation: "to",
    ...partial,
  };
}

describe("v2 card actions", () => {
  it("hides open on a file request before a version exists", () => {
    const pending = source({
      latestFinalizedVersion: null,
      activeHop: { ...v2RootActive().transfers[0]!, requestedAction: "file_request" },
      record: { ...v2RootActive().record, versions: [] },
    });
    expect(isFileRequestWithoutVersion(pending)).toBe(true);
    expect(canOpenV2(pending, MEMBER.recipient)).toBe(false);
    expect(recipientPrimaryAction(pending, MEMBER.recipient)).toBe("attach");
  });

  it("keeps attach after a previous version when another file is requested", () => {
    const revision = source({
      latestFinalizedVersion: 1,
      activeHop: {
        ...v2RootActive().transfers[0]!,
        requestedAction: "file_request",
        status: "active",
      },
    });
    expect(isFileRequestWithoutVersion(revision)).toBe(false);
    expect(canOpenV2(revision, MEMBER.recipient)).toBe(true);
    expect(recipientPrimaryAction(revision, MEMBER.recipient)).toBe("attach");
  });

  it("shows reminder only to the from member of an active hop", () => {
    const active = source();
    expect(canRemind(active, MEMBER.creator)).toBe(true);
    expect(canRemind(active, MEMBER.recipient)).toBe(false);
    expect(canCancelV2(active, MEMBER.creator)).toBe(true);
    expect(canCancelV2(active, MEMBER.recipient)).toBe(false);
  });

  it("uses file-request wording after a return", () => {
    const returned = source({
      activeHop: {
        ...v2RootActive().transfers[0]!,
        status: "returned_to_sender",
        requestedAction: "file_request",
      },
    });
    expect(senderReturnActions(returned, MEMBER.creator)).toEqual({
      accept: true,
      revision: true,
      fileRequestWording: true,
    });
    expect(noteRequiredFor("rejected")).toBe(true);
    expect(noteRequiredFor("returned_with_reply")).toBe(true);
    expect(resultActionFor("approval", "approve")).toBe("approved");
    expect(resultActionFor("review", "complete")).toBe("review_completed");
  });
});
