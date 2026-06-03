/**
 * G-1113.D.6 — legacy-iterations toggle (localStorage-persisted).
 *
 * Keeps the legacy iteration kanban (the `Iterations` tab + its detail surface)
 * available behind a toggle "until the plan surface reaches parity" (plan §5.4).
 * Defaults to ON (legacy available) — the new Plans surface isn't fully live yet,
 * so the toggle is purely additive: it adds the control to HIDE the legacy
 * kanban once the principal is satisfied with parity, changing nothing by default.
 * Mirrors use-software-mode's persistence shape.
 */
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "mc.legacyIterations";

function readLegacyIterations(): boolean {
  if (typeof window === "undefined") return true;
  // Default ON: only an explicit "off" hides the legacy kanban.
  return window.localStorage?.getItem(STORAGE_KEY) !== "off";
}

export function useLegacyIterations(): { legacyIterations: boolean; toggle: () => void } {
  const [legacyIterations, setLegacyIterations] = useState<boolean>(() => readLegacyIterations());
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage?.setItem(STORAGE_KEY, legacyIterations ? "on" : "off");
    } catch (_err) {
      // localStorage unavailable (private mode / permissions) — the flag still
      // applies in-session; persistence is best-effort (matches use-software-mode).
    }
  }, [legacyIterations]);
  const toggle = useCallback(() => setLegacyIterations((v) => !v), []);
  return { legacyIterations, toggle };
}
