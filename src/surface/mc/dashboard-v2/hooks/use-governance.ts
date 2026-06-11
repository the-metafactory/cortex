/**
 * G-1115 — governance verdicts hook (governance upgrade Stage 5).
 *
 * Fetches `GET /api/governance` (30d verdicts + summary + alarm tier) and
 * keeps it fresh by subscribing to the `mc.projection` WS frame with family
 * `governance.verdict`: every projected verdict broadcasts a refresh signal,
 * which triggers a debounced refetch. The frame is a REFRESH SIGNAL, not
 * authoritative state — the tab always re-reads the API (same discipline as
 * `use-agents` / `use-attention`).
 *
 * Only fetches when `enabled` (the Governance tab is visible). Frames
 * arriving while the tab is closed are discarded, so every tab OPEN refetches
 * (audit data must not present stale) — and a failed boot fetch retries on
 * the next open rather than wedging the tab on its error.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, getJson } from "../lib/api";
import type { GovernanceResponse } from "../../api/governance";
import type { WsClient, WsMessage } from "./use-websocket";

export interface GovernanceState {
  data: GovernanceResponse | null;
  loaded: boolean;
  /** Boot error only — refetch failures are swallowed (warn-only). */
  error: string | null;
}

const REFETCH_DEBOUNCE_MS = 150;

export function useGovernance(ws: WsClient, enabled: boolean): GovernanceState {
  const [data, setData] = useState<GovernanceResponse | null>(null);
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

  const fetchGovernance = useCallback(async (isBoot: boolean) => {
    const gen = ++genRef.current;
    try {
      const res = await getJson<GovernanceResponse>("/api/governance");
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
        console.warn("[mc] governance refetch failed", err);
      }
    }
  }, []);

  // Fetch on EVERY tab open (closed-tab frames are discarded, so reopening
  // must re-read — stale audit data is worse than a refetch). The first
  // successful fetch flips bootedRef so frame-driven refetches engage.
  useEffect(() => {
    if (!enabled) return;
    void fetchGovernance(!bootedRef.current);
  }, [enabled, fetchGovernance]);

  // Live refresh on projected verdicts.
  const subscribe = ws.subscribe;
  useEffect(() => {
    function onProjection(msg: WsMessage) {
      const family = (msg as { family?: string }).family;
      if (family !== "governance.verdict") return;
      if (!enabledRef.current || !bootedRef.current) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void fetchGovernance(false);
      }, REFETCH_DEBOUNCE_MS);
    }
    return subscribe("mc.projection", onProjection);
  }, [subscribe, fetchGovernance]);

  return { data, loaded, error };
}
