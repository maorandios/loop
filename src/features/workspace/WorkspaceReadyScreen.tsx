import { useMemo, useState } from "react";
import { LtrValue } from "../../components/LtrValue";
import {
  he,
  returnFileToLabel,
} from "../../copy/he";
import { formatLocalDateTime } from "../../lib/dates";
import { handoffRole } from "../handoff/buckets";
import { visibleHistory } from "../handoff/history";
import { canReturnFile } from "../handoff/reconciliation";
import { projectHandoffList } from "../handoff/view";
import {
  canCancelV2,
  canOpenV2,
  canRemind,
  cardRequestedAction,
  isFileRequestWithoutVersion,
  recipientPrimaryAction,
  senderReturnActions,
  workingFileChanged,
} from "../handoff/actions";
import {
  INSTRUCTION_MAX,
  REVISION_NOTE_MAX,
  normalizeDueOn,
  validateFileRequestForm,
  validateRevisionNote,
  validateSendForm,
} from "../handoff/sendForm";
import type {
  FormMode,
  HandoffRecord,
  HandoffSection,
  InboxLocalEntry,
  LocalWorkState,
  PickedFile,
  SendAction,
  SendProgress,
  TransferRecord,
} from "../handoff/types";
import { latestHandoffVersion, versionLabel } from "../handoff/versions";
import type { Workspace, WorkspaceMember } from "./types";

type WorkspaceReadyScreenProps = {
  workspace: Workspace;
  displayName: string;
  members: WorkspaceMember[];
  currentUserId?: string | null;
  currentDeviceId?: string | null;
  currentMemberId?: string | null;
  joinCode?: string | null;
  rotating?: boolean;
  error?: string | null;
  onRotateJoinCode?: () => void | Promise<void>;
  handoffs?: HandoffRecord[];
  transfers?: TransferRecord[];
  v2LoadFailed?: boolean;
  onRetryLoad?: () => void | Promise<void>;
  inbox?: InboxLocalEntry[];
  pickedFile?: PickedFile | null;
  sendProgress?: SendProgress;
  downloadingId?: string | null;
  returningId?: string | null;
  reconcilingIds?: string[];
  watchFailedIds?: string[];
  autostartEnabled?: boolean;
  onToggleAutostart?: (enabled: boolean) => void | Promise<void>;
  onPickFile?: () => void | Promise<void>;
  onCancelSend?: () => void | Promise<void>;
  onSubmitSend?: (input: {
    recipientMemberId: string;
    instruction: string;
    dueOn: string | null;
    requestedAction: SendAction;
  }) => void | Promise<void>;
  onSubmitFileRequest?: (input: {
    recipientMemberId: string;
    instruction: string;
    dueOn: string | null;
  }) => void | Promise<void>;
  onDownloadAndOpen?: (handoff: HandoffRecord) => void | Promise<void>;
  onOpenLatest?: (handoff: HandoffRecord) => void | Promise<void>;
  onOpenFolder?: (handoffId: string, version?: string) => void | Promise<void>;
  onReturnFile?: (handoff: HandoffRecord) => void | Promise<void>;
  onCompleteHandoff?: (handoff: HandoffRecord) => void | Promise<void>;
  onRequestRevision?: (handoff: HandoffRecord, note: string) => void | Promise<void>;
  onOpenV2?: (handoff: HandoffRecord) => void | Promise<void>;
  onApprove?: (handoff: HandoffRecord, note: string | null) => void | Promise<void>;
  onReject?: (handoff: HandoffRecord, note: string) => void | Promise<void>;
  onFinishReview?: (handoff: HandoffRecord, note: string | null) => void | Promise<void>;
  onReturnUpdate?: (handoff: HandoffRecord, note: string | null) => void | Promise<void>;
  onAttachFileRequest?: (handoff: HandoffRecord) => void | Promise<void>;
  onCannotProvide?: (handoff: HandoffRecord, note: string) => void | Promise<void>;
  onAcceptV2?: (handoff: HandoffRecord) => void | Promise<void>;
  onRevisionV2?: (handoff: HandoffRecord, note: string) => void | Promise<void>;
  onRemind?: (handoff: HandoffRecord) => void | Promise<void>;
  onCancelV2?: (handoff: HandoffRecord) => void | Promise<void>;
  onRetryLocal?: (handoffId: string) => void | Promise<void>;
  onAbortLocal?: (handoffId: string) => void | Promise<void>;
  onRestoreSnapshot?: (handoffId: string) => void | Promise<void>;
  localStates?: Record<string, LocalWorkState>;
  reminderNotice?: string | null;
  actionBusyId?: string | null;
};

