import { useCallback, useEffect, useState } from "react";
import { getJson } from "../lib/api";
import type { DeskView } from "../../desk/types";

const REFRESH_MS = 30_000;

interface DeskState {
  view: DeskView | null;
  enabled: boolean;
  error: string | null;
}

/** Loads the Desk and refreshes it every 30 seconds while `active`; `reload` fetches it now. */
export function useDesk(active: boolean): DeskState & { reload: () => void } {
  const [state, setState] = useState<DeskState>({ view: null, enabled: true, error: null });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const payload = await getJson<DeskView | { enabled: false }>("/api/desk", { signal: controller.signal });
        if (controller.signal.aborted) return;
        setState((s) => ("enabled" in payload ? { ...s, enabled: false, error: null } : { view: payload, enabled: true, error: null }));
      } catch {
        if (!controller.signal.aborted) setState((s) => ({ ...s, error: "The Desk could not load. Retrying." }));
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [active, nonce]);

  return { ...state, reload };
}
