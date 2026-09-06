export const THEME_STORAGE_KEY = "filerelay.theme";

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export function isThemePref(value: string | null | undefined): value is ThemePref {
  return value === "system" || value === "light" || value === "dark";
}

export function readThemePref(): ThemePref {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePref(stored)) {
      return stored;
    }
  } catch {
    /* localStorage may be unavailable */
  }
  return "system";
}

export function prefersDarkScheme(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === "light" || pref === "dark") {
    return pref;
  }
  return prefersDarkScheme() ? "dark" : "light";
}

export function applyTheme(pref: ThemePref): ResolvedTheme {
  const resolved = resolveTheme(pref);
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.setAttribute("data-theme-pref", pref);
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

export function persistThemePref(pref: ThemePref): ResolvedTheme {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* ignore quota / privacy mode */
  }
  return applyTheme(pref);
}
