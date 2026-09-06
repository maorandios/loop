import { handoffStatusLabel, he } from "../../copy/he";
import { classifyHandoffView, handoffRole, type HandoffView } from "./buckets";
import type {
  HandoffEvent,
  HandoffRecord,
  HandoffSection,
  RequestStatus,
  RequestedAction,
  TransferRecord,
  TransferStatus,
  ViewerRelation,
} from "./types";

export const HANDOFF_VIEW_INCONSISTENT = "handoff_view_inconsistent";

export type LegacyHandoffView = {
  kind: "legacy";
  record: HandoffRecord;
};

export type TransferHandoffView = {
  kind: "transfer";
  record: HandoffRecord;
  requestStatus: RequestStatus;
  activeHop: TransferRecord | null;
  latestTransfer: TransferRecord;
  rootHop: TransferRecord;
  parentHop: TransferRecord | null;
  pathMemberIds: string[];
  holderMemberId: string | null;
  latestFinalizedVersion: number | null;
  lastBusinessEvent: HandoffEvent | null;
  viewerRelation: ViewerRelation;
};

export type HandoffSourceView = LegacyHandoffView | TransferHandoffView;

export type HandoffCardView = {
  id: string;
  section: HandoffSection;
  filename: string;
  statusSentence: string;
  actionLabel: string | null;
  instruction: string | null;
  dueOn: string | null;
  holderDisplayName: string | null;
  latestVersionNumber: number | null;
  lastActivityAt: string;
  relevantNote: string | null;
  source: HandoffSourceView;
};

export type ProjectedHandoffList = {
  cards: HandoffCardView[];
  grouped: Record<HandoffSection, HandoffCardView[]>;
  counts: Record<HandoffSection, number>;
  inconsistent: boolean;
};

const LIVE_HOP_STATUSES = new Set<TransferStatus>([
  "preparing",
  "failed",
  "active",
  "returned_to_sender",
]);

const REQUEST_STATUSES = new Set<RequestStatus>(["open", "completed", "cancelled"]);
const REQUESTED_ACTIONS = new Set<RequestedAction>([
  "approval",
  "review",
  "update",
  "file_request",
]);
const V2_HISTORY_TYPES = new Set([
  "finalized",
  "failed",
  "created",
  "opened",
  "approved",
  "review_completed",
  "returned_with_file",
  "returned_with_reply",
  "rejected",
  "revision_requested",
  "completed",
  "cancelled",
]);

export function isLegacyHandoff(row: HandoffRecord): boolean {
  return (row.flowVersion ?? 1) === 1;
}

export function sectionFromLegacyView(view: HandoffView): HandoffSection {
  if (view === "waiting_for_me") {
    return "mine";
  }
  if (view === "waiting_for_others") {
    return "watching";
  }
  return "done";
}

export function holderMemberIdFromHop(hop: TransferRecord): string | null {
  if (hop.status === "preparing" || hop.status === "failed") {
    return hop.fromMemberId;
  }
  if (hop.status === "active") {
    return hop.toMemberId;
  }
  if (hop.status === "returned_to_sender") {
    return hop.fromMemberId;
  }
  return null;
}

export function latestTransferOf(transfers: TransferRecord[]): TransferRecord | null {
  if (transfers.length === 0) {
    return null;
  }
  return [...transfers].sort((left, right) => {
    const delta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (delta !== 0) {
      return delta;
    }
    return right.id.localeCompare(left.id);
  })[0] ?? null;
}

export function latestFinalizedVersionNumber(row: HandoffRecord): number | null {
  if (row.versions.length === 0) {
    return null;
  }
  return row.versions.reduce(
    (latest, version) => Math.max(latest, version.versionNumber),
    0,
  );
}

function pathMemberIdsOf(
  record: HandoffRecord,
  transfers: TransferRecord[],
): string[] {
  const ids = new Set<string>([record.senderMemberId]);
  for (const hop of transfers) {
    ids.add(hop.fromMemberId);
    ids.add(hop.toMemberId);
  }
  return [...ids];
}

function lastBusinessEventOf(events: HandoffEvent[]): HandoffEvent | null {
  const visible = events.filter((event) => V2_HISTORY_TYPES.has(event.eventType));
  if (visible.length === 0) {
    return null;
  }
  return [...visible].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  )[0] ?? null;
}

