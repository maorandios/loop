export type PostgresChangesChannel = {
  on: (
    type: "postgres_changes",
    filter: {
      event: string;
      schema: string;
      table: string;
      filter: string;
    },
    callback: () => void,
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
  filter: string,
  onChange: () => void,
  options: MemberSubscriptionOptions = {},
): () => void {
  const timers = options.timers ?? defaultTimers;
  const maxRetries = options.maxRetries ?? 8;
  const baseDelayMs = options.baseDelayMs ?? 1000;
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
    channel = client
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table,
          filter,
        },
        () => {
          if (!stopped) {
            onChange();
          }
        },
      )
      .subscribe((status: string) => {
        if (stopped) {
          return;
        }
        if (status === "SUBSCRIBED") {
          retries = 0;
          onChange();
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
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
    options,
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
    options,
  );
}
