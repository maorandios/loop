import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CloudConnectingScreen,
  CloudNotConfiguredScreen,
  CloudProblemScreen,
} from "./screens/CloudScreens";
import { cloudErrorHint, cloudErrorLabel, he } from "./copy/he";
import { createCommandIdStore } from "./features/handoff/commandIds";
import { createSupabaseHandoffService } from "./features/handoff/service";
import { createHandoffSyncController } from "./features/handoff/sync";
import { createReconciliationRegistry, isReturnTerminal } from "./features/handoff/reconciliation";
import {
  attachFileRequest,
  abortResumeRecord,
  createFileRequest,
  inboxGenerationFor,
  openRootTransfer,
  recoverResumeRecord,
  resultActionForRequest,
  sendHandoffV2,
  submitWithFile,
  submitWithoutFile,
  workingFileChangedAfterPrepare,
  type InvokeFn,
} from "./features/handoff/v2";
import { projectHandoffList } from "./features/handoff/view";
import type {
  HandoffRecord,
  HandoffService,
  InboxLocalEntry,
  LocalStateEvent,
  LocalWorkState,
  PendingLocalStatus,
  PickedFile,
  PreparedResultSnapshot,
  PreparedReturnSnapshot,
  ResultAction,
  ResumeSummary,
  SendAction,
  SendProgress,
  TransferRecord,
} from "./features/handoff/types";
import { latestHandoffVersion, versionLabel } from "./features/handoff/versions";
import { createSupabaseWorkspaceService } from "./features/workspace/service";
import { WorkspaceReadyScreen } from "./features/workspace/WorkspaceReadyScreen";
import { WorkspaceSetupScreen } from "./features/workspace/WorkspaceSetupScreen";
import type { Workspace, WorkspaceMember, WorkspaceService } from "./features/workspace/types";
import { cloudErrorCode, type CloudErrorCode } from "./lib/supabase/errors";
import { SetupScreen } from "./screens/SetupScreen";
import type { LocalDevice, Snapshot } from "./types";

type Phase =
  | "loading"
  | "setup"
  | "cloud_missing"
  | "connecting"
  | "choose_workspace"
  | "ready"
  | "error";

const defaultWorkspaceService = createSupabaseWorkspaceService();
const defaultHandoffService = createSupabaseHandoffService();

function localErrorMessage(code: unknown): string {
  const value =
    typeof code === "string"
      ? code
      : code && typeof code === "object" && "message" in code
        ? String((code as { message: unknown }).message)
        : "";
  if (value === "display_name_required") {
    return he.deviceNameRequired;
  }
  if (value === "display_name_too_long") {
    return he.deviceNameTooLong;
  }
  return he.saveFailed;
}

function connectionTitle(code: CloudErrorCode | null, fallback: string | null): string {
  if (code === "cloud_unavailable" || code === "anonymous_auth_failed") {
    return he.cannotConnectNow;
  }
  return fallback ?? cloudErrorLabel("unknown_cloud_error");
}

type AppProps = {
  workspaceService?: WorkspaceService;
  handoffService?: HandoffService;
};

