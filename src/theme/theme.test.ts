import { afterEach, describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  persistThemePref,
  readThemePref,
  resolveTheme,
} from "./theme";

describe("theme preference", () => {
  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-pref");
  });

  it("defaults to system and resolves from prefers-color-scheme", () => {
    expect(readThemePref()).toBe("system");
    const resolved = resolveTheme("system");
    expect(["light", "dark"]).toContain(resolved);
  });

  it("persists light and dark locally", () => {
    persistThemePref("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    persistThemePref("dark");
    expect(readThemePref()).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("applies system without writing a wrong flash attribute", () => {
    applyTheme("system");
    expect(document.documentElement.getAttribute("data-theme-pref")).toBe("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe(resolveTheme("system"));
  });
});
