import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureAnonymousSession,
  getCurrentSession,
  resetEnsureAnonymousSessionForTests,
  signOutForDevelopment,
} from "./auth";
import { CloudError } from "./errors";

const healthyStore = async () => undefined;

afterEach(() => {
  resetEnsureAnonymousSessionForTests();
});

describe("anonymous auth", () => {
  it("reuses an existing session without creating another user", async () => {
    const signInAnonymously = vi.fn();
    const userId = await ensureAnonymousSession(
      {
        getSession: async () => ({ id: "existing-user" }),
        signInAnonymously,
        signOut: async () => undefined,
      },
      healthyStore,
    );

    expect(userId).toBe("existing-user");
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it("signs in anonymously once when no session exists", async () => {
    const signInAnonymously = vi.fn(async () => ({ id: "new-user" }));
    const userId = await ensureAnonymousSession(
      {
        getSession: async () => null,
        signInAnonymously,
        signOut: async () => undefined,
      },
      healthyStore,
    );

    expect(userId).toBe("new-user");
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it("does not create another user when a temporary failure occurs", async () => {
    const signInAnonymously = vi.fn();

    await expect(
      ensureAnonymousSession(
        {
          getSession: async () => {
            throw new CloudError("cloud_unavailable");
          },
          signInAnonymously,
          signOut: async () => undefined,
        },
        healthyStore,
      ),
    ).rejects.toMatchObject({ code: "cloud_unavailable" });

    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it("does not sign in anonymously when the auth store is corrupt", async () => {
    const getSession = vi.fn();
    const signInAnonymously = vi.fn();

    await expect(
      ensureAnonymousSession(
        {
          getSession,
          signInAnonymously,
          signOut: async () => undefined,
        },
        async () => {
          throw new CloudError("auth_store_corrupt");
        },
      ),
    ).rejects.toMatchObject({ code: "auth_store_corrupt" });

    expect(getSession).not.toHaveBeenCalled();
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it("reuses a single in-flight sign-in when called twice", async () => {
    let resolveSignIn: ((user: { id: string }) => void) | undefined;
    const signInAnonymously = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveSignIn = resolve;
        }),
    );

    const first = ensureAnonymousSession(
      {
        getSession: async () => null,
        signInAnonymously,
        signOut: async () => undefined,
      },
      healthyStore,
    );
    const second = ensureAnonymousSession(
      {
        getSession: async () => null,
        signInAnonymously,
        signOut: async () => undefined,
      },
      healthyStore,
    );

    await vi.waitFor(() => {
      expect(signInAnonymously).toHaveBeenCalledTimes(1);
    });
    resolveSignIn?.({ id: "shared-user" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      "shared-user",
      "shared-user",
    ]);
  });

  it("maps auth failures to a stable code", async () => {
    await expect(
      getCurrentSession({
        getSession: async () => {
          throw new Error("jwt exploded");
        },
        signInAnonymously: async () => ({ id: "x" }),
        signOut: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "unknown_cloud_error" });
  });

  it("clears the local Tauri session on development sign-out", async () => {
    const signOut = vi.fn(async () => undefined);
    const clearLocalSession = vi.fn(async () => undefined);
    await signOutForDevelopment(
      {
        getSession: async () => null,
        signInAnonymously: async () => ({ id: "x" }),
        signOut,
      },
      clearLocalSession,
    );
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(clearLocalSession).toHaveBeenCalledTimes(1);
    expect(CloudError).toBeDefined();
  });
});
