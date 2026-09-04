import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CloudConnectingScreen,
  CloudNotConfiguredScreen,
  CloudProblemScreen,
} from "./screens/CloudScreens";
import { cloudErrorHint, cloudErrorLabel, he } from "./copy/he";
import { createSupabaseHandoffService } from "./features/handoff/service";
import { createReconciliationRegistry, isReturnTerminal } from "./features/handoff/reconciliation";
import type {
  HandoffRecord,
  HandoffService,
  InboxLocalEntry,
  LocalStateEvent,
  PendingLocalStatus,
  PickedFile,
  PreparedReturnSnapshot,
  SendProgress,
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
  const [inbox, setInbox] = useState<InboxLocalEntry[]>([]);
  const [pickedFile, setPickedFile] = useState<PickedFile | null>(null);
  const [sendProgress, setSendProgress] = useState<SendProgress>("idle");
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
  const seenIncoming = useRef<Set<string> | null>(null);
  const seenReturned = useRef<Set<string> | null>(null);
  const membersRef = useRef<WorkspaceMember[]>([]);
  const memberIdRef = useRef<string | null>(null);
  const handoffsRef = useRef<HandoffRecord[]>([]);
  const returnLock = useRef(new Set<string>());

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

  const reconciliation = useMemo(() => {
    const registry = createReconciliationRegistry({
      async getCloudStatus(handoffId) {
        const list = await handoffService.listHandoffs();
        setHandoffs(list);
        return list.find((row) => row.id === handoffId)?.status ?? null;
      },
      markModified: (handoffId) => handoffService.markModified(handoffId),
      markUnmodified: (handoffId) => handoffService.markUnmodified(handoffId),
      markOpened: (handoffId) => handoffService.markOpened(handoffId),
      acknowledge: (handoffId, desiredStatus, generation) =>
        invoke<boolean>("acknowledge_local_status_sync", {
          handoffId,
          desiredStatus,
          generation,
        }),
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
    if (phase !== "ready" || !memberId) {
      return;
    }
    let cancelled = false;
    seenIncoming.current = null;
    seenReturned.current = null;

    async function refresh(notifyNew: boolean) {
      try {
        const list = await handoffService.listHandoffs();
        if (cancelled) {
          return;
        }
        setHandoffs(list);
        for (const row of list) {
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
        const incoming = list.filter((row) => row.recipientMemberId === localMemberId);
        const outgoing = list.filter((row) => row.senderMemberId === localMemberId);
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

    void refresh(false);
    void invoke<InboxLocalEntry[]>("inbox_local_state")
      .then((entries) => {
        if (!cancelled) {
          setInbox(entries);
        }
      })
      .catch(() => undefined);

    const stopIncoming = handoffService.subscribeToIncomingHandoffs(memberId, () => {
      void refresh(true);
      window.setTimeout(() => {
        void refresh(true);
      }, 500);
    });
    const stopOutgoing = handoffService.subscribeToOutgoingHandoffs(memberId, () => {
      void refresh(true);
      window.setTimeout(() => {
        void refresh(true);
      }, 500);
    });
    return () => {
      cancelled = true;
      stopIncoming();
      stopOutgoing();
    };
  }, [phase, memberId, handoffService, reconciliation]);

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
        const list = await handoffService.listHandoffs();
        if (cancelled) {
          return;
        }
        setHandoffs(list);
        const mine = memberIdRef.current;
        for (const row of list) {
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
    if (phase !== "ready") {
      return;
    }
    function retry() {
      reconciliation.retryAll();
      void invoke("recheck_all_inbox_files");
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

  async function onCancelSend() {
    await clearSelection(pickedFile?.selectionId ?? null);
    setPickedFile(null);
    setSendProgress("idle");
  }

  async function onSubmitSend(input: {
    recipientMemberId: string;
    instruction: string;
    dueOn: string | null;
  }) {
    if (sendLock.current) {
      return;
    }
    const picked = pickedFile;
    if (!picked) {
      return;
    }
    sendLock.current = true;
    setSendProgress("sending");
    setError(null);
    let createdId: string | null = null;
    try {
      const created = await handoffService.createHandoffWithContext(
        input.recipientMemberId,
        picked.originalFilename,
        input.instruction,
        input.dueOn,
      );
      createdId = created.handoffId;
      try {
        const accessToken = await handoffService.currentAccessToken();
        await invoke("tus_upload_v1", {
          selectionId: picked.selectionId,
          accessToken,
          handoffId: created.handoffId,
          objectId: created.objectId,
          storagePath: created.storagePath,
        });
        await handoffService.finalizeHandoffV1(
          created.handoffId,
          created.objectId,
          picked.size,
          picked.blake3,
        );
        setSendProgress("sent");
        setHandoffs(await handoffService.listHandoffs());
      } catch (afterCreate) {
        try {
          await handoffService.failHandoff(created.handoffId);
        } catch {
          /* keep the original send error */
        }
        throw afterCreate;
      } finally {
        await clearSelection(picked.selectionId);
        setPickedFile(null);
      }
    } catch (cause) {
      if (createdId) {
        setPickedFile(null);
      }
      const code = cloudErrorCode(cause);
      setError(code === "file_too_large" ? he.fileTooLarge : cloudErrorLabel(code));
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
      setHandoffs(await handoffService.listHandoffs());
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
    try {
      const prepared = await invoke<PreparedReturnSnapshot>("prepare_return_snapshot", {
        handoffId: handoff.id,
      });
      snapshotId = prepared.returnSnapshotId;
      const started = await handoffService.beginReturnNext(handoff.id);
      began = true;
      reconciliation.stop(handoff.id);
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
      setHandoffs(await handoffService.listHandoffs());
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
        reconciliation.resume(handoff.id);
        try {
          await invoke("recheck_inbox_file", { handoffId: handoff.id });
        } catch {
          /* watcher may still be running */
        }
      }
      setError(
        code === "file_busy"
          ? he.fileBusy
          : code === "file_changed_during_return"
            ? he.fileChangedDuringReturn
            : cloudErrorLabel(code),
      );
      setHandoffs(await handoffService.listHandoffs());
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
      setHandoffs(await handoffService.listHandoffs());
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
      setHandoffs(await handoffService.listHandoffs());
    } catch (cause) {
      setError(cloudErrorLabel(cloudErrorCode(cause)));
    }
  }

  async function onRequestRevision(handoff: HandoffRecord, note: string) {
    setError(null);
    try {
      await handoffService.requestRevision(handoff.id, note);
      setHandoffs(await handoffService.listHandoffs());
    } catch (cause) {
      setError(cloudErrorLabel(cloudErrorCode(cause)));
    }
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
      <main className="flex min-h-dvh items-center justify-center bg-zinc-50 text-zinc-600">
        {he.loading}
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
        onCancelSend={onCancelSend}
        onSubmitSend={onSubmitSend}
        onDownloadAndOpen={onDownloadAndOpen}
        onOpenLatest={onOpenLatest}
        onOpenFolder={onOpenFolder}
        onReturnFile={onReturnFile}
        onCompleteHandoff={onCompleteHandoff}
        onRequestRevision={onRequestRevision}
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