export function lastActivityAtForV2(
  record: HandoffRecord,
  transfers: TransferRecord[],
): string {
  const stamps = [
    record.updatedAt,
    ...transfers.map((hop) => hop.updatedAt),
    ...record.events.map((event) => event.createdAt),
  ];
  return stamps.reduce((latest, stamp) => {
    const latestMs = Date.parse(latest);
    const stampMs = Date.parse(stamp);
    if (Number.isNaN(stampMs)) {
      return latest;
    }
    if (Number.isNaN(latestMs) || stampMs > latestMs) {
      return stamp;
    }
    return latest;
  }, record.updatedAt);
}

function walkParentChain(
  start: TransferRecord,
  byId: Map<string, TransferRecord>,
): TransferRecord[] | null {
  const chain: TransferRecord[] = [];
  const seen = new Set<string>();
  let current: TransferRecord | undefined = start;
  while (current) {
    if (seen.has(current.id)) {
      return null;
    }
    seen.add(current.id);
    chain.push(current);
    if (!current.parentTransferId) {
      return chain;
    }
    current = byId.get(current.parentTransferId);
    if (!current) {
      return null;
    }
  }
  return null;
}

export function validateTransferStack(
  record: HandoffRecord,
  transfers: TransferRecord[],
): TransferHandoffView | typeof HANDOFF_VIEW_INCONSISTENT {
  const requestStatus = record.requestStatus ?? null;
  if (!requestStatus || !REQUEST_STATUSES.has(requestStatus)) {
    return HANDOFF_VIEW_INCONSISTENT;
  }
  if (transfers.some((hop) => !REQUESTED_ACTIONS.has(hop.requestedAction))) {
    return HANDOFF_VIEW_INCONSISTENT;
  }

  const roots = transfers.filter((hop) => hop.parentTransferId === null);
  if (roots.length !== 1) {
    return HANDOFF_VIEW_INCONSISTENT;
  }
  const rootHop = roots[0]!;
  const byId = new Map(transfers.map((hop) => [hop.id, hop]));

  for (const hop of transfers) {
    const chain = walkParentChain(hop, byId);
    if (!chain) {
      return HANDOFF_VIEW_INCONSISTENT;
    }
    const chainRoot = chain[chain.length - 1];
    if (!chainRoot || chainRoot.id !== rootHop.id) {
      return HANDOFF_VIEW_INCONSISTENT;
    }
  }

  let activeHop: TransferRecord | null = null;
  if (requestStatus === "open") {
    const pointer = record.activeTransferId ?? null;
    if (!pointer) {
      return HANDOFF_VIEW_INCONSISTENT;
    }
    const pointed = byId.get(pointer);
    if (!pointed || !LIVE_HOP_STATUSES.has(pointed.status)) {
      return HANDOFF_VIEW_INCONSISTENT;
    }
    if (pointed.parentTransferId === null && pointed.id !== rootHop.id) {
      return HANDOFF_VIEW_INCONSISTENT;
    }
    const chain = walkParentChain(pointed, byId);
    if (!chain) {
      return HANDOFF_VIEW_INCONSISTENT;
    }
    if (pointed.parentTransferId !== null) {
      const parent = byId.get(pointed.parentTransferId);
      if (
        (pointed.status === "active" || pointed.status === "returned_to_sender") &&
        parent?.status !== "waiting_child"
      ) {
        return HANDOFF_VIEW_INCONSISTENT;
      }
      for (const ancestor of chain.slice(1)) {
        if (ancestor.status !== "waiting_child") {
          return HANDOFF_VIEW_INCONSISTENT;
        }
      }
    }
    activeHop = pointed;
  } else {
    if (record.activeTransferId) {
      return HANDOFF_VIEW_INCONSISTENT;
    }
    if (transfers.some((hop) => hop.status !== "closed")) {
      return HANDOFF_VIEW_INCONSISTENT;
    }
  }

  const latestTransfer = latestTransferOf(transfers);
  if (!latestTransfer) {
    return HANDOFF_VIEW_INCONSISTENT;
  }

  const parentHop = activeHop?.parentTransferId
    ? (byId.get(activeHop.parentTransferId) ?? null)
    : null;

  return {
    kind: "transfer",
    record,
    requestStatus,
    activeHop,
    latestTransfer,
    rootHop,
    parentHop,
    pathMemberIds: pathMemberIdsOf(record, transfers),
    holderMemberId: activeHop ? holderMemberIdFromHop(activeHop) : null,
    latestFinalizedVersion: latestFinalizedVersionNumber(record),
    lastBusinessEvent: lastBusinessEventOf(record.events),
    viewerRelation: "prior",
  };
}

