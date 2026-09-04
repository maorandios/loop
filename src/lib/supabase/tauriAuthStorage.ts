import { invoke } from "@tauri-apps/api/core";

export type AuthStorageAdapter = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export function createMemoryAuthStorage(
  map: Map<string, string> = new Map(),
): AuthStorageAdapter {
  return {
    async getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    },
  };
}

export function createTauriAuthStorage(): AuthStorageAdapter {
  let ready: Promise<void> | null = null;

  const ensureReady = async () => {
    if (!ready) {
      ready = invoke<void>("auth_storage_ensure").then(() => undefined);
    }
    await ready;
  };

  return {
    async getItem(key) {
      await ensureReady();
      const value = await invoke<string | null>("auth_storage_get", { key });
      return value ?? null;
    },
    async setItem(key, value) {
      await ensureReady();
      await invoke("auth_storage_set", { key, value });
    },
    async removeItem(key) {
      await ensureReady();
      await invoke("auth_storage_remove", { key });
    },
  };
}

export async function clearTauriAuthStorage(): Promise<void> {
  await invoke("auth_storage_clear");
}

export async function assertAuthStoreHealthy(): Promise<void> {
  await invoke<string>("auth_storage_health");
}
