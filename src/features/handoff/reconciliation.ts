import type { HandoffStatus } from "../../copy/he";
import type { LocalStateEvent } from "./types";

const STOP_STATUSES = new Set<HandoffStatus>([
  "returning",
  "returned",
  "return_received",
  "completed",
]);

export type ReconciliationDeps = {
  getCloudStatus: (handoffId: string) => Promise<HandoffStatus | null>;
  markModified: (handoffId: string) => Promise<void>;
  markUnmodified: (handoffId: string) => Promise<void>;
  markOpened: (handoffId: string) => Promise<void>;
  acknowledge: (
    handoffId: string,
    desiredStatus: string,
    generation: number,
  ) => Promise<boolean>;
  onActivity?: () => void;
};

type Worker = {
  desiredStatus: "opened" | "modified";
  generation: number;
  busy: boolean;
  queued: boolean;
  stopped: boolean;
  run: () => Promise<void>;
};

export type ReconciliationRegistry = {
  notify(event: LocalStateEvent): void;
  retryAll(): void;
  stop(handoffId: string): void;
  resume(handoffId: string): void;
  stopAll(): void;
  isBusy(handoffId: string): boolean;
  busyIds(): string[];
  desiredStatus(handoffId: string): "opened" | "modified" | null;
};

export function createReconciliationRegistry(
  deps: ReconciliationDeps,
): ReconciliationRegistry {
  const workers = new Map<string, Worker>();

  function ensure(handoffId: string): Worker {
    const existing = workers.get(handoffId);
    if (existing) {
      return existing;
    }
    const worker: Worker = {
      desiredStatus: "opened",
      generation: 0,
      busy: false,
      queued: false,
      stopped: false,
      run: async () => {
        if (worker.busy || worker.stopped) {
          return;
        }
        worker.busy = true;
        deps.onActivity?.();
        try {
          while (!worker.stopped) {
            const cloud = await deps.getCloudStatus(handoffId);
            if (!cloud || STOP_STATUSES.has(cloud)) {
              worker.stopped = true;
              break;
            }
            if (cloud === worker.desiredStatus) {
              await deps.acknowledge(
                handoffId,
                worker.desiredStatus,
                worker.generation,
              );
              break;
            }
            if (
              worker.desiredStatus === "modified" &&
              (cloud === "opened" || cloud === "received" || cloud === "revision_requested")
            ) {
              await deps.markModified(handoffId);
              continue;
            }
            if (worker.desiredStatus === "opened" && cloud === "revision_requested") {
              await deps.markOpened(handoffId);
              continue;
            }
            if (worker.desiredStatus === "opened" && cloud === "modified") {
              await deps.markUnmodified(handoffId);
              continue;
            }
            break;
          }
        } catch {
          /* keep pending_status_sync; retry on reconnect/focus */
        } finally {
          worker.busy = false;
          deps.onActivity?.();
          if (worker.queued && !worker.stopped) {
            worker.queued = false;
            void worker.run();
          }
        }
      },
    };
    workers.set(handoffId, worker);
    return worker;
  }

  function kick(worker: Worker) {
    if (worker.stopped) {
      return;
    }
    if (worker.busy) {
      worker.queued = true;
      return;
    }
    void worker.run();
  }

  return {
    notify(event) {
      const worker = ensure(event.handoffId);
      if (worker.stopped) {
        return;
      }
      worker.desiredStatus = event.desiredStatus;
      worker.generation = event.generation;
      kick(worker);
    },
    retryAll() {
      for (const worker of workers.values()) {
        if (!worker.stopped) {
          kick(worker);
        }
      }
    },
    stop(handoffId) {
      const worker = workers.get(handoffId);
      if (worker) {
        worker.stopped = true;
        worker.queued = false;
      }
    },
    resume(handoffId) {
      const worker = ensure(handoffId);
      worker.stopped = false;
    },
    stopAll() {
      for (const worker of workers.values()) {
        worker.stopped = true;
        worker.queued = false;
      }
      workers.clear();
    },
    isBusy(handoffId) {
      return workers.get(handoffId)?.busy === true;
    },
    busyIds() {
      return [...workers.entries()]
        .filter(([, worker]) => worker.busy)
        .map(([id]) => id);
    },
    desiredStatus(handoffId) {
      return workers.get(handoffId)?.desiredStatus ?? null;
    },
  };
}

export function canReturnFile(input: {
  contentDiffersFromV1: boolean;
  cloudStatus: HandoffStatus;
  pendingStatusSync: boolean;
  reconciling: boolean;
}): boolean {
  return (
    input.contentDiffersFromV1 &&
    input.cloudStatus === "modified" &&
    !input.pendingStatusSync &&
    !input.reconciling
  );
}

export function isReturnTerminal(status: HandoffStatus): boolean {
  return STOP_STATUSES.has(status);
}