export function viewerRelationFor(
  memberId: string,
  source: TransferHandoffView,
): ViewerRelation | null {
  const hop = source.activeHop ?? source.latestTransfer;
  if (hop.fromMemberId === memberId) {
    return "from";
  }
  if (hop.toMemberId === memberId) {
    return "to";
  }
  if (source.record.senderMemberId === memberId) {
    return "creator";
  }
  if (source.pathMemberIds.includes(memberId)) {
    return "prior";
  }
  return null;
}

export function classifyTransferSection(
  source: TransferHandoffView,
  memberId: string,
): HandoffSection | null {
  const relation = viewerRelationFor(memberId, source);
  if (!relation) {
    return null;
  }
  if (source.requestStatus === "completed" || source.requestStatus === "cancelled") {
    return "done";
  }
  if (
    source.activeHop &&
    (source.activeHop.status === "preparing" || source.activeHop.status === "failed")
  ) {
    return relation === "from" ? "mine" : null;
  }
  if (source.holderMemberId === memberId) {
    return "mine";
  }
  return "watching";
}

export function actionLabelFor(action: RequestedAction): string {
  if (action === "approval") {
    return he.actionApproval;
  }
  if (action === "review") {
    return he.actionReview;
  }
  if (action === "file_request") {
    return he.actionFileRequest;
  }
  return he.actionUpdate;
}

export function actionVerbFor(action: RequestedAction): string {
  if (action === "approval") {
    return he.verbApproveFile;
  }
  if (action === "review") {
    return he.verbReviewFile;
  }
  if (action === "file_request") {
    return he.verbSupplyFile;
  }
  return he.verbUpdateFile;
}

export function cardTitleFor(
  record: HandoffRecord,
  hop: { requestedAction: RequestedAction; instruction: string } | null,
  latestFileName: string | null,
): string {
  if (hop?.requestedAction === "file_request") {
    return latestFileName || hop.instruction || record.instruction || he.requestFile;
  }
  return latestFileName || record.originalFilename;
}

export function transferStatusSentence(
  source: TransferHandoffView,
  names: (memberId: string) => string,
): string | typeof HANDOFF_VIEW_INCONSISTENT {
  if (source.requestStatus === "completed") {
    return he.requestCompleted;
  }
  if (source.requestStatus === "cancelled") {
    return he.requestCancelled;
  }
  const hop = source.activeHop;
  if (!hop) {
    return HANDOFF_VIEW_INCONSISTENT;
  }
  const fromName = names(hop.fromMemberId);
  const toName = names(hop.toMemberId);
  if (hop.requestedAction === "file_request" && hop.status === "active") {
    if (source.viewerRelation === "to") {
      return he.receivedFileRequestFrom.replace("{fromName}", fromName);
    }
    return he.waitingForFileFrom.replace("{toName}", toName);
  }
  if (hop.status === "preparing" || hop.status === "failed") {
    if (source.viewerRelation !== "from") {
      return HANDOFF_VIEW_INCONSISTENT;
    }
    return he.sendIncomplete;
  }
  if (hop.status === "active") {
    if (source.viewerRelation === "to") {
      if (hop.requestedAction === "approval") {
        return he.needApprove;
      }
      if (hop.requestedAction === "review") {
        return he.needReview;
      }
      return he.needUpdate;
    }
    return he.fileInCareOf.replace("{toName}", toName);
  }
  if (hop.status === "returned_to_sender") {
    if (source.viewerRelation === "from") {
      if (hop.resultAction === "rejected") {
        return he.requestRejected;
      }
      if (hop.resultAction === "returned_with_reply") {
        return he.receivedReplyFrom.replace("{fromName}", toName);
      }
      return he.returnedVersion;
    }
    if (source.viewerRelation === "to") {
      return he.resultWaitingTheirReview.replace("{fromName}", fromName);
    }
    return he.resultWaitingNamedReview
      .replace("{toName}", toName)
      .replace("{fromName}", fromName);
  }
  return HANDOFF_VIEW_INCONSISTENT;
}

