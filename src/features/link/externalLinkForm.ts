export type LinkAccess = "anyone" | "people";
export type LinkExpiryPreset = "1d" | "3d" | "7d" | "custom";
export type LinkProvider = "sharepoint" | "google" | "dropbox";
export type LinkFileSource = "computer" | "cloud";
export type LinkStage = "form" | "uploading" | "success";
export type LinkSharePolicy = "anyone" | "identified";

export type LinkPickedFile = {
  name: string;
  size: number;
  source: LinkFileSource;
  provider: LinkProvider;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export function parseEmailTokens(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function addEmailChip(emails: string[], raw: string): {
  emails: string[];
  invalid: string | null;
  consumed: boolean;
} {
  const tokens = parseEmailTokens(raw);
  if (tokens.length === 0) {
    return { emails, invalid: null, consumed: false };
  }

  const next = [...emails];
  for (const token of tokens) {
    if (!isValidEmail(token)) {
      return { emails: next, invalid: token, consumed: false };
    }
    if (!next.some((email) => email.toLowerCase() === token.toLowerCase())) {
      next.push(token);
    }
  }
  return { emails: next, invalid: null, consumed: true };
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

export function policyMaxDays(policy: LinkSharePolicy): number {
  return policy === "identified" ? 7 : 30;
}

export function maxExpiryAt(now: Date, policy: LinkSharePolicy): Date {
  return addDays(now, policyMaxDays(policy));
}

export function expiresAtFromPreset(
  preset: LinkExpiryPreset,
  customValue: string,
  now: Date,
): Date | null {
  if (preset === "1d") {
    return addDays(now, 1);
  }
  if (preset === "3d") {
    return addDays(now, 3);
  }
  if (preset === "7d") {
    return addDays(now, 7);
  }
  if (!customValue) {
    return null;
  }
  const parsed = new Date(customValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function clampExpiry(date: Date, now: Date, max: Date): Date {
  if (date.getTime() <= now.getTime()) {
    return new Date(now.getTime() + 60_000);
  }
  if (date.getTime() > max.getTime()) {
    return max;
  }
  return date;
}

export function isExpiryAllowed(date: Date | null, now: Date, max: Date): boolean {
  if (!date) {
    return false;
  }
  return date.getTime() > now.getTime() && date.getTime() <= max.getTime();
}

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function datetimeLocalValue(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatLinkExpiryParts(date: Date): { date: string; time: string } {
  return {
    date: new Intl.DateTimeFormat("he-IL", {
      day: "numeric",
      month: "long",
    }).format(date),
    time: `${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
  };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function canCreateExternalLink(input: {
  file: LinkPickedFile | null;
  access: LinkAccess | null;
  validEmails: string[];
  expiresAt: Date | null;
  now: Date;
  maxExpiresAt: Date;
}): boolean {
  if (!input.file || !input.access) {
    return false;
  }
  if (input.access === "people" && input.validEmails.length < 1) {
    return false;
  }
  return isExpiryAllowed(input.expiresAt, input.now, input.maxExpiresAt);
}

export function linkFixturesEnabled(): boolean {
  return import.meta.env.DEV || import.meta.env.MODE === "test";
}