export default function App({
  workspaceService = defaultWorkspaceService,
  handoffService = defaultHandoffService,
}: AppProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [device, setDevice] = useState<LocalDevice | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [handoffs, setHandoffs] = useState<HandoffRecord[]>([]);
  const [transfers, setTransfers] = useState<TransferRecord[]>([]);
  const [v2LoadFailed, setV2LoadFailed] = useState(false);
  const [inbox, setInbox] = useState<InboxLocalEntry[]>([]);
  const [pickedFile, setPickedFile] = useState<PickedFile | null>(null);
  const [sendProgress, setSendProgress] = useState<SendProgress>("idle");
  const [localStates, setLocalStates] = useState<Record<string, LocalWorkState>>({});
  const [reminderNotice, setReminderNotice] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [returningId, setReturningId] = useState<string | null>(null);
  const [reconcilingIds, setReconcilingIds] = useState<string[]>([]);
  const [watchFailedIds, setWatchFailedIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<CloudErrorCode | null>(null);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [rotating, setRotating] = useState(false);
  const createLock = useRef(false);
  const joinLock = useRef(false);
  const sendLock = useRef(false);
  const sendCancelledRef = useRef(false);
  const sendProgressRef = useRef(sendProgress);
  sendProgressRef.current = sendProgress;
  const actionLock = useRef(new Set<string>());
  const resumeLock = useRef(new Set<string>());
  const commandIds = useRef(createCommandIdStore());
  const invokeFn = invoke as unknown as InvokeFn;
  const seenIncoming = useRef<Set<string> | null>(null);
  const seenReturned = useRef<Set<string> | null>(null);
  const membersRef = useRef<WorkspaceMember[]>([]);
  const memberIdRef = useRef<string | null>(null);
  const handoffsRef = useRef<HandoffRecord[]>([]);
  const transfersRef = useRef<TransferRecord[]>([]);
  const returnLock = useRef(new Set<string>());
  const syncRef = useRef<ReturnType<typeof createHandoffSyncController> | null>(null);
  const workspaceIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    invoke<Snapshot>("get_snapshot")
      .then((snapshot) => {
        if (cancelled) {
          return;
        }
        if (!snapshot.localDevice) {
          setPhase("setup");
          return;
        }
        setDevice(snapshot.localDevice);
        void invoke<{ enabled: boolean }>("get_autostart_state")
          .then((state) => {
            if (!cancelled) {
              setAutostartEnabled(state.enabled);
            }
          })
          .catch(() => undefined);
        void enterCloud(() => cancelled);
      })
      .catch(() => {
        if (!cancelled) {
          setPhase("error");
          setError(he.saveFailed);
          setErrorCode("unknown_cloud_error");
        }
      });

    return () => {
      cancelled = true;
      workspaceService.unsubscribe();
    };
  }, [workspaceService]);

  membersRef.current = members;
  memberIdRef.current = memberId;
  handoffsRef.current = handoffs;
  transfersRef.current = transfers;
  workspaceIdRef.current = workspace?.id ?? null;

  async function applySnapshot(workspaceId: string) {
    const snapshot = await handoffService.listHandoffSnapshot(workspaceId);
    setHandoffs(snapshot.handoffs);
    setTransfers(snapshot.transfers);
    setV2LoadFailed(snapshot.v2LoadFailed);
    return snapshot.handoffs;
  }

  async function reloadList() {
    const workspaceId = workspaceIdRef.current;
    if (workspaceId) {
      return applySnapshot(workspaceId);
    }
    const list = await handoffService.listHandoffs();
    setHandoffs(list);
    return list;
  }

  const reconciliation = useMemo(() => {
    let statusInflight: Promise<HandoffRecord[]> | null = null;
    const registry = createReconciliationRegistry({
      async getCloudStatus(handoffId) {
        if (!statusInflight) {
          statusInflight = (async () => {
            const workspaceId = workspaceIdRef.current;
            if (workspaceId) {
              return applySnapshot(workspaceId);
            }
            const list = await handoffService.listHandoffs();
            setHandoffs(list);
            return list;
          })().finally(() => {
            statusInflight = null;
          });
        }
        const list = await statusInflight;
        return list.find((row) => row.id === handoffId)?.status ?? null;
      },
      markModified: (handoffId) => handoffService.markModified(handoffId),
      markUnmodified: (handoffId) => handoffService.markUnmodified(handoffId),
      markOpened: (handoffId) => handoffService.markOpened(handoffId),
      acknowledge: async (handoffId, desiredStatus, generation) => {
        const ok = await invoke<boolean>("acknowledge_local_status_sync", {
          handoffId,
          desiredStatus,
          generation,
        });
        if (ok) {
          try {
            setInbox(await invoke<InboxLocalEntry[]>("inbox_local_state"));
          } catch {
            /* keep last inbox */
          }
        }
        return ok;
      },
      onActivity: () => {
        setReconcilingIds(registry.busyIds());
      },
    });
    return registry;
  }, [handoffService]);

  useEffect(() => {
    if (phase !== "ready" || !workspace) {
      return;
    }
    const workspaceId = workspace.id;

    function refreshMembers() {
      void workspaceService
        .listWorkspaceMembers(workspaceId)
        .then((list) => {
          setMembers(list);
          if (currentUserId) {
            const mine = list.find((member) => member.userId === currentUserId);
            if (mine) {
              setMemberId(mine.id);
            }
          }
        })
        .catch((cause) => {
          setError(cloudErrorLabel(cloudErrorCode(cause)));
        });
    }

    refreshMembers();
    const stop = workspaceService.subscribeToWorkspaceMembers(workspaceId, refreshMembers);
    return () => {
      stop();
    };
  }, [phase, workspace, workspaceService, currentUserId]);

  useEffect(() => {
    if (phase !== "ready" || !memberId || !workspace) {
      return;
    }
    const workspaceId = workspace.id;
    let cancelled = false;
    let firstSnapshot = true;
    seenIncoming.current = null;
    seenReturned.current = null;

    async function refresh(notifyNew: boolean) {
      try {
        const list = await applySnapshot(workspaceId);
        if (cancelled) {
          return;
        }
        for (const row of list) {
          if ((row.flowVersion ?? 1) === 2 || !row.status) {
            continue;
          }
          if (row.recipientMemberId !== memberIdRef.current) {
            continue;
          }
          if (isReturnTerminal(row.status)) {
            reconciliation.stop(row.id);
          } else if (
            row.status === "received" ||
            row.status === "opened" ||
            row.status === "modified" ||
            row.status === "returning" ||
            row.status === "revision_requested"
          ) {
            reconciliation.resume(row.id);
          }
        }
        const localMemberId = memberIdRef.current;
        const incoming = list.filter(
          (row) => (row.flowVersion ?? 1) === 1 && row.recipientMemberId === localMemberId,
        );
        const outgoing = list.filter(
          (row) => (row.flowVersion ?? 1) === 1 && row.senderMemberId === localMemberId,
        );
        const incomingIds = new Set(incoming.map((row) => row.id));
        const returnedIds = new Set(
          outgoing
            .filter((row) => row.status === "returned" || row.status === "return_received")
            .map((row) => row.id),
        );
        if (seenIncoming.current === null) {
          seenIncoming.current = incomingIds;
          seenReturned.current = returnedIds;
          return;
        }
        if (notifyNew) {
          for (const row of incoming) {
            if (row.status === "sent" && !seenIncoming.current.has(row.id)) {
              const sender =
                membersRef.current.find((member) => member.id === row.senderMemberId)
                  ?.displayName ?? "";
              void invoke("notify_new_file", { senderDisplayName: sender });
            }
          }
          for (const row of outgoing) {
            if (
              (row.status === "returned" || row.status === "return_received") &&
              !seenReturned.current?.has(row.id)
            ) {
              const recipient =
                membersRef.current.find((member) => member.id === row.recipientMemberId)
                  ?.displayName ?? "";
              void invoke("notify_file_returned", { senderDisplayName: recipient });
            }
          }
        }
        seenIncoming.current = incomingIds;
        seenReturned.current = returnedIds;
      } catch (cause) {
        if (!cancelled) {
          setError(cloudErrorLabel(cloudErrorCode(cause)));
        }
      }
    }

    const sync = createHandoffSyncController({
      requiredChannels: ["incoming", "outgoing", "events"],
      snapshot: async () => {
        const notifyNew = !firstSnapshot;
        firstSnapshot = false;
        await refresh(notifyNew);
      },
    });
    syncRef.current = sync;
    sync.start();

    void invoke<InboxLocalEntry[]>("inbox_local_state")
      .then((entries) => {
        if (!cancelled) {
          setInbox(entries);
        }
      })
      .catch(() => undefined);

    const stopIncoming = handoffService.subscribeToIncomingHandoffs(
      memberId,
      () => {
        sync.notifySignal();
      },
      {
        onSubscribed: () => sync.markSubscribed("incoming"),
        onDisconnected: () => sync.markUnsubscribed("incoming"),
      },
    );
    const stopOutgoing = handoffService.subscribeToOutgoingHandoffs(
      memberId,
      () => {
        sync.notifySignal();
      },
      {
        onSubscribed: () => sync.markSubscribed("outgoing"),
        onDisconnected: () => sync.markUnsubscribed("outgoing"),
      },
    );
    const stopEvents = handoffService.subscribeToHandoffEvents(
      memberId,
      (eventId) => {
        sync.notifyEvent(eventId);
      },
      {
        onSubscribed: () => sync.markSubscribed("events"),
        onDisconnected: () => sync.markUnsubscribed("events"),
      },
    );
    return () => {
      cancelled = true;
      sync.stop();
      syncRef.current = null;
      stopIncoming();
      stopOutgoing();
      stopEvents();
    };
  }, [phase, memberId, workspace, handoffService, reconciliation]);

  useEffect(() => {
    if (phase !== "ready") {
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<LocalStateEvent>("handoff-local-state", (event) => {
      reconciliation.notify(event.payload);
      void invoke<InboxLocalEntry[]>("inbox_local_state").then((entries) => {
        if (!cancelled) {
          setInbox(entries);
        }
      });
    }).then((stop) => {
      if (cancelled) {
        stop();
        return;
      }
      unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [phase, reconciliation]);

  useEffect(() => {
    if (phase !== "ready" || !memberId) {
      return;
    }
    let cancelled = false;

    async function restore() {
      try {
        const pending = await invoke<PendingLocalStatus[]>("get_pending_local_statuses");
        const local = await invoke<InboxLocalEntry[]>("inbox_local_state");
        if (cancelled) {
          return;
        }
        setInbox(local);
        const list = await reloadList();
        if (cancelled) {
          return;
        }
        const mine = memberIdRef.current;
        for (const row of list) {
          if ((row.flowVersion ?? 1) === 2 || !row.status) {
            continue;
          }
          if (row.recipientMemberId !== mine) {
            continue;
          }
          const hasLocal = local.some((entry) => entry.handoffId === row.id);
          if (!hasLocal) {
            continue;
          }
          if (row.status === "returning") {
            try {
              await handoffService.failHandoffReturn(row.id);
            } catch {
              /* keep restoring */
            }
          }
          if (
            row.status === "received" ||
            row.status === "opened" ||
            row.status === "modified" ||
            row.status === "returning" ||
            row.status === "revision_requested"
          ) {
            reconciliation.resume(row.id);
            try {
              await invoke("start_inbox_watch", { handoffId: row.id });
            } catch {
              setWatchFailedIds((ids) =>
                ids.includes(row.id) ? ids : [...ids, row.id],
              );
            }
            await invoke("recheck_inbox_file", { handoffId: row.id });
          }
          if (isReturnTerminal(row.status)) {
            reconciliation.stop(row.id);
          }
        }
        for (const item of pending) {
          reconciliation.notify({
            handoffId: item.handoffId,
            generation: item.generation,
            contentDiffersFromV1: item.contentDiffersFromV1,
            desiredStatus: item.desiredStatus === "modified" ? "modified" : "opened",
            pendingRecheck: item.pendingRecheck,
          });
        }
      } catch {
        /* restore is best-effort */
      }
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, [phase, memberId, handoffService, reconciliation]);

  useEffect(() => {
    if (phase !== "ready" || !workspace) {
      return;
    }
    void recoverAllResumes();
  }, [phase, workspace, handoffService]);

  useEffect(() => {
    if (phase !== "ready") {
      return;
    }
    function retry() {
      reconciliation.retryAll();
      void invoke("recheck_all_inbox_files");
      syncRef.current?.retry();
    }
    function onVisibility() {
      if (document.visibilityState === "visible") {
        retry();
      }
    }
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [phase, reconciliation]);

  async function enterCloud(isCancelled: () => boolean = () => false) {
    if (!workspaceService.isConfigured()) {
      if (!isCancelled()) {
        setPhase("cloud_missing");
      }
      return;
    }

    setPhase("connecting");
    setError(null);
    setErrorHint(null);
    setErrorCode(null);
    try {
      const userId = await workspaceService.ensureSession();
      if (!isCancelled()) {
        setCurrentUserId(userId);
      }
      const current = await workspaceService.getCurrentWorkspace();
      if (isCancelled()) {
        return;
      }
      if (!current) {
        setWorkspace(null);
        setMembers([]);
        setJoinCode(null);
        setMemberId(null);
        setPhase("choose_workspace");
        return;
      }
      const list = await workspaceService.listWorkspaceMembers(current.id);
      if (isCancelled()) {
        return;
      }
      setWorkspace(current);
      setMembers(list);
      setMemberId(list.find((member) => member.userId === userId)?.id ?? null);
      setPhase("ready");
    } catch (cause) {
      if (!isCancelled()) {
        showCloudError(cause);
      }
    }
  }

  function showCloudError(cause: unknown) {
    const code: CloudErrorCode = cloudErrorCode(cause);
    setErrorCode(code);
    setError(cloudErrorLabel(code));
    setErrorHint(cloudErrorHint(code));
    setPhase("error");
  }

  async function onSubmitName(displayName: string) {
    setSaving(true);
    setError(null);
    try {
      const saved = await invoke<LocalDevice>("complete_setup", { displayName });
      setDevice(saved);
      await enterCloud();
    } catch (cause) {
      setError(localErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function onCreateWorkspace() {
    if (!device || createLock.current) {
      return;
    }
    createLock.current = true;
    setCreating(true);
    setError(null);
    try {
      const created = await workspaceService.createWorkspace(
        device.displayName,
        device.deviceId,
      );
      setWorkspace(created.workspace);
      setMemberId(created.memberId);
      setJoinCode(created.joinCode);
      setMembers(await workspaceService.listWorkspaceMembers(created.workspaceId));
      setPhase("ready");
    } catch (cause) {
      setError(cloudErrorLabel(cloudErrorCode(cause)));
    } finally {
      createLock.current = false;
      setCreating(false);
    }
  }

  async function onRotateJoinCode() {
    if (!workspace) {
      return;
    }
    setRotating(true);
    setError(null);
    try {
      const nextCode = await workspaceService.rotateWorkspaceJoinCode(workspace.id);
      setJoinCode(nextCode);
    } catch (cause) {
      setError(cloudErrorLabel(cloudErrorCode(cause)));
    } finally {
      setRotating(false);
    }
  }

  async function onJoinWorkspace(code: string) {
    if (!device || joinLock.current) {
      return;
    }
    joinLock.current = true;
    setJoining(true);
    setError(null);
    try {
      const joined = await workspaceService.joinWorkspace(
        code,
        device.displayName,
        device.deviceId,
      );
      setWorkspace(joined.workspace);
      setMemberId(joined.memberId);
      setJoinCode(null);
      setMembers(await workspaceService.listWorkspaceMembers(joined.workspaceId));
      setPhase("ready");
    } catch (cause) {
      setError(cloudErrorLabel(cloudErrorCode(cause)));
    } finally {
      joinLock.current = false;
      setJoining(false);
    }
  }

  async function clearSelection(selectionId: string | null) {
    if (!selectionId) {
      return;
    }
    try {
      await invoke("cancel_send_selection", { selectionId });
    } catch {
      /* selection is already gone */
    }
  }

  async function onPickFile() {
    const previous = pickedFile?.selectionId ?? null;
    if (previous) {
      await clearSelection(previous);
      setPickedFile(null);
    }
    try {
      const picked = await invoke<PickedFile | null>("pick_send_file");
      if (picked) {
        setPickedFile(picked);
      }
    } catch (cause) {
      setError(cloudErrorLabel(cloudErrorCode(cause)));
    }
  }

  async function onPickDroppedFile(path: string) {
    const previous = pickedFile?.selectionId ?? null;
    if (previous) {
      await clearSelection(previous);
      setPickedFile(null);
    }
    try {
      const picked = await invoke<PickedFile | null>("pick_send_file_from_path", { path });
      if (picked) {
        setPickedFile(picked);
      }
    } catch (cause) {
      setError(cloudErrorLabel(cloudErrorCode(cause)));
    }
  }

  async function onCancelSend() {
    const inFlight =
      sendProgressRef.current === "sending" ||
      sendProgressRef.current === "uploading" ||
      sendProgressRef.current === "finalizing";
    if (inFlight) {
      sendCancelledRef.current = true;
      try {
        const listed = await invoke<ResumeSummary[]>("list_resume_uploads");
        const inflight = listed.find((row) => row.kind === "initial");
        if (inflight) {
          await abortResumeRecord({
            service: handoffService,
            invoke: invokeFn,
            commands: commandIds.current,
            summary: inflight,
            pendingStoragePath: pendingPathForResume(inflight),
            stillOpen: true,
          });
        }
      } catch (cause) {
        setError(cloudErrorLabel(cloudErrorCode(cause)));
      }
    }
    await clearSelection(pickedFile?.selectionId ?? null);
    setPickedFile(null);
    setSendProgress("idle");
    if (inFlight) {
      await reloadList();
    }
  }

  function setLocal(handoffId: string, state: LocalWorkState) {
    setLocalStates((current) => ({ ...current, [handoffId]: state }));
  }

  function clearLocal(handoffId: string) {
    setLocalStates((current) => {
      const next = { ...current };
      delete next[handoffId];
      return next;
    });
  }

  function pendingPathForResume(summary: ResumeSummary): string | null {
    const hop =
      transfersRef.current.find((row) => row.id === summary.transferId) ??
      transfersRef.current.find((row) => row.handoffId === summary.handoffId);
    return hop?.pendingStoragePath ?? null;
  }

  function transferViewFor(handoff: HandoffRecord) {
    const projected = projectHandoffList(
      [handoff],
      transfersRef.current.filter((hop) => hop.handoffId === handoff.id),
      memberIdRef.current,
      (id) => membersRef.current.find((member) => member.id === id)?.displayName ?? "",
    );
    const card = projected.cards[0];
    return card?.source.kind === "transfer" ? card.source : null;
  }

  async function onSubmitSend(input: {
    recipientMemberId: string;
    instruction: string;
    dueOn: string | null;
    requestedAction?: SendAction;
  }) {
    if (sendLock.current) {
      return;
    }
    const picked = pickedFile;
    if (!picked) {
      return;
    }
    sendLock.current = true;
    sendCancelledRef.current = false;
    setSendProgress("sending");
    setError(null);
    try {
      await sendHandoffV2({
        service: handoffService,
        invoke: invokeFn,
        commands: commandIds.current,
        recipientMemberId: input.recipientMemberId,
        picked,
        requestedAction: input.requestedAction ?? "approval",
        instruction: input.instruction,
        dueOn: input.dueOn,
        onState(state) {
          if (state === "sending") {
            setSendProgress("sending");
          } else if (state === "uploading") {
            setSendProgress("uploading");
          } else if (state === "finalizing") {
            setSendProgress("finalizing");
          }
        },
      });
      setSendProgress("sent");
      await clearSelection(picked.selectionId);
      setPickedFile(null);
      await reloadList();
    } catch (cause) {
      if (sendCancelledRef.current) {
        setSendProgress("idle");
        return;
      }
      const code = cloudErrorCode(cause);
      if (code !== "handoff_create_failed") {
        await clearSelection(picked.selectionId);
        setPickedFile(null);
      }
      setError(code === "file_too_large" ? he.fileTooLarge : cloudErrorLabel(code));
      setSendProgress("failed");
    } finally {
      sendLock.current = false;
    }
  }

  async function onSubmitFileRequest(input: {
    recipientMemberId: string;
    instruction: string;
    dueOn: string | null;
  }) {
    if (sendLock.current) {
      return;
    }
    sendLock.current = true;
    setSendProgress("sending");
    setError(null);
    try {
      await createFileRequest({
        service: handoffService,
        commands: commandIds.current,
        recipientMemberId: input.recipientMemberId,
        instruction: input.instruction,
        dueOn: input.dueOn,
      });
      setSendProgress("sent");
      await reloadList();
    } catch (cause) {
      setError(cloudErrorLabel(cloudErrorCode(cause)));
      setSendProgress("failed");
    } finally {
      sendLock.current = false;
    }
  }

  async function onDownloadAndOpen(handoff: HandoffRecord) {
    const version = latestHandoffVersion(handoff);
    if (!version) {
      setError(he.downloadFailed);
      return;
    }
    setDownloadingId(handoff.id);
    setError(null);
    try {
      const signedUrl = await handoffService.createSignedDownloadUrl(version.storagePath);
      await invoke("download_inbox", {
        handoffId: handoff.id,
        signedUrl,
        expectedSize: version.fileSize,
        expectedBlake3: version.blake3,
        originalFilename: handoff.originalFilename,
        version: versionLabel(version.versionNumber),
        role: "recipient",
      });
      if (handoff.status === "sent") {
        await handoffService.markReceived(handoff.id);
      }
      reconciliation.resume(handoff.id);
      try {
        await invoke("start_inbox_watch", { handoffId: handoff.id });
        setWatchFailedIds((ids) => ids.filter((id) => id !== handoff.id));
      } catch {
        setWatchFailedIds((ids) => (ids.includes(handoff.id) ? ids : [...ids, handoff.id]));
      }
      await invoke("recheck_inbox_file", { handoffId: handoff.id });
      await invoke("open_inbox_file", {
        handoffId: handoff.id,
        version: versionLabel(version.versionNumber),
      });
      await handoffService.markOpened(handoff.id);
      setInbox(await invoke<InboxLocalEntry[]>("inbox_local_state"));
      await reloadList();
    } catch (cause) {
      setError(cloudErrorLabel(cloudErrorCode(cause)));
    } finally {
      setDownloadingId(null);
    }
  }

  async function onOpenFolder(handoffId: string, version = "v1") {
    try {
      await invoke("reveal_inbox_folder", { handoffId, version });
    } catch (cause) {
      setError(cloudErrorLabel(cloudErrorCode(cause)));
    }
  }

  async function onReturnFile(handoff: HandoffRecord) {
    if (returnLock.current.has(handoff.id)) {
      return;
    }
    returnLock.current.add(handoff.id);
    setReturningId(handoff.id);
    setError(null);
    let snapshotId: string | null = null;
    let began = false;
    reconciliation.stop(handoff.id);
    try {
      const prepared = await invoke<PreparedReturnSnapshot>("prepare_return_snapshot", {
        handoffId: handoff.id,
      });
      snapshotId = prepared.returnSnapshotId;
      const started = await handoffService.beginReturnNext(handoff.id);
      began = true;
      const accessToken = await handoffService.currentAccessToken();
      await invoke("tus_upload_v2", {
        returnSnapshotId: prepared.returnSnapshotId,
        accessToken,
        handoffId: started.handoffId,
        objectId: started.objectId,
        storagePath: started.storagePath,
        versionNumber: started.versionNumber,
      });
      await invoke("confirm_return_snapshot", {
        returnSnapshotId: prepared.returnSnapshotId,
      });
      await handoffService.finalizeHandoffReturn(
        started.handoffId,
        started.versionNumber,
        started.objectId,
        prepared.fileSize,
        prepared.blake3,
      );
      await invoke("discard_return_snapshot", {
        returnSnapshotId: prepared.returnSnapshotId,
      });
      snapshotId = null;
      await invoke("stop_inbox_watch", { handoffId: handoff.id });
      await reloadList();
      setInbox(await invoke<InboxLocalEntry[]>("inbox_local_state"));
    } catch (cause) {
      const code = cloudErrorCode(cause);
      if (snapshotId) {
        try {
          await invoke("discard_return_snapshot", { returnSnapshotId: snapshotId });
        } catch {
          /* already gone */
        }
      }
      if (began) {
        try {
          await handoffService.failHandoffReturn(handoff.id);
        } catch {
          /* keep original */
        }
      }
      reconciliation.resume(handoff.id);
      try {
        await invoke("recheck_inbox_file", { handoffId: handoff.id });
      } catch {
        /* watcher may still be running */
      }
      setError(
        code === "file_busy"
          ? he.fileBusy
          : code === "file_changed_during_return"
            ? he.fileChangedDuringReturn
            : cloudErrorLabel(code),
      );
      await reloadList();
    } finally {
      returnLock.current.delete(handoff.id);
      setReturningId(null);
    }
  }

  async function onOpenLatest(handoff: HandoffRecord) {
    const version = latestHandoffVersion(handoff);
    if (!version) {
      setError(he.downloadFailed);
      return;
    }
    setDownloadingId(handoff.id);
    setError(null);
    try {
      const signedUrl = await handoffService.createSignedDownloadUrl(version.storagePath);
      await invoke("download_inbox", {
        handoffId: handoff.id,
        signedUrl,
        expectedSize: version.fileSize,
        expectedBlake3: version.blake3,
        originalFilename: handoff.originalFilename,
        version: versionLabel(version.versionNumber),
        role: handoff.senderMemberId === memberIdRef.current ? "sender" : "recipient",
      });
      await invoke("open_inbox_file", {
        handoffId: handoff.id,
        version: versionLabel(version.versionNumber),
      });
      setInbox(await invoke<InboxLocalEntry[]>("inbox_local_state"));
      await reloadList();
    } catch (cause) {
      setError(cloudErrorLabel(cloudErrorCode(cause)));
    } finally {
      setDownloadingId(null);
    }
  }

  async function onCompleteHandoff(handoff: HandoffRecord) {
    setError(null);
    try {
      await handoffService.completeHandoff(handoff.id);
      await reloadList();
    } catch (cause) {
      setError(cloudErrorLabel(cloudErrorCode(cause)));
    }
  }

  async function onRequestRevision(handoff: HandoffRecord, note: string) {
    setError(null);
    try {
      await handoffService.requestRevision(handoff.id, note);
      await reloadList();
    } catch (cause) {
      setError(cloudErrorLabel(cloudErrorCode(cause)));
    }
  }

  async function runLocked(handoffId: string, work: () => Promise<void>) {
    if (actionLock.current.has(handoffId)) {
      return;
    }
    actionLock.current.add(handoffId);
    setActionBusyId(handoffId);
    setError(null);
    try {
      await work();
    } finally {
      actionLock.current.delete(handoffId);
      setActionBusyId((current) => (current === handoffId ? null : current));
    }
  }

  async function onOpenV2(handoff: HandoffRecord) {
    await runLocked(handoff.id, async () => {
      setDownloadingId(handoff.id);
      try {
        await openRootTransfer({
          service: handoffService,
          invoke: invokeFn,
          commands: commandIds.current,
          handoff,
          memberId: memberIdRef.current,
          source: transferViewFor(handoff),
        });
        setInbox(await invoke<InboxLocalEntry[]>("inbox_local_state"));
        await reloadList();
      } catch (cause) {
        setError(cloudErrorLabel(cloudErrorCode(cause)));
      } finally {
        setDownloadingId(null);
      }
    });
  }

  async function submitV2Result(
    handoff: HandoffRecord,
    rejected: boolean,
    note: string | null,
  ) {
    await runLocked(handoff.id, async () => {
      const source = transferViewFor(handoff);
      const requested = source?.activeHop?.requestedAction;
      if (!requested || !source?.activeHop) {
        return;
      }
      await invoke("recheck_inbox_file", { handoffId: handoff.id }).catch(() => undefined);
      const inboxState = await invoke<InboxLocalEntry[]>("inbox_local_state");
      const working = inboxState.find((entry) => entry.handoffId === handoff.id);
      if (working?.pendingRecheck) {
        setError(he.fileBusy);
        return;
      }
      const changed = Boolean(working?.contentDiffersFromV1);
      const resultAction: ResultAction = resultActionForRequest(requested, changed, rejected);
      if ((resultAction === "rejected" || resultAction === "returned_with_reply") && !note?.trim()) {
        setError(resultAction === "returned_with_reply" ? he.replyRequired : he.resultNoteRequired);
        return;
      }
      try {
        if (!changed) {
          await submitWithoutFile({
            service: handoffService,
            commands: commandIds.current,
            handoffId: handoff.id,
            resultAction,
            resultNote: note,
          });
        } else {
          setLocal(handoff.id, "sending");
          const prepared = await invoke<PreparedResultSnapshot>(
            "prepare_result_snapshot_from_working_file",
            {
              handoffId: handoff.id,
              transferId: source.activeHop.id,
            },
          );
          const inboxAfterPrepare = await invoke<InboxLocalEntry[]>("inbox_local_state");
          const prepareGeneration = inboxGenerationFor(inboxAfterPrepare, handoff.id);
          await submitWithFile({
            service: handoffService,
            invoke: invokeFn,
            commands: commandIds.current,
            handoffId: handoff.id,
            transferId: source.activeHop.id,
            intent: { resultAction, resultNote: note },
            snapshot: prepared,
            async changedDuringUpload() {
              const latest = await invoke<InboxLocalEntry[]>("inbox_local_state");
              return workingFileChangedAfterPrepare(latest, handoff.id, prepareGeneration);
            },
            onState: (state) => setLocal(handoff.id, state),
          });
        }
        clearLocal(handoff.id);
        await reloadList();
      } catch (cause) {
        const code = cloudErrorCode(cause);
        if (code === "file_changed_during_upload") {
          setLocal(handoff.id, "file_changed");
        } else if (code === "cloud_unavailable") {
          setLocal(handoff.id, "offline");
        }
        setError(code === "file_busy" ? he.fileBusy : cloudErrorLabel(code));
      }
    });
  }

  async function onAttachFileRequest(handoff: HandoffRecord) {
    await runLocked(handoff.id, async () => {
      const source = transferViewFor(handoff);
      if (!source?.activeHop) {
        return;
      }
      try {
        const picked = await invoke<PickedFile | null>("pick_send_file");
        if (!picked) {
          return;
        }
        setLocal(handoff.id, "sending");
        await attachFileRequest({
          service: handoffService,
          invoke: invokeFn,
          commands: commandIds.current,
          handoffId: handoff.id,
          transferId: source.activeHop.id,
          picked,
          onState: (state) => setLocal(handoff.id, state),
        });
        await clearSelection(picked.selectionId);
        clearLocal(handoff.id);
        await reloadList();
      } catch (cause) {
        const code = cloudErrorCode(cause);
        setLocal(handoff.id, code === "cloud_unavailable" ? "offline" : "retry");
        setError(cloudErrorLabel(code));
      }
    });
  }

  async function onAcceptV2(handoff: HandoffRecord) {
    await runLocked(handoff.id, async () => {
      try {
        const id = commandIds.current.id("accept_root_transfer_result", handoff.id);
        await handoffService.acceptRootTransferResult(handoff.id, id);
        await reloadList();
      } catch (cause) {
        setError(cloudErrorLabel(cloudErrorCode(cause)));
      }
    });
  }

  async function onRevisionV2(handoff: HandoffRecord, note: string) {
    await runLocked(handoff.id, async () => {
      try {
        const id = commandIds.current.id("request_root_transfer_revision", handoff.id);
        await handoffService.requestRootTransferRevision(handoff.id, note, id);
        await reloadList();
      } catch (cause) {
        setError(cloudErrorLabel(cloudErrorCode(cause)));
      }
    });
  }

  async function onRemind(handoff: HandoffRecord) {
    await runLocked(`remind:${handoff.id}`, async () => {
      const command = "send_transfer_reminder";
      try {
        const id = commandIds.current.id(command, handoff.id);
        await handoffService.sendTransferReminder(handoff.id, id);
        commandIds.current.forget(command, handoff.id);
        setReminderNotice(he.reminderSent);
        window.setTimeout(() => {
          setReminderNotice((current) => (current === he.reminderSent ? null : current));
        }, 2500);
        await reloadList();
      } catch (cause) {
        const code = cloudErrorCode(cause);
        if (code !== "cloud_unavailable") {
          commandIds.current.forget(command, handoff.id);
        }
        setError(code === "reminder_cooldown" ? he.reminderCooldown : cloudErrorLabel(code));
      }
    });
  }

  async function onCancelV2(handoff: HandoffRecord) {
    await runLocked(handoff.id, async () => {
      try {
        const listed = await invoke<ResumeSummary[]>("list_resume_uploads");
        const resume = listed.find((row) => row.handoffId === handoff.id);
        if (resume) {
          setLocal(handoff.id, "aborting");
          await abortResumeRecord({
            service: handoffService,
            invoke: invokeFn,
            commands: commandIds.current,
            summary: resume,
            pendingStoragePath: pendingPathForResume(resume),
            stillOpen: true,
          });
        } else {
          const cancelId = commandIds.current.id("cancel_root_handoff_v2", handoff.id);
          await handoffService.cancelRootHandoffV2(handoff.id, cancelId);
        }
        clearLocal(handoff.id);
        await reloadList();
      } catch (cause) {
        const code = cloudErrorCode(cause);
        setLocal(handoff.id, code === "cloud_unavailable" ? "offline" : "retry");
        setError(cloudErrorLabel(code));
      }
    });
  }

  async function recoverAllResumes() {
    const workspaceId = workspaceIdRef.current;
    if (!workspaceId) {
      return;
    }
    try {
      await reloadList();
    } catch {
      /* match against whatever is already loaded */
    }
    let listed: ResumeSummary[] = [];
    try {
      const raw = await invoke<ResumeSummary[]>("list_resume_uploads");
      listed = Array.isArray(raw) ? raw : [];
    } catch {
      return;
    }
    for (const summary of listed) {
      if (resumeLock.current.has(summary.objectId)) {
        continue;
      }
      resumeLock.current.add(summary.objectId);
      void (async () => {
        try {
          setLocal(summary.handoffId, "resuming");
          const handoff =
            handoffsRef.current.find((row) => row.id === summary.handoffId) ?? null;
          await recoverResumeRecord({
            service: handoffService,
            invoke: invokeFn,
            commands: commandIds.current,
            summary,
            pendingStoragePath: pendingPathForResume(summary),
            handoff,
            onState: (state) => setLocal(summary.handoffId, state),
            async pickReplacement() {
              return invoke<PickedFile | null>("pick_send_file");
            },
          });
          clearLocal(summary.handoffId);
          await reloadList();
        } catch (cause) {
          const code = cloudErrorCode(cause);
          setLocal(
            summary.handoffId,
            code === "resume_snapshot_required"
              ? "waiting_reselect"
              : code === "cloud_unavailable"
                ? "offline"
                : "retry",
          );
        } finally {
          resumeLock.current.delete(summary.objectId);
        }
      })();
    }
  }

  async function onRetryLocal(handoffId: string) {
    await recoverAllResumes();
    if (localStates[handoffId] === "retry" || localStates[handoffId] === "offline") {
      clearLocal(handoffId);
    }
  }

  async function onAbortLocal(handoffId: string) {
    await runLocked(handoffId, async () => {
      const listed = await invoke<ResumeSummary[]>("list_resume_uploads");
      const resume = listed.find((row) => row.handoffId === handoffId);
      if (!resume) {
        return;
      }
      setLocal(handoffId, "aborting");
      await abortResumeRecord({
        service: handoffService,
        invoke: invokeFn,
        commands: commandIds.current,
        summary: resume,
        pendingStoragePath: pendingPathForResume(resume),
      });
      clearLocal(handoffId);
      await reloadList();
    });
  }

  async function onRestoreSnapshot(handoffId: string) {
    await recoverAllResumes();
    void handoffId;
  }

  async function onToggleAutostart(enabled: boolean) {
    try {
      const next = await invoke<{ enabled: boolean }>("set_autostart_enabled", {
        enabled,
      });
      setAutostartEnabled(next.enabled);
    } catch {
      const current = await invoke<{ enabled: boolean }>("get_autostart_state");
      setAutostartEnabled(current.enabled);
    }
  }

  if (phase === "loading") {
    return (
      <main className="fr-center">
        <p className="fr-hint">{he.loading}</p>
      </main>
    );
  }

  if (phase === "connecting") {
    return <CloudConnectingScreen />;
  }

  if (phase === "setup") {
    return (
      <SetupScreen saving={saving} error={error} onSubmitName={onSubmitName} />
    );
  }

  if (phase === "cloud_missing") {
    return <CloudNotConfiguredScreen />;
  }

  if (phase === "choose_workspace") {
    return (
      <WorkspaceSetupScreen
        creating={creating}
        joining={joining}
        error={error}
        onCreateWorkspace={onCreateWorkspace}
        onJoinWorkspace={onJoinWorkspace}
      />
    );
  }

  if (phase === "ready" && workspace && device) {
    return (
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName={device.displayName}
        members={members}
        currentUserId={currentUserId}
        currentDeviceId={device.deviceId}
        currentMemberId={memberId}
        joinCode={joinCode}
        rotating={rotating}
        error={error}
        onRotateJoinCode={onRotateJoinCode}
        handoffs={handoffs}
        transfers={transfers}
        v2LoadFailed={v2LoadFailed}
        onRetryLoad={() => {
          syncRef.current?.retry();
        }}
        inbox={inbox}
        pickedFile={pickedFile}
        sendProgress={sendProgress}
        downloadingId={downloadingId}
        returningId={returningId}
        reconcilingIds={reconcilingIds}
        watchFailedIds={watchFailedIds}
        autostartEnabled={autostartEnabled}
        onToggleAutostart={onToggleAutostart}
        onPickFile={onPickFile}
        onPickDroppedFile={onPickDroppedFile}
        onCancelSend={onCancelSend}
        onSubmitSend={onSubmitSend}
        onSubmitFileRequest={onSubmitFileRequest}
        onDownloadAndOpen={onDownloadAndOpen}
        onOpenLatest={onOpenLatest}
        onOpenFolder={onOpenFolder}
        onReturnFile={onReturnFile}
        onCompleteHandoff={onCompleteHandoff}
        onRequestRevision={onRequestRevision}
        onOpenV2={onOpenV2}
        onApprove={(handoff, note) => submitV2Result(handoff, false, note)}
        onReject={(handoff, note) => submitV2Result(handoff, true, note)}
        onFinishReview={(handoff, note) => submitV2Result(handoff, false, note)}
        onReturnUpdate={(handoff, note) => submitV2Result(handoff, false, note)}
        onAttachFileRequest={onAttachFileRequest}
        onCannotProvide={(handoff, note) => submitV2Result(handoff, true, note)}
        onAcceptV2={onAcceptV2}
        onRevisionV2={onRevisionV2}
        onRemind={onRemind}
        onCancelV2={onCancelV2}
        onRetryLocal={onRetryLocal}
        onAbortLocal={onAbortLocal}
        onRestoreSnapshot={onRestoreSnapshot}
        localStates={localStates}
        reminderNotice={reminderNotice}
        actionBusyId={actionBusyId}
      />
    );
  }

  return (
    <CloudProblemScreen
      title={connectionTitle(errorCode, error)}
      hint={errorHint}
      onRetry={() => {
        void enterCloud();
      }}
    />
  );
}
