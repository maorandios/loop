import { describe, expect, it, vi } from "vitest";
import {
  subscribeHandoffEvents,
  subscribeIncomingHandoffs,
  subscribeOutgoingHandoffs,
  subscribeWorkspaceMembers,
  type PostgresChangePayload,
  type WorkspaceMembersChannel,
  type WorkspaceMembersRealtimeClient,
} from "./realtime";

function createFakeClient() {
  const removed: WorkspaceMembersChannel[] = [];
  const channels: Array<{
    name: string;
    channel: WorkspaceMembersChannel;
    onChange: (payload: PostgresChangePayload) => void;
    filter?: { event: string; table: string; filter?: string };
    status?: (status: string) => void;
  }> = [];

  const client: WorkspaceMembersRealtimeClient = {
    channel(name: string) {
      const record: {
        name: string;
        channel: WorkspaceMembersChannel;
        onChange: (payload: PostgresChangePayload) => void;
        filter?: { event: string; table: string; filter?: string };
        status?: (status: string) => void;
      } = {
        name,
        channel: null as unknown as WorkspaceMembersChannel,
        onChange: () => undefined,
      };
      const channel: WorkspaceMembersChannel = {
        on(_type, filter, callback) {
          record.onChange = callback;
          record.filter = filter;
          return channel;
        },
        subscribe(callback) {
          record.status = callback;
          return channel;
        },
      };
      record.channel = channel;
      channels.push(record);
      return channel;
    },
    removeChannel(channel) {
      removed.push(channel);
    },
  };

  return { client, channels, removed };
}

