import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readSupabaseConfig, type SupabaseEnvReader } from "./config";
import {
  createTauriAuthStorage,
  type AuthStorageAdapter,
} from "./tauriAuthStorage";

export type GetSupabaseClientOptions = {
  env?: SupabaseEnvReader;
  storage?: AuthStorageAdapter;
};

let singleton: SupabaseClient | null | undefined;
let pending: Promise<SupabaseClient | null> | null = null;

async function initializeClient(
  options?: GetSupabaseClientOptions,
): Promise<SupabaseClient | null> {
  const result = options?.env ? readSupabaseConfig(options.env) : readSupabaseConfig();
  if (!result.ok) {
    singleton = null;
    return null;
  }

  const storage = options?.storage ?? createTauriAuthStorage();
  await storage.getItem("__filerelay_auth_storage_ready__");
  singleton = createClient(result.config.url, result.config.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage,
    },
  });
  return singleton;
}

export async function getSupabaseClient(
  options?: GetSupabaseClientOptions,
): Promise<SupabaseClient | null> {
  if (singleton !== undefined) {
    return singleton;
  }
  if (!pending) {
    pending = initializeClient(options);
  }
  return pending;
}

export function getCachedSupabaseClient(): SupabaseClient | null {
  return singleton ?? null;
}

export function resetSupabaseClientForTests(): void {
  singleton = undefined;
  pending = null;
}
