import { CloudError, toCloudError } from "./errors";
import { getSupabaseClient } from "./client";
import { assertAuthStoreHealthy, clearTauriAuthStorage } from "./tauriAuthStorage";

export type AuthUser = {
  id: string;
};

export type AuthGateway = {
  getSession(): Promise<AuthUser | null>;
  signInAnonymously(): Promise<AuthUser>;
  signOut(): Promise<void>;
};

let ensureInFlight: Promise<string> | null = null;

async function requireClient() {
  const client = await getSupabaseClient();
  if (!client) {
    throw new CloudError("cloud_not_configured");
  }
  return client;
}

export function createSupabaseAuthGateway(): AuthGateway {
  return {
    async getSession() {
      const client = await requireClient();
      const { data, error } = await client.auth.getSession();
      if (error) {
        throw toCloudError(error);
      }
      if (!data.session?.user) {
        return null;
      }
      const { data: userData, error: userError } = await client.auth.getUser();
      if (userError) {
        throw toCloudError(userError);
      }
      return userData.user ? { id: userData.user.id } : null;
    },
    async signInAnonymously() {
      const client = await requireClient();
      const { data, error } = await client.auth.signInAnonymously();
      if (error || !data.user) {
        throw toCloudError(error ?? new CloudError("anonymous_auth_failed"));
      }
      return { id: data.user.id };
    },
    async signOut() {
      const client = await requireClient();
      const { error } = await client.auth.signOut();
      if (error) {
        throw toCloudError(error);
      }
    },
  };
}

export async function getCurrentSession(
  gateway: AuthGateway = createSupabaseAuthGateway(),
): Promise<AuthUser | null> {
  try {
    return await gateway.getSession();
  } catch (error) {
    throw toCloudError(error);
  }
}

async function ensureAnonymousSessionOnce(
  gateway: AuthGateway,
  assertHealthy: () => Promise<void>,
): Promise<string> {
  await assertHealthy();
  const existing = await gateway.getSession();
  if (existing) {
    return existing.id;
  }
  const created = await gateway.signInAnonymously();
  return created.id;
}

export async function ensureAnonymousSession(
  gateway: AuthGateway = createSupabaseAuthGateway(),
  assertHealthy: () => Promise<void> = assertAuthStoreHealthy,
): Promise<string> {
  if (ensureInFlight) {
    return ensureInFlight;
  }
  ensureInFlight = (async () => {
    try {
      return await ensureAnonymousSessionOnce(gateway, assertHealthy);
    } catch (error) {
      throw toCloudError(error);
    }
  })().finally(() => {
    ensureInFlight = null;
  });
  return ensureInFlight;
}

export function resetEnsureAnonymousSessionForTests(): void {
  ensureInFlight = null;
}

export async function signOutForDevelopment(
  gateway: AuthGateway = createSupabaseAuthGateway(),
  clearLocalSession: () => Promise<void> = clearTauriAuthStorage,
): Promise<void> {
  await gateway.signOut();
  await clearLocalSession();
}