function memberName(members: WorkspaceMember[], memberId: string): string {
  return members.find((member) => member.id === memberId)?.displayName ?? "";
}

function localFor(inbox: InboxLocalEntry[], handoffId: string): InboxLocalEntry[] {
  return inbox.filter((entry) => entry.handoffId === handoffId);
}

function workingLocal(inbox: InboxLocalEntry[], handoffId: string): InboxLocalEntry | undefined {
  const entries = localFor(inbox, handoffId);
  if (entries.length === 0) {
    return undefined;
  }
  return entries.reduce((latest, entry) => {
    const latestNum = Number(latest.version.replace(/^v/, ""));
    const entryNum = Number(entry.version.replace(/^v/, ""));
    return entryNum > latestNum ? entry : latest;
  });
}

function formatDueOn(dueOn: string): string {
  const date = new Date(`${dueOn}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return dueOn;
  }
  return new Intl.DateTimeFormat("he-IL", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

const VIEWS: HandoffSection[] = ["mine", "watching", "done"];

function viewLabel(view: HandoffSection): string {
  if (view === "mine") {
    return he.waitingForMe;
  }
  if (view === "watching") {
    return he.waitingForOthers;
  }
  return he.done;
}

function emptyLabel(view: HandoffSection): string {
  if (view === "mine") {
    return he.noWaitingForMe;
  }
  if (view === "watching") {
    return he.noWaitingForOthers;
  }
  return he.noDoneFiles;
}

export function WorkspaceReadyScreen({
  workspace,
  displayName,
  members,
  currentUserId = null,
  currentDeviceId = null,
  currentMemberId = null,
  joinCode = null,
  rotating = false,
  error = null,
  onRotateJoinCode,
  handoffs = [],
  transfers = [],
  v2LoadFailed = false,
  onRetryLoad,
  inbox = [],
  pickedFile = null,
  sendProgress = "idle",
  downloadingId = null,
  returningId = null,
  reconcilingIds = [],
  watchFailedIds = [],
  autostartEnabled = false,
  onToggleAutostart,
  onPickFile,
  onCancelSend,
  onSubmitSend,
  onSubmitFileRequest,
  onDownloadAndOpen,
  onOpenLatest,
  onOpenFolder,
  onReturnFile,
  onCompleteHandoff,
  onRequestRevision,
  onOpenV2,
  onApprove,
  onReject,
  onFinishReview,
  onReturnUpdate,
  onAttachFileRequest,
  onCannotProvide,
  onAcceptV2,
  onRevisionV2,
  onRemind,
  onCancelV2,
  onRetryLocal,
  onAbortLocal,
  onRestoreSnapshot,
  localStates = {},
  reminderNotice = null,
  actionBusyId = null,
}: WorkspaceReadyScreenProps) {
  const waiting = members.length < 2;
  const isCreator = currentUserId !== null && currentUserId === workspace.createdBy;
  const others = members.filter((member) => {
    const isLocal =
      (currentUserId !== null && member.userId === currentUserId) ||
      (currentDeviceId !== null && member.deviceId === currentDeviceId) ||
      (currentMemberId !== null && member.id === currentMemberId);
    return !isLocal;
  });
  const [copyError, setCopyError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<HandoffSection>("mine");
  const [recipientId, setRecipientId] = useState(others[0]?.id ?? "");
  const [formMode, setFormMode] = useState<FormMode>("send");
  const [requestedAction, setRequestedAction] = useState<SendAction>("approval");
  const [instruction, setInstruction] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [resultNoteFor, setResultNoteFor] = useState<string | null>(null);
  const [resultNote, setResultNote] = useState("");
  const [resultNoteError, setResultNoteError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  const [revisionFor, setRevisionFor] = useState<string | null>(null);
  const [revisionNote, setRevisionNote] = useState("");
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const reconciling = new Set(reconcilingIds);
  const watchFailed = new Set(watchFailedIds);
  const projected = useMemo(
    () =>
      projectHandoffList(
        handoffs,
        transfers,
        currentMemberId,
        (memberId) => memberName(members, memberId),
        { v2LoadFailed },
      ),
    [handoffs, transfers, currentMemberId, members, v2LoadFailed],
  );
  const grouped = projected.grouped;
  const counts = projected.counts;
  const visible = grouped[activeView];
  const showLoadBanner = projected.inconsistent;

  async function onCopyJoinCode() {
    if (!joinCode) {
      return;
    }
    try {
      await navigator.clipboard.writeText(joinCode);
      setCopyError(null);
    } catch {
      setCopyError(he.copyJoinCodeFailed);
    }
  }

  function sendErrorLabel(code: ReturnType<typeof validateSendForm>): string | null {
    if (code === "recipient_required") {
      return he.recipientRequired;
    }
    if (code === "file_required") {
      return he.fileRequired;
    }
    if (code === "instruction_required") {
      return he.cloudError.instruction_required;
    }
    if (code === "instruction_too_long") {
      return he.instructionTooLong;
    }
    return null;
  }

  function onSend() {
    const selected = recipientId || others[0]?.id || null;
    if (formMode === "file_request") {
      const problem = validateFileRequestForm({
        recipientMemberId: selected,
        instruction,
      });
      if (problem || !selected) {
        setFormError(sendErrorLabel(problem));
        return;
      }
      setFormError(null);
      void onSubmitFileRequest?.({
        recipientMemberId: selected,
        instruction: instruction.trim(),
        dueOn: normalizeDueOn(dueOn),
      });
      return;
    }
    const problem = validateSendForm({
      recipientMemberId: selected,
      instruction,
      picked: pickedFile,
    });
    if (problem || !selected) {
      setFormError(sendErrorLabel(problem));
      return;
    }
    setFormError(null);
    void onSubmitSend?.({
      recipientMemberId: selected,
      instruction: instruction.trim(),
      dueOn: normalizeDueOn(dueOn),
      requestedAction,
    });
  }

  function onClearForm() {
    setInstruction("");
    setDueOn("");
    setFormError(null);
    void onCancelSend?.();
  }

  return (
    <main className="flex min-h-dvh flex-col bg-zinc-50 px-4 py-5 text-zinc-900">
      <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-zinc-500">{he.brand}</p>
          <h1 className="text-xl font-semibold leading-snug">{he.workspaceReadyTitle}</h1>
          <p className="text-sm text-zinc-600" dir="auto">
            {workspace.name}
          </p>
          <p className="text-sm text-zinc-600" dir="auto">
            {displayName}
          </p>
        </div>

        {error || copyError || formError ? (
          <p role="alert" className="text-sm text-red-700">
            {error ?? copyError ?? formError}
          </p>
        ) : null}
        {reminderNotice ? (
          <p role="status" className="text-sm text-zinc-700">
            {reminderNotice}
          </p>
        ) : null}

        {!waiting && onSubmitSend ? (
          <section className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-3">
            <h2 className="text-sm font-medium">
              {formMode === "file_request" ? he.requestFile : he.sendForHandling}
            </h2>
            <div className="flex flex-col gap-1 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="form-mode"
                  checked={formMode === "send"}
                  onChange={() => {
                    setFormMode("send");
                    setFormError(null);
                  }}
                />
                <span>{he.sendForHandling}</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="form-mode"
                  checked={formMode === "file_request"}
                  onChange={() => {
                    setFormMode("file_request");
                    setFormError(null);
                  }}
                />
                <span>{he.requestFile}</span>
              </label>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-500">{he.recipientLabel}</span>
              <select
                className="rounded-md border border-zinc-300 bg-white px-2 py-1.5"
                value={recipientId || others[0]?.id || ""}
                onChange={(event) => {
                  setRecipientId(event.target.value);
                }}
              >
                {others.length === 0 ? (
                  <option value="">{he.chooseRecipient}</option>
                ) : null}
                {others.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.displayName}
                  </option>
                ))}
              </select>
            </label>
            {formMode === "send" ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm"
                    onClick={() => {
                      void onPickFile?.();
                    }}
                  >
                    {he.chooseFile}
                  </button>
                  {pickedFile ? (
                    <span className="text-sm" dir="auto">
                      {pickedFile.originalFilename}
                    </span>
                  ) : null}
                </div>
                <fieldset className="flex flex-col gap-1 text-sm">
                  <legend className="text-zinc-500">{he.sendFile}</legend>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="requested-action"
                      checked={requestedAction === "approval"}
                      onChange={() => {
                        setRequestedAction("approval");
                      }}
                    />
                    <span>{he.actionForApproval}</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="requested-action"
                      checked={requestedAction === "review"}
                      onChange={() => {
                        setRequestedAction("review");
                      }}
                    />
                    <span>{he.actionForReview}</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="requested-action"
                      checked={requestedAction === "update"}
                      onChange={() => {
                        setRequestedAction("update");
                      }}
                    />
                    <span>{he.actionForUpdate}</span>
                  </label>
                </fieldset>
              </>
            ) : null}
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-500">
                {formMode === "file_request" ? he.fileDescriptionLabel : he.instructionLabel}
              </span>
              <textarea
                className="min-h-16 rounded-md border border-zinc-300 px-2 py-1.5"
                maxLength={INSTRUCTION_MAX}
                value={instruction}
                onChange={(event) => {
                  setInstruction(event.target.value);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-500">{he.dueOnLabel}</span>
              <input
                type="date"
                className="rounded-md border border-zinc-300 px-2 py-1.5"
                value={dueOn}
                onChange={(event) => {
                  setDueOn(event.target.value);
                }}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-60"
                disabled={
                  sendProgress === "sending" ||
                  sendProgress === "uploading" ||
                  sendProgress === "finalizing"
                }
                onClick={onSend}
              >
                {sendProgress === "sending"
                  ? he.handoffStatus.sending
                  : sendProgress === "uploading"
                    ? he.uploadingFile
                    : sendProgress === "finalizing"
                      ? he.finishingRequest
                      : he.send}
              </button>
              <button
                type="button"
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm"
                onClick={onClearForm}
              >
                {he.cancel}
              </button>
            </div>
          </section>
        ) : waiting ? (
          <p className="text-sm text-zinc-600">{he.waitingForMembers}</p>
        ) : null}

        {showLoadBanner ? (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-3 text-sm">
            <p>{he.partialRequestsFailed}</p>
            {onRetryLoad ? (
              <button
                type="button"
                className="self-start rounded-md border border-zinc-300 bg-white px-3 py-1.5"
                onClick={() => {
                  void onRetryLoad();
                }}
              >
                {he.tryAgain}
              </button>
            ) : null}
          </div>
        ) : null}

        <div role="tablist" className="grid grid-cols-3 gap-1 rounded-lg bg-zinc-200 p-1 text-sm">
          {VIEWS.map((view) => (
            <button
              key={view}
              type="button"
              role="tab"
              aria-selected={activeView === view}
              className={`rounded-md px-1 py-1.5 leading-tight ${
                activeView === view ? "bg-white font-medium shadow-sm" : "text-zinc-600"
              }`}
              onClick={() => {
                setActiveView(view);
              }}
            >
              {`${viewLabel(view)} ${counts[view]}`}
            </button>
          ))}
        </div>

        <section className="flex flex-col gap-3">
          {visible.length === 0 ? (
            <p className="text-sm text-zinc-600">{emptyLabel(activeView)}</p>
          ) : (
            visible.map((card) => {
              const handoff = card.source.record;
              const isLegacy = card.source.kind === "legacy";
              const role = isLegacy ? handoffRole(handoff, currentMemberId) : null;
              const local = workingLocal(inbox, handoff.id);
              const already = Boolean(local);
              const sender = memberName(members, handoff.senderMemberId);
              const recipient = memberName(members, handoff.recipientMemberId);
              const latest = latestHandoffVersion(handoff);
              const differs = local?.contentDiffersFromV1 === true;
              const pendingSync = local?.pendingStatusSync === true;
              const busy = reconciling.has(handoff.id);
              const returning =
                isLegacy && (handoff.status === "returning" || returningId === handoff.id);
              const canReturn =
                isLegacy &&
                role === "recipient" &&
                already &&
                handoff.status !== null &&
                canReturnFile({
                  contentDiffersFromV1: differs,
                  cloudStatus: handoff.status,
                  pendingStatusSync: pendingSync,
                  reconciling: busy,
                });
              const showSyncing =
                isLegacy &&
                role === "recipient" &&
                already &&
                (differs || pendingSync || busy) &&
                !canReturn &&
                !returning &&
                handoff.status !== "returned" &&
                handoff.status !== "return_received" &&
                handoff.status !== "completed";
              const history = visibleHistory(handoff, {
                requestedAction: cardRequestedAction(card),
              });
              const localWork = localStates[handoff.id] ?? "idle";
              const v2Source = card.source.kind === "transfer" ? card.source : null;
              const v2Busy = actionBusyId === handoff.id || localWork === "sending" || localWork === "uploading" || localWork === "finalizing" || localWork === "resuming" || localWork === "aborting";
              const primary = v2Source && currentMemberId
                ? recipientPrimaryAction(v2Source, currentMemberId)
                : null;
              const senderActs = v2Source && currentMemberId
                ? senderReturnActions(v2Source, currentMemberId)
                : { accept: false, revision: false, fileRequestWording: false };
              const showOpenV2 = Boolean(
                v2Source &&
                  currentMemberId &&
                  onOpenV2 &&
                  canOpenV2(v2Source, currentMemberId),
              );
              const showRemind = Boolean(
                v2Source && currentMemberId && onRemind && canRemind(v2Source, currentMemberId),
              );
              const showCancel = Boolean(
                v2Source && currentMemberId && onCancelV2 && canCancelV2(v2Source, currentMemberId),
              );
              const fileRequestPending = Boolean(
                v2Source && isFileRequestWithoutVersion(v2Source),
              );
              const changed = workingFileChanged(inbox, handoff.id);
              const historyShown = historyOpen === handoff.id;
              const revisionOpen = revisionFor === handoff.id;
              const openVersion = latest ? versionLabel(latest.versionNumber) : local?.version;
              return (
                <article
                  key={handoff.id}
                  className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-3 text-sm"
                >
                  <div dir="auto" className="font-medium">
                    {card.filename}
                  </div>
                  <div className="text-zinc-600">
                    {`${he.senderLabel}: `}
                    <span dir="auto">{sender}</span>
                    {` · ${he.recipientLabel}: `}
                    <span dir="auto">{recipient}</span>
                  </div>
                  {card.instruction ? (
                    <p dir="auto" className="text-zinc-800">
                      {card.instruction}
                    </p>
                  ) : null}
                  {card.dueOn ? (
                    <div className="text-zinc-600">{`${he.dueOnLabel}: ${formatDueOn(card.dueOn)}`}</div>
                  ) : null}
                  <div>{card.statusSentence}</div>
                  {card.actionLabel ? (
                    <div className="text-zinc-600">{card.actionLabel}</div>
                  ) : null}
                  {card.holderDisplayName ? (
                    <div className="text-zinc-600">
                      {`${he.currentHolderLabel}: `}
                      <span dir="auto">{card.holderDisplayName}</span>
                    </div>
                  ) : null}
                  {card.relevantNote ? (
                    <p dir="auto" className="text-zinc-800">
                      {card.relevantNote}
                    </p>
                  ) : null}
                  <div className="text-zinc-600">
                    {formatLocalDateTime(new Date(card.lastActivityAt))}
                    {card.latestVersionNumber
                      ? ` · ${he.latestVersionLabel.replace("{version}", String(card.latestVersionNumber))}`
                      : ""}
                  </div>
                  {watchFailed.has(handoff.id) ? (
                    <p role="status" className="text-zinc-600">
                      {he.watchFailed}
                    </p>
                  ) : null}
                  {localWork === "sending" ? <div>{he.handoffStatus.sending}</div> : null}
                  {localWork === "uploading" ? <div>{he.uploadingFile}</div> : null}
                  {localWork === "finalizing" ? <div>{he.finishingRequest}</div> : null}
                  {localWork === "resuming" ? <div>{he.resumingUpload}</div> : null}
                  {localWork === "waiting_reselect" ? <div>{he.waitingForOriginalFile}</div> : null}
                  {localWork === "file_changed" ? <div>{he.fileChangedDuringUpload}</div> : null}
                  {localWork === "offline" ? <div>{he.cannotConnectNow}</div> : null}
                  {returning ? (
                    <div>{he.handoffStatus.returning}</div>
                  ) : showSyncing ? (
                    <div>{he.syncingChanges}</div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {isLegacy &&
                    role === "recipient" &&
                    handoff.status !== "completed" &&
                    handoff.status !== "return_received" ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                        disabled={returning || downloadingId === handoff.id || !onDownloadAndOpen}
                        onClick={() => {
                          void onDownloadAndOpen?.(handoff);
                        }}
                      >
                        {already ? he.open : he.downloadAndOpen}
                      </button>
                    ) : null}
                    {isLegacy &&
                    ((role === "sender" &&
                      (handoff.status === "returned" ||
                        handoff.status === "completed" ||
                        handoff.status === "return_received")) ||
                    (role === "recipient" &&
                      (handoff.status === "completed" || handoff.status === "return_received"))) ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                        disabled={returning || downloadingId === handoff.id || !onOpenLatest}
                        onClick={() => {
                          void onOpenLatest?.(handoff);
                        }}
                      >
                        {already ? he.open : he.downloadAndOpen}
                      </button>
                    ) : null}
                    {isLegacy && already && onOpenFolder && openVersion ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                        disabled={returning}
                        onClick={() => {
                          void onOpenFolder(handoff.id, openVersion);
                        }}
                      >
                        {he.openFolder}
                      </button>
                    ) : null}
                    {isLegacy && canReturn && onReturnFile ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                        disabled={returning}
                        onClick={() => {
                          void onReturnFile(handoff);
                        }}
                      >
                        {returnFileToLabel(sender)}
                      </button>
                    ) : null}
                    {v2Source && showOpenV2 && !fileRequestPending ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                        disabled={v2Busy || downloadingId === handoff.id}
                        onClick={() => {
                          void onOpenV2?.(handoff);
                        }}
                      >
                        {already ? he.open : senderActs.accept ? he.openLatestVersion : he.downloadAndOpen}
                      </button>
                    ) : null}
                    {primary === "approve" && onApprove ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                        disabled={v2Busy}
                        onClick={() => {
                          if (changed && !window.confirm(he.fileChangedConfirm)) {
                            return;
                          }
                          void onApprove(handoff, resultNoteFor === handoff.id ? resultNote.trim() || null : null);
                        }}
                      >
                        {he.approve}
                      </button>
                    ) : null}
                    {primary === "review" && onFinishReview ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                        disabled={v2Busy}
                        onClick={() => {
                          void onFinishReview(
                            handoff,
                            resultNoteFor === handoff.id ? resultNote.trim() || null : null,
                          );
                        }}
                      >
                        {he.finishReview}
                      </button>
                    ) : null}
                    {primary === "update" && onReturnUpdate ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                        disabled={v2Busy}
                        onClick={() => {
                          if (!changed) {
                            setResultNoteFor(handoff.id);
                            setResultNoteError(null);
                            return;
                          }
                          void onReturnUpdate(
                            handoff,
                            resultNoteFor === handoff.id ? resultNote.trim() || null : null,
                          );
                        }}
                      >
                        {he.returnUpdate}
                      </button>
                    ) : null}
                    {(primary === "approve" || primary === "review" || primary === "update") && onReject ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                        disabled={v2Busy}
                        onClick={() => {
                          setResultNoteFor(handoff.id);
                          setResultNote("");
                          setResultNoteError(null);
                        }}
                      >
                        {he.reject}
                      </button>
                    ) : null}
                    {primary === "attach" && onAttachFileRequest ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                        disabled={v2Busy}
                        onClick={() => {
                          void onAttachFileRequest(handoff);
                        }}
                      >
                        {he.attachAndSend}
                      </button>
                    ) : null}
                    {primary === "attach" && onCannotProvide ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                        disabled={v2Busy}
                        onClick={() => {
                          setResultNoteFor(handoff.id);
                          setResultNote("");
                          setResultNoteError(null);
                        }}
                      >
                        {he.cannotProvide}
                      </button>
                    ) : null}
                    {senderActs.accept && onAcceptV2 ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                        disabled={v2Busy}
                        onClick={() => {
                          void onAcceptV2(handoff);
                        }}
                      >
                        {he.acceptAndClose}
                      </button>
                    ) : null}
                    {senderActs.revision ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                        disabled={v2Busy}
                        onClick={() => {
                          setRevisionFor(handoff.id);
                          setRevisionNote("");
                          setRevisionError(null);
                        }}
                      >
                        {senderActs.fileRequestWording ? he.requestOtherFile : he.requestRevision}
                      </button>
                    ) : null}
                    {showRemind ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                        disabled={v2Busy}
                        onClick={() => {
                          void onRemind?.(handoff);
                        }}
                      >
                        {he.sendReminder}
                      </button>
                    ) : null}
                    {showCancel ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                        disabled={v2Busy}
                        onClick={() => {
                          void onCancelV2?.(handoff);
                        }}
                      >
                        {he.cancelRequest}
                      </button>
                    ) : null}
                    {localWork === "retry" || localWork === "offline" ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5"
                        onClick={() => {
                          void onRetryLocal?.(handoff.id);
                        }}
                      >
                        {he.tryAgain}
                      </button>
                    ) : null}
                    {localWork === "waiting_reselect" ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5"
                        onClick={() => {
                          void onRestoreSnapshot?.(handoff.id);
                        }}
                      >
                        {he.chooseFile}
                      </button>
                    ) : null}
                    {localWork !== "idle" && onAbortLocal ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5"
                        onClick={() => {
                          void onAbortLocal(handoff.id);
                        }}
                      >
                        {he.abortAttempt}
                      </button>
                    ) : null}
                    {isLegacy && role === "sender" && handoff.status === "returned" ? (
                      <>
                        <button
                          type="button"
                          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                          disabled={returning || !onCompleteHandoff}
                          onClick={() => {
                            void onCompleteHandoff?.(handoff);
                          }}
                        >
                          {he.approveAndComplete}
                        </button>
                        <button
                          type="button"
                          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 disabled:opacity-60"
                          disabled={returning}
                          onClick={() => {
                            setRevisionFor(handoff.id);
                            setRevisionNote("");
                            setRevisionError(null);
                          }}
                        >
                          {he.requestRevision}
                        </button>
                      </>
                    ) : null}
                  </div>
                  {resultNoteFor === handoff.id ? (
                    <div className="flex flex-col gap-2">
                      <label className="flex flex-col gap-1">
                        <span className="text-zinc-500">
                          {primary === "update" ? he.replyLabel : primary === "attach" ? he.rejectReasonLabel : he.optionalNoteLabel}
                        </span>
                        <textarea
                          className="min-h-16 rounded-md border border-zinc-300 px-2 py-1.5"
                          maxLength={REVISION_NOTE_MAX}
                          value={resultNote}
                          onChange={(event) => {
                            setResultNote(event.target.value);
                          }}
                        />
                      </label>
                      {resultNoteError ? (
                        <p role="alert" className="text-red-700">
                          {resultNoteError}
                        </p>
                      ) : null}
                      <button
                        type="button"
                        className="self-start rounded-md bg-zinc-900 px-3 py-1.5 text-white"
                        onClick={() => {
                          const trimmed = resultNote.trim();
                          const needsNote =
                            primary === "attach" ||
                            primary === "approve" ||
                            primary === "review" ||
                            (primary === "update" && !changed);
                          if (needsNote && !trimmed) {
                            setResultNoteError(
                              primary === "update" ? he.replyRequired : he.resultNoteRequired,
                            );
                            return;
                          }
                          if (trimmed.length > REVISION_NOTE_MAX) {
                            setResultNoteError(he.revisionNoteTooLong);
                            return;
                          }
                          setResultNoteError(null);
                          if (primary === "attach") {
                            void onCannotProvide?.(handoff, trimmed);
                          } else if (primary === "update") {
                            void onReturnUpdate?.(handoff, trimmed);
                          } else {
                            void onReject?.(handoff, trimmed);
                          }
                          setResultNoteFor(null);
                        }}
                      >
                        {primary === "attach" ? he.cannotProvide : primary === "update" ? he.returnUpdate : he.reject}
                      </button>
                    </div>
                  ) : null}
                  {revisionOpen ? (
                    <div className="flex flex-col gap-2">
                      <label className="flex flex-col gap-1">
                        <span className="text-zinc-500">{he.revisionNoteLabel}</span>
                        <textarea
                          className="min-h-16 rounded-md border border-zinc-300 px-2 py-1.5"
                          maxLength={REVISION_NOTE_MAX}
                          value={revisionNote}
                          onChange={(event) => {
                            setRevisionNote(event.target.value);
                          }}
                        />
                      </label>
                      {revisionError ? (
                        <p role="alert" className="text-red-700">
                          {revisionError}
                        </p>
                      ) : null}
                      <button
                        type="button"
                        className="self-start rounded-md bg-zinc-900 px-3 py-1.5 text-white"
                        onClick={() => {
                          const problem = validateRevisionNote(revisionNote);
                          if (problem === "revision_note_required") {
                            setRevisionError(he.cloudError.revision_note_required);
                            return;
                          }
                          if (problem === "revision_note_too_long") {
                            setRevisionError(he.revisionNoteTooLong);
                            return;
                          }
                          setRevisionError(null);
                          if (v2Source) {
                            void onRevisionV2?.(handoff, revisionNote.trim());
                          } else {
                            void onRequestRevision?.(handoff, revisionNote.trim());
                          }
                          setRevisionFor(null);
                        }}
                      >
                        {he.confirmRevision}
                      </button>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="self-start text-zinc-600 underline"
                    onClick={() => {
                      setHistoryOpen(historyShown ? null : handoff.id);
                    }}
                  >
                    {historyShown ? he.hideHistory : he.showHistory}
                  </button>
                  {historyShown ? (
                    <ol className="flex flex-col gap-2 border-t border-zinc-100 pt-2">
                      {history.map((line, index) => (
                        <li key={`${handoff.id}-${line.eventType}-${index}`}>
                          <div>{line.title}</div>
                          {line.detail ? (
                            <div dir="auto" className="text-zinc-700">
                              {line.detail}
                            </div>
                          ) : null}
                          <div className="text-zinc-500">
                            {line.actorMemberId
                              ? memberName(members, line.actorMemberId)
                              : ""}
                            {line.createdAt
                              ? ` · ${formatLocalDateTime(new Date(line.createdAt))}`
                              : ""}
                          </div>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </article>
              );
            })
          )}
        </section>

        <section className="flex flex-col gap-2 border-t border-zinc-200 pt-3">
          <h2 className="text-sm font-medium text-zinc-500">{he.settings}</h2>
          {joinCode ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-500">{he.joinCodeLabel}</span>
                <LtrValue>{joinCode}</LtrValue>
              </div>
              <button
                type="button"
                className="self-start rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm"
                onClick={() => {
                  void onCopyJoinCode();
                }}
              >
                {he.copyJoinCode}
              </button>
            </div>
          ) : isCreator ? (
            <button
              type="button"
              className="self-start rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm disabled:opacity-60"
              disabled={rotating || !onRotateJoinCode}
              onClick={() => {
                void onRotateJoinCode?.();
              }}
            >
              {rotating ? he.creatingJoinCode : he.createNewJoinCode}
            </button>
          ) : null}
          {onToggleAutostart ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autostartEnabled}
                onChange={(event) => {
                  void onToggleAutostart(event.target.checked);
                }}
              />
              <span>{he.autostartLabel}</span>
            </label>
          ) : null}
          <p className="text-xs text-zinc-500">{he.membersLabel}</p>
          <ul className="text-sm">
            {members.map((member) => {
              const isLocal =
                (currentUserId !== null && member.userId === currentUserId) ||
                (currentDeviceId !== null && member.deviceId === currentDeviceId) ||
                (currentMemberId !== null && member.id === currentMemberId);
              return (
                <li key={member.id}>
                  <span dir="auto">{member.displayName}</span>
                  {isLocal ? <span>{` — ${he.thisComputer}`}</span> : null}
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </main>
  );
}
