import { useEffect, useMemo, useRef, useState } from "react";
import { FileName } from "../../components/FileName";
import { LtrValue } from "../../components/LtrValue";
import { he, returnFileToLabel } from "../../copy/he";
import { FluentIcon, type IconName } from "../../icons/fluent";
import { formatRelativeTime } from "../../lib/dates";
import { ThemeProvider, useTheme } from "../../theme/ThemeProvider";
import { handoffRole } from "../handoff/buckets";
import { visibleHistory } from "../handoff/history";
import {
  EMPTY_INBOX_FILTER,
  isInboxFilterActive,
  type InboxExtraFilter,
} from "../handoff/inboxList";
import {
  PRIMARY_VIEWS,
  primaryCounts,
  visibleListItems,
  type PrimaryView,
} from "../handoff/mailbox";
import {
  buildDesignInbox,
  mergeDesignMembers,
  shouldUseDesignCards,
  withDesignEmails,
} from "../handoff/designCards";
import { canReturnFile } from "../handoff/reconciliation";
import { projectHandoffList } from "../handoff/view";
import { FilterPopover } from "./FilterPopover";
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
  counterpartHandle,
  presentHandoffCard,
  resolveCardPrimary,
} from "../handoff/cardPresentation";
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
  InboxLocalEntry,
  LocalWorkState,
  PickedFile,
  SendAction,
  SendProgress,
  TransferRecord,
} from "../handoff/types";
import { latestHandoffVersion } from "../handoff/versions";
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
  connected?: boolean;
};

function memberName(members: WorkspaceMember[], memberId: string): string {
  return members.find((member) => member.id === memberId)?.displayName ?? "";
}

