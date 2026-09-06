import { he } from "../../copy/he";
import type { IconName } from "../../icons/fluent";
import type { LocalWorkState, RequestedAction } from "./types";
import { cardRequestedAction, isFileRequestWithoutVersion } from "./actions";
import type { HandoffCardView, TransferHandoffView } from "./view";

export type CardTone = "action" | "watch" | "done" | "return" | "danger";
export type DueTone = "normal" | "soon" | "overdue";
export type SubjectKind = "file" | "fileRequest";

export type CardPrimaryKind =
  | "openAndHandle"
  | "attach"
  | "openToReview"
  | "acceptAndClose"
  | "retry"
  | "openDetails"
  | "openFile"
  | "returnFile"
  | "chooseFile";

const PLACEHOLDER_FILES = new Set(["unknown.txt", he.requestFile, ""]);

export type CardPeople = {
  senderId: string;
  senderName: string;
  senderDisplay: string;
  recipientId: string;
  recipientName: string;
  recipientDisplay: string;
  holderLine: string | null;
};

export type CardPresentation = {
  statusLabel: string;
  statusIcon: IconName;
  tone: CardTone;
  headline: string;
  subjectKind: SubjectKind;
  subjectText: string | null;
  instruction: string | null;
  people: CardPeople;
  dueLabel: string | null;
  dueTone: DueTone | null;
  versionLabel: string | null;
  settled: boolean;
};

export function initials(name: string): string {
  const trimmed = name.trim();
  return trimmed ? Array.from(trimmed)[0] ?? "" : "";
}

function hopOf(card: HandoffCardView) {
  return card.source.kind === "transfer"
    ? (card.source.activeHop ?? card.source.latestTransfer)
    : null;
}

function transferOf(card: HandoffCardView): TransferHandoffView | null {
  return card.source.kind === "transfer" ? card.source : null;
}

function personDisplay(
  memberId: string,
  realName: string,
  currentMemberId: string | null,
  useMe: boolean,
): string {
  if (useMe && currentMemberId && memberId === currentMemberId && realName) {
    return he.meLabel;
  }
  return realName;
}

function requestedAction(card: HandoffCardView): RequestedAction | null {
  return cardRequestedAction(card);
}

function isFileRequestPending(card: HandoffCardView): boolean {
  return card.source.kind === "transfer" && isFileRequestWithoutVersion(card.source);
}

function isPlaceholderFile(name: string | null | undefined): boolean {
  const trimmed = name?.trim() ?? "";
  return PLACEHOLDER_FILES.has(trimmed);
}

