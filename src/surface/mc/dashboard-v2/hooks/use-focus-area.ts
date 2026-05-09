/**
 * F-6 focus area hook — "who needs me" blocked-only feed.
 *
 * Fetches `GET /api/focus-area` once at mount and re-fetches on
 * `state.transition` WS frames where `from === 'blocked'` or
 * `to === 'blocked'` (the only transitions that change focus-area
 * membership). 150 ms trailing debounce per F-6 addendum.
 *
 * `mostActiveAgent` drives the empty-state one-liner (design addendum
 * §2.6 / §4) and is always populated regardless of `items`, so the
 * dashboard can render the empty state in one round-trip.
 *
 * Concurrency model (MIG-2 sweep W3):
 *  - Each `refetch` bumps a generation counter and carries an
 *    `AbortController.signal`. Out-of-order responses are dropped at
 *    the resolution site so a slow initial fetch can't clobber a
 *    fresher WS-triggered refetch.
 *  - Cleanup on unmount aborts the in-flight fetch and bumps the gen
 *    counter, so a late-resolving response from a discarded React
 *    StrictMode mount can't write into a remounted hook's state.
 *
 * The hook depends on `ws.subscribe` (stable across renders via the
 * `useCallback([])` inside `useWebSocket`) rather than the whole `ws`
 * object, so a connection-state flip on `ws.state` doesn't churn the
 * subscription (sweep W4).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, getJson } from "../lib/api";
import { isFocusAreaTransition } from "../lib/focus-area-filter";
import type { WsClient, WsMessage } from "./use-websocket";
import type { AssignmentListItem, MostActiveAgent } from "../../db/assignments";
import { ITERATION_STATES, type IterationState } from "../../db/iterations";
import {
  patchIterationOnRows,
  validateIterationUpdatedPayload,
  validateTaskUpdatedPayload,
  type IterationTagPatch,
} from "../lib/iteration-display";

const REFETCH_DEBOUNCE_MS = 150;

export interface FocusAreaState {
  items: AssignmentListItem[];
  mostActiveAgent: MostActiveAgent | null;
  /** True once the first fetch has completed (success or failure). */
  loaded: boolean;
  /** Last error message, or null after a successful refetch. */
  error: string | null;
  /** Manual refetch trigger — useful for an operator-driven refresh. */
  refetch: () => void;
}

interface FocusAreaResponse {
  items: AssignmentListItem[];
  mostActiveAgent: MostActiveAgent | null;
}