function memberEmail(members: WorkspaceMember[], memberId: string): string | null {
  const email = members.find((member) => member.id === memberId)?.email?.trim();
  return email || null;
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

function btnClass(isPrimary: boolean, danger = false): string {
  if (isPrimary) {
    return "fr-btn fr-btn-primary";
  }
  if (danger) {
    return "fr-btn fr-btn-danger-ghost";
  }
  return "fr-btn fr-btn-secondary";
}

function motionDuration(ms: number): number {
  if (import.meta.env.MODE === "test") {
    return 0;
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return 0;
  }
  return ms;
}

function runAfterMotion(ms: number, fn: () => void) {
  const wait = motionDuration(ms);
  if (wait <= 0) {
    fn();
    return;
  }
  window.setTimeout(fn, wait);
}

const TABS: PrimaryView[] = PRIMARY_VIEWS;

function tabLabel(tab: PrimaryView): string {
  if (tab === "action") {
    return he.primaryAction;
  }
  if (tab === "info") {
    return he.primaryInfo;
  }
  return he.primaryCompleted;
}

function tabIcon(tab: PrimaryView): IconName {
  if (tab === "action") {
    return "mailInboxArrowDown";
  }
  if (tab === "info") {
    return "mailInboxArrowUp";
  }
  return "mailInboxCheckmark";
}

function emptyLabel(tab: PrimaryView): string {
  if (tab === "action") {
    return he.noPrimaryAction;
  }
  if (tab === "info") {
    return he.noPrimaryInfo;
  }
  return he.noPrimaryCompleted;
}

export function WorkspaceReadyScreen(props: WorkspaceReadyScreenProps) {
  return (
    <ThemeProvider>
      <WorkspaceReadyView {...props} />
    </ThemeProvider>
  );
}

function WorkspaceReadyView({
  workspace,
  displayName,
  members: liveMembers,
  currentUserId = null,
  currentDeviceId = null,
  currentMemberId = null,
  joinCode = null,
  rotating = false,
  error = null,
  onRotateJoinCode,
  handoffs: liveHandoffs = [],
  transfers: liveTransfers = [],
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
  const designInbox = useMemo(() => {
    if (!shouldUseDesignCards() || !currentMemberId) {
      return null;
    }
    const roster = withDesignEmails(
      mergeDesignMembers(workspace.id, currentMemberId, liveMembers),
      currentMemberId,
    );
    const partner = roster.find((member) => member.id !== currentMemberId);
    if (!partner) {
      return null;
    }
    return {
      members: roster,
      ...buildDesignInbox({
        workspaceId: workspace.id,
        meId: currentMemberId,
        partnerId: partner.id,
      }),
    };
  }, [currentMemberId, liveMembers, workspace.id]);
  const members = designInbox?.members ?? liveMembers;
  const handoffs = designInbox?.handoffs ?? liveHandoffs;
  const transfers = designInbox?.transfers ?? liveTransfers;
  const waiting = members.length < 2;
  const isCreator = currentUserId !== null && currentUserId === workspace.createdBy;
  const others = members.filter((member) => {
    const isLocal =
      (currentUserId !== null && member.userId === currentUserId) ||
      (currentDeviceId !== null && member.deviceId === currentDeviceId) ||
      (currentMemberId !== null && member.id === currentMemberId);
    return !isLocal;
  });
  const { pref: themePref, setPref: setThemePref } = useTheme();
  const [copyError, setCopyError] = useState<string | null>(null);
  const [primaryView, setPrimaryView] = useState<PrimaryView>("action");
  const [extraFilter, setExtraFilter] = useState<InboxExtraFilter>(EMPTY_INBOX_FILTER);
  const [draftFilter, setDraftFilter] = useState<InboxExtraFilter>(EMPTY_INBOX_FILTER);
  const [filterOpen, setFilterOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [screenLeaving, setScreenLeaving] = useState(false);
  const [composeLeaving, setComposeLeaving] = useState(false);
  const listScrollRef = useRef<HTMLElement | null>(null);
  const listScrollTop = useRef(0);
  const detailTitleRef = useRef<HTMLHeadingElement | null>(null);
  const settingsTitleRef = useRef<HTMLHeadingElement | null>(null);
  const openedFromCard = useRef<HTMLElement | null>(null);
  const openedFromId = useRef<string | null>(null);
  const composeRef = useRef<HTMLDivElement | null>(null);
  const composeFirstRef = useRef<HTMLSelectElement | null>(null);
  const settingsScreenRef = useRef<HTMLElement | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const composeTriggerRef = useRef<HTMLButtonElement | null>(null);
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
  const [composeOpen, setComposeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const tabCounts = primaryCounts(projected, currentMemberId, (handoffId) =>
    localStates[handoffId] ?? "idle",
  );
  const visibleItems = visibleListItems({
    projected,
    primaryView,
    extraFilter,
    memberId: currentMemberId,
    localWorkOf: (handoffId) => localStates[handoffId] ?? "idle",
  });
  const detailCard = detailId
    ? (projected.cards.find((card) => card.id === detailId) ?? null)
    : null;
  const showLoadBanner = projected.inconsistent;
  const sending =
    sendProgress === "sending" || sendProgress === "uploading" || sendProgress === "finalizing";
  const bannerError = error ?? copyError;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      if (resultNoteFor) {
        setResultNoteFor(null);
        return;
      }
      if (revisionFor) {
        setRevisionFor(null);
        return;
      }
      if (filterOpen) {
        setFilterOpen(false);
        return;
      }
      if (composeOpen) {
        closeCompose();
        return;
      }
      if (settingsOpen) {
        closeSettings();
        return;
      }
      if (detailId) {
        closeDetail();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composeOpen, detailId, filterOpen, resultNoteFor, revisionFor, settingsOpen]);

  useEffect(() => {
    if (detailId && !screenLeaving) {
      detailTitleRef.current?.focus();
    }
  }, [detailId, screenLeaving]);

  useEffect(() => {
    if (settingsOpen && !screenLeaving) {
      settingsTitleRef.current?.focus();
    }
  }, [settingsOpen, screenLeaving]);

  useEffect(() => {
    if (composeOpen && !composeLeaving) {
      composeFirstRef.current?.focus();
    }
  }, [composeOpen, composeLeaving]);

  useEffect(() => {
    if (detailId || settingsOpen) {
      return;
    }
    const node = listScrollRef.current;
    if (node) {
      node.scrollTop = listScrollTop.current;
    }
    const card = openedFromId.current
      ? document.querySelector<HTMLElement>(`[data-handoff-id="${openedFromId.current}"]`)
      : null;
    card?.focus();
  }, [detailId, settingsOpen]);

  useEffect(() => {
    const root = composeOpen ? composeRef.current : settingsOpen ? settingsScreenRef.current : null;
    if (!root) {
      return;
    }
    function onTab(event: KeyboardEvent) {
      if (event.key !== "Tab" || !root) {
        return;
      }
      const items = [
        ...root.querySelectorAll<HTMLElement>(
          "a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex='-1'])",
        ),
      ].filter((el) => el.offsetParent !== null);
      if (items.length === 0) {
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    root.addEventListener("keydown", onTab);
    return () => root.removeEventListener("keydown", onTab);
  }, [composeOpen, settingsOpen]);

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

  function closeCompose() {
    const finish = () => {
      onClearForm();
      setComposeOpen(false);
      setComposeLeaving(false);
      composeTriggerRef.current?.focus();
    };
    if (motionDuration(260) === 0) {
      finish();
      return;
    }
    setComposeLeaving(true);
    runAfterMotion(260, finish);
  }

  function openDetail(id: string, from?: HTMLElement | null) {
    if (listScrollRef.current) {
      listScrollTop.current = listScrollRef.current.scrollTop;
    }
    openedFromCard.current = from ?? null;
    openedFromId.current = id;
    setDetailId(id);
  }

  function closeDetail() {
    const finish = () => {
      setDetailId(null);
      setScreenLeaving(false);
    };
    if (motionDuration(240) === 0) {
      finish();
      return;
    }
    setScreenLeaving(true);
    runAfterMotion(240, finish);
  }

  function closeSettings() {
    const finish = () => {
      setSettingsOpen(false);
      setScreenLeaving(false);
      window.requestAnimationFrame(() => {
        settingsTriggerRef.current?.focus();
      });
    };
    if (motionDuration(240) === 0) {
      finish();
      return;
    }
    setScreenLeaving(true);
    runAfterMotion(240, finish);
  }

  return (
    <main className="fr-shell">
      <header className="fr-header fr-sticky">
        <div className="fr-brand">
          <span className="fr-brand-mark">
            <FluentIcon name="document" size={16} />
          </span>
          <div className="fr-brand-text">
            <div className="fr-brand-name">
              <h1 className="fr-sheet-title" style={{ fontSize: 15 }}>
                {he.appName}
              </h1>
            </div>
          </div>
        </div>
        <div className="fr-header-tools">
          {!waiting && onSubmitSend ? (
            <button
              type="button"
              className="fr-icon-btn fr-icon-btn-accent"
              aria-label={he.newRequest}
              ref={composeTriggerRef}
              onClick={() => {
                setComposeOpen(true);
              }}
            >
              <FluentIcon name="add" />
            </button>
          ) : null}
          {!detailCard && !settingsOpen ? (
            <div className="fr-filter-wrap">
              <button
                type="button"
                className="fr-icon-btn"
                aria-label={he.filterRequests}
                aria-expanded={filterOpen}
                onClick={() => {
                  setDraftFilter(extraFilter);
                  setFilterOpen((open) => !open);
                }}
              >
                <FluentIcon name="filter" />
              </button>
              {isInboxFilterActive(extraFilter) ? <span className="fr-filter-dot" /> : null}
              {filterOpen ? (
                <FilterPopover
                  filter={draftFilter}
                  members={members}
                  onChange={setDraftFilter}
                  onApply={() => {
                    setExtraFilter(draftFilter);
                    setFilterOpen(false);
                  }}
                  onClear={() => {
                    setDraftFilter(EMPTY_INBOX_FILTER);
                    setExtraFilter(EMPTY_INBOX_FILTER);
                    setFilterOpen(false);
                  }}
                />
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            className="fr-icon-btn"
            aria-label={he.settings}
            ref={settingsTriggerRef}
            onClick={() => {
              if (listScrollRef.current) {
                listScrollTop.current = listScrollRef.current.scrollTop;
              }
              setDetailId(null);
              setSettingsOpen(true);
            }}
          >
            <FluentIcon name="settings" />
          </button>
        </div>
      </header>

      <div className="fr-main">
        {bannerError || reminderNotice ? (
          <div
            role={bannerError ? "alert" : "status"}
            className={`fr-banner${bannerError ? " fr-banner-error" : ""}`}
          >
            <p>{bannerError ?? reminderNotice}</p>
          </div>
        ) : null}

        {waiting && !settingsOpen && !detailCard ? (
          <p className="fr-hint">{he.waitingForMembers}</p>
        ) : null}

        {showLoadBanner ? (
          <div role="alert" className="fr-banner fr-banner-error">
            <p>{he.partialRequestsFailed}</p>
            {onRetryLoad ? (
              <button
                type="button"
                className="fr-btn fr-btn-secondary"
                onClick={() => {
                  void onRetryLoad();
                }}
              >
                {he.tryAgain}
              </button>
            ) : null}
          </div>
        ) : null}

        {settingsOpen ? (
          <section
            ref={settingsScreenRef}
            className={`fr-screen${screenLeaving ? " fr-leaving" : " fr-screen-in"}`}
          >
            <div className="fr-page-head">
              <button
                type="button"
                className="fr-icon-btn"
                aria-label={he.back}
                onClick={closeSettings}
              >
                <FluentIcon name="chevronLeft" rtlFlip />
              </button>
              <h2 id="settings-title" ref={settingsTitleRef} tabIndex={-1}>
                {he.settings}
              </h2>
              <span style={{ width: 36 }} />
            </div>
            <div className="fr-scroll">
              <div className="fr-field-wrap">
                <span className="fr-label">{he.themeLabel}</span>
                <div className="fr-theme-options">
                  <label>
                    <input
                      type="radio"
                      name="theme-pref"
                      checked={themePref === "system"}
                      onChange={() => {
                        setThemePref("system");
                      }}
                    />
                    <span>{he.themeSystem}</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="theme-pref"
                      checked={themePref === "light"}
                      onChange={() => {
                        setThemePref("light");
                      }}
                    />
                    <span>{he.themeLight}</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="theme-pref"
                      checked={themePref === "dark"}
                      onChange={() => {
                        setThemePref("dark");
                      }}
                    />
                    <span>{he.themeDark}</span>
                  </label>
                </div>
              </div>
              {joinCode ? (
                <div className="fr-field-wrap">
                  <span className="fr-label">{he.joinCodeLabel}</span>
                  <LtrValue>{joinCode}</LtrValue>
                  <button
                    type="button"
                    className="fr-btn fr-btn-secondary"
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
                  className="fr-btn fr-btn-secondary"
                  disabled={rotating || !onRotateJoinCode}
                  onClick={() => {
                    void onRotateJoinCode?.();
                  }}
                >
                  {rotating ? he.creatingJoinCode : he.createNewJoinCode}
                </button>
              ) : null}
              {onToggleAutostart ? (
                <label className="fr-theme-options" style={{ marginTop: 12 }}>
                  <span className="fr-label" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input
                      type="checkbox"
                      checked={autostartEnabled}
                      onChange={(event) => {
                        void onToggleAutostart(event.target.checked);
                      }}
                    />
                    {he.autostartLabel}
                  </span>
                </label>
              ) : null}
              <p className="fr-hint" dir="auto">
                {displayName}
              </p>
              <p className="fr-label" style={{ marginTop: 16 }}>
                {he.membersLabel}
              </p>
              <ul className="fr-members">
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
            </div>
          </section>
        ) : null}

        {!settingsOpen ? (
        <div className={detailCard ? `fr-screen${screenLeaving ? " fr-leaving" : " fr-screen-in"}` : "fr-list-in"}>
        {detailCard ? (
          <div className="fr-page-head">
            <button
              type="button"
              className="fr-icon-btn"
              aria-label={he.back}
              onClick={closeDetail}
            >
              <FluentIcon name="chevronLeft" rtlFlip />
            </button>
            <h2 ref={detailTitleRef} tabIndex={-1}>
              {he.requestDetails}
            </h2>
            <span style={{ width: 36 }} />
          </div>
        ) : (
          <div className="fr-nav-block">
            <div role="tablist" className="fr-seg">
              {TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={primaryView === tab}
                  aria-label={`${tabLabel(tab)} ${tabCounts[tab]}`}
                  className="fr-seg-btn"
                  onClick={() => {
                    setPrimaryView(tab);
                  }}
                >
                  <span className="fr-seg-count">{tabCounts[tab]}</span>
                  <span className="fr-seg-label">
                    <FluentIcon name={tabIcon(tab)} size={16} />
                    {tabLabel(tab)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <section
          ref={listScrollRef}
          className="fr-scroll"
          key={detailCard ? "detail" : primaryView}
        >
          {!detailCard && visibleItems.length === 0 ? (
            <div className="fr-empty">
              <FluentIcon name="document" />
              <p>{emptyLabel(primaryView)}</p>
            </div>
          ) : (
            (detailCard
              ? [{ key: "detail", cards: [{ key: detailCard.id, card: detailCard }] }]
              : [{ key: primaryView, cards: visibleItems }]
            ).map((group) => (
              <div key={group.key} className={detailCard ? undefined : "fr-list-swap"}>
                <div
                  key={detailCard ? "detail" : primaryView}
                  className={detailCard ? undefined : "fr-list-filter"}
                >
                {group.cards.map((item) => {
              const card = item.card;
              const handoff = card.source.record;
              const isLegacy = card.source.kind === "legacy";
              const role = isLegacy ? handoffRole(handoff, currentMemberId) : null;
              const local = workingLocal(inbox, handoff.id);
              const already = Boolean(local);
              const sender = memberName(members, handoff.senderMemberId);
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
              const v2Busy =
                actionBusyId === handoff.id ||
                localWork === "sending" ||
                localWork === "uploading" ||
                localWork === "finalizing" ||
                localWork === "resuming" ||
                localWork === "aborting";
              const primary =
                v2Source && currentMemberId
                  ? recipientPrimaryAction(v2Source, currentMemberId)
                  : null;
              const senderActs =
                v2Source && currentMemberId
                  ? senderReturnActions(v2Source, currentMemberId)
                  : { accept: false, revision: false, fileRequestWording: false };
              const showOpenV2 = Boolean(
                v2Source && currentMemberId && onOpenV2 && canOpenV2(v2Source, currentMemberId),
              );
              const showRemind = Boolean(
                v2Source && currentMemberId && onRemind && canRemind(v2Source, currentMemberId),
              );
              const showCancel = Boolean(
                v2Source && currentMemberId && onCancelV2 && canCancelV2(v2Source, currentMemberId),
              );
              const fileRequestPending = Boolean(v2Source && isFileRequestWithoutVersion(v2Source));
              const changed = workingFileChanged(inbox, handoff.id);
              const historyShown = historyOpen === handoff.id;
              const revisionOpen = revisionFor === handoff.id;
              const compact = !detailCard;
              const visualPrimary =
                localWork === "retry" || localWork === "offline"
                  ? "retry"
                  : primary === "attach"
                    ? "attach"
                    : primary === "approve"
                      ? "approve"
                      : primary === "review"
                        ? "review"
                        : primary === "update"
                          ? "update"
                          : senderActs.accept
                            ? "accept"
                            : showOpenV2 && !fileRequestPending
                              ? "openV2"
                              : isLegacy &&
                                  role === "recipient" &&
                                  handoff.status !== "completed" &&
                                  handoff.status !== "return_received"
                                ? "openLegacyIn"
                                : isLegacy && canReturn
                                  ? "return"
                                  : isLegacy && role === "sender" && handoff.status === "returned"
                                    ? "complete"
                                    : "";
              const showLegacyOpenIn =
                isLegacy &&
                role === "recipient" &&
                handoff.status !== "completed" &&
                handoff.status !== "return_received";
              const showLegacyOpenOut =
                isLegacy &&
                ((role === "sender" &&
                  (handoff.status === "returned" ||
                    handoff.status === "completed" ||
                    handoff.status === "return_received")) ||
                  (role === "recipient" &&
                    (handoff.status === "completed" || handoff.status === "return_received")));
              const presented = presentHandoffCard(
                card,
                currentMemberId,
                (id) => memberName(members, id),
                {
                  useMe: compact,
                  emailOf: (id) => memberEmail(members, id),
                },
              );
              const primaryKind = resolveCardPrimary({
                section: card.section,
                localWork,
                fileRequestPending,
                senderAccept: senderActs.accept,
                hasOpenableFile: Boolean(
                  (card.latestVersionNumber && card.latestVersionNumber > 0) ||
                    showOpenV2 ||
                    showLegacyOpenOut ||
                    latest,
                ),
                showOpen: Boolean(showOpenV2 || showLegacyOpenIn),
                canReturn: Boolean(isLegacy && canReturn && onReturnFile),
                legacyReturnedSender: Boolean(
                  isLegacy && role === "sender" && handoff.status === "returned",
                ),
              });
              const handle = counterpartHandle(presented.counterpart);
              const canDownloadFile = Boolean(
                presented.subjectText && (onOpenV2 || onDownloadAndOpen || onOpenLatest),
              );
              const downloadCardFile = () => {
                if (v2Source && onOpenV2) {
                  void onOpenV2(handoff);
                  return;
                }
                if (showLegacyOpenOut && onOpenLatest) {
                  void onOpenLatest(handoff);
                  return;
                }
                void onDownloadAndOpen?.(handoff);
              };
              return (
                <article
                  key={item.key}
                  data-handoff-id={handoff.id}
                  className={`fr-card${compact ? " fr-card-compact" : ""}${presented.settled ? " fr-card-settled" : ""}`}
                  tabIndex={compact ? 0 : undefined}
                  onClick={(event) => {
                    if (detailCard) {
                      return;
                    }
                    const target = event.target as HTMLElement;
                    if (target.closest("button, a, input, textarea, select, [role='menu']")) {
                      return;
                    }
                    openDetail(handoff.id, event.currentTarget);
                  }}
                  onKeyDown={(event) => {
                    if (!compact || event.key !== "Enter") {
                      return;
                    }
                    const target = event.target as HTMLElement;
                    if (target.closest("button, a, input, textarea, select, [role='menu']")) {
                      return;
                    }
                    openDetail(handoff.id, event.currentTarget);
                  }}
                >
                  <div className="fr-card-status">
                    <span className={`fr-status fr-status-${presented.tone}`}>
                      <FluentIcon name={presented.statusIcon} size={14} />
                      {presented.statusLabel}
                    </span>
                    <span className="fr-activity-time">
                      {formatRelativeTime(new Date(card.lastActivityAt))}
                    </span>
                  </div>
                  {handle || presented.title ? (
                    <div className="fr-sentence">
                      {handle ? (
                        <>
                          <span className="fr-sentence-who">
                            <span className="fr-sentence-at" aria-hidden="true">
                              @
                            </span>
                            <span dir="auto" className="fr-sentence-user">
                              {handle}
                            </span>
                          </span>
                          {presented.title ? (
                            <span className="fr-sentence-dot" aria-hidden="true">
                              ·
                            </span>
                          ) : null}
                        </>
                      ) : null}
                      {presented.title ? (
                        <span dir="auto" className="fr-sentence-text">
                          {presented.title}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {presented.dueLabel ? (
                    <div className="fr-meta-row">
                      <span>
                        <FluentIcon name="calendar" size={14} />
                        {presented.dueLabel}
                      </span>
                    </div>
                  ) : null}
                  {detailCard && card.relevantNote ? (
                    <p dir="auto" className="fr-note">
                      {card.relevantNote}
                    </p>
                  ) : null}
                  {watchFailed.has(handoff.id) ? (
                    <p role="status" className="fr-note">
                      {he.watchFailed}
                    </p>
                  ) : null}
                  {localWork === "sending" ? <div className="fr-progress">{he.handoffStatus.sending}</div> : null}
                  {localWork === "uploading" || sendProgress === "uploading" ? (
                    <div className="fr-progress">
                      <span>{he.uploadingFile}</span>
                      <div className="fr-progress-bar">
                        <span />
                      </div>
                    </div>
                  ) : null}
                  {localWork === "finalizing" ? <div className="fr-progress">{he.finishingRequest}</div> : null}
                  {localWork === "resuming" ? <div className="fr-progress">{he.resumingUpload}</div> : null}
                  {localWork === "waiting_reselect" ? <div className="fr-note">{he.waitingForOriginalFile}</div> : null}
                  {localWork === "file_changed" ? <div className="fr-note">{he.fileChangedDuringUpload}</div> : null}
                  {localWork === "offline" ? <div className="fr-note">{he.cannotConnectNow}</div> : null}
                  {returning ? (
                    <div className="fr-progress">{he.handoffStatus.returning}</div>
                  ) : showSyncing ? (
                    <div className="fr-progress">{he.syncingChanges}</div>
                  ) : null}
                  {!compact ? (
                  <div className="fr-actions">
                    {!compact && showLegacyOpenIn ? (
                      <button
                        type="button"
                        className={btnClass(visualPrimary === "openLegacyIn")}
                        disabled={returning || downloadingId === handoff.id || !onDownloadAndOpen}
                        onClick={() => {
                          void onDownloadAndOpen?.(handoff);
                        }}
                      >
                        {already ? he.open : he.openAndHandle}
                      </button>
                    ) : null}
                    {!compact && showLegacyOpenOut ? (
                      <button
                        type="button"
                        className={btnClass(false)}
                        disabled={returning || downloadingId === handoff.id || !onOpenLatest}
                        onClick={() => {
                          void onOpenLatest?.(handoff);
                        }}
                      >
                        {card.section === "done" ? he.openFile : already ? he.open : he.openToReview}
                      </button>
                    ) : null}
                    {!compact && isLegacy && canReturn && onReturnFile ? (
                      <button
                        type="button"
                        className={btnClass(visualPrimary === "return")}
                        disabled={returning}
                        onClick={() => {
                          void onReturnFile(handoff);
                        }}
                      >
                        {returnFileToLabel(sender)}
                      </button>
                    ) : null}
                    {!compact && v2Source && showOpenV2 && !fileRequestPending ? (
                      <button
                        type="button"
                        className={btnClass(visualPrimary === "openV2")}
                        disabled={v2Busy || downloadingId === handoff.id}
                        onClick={() => {
                          void onOpenV2?.(handoff);
                        }}
                      >
                        {card.section === "done"
                          ? he.openFile
                          : already
                            ? he.open
                            : senderActs.accept
                              ? he.openToReview
                              : he.openAndHandle}
                      </button>
                    ) : null}
                    {!compact && primary === "approve" && onApprove ? (
                      <button
                        type="button"
                        className={btnClass(visualPrimary === "approve")}
                        disabled={v2Busy}
                        onClick={() => {
                          if (changed && !window.confirm(he.fileChangedConfirm)) {
                            return;
                          }
                          void onApprove(
                            handoff,
                            resultNoteFor === handoff.id ? resultNote.trim() || null : null,
                          );
                        }}
                      >
                        {he.approve}
                      </button>
                    ) : null}
                    {!compact && primary === "review" && onFinishReview ? (
                      <button
                        type="button"
                        className={btnClass(visualPrimary === "review")}
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
                    {!compact && primary === "update" && onReturnUpdate ? (
                      <button
                        type="button"
                        className={btnClass(visualPrimary === "update")}
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
                    {!compact &&
                    (primary === "approve" || primary === "review" || primary === "update") &&
                    onReject ? (
                      <button
                        type="button"
                        className={btnClass(false, true)}
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
                    {!compact && primary === "attach" && onAttachFileRequest ? (
                      <button
                        type="button"
                        className={btnClass(visualPrimary === "attach")}
                        disabled={v2Busy}
                        onClick={() => {
                          void onAttachFileRequest(handoff);
                        }}
                      >
                        {he.attachFile}
                      </button>
                    ) : null}
                    {!compact && primary === "attach" && onCannotProvide ? (
                      <button
                        type="button"
                        className={btnClass(false, true)}
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
                    {!compact && senderActs.accept && onAcceptV2 ? (
                      <button
                        type="button"
                        className={btnClass(visualPrimary === "accept")}
                        disabled={v2Busy}
                        onClick={() => {
                          void onAcceptV2(handoff);
                        }}
                      >
                        {he.acceptAndClose}
                      </button>
                    ) : null}
                    {!compact && senderActs.revision ? (
                      <button
                        type="button"
                        className={btnClass(false)}
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
                    {!compact && (localWork === "retry" || localWork === "offline") ? (
                      <button
                        type="button"
                        className={btnClass(visualPrimary === "retry")}
                        onClick={() => {
                          void onRetryLocal?.(handoff.id);
                        }}
                      >
                        {he.tryAgain}
                      </button>
                    ) : null}
                    {!compact && localWork === "waiting_reselect" ? (
                      <button
                        type="button"
                        className={btnClass(true)}
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
                        className={btnClass(false, true)}
                        onClick={() => {
                          void onAbortLocal(handoff.id);
                        }}
                      >
                        {he.abortAttempt}
                      </button>
                    ) : null}
                    {!compact && isLegacy && role === "sender" && handoff.status === "returned" ? (
                      <>
                        <button
                          type="button"
                          className={btnClass(visualPrimary === "complete")}
                          disabled={returning || !onCompleteHandoff}
                          onClick={() => {
                            void onCompleteHandoff?.(handoff);
                          }}
                        >
                          {he.acceptAndClose}
                        </button>
                        {!compact ? (
                          <button
                            type="button"
                            className={btnClass(false)}
                            disabled={returning}
                            onClick={() => {
                              setRevisionFor(handoff.id);
                              setRevisionNote("");
                              setRevisionError(null);
                            }}
                          >
                            {he.requestRevision}
                          </button>
                        ) : null}
                      </>
                    ) : null}
                    {!compact && showRemind ? (
                      <button
                        type="button"
                        className={btnClass(false)}
                        disabled={v2Busy}
                        onClick={() => {
                          void onRemind?.(handoff);
                        }}
                      >
                        {he.sendReminder}
                      </button>
                    ) : null}
                    {!compact && showCancel ? (
                      <button
                        type="button"
                        className={btnClass(false, true)}
                        disabled={v2Busy}
                        onClick={() => {
                          void onCancelV2?.(handoff);
                        }}
                      >
                        {he.cancelRequest}
                      </button>
                    ) : null}
                  </div>
                  ) : null}
                  {presented.subjectText ? (
                    canDownloadFile ? (
                      <button
                        type="button"
                        className="fr-file"
                        aria-label={he.downloadAndOpen}
                        disabled={v2Busy || returning || downloadingId === handoff.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          downloadCardFile();
                        }}
                      >
                        <FluentIcon name="documentMultiple" size={14} />
                        <FileName name={presented.subjectText} className="fr-file-name" />
                        <span className="fr-file-download" aria-hidden="true">
                          <FluentIcon name="arrowCircleDown" size={14} />
                        </span>
                      </button>
                    ) : (
                      <div className="fr-file">
                        <FluentIcon name="documentMultiple" size={14} />
                        <FileName name={presented.subjectText} className="fr-file-name" />
                      </div>
                    )
                  ) : null}
                  {resultNoteFor === handoff.id ? (
                    <div className="fr-overlay" role="presentation">
                      <div className="fr-dialog" role="dialog" aria-modal="true">
                        <div className="fr-dialog-head">
                          <h2 className="fr-dialog-title">
                            {primary === "update"
                              ? he.replyLabel
                              : primary === "attach"
                                ? he.rejectReasonLabel
                                : he.optionalNoteLabel}
                          </h2>
                          <button
                            type="button"
                            className="fr-icon-btn"
                            aria-label={he.closeDialog}
                            onClick={() => {
                              setResultNoteFor(null);
                            }}
                          >
                            <FluentIcon name="dismiss" />
                          </button>
                        </div>
                        <label className="fr-field-wrap">
                          <span className="fr-label">
                            {primary === "update"
                              ? he.replyLabel
                              : primary === "attach"
                                ? he.rejectReasonLabel
                                : he.optionalNoteLabel}
                          </span>
                          <textarea
                            className="fr-area"
                            maxLength={REVISION_NOTE_MAX}
                            value={resultNote}
                            onChange={(event) => {
                              setResultNote(event.target.value);
                            }}
                          />
                        </label>
                        {resultNoteError ? (
                          <p role="alert" className="fr-field-error">
                            {resultNoteError}
                          </p>
                        ) : null}
                        <div className="fr-sheet-actions">
                          <button
                            type="button"
                            className="fr-btn fr-btn-secondary"
                            onClick={() => {
                              setResultNoteFor(null);
                            }}
                          >
                            {he.cancel}
                          </button>
                          <button
                            type="button"
                            className={
                              primary === "attach" ? "fr-btn fr-btn-danger" : "fr-btn fr-btn-primary"
                            }
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
                            {primary === "attach"
                              ? he.cannotProvide
                              : primary === "update"
                                ? he.returnUpdate
                                : he.reject}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {revisionOpen ? (
                    <div className="fr-overlay" role="presentation">
                      <div className="fr-dialog" role="dialog" aria-modal="true">
                        <div className="fr-dialog-head">
                          <h2 className="fr-dialog-title">{he.requestRevision}</h2>
                          <button
                            type="button"
                            className="fr-icon-btn"
                            aria-label={he.closeDialog}
                            onClick={() => {
                              setRevisionFor(null);
                            }}
                          >
                            <FluentIcon name="dismiss" />
                          </button>
                        </div>
                        <p className="fr-dialog-body">{he.revisionNoteLabel}</p>
                        <label className="fr-field-wrap">
                          <span className="fr-label">{he.revisionNoteLabel}</span>
                          <textarea
                            className="fr-area"
                            maxLength={REVISION_NOTE_MAX}
                            value={revisionNote}
                            onChange={(event) => {
                              setRevisionNote(event.target.value);
                            }}
                          />
                        </label>
                        {revisionError ? (
                          <p role="alert" className="fr-field-error">
                            {revisionError}
                          </p>
                        ) : null}
                        <div className="fr-sheet-actions">
                          <button
                            type="button"
                            className="fr-btn fr-btn-secondary"
                            onClick={() => {
                              setRevisionFor(null);
                            }}
                          >
                            {he.cancel}
                          </button>
                          <button
                            type="button"
                            className="fr-btn fr-btn-primary"
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
                      </div>
                    </div>
                  ) : null}
                  {detailCard ? (
                    <>
                      <button
                        type="button"
                        className="fr-history-link"
                        aria-expanded={historyShown}
                        onClick={() => {
                          setHistoryOpen(historyShown ? null : handoff.id);
                        }}
                      >
                        <FluentIcon name="chevronDown" />
                        {historyShown ? he.hideHistory : he.showHistory}
                      </button>
                      <div className={`fr-history-fold${historyShown ? " fr-open" : ""}`}>
                        <ol className="fr-history">
                          {history.map((line, index) => (
                            <li
                              key={`${handoff.id}-${line.eventType}-${index}`}
                              className="fr-history-item"
                            >
                              <span className="fr-history-icon">
                                <FluentIcon name="history" />
                              </span>
                              <div className="fr-history-title">{line.title}</div>
                              {line.detail ? (
                                <div dir="auto" className="fr-note">
                                  {line.detail}
                                </div>
                              ) : null}
                              <div className="fr-history-meta">
                                {line.actorMemberId ? memberName(members, line.actorMemberId) : ""}
                                {line.createdAt
                                  ? ` · ${formatRelativeTime(new Date(line.createdAt))}`
                                  : ""}
                                {typeof line.versionNumber === "number"
                                  ? ` · ${he.latestVersionLabel.replace("{version}", String(line.versionNumber))}`
                                  : ""}
                              </div>
                            </li>
                          ))}
                        </ol>
                      </div>
                    </>
                  ) : null}
                </article>
              );
                })}
                </div>
              </div>
            ))
          )}
        </section>
        </div>
        ) : null}
      </div>

      {composeOpen && !waiting && onSubmitSend ? (
        <div className={`fr-overlay${composeLeaving ? " fr-leaving" : ""}`} role="presentation">
          <div
            ref={composeRef}
            className="fr-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="compose-title"
          >
            <div className="fr-sheet-head">
              <h2 id="compose-title" className="fr-sheet-title">
                {he.newRequest}
              </h2>
              <button
                type="button"
                className="fr-icon-btn"
                aria-label={he.closeDialog}
                onClick={closeCompose}
              >
                <FluentIcon name="dismiss" />
              </button>
            </div>
            <div className="fr-choice">
              <label>
                <input
                  type="radio"
                  name="form-mode"
                  checked={formMode === "send"}
                  onChange={() => {
                    setFormMode("send");
                    setFormError(null);
                  }}
                />
                <span>{he.sendFile}</span>
              </label>
              <label>
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
            <label className="fr-field-wrap">
              <span className="fr-label">{he.recipientLabel}</span>
              <select
                ref={composeFirstRef}
                className="fr-select"
                value={recipientId || others[0]?.id || ""}
                onChange={(event) => {
                  setRecipientId(event.target.value);
                }}
              >
                {others.length === 0 ? <option value="">{he.chooseRecipient}</option> : null}
                {others.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.displayName}
                  </option>
                ))}
              </select>
            </label>
            {formMode === "send" ? (
              <>
                <div className="fr-field-wrap">
                  <span className="fr-label">{he.chooseFile}</span>
                  <div className="fr-actions">
                    <button
                      type="button"
                      className="fr-btn fr-btn-secondary"
                      onClick={() => {
                        void onPickFile?.();
                      }}
                    >
                      {he.chooseFile}
                    </button>
                    {pickedFile ? (
                      <FileName name={pickedFile.originalFilename} className="fr-file-name" />
                    ) : null}
                  </div>
                </div>
                <fieldset className="fr-field-wrap">
                  <legend className="fr-label">{he.sendFile}</legend>
                  <div className="fr-choice">
                    <label>
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
                    <label>
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
                    <label>
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
                  </div>
                </fieldset>
              </>
            ) : null}
            <label className="fr-field-wrap">
              <span className="fr-label">
                {formMode === "file_request" ? he.fileDescriptionLabel : he.instructionLabel}
              </span>
              <textarea
                className="fr-area"
                maxLength={INSTRUCTION_MAX}
                value={instruction}
                onChange={(event) => {
                  setInstruction(event.target.value);
                }}
              />
              {formError &&
              (formError === he.cloudError.instruction_required ||
                formError === he.instructionTooLong) ? (
                <span className="fr-field-error">{formError}</span>
              ) : null}
            </label>
            <label className="fr-field-wrap">
              <span className="fr-label">{he.dueOnLabel}</span>
              <input
                type="date"
                className="fr-field"
                value={dueOn}
                onChange={(event) => {
                  setDueOn(event.target.value);
                }}
              />
            </label>
            {formError &&
            formError !== he.cloudError.instruction_required &&
            formError !== he.instructionTooLong ? (
              <p role="alert" className="fr-field-error">
                {formError}
              </p>
            ) : null}
            {sending ? (
              <div className="fr-progress">
                <span>
                  {sendProgress === "sending"
                    ? he.handoffStatus.sending
                    : sendProgress === "uploading"
                      ? he.uploadingFile
                      : he.finishingRequest}
                </span>
                {sendProgress === "uploading" ? (
                  <div className="fr-progress-bar">
                    <span />
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="fr-sheet-actions">
              <button type="button" className="fr-btn fr-btn-secondary" onClick={closeCompose}>
                {he.cancel}
              </button>
              <button
                type="button"
                className="fr-btn fr-btn-primary"
                disabled={sending}
                onClick={onSend}
              >
                {formMode === "file_request" ? he.sendRequest : he.send}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
