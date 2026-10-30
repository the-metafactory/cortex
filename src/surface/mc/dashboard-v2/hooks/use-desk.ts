import { useEffect, useState } from "react";
import { getJson } from "../lib/api";
import type { DeskView } from "../../desk/types";

const REFRESH_MS = 30_000;

export function useDesk(active: boolean) {
  const [view, setView] = useState<DeskView | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const load = (): void => {
      void getJson<DeskView | { enabled: false }>("/api/desk", { signal: controller.signal })
        .then((body) => {
          if (controller.signal.aborted) return;
          if ("enabled" in body && body.enabled === false) setEnabled(false);
          else setView(body as DeskView);
          setError(null);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError("The Desk could not load. Retrying.");
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [active]);

  return { view, enabled, error };
}
