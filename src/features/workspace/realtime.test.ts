import { describe, expect, it, vi } from "vitest";
import {
  subscribeIncomingHandoffs,
  subscribeOutgoingHandoffs,
  subscribeWorkspaceMembers,
  type WorkspaceMembersChannel,
  type WorkspaceMembersRealtimeClient,
} from "./realtime";

function createFakeClient() {
  const removed: WorkspaceMembersChannel[] = [];
  const channels: Array<{
    name: string;
    channel: WorkspaceMembersChannel;
    onChange: () => void;
    status?: (status: string) => void;
  }> = [];

  const client: WorkspaceMembersRealtimeClient = {
    channel(name: string) {
      const record: {
        name: string;
        channel: WorkspaceMembersChannel;
        onChange: () => void;
        status?: (status: string) => void;
      } = {
        name,
        channel: null as unknown as WorkspaceMembersChannel,
        onChange: () => undefined,
      };
      const channel: WorkspaceMembersChannel = {
        on(_type, _filter, callback) {
          record.onChange = callback;
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
    channels[0]?.onChange();
    expect(onChange).toHaveBeenCalledTimes(1);

    stop();
    expect(removed).toHaveLength(1);
    channels[0]?.onChange();
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

    channels[0]?.onChange();
    channels[1]?.onChange();
    channels[2]?.onChange();
    expect(onMembers).toHaveBeenCalledTimes(1);
    expect(onIncoming).toHaveBeenCalledTimes(1);
    expect(onOutgoing).toHaveBeenCalledTimes(1);

    stopMembers();
    expect(removed).toHaveLength(1);
    channels[0]?.onChange();
    channels[1]?.onChange();
    expect(onMembers).toHaveBeenCalledTimes(1);
    expect(onIncoming).toHaveBeenCalledTimes(2);

    stopIncoming();
    expect(removed).toHaveLength(2);
    channels[1]?.onChange();
    expect(onIncoming).toHaveBeenCalledTimes(2);

    stopOutgoing();
    expect(removed).toHaveLength(3);
    channels[2]?.onChange();
    expect(onOutgoing).toHaveBeenCalledTimes(1);
  });
});

describe("incoming handoff realtime", () => {
  it("listens to handoffs for the recipient member and cleans up", () => {
    const { client, channels, removed } = createFakeClient();
    const onChange = vi.fn();
    const stop = subscribeIncomingHandoffs(client, "member-2", onChange);

    expect(channels).toHaveLength(1);
    channels[0]?.onChange();
    expect(onChange).toHaveBeenCalledTimes(1);

    stop();
    expect(removed).toHaveLength(1);
    channels[0]?.onChange();
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
