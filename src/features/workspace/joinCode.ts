export function normalizeJoinCodeInput(raw: string): string {
  return raw.trim().replace(/\s+/g, "").toUpperCase();
}

export function joinCodeHasChars(raw: string): boolean {
  return normalizeJoinCodeInput(raw).replace(/-/g, "").length > 0;
}