describe("workspace member realtime", () => {
  it("notifies on a postgres change and removes the channel on cleanup", () => {
    const { client, channels, removed } = createFakeClient();
    const onChange = vi.fn();
    const stop = subscribeWorkspaceMembers(client, "workspace-1", onChange);

    expect(channels).toHaveLength(1);
    channels[0]?.onChange({});
    expect(onChange).toHaveBeenCalledTimes(1);

    stop();
    expect(removed).toHaveLength(1);
    channels[0]?.onChange({});
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("reconnects after a channel error and stops retrying after cleanup", () => {
    const scheduled: Array<() => void> = [];
    const { client, channels, removed } = createFakeClient();
    const stop = subscribeWorkspaceMembers(client, "workspace-1", () => undefined, {
      maxRetries: 2,
      baseDelayMs: 10,
      timers: {
        schedule: (callback) => {
          scheduled.push(callback);
          return scheduled.length;
        },
        cancel: () => undefined,
      },
    });

    channels[0]?.status?.("CHANNEL_ERROR");
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(channels).toHaveLength(2);
    expect(removed).toHaveLength(1);

    stop();
    channels[1]?.status?.("TIMED_OUT");
    expect(scheduled).toHaveLength(1);
  });

  it("refreshes when the channel is subscribed so handshake events are not missed", () => {
    const { client, channels } = createFakeClient();
    const onChange = vi.fn();
    subscribeWorkspaceMembers(client, "workspace-1", onChange);

    expect(onChange).not.toHaveBeenCalled();
    channels[0]?.status?.("SUBSCRIBED");
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("member and handoff realtime channels", () => {
  it("keeps separate channel names and independent cleanup", () => {
    const { client, channels, removed } = createFakeClient();
    const onMembers = vi.fn();
    const onIncoming = vi.fn();
    const onOutgoing = vi.fn();
    const stopMembers = subscribeWorkspaceMembers(client, "workspace-1", onMembers);
    const stopIncoming = subscribeIncomingHandoffs(client, "member-2", onIncoming);
    const stopOutgoing = subscribeOutgoingHandoffs(client, "member-1", onOutgoing);

    expect(channels.map((row) => row.name)).toEqual([
      "workspace-members-workspace-1",
      "workspace-handoffs-member-2",
      "workspace-handoffs-out-member-1",
    ]);

    channels[0]?.onChange({});
    channels[1]?.onChange({});
    channels[2]?.onChange({});
    expect(onMembers).toHaveBeenCalledTimes(1);
    expect(onIncoming).toHaveBeenCalledTimes(1);
    expect(onOutgoing).toHaveBeenCalledTimes(1);

    stopMembers();
    expect(removed).toHaveLength(1);
    channels[0]?.onChange({});
    channels[1]?.onChange({});
    expect(onMembers).toHaveBeenCalledTimes(1);
    expect(onIncoming).toHaveBeenCalledTimes(2);

    stopIncoming();
    expect(removed).toHaveLength(2);
    channels[1]?.onChange({});
    expect(onIncoming).toHaveBeenCalledTimes(2);

    stopOutgoing();
    expect(removed).toHaveLength(3);
    channels[2]?.onChange({});
    expect(onOutgoing).toHaveBeenCalledTimes(1);
  });
});

describe("incoming handoff realtime", () => {
  it("listens to handoffs for the recipient member and cleans up", () => {
    const { client, channels, removed } = createFakeClient();
    const onChange = vi.fn();
    const stop = subscribeIncomingHandoffs(client, "member-2", onChange);

    expect(channels).toHaveLength(1);
    channels[0]?.onChange({});
    expect(onChange).toHaveBeenCalledTimes(1);

    stop();
    expect(removed).toHaveLength(1);
    channels[0]?.onChange({});
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("reconnects after a channel error and stops retrying after cleanup", () => {
    const scheduled: Array<() => void> = [];
    const { client, channels, removed } = createFakeClient();
    const stop = subscribeIncomingHandoffs(client, "member-2", () => undefined, {
      maxRetries: 2,
      baseDelayMs: 10,
      timers: {
        schedule: (callback) => {
          scheduled.push(callback);
          return scheduled.length;
        },
        cancel: () => undefined,
      },
    });

    channels[0]?.status?.("CHANNEL_ERROR");
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(channels).toHaveLength(2);
    expect(removed).toHaveLength(1);

    stop();
    channels[1]?.status?.("TIMED_OUT");
    expect(scheduled).toHaveLength(1);
  });
});

describe("handoff events realtime", () => {
  it("listens to INSERT on handoff_events and treats the payload as a signal id", () => {
    const { client, channels, removed } = createFakeClient();
    const onEvent = vi.fn();
    const onSubscribed = vi.fn();
    const stop = subscribeHandoffEvents(client, "member-2", onEvent, { onSubscribed });

    expect(channels.map((row) => row.name)).toEqual(["handoff-events-member-2"]);
    expect(channels[0]?.filter).toEqual({
      event: "INSERT",
      schema: "public",
      table: "handoff_events",
    });
    expect(JSON.stringify(channels[0]?.filter)).not.toMatch(/handoff_id IN/i);

    channels[0]?.status?.("SUBSCRIBED");
    expect(onSubscribed).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();

    channels[0]?.onChange({ new: { id: "evt-1" } });
    expect(onEvent).toHaveBeenCalledWith("evt-1");

    stop();
    expect(removed).toHaveLength(1);
    channels[0]?.onChange({ new: { id: "evt-2" } });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("notifies onSubscribed again after reconnect", () => {
    const scheduled: Array<() => void> = [];
    const { client, channels } = createFakeClient();
    const onSubscribed = vi.fn();
    subscribeHandoffEvents(client, "member-2", () => undefined, {
      onSubscribed,
      maxRetries: 2,
      baseDelayMs: 10,
      timers: {
        schedule: (callback) => {
          scheduled.push(callback);
          return scheduled.length;
        },
        cancel: () => undefined,
      },
    });

    channels[0]?.status?.("SUBSCRIBED");
    channels[0]?.status?.("CHANNEL_ERROR");
    scheduled[0]?.();
    channels[1]?.status?.("SUBSCRIBED");
    expect(onSubscribed).toHaveBeenCalledTimes(2);
  });

  it("reconnects after unsolicited CLOSED and does not open a second channel first", () => {
    const scheduled: Array<() => void> = [];
    const { client, channels, removed } = createFakeClient();
    const onDisconnected = vi.fn();
    subscribeHandoffEvents(client, "member-2", () => undefined, {
      onDisconnected,
      maxRetries: 2,
      baseDelayMs: 10,
      timers: {
        schedule: (callback) => {
          scheduled.push(callback);
          return scheduled.length;
        },
        cancel: () => undefined,
      },
    });

    expect(channels).toHaveLength(1);
    channels[0]?.status?.("CLOSED");
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(channels).toHaveLength(1);
    scheduled[0]?.();
    expect(removed).toHaveLength(1);
    expect(channels).toHaveLength(2);
    channels[0]?.status?.("CLOSED");
    expect(scheduled).toHaveLength(1);
  });

  it("does not reconnect after an intentional cleanup CLOSED", () => {
    const scheduled: Array<() => void> = [];
    const { client, channels } = createFakeClient();
    const onDisconnected = vi.fn();
    const stop = subscribeHandoffEvents(client, "member-2", () => undefined, {
      onDisconnected,
      maxRetries: 2,
      baseDelayMs: 10,
      timers: {
        schedule: (callback) => {
          scheduled.push(callback);
          return scheduled.length;
        },
        cancel: () => undefined,
      },
    });

    stop();
    channels[0]?.status?.("CLOSED");
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
    expect(channels).toHaveLength(1);
  });

  it("does not create duplicate channels while a reconnect is already scheduled", () => {
    const scheduled: Array<() => void> = [];
    const { client, channels, removed } = createFakeClient();
    subscribeIncomingHandoffs(client, "member-2", () => undefined, {
      maxRetries: 3,
      baseDelayMs: 10,
      timers: {
        schedule: (callback) => {
          scheduled.push(callback);
          return scheduled.length;
        },
        cancel: () => undefined,
      },
    });

    channels[0]?.status?.("CHANNEL_ERROR");
    channels[0]?.status?.("TIMED_OUT");
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(channels).toHaveLength(2);
    expect(removed).toHaveLength(1);
  });
});