export function formatCardDue(
  dueOn: string | null,
  now = new Date(),
): { label: string; tone: DueTone } | null {
  if (!dueOn) {
    return null;
  }
  const date = new Date(`${dueOn}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const due = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((due - today) / 86_400_000);
  if (dayDiff < 0) {
    const days = Math.abs(dayDiff);
    const label =
      days === 1
        ? he.dueOverdueOne
        : days === 2
          ? he.dueOverdueTwo
          : he.dueOverdueMany.replace("{n}", String(days));
    return { label, tone: "overdue" };
  }
  if (dayDiff === 0) {
    return { label: he.dueTodayShort, tone: "soon" };
  }
  if (dayDiff === 1) {
    return { label: he.dueTomorrow, tone: "soon" };
  }
  return {
    label: he.dueBy.replace(
      "{date}",
      new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "long" }).format(date),
    ),
    tone: "normal",
  };
}

function statusForTransfer(card: HandoffCardView): {
  label: string;
  icon: IconName;
  tone: CardTone;
} {
  const source = transferOf(card);
  const hop = hopOf(card);
  const action = requestedAction(card);
  if (source?.requestStatus === "cancelled") {
    return { label: he.statusCancelled, icon: "dismissCircle", tone: "danger" };
  }
  if (source?.requestStatus === "completed") {
    return { label: he.statusCompleted, icon: "checkmarkCircle", tone: "done" };
  }
  if (hop?.status === "preparing" || hop?.status === "failed") {
    return { label: he.statusSendFailed, icon: "cloudError", tone: "danger" };
  }
  if (hop?.status === "returned_to_sender") {
    if (hop.resultAction === "rejected") {
      return { label: he.statusRejected, icon: "prohibited", tone: "danger" };
    }
    return { label: he.statusReturnedToYou, icon: "arrowSync", tone: "return" };
  }
  if (card.section === "watching") {
    return { label: he.statusInProgress, icon: "clock", tone: "watch" };
  }
  if (action === "approval") {
    return { label: he.actionApproval, icon: "checkmarkCircle", tone: "action" };
  }
  if (action === "review") {
    return { label: he.actionReview, icon: "search", tone: "action" };
  }
  if (action === "file_request") {
    return { label: he.statusNeedFile, icon: "attach", tone: "action" };
  }
  return { label: he.actionUpdate, icon: "arrowSync", tone: "action" };
}

function statusForLegacy(card: HandoffCardView): {
  label: string;
  icon: IconName;
  tone: CardTone;
} {
  const status = card.source.kind === "legacy" ? card.source.record.status : null;
  if (status === "failed") {
    return { label: he.statusSendFailed, icon: "cloudError", tone: "danger" };
  }
  if (status === "completed" || status === "return_received") {
    return { label: he.statusCompleted, icon: "checkmarkCircle", tone: "done" };
  }
  if (status === "returned") {
    return card.section === "mine"
      ? { label: he.statusReturnedToYou, icon: "arrowSync", tone: "return" }
      : { label: he.statusInProgress, icon: "clock", tone: "watch" };
  }
  if (card.section === "watching") {
    return { label: he.statusInProgress, icon: "clock", tone: "watch" };
  }
  if (card.section === "done") {
    return { label: he.statusCompleted, icon: "checkmarkCircle", tone: "done" };
  }
  return { label: he.actionUpdate, icon: "document", tone: "action" };
}

function headlineForTransfer(card: HandoffCardView, names: (id: string) => string): string {
  const source = transferOf(card);
  const hop = hopOf(card);
  if (!source || !hop) {
    return card.statusSentence;
  }
  const toName = names(hop.toMemberId);
  const action = hop.requestedAction;
  if (source.requestStatus === "cancelled") {
    return he.requestCancelled;
  }
  if (source.requestStatus === "completed") {
    if (action === "approval" && toName) {
      return he.requestApprovedBy.replace("{name}", toName);
    }
    return he.requestCompleted;
  }
  if (hop.status === "preparing" || hop.status === "failed") {
    return he.sendIncomplete;
  }
  if (hop.status === "returned_to_sender") {
    if (hop.resultAction === "rejected") {
      return he.requestRejectedBy.replace("{name}", toName);
    }
    if (hop.resultAction === "returned_with_reply") {
      return he.receivedReplyFromNeutral.replace("{name}", toName);
    }
    if (hop.resultAction === "review_completed") {
      return he.reviewFinishedBy.replace("{name}", toName);
    }
    return he.returnedVersion;
  }
  if (card.section === "watching") {
    if (action === "file_request") {
      return he.waitingForFileFromNeutral.replace("{name}", toName);
    }
    if (action === "update") {
      return he.fileInCareOf.replace("{toName}", toName);
    }
    return he.recipientHandling.replace("{name}", toName);
  }
  if (action === "approval") {
    return he.needApprove;
  }
  if (action === "review") {
    return he.needReview;
  }
  if (action === "file_request") {
    return he.needAttachFile;
  }
  return he.needUpdate;
}

function headlineForLegacy(card: HandoffCardView, recipientName: string): string {
  const status = card.source.kind === "legacy" ? card.source.record.status : null;
  if (status === "failed") {
    return he.sendIncomplete;
  }
  if (status === "completed" || status === "return_received") {
    return he.requestCompleted;
  }
  if (status === "returned" && card.section === "mine") {
    return he.returnedVersion;
  }
  if (card.section === "watching") {
    return recipientName
      ? he.recipientHandling.replace("{name}", recipientName)
      : he.statusInProgress;
  }
  return he.needUpdate;
}

function subjectFor(card: HandoffCardView): { kind: SubjectKind; text: string | null } {
  const pending = isFileRequestPending(card);
  if (pending) {
    const description = card.instruction?.trim() || null;
    const filename = card.filename?.trim() || null;
    if (description) {
      return { kind: "fileRequest", text: description };
    }
    if (filename && !isPlaceholderFile(filename)) {
      return { kind: "fileRequest", text: filename };
    }
    return { kind: "fileRequest", text: null };
  }
  const filename = card.filename?.trim() || null;
  if (!filename || isPlaceholderFile(filename)) {
    return { kind: "file", text: null };
  }
  return { kind: "file", text: filename };
}

function instructionFor(card: HandoffCardView, subject: { kind: SubjectKind; text: string | null }) {
  const text = card.instruction?.trim() || null;
  if (!text) {
    return null;
  }
  if (subject.kind === "fileRequest" && subject.text === text) {
    return null;
  }
  return text;
}

function peopleFor(
  card: HandoffCardView,
  currentMemberId: string | null,
  nameOf: (id: string) => string,
  useMe: boolean,
): CardPeople {
  const hop = hopOf(card);
  const record = card.source.record;
  const senderId = hop?.fromMemberId ?? record.senderMemberId;
  const recipientId = hop?.toMemberId ?? record.recipientMemberId;
  const senderName = nameOf(senderId);
  const recipientName = nameOf(recipientId);
  const holderId = transferOf(card)?.holderMemberId ?? null;
  const holderLine =
    holderId &&
    holderId !== recipientId &&
    card.holderDisplayName &&
    card.holderDisplayName !== recipientName
      ? he.heldBy.replace("{name}", card.holderDisplayName)
      : null;
  return {
    senderId,
    senderName,
    senderDisplay: personDisplay(senderId, senderName, currentMemberId, useMe),
    recipientId,
    recipientName,
    recipientDisplay: personDisplay(recipientId, recipientName, currentMemberId, useMe),
    holderLine,
  };
}

function versionLabelFor(card: HandoffCardView): string | null {
  const version = card.latestVersionNumber;
  if (version == null || version <= 0) {
    return null;
  }
  if (card.section === "done") {
    return he.finalVersionLabel.replace("{version}", String(version));
  }
  return he.latestVersionLabel.replace("{version}", String(version));
}

export function presentHandoffCard(
  card: HandoffCardView,
  currentMemberId: string | null,
  nameOf: (id: string) => string,
  options: { useMe?: boolean; now?: Date } = {},
): CardPresentation {
  const useMe = options.useMe !== false;
  const status =
    card.source.kind === "transfer" ? statusForTransfer(card) : statusForLegacy(card);
  const people = peopleFor(card, currentMemberId, nameOf, useMe);
  const headline =
    card.source.kind === "transfer"
      ? headlineForTransfer(card, nameOf)
      : headlineForLegacy(card, people.recipientName);
  const subject = subjectFor(card);
  const due = formatCardDue(card.dueOn, options.now);
  const settled =
    card.section === "done" ||
    status.tone === "done" ||
    status.label === he.statusCancelled;
  return {
    statusLabel: status.label,
    statusIcon: status.icon,
    tone: status.tone,
    headline,
    subjectKind: subject.kind,
    subjectText: subject.text,
    instruction: instructionFor(card, subject),
    people,
    dueLabel: due?.label ?? null,
    dueTone: due?.tone ?? null,
    versionLabel: versionLabelFor(card),
    settled,
  };
}

export function resolveCardPrimary(input: {
  section: HandoffCardView["section"];
  localWork: LocalWorkState;
  fileRequestPending: boolean;
  senderAccept: boolean;
  hasOpenableFile: boolean;
  showOpen: boolean;
  canReturn: boolean;
  legacyReturnedSender: boolean;
}): CardPrimaryKind | null {
  if (input.localWork === "retry" || input.localWork === "offline") {
    return "retry";
  }
  if (input.localWork === "waiting_reselect") {
    return "chooseFile";
  }
  if (input.section === "watching") {
    return "openDetails";
  }
  if (input.section === "done") {
    return input.hasOpenableFile ? "openFile" : "openDetails";
  }
  if (input.fileRequestPending) {
    return "attach";
  }
  if (input.senderAccept) {
    return input.hasOpenableFile ? "openToReview" : "acceptAndClose";
  }
  if (input.canReturn) {
    return "returnFile";
  }
  if (input.showOpen) {
    return "openAndHandle";
  }
  if (input.legacyReturnedSender) {
    return "acceptAndClose";
  }
  return null;
}

export function primaryActionCopy(kind: CardPrimaryKind): { label: string; icon: IconName } {
  if (kind === "attach") {
    return { label: he.attachFile, icon: "attach" };
  }
  if (kind === "openToReview") {
    return { label: he.openToReview, icon: "open" };
  }
  if (kind === "acceptAndClose") {
    return { label: he.acceptAndClose, icon: "checkmark" };
  }
  if (kind === "retry") {
    return { label: he.tryAgain, icon: "arrowSync" };
  }
  if (kind === "openDetails") {
    return { label: he.openDetails, icon: "info" };
  }
  if (kind === "openFile") {
    return { label: he.openFile, icon: "open" };
  }
  if (kind === "returnFile") {
    return { label: he.returnFile, icon: "arrowSync" };
  }
  if (kind === "chooseFile") {
    return { label: he.chooseFile, icon: "document" };
  }
  return { label: he.openAndHandle, icon: "open" };
}

