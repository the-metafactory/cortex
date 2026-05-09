/**
 * Theme hook — light/dark with localStorage persistence + OS-preference default.
 *
 * Sets `data-theme` on `<html>` so the oklch palette in tokens.css
 * switches without re-mounting components.
 *
 * Persistence key: `mc.theme`. Values: `"dark" | "light"`. Anything else
 * falls back to OS preference. Across sessions, an explicit operator
 * pick wins over OS preference; no preference recorded means "follow OS".
 */

import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "mc.theme";

function readPreferredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage?.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  if (window.matchMedia?.("(prefers-color-scheme: light)").matches) return "light";
  return "dark";
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>(() => readPreferredTheme());

  // Apply to <html> on every change.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      window.localStorage?.setItem(STORAGE_KEY, t);
    } catch {
      // localStorage unavailable (private mode, storage permissions);
      // theme still applies in-session via the data-theme effect above.
    }
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      try {
        window.localStorage?.setItem(STORAGE_KEY, next);
      } catch {
        // see setTheme
      }
      return next;
    });
  }, []);

  return { theme, setTheme, toggle };
}
