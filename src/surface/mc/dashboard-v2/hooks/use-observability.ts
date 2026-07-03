/**
 * P-14 U2.1 (#934) — observability tab hook.
 *
 * Fetches `GET /api/observability-events` (per-section rows + counts over the
 * projection of signal's four `system.*` families) and keeps it fresh by
 * subscribing to the `mc.projection` WS frame with family `observability`: every
 * projected observability envelope broadcasts a refresh signal, which triggers a
 * debounced refetch. The frame is a REFRESH SIGNAL, not authoritative state — the
 * tab always re-reads the API (same discipline as `use-governance` / `use-attention`).
 *
 * Only fetches when `enabled` (the Observability tab is visible). Frames arriving
 * while the tab is closed are discarded, so every tab OPEN refetches, and a failed
 * boot fetch retries on the next open rather than wedging the tab.
 *
 * Live-oracle path: stopping the relay / a leaf publishes
 * `system.signal.collector.degraded` / `system.transport.leaf-disconnect`, the
 * renderer projects them (+ opens an `att:adapter:` attention item) and broadcasts
 * the `observability` family — which lands here within one poll's debounce.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, getJson } from "../lib/api";
import { projectionAffectsView } from "../lib/projection-routing";
import type { ObservabilityResponse } from "../../api/observability-tab";
import type { WsClient, WsMessage } from "./use-websocket";

export interface ObservabilityState {
  data: ObservabilityResponse | null;
  loaded: boolean;
  /** Boot error only — refetch failures are swallowed (warn-only). */
  error: string | null;
}

const REFETCH_DEBOUNCE_MS = 150;

export function useObservability(ws: WsClient, enabled: boolean): ObservabilityState {
  const [data, setData] = useState<ObservabilityResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const genRef = useRef(0);
  const aliveRef = useRef(true);
  const bootedRef = useRef(false);
  const enabledRef = useRef(enabled);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const fetchObservability = useCallback(async (isBoot: boolean) => {
    const gen = ++genRef.current;
    try {
      const res = await getJson<ObservabilityResponse>("/api/observability-events");
      if (!aliveRef.current || gen !== genRef.current) return;
      bootedRef.current = true; // freshness achieved — frame refetches engage
      setData(res);
      setLoaded(true);
      setError(null);
    } catch (err) {
      if (!aliveRef.current || gen !== genRef.current) return;
      if (isBoot) {
        setLoaded(true);
        setError(err instanceof ApiFailure ? err.message : String(err));
      } else {
        // eslint-disable-next-line no-console
        console.warn("[mc] observability refetch failed", err);
      }
    }
  }, []);

  // Fetch on EVERY tab open (closed-tab frames are discarded, so reopening must
  // re-read). The first successful fetch flips bootedRef so frame refetches engage.
  useEffect(() => {
    if (!enabled) return;
    void fetchObservability(!bootedRef.current);
  }, [enabled, fetchObservability]);

  // Live refresh on projected observability envelopes (family-gated via the
  // shared routing policy, so a future server family this client doesn't know
  // about can't trigger a spurious refetch).
  const subscribe = ws.subscribe;
  useEffect(() => {
    function onProjection(msg: WsMessage) {
      const family = (msg as { family?: string }).family;
      if (family === undefined || !projectionAffectsView(family, "observability")) return;
      if (!enabledRef.current || !bootedRef.current) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void fetchObservability(false);
      }, REFETCH_DEBOUNCE_MS);
    }
    return subscribe("mc.projection", onProjection);
  }, [subscribe, fetchObservability]);

  return { data, loaded, error };
}
