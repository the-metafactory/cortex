import { useCallback, useEffect, useState } from "react";
import { getJson } from "../lib/api";
import type { StudioView } from "../../desk/studio/view";

const REFRESH_MS = 30_000;
const MODE_PARAM = "desk";
const THREAD_PARAM = "thread";

export type DeskMode = "day" | "studio";

interface StudioState {
  studio: StudioView | null;
  error: string | null;
}

export function useDeskStudio(poll: boolean): StudioState {
  const [state, setState] = useState<StudioState>({ studio: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const payload = await getJson<{ studio: StudioView | null }>("/api/desk/studio", { signal: controller.signal });
        if (!controller.signal.aborted) setState({ studio: payload.studio ?? null, error: null });
      } catch {
        if (!controller.signal.aborted) setState((s) => ({ ...s, error: "The Studio could not load. Retrying." }));
      }
    };
    void load();
    const timer = poll ? setInterval(() => void load(), REFRESH_MS) : undefined;
    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [poll]);

  return state;
}

export interface DeskLocation {
  mode: DeskMode;
  thread: string | null;
}

export function readDeskLocation(search: string): DeskLocation {
  const params = new URLSearchParams(search);
  const mode: DeskMode = params.get(MODE_PARAM) === "studio" ? "studio" : "day";
  return { mode, thread: mode === "studio" ? params.get(THREAD_PARAM) : null };
}

export function deskSearch(search: string, next: DeskLocation): string {
  const params = new URLSearchParams(search);
  params.delete(MODE_PARAM);
  params.delete(THREAD_PARAM);
  if (next.mode === "studio") params.set(MODE_PARAM, "studio");
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
