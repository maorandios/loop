import { useMemo, useState } from "react";
import { LtrValue } from "../../components/LtrValue";
import {
  handoffStatusLabel,
  he,
  returnFileToLabel,
} from "../../copy/he";
import { formatLocalDateTime } from "../../lib/dates";
import {
  groupHandoffsByView,
  handoffRole,
  viewCounts,
  type HandoffView,
} from "../handoff/buckets";
import { visibleHistory } from "../handoff/history";
import { canReturnFile } from "../handoff/reconciliation";
import {
  INSTRUCTION_MAX,
  REVISION_NOTE_MAX,
  normalizeDueOn,
  validateRevisionNote,
  validateSendForm,
} from "../handoff/sendForm";
import type {
  HandoffRecord,
  InboxLocalEntry,
  PickedFile,
  SendProgress,
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
  }) => void | Promise<void>;
  onDownloadAndOpen?: (handoff: HandoffRecord) => void | Promise<void>;
  onOpenLatest?: (handoff: HandoffRecord) => void | Promise<void>;
  onOpenFolder?: (handoffId: string, version?: string) => void | Promise<void>;
  onReturnFile?: (handoff: HandoffRecord) => void | Promise<void>;
  onCompleteHandoff?: (handoff: HandoffRecord) => void | Promise<void>;
  onRequestRevision?: (handoff: HandoffRecord, note: string) => void | Promise<void>;
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

const VIEWS: HandoffView[] = ["waiting_for_me", "waiting_for_others", "done"];

function viewLabel(view: HandoffView): string {
  if (view === "waiting_for_me") {
    return he.waitingForMe;
  }
  if (view === "waiting_for_others") {
    return he.waitingForOthers;
  }
  return he.done;
}

function emptyLabel(view: HandoffView): string {
  if (view === "waiting_for_me") {
    return he.noWaitingForMe;
  }
  if (view === "waiting_for_others") {
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
  onDownloadAndOpen,
  onOpenLatest,
  onOpenFolder,
  onReturnFile,
  onCompleteHandoff,
  onRequestRevision,
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
  const [activeView, setActiveView] = useState<HandoffView>("waiting_for_me");
  const [recipientId, setRecipientId] = useState(others[0]?.id ?? "");
  const [instruction, setInstruction] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  const [revisionFor, setRevisionFor] = useState<string | null>(null);
  const [revisionNote, setRevisionNote] = useState("");
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const reconciling = new Set(reconcilingIds);
  const watchFailed = new Set(watchFailedIds);
  const grouped = useMemo(
    () => groupHandoffsByView(handoffs, currentMemberId),
    [handoffs, currentMemberId],
  );
  const counts = useMemo(
    () => viewCounts(handoffs, currentMemberId),
    [handoffs, currentMemberId],
  );
  const visible = grouped[activeView];

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

        {!waiting && onSubmitSend ? (
          <section className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-3">
            <h2 className="text-sm font-medium">{he.sendFile}</h2>
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
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-500">{he.instructionLabel}</span>
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
                disabled={sendProgress === "sending"}
                onClick={onSend}
              >
                {sendProgress === "sending" ? he.handoffStatus.sending : he.send}
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
            visible.map((handoff) => {
              const role = handoffRole(handoff, currentMemberId);
              const local = workingLocal(inbox, handoff.id);
              const already = Boolean(local);
              const sender = memberName(members, handoff.senderMemberId);
              const recipient = memberName(members, handoff.recipientMemberId);
              const latest = latestHandoffVersion(handoff);
              const differs = local?.contentDiffersFromV1 === true;
              const pendingSync = local?.pendingStatusSync === true;
              const busy = reconciling.has(handoff.id);
              const returning = handoff.status === "returning" || returningId === handoff.id;
              const canReturn =
                role === "recipient" &&
                already &&
                canReturnFile({
                  contentDiffersFromV1: differs,
                  cloudStatus: handoff.status,
                  pendingStatusSync: pendingSync,
                  reconciling: busy,
                });
              const showSyncing =
                role === "recipient" &&
                already &&
                (differs || pendingSync || busy) &&
                !canReturn &&
                !returning &&
                handoff.status !== "returned" &&
                handoff.status !== "return_received" &&
                handoff.status !== "completed";
              const history = visibleHistory(handoff);
              const historyShown = historyOpen === handoff.id;
              const revisionOpen = revisionFor === handoff.id;
              const openVersion = latest ? versionLabel(latest.versionNumber) : local?.version;
              return (
                <article
                  key={handoff.id}
                  className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-3 text-sm"
                >
                  <div dir="auto" className="font-medium">
                    {handoff.originalFilename}
                  </div>
                  <div className="text-zinc-600">
                    {`${he.senderLabel}: `}
                    <span dir="auto">{sender}</span>
                    {` · ${he.recipientLabel}: `}
                    <span dir="auto">{recipient}</span>
                  </div>
                  {handoff.instruction ? (
                    <p dir="auto" className="text-zinc-800">
                      {handoff.instruction}
                    </p>
                  ) : null}
                  {handoff.dueOn ? (
                    <div className="text-zinc-600">{`${he.dueOnLabel}: ${formatDueOn(handoff.dueOn)}`}</div>
                  ) : null}
                  <div>{handoffStatusLabel(handoff.status)}</div>
                  <div className="text-zinc-600">
                    {formatLocalDateTime(new Date(handoff.updatedAt))}
                    {latest
                      ? ` · ${he.latestVersionLabel.replace("{version}", String(latest.versionNumber))}`
                      : ""}
                  </div>
                  {watchFailed.has(handoff.id) ? (
                    <p role="status" className="text-zinc-600">
                      {he.watchFailed}
                    </p>
                  ) : null}
                  {returning ? (
                    <div>{he.handoffStatus.returning}</div>
                  ) : showSyncing ? (
                    <div>{he.syncingChanges}</div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {role === "recipient" &&
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
                    {(role === "sender" &&
                      (handoff.status === "returned" ||
                        handoff.status === "completed" ||
                        handoff.status === "return_received")) ||
                    (role === "recipient" &&
                      (handoff.status === "completed" || handoff.status === "return_received")) ? (
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
                    {already && onOpenFolder && openVersion ? (
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
                    {canReturn && onReturnFile ? (
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
                    {role === "sender" && handoff.status === "returned" ? (
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
                          void onRequestRevision?.(handoff, revisionNote.trim());
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