function compareActivity(left: HandoffCardView, right: HandoffCardView): number {
  const delta = Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt);
  if (delta !== 0) {
    return delta;
  }
  return right.id.localeCompare(left.id);
}

function emptyGroups(): Record<HandoffSection, HandoffCardView[]> {
  return { mine: [], watching: [], done: [] };
}

export function projectHandoffList(
  handoffs: HandoffRecord[],
  transfers: TransferRecord[],
  memberId: string | null | undefined,
  memberName: (memberId: string) => string,
  options: { v2LoadFailed?: boolean } = {},
): ProjectedHandoffList {
  const grouped = emptyGroups();
  let inconsistent = options.v2LoadFailed === true;
  const byHandoff = new Map<string, TransferRecord[]>();
  for (const hop of transfers) {
    const list = byHandoff.get(hop.handoffId) ?? [];
    list.push(hop);
    byHandoff.set(hop.handoffId, list);
  }

  for (const record of handoffs) {
    if (isLegacyHandoff(record)) {
      if (!record.status) {
        continue;
      }
      const role = handoffRole(record, memberId);
      if (!role) {
        continue;
      }
      const view = classifyHandoffView(record.status, role);
      if (!view) {
        continue;
      }
      const section = sectionFromLegacyView(view);
      const latest = latestFinalizedVersionNumber(record);
      grouped[section].push({
        id: record.id,
        section,
        filename: record.originalFilename,
        statusSentence: handoffStatusLabel(record.status),
        actionLabel: null,
        instruction: record.instruction,
        dueOn: record.dueOn,
        holderDisplayName: null,
        latestVersionNumber: latest,
        lastActivityAt: record.updatedAt,
        relevantNote: null,
        source: { kind: "legacy", record },
      });
      continue;
    }

    if (options.v2LoadFailed) {
      inconsistent = true;
      continue;
    }

    const hops = byHandoff.get(record.id) ?? [];
    const validated = validateTransferStack(record, hops);
    if (validated === HANDOFF_VIEW_INCONSISTENT) {
      inconsistent = true;
      continue;
    }
    if (!memberId) {
      continue;
    }
    const relation = viewerRelationFor(memberId, validated);
    if (!relation) {
      continue;
    }
    const source: TransferHandoffView = { ...validated, viewerRelation: relation };
    if (
      source.activeHop &&
      (source.activeHop.status === "preparing" || source.activeHop.status === "failed") &&
      relation !== "from"
    ) {
      inconsistent = true;
      continue;
    }
    const section = classifyTransferSection(source, memberId);
    if (!section) {
      continue;
    }
    const sentence = transferStatusSentence(source, memberName);
    if (sentence === HANDOFF_VIEW_INCONSISTENT) {
      inconsistent = true;
      continue;
    }
    const displayHop = source.activeHop ?? source.latestTransfer;
    const latestName =
      [...record.versions]
        .reverse()
        .map((version) => version.fileName?.trim())
        .find((name) => name) ?? null;
    grouped[section].push({
      id: record.id,
      section,
      filename: cardTitleFor(record, displayHop, latestName),
      statusSentence: sentence,
      actionLabel: actionLabelFor(displayHop.requestedAction),
      instruction: displayHop.instruction || record.instruction,
      dueOn: displayHop.dueOn ?? record.dueOn,
      holderDisplayName: source.holderMemberId
        ? memberName(source.holderMemberId)
        : null,
      latestVersionNumber: source.latestFinalizedVersion,
      lastActivityAt: lastActivityAtForV2(record, hops),
      relevantNote: displayHop.resultNote,
      source,
    });
  }

  for (const section of ["mine", "watching", "done"] as const) {
    grouped[section].sort(compareActivity);
  }

  return {
    cards: [...grouped.mine, ...grouped.watching, ...grouped.done],
    grouped,
    counts: {
      mine: grouped.mine.length,
      watching: grouped.watching.length,
      done: grouped.done.length,
    },
    inconsistent,
  };
}
