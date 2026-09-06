import type { HandoffCardView, TransferHandoffView } from "./view";
import type { InboxLocalEntry, RequestedAction, ResultAction } from "./types";

export function resultActionFor(
  requested: RequestedAction,
  kind: "approve" | "reject" | "complete" | "update" | "attach",
): ResultAction {
  if (kind === "reject") {
    return "rejected";
  }
  if (requested === "approval") {
    return "approved";
  }
  if (requested === "review") {
    return "review_completed";
  }
  if (requested === "file_request") {
    return "returned_with_file";
  }
  return kind === "update" || kind === "attach" ? "returned_with_file" : "returned_with_reply";
}

export function noteRequiredFor(action: ResultAction): boolean {
  return action === "rejected" || action === "returned_with_reply";
}

export function isFileRequestWithoutVersion(source: TransferHandoffView): boolean {
  return (
    source.activeHop?.requestedAction === "file_request" &&
    source.latestFinalizedVersion === null &&
    source.activeHop.status === "active"
  );
}

export function canOpenV2(source: TransferHandoffView, memberId: string): boolean {
  if (isFileRequestWithoutVersion(source)) {
    return false;
  }
  if (!source.latestFinalizedVersion && source.record.versions.length === 0) {
    return false;
  }
  const hop = source.activeHop;
  if (!hop) {
    return source.requestStatus === "completed" || source.requestStatus === "cancelled";
  }
  if (hop.status === "active" && hop.toMemberId === memberId) {
    return true;
  }
  if (hop.status === "returned_to_sender" && hop.fromMemberId === memberId) {
    return true;
  }
  return source.record.senderMemberId === memberId || hop.toMemberId === memberId;
}

export function canRemind(source: TransferHandoffView, memberId: string): boolean {
  return source.activeHop?.status === "active" && source.activeHop.fromMemberId === memberId;
}

export function canCancelV2(source: TransferHandoffView, memberId: string): boolean {
  return source.requestStatus === "open" && source.record.senderMemberId === memberId;
}

export function recipientPrimaryAction(
  source: TransferHandoffView,
  memberId: string,
): "approve" | "review" | "update" | "attach" | "reject" | null {
  const hop = source.activeHop;
  if (!hop || hop.status !== "active" || hop.toMemberId !== memberId) {
    return null;
  }
  if (hop.requestedAction === "file_request") {
    return "attach";
  }
  if (hop.requestedAction === "approval") {
    return "approve";
  }
  if (hop.requestedAction === "review") {
    return "review";
  }
  return "update";
}

export function senderReturnActions(
  source: TransferHandoffView,
  memberId: string,
): { accept: boolean; revision: boolean; fileRequestWording: boolean } {
  const hop = source.activeHop;
  const visible =
    hop?.status === "returned_to_sender" && hop.fromMemberId === memberId;
  return {
    accept: visible,
    revision: visible,
    fileRequestWording: hop?.requestedAction === "file_request",
  };
}

export function workingFileChanged(
  inbox: InboxLocalEntry[],
  handoffId: string,
): boolean {
  return inbox.some((entry) => entry.handoffId === handoffId && entry.contentDiffersFromV1);
}

export function cardRequestedAction(card: HandoffCardView): RequestedAction | null {
  return card.source.kind === "transfer"
    ? (card.source.activeHop ?? card.source.latestTransfer).requestedAction
    : null;
}
