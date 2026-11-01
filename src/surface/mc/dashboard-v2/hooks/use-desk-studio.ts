import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "../lib/api";
import type { StudioView } from "../../desk/studio/view";

const REFRESH_MS = 30_000;
const MODE_PARAM = "desk";
const THREAD_PARAM = "thread";

export type DeskMode = "day" | "studio" | "balance" | "catchup";

export function useDeskStudio(poll: boolean, revision = 0): StudioView | null {
  const [studio, setStudio] = useState<StudioView | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const payload = await getJson<{ studio: StudioView | null }>("/api/desk/studio", { signal: controller.signal });
        if (controller.signal.aborted) return;
        loaded.current = true;
        setStudio(payload.studio ?? null);
      } catch {
        return;
      }
    };
    void load();
    const timer = setInterval(() => {
      if (poll || !loaded.current) void load();
    }, REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [poll, revision]);

  return studio;
}

export interface DeskLocation {
  mode: DeskMode;
  thread: string | null;
}

export function readDeskLocation(search: string): DeskLocation {
  const params = new URLSearchParams(search);
  const requested = params.get(MODE_PARAM);
  const mode: DeskMode = requested === "mirror" ? "balance" : requested === "studio" || requested === "balance" || requested === "catchup" ? requested : "day";
  return { mode, thread: mode === "studio" ? params.get(THREAD_PARAM) : null };
}

export function deskSearch(search: string, next: DeskLocation): string {
  const params = new URLSearchParams(search);
  params.delete(MODE_PARAM);
  params.delete(THREAD_PARAM);
  if (next.mode !== "day") params.set(MODE_PARAM, next.mode);
  if (next.mode === "studio" && next.thread) params.set(THREAD_PARAM, next.thread);
  const text = params.toString();
  return text ? `?${text}` : "";
}

const currentSearch = (): string => (typeof window === "undefined" ? "" : window.location.search);

export function useDeskLocation(): [DeskLocation, (next: DeskLocation) => void] {
  const [location, setLocation] = useState<DeskLocation>(() => readDeskLocation(currentSearch()));

  useEffect(() => {
    const onPop = (): void => setLocation(readDeskLocation(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((next: DeskLocation) => {
    const search = deskSearch(window.location.search, next);
    window.history.pushState(null, "", `${window.location.pathname}${search}${window.location.hash}`);
    setLocation(next);
  }, []);

  return [location, go];
}
