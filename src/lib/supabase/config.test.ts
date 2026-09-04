import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isValidPublishableKey,
  isValidSupabaseUrl,
  readSupabaseConfig,
} from "./config";
import { getSupabaseClient, resetSupabaseClientForTests } from "./client";
import { createMemoryAuthStorage } from "./tauriAuthStorage";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { getSession: vi.fn() } })),
}));

import { createClient } from "@supabase/supabase-js";

const mockedCreateClient = vi.mocked(createClient);

const validEnv = {
  VITE_SUPABASE_URL: "https://abcdefgh.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY:
    "eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYW5vbiIsImlhdCI6MX0.signature",
};

afterEach(() => {
  resetSupabaseClientForTests();
  mockedCreateClient.mockClear();
  vi.unstubAllEnvs();
});

describe("supabase config", () => {
  it("does not treat missing values as configured", () => {
    expect(readSupabaseConfig({}).ok).toBe(false);
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: "", VITE_SUPABASE_PUBLISHABLE_KEY: "" }).ok).toBe(
      false,
    );
  });

  it("rejects an invalid URL", () => {
    expect(isValidSupabaseUrl("not-a-url")).toBe(false);
    expect(isValidSupabaseUrl("http://abcdefgh.supabase.co")).toBe(false);
    expect(
      readSupabaseConfig({
        VITE_SUPABASE_URL: "not-a-url",
        VITE_SUPABASE_PUBLISHABLE_KEY: validEnv.VITE_SUPABASE_PUBLISHABLE_KEY,
      }).ok,
    ).toBe(false);
  });

  it("rejects a service role key", () => {
    expect(isValidPublishableKey("service_role-secret")).toBe(false);
  });
});

describe("supabase client", () => {
  it("does not create a client when config is missing", async () => {
    const client = await getSupabaseClient({ env: {} });
    expect(client).toBeNull();
    expect(mockedCreateClient).not.toHaveBeenCalled();
  });

  it("creates a singleton client once when config is valid", async () => {
    const storage = createMemoryAuthStorage();
    const first = await getSupabaseClient({ env: validEnv, storage });
    const second = await getSupabaseClient({ env: validEnv, storage });

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(mockedCreateClient).toHaveBeenCalledTimes(1);
  });

  it("uses the custom auth storage adapter and does not fall back to localStorage", async () => {
    const storage = createMemoryAuthStorage();
    await getSupabaseClient({ env: validEnv, storage });

    expect(mockedCreateClient).toHaveBeenCalledWith(
      validEnv.VITE_SUPABASE_URL,
      validEnv.VITE_SUPABASE_PUBLISHABLE_KEY,
      expect.objectContaining({
        auth: expect.objectContaining({
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
          storage,
        }),
      }),
    );
    const options = mockedCreateClient.mock.calls[0]?.[2] as {
      auth?: { storage?: unknown };
    };
    expect(options.auth?.storage).toBe(storage);
  });
});
