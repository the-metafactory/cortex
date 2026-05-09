/**
 * F-18 — fleet metrics hook.
 *
 * Boot fetch + window-switch refetch + WS-debounced refresh on
 * `state.transition`. Mirrors the concurrency model of `use-iterations`:
 * generation-tagged fetches drop out-of-order responses, AbortController
 * cancels in-flight on remount or refetch, `bootedRef` distinguishes
 * first-paint failure (red pill) from subsequent refetch failure (warn).
 *
 * Per F-18 spec Decision 6, the WS debounce here is 500 ms (slower than
 * `use-iterations`'s 100 ms) — metrics don't need single-event resolution;
 * one refresh per quiet half-second is plenty.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, getJson } from "../lib/api";
import type { WsClient, WsMessage } from "./use-websocket";
import type { FleetMetrics } from "../../db/metrics";

const REFETCH_DEBOUNCE_MS = 500;

export type FleetWindow = "24h" | "7d" | "30d";

interface FleetResponse {
  metrics: FleetMetrics;
}

export interface UseMetricsState {
  metrics: FleetMetrics | null;
  loaded: boolean;
  /** Boot error only — refetch failures are warn-only. */
  error: string | null;
  window: FleetWindow;
  setWindow: (w: FleetWindow) => void;
  refetch: () => void;
}

export function useMetrics(ws: WsClient): UseMetricsState {
  const [metrics, setMetrics] = useState<FleetMetrics | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowState, setWindowState] = useState<FleetWindow>("24h");

  const genRef = useRef(0);
  const aliveRef = useRef(true);
  const bootedRef = useRef(false);
  const inflightRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      inflightRef.current?.abort();
      inflightRef.current = null;
    };
  }, []);

  const doFetch = useCallback(async (w: FleetWindow) => {
    if (!aliveRef.current) return;
    inflightRef.current?.abort();
    const controller = new AbortController();
    inflightRef.current = controller;
    const myGen = ++genRef.current;
    try {
      const body = await getJson<FleetResponse>(
        `/api/metrics/fleet?window=${w}`,
        { signal: controller.signal }
      );
      if (!aliveRef.current || genRef.current !== myGen) return;
      setMetrics(body.metrics);
      setError(null);
      bootedRef.current = true;
    } catch (e) {
      if (!aliveRef.current || genRef.current !== myGen) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      const msg =
        e instanceof ApiFailure
          ? e.info.message
          : e instanceof Error
            ? e.message
            : String(e);
      if (!bootedRef.current) {
        setError(msg);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[use-metrics] refetch failed:", msg);
      }
    } finally {
      if (inflightRef.current === controller) inflightRef.current = null;
      if (aliveRef.current && genRef.current === myGen) setLoaded(true);
    }
  }, []);

  // Boot + window-switch fetch.
  useEffect(() => {
    void doFetch(windowState);
  }, [doFetch, windowState]);

  // WS subscribe — debounced refetch on any state.transition.
  const subscribe = ws.subscribe;
  useEffect(() => {
    function onTransition(_msg: WsMessage) {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void doFetch(windowState);
      }, REFETCH_DEBOUNCE_MS);
    }
    return subscribe("state.transition", onTransition);
  }, [subscribe, doFetch, windowState]);

  const refetch = useCallback(() => {
    void doFetch(windowState);
  }, [doFetch, windowState]);

  const setWindow = useCallback((w: FleetWindow) => {
    setWindowState(w);
  }, []);

  return { metrics, loaded, error, window: windowState, setWindow, refetch };
}