export function useFocusArea(ws: WsClient): FocusAreaState {
  const [items, setItems] = useState<AssignmentListItem[]>([]);
  const [mostActiveAgent, setMostActiveAgent] = useState<MostActiveAgent | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generation counter — incremented on every refetch and on unmount.
  // Resolved responses with a stale gen number are dropped.
  const genRef = useRef(0);
  // The currently in-flight AbortController, if any. Re-issued per
  // refetch and aborted on the next refetch / unmount.
  const inflightRef = useRef<AbortController | null>(null);
  // Track unmount to keep state setters off a discarded hook instance.
  const aliveRef = useRef(true);

  const refetch = useCallback(async () => {
    if (!aliveRef.current) return;
    // Abort any in-flight request so the network-level work stops too.
    inflightRef.current?.abort();
    const controller = new AbortController();
    inflightRef.current = controller;
    const myGen = ++genRef.current;

    try {
      const body = await getJson<FocusAreaResponse>("/api/focus-area", {
        signal: controller.signal,
      });
      // Drop stale or discarded-mount responses.
      if (!aliveRef.current || myGen !== genRef.current) return;
      setItems(body.items ?? []);
      setMostActiveAgent(body.mostActiveAgent ?? null);
      setError(null);
    } catch (e) {
      // AbortError is expected when a newer refetch / unmount
      // pre-empts the in-flight call — surface nothing to the UI.
      if (e instanceof DOMException && e.name === "AbortError") return;
      // Likewise drop stale-gen errors (the newer fetch will set
      // `error` itself when it resolves).
      if (!aliveRef.current || myGen !== genRef.current) return;
      const msg = e instanceof ApiFailure ? e.info.message : (e instanceof Error ? e.message : String(e));
      setError(msg);
    } finally {
      // Clear `inflight` only if we're still the active controller —
      // a newer refetch may have replaced it already.
      if (inflightRef.current === controller) inflightRef.current = null;
      if (aliveRef.current && myGen === genRef.current) setLoaded(true);
    }
  }, []);

  // Initial fetch + lifetime tracking. Mount sets `aliveRef = true`
  // (StrictMode remount needs this), unmount aborts + bumps gen so any
  // pending response from the discarded mount is dropped.
  useEffect(() => {
    aliveRef.current = true;
    refetch();
    return () => {
      aliveRef.current = false;
      genRef.current++;
      inflightRef.current?.abort();
      inflightRef.current = null;
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [refetch]);

  // WS subscription — filtered + debounced per F-6 addendum.
  //
  // Depend on `ws.subscribe` (stable via useCallback in use-websocket)
  // and `refetch` (stable via useCallback above) so the subscription
  // doesn't churn when the parent re-renders or when `ws.state` flips
  // (sweep W4).
  const subscribe = ws.subscribe;
  useEffect(() => {
    function onTransition(msg: WsMessage) {
      // Membership only changes on blocked-related transitions; skip
      // running→running or queued→dispatched bursts so we don't hammer
      // the server.
      if (!isFocusAreaTransition(msg)) return;
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        refetch();
      }, REFETCH_DEBOUNCE_MS);
    }
    const unsub = subscribe("state.transition", onTransition);
    return () => {
      unsub();
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [subscribe, refetch]);

  // F-16 — patch the denormalised `iteration` tag on each focus-area
  // item when the iteration's title/state changes. Same rationale as
  // `use-tasks`: the wire frame already carries (id, title, state)
  // so we patch in place without a network round-trip. Drill-down
  // header chip relies on this tag for its rendering, so a stale
  // title here would leave the chip showing the old name until the
  // next blocked transition forced a refetch.
  //
  // Per Echo grove-v2#43 sweep — patch logic centralised in
  // `patchIterationOnRows` (Major 3), runtime guards in
  // `validateIterationUpdatedPayload` (Major 4), `task.updated`
  // subscription added for `null → attached` / `attached → null`
  // transitions that `iteration.updated` can't infer (Major 1).
  // The `iteration.state_changed` subscription stays as belt-and-
  // braces against a future broadcast-ordering refactor (Major 2).
  useEffect(() => {
    function onIterationUpdated(msg: WsMessage) {
      const patch = validateIterationUpdatedPayload(msg["iteration"]);
      if (!patch) return;
      setItems((prev) => patchIterationOnRows(prev, patch));
    }
    function onIterationStateChanged(msg: WsMessage) {
      const id = msg["iterationId"];
      const to = msg["to"];
      if (
        typeof id !== "string" ||
        typeof to !== "string" ||
        !ITERATION_STATES.includes(to as IterationState)
      ) return;
      const patch: IterationTagPatch = { id, state: to as IterationState };
      setItems((prev) => patchIterationOnRows(prev, patch));
    }
    function onTaskUpdated(msg: WsMessage) {
      // F-16 sweep — replace the cached row in place when a task's
      // iteration link mutates. Focus area is keyed by assignment id,
      // not task id; we match by `task.id` on the assignment row.
      //
      // Per Echo grove-v2#43 sweep #2 — runtime shape check via
      // `validateTaskUpdatedPayload`. Symmetric with the iteration
      // validator; a malformed `iteration: { title: 42 }` would
      // otherwise land in cache and crash the chip renderer.
      const task = validateTaskUpdatedPayload(msg["task"]);
      if (!task) return;
      setItems((prev) => {
        let changed = false;
        const next = prev.map((row) => {
          if (row.task.id !== task.id) return row;
          changed = true;
          // Patch only the iteration denorm; keep the rest of the
          // assignment row (state, age, etc.) intact since the
          // task.updated frame doesn't carry that.
          return { ...row, iteration: task.iteration };
        });
        return changed ? next : prev;
      });
    }
    const u1 = subscribe("iteration.updated", onIterationUpdated);
    const u2 = subscribe("iteration.state_changed", onIterationStateChanged);
    const u3 = subscribe("task.updated", onTaskUpdated);
    return () => {
      u1();
      u2();
      u3();
    };
  }, [subscribe]);

  return { items, mostActiveAgent, loaded, error, refetch };
}
