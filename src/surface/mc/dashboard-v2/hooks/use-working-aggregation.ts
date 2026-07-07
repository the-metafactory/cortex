/**
 * CK-4b (cortex#1295) — cross-stack WORKING aggregation hook.
 *
 * Fetches `GET /api/working-aggregation` (the CK-4a `listWorkingAggregation`
 * read model served by the local daemon) and keeps it fresh via the same
 * WS `state.transition` debounce + `mc.projection` refetch discipline the F-9
 * working grid uses. This is the DATA feed for the cockpit's cross-stack WORKING
 * lane — one metadata rollup per origin stack, keyed on the SCHEMA origin
 * (`origin_stack_id`, decision D-8), NOT the runtime federation tag the
 * `working-grid` `workingTileKey` React-key hack derives.
 *
 * ── SCOPE BOUNDARY (mirrors db/working-aggregation.ts) ───────────────────────
 * The rollup carries METADATA ONLY — per-origin counts + a provider-retry hint.
 * NEVER a session id, prompt, tool call, or any interior. A federated PEER's
 * origin yields the SAME metadata-only tile as a local origin (ADR-0005): the
 * cross-stack lane SEES that a peer is working (counts) but never drills its
 * interior. Dispatch + interior drill stay LOCAL-only (the cockpit's per-agent
 * `WorkingGrid`, not this lane).
 *
 * Boot-vs-refetch error handling matches `use-working-agents`: first-paint
 * failures surface to the caller's error pill; later refetch failures warn only.
 * On a daemon that doesn't serve the endpoint yet (older build) the boot error
 * simply yields an empty lane — honest degradation, never a fabricated tile.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, getJson } from "../lib/api";
import type { WsClient, WsMessage } from "./use-websocket";
import { useProjectionRefetch } from "./use-projection-refetch";

/**
 * Provider back-pressure for an origin's WORKING lane. Byte-shape-mirror of the
 * server's `ProviderRetryStatus` (`db/working-aggregation.ts`) — a semantic state
 * tag + a delay in ms; metadata only, never an interior. Mirrored (not imported)
 * because the server module pulls `bun:sqlite`, which the browser bundle can't.
 */
export interface ProviderRetryStatus {
  /** The dispatch lifecycle's back-pressure state. `not_now` ⇒ rate/capacity exhausted. */
  state: "not_now";
  /** Earliest-retry delay in ms (soonest across the origin's pending assignments). */
  retryAfterMs: number;
}

/**
 * One origin-stack's WORKING rollup — pure lifecycle METADATA. Byte-shape-mirror
 * of the server's `WorkingStackAggregate` (`db/working-aggregation.ts`) and the
 * worker's `WorkingOriginRollup` (`worker/src/routes/state.ts`); the three are
 * kept congruent by their respective shape guards.
 */
export interface WorkingStackAggregate {
  /**
   * The stack these WORKING sessions originated on. `null` ⇒ own/local-stack
   * origin (or a session-less pending dispatch on this daemon). A non-null value
   * that is not this daemon's own stack is a federated PEER — still metadata-only.
   */
  originStackId: string | null;
  /** Count of active (non-terminal, working-state) sessions on this origin stack. */
  activeSessionCount: number;
  /**
   * Of those active sessions, how many are SUB-AGENTS — i.e. carry a
   * `parent_session_id` (the substrate-projection edge; CONTEXT.md §Session tree).
   */
  subAgentCount: number;
  /** Provider back-pressure across this origin's assignments; `null` ⇒ none pending. */
  providerRetry: ProviderRetryStatus | null;
}

interface ListWorkingAggregationResponse {
  aggregation: WorkingStackAggregate[];
}

export interface WorkingAggregationState {
  aggregation: WorkingStackAggregate[];
  loaded: boolean;
  /** Boot error only — refetch failures are swallowed (warn-only). */
  error: string | null;
}

/** Same window as the F-9 grid so a burst of transitions collapses into one refresh. */
const REFETCH_DEBOUNCE_MS = 100;

export function useWorkingAggregation(ws: WsClient): WorkingAggregationState {
  const [aggregation, setAggregation] = useState<WorkingStackAggregate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const genRef = useRef(0);
  const aliveRef = useRef(true);
  const bootedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const fetchAggregation = useCallback(async (signal?: AbortSignal) => {
    const myGen = ++genRef.current;
    try {
      const body = await getJson<ListWorkingAggregationResponse>(
        "/api/working-aggregation",
        signal ? { signal } : undefined
      );
      if (!aliveRef.current || genRef.current !== myGen) return;
      setAggregation(body.aggregation ?? []);
      setError(null);
      bootedRef.current = true;
    } catch (e) {
      if (!aliveRef.current || genRef.current !== myGen) return;
      if ((e as { name?: string })?.name === "AbortError") return;
      const msg = e instanceof ApiFailure ? e.info.message : (e instanceof Error ? e.message : String(e));
      // Only surface boot errors; refetch failures stay quiet (F-9 parity).
      if (!bootedRef.current) {
        setError(msg);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[use-working-aggregation] refetch failed:", msg);
      }
    } finally {
      if (aliveRef.current && genRef.current === myGen) setLoaded(true);
    }
  }, []);

  // Boot fetch.
  useEffect(() => {
    const ac = new AbortController();
    void fetchAggregation(ac.signal);
    return () => ac.abort();
  }, [fetchAggregation]);

  // WS subscription — debounced refetch on every state.transition (mirrors
  // use-working-agents F-9 Decision 8: an over-broad superset trigger, tightened
  // to working-touching transitions in a future pass).
  const subscribe = ws.subscribe;
  useEffect(() => {
    function onTransition(_msg: WsMessage) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void fetchAggregation();
      }, REFETCH_DEBOUNCE_MS);
    }
    return subscribe("state.transition", onTransition);
  }, [subscribe, fetchAggregation]);

  // Also refresh off the S6 `mc.projection` broadcast so bus→MC projection writes
  // (dispatch-lifecycle transitions, provider back-pressure) push the cross-stack
  // lane live. The aggregation is derived from the SAME working-session data as the
  // F-9 grid, so it rides the existing `working-agents` projection view — every
  // family that invalidates the grid (dispatch.lifecycle / review.verdict /
  // agent.heartbeat) invalidates this rollup too. Zero-arg refetch is stable.
  const refetch = useCallback(() => { void fetchAggregation(); }, [fetchAggregation]);
  useProjectionRefetch(ws, "working-agents", refetch);

  return { aggregation, loaded, error };
}
