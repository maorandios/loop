import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileName } from "../../components/FileName";
import { LtrValue } from "../../components/LtrValue";
import { he } from "../../copy/he";
import { FluentIcon, type IconName } from "../../icons/fluent";
import { formatRelativeTime } from "../../lib/dates";
import { ThemeProvider, useTheme } from "../../theme/ThemeProvider";
import { handoffRole } from "../handoff/buckets";
import { historyIcon, visibleHistory } from "../handoff/history";
import {
  EMPTY_INBOX_FILTER,
  isInboxFilterActive,
  type InboxExtraFilter,
} from "../handoff/inboxList";
import {
  cardMatchesQuery,
  latestActivityAt,
  visibleListItems,
  PRIMARY_VIEWS,
  type PrimaryView,
} from "../handoff/mailbox";
import {
  buildDesignInbox,
  DESIGN_ALL_ACTIONS_ID,
  mergeDesignMembers,
  shouldUseDesignCards,
  withDesignEmails,
} from "../handoff/designCards";
import { canReturnFile } from "../handoff/reconciliation";
import { projectHandoffList } from "../handoff/view";
import { FilterPopover } from "./FilterPopover";
import { NavigationRail } from "./NavigationRail";
import { WorkspaceToolbar } from "./WorkspaceToolbar";
import {
  canCancelV2,
  canRemind,
  cardRequestedAction,
  recipientPrimaryAction,
  senderReturnActions,
  workingFileChanged,
} from "../handoff/actions";
import { counterpartHandle, presentHandoffCard } from "../handoff/cardPresentation";
import {
  INSTRUCTION_MAX,
  REVISION_NOTE_MAX,
  normalizeDueOn,
  validateFileRequestForm,
  validateRevisionNote,
  validateSendForm,
} from "../handoff/sendForm";
import { designLinkPolicy, designLinkStage } from "../link/designLink";
import { ExternalLinkScreen } from "../link/ExternalLinkScreen";
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
import type { Workspace, WorkspaceMember } from "./types";

function laterStamp(left: string, right: string | null): string {
  if (!right || left >= right) {
    return left;
  }
  return right;
}

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
  onPickDroppedFile?: (path: string) => void | Promise<void>;
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
  externalLinkPolicy?: "anyone" | "identified";
  externalLinkStage?: "form" | "uploading" | "success";
};

function memberName(members: WorkspaceMember[], memberId: string): string {
  return members.find((member) => member.id === memberId)?.displayName ?? "";
}

function memberEmail(members: WorkspaceMember[], memberId: string): string | null {
  const email = members.find((member) => member.id === memberId)?.email?.trim();
  return email || null;
}

function memberRecipientLabel(member: WorkspaceMember): string {
  const email = member.email?.trim();
  return email ? `${member.displayName} • ${email}` : member.displayName;
}

function memberMatchesExact(member: WorkspaceMember, value: string): boolean {
  const typed = value.trim();
  return typed.length > 0 && (member.displayName === typed || memberRecipientLabel(member) === typed);
}

function memberMatchesQuery(member: WorkspaceMember, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return false;
  }
  return (
    member.displayName.toLowerCase().includes(needle) ||
    (member.email ?? "").toLowerCase().includes(needle) ||
    memberRecipientLabel(member).toLowerCase().includes(needle)
  );
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

function CommandRow(props: {
  icon: IconName;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`fr-command-btn${props.danger ? " fr-command-btn-danger" : ""}`}
      onClick={props.onClick}
    >
      <FluentIcon name={props.icon} size={16} />
      {props.label}
    </button>
  );
}

function FormDrawer(props: {
  titleId: string;
  title: string;
  icon: IconName;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fr-form-drawer" role="dialog" aria-labelledby={props.titleId}>
      <div className="fr-dialog-head">
        <h2 id={props.titleId} className="fr-dialog-title">
          <FluentIcon name={props.icon} size={18} />
          {props.title}
        </h2>
        <button
          type="button"
          className="fr-drawer-back"
          dir="ltr"
          aria-label={he.backToMenu}
          onClick={props.onClose}
        >
          <FluentIcon name="chevronLeft" />
          {he.back}
        </button>
      </div>
      {props.children}
    </div>
  );
}

function firstDroppedName(files: FileList | null | undefined): string | null {
  const name = files?.[0]?.name?.trim();
  return name ? name : null;
}

function droppedFilePath(file: File | undefined): string | null {
  if (!file) {
    return null;
  }
  const path = "path" in file ? String((file as File & { path?: string }).path ?? "").trim() : "";
  return path || null;
}

export const PUSH_DURATION_MS = 3000;
const PUSH_SLIDE_MS = 240;
const SCREEN_SLIDE_MS = 240;

type PushTone = "accent" | "danger" | "success";

type PushNotice = {
  id: number;
  text: string;
  tone: PushTone;
  icon: IconName;
  sticky?: boolean;
  source?: "form" | "system";
  actionLabel?: string;
  onAction?: () => void;
};

function sendProgressPushText(progress: SendProgress): string | null {
  if (progress === "sending") {
    return he.handoffStatus.sending;
  }
  if (progress === "uploading") {
    return he.uploadingFile;
  }
  if (progress === "finalizing") {
    return he.finishingRequest;
  }
  return null;
}

