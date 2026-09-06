import { describe, expect, it, vi } from "vitest";
import { HANDOFF_EVENT_DEDUP_LIMIT, createHandoffSyncController } from "./sync";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("handoff sync controller", () => {
  it("starts a baseline snapshot immediately even if a channel stays timed out", async () => {
    const snapshot = vi.fn().mockResolvedValue(undefined);
    const sync = createHandoffSyncController({
      requiredChannels: ["incoming", "outgoing", "events"],
      snapshot,
    });
    sync.start();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    sync.markSubscribed("incoming");
    sync.markSubscribed("outgoing");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(sync.debug().subscribed).toEqual(["incoming", "outgoing"]);
  });

  it("runs one reconciliation snapshot after every channel is subscribed", async () => {
    const snapshot = vi.fn().mockResolvedValue(undefined);
    const sync = createHandoffSyncController({
      requiredChannels: ["incoming", "outgoing", "events"],
      snapshot,
    });
    sync.start();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    sync.markSubscribed("incoming");
    sync.markSubscribed("outgoing");
    sync.markSubscribed("events");
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
  });

  it("coalesces three channels becoming ready together into one reconciliation", async () => {
    const first = deferred();
    const snapshot = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const sync = createHandoffSyncController({
      requiredChannels: ["incoming", "outgoing", "events"],
      snapshot,
    });
    sync.start();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    first.resolve();
    await vi.waitFor(() => expect(sync.debug().inFlight).toBe(false));
    sync.markSubscribed("incoming");
    sync.markSubscribed("outgoing");
    sync.markSubscribed("events");
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("does not snapshot on disconnect so already-loaded data is kept", async () => {
    const snapshot = vi.fn().mockResolvedValue(undefined);
    const sync = createHandoffSyncController({
      requiredChannels: ["incoming", "outgoing", "events"],
      snapshot,
    });
    sync.start();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    sync.markSubscribed("incoming");
    sync.markSubscribed("outgoing");
    sync.markSubscribed("events");
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    sync.markUnsubscribed("events");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("runs a reconciliation snapshot when a late channel reaches SUBSCRIBED", async () => {
    const snapshot = vi.fn().mockResolvedValue(undefined);
    const sync = createHandoffSyncController({
      requiredChannels: ["incoming", "outgoing", "events"],
      snapshot,
    });
    sync.start();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    sync.markSubscribed("incoming");
    sync.markSubscribed("outgoing");
    expect(snapshot).toHaveBeenCalledTimes(1);
    sync.markSubscribed("events");
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
  });

  it("runs one reconciliation after reconnect of a channel that had dropped", async () => {
    const snapshot = vi.fn().mockResolvedValue(undefined);
    const sync = createHandoffSyncController({
      requiredChannels: ["incoming", "events"],
      snapshot,
    });
    sync.start();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    sync.markSubscribed("incoming");
    sync.markSubscribed("events");
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    sync.markUnsubscribed("incoming");
    sync.markSubscribed("incoming");
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(3));
  });

  it("does not lose an event that arrives during the baseline snapshot", async () => {
    const first = deferred();
    const snapshot = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const sync = createHandoffSyncController({
      requiredChannels: ["events"],
      snapshot,
    });
    sync.start();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    sync.notifyEvent("evt-1");
    expect(snapshot).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
  });

  it("does not lose an event that arrives during reconciliation", async () => {
    const baseline = deferred();
    const recon = deferred();
    const snapshot = vi
      .fn()
      .mockImplementationOnce(() => baseline.promise)
      .mockImplementationOnce(() => recon.promise)
      .mockResolvedValue(undefined);
    const sync = createHandoffSyncController({
      requiredChannels: ["incoming", "events"],
      snapshot,
    });
    sync.start();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    baseline.resolve();
    await vi.waitFor(() => expect(sync.debug().inFlight).toBe(false));
    sync.markSubscribed("incoming");
    sync.markSubscribed("events");
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    sync.notifyEvent("evt-during-recon");
    expect(snapshot).toHaveBeenCalledTimes(2);
    recon.resolve();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(3));
  });

  it("runs one trailing refetch when multiple events arrive during a snapshot", async () => {
    const first = deferred();
    const snapshot = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const sync = createHandoffSyncController({
      requiredChannels: ["events"],
      snapshot,
    });
    sync.start();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    sync.notifyEvent("evt-1");
    sync.notifyEvent("evt-2");
    expect(snapshot).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
  });

  it("does not open a second refetch for a known event id after sync", async () => {
    const snapshot = vi.fn().mockResolvedValue(undefined);
    const sync = createHandoffSyncController({
      requiredChannels: ["events"],
      snapshot,
    });
    sync.start();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    sync.notifyEvent("evt-same");
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    sync.notifyEvent("evt-same");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("evicts old event ids when the ring is full", async () => {
    const snapshot = vi.fn().mockResolvedValue(undefined);
    const sync = createHandoffSyncController({
      requiredChannels: ["events"],
      snapshot,
      maxEventIds: 3,
    });
    sync.start();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    sync.notifyEvent("a");
    sync.notifyEvent("b");
    sync.notifyEvent("c");
    await vi.waitFor(() => expect(sync.debug().seenCount).toBe(3));
    sync.notifyEvent("d");
    await vi.waitFor(() => expect(sync.debug().seenCount).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const settled = snapshot.mock.calls.length;
    sync.notifyEvent("c");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(snapshot).toHaveBeenCalledTimes(settled);
    expect(sync.debug().seenCount).toBeLessThanOrEqual(3);
    sync.notifyEvent("a");
    await vi.waitFor(() => expect(snapshot.mock.calls.length).toBeGreaterThan(settled));
  });

  it("retry after stop does not snapshot", async () => {
    const snapshot = vi.fn().mockResolvedValue(undefined);
    const sync = createHandoffSyncController({
      requiredChannels: ["events"],
      snapshot,
    });
    sync.start();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    sync.stop();
    sync.retry();
    sync.markSubscribed("events");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("caps the default ring at 500 ids", () => {
    expect(HANDOFF_EVENT_DEDUP_LIMIT).toBe(500);
  });
});
