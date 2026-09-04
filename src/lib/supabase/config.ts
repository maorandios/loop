export type SupabaseEnvReader = {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
};

export type SupabaseConfig = {
  url: string;
  publishableKey: string;
};

export type SupabaseConfigResult =
  | { ok: true; config: SupabaseConfig }
  | { ok: false; code: "cloud_not_configured" | "invalid_supabase_url" | "invalid_supabase_key" };

function readValue(raw: string | undefined): string {
  return raw?.trim() ?? "";
}

export function isValidSupabaseUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }
  if (!parsed.hostname.includes(".")) {
    return false;
  }
  return true;
}

export function isValidPublishableKey(raw: string): boolean {
  if (!raw || raw.toLowerCase().includes("service_role")) {
    return false;
  }
  if (raw.startsWith("sb_publishable_")) {
    return raw.length > "sb_publishable_".length;
  }
  const parts = raw.split(".");
  return parts.length === 3 && parts[0].startsWith("eyJ") && parts.every((part) => part.length > 0);
}

export function readSupabaseConfig(
  env: SupabaseEnvReader = import.meta.env,
): SupabaseConfigResult {
  const url = readValue(env.VITE_SUPABASE_URL);
  const publishableKey = readValue(env.VITE_SUPABASE_PUBLISHABLE_KEY);

  if (!url || !publishableKey) {
    return { ok: false, code: "cloud_not_configured" };
  }
  if (!isValidSupabaseUrl(url)) {
    return { ok: false, code: "invalid_supabase_url" };
  }
  if (!isValidPublishableKey(publishableKey)) {
    return { ok: false, code: "invalid_supabase_key" };
  }
  return { ok: true, config: { url, publishableKey } };
}

export function isSupabaseConfigured(env: SupabaseEnvReader = import.meta.env): boolean {
  return readSupabaseConfig(env).ok;
}