function PushBanner({
  open,
  notice,
  onDismiss,
}: {
  open: boolean;
  notice: PushNotice | null;
  onDismiss: () => void;
}) {
  return (
    <div className={`fr-push-slot${open ? " fr-open" : ""}`}>
      <div className="fr-push-slot-inner">
        {notice ? (
          <div className="fr-push-wrap">
            <div
              className="fr-push"
              data-tone={notice.tone}
              role={notice.tone === "danger" ? "alert" : "status"}
            >
              <div className="fr-push-body">
                <FluentIcon name={notice.icon} size={16} />
                <p className="fr-push-text">{notice.text}</p>
                {notice.actionLabel && notice.onAction ? (
                  <button
                    type="button"
                    className="fr-push-action"
                    onClick={() => {
                      notice.onAction?.();
                      onDismiss();
                    }}
                  >
                    {notice.actionLabel}
                  </button>
                ) : null}
                {notice.sticky ? (
                  <span className="fr-push-close" aria-hidden="true" />
                ) : (
                  <button
                    type="button"
                    className="fr-icon-btn fr-push-close"
                    aria-label={he.closeDialog}
                    onClick={onDismiss}
                  >
                    <FluentIcon name="dismiss" />
                  </button>
                )}
              </div>
              <div className="fr-push-progress" aria-hidden="true">
                <span
                  key={notice.id}
                  className="fr-push-progress-bar"
                  data-kind={notice.sticky ? "indeterminate" : "timer"}
                  style={
                    notice.sticky ? undefined : { animationDuration: `${PUSH_DURATION_MS}ms` }
                  }
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
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
  onPickDroppedFile,
  onCancelSend,
  onSubmitSend,
  onSubmitFileRequest,
  onDownloadAndOpen,
  onOpenLatest,
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
  externalLinkPolicy,
  externalLinkStage,
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
  const [slideDir, setSlideDir] = useState<"start" | "end">("start");
  const [seenAt, setSeenAt] = useState<Record<PrimaryView, string>>(() => {
    const now = new Date().toISOString();
    return { action: now, info: now, completed: now };
  });
  const seenHydrated = useRef(false);
  const [searchQuery, setSearchQuery] = useState("");
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
  const composeFirstRef = useRef<HTMLElement | null>(null);
  const composeTitleRef = useRef<HTMLHeadingElement | null>(null);
  const settingsScreenRef = useRef<HTMLElement | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const composeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const recipientWrapRef = useRef<HTMLDivElement | null>(null);
  const [recipientId, setRecipientId] = useState("");
  const [recipientQuery, setRecipientQuery] = useState("");
  const [recipientOpen, setRecipientOpen] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>("send");
  const [requestedAction, setRequestedAction] = useState<SendAction>("approval");
  const [instruction, setInstruction] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [resultNoteFor, setResultNoteFor] = useState<string | null>(null);
  const [resultNote, setResultNote] = useState("");
  const [resultNoteError, setResultNoteError] = useState<string | null>(null);
  const [historyCollapsed, setHistoryCollapsed] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [drawerLeaving, setDrawerLeaving] = useState(false);
  const [dockExpanded, setDockExpanded] = useState(false);
  const drawerLeavingRef = useRef(false);
  const drawerMotionTimer = useRef(0);
  const dockExpandFrame = useRef(0);
  const [panelLeaving, setPanelLeaving] = useState(false);
  const [panelEnter, setPanelEnter] = useState(false);
  const panelLeavingRef = useRef(false);
  const panelMotionTimer = useRef(0);
  const [designDialog, setDesignDialog] = useState<
    "approve" | "attach" | "remind" | "cancel" | null
  >(null);
  const [designNotice, setDesignNotice] = useState<string | null>(null);
  const [designPickedName, setDesignPickedName] = useState<string | null>(null);
  const [designDropActive, setDesignDropActive] = useState(false);
  const designFileInputRef = useRef<HTMLInputElement | null>(null);
  const [revisionFor, setRevisionFor] = useState<string | null>(null);
  const [revisionNote, setRevisionNote] = useState("");
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeStep, setComposeStep] = useState<"choose" | "form">("choose");
  const [sendDropActive, setSendDropActive] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pushNotice, setPushNotice] = useState<PushNotice | null>(null);
  const [pushOpen, setPushOpen] = useState(false);
  const pushTimer = useRef(0);
  const pushMotionTimer = useRef(0);
  const pushExpandFrame = useRef(0);
  const pushLeavingRef = useRef(false);
  const pushNoticeRef = useRef(pushNotice);
  pushNoticeRef.current = pushNotice;
  const onRetryLoadRef = useRef(onRetryLoad);
  onRetryLoadRef.current = onRetryLoad;

  function expandPush() {
    window.cancelAnimationFrame(pushExpandFrame.current);
    if (motionDuration(PUSH_SLIDE_MS) === 0) {
      setPushOpen(true);
      return;
    }
    setPushOpen(false);
    pushExpandFrame.current = window.requestAnimationFrame(() => {
      pushExpandFrame.current = window.requestAnimationFrame(() => {
        setPushOpen(true);
      });
    });
  }

  function showPush(
    text: string,
    tone: PushTone = "accent",
    icon: IconName = "alert",
    action?: { label: string; onClick: () => void },
    options?: { sticky?: boolean; source?: "form" | "system" },
  ) {
    window.clearTimeout(pushTimer.current);
    window.clearTimeout(pushMotionTimer.current);
    window.cancelAnimationFrame(pushExpandFrame.current);
    pushLeavingRef.current = false;
    const alreadyOpen = pushOpen && pushNoticeRef.current;
    setPushNotice({
      id: Date.now(),
      text,
      tone,
      icon,
      sticky: options?.sticky ?? false,
      source: options?.source ?? "system",
      actionLabel: action?.label,
      onAction: action?.onClick,
    });
    if (alreadyOpen) {
      setPushOpen(true);
      return;
    }
    expandPush();
  }

  function dismissPush() {
    window.clearTimeout(pushTimer.current);
    window.cancelAnimationFrame(pushExpandFrame.current);
    if (!pushNoticeRef.current || pushLeavingRef.current) {
      return;
    }
    const finish = () => {
      pushMotionTimer.current = 0;
      pushLeavingRef.current = false;
      setPushOpen(false);
      setPushNotice(null);
    };
    setPushOpen(false);
    if (motionDuration(PUSH_SLIDE_MS) === 0) {
      finish();
      return;
    }
    pushLeavingRef.current = true;
    window.clearTimeout(pushMotionTimer.current);
    pushMotionTimer.current = window.setTimeout(finish, PUSH_SLIDE_MS);
  }
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
  const sectionItems = visibleListItems({
    projected,
    primaryView,
    extraFilter,
    memberId: currentMemberId,
    localWorkOf: (handoffId) => localStates[handoffId] ?? "idle",
  });
  const visibleItems = sectionItems.filter((item) => {
    const presented = presentHandoffCard(
      item.card,
      currentMemberId,
      (id) => memberName(members, id),
      {
        useMe: true,
        emailOf: (id) => memberEmail(members, id),
      },
    );
    return cardMatchesQuery(
      [
        item.card.filename,
        item.card.instruction,
        item.card.statusSentence,
        presented.title,
        presented.subjectText,
        presented.headline,
        presented.statusLabel,
        presented.people.senderName,
        presented.people.recipientName,
        presented.counterpart?.name,
      ],
      searchQuery,
    );
  });
  const searching = Boolean(searchQuery.trim());
  const unread = useMemo(() => {
    const flags: Record<PrimaryView, boolean> = {
      action: false,
      info: false,
      completed: false,
    };
    for (const view of PRIMARY_VIEWS) {
      if (!settingsOpen && view === primaryView) {
        continue;
      }
      const latest = latestActivityAt(
        visibleListItems({
          projected,
          primaryView: view,
          extraFilter: EMPTY_INBOX_FILTER,
          memberId: currentMemberId,
          localWorkOf: (handoffId) => localStates[handoffId] ?? "idle",
        }),
      );
      flags[view] = Boolean(latest && latest > seenAt[view]);
    }
    return flags;
  }, [
    currentMemberId,
    localStates,
    primaryView,
    projected,
    seenAt,
    settingsOpen,
  ]);
  const detailCard = detailId
    ? (projected.cards.find((card) => card.id === detailId) ?? null)
    : null;
  const drawerScrimShown = Boolean(
    detailCard &&
      (actionsOpen ||
        drawerLeaving ||
        Boolean(designDialog) ||
        resultNoteFor !== null ||
        revisionFor !== null),
  );
  const showLoadBanner = projected.inconsistent;
  const sending =
    sendProgress === "sending" || sendProgress === "uploading" || sendProgress === "finalizing";
  const bannerError = error ?? copyError;
  const sectionLatest = latestActivityAt(sectionItems);

  useEffect(() => {
    if (seenHydrated.current || projected.cards.length === 0) {
      return;
    }
    seenHydrated.current = true;
    const now = new Date().toISOString();
    const next: Record<PrimaryView, string> = {
      action: now,
      info: now,
      completed: now,
    };
    for (const view of PRIMARY_VIEWS) {
      next[view] = laterStamp(
        now,
        latestActivityAt(
          visibleListItems({
            projected,
            primaryView: view,
            extraFilter: EMPTY_INBOX_FILTER,
            memberId: currentMemberId,
            localWorkOf: (handoffId) => localStates[handoffId] ?? "idle",
          }),
        ),
      );
    }
    setSeenAt(next);
  }, [currentMemberId, localStates, projected]);

  useEffect(() => {
    if (settingsOpen || !sectionLatest) {
      return;
    }
    setSeenAt((prev) => {
      if (prev[primaryView] >= sectionLatest) {
        return prev;
      }
      return { ...prev, [primaryView]: sectionLatest };
    });
  }, [primaryView, sectionLatest, settingsOpen]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      if (designDialog || resultNoteFor || revisionFor) {
        backToMenu();
        return;
      }
      if (actionsOpen) {
        closeDrawer();
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
  }, [
    actionsOpen,
    composeOpen,
    designDialog,
    detailId,
    filterOpen,
    resultNoteFor,
    revisionFor,
    settingsOpen,
  ]);

  useEffect(() => {
    if (!pushNotice || pushNotice.sticky) {
      return;
    }
    window.clearTimeout(pushTimer.current);
    pushTimer.current = window.setTimeout(() => {
      dismissPush();
    }, PUSH_DURATION_MS);
    return () => window.clearTimeout(pushTimer.current);
  }, [pushNotice]);

  useEffect(() => {
    if (!bannerError) {
      return;
    }
    showPush(bannerError, "danger", "errorCircle");
  }, [bannerError]);

  useEffect(() => {
    if (!reminderNotice) {
      return;
    }
    showPush(reminderNotice, "success", "checkmarkCircle");
  }, [reminderNotice]);

  useEffect(() => {
    if (!designNotice) {
      return;
    }
    showPush(designNotice, "success", "checkmarkCircle");
  }, [designNotice]);

  useEffect(() => {
    const text = sendProgressPushText(sendProgress);
    if (text && composeOpen && composeStep === "form") {
      showPush(text, "accent", "arrowUpload", undefined, { sticky: true, source: "form" });
      return;
    }
    if (pushNoticeRef.current?.sticky && sendProgress !== "failed") {
      dismissPush();
    }
  }, [composeOpen, composeStep, sendProgress]);

  useEffect(() => {
    if (!showLoadBanner) {
      return;
    }
    showPush(
      he.partialRequestsFailed,
      "danger",
      "errorCircle",
      onRetryLoadRef.current
        ? {
            label: he.tryAgain,
            onClick: () => {
              void onRetryLoadRef.current?.();
            },
          }
        : undefined,
    );
  }, [showLoadBanner]);

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
      if (composeStep === "form") {
        composeFirstRef.current?.focus();
      } else {
        composeTitleRef.current?.focus();
      }
    }
  }, [composeOpen, composeLeaving, composeStep]);

  useEffect(() => {
    if (!composeOpen || composeLeaving || composeStep !== "form" || formMode !== "send") {
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview")
      .then(async (api) => {
        if (cancelled) {
          return;
        }
        unlisten = await api.getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            setSendDropActive(false);
            const path = event.payload.paths[0];
            if (path) {
              void onPickDroppedFile?.(path);
            }
            return;
          }
          if (event.payload.type === "leave") {
            setSendDropActive(false);
            return;
          }
          setSendDropActive(true);
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [composeLeaving, composeOpen, composeStep, formMode, onPickDroppedFile]);

  useEffect(() => {
    if (!recipientOpen) {
      return;
    }
    function onPointer(event: MouseEvent) {
      if (!recipientWrapRef.current?.contains(event.target as Node)) {
        setRecipientOpen(false);
      }
    }
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [recipientOpen]);

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
      return formMode === "send" ? he.taskDescriptionRequired : he.fileDescriptionRequired;
    }
    if (code === "instruction_too_long") {
      return he.instructionTooLong;
    }
    return null;
  }

  function resolveSendRecipient(): string | null {
    if (recipientId && others.some((member) => member.id === recipientId)) {
      return recipientId;
    }
    const typed = recipientQuery.trim();
    if (!typed) {
      return null;
    }
    const exact = others.find((member) => memberMatchesExact(member, typed));
    if (exact) {
      return exact.id;
    }
    const matches = others.filter((member) => memberMatchesQuery(member, typed));
    return matches.length === 1 ? matches[0]!.id : null;
  }

  function onSend() {
    const selected = resolveSendRecipient();
    if (formMode === "file_request") {
      const problem = validateFileRequestForm({
        recipientMemberId: selected,
        instruction,
      });
      if (problem || !selected) {
        const label = sendErrorLabel(problem) ?? he.recipientRequired;
        showPush(label, "danger", "alert", undefined, { source: "form" });
        return;
      }
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
      const label = sendErrorLabel(problem) ?? he.recipientRequired;
      showPush(label, "danger", "alert", undefined, { source: "form" });
      return;
    }
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
    setRecipientQuery("");
    setRecipientId("");
    setRecipientOpen(false);
    void onCancelSend?.();
  }

  function closeCompose() {
    if (pushNoticeRef.current?.source === "form") {
      dismissPush();
    }
    const finish = () => {
      onClearForm();
      setComposeStep("choose");
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

  function backToChooser() {
    if (pushNoticeRef.current?.source === "form") {
      dismissPush();
    }
    setSendDropActive(false);
    setRecipientId("");
    setRecipientQuery("");
    setRecipientOpen(false);
    setComposeStep("choose");
  }

  function openDetail(id: string, from?: HTMLElement | null) {
    if (listScrollRef.current) {
      listScrollTop.current = listScrollRef.current.scrollTop;
    }
    openedFromCard.current = from ?? null;
    openedFromId.current = id;
    setActionsOpen(false);
    setDrawerLeaving(false);
    drawerLeavingRef.current = false;
    window.clearTimeout(drawerMotionTimer.current);
    drawerMotionTimer.current = 0;
    window.clearTimeout(panelMotionTimer.current);
    panelMotionTimer.current = 0;
    setPanelLeaving(false);
    panelLeavingRef.current = false;
    setPanelEnter(false);
    setDockExpanded(false);
    window.cancelAnimationFrame(dockExpandFrame.current);
    closeActionForm();
    setHistoryCollapsed(null);
    setSlideDir("start");
    setDetailId(id);
  }

  function closeActionForm() {
    setDesignDialog(null);
    setDesignDropActive(false);
    setResultNoteFor(null);
    setRevisionFor(null);
  }

  function afterPanelLeave(fn: () => void) {
    const finish = () => {
      panelMotionTimer.current = 0;
      panelLeavingRef.current = false;
      setPanelLeaving(false);
      setPanelEnter(true);
      fn();
    };
    if (motionDuration(180) === 0 || drawerLeavingRef.current) {
      finish();
      return;
    }
    if (panelLeavingRef.current) {
      return;
    }
    panelLeavingRef.current = true;
    setPanelLeaving(true);
    window.clearTimeout(panelMotionTimer.current);
    panelMotionTimer.current = window.setTimeout(finish, 180);
  }

  function backToMenu() {
    afterPanelLeave(() => {
      closeActionForm();
      setActionsOpen(true);
    });
  }

  function expandDock() {
    window.cancelAnimationFrame(dockExpandFrame.current);
    if (motionDuration(260) === 0) {
      setDockExpanded(true);
      return;
    }
    setDockExpanded(false);
    dockExpandFrame.current = window.requestAnimationFrame(() => {
      dockExpandFrame.current = window.requestAnimationFrame(() => {
        setDockExpanded(true);
      });
    });
  }

  function closeDrawer() {
    const finish = () => {
      drawerMotionTimer.current = 0;
      drawerLeavingRef.current = false;
      setDrawerLeaving(false);
      panelLeavingRef.current = false;
      setPanelLeaving(false);
      setPanelEnter(false);
      setDockExpanded(false);
      setActionsOpen(false);
      closeActionForm();
    };
    window.cancelAnimationFrame(dockExpandFrame.current);
    window.clearTimeout(panelMotionTimer.current);
    panelMotionTimer.current = 0;
    panelLeavingRef.current = false;
    setPanelLeaving(false);
    setDockExpanded(false);
    if (motionDuration(260) === 0) {
      finish();
      return;
    }
    if (drawerLeavingRef.current) {
      return;
    }
    drawerLeavingRef.current = true;
    setDrawerLeaving(true);
    window.clearTimeout(drawerMotionTimer.current);
    drawerMotionTimer.current = window.setTimeout(finish, 260);
  }

  function closeDetail() {
    const finish = () => {
      setActionsOpen(false);
      setDrawerLeaving(false);
      drawerLeavingRef.current = false;
      window.clearTimeout(drawerMotionTimer.current);
      drawerMotionTimer.current = 0;
      window.clearTimeout(panelMotionTimer.current);
      panelMotionTimer.current = 0;
      setPanelLeaving(false);
      panelLeavingRef.current = false;
      setPanelEnter(false);
      setDockExpanded(false);
      window.cancelAnimationFrame(dockExpandFrame.current);
      closeActionForm();
      setHistoryCollapsed(null);
      setDetailId(null);
      setScreenLeaving(false);
    };
    if (motionDuration(SCREEN_SLIDE_MS) === 0) {
      finish();
      return;
    }
    setSlideDir("end");
    setScreenLeaving(true);
    runAfterMotion(SCREEN_SLIDE_MS, finish);
  }

  function closeSettings() {
    const finish = () => {
      setSettingsOpen(false);
      setScreenLeaving(false);
      window.requestAnimationFrame(() => {
        settingsTriggerRef.current?.focus();
      });
    };
    if (motionDuration(SCREEN_SLIDE_MS) === 0) {
      finish();
      return;
    }
    setSlideDir("end");
    setScreenLeaving(true);
    runAfterMotion(SCREEN_SLIDE_MS, finish);
  }

  function goToPrimary(tab: PrimaryView) {
    const from = PRIMARY_VIEWS.indexOf(primaryView);
    const to = PRIMARY_VIEWS.indexOf(tab);
    setSlideDir(settingsOpen || detailId || to > from ? "end" : "start");
    setFilterOpen(false);
    setSettingsOpen(false);
    setScreenLeaving(false);
    setPrimaryView(tab);
    setActionsOpen(false);
    setDrawerLeaving(false);
    drawerLeavingRef.current = false;
    closeActionForm();
    setHistoryCollapsed(null);
    setDetailId(null);
  }

  function openSettings() {
    if (listScrollRef.current) {
      listScrollTop.current = listScrollRef.current.scrollTop;
    }
    setDetailId(null);
    setActionsOpen(false);
    setDrawerLeaving(false);
    drawerLeavingRef.current = false;
    setHistoryCollapsed(null);
    setFilterOpen(false);
    setSlideDir("start");
    setSettingsOpen(true);
  }

  const recipientMatches = others.filter((member) => memberMatchesQuery(member, recipientQuery));

  return (
    <main className={`fr-shell${drawerScrimShown ? " fr-drawer-open" : ""}${composeOpen ? " fr-compose-open" : ""}`}>
      <NavigationRail
        primaryView={primaryView}
        settingsOpen={settingsOpen}
        unread={unread}
        settingsRef={settingsTriggerRef}
        onSelectView={goToPrimary}
        onOpenSettings={openSettings}
      />
      <div className="fr-workspace">
      <div className="fr-chrome">
      <header className="fr-header">
        {detailCard ? (
          <div className="fr-detail-head">
            <button type="button" className="fr-header-back" onClick={closeDetail}>
              <FluentIcon name="chevronLeft" rtlFlip />
              {he.back}
            </button>
          </div>
        ) : settingsOpen ? null : (
          <WorkspaceToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            filter={
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
            }
            compose={
              !waiting && onSubmitSend ? (
                <button
                  type="button"
                  className="fr-icon-btn fr-icon-btn-accent"
                  aria-label={he.newRequest}
                  ref={composeTriggerRef}
                  onClick={() => {
                    setComposeStep("choose");
                    setComposeOpen(true);
                  }}
                >
                  <FluentIcon name="add" />
                </button>
              ) : (
                <span className="fr-toolbar-spacer" />
              )
            }
          />
        )}
      </header>
      <PushBanner
        open={pushOpen && !composeOpen}
        notice={composeOpen ? null : pushNotice}
        onDismiss={dismissPush}
      />
      </div>

      <div className="fr-main">
        {waiting && !settingsOpen && !detailCard ? (
          <p className="fr-hint">{he.waitingForMembers}</p>
        ) : null}

        {settingsOpen ? (
          <section
            ref={settingsScreenRef}
            className={`fr-screen${screenLeaving ? " fr-leaving" : " fr-screen-in"}`}
            data-slide={slideDir}
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
        <div
          key={detailCard ? "detail" : primaryView}
          className={detailCard ? `fr-screen${screenLeaving ? " fr-leaving" : " fr-screen-in"}` : "fr-list-in"}
          data-slide={slideDir}
        >
        <section
          ref={listScrollRef}
          className="fr-scroll"
          key={detailCard ? "detail" : primaryView}
        >
          {!detailCard && visibleItems.length === 0 ? (
            <div className={`fr-empty${searching ? " fr-empty-search" : ""}`}>
              <FluentIcon name={searching ? "search" : "document"} />
              <p>{searching ? he.noSearchMatches : emptyLabel(primaryView)}</p>
            </div>
          ) : (
            (detailCard
              ? [{ key: "detail", cards: [{ key: detailCard.id, card: detailCard }] }]
              : [{ key: primaryView, cards: visibleItems }]
            ).map((group) => (
              <div key={group.key} className={detailCard ? "fr-detail-pane" : "fr-list-swap"}>
                <div
                  key={detailCard ? "detail" : primaryView}
                  className={detailCard ? "fr-detail-pane-inner" : "fr-list-filter"}
                >
                {group.cards.map((item) => {
              const card = item.card;
              const handoff = card.source.record;
              const isLegacy = card.source.kind === "legacy";
              const role = isLegacy ? handoffRole(handoff, currentMemberId) : null;
              const local = workingLocal(inbox, handoff.id);
              const already = Boolean(local);
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
              const designAllActions = handoff.id === DESIGN_ALL_ACTIONS_ID;
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
              const showRemind = Boolean(
                designAllActions ||
                  (v2Source && currentMemberId && onRemind && canRemind(v2Source, currentMemberId)),
              );
              const showCancel = Boolean(
                designAllActions ||
                  (v2Source && currentMemberId && onCancelV2 && canCancelV2(v2Source, currentMemberId)),
              );
              const changed = workingFileChanged(inbox, handoff.id);
              const historyShown = historyCollapsed !== handoff.id;
              const revisionOpen = revisionFor === handoff.id;
              const actionFormOpen =
                resultNoteFor === handoff.id || revisionOpen || Boolean(designDialog);
              const drawerShown = actionsOpen || actionFormOpen || drawerLeaving;
              const dockPanelKey =
                resultNoteFor === handoff.id
                  ? "reject"
                  : revisionOpen
                    ? "revision"
                    : (designDialog ?? "menu");
              const rejectFormTitle = designAllActions
                ? he.reject
                : primary === "update"
                  ? he.replyLabel
                  : primary === "attach"
                    ? he.rejectReasonLabel
                    : he.optionalNoteLabel;
              const designFormTitle =
                designDialog === "approve"
                  ? he.approve
                  : designDialog === "attach"
                    ? he.attachFile
                    : designDialog === "remind"
                      ? he.sendReminder
                      : he.cancelRequest;
              const designFormIcon: IconName =
                designDialog === "approve"
                  ? "checkmarkCircle"
                  : designDialog === "attach"
                    ? "attach"
                    : designDialog === "remind"
                      ? "alert"
                      : "prohibited";
              const confirmActionForm = (): boolean => {
                if (resultNoteFor === handoff.id) {
                  if (designAllActions) {
                    return true;
                  }
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
                    return false;
                  }
                  if (trimmed.length > REVISION_NOTE_MAX) {
                    setResultNoteError(he.revisionNoteTooLong);
                    return false;
                  }
                  setResultNoteError(null);
                  if (primary === "attach") {
                    void onCannotProvide?.(handoff, trimmed);
                  } else if (primary === "update") {
                    void onReturnUpdate?.(handoff, trimmed);
                  } else {
                    void onReject?.(handoff, trimmed);
                  }
                  return true;
                }
                if (revisionOpen) {
                  if (designAllActions) {
                    return true;
                  }
                  const problem = validateRevisionNote(revisionNote);
                  if (problem === "revision_note_required") {
                    setRevisionError(he.cloudError.revision_note_required);
                    return false;
                  }
                  if (problem === "revision_note_too_long") {
                    setRevisionError(he.revisionNoteTooLong);
                    return false;
                  }
                  setRevisionError(null);
                  if (v2Source) {
                    void onRevisionV2?.(handoff, revisionNote.trim());
                  } else {
                    void onRequestRevision?.(handoff, revisionNote.trim());
                  }
                  return true;
                }
                if (designDialog === "remind") {
                  setDesignNotice(he.reminderSent);
                }
                return true;
              };
              const dockPrimaryLabel = resultNoteFor === handoff.id
                ? primary === "attach"
                  ? he.cannotProvide
                  : primary === "update"
                    ? he.returnUpdate
                    : he.reject
                : revisionOpen
                  ? he.confirmRevision
                  : designDialog
                    ? designFormTitle
                    : he.actions;
              const dockPrimaryDanger = Boolean(
                (resultNoteFor === handoff.id && (designAllActions || primary === "attach")) ||
                  designDialog === "cancel",
              );
              const dockPrimaryIcon: IconName = resultNoteFor === handoff.id
                ? primary === "update"
                  ? "arrowSync"
                  : "dismissCircle"
                : revisionOpen
                  ? "arrowSync"
                  : designDialog
                    ? designFormIcon
                    : "arrowJoin";
              const compact = !detailCard;
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
              const handle = counterpartHandle(presented.counterpart);
              const senderName = presented.people.senderName;
              const senderEmail = memberEmail(members, presented.people.senderId);
              const detailTitle =
                presented.title ?? presented.subjectText ?? presented.headline;
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
              const commandBusy = v2Busy || returning;
              const canApproveAction = Boolean(
                designAllActions ||
                  (primary === "approve" && onApprove) ||
                  (primary === "review" && onFinishReview) ||
                  (senderActs.accept && onAcceptV2) ||
                  (isLegacy && role === "sender" && handoff.status === "returned" && onCompleteHandoff),
              );
              const canRejectAction = Boolean(
                designAllActions ||
                  ((primary === "approve" || primary === "review" || primary === "update") &&
                    onReject) ||
                  (primary === "attach" && onCannotProvide),
              );
              const canAttachAction = Boolean(
                designAllActions ||
                  (primary === "attach" && onAttachFileRequest) ||
                  (primary === "update" && onReturnUpdate) ||
                  (isLegacy && canReturn && onReturnFile),
              );
              const canRevisionAction = Boolean(
                designAllActions ||
                  senderActs.revision ||
                  (isLegacy && role === "sender" && handoff.status === "returned"),
              );
              const showRetry = localWork === "retry" || localWork === "offline";
              const showReselect = localWork === "waiting_reselect";
              const showAbort = localWork !== "idle" && Boolean(onAbortLocal);
              const runCardAction = (run: () => boolean | void, stayOpen = false) => {
                if (stayOpen) {
                  afterPanelLeave(() => {
                    run();
                  });
                  return;
                }
                if (run() === false) {
                  return;
                }
                closeDrawer();
              };
              const cardCommands = compact
                ? []
                : [
                    ...(showRetry
                      ? [
                          {
                            icon: "arrowSync" as const,
                            label: he.tryAgain,
                            stayOpen: false,
                            run: () => {
                              void onRetryLocal?.(handoff.id);
                            },
                          },
                        ]
                      : []),
                    ...(showReselect
                      ? [
                          {
                            icon: "document" as const,
                            label: he.chooseFile,
                            stayOpen: false,
                            run: () => {
                              void onRestoreSnapshot?.(handoff.id);
                            },
                          },
                        ]
                      : []),
                    ...(showAbort
                      ? [
                          {
                            icon: "dismiss" as const,
                            label: he.abortAttempt,
                            danger: true,
                            stayOpen: false,
                            run: () => {
                              void onAbortLocal?.(handoff.id);
                            },
                          },
                        ]
                      : []),
                    ...(!commandBusy && canApproveAction
                      ? [
                          {
                            icon: "checkmarkCircle" as const,
                            label: he.approve,
                            stayOpen: designAllActions,
                            run: () => {
                              if (designAllActions) {
                                setResultNote("");
                                setResultNoteError(null);
                                setDesignDialog("approve");
                                return;
                              }
                              if (primary === "approve" && onApprove) {
                                if (changed && !window.confirm(he.fileChangedConfirm)) {
                                  return false;
                                }
                                void onApprove(
                                  handoff,
                                  resultNoteFor === handoff.id ? resultNote.trim() || null : null,
                                );
                                return;
                              }
                              if (primary === "review" && onFinishReview) {
                                void onFinishReview(
                                  handoff,
                                  resultNoteFor === handoff.id ? resultNote.trim() || null : null,
                                );
                                return;
                              }
                              if (senderActs.accept && onAcceptV2) {
                                void onAcceptV2(handoff);
                                return;
                              }
                              void onCompleteHandoff?.(handoff);
                            },
                          },
                        ]
                      : []),
                    ...(!commandBusy && canRejectAction
                      ? [
                          {
                            icon: "dismissCircle" as const,
                            label: he.reject,
                            danger: true,
                            stayOpen: true,
                            run: () => {
                              setResultNoteFor(handoff.id);
                              setResultNote("");
                              setResultNoteError(null);
                            },
                          },
                        ]
                      : []),
                    ...(!commandBusy && canAttachAction
                      ? [
                          {
                            icon: "attach" as const,
                            label: he.attachFile,
                            stayOpen:
                              designAllActions || Boolean(primary === "update" && !changed),
                            run: () => {
                              if (designAllActions) {
                                setDesignPickedName(null);
                                setDesignDropActive(false);
                                setDesignDialog("attach");
                                return;
                              }
                              if (primary === "attach" && onAttachFileRequest) {
                                void onAttachFileRequest(handoff);
                                return;
                              }
                              if (primary === "update" && onReturnUpdate) {
                                if (!changed) {
                                  setResultNoteFor(handoff.id);
                                  setResultNoteError(null);
                                  return;
                                }
                                void onReturnUpdate(
                                  handoff,
                                  resultNoteFor === handoff.id ? resultNote.trim() || null : null,
                                );
                                return;
                              }
                              void onReturnFile?.(handoff);
                            },
                          },
                        ]
                      : []),
                    ...(!commandBusy && showRemind
                      ? [
                          {
                            icon: "alert" as const,
                            label: he.sendReminder,
                            stayOpen: designAllActions,
                            run: () => {
                              if (designAllActions) {
                                setDesignDialog("remind");
                                return;
                              }
                              void onRemind?.(handoff);
                            },
                          },
                        ]
                      : []),
                    ...(!commandBusy && showCancel
                      ? [
                          {
                            icon: "prohibited" as const,
                            label: he.cancelRequest,
                            danger: true,
                            stayOpen: designAllActions,
                            run: () => {
                              if (designAllActions) {
                                setDesignDialog("cancel");
                                return;
                              }
                              void onCancelV2?.(handoff);
                            },
                          },
                        ]
                      : []),
                    ...(!commandBusy && canRevisionAction
                      ? [
                          {
                            icon: "arrowSync" as const,
                            label: he.requestRevision,
                            stayOpen: true,
                            run: () => {
                              setRevisionFor(handoff.id);
                              setRevisionNote("");
                              setRevisionError(null);
                            },
                          },
                        ]
                      : []),
                  ];
              return (
                <div key={item.key} className={compact ? undefined : "fr-detail-stack"}>
                <article
                  data-handoff-id={handoff.id}
                  className={`fr-card${compact ? " fr-card-compact" : " fr-card-detail"}${compact && presented.settled ? " fr-card-settled" : ""}`}
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
                  {compact && (handle || presented.title) ? (
                    <div className="fr-sentence">
                      {handle ? (
                        <>
                          <span className="fr-sentence-who">
                            <span className="fr-sentence-at" aria-hidden="true">
                              @
                            </span>
                            {" "}
                            <span dir="auto" className="fr-sentence-user">
                              {handle}
                            </span>
                          </span>
                          {presented.title ? (
                            <span className="fr-sentence-dot" aria-hidden="true">
                              {" · "}
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
                  {!compact ? (
                    <>
                      <h2 ref={detailTitleRef} tabIndex={-1} className="fr-detail-title">
                        <span dir="auto">{detailTitle}</span>
                      </h2>
                      <div className="fr-detail-from">
                        {senderName ? (
                          <div className="fr-detail-from-row">
                            <span className="fr-sentence-at" aria-hidden="true">
                              @
                            </span>
                            <span dir="auto">{senderName}</span>
                          </div>
                        ) : null}
                        {senderEmail ? (
                          <div className="fr-detail-from-row">
                            <FluentIcon name="mail" size={14} />
                            <span dir="ltr">{senderEmail}</span>
                          </div>
                        ) : null}
                        {presented.dueLabel ? (
                          <div className="fr-detail-from-row">
                            <FluentIcon name="calendar" size={14} />
                            <span>{presented.dueLabel}</span>
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : presented.dueLabel ? (
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
                  {detailCard ? (
                    <>
                      <button
                        type="button"
                        className="fr-activity-head"
                        aria-expanded={historyShown}
                        aria-label={historyShown ? he.hideHistory : he.showHistory}
                        onClick={() => {
                          setHistoryCollapsed(historyShown ? handoff.id : null);
                        }}
                      >
                        <span className="fr-activity-label">
                          <FluentIcon name="timeline" size={16} />
                          {he.activity}
                        </span>
                        <span className="fr-activity-chevron" aria-hidden="true">
                          <FluentIcon name="chevronDown" />
                        </span>
                      </button>
                      <div className={`fr-history-fold${historyShown ? " fr-open" : ""}`}>
                        <ol className="fr-history">
                          {history.map((line, index) => (
                            <li
                              key={`${handoff.id}-${line.eventType}-${index}`}
                              className="fr-history-item"
                            >
                              <span className="fr-history-icon">
                                <FluentIcon name={historyIcon(line.eventType)} />
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
                              </div>
                            </li>
                          ))}
                        </ol>
                      </div>
                    </>
                  ) : null}
                </article>
                  {!compact && cardCommands.length > 0 ? (
                    <div
                      className={`fr-detail-dock${drawerShown ? " fr-dock-open" : ""}${drawerLeaving ? " fr-leaving" : ""}`}
                    >
                      <div className="fr-dock-anchor">
                      {drawerShown ? (
                        <div
                          className={`fr-dock-clip${dockExpanded && !drawerLeaving ? " fr-expanded" : ""}`}
                        >
                        <div className="fr-dock-sheet">
                          <div className="fr-dock-handle" aria-hidden="true" />
                          <div
                            className={`fr-dock-panel${panelEnter ? " fr-panel-enter" : ""}${panelLeaving ? " fr-panel-leaving" : ""}`}
                            key={dockPanelKey}
                          >
                      {resultNoteFor === handoff.id ? (
                        <FormDrawer
                          titleId="result-note-title"
                          title={rejectFormTitle}
                          icon={
                            primary === "update" ? "arrowSync" : "dismissCircle"
                          }
                          onClose={backToMenu}
                        >
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
                        </FormDrawer>
                      ) : revisionOpen ? (
                        <FormDrawer
                          titleId="revision-title"
                          title={he.requestRevision}
                          icon="arrowSync"
                          onClose={backToMenu}
                        >
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
                        </FormDrawer>
                      ) : designDialog ? (
                        <FormDrawer
                          titleId="design-action-title"
                          title={designFormTitle}
                          icon={designFormIcon}
                          onClose={backToMenu}
                        >
                          {designDialog === "approve" ? (
                            <label className="fr-field-wrap">
                              <span className="fr-label">{he.optionalNoteLabel}</span>
                              <textarea
                                className="fr-area"
                                maxLength={REVISION_NOTE_MAX}
                                value={resultNote}
                                onChange={(event) => {
                                  setResultNote(event.target.value);
                                }}
                              />
                            </label>
                          ) : null}
                          {designDialog === "attach" ? (
                            <div className="fr-drop-stack">
                              <input
                                ref={designFileInputRef}
                                type="file"
                                className="fr-file-input"
                                tabIndex={-1}
                                onChange={(event) => {
                                  const name = firstDroppedName(event.currentTarget.files);
                                  if (name) {
                                    setDesignPickedName(name);
                                  }
                                  event.currentTarget.value = "";
                                }}
                              />
                              <div
                                className={`fr-dropzone${designDropActive ? " fr-drop-active" : ""}`}
                                onDragEnter={(event) => {
                                  event.preventDefault();
                                  setDesignDropActive(true);
                                }}
                                onDragOver={(event) => {
                                  event.preventDefault();
                                  event.dataTransfer.dropEffect = "copy";
                                }}
                                onDragLeave={(event) => {
                                  if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                                    setDesignDropActive(false);
                                  }
                                }}
                                onDrop={(event) => {
                                  event.preventDefault();
                                  setDesignDropActive(false);
                                  const name = firstDroppedName(event.dataTransfer.files);
                                  if (name) {
                                    setDesignPickedName(name);
                                  }
                                }}
                              >
                                <FluentIcon name="documentQueueAdd" size={20} />
                                {designPickedName ? (
                                  <FileName name={designPickedName} className="fr-dropzone-name" />
                                ) : (
                                  <span className="fr-dropzone-hint">{he.dropHint}</span>
                                )}
                              </div>
                              <button
                                type="button"
                                className="fr-btn fr-btn-secondary"
                                onClick={() => {
                                  designFileInputRef.current?.click();
                                }}
                              >
                                {he.browseFromExplorer}
                              </button>
                            </div>
                          ) : null}
                          {designDialog === "remind" ? (
                            <p className="fr-dialog-body">{he.sendReminderConfirm}</p>
                          ) : null}
                          {designDialog === "cancel" ? (
                            <p className="fr-dialog-body">{he.cancelRequestConfirm}</p>
                          ) : null}
                        </FormDrawer>
                      ) : actionsOpen ? (
                        <div className="fr-action-drawer" role="group" aria-label={he.actions}>
                          <div className="fr-command-list">
                            {cardCommands.map((command) => (
                              <CommandRow
                                key={command.label}
                                icon={command.icon}
                                label={command.label}
                                danger={command.danger}
                                onClick={() => {
                                  runCardAction(command.run, command.stayOpen);
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      ) : null}
                          </div>
                        </div>
                        </div>
                      ) : null}
                      <button
                        type="button"
                        className={`fr-actions-launch${actionFormOpen ? "" : " fr-actions-launch-menu"}${dockPrimaryDanger ? " fr-actions-launch-danger" : ""}`}
                        dir="rtl"
                        aria-expanded={drawerShown}
                        aria-haspopup={actionFormOpen ? undefined : "true"}
                        onClick={() => {
                          if (actionFormOpen) {
                            if (!confirmActionForm()) {
                              return;
                            }
                            closeDrawer();
                            return;
                          }
                          if (actionsOpen) {
                            closeDrawer();
                            return;
                          }
                          setDrawerLeaving(false);
                          drawerLeavingRef.current = false;
                          setPanelLeaving(false);
                          panelLeavingRef.current = false;
                          setPanelEnter(false);
                          setActionsOpen(true);
                          expandDock();
                        }}
                      >
                        <FluentIcon name={dockPrimaryIcon} size={actionFormOpen ? 18 : 20} />
                        {dockPrimaryLabel}
                      </button>
                      </div>
                    </div>
                  ) : null}
                </div>
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

      {drawerScrimShown ? (
        <div
          className={`fr-drawer-scrim${drawerLeaving ? " fr-leaving" : ""}`}
          role="presentation"
          onClick={() => {
            closeDrawer();
          }}
        />
      ) : null}
      </div>

      {composeOpen && !waiting && onSubmitSend ? (
        <div
          className={`fr-overlay${composeLeaving ? " fr-leaving" : ""}${
            composeStep === "choose" ? " fr-overlay-choose" : " fr-overlay-send"
          }`}
          role="presentation"
        >
          {composeStep === "choose" ? (
            <div
              ref={composeRef}
              className="fr-compose-choose"
              role="dialog"
              aria-modal="true"
              aria-labelledby="compose-title"
            >
              <button
                type="button"
                className="fr-icon-btn fr-compose-close"
                aria-label={he.closeDialog}
                onClick={closeCompose}
              >
                <FluentIcon name="dismiss" />
              </button>
              <h2 id="compose-title" className="fr-compose-question" tabIndex={-1} ref={composeTitleRef}>
                {he.whatDoYouWant}
              </h2>
              <div className="fr-compose-cards">
                <button
                  type="button"
                  className="fr-compose-card"
                  onClick={() => {
                    setFormMode("send");
                    setComposeStep("form");
                  }}
                >
                  <FluentIcon name="send" size={20} className="fr-compose-send-icon" />
                  <span className="fr-compose-card-label">{he.sendNewFile}</span>
                </button>
                <button
                  type="button"
                  className="fr-compose-card"
                  onClick={() => {
                    setFormMode("file_request");
                    setComposeStep("form");
                  }}
                >
                  <FluentIcon name="mailInboxArrowDown" size={32} />
                  <span className="fr-compose-card-label">{he.requestFile}</span>
                </button>
                <button
                  type="button"
                  className="fr-compose-card"
                  onClick={() => {
                    setFormMode("external_link");
                    setComposeStep("form");
                  }}
                >
                  <FluentIcon name="link" size={32} />
                  <span className="fr-compose-card-label">{he.createExternalLink}</span>
                </button>
              </div>
            </div>
          ) : formMode === "send" ? (
          <div
            ref={composeRef}
            className="fr-compose-send"
            role="dialog"
            aria-modal="true"
            aria-labelledby="compose-title"
          >
            <div className="fr-compose-form-nav">
              <button type="button" className="fr-header-back" onClick={backToChooser}>
                <FluentIcon name="chevronLeft" rtlFlip />
                {he.back}
              </button>
              <button
                type="button"
                className="fr-icon-btn"
                aria-label={he.closeDialog}
                onClick={closeCompose}
              >
                <FluentIcon name="dismiss" />
              </button>
            </div>
            <PushBanner open={pushOpen} notice={pushNotice} onDismiss={dismissPush} />
            <div className="fr-compose-send-body">
            <h2 id="compose-title" className="fr-compose-form-title">
              <FluentIcon name="send" size={18} className="fr-compose-send-icon" />
              {he.sendNewFile}
            </h2>
            <div
              ref={(node) => {
                composeFirstRef.current = node;
              }}
              className={`fr-dropzone${sendDropActive ? " fr-drop-active" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={he.chooseFile}
              onClick={() => {
                void onPickFile?.();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void onPickFile?.();
                }
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                setSendDropActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  setSendDropActive(false);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                setSendDropActive(false);
                const path = droppedFilePath(event.dataTransfer.files[0]);
                if (path) {
                  void onPickDroppedFile?.(path);
                  return;
                }
                void onPickFile?.();
              }}
            >
              {pickedFile ? (
                <span className="fr-dropzone-picked">
                  <FileName name={pickedFile.originalFilename} className="fr-dropzone-name" />
                  <button
                    type="button"
                    className="fr-icon-btn"
                    aria-label={he.removeFile}
                    onClick={(event) => {
                      event.stopPropagation();
                      void onCancelSend?.();
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    <FluentIcon name="delete" />
                  </button>
                </span>
              ) : (
                <>
                  <FluentIcon name="documentQueueAdd" size={20} className="fr-dropzone-hero" />
                  <span className="fr-dropzone-hint">{he.dropHint}</span>
                  <span className="fr-dropzone-browse">{he.browseFromExplorer}</span>
                </>
              )}
            </div>
            <div className="fr-field-wrap fr-recipient-wrap" ref={recipientWrapRef}>
              <label className="fr-label" htmlFor="compose-recipient">
                {he.toAtLabel}
              </label>
              <input
                id="compose-recipient"
                type="text"
                className="fr-field"
                role="combobox"
                autoComplete="off"
                aria-expanded={recipientOpen && recipientMatches.length > 0}
                aria-controls="compose-recipient-list"
                aria-autocomplete="list"
                placeholder={he.chooseRecipient}
                value={recipientQuery}
                onChange={(event) => {
                  const value = event.target.value;
                  setRecipientQuery(value);
                  setRecipientOpen(true);
                  const exact = others.find((member) => memberMatchesExact(member, value));
                  setRecipientId(exact?.id ?? "");
                }}
                onFocus={() => {
                  if (recipientQuery.trim()) {
                    setRecipientOpen(true);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setRecipientOpen(false);
                  }
                  if (event.key === "Enter" && recipientMatches.length === 1) {
                    event.preventDefault();
                    const match = recipientMatches[0]!;
                    setRecipientId(match.id);
                    setRecipientQuery(memberRecipientLabel(match));
                    setRecipientOpen(false);
                  }
                }}
              />
              {recipientOpen && recipientMatches.length > 0 ? (
                <div id="compose-recipient-list" className="fr-suggest" role="listbox">
                  {recipientMatches.map((member) => (
                    <button
                      key={member.id}
                      type="button"
                      className="fr-suggest-item"
                      role="option"
                      aria-selected={member.id === recipientId}
                      onClick={() => {
                        setRecipientId(member.id);
                        setRecipientQuery(memberRecipientLabel(member));
                        setRecipientOpen(false);
                      }}
                    >
                      {memberRecipientLabel(member)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <fieldset className="fr-field-wrap">
              <legend className="fr-label fr-label-icon">
                <FluentIcon name="windowBulletList" />
                {he.requestTypeLabel}
              </legend>
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
                  <span>{he.approve}</span>
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
                  <span>{he.kindReview}</span>
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
                  <span>{he.kindUpdate}</span>
                </label>
              </div>
            </fieldset>
            <label className="fr-field-wrap">
              <span className="fr-label fr-label-icon">
                <FluentIcon name="commentArrowLeft" />
                {he.taskDescriptionLabel}
              </span>
              <textarea
                className="fr-area"
                maxLength={INSTRUCTION_MAX}
                value={instruction}
                onChange={(event) => {
                  setInstruction(event.target.value);
                }}
              />
            </label>
            <label className="fr-field-wrap">
              <span className="fr-label fr-label-icon">
                <FluentIcon name="calendarArrowRepeat" />
                {he.dueOnCompleteLabel}
              </span>
              <input
                type="date"
                className="fr-field fr-date"
                value={dueOn}
                onChange={(event) => {
                  setDueOn(event.target.value);
                }}
              />
            </label>
            <div className="fr-compose-form-actions">
              <button
                type="button"
                className="fr-btn fr-btn-primary"
                disabled={sending}
                onClick={onSend}
              >
                {he.send}
              </button>
              <button type="button" className="fr-btn fr-btn-secondary" onClick={closeCompose}>
                {he.cancel}
              </button>
            </div>
            </div>
          </div>
          ) : formMode === "file_request" ? (
          <div
            ref={composeRef}
            className="fr-compose-send fr-compose-request"
            role="dialog"
            aria-modal="true"
            aria-labelledby="compose-title"
          >
            <div className="fr-compose-form-nav">
              <button type="button" className="fr-header-back" onClick={backToChooser}>
                <FluentIcon name="chevronLeft" rtlFlip />
                {he.back}
              </button>
              <button
                type="button"
                className="fr-icon-btn"
                aria-label={he.closeDialog}
                onClick={closeCompose}
              >
                <FluentIcon name="dismiss" />
              </button>
            </div>
            <PushBanner open={pushOpen} notice={pushNotice} onDismiss={dismissPush} />
            <div className="fr-compose-send-body">
              <h2 id="compose-title" className="fr-compose-form-title">
                <FluentIcon name="mailInboxArrowDown" size={18} />
                {he.requestFile}
              </h2>
              <div className="fr-field-wrap fr-recipient-wrap" ref={recipientWrapRef}>
                <label className="fr-label" htmlFor="request-recipient">
                  {he.toAtLabel}
                </label>
                <input
                  id="request-recipient"
                  ref={(node) => {
                    composeFirstRef.current = node;
                  }}
                  type="text"
                  className="fr-field"
                  role="combobox"
                  autoComplete="off"
                  aria-expanded={recipientOpen && recipientMatches.length > 0}
                  aria-controls="request-recipient-list"
                  aria-autocomplete="list"
                  placeholder={he.chooseRecipient}
                  value={recipientQuery}
                  onChange={(event) => {
                    const value = event.target.value;
                    setRecipientQuery(value);
                    setRecipientOpen(true);
                    const exact = others.find((member) => memberMatchesExact(member, value));
                    setRecipientId(exact?.id ?? "");
                  }}
                  onFocus={() => {
                    if (recipientQuery.trim()) {
                      setRecipientOpen(true);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setRecipientOpen(false);
                    }
                    if (event.key === "Enter" && recipientMatches.length === 1) {
                      event.preventDefault();
                      const match = recipientMatches[0]!;
                      setRecipientId(match.id);
                      setRecipientQuery(memberRecipientLabel(match));
                      setRecipientOpen(false);
                    }
                  }}
                />
                {recipientOpen && recipientMatches.length > 0 ? (
                  <div id="request-recipient-list" className="fr-suggest" role="listbox">
                    {recipientMatches.map((member) => (
                      <button
                        key={member.id}
                        type="button"
                        className="fr-suggest-item"
                        role="option"
                        aria-selected={member.id === recipientId}
                        onClick={() => {
                          setRecipientId(member.id);
                          setRecipientQuery(memberRecipientLabel(member));
                          setRecipientOpen(false);
                        }}
                      >
                        {memberRecipientLabel(member)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <label className="fr-field-wrap">
                <span className="fr-label fr-label-icon">
                  <FluentIcon name="commentArrowLeft" />
                  {he.fileDescriptionLabel}
                </span>
                <textarea
                  className="fr-area"
                  maxLength={INSTRUCTION_MAX}
                  value={instruction}
                  onChange={(event) => {
                    setInstruction(event.target.value);
                  }}
                />
              </label>
              <label className="fr-field-wrap">
                <span className="fr-label fr-label-icon">
                  <FluentIcon name="calendarArrowRepeat" />
                  {he.dueOnLabel}
                </span>
                <input
                  type="date"
                  className="fr-field fr-date"
                  value={dueOn}
                  onChange={(event) => {
                    setDueOn(event.target.value);
                  }}
                />
              </label>
              <div className="fr-compose-form-actions">
                <button
                  type="button"
                  className="fr-btn fr-btn-primary"
                  disabled={sending}
                  onClick={onSend}
                >
                  {he.sendRequest}
                </button>
                <button type="button" className="fr-btn fr-btn-secondary" onClick={closeCompose}>
                  {he.cancel}
                </button>
              </div>
            </div>
          </div>
          ) : (
            <div ref={composeRef} className="fr-compose-link-host">
              <ExternalLinkScreen
                policy={designLinkPolicy(externalLinkPolicy)}
                initialStage={designLinkStage(externalLinkStage)}
                onBack={backToChooser}
                onClose={closeCompose}
              />
            </div>
          )}
        </div>
      ) : null}
    </main>
  );
}
