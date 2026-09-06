export const HANDOFF_EVENT_DEDUP_LIMIT = 500;

export type HandoffSyncController = {
  start: () => void;
  markSubscribed: (channel: string) => void;
  markUnsubscribed: (channel: string) => void;
  notifyEvent: (eventId: string | null) => void;
  notifySignal: () => void;
  retry: () => void;
  stop: () => void;
  debug: () => {
    dirty: boolean;
    inFlight: boolean;
    synced: boolean;
    started: boolean;
    seenCount: number;
    subscribed: string[];
    snapshotCount: number;
  };
};

export function createHandoffSyncController(options: {
  requiredChannels: string[];
  snapshot: () => Promise<void>;
  maxEventIds?: number;
}): HandoffSyncController {
  const max = options.maxEventIds ?? HANDOFF_EVENT_DEDUP_LIMIT;
  const seenQueue: string[] = [];
  const seenSet = new Set<string>();
  const subscribed = new Set<string>();
  let dirty = false;
  let inFlight = false;
  let synced = false;
  let started = false;
  let stopped = false;
  let snapshotCount = 0;

  function remember(id: string): boolean {
    if (seenSet.has(id)) {
      return false;
    }
    seenSet.add(id);
    seenQueue.push(id);
    if (seenQueue.length > max) {
      const evicted = seenQueue.shift();
      if (evicted) {
        seenSet.delete(evicted);
      }
    }
    return true;
  }

  function allSubscribed(): boolean {
    return options.requiredChannels.every((channel) => subscribed.has(channel));
  }

  async function runSnapshot() {
    if (stopped) {
      return;
    }
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    try {
      do {
        dirty = false;
        snapshotCount += 1;
        await options.snapshot();
        synced = true;
      } while (dirty && !stopped);
    } finally {
      inFlight = false;
    }
  }

  function requestSnapshot() {
    if (!started || stopped) {
      dirty = true;
      return;
    }
    void runSnapshot();
  }

  return {
    start() {
      if (stopped || started) {
        return;
      }
      started = true;
      void runSnapshot();
    },
    markSubscribed(channel: string) {
      const wasAll = allSubscribed();
      subscribed.add(channel);
      if (!wasAll && allSubscribed()) {
        requestSnapshot();
      }
    },
    markUnsubscribed(channel: string) {
      subscribed.delete(channel);
    },
    notifyEvent(eventId: string | null) {
      if (eventId) {
        const isNew = remember(eventId);
        if (!isNew) {
          if (inFlight) {
            dirty = true;
          }
          return;
        }
      }
      if (inFlight || !started) {
        dirty = true;
        return;
      }
      requestSnapshot();
    },
    notifySignal() {
      if (inFlight || !started) {
        dirty = true;
        return;
      }
      requestSnapshot();
    },
    retry() {
      requestSnapshot();
    },
    stop() {
      stopped = true;
    },
    debug() {
      return {
        dirty,
        inFlight,
        synced,
        started,
        seenCount: seenSet.size,
        subscribed: [...subscribed],
        snapshotCount,
      };
    },
  };
}
