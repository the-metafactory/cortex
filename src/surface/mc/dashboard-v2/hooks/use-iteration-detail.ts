/**
 * F-15 — iteration detail hook.
 *
 * Fetches `GET /api/iterations/:id` and merges live
 * `iteration.detail_updated` / `iteration.state_changed` WS frames for
 * the same id. Race-guarded mirroring `use-drill-events.ts` (the
 * iteration id can change as the operator clicks between cards on the
 * kanban; in-flight responses for a stale id are dropped).
 *
 * Surfaces the same `loaded / error / refetch` triple as the other
 * hooks so the detail component can render `loading / error / empty /
 * happy-path` with the same idiom.
 *
 * Per Echo grove-v2#42 (Major 3) — this hook subscribes to the
 * NARROW `iteration.detail_updated` event (full `IterationDetail`),
 * not the broad `iteration.updated` (which now carries header-only
 * `IterationListItem` so the kanban tabs don't pay the body / tasks
 * byte cost on every autosave). The handler fires both events as a
 * pair, so the detail surface always sees the latest body / tasks
 * delta.
 *
 * Two narrow WS subscriptions instead of the kanban hook's broad
 * debounced refetch:
 *   - `iteration.detail_updated` — replaces the in-memory copy in one
 *     functional setState (StrictMode-safe).
 *   - `iteration.state_changed` — applies the state delta optimistically
 *     so the state pill flips immediately even before the next
 *     `iteration.detail_updated` frame lands. (The two events fire as
 *     a pair from the server's PATCH path — the state_changed frame
 *     is redundant for the detail surface but lets the kanban
 *     subscribe narrowly.)
 *
 * Per the F-15 brief, the broader `state.transition` events do NOT
 * trigger a refetch on this hook — they belong to the assignment-level
 * machine, and the iteration detail's task list rolls them up via the
 * detail-updated frames the API emits when the underlying iteration's
 * task set changes (attach/detach paths).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, getJson } from "../lib/api";
import type { IterationDetail, IterationState } from "../../db/iterations";
import type { WsClient, WsMessage } from "./use-websocket";

interface IterationDetailResponse {
  iteration: IterationDetail;
}

export interface IterationDetailHookState {
  iteration: IterationDetail | null;
  loaded: boolean;
  error: string | null;
  /** Manual refetch — used by mutation success paths that want a re-read. */
  refetch: () => void;
}

export function useIterationDetail(
  ws: WsClient,
  iterationId: string | null
): IterationDetailHookState {
  const [iteration, setIteration] = useState<IterationDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const genRef = useRef(0);
  const aliveRef = useRef(true);
  // Mirror id into a ref so the WS subscription's closure can read the
  // currently-rendered id without re-subscribing per render. Mirrors
  // the `use-drill-events.ts` race-guard pattern.
  const idRef = useRef<string | null>(iterationId);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Keep idRef in sync. Setting state synchronously here is fine — the
  // subscriber reads the ref, not the state.
  useEffect(() => {
    idRef.current = iterationId;
  }, [iterationId]);

  const doFetch = useCallback(async () => {
    if (!iterationId) {
      setIteration(null);
      setLoaded(false);
      setError(null);
      return;
    }
    if (!aliveRef.current) return;
    const myGen = ++genRef.current;
    const ac = new AbortController();
    setLoaded(false);
    setError(null);
    try {
      const body = await getJson<IterationDetailResponse>(
        `/api/iterations/${encodeURIComponent(iterationId)}`,
        { signal: ac.signal }
      );
      if (!aliveRef.current || genRef.current !== myGen) return;
      setIteration(body.iteration ?? null);
    } catch (e) {
      if (!aliveRef.current || genRef.current !== myGen) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      const msg =
        e instanceof ApiFailure
          ? e.info.message
          : e instanceof Error
            ? e.message
            : String(e);
      setError(msg);
      setIteration(null);
    } finally {
      if (aliveRef.current && genRef.current === myGen) setLoaded(true);
    }
    // Returning the AbortController so the caller can cancel; useCallback
    // can't return it through the React contract but the abort happens via
    // re-entry (`++genRef` → the in-flight fetch's branch becomes a no-op
    // by the gen check above).
  }, [iterationId]);

  // Boot fetch on every id change.
  useEffect(() => {
    void doFetch();
  }, [doFetch]);

  // WS subscription — `iteration.detail_updated` (full row replace).
  // Per Echo grove-v2#42 (Major 3) — narrow event carrying the full
  // `IterationDetail`. The broad `iteration.updated` is now header-only
  // and handled exclusively by the kanban hook.
  const subscribe = ws.subscribe;
  useEffect(() => {
    function onDetailUpdated(msg: WsMessage) {
      const it = msg["iteration"] as IterationDetail | undefined;
      if (!it || typeof it !== "object" || typeof it.id !== "string") return;
      if (it.id !== idRef.current) return;
      // Functional setState so StrictMode's double-invoke doesn't
      // produce inconsistent snapshots — replace with the freshest
      // server view unconditionally.
      setIteration(() => it);
    }
    return subscribe("iteration.detail_updated", onDetailUpdated);
  }, [subscribe]);

  // WS subscription — `iteration.state_changed` (state delta only).
  // The state pill flips on this frame; the next
  // `iteration.detail_updated` frame (always paired by the server's
  // PATCH path) replaces the rest of the row. Subscribe narrowly
  // anyway so a future "throttle the detail-updated frames during
  // high-volume edits" optimisation (deferred to F-16+) doesn't break
  // the state-pill UX.
  useEffect(() => {
    function onStateChanged(msg: WsMessage) {
      const id = msg["iterationId"];
      if (typeof id !== "string" || id !== idRef.current) return;
      const to = msg["to"] as IterationState | undefined;
      if (!to || typeof to !== "string") return;
      setIteration((prev) =>
        prev && prev.id === id ? { ...prev, state: to } : prev
      );
    }
    return subscribe("iteration.state_changed", onStateChanged);
  }, [subscribe]);

  const refetch = useCallback(() => {
    void doFetch();
  }, [doFetch]);

  return { iteration, loaded, error, refetch };
}
