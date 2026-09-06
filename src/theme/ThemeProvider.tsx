import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  applyTheme,
  persistThemePref,
  readThemePref,
  resolveTheme,
  type ResolvedTheme,
  type ThemePref,
} from "./theme";

type ThemeContextValue = {
  pref: ThemePref;
  resolved: ResolvedTheme;
  setPref: (pref: ThemePref) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readThemePref);
  const resolved = resolveTheme(pref);

  useEffect(() => {
    applyTheme(pref);
    if (pref !== "system") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyTheme("system");
    };
    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, [pref]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      pref,
      resolved,
      setPref: (next) => {
        persistThemePref(next);
        setPrefState(next);
      },
    }),
    [pref, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context) {
    return context;
  }
  return {
    pref: readThemePref(),
    resolved: resolveTheme(readThemePref()),
    setPref: persistThemePref,
  };
}
