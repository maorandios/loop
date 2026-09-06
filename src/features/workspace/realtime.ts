export type PostgresChangePayload = {
  new?: { id?: string };
};

export type PostgresChangesChannel = {
  on: (
    type: "postgres_changes",
    filter: {
      event: string;
      schema: string;
      table: string;
      filter?: string;
    },
    callback: (payload: PostgresChangePayload) => void,
  ) => PostgresChangesChannel;
  subscribe: (callback?: (status: string) => void) => PostgresChangesChannel;
};

export type PostgresRealtimeClient = {
  channel: (name: string) => PostgresChangesChannel;
  removeChannel: (channel: PostgresChangesChannel) => Promise<unknown> | unknown;
};

export type WorkspaceMembersChannel = PostgresChangesChannel;
export type WorkspaceMembersRealtimeClient = PostgresRealtimeClient;

export type MemberSubscriptionTimers = {
  schedule: (callback: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
};

export type MemberSubscriptionOptions = {
  timers?: MemberSubscriptionTimers;
  maxRetries?: number;
  baseDelayMs?: number;
  event?: string;
  filter?: string | null;
  notifyOnSubscribed?: boolean;
  onSubscribed?: () => void;
  onDisconnected?: () => void;
  onPayload?: (payload: PostgresChangePayload) => void;
};

const defaultTimers: MemberSubscriptionTimers = {
  schedule: (callback, ms) => setTimeout(callback, ms),
  cancel: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function subscribePostgresTable(
  client: {
    channel: (name: string) => any;
    removeChannel: (channel: any) => Promise<unknown> | unknown;
  },
  channelName: string,
  table: string,
  filter: string | null,
  onChange: () => void,
  options: MemberSubscriptionOptions = {},
): () => void {
  const timers = options.timers ?? defaultTimers;
  const maxRetries = options.maxRetries ?? 8;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const event = options.event ?? "*";
  const notifyOnSubscribed = options.notifyOnSubscribed ?? true;
  let stopped = false;
  let channel: PostgresChangesChannel | null = null;
  let retries = 0;
  let retryHandle: unknown = null;

  function clearRetry() {
    if (retryHandle !== null) {
      timers.cancel(retryHandle);
      retryHandle = null;
    }
  }

  function detach() {
    if (!channel) {
      return;
    }
    const current = channel;
    channel = null;
    void client.removeChannel(current);
  }

  function scheduleRetry() {
    if (stopped || retries >= maxRetries || retryHandle !== null) {
      return;
    }
    const delay = Math.min(baseDelayMs * 2 ** retries, 15_000);
    retries += 1;
    retryHandle = timers.schedule(() => {
      retryHandle = null;
      detach();
      attach();
    }, delay);
  }

  function attach() {
    if (stopped) {
      return;
    }
    const filterSpec: {
      event: string;
      schema: string;
      table: string;
      filter?: string;
    } = {
      event,
      schema: "public",
      table,
    };
    if (filter) {
      filterSpec.filter = filter;
    }
    const created = client.channel(channelName).on(
      "postgres_changes",
      filterSpec,
      (payload: PostgresChangePayload) => {
        if (stopped || created !== channel) {
          return;
        }
        options.onPayload?.(payload);
        onChange();
      },
    );
    channel = created;
    created.subscribe((status: string) => {
      if (stopped || created !== channel) {
        return;
      }
      if (status === "SUBSCRIBED") {
        retries = 0;
        options.onSubscribed?.();
        if (notifyOnSubscribed) {
          onChange();
        }
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        options.onDisconnected?.();
        scheduleRetry();
      }
    });
  }

  attach();

  return () => {
    stopped = true;
    clearRetry();
    detach();
  };
}

export function subscribeWorkspaceMembers(
  client: {
    channel: (name: string) => any;
    removeChannel: (channel: any) => Promise<unknown> | unknown;
  },
  workspaceId: string,
  onChange: () => void,
  options: MemberSubscriptionOptions = {},
): () => void {
  return subscribePostgresTable(
    client,
    `workspace-members-${workspaceId}`,
    "workspace_members",
    `workspace_id=eq.${workspaceId}`,
    onChange,
    options,
  );
}

export function subscribeIncomingHandoffs(
  client: {
    channel: (name: string) => any;
    removeChannel: (channel: any) => Promise<unknown> | unknown;
  },
  recipientMemberId: string,
  onChange: () => void,
  options: MemberSubscriptionOptions = {},
): () => void {
  return subscribePostgresTable(
    client,
    `workspace-handoffs-${recipientMemberId}`,
    "handoffs",
    `recipient_member_id=eq.${recipientMemberId}`,
    onChange,
    { notifyOnSubscribed: false, ...options },
  );
}

export function subscribeOutgoingHandoffs(
  client: {
    channel: (name: string) => any;
    removeChannel: (channel: any) => Promise<unknown> | unknown;
  },
  senderMemberId: string,
  onChange: () => void,
  options: MemberSubscriptionOptions = {},
): () => void {
  return subscribePostgresTable(
    client,
    `workspace-handoffs-out-${senderMemberId}`,
    "handoffs",
    `sender_member_id=eq.${senderMemberId}`,
    onChange,
    { notifyOnSubscribed: false, ...options },
  );
}

export function subscribeHandoffEvents(
  client: {
    channel: (name: string) => any;
    removeChannel: (channel: any) => Promise<unknown> | unknown;
  },
  memberId: string,
  onEvent: (eventId: string | null) => void,
  options: MemberSubscriptionOptions = {},
): () => void {
  return subscribePostgresTable(
    client,
    `handoff-events-${memberId}`,
    "handoff_events",
    null,
    () => undefined,
    {
      event: "INSERT",
      notifyOnSubscribed: false,
      ...options,
      onPayload: (payload) => {
        options.onPayload?.(payload);
        onEvent(typeof payload.new?.id === "string" ? payload.new.id : null);
      },
    },
  );
}
