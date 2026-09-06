export function newClientRequestId(): string {
  return crypto.randomUUID();
}

export function createCommandIdStore() {
  const ids = new Map<string, string>();

  function key(command: string, scope: string): string {
    return `${command}:${scope}`;
  }

  return {
    id(command: string, scope: string): string {
      const stored = ids.get(key(command, scope));
      if (stored) {
        return stored;
      }
      const created = newClientRequestId();
      ids.set(key(command, scope), created);
      return created;
    },
    peek(command: string, scope: string): string | null {
      return ids.get(key(command, scope)) ?? null;
    },
    forget(command: string, scope: string): void {
      ids.delete(key(command, scope));
    },
    forgetScope(scope: string): void {
      for (const current of [...ids.keys()]) {
        if (current.endsWith(`:${scope}`)) {
          ids.delete(current);
        }
      }
    },
  };
}

export type CommandIdStore = ReturnType<typeof createCommandIdStore>;
