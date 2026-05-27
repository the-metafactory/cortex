/**
 * Generic location.hash (de)serializer hook.
 *
 * Used by F-8 task-table filters in MIG-4 (where the hash state lives
 * today) and by any future shareable-state surface. Pattern matches the
 * legacy monolith's hash-persistence rules from `docs/design-mc-f8-task-table.md`
 * Decision 3.
 *
 * The hash format is a single tag namespace plus URLSearchParams:
 *   #tasks?p=0,1&age=5&closed=1&q=webhook
 *
 * MIG-1 ships only the read/write helpers. MIG-4 layers task-specific
 * keys on top via `parseTaskFilters` / `serializeTaskFilters` in
 * `lib/hash-tasks.ts` (added in MIG-4, not here).
 */

import { useCallback, useEffect, useState } from "react";

export interface HashState {
  /** The leading namespace tag, e.g. "tasks" in `#tasks?...`. Empty when no hash. */
  tag: string;
  /** URLSearchParams instance over the part after `?`. Empty when no `?`. */
  params: URLSearchParams;
}

function parseHash(raw: string): HashState {
  if (!raw || raw === "#") return { tag: "", params: new URLSearchParams() };
  const stripped = raw.startsWith("#") ? raw.slice(1) : raw;
  const qIdx = stripped.indexOf("?");
  if (qIdx < 0) {
    return { tag: stripped, params: new URLSearchParams() };
  }
  return {
    tag: stripped.slice(0, qIdx),
    params: new URLSearchParams(stripped.slice(qIdx + 1)),
  };
}

function serializeHash(state: HashState): string {
  if (!state.tag && state.params.size === 0) return "";
  const qs = state.params.toString();
  return qs ? `#${state.tag}?${qs}` : `#${state.tag}`;
}

/**
 * `setHashState` semantics (matches `docs/design-mc-dashboard-react-migration.md`
 * Decision 3 — principal filters use replaceState so the back-button doesn't
 * accumulate one history entry per keystroke):
 *
 *   - default (no `opts`)                → replaceState (no new history entry)
 *   - `{ replace: true }`  (explicit)    → replaceState (same as default)
 *   - `{ replace: false }` (opt-in push) → pushState    (adds a history entry)
 *
 * The `replace: false` form is the *only* way to opt into a history push;
 * read it as "do not use replaceState", not as "do not replace the existing
 * hash". MIG-4 task-table filters call this without options (replace path).
 */
export function useHashState(): {
  state: HashState;
  setHashState: (next: HashState, opts?: { replace?: boolean }) => void;
} {
  const [state, setState] = useState<HashState>(() =>
    typeof window === "undefined" ? { tag: "", params: new URLSearchParams() } : parseHash(window.location.hash)
  );

  // Listen for back/forward and external hash changes.
  useEffect(() => {
    function onHashChange() {
      setState(parseHash(window.location.hash));
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const setHashState = useCallback((next: HashState, opts?: { replace?: boolean }) => {
    const newHash = serializeHash(next);
    const current = window.location.hash || "";
    if (newHash === current || (!newHash && !current)) return;
    // Default + `{ replace: true }` → replaceState (no history pollution).
    // Only an explicit `{ replace: false }` opts into pushState; assigning to
    // `window.location.hash` produces a real history entry the back-button
    // can step through.
    if (opts?.replace !== false) {
      const url = newHash || `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, "", url);
      setState(next);
    } else {
      window.location.hash = newHash;
    }
  }, []);

  return { state, setHashState };
}
