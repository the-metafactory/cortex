/**
 * F-14 / F-15 — kanban data hook for the iteration planning surface.
 *
 * Two boot fetches (`GET /api/iterations` for the iterations list, plus
 * `GET /api/inbox?source=github&limit=100` for the inbox lane), then
 * live updates via two WS subscription paths:
 *
 *   - `state.transition` (assignment-level) — debounced refetch of
 *     BOTH endpoints. Preserved from F-14: any task-level lifecycle
 *     move can roll up into the iteration view (task counts, derived
 *     state).
 *
 *   - `iteration.created` / `iteration.updated` / `iteration.state_changed`
 *     (F-15) — applied OPTIMISTICALLY without a debounced refetch.
 *     The frame already carries the full row (or just the state delta
 *     for `state_changed`), so we patch the in-memory list directly
 *     instead of paying a round-trip. This is the asymmetry vs the
 *     `state.transition` path: the iteration WS events are
 *     authoritative-by-payload, while `state.transition` only signals
 *     "something might have changed" and the refetch reads the truth.
 *
 *   Why the asymmetry — `state.transition` carries an
 *   assignment-level delta which doesn't directly map to the iteration's
 *   rolled-up `task_count` or aggregated state. The server doesn't yet
 *   recompute the iteration on every transition (deferred to a
 *   roll-up event in Phase G), so the dashboard refetches as a
 *   defensive read. The iteration-level events DO carry the
 *   recomputed row, so we trust them.
 *
 * Concurrency model mirrors `use-working-agents`:
 *   - `genRef` increments per fetch so out-of-order responses are dropped.
 *   - `aliveRef` short-circuits state writes after unmount.
 *   - `AbortController` cancels in-flight requests on remount / refetch.
 *   - `bootedRef` distinguishes first-paint failure (surface to error
 *     pill) from subsequent refetch failures (warn-only — a transition
 *     burst should not pop a banner repeatedly).
 *
 * Per F-14's "No external libs" constraint, the same 100ms debounce
 * window as `use-tasks` and `use-working-agents` is reused so a burst of
 * transitions collapses into one refresh.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, getJson } from "../lib/api";
import {
  INBOX_DEFAULT_LIMIT,
  type InboxItem,
  type IterationListItem,
  type IterationState,
} from "../../db/iterations";
import type { WsClient, WsMessage } from "./use-websocket";

/** Same debounce window as F-8 / F-9 — see `use-working-agents`. */
const REFETCH_DEBOUNCE_MS = 100;

interface IterationsResponse {
  iterations: IterationListItem[];
}

interface InboxResponse {
  // Wire shape per `api/types.ts#ListInboxResponse` — `items`, not
  // `inbox`. F-14 had a typo here that left the inbox column empty in
  // production; F-15 fixes it as a drive-by because the same hook is
  // being extended for iteration-level WS frames.
  items: InboxItem[];
}

export interface IterationsHookState {
  /** All non-cancelled iterations the server returned. Server-sorted. */
  iterations: IterationListItem[];
  /** Upstream inbox items (status != cancelled, not attached to any iteration). */
  inboxItems: InboxItem[];
  loaded: boolean;
  /** Boot error only — refetch failures are swallowed (warn-only). */
  error: string | null;
  /** Manual refetch — used by F-15's mutation success path. */
  refetch: () => void;
}

export function useIterations(ws: WsClient): IterationsHookState {
  const [iterations, setIterations] = useState<IterationListItem[]>([]);
  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const genRef = useRef(0);
  const aliveRef = useRef(true);
  const bootedRef = useRef(false);
  const inflightRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lifetime tracking — mirror of `use-working-agents`.
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

  const doFetch = useCallback(async () => {
    if (!aliveRef.current) return;
    inflightRef.current?.abort();
    const controller = new AbortController();
    inflightRef.current = controller;
    const myGen = ++genRef.current;

    try {
      // Two parallel fetches — both endpoints already exist (F-13). The
      // kanban needs both before it can render coherently, so we await
      // them together and either commit both or surface the failure.
      const [iterBody, inboxBody] = await Promise.all([
        getJson<IterationsResponse>("/api/iterations", { signal: controller.signal }),
        getJson<InboxResponse>(
          `/api/inbox?source=github&limit=${INBOX_DEFAULT_LIMIT}`,
          { signal: controller.signal }
        ),
      ]);
      if (!aliveRef.current || genRef.current !== myGen) return;

      setIterations(iterBody.iterations ?? []);
      setInboxItems(inboxBody.items ?? []);
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
      // Boot vs refetch error split — same policy as `use-working-agents`.
      if (!bootedRef.current) {
        setError(msg);
      } else {
        // Browser bundle has no `process.stderr`; `console.warn` is the
        // only path that surfaces to DevTools. Per repo CLAUDE.md, the
        // catch is named + commented rather than swallowed.
        // eslint-disable-next-line no-console
        console.warn("[use-iterations] refetch failed:", msg);
      }
    } finally {
      if (inflightRef.current === controller) inflightRef.current = null;
      if (aliveRef.current && genRef.current === myGen) setLoaded(true);
    }
  }, []);

  // Boot fetch.
  useEffect(() => {
    void doFetch();
  }, [doFetch]);

  // WS subscription — `state.transition` debounced refetch (F-14 path).
  const subscribe = ws.subscribe;
  useEffect(() => {
    function onTransition(_msg: WsMessage) {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void doFetch();
      }, REFETCH_DEBOUNCE_MS);
    }
    return subscribe("state.transition", onTransition);
  }, [subscribe, doFetch]);

  // WS subscription — `iteration.created` (F-15). Append to the
  // iterations list optimistically. The server's POST already returned
  // the row to the caller via the HTTP response; this frame is for OTHER
  // dashboard tabs that didn't initiate the create.
  //
  // Per Echo grove-v2#42 (Nit 3) — the `iteration.created` frame
  // carries the full `IterationDetail` (the create handler still
  // broadcasts the full row so a freshly-created iteration with
  // attached tasks lands in the detail surface immediately if the
  // principal opens it). The kanban only needs the `IterationListItem`
  // subset; the cast here is structurally safe (extends).
  useEffect(() => {
    function onCreated(msg: WsMessage) {
      const it = msg["iteration"] as IterationListItem | undefined;
      if (!it || typeof it !== "object" || typeof it.id !== "string") return;
      // Per Echo grove-v2#42 (Nit 2) — mirror the `cancelled` filter
      // that `onUpdated` and the server-default list both apply. If
      // F-17 (or any future code path) creates an iteration directly
      // in `cancelled` and broadcasts the frame, the kanban would
      // briefly show a row that the next refetch would drop.
      if (it.state === "cancelled") return;
      setIterations((prev) => {
        // Defensive: don't double-insert if a refetch already raced
        // this frame (the principal might have caused both).
        if (prev.some((p) => p.id === it.id)) return prev;
        return [...prev, it];
      });
      // If the new iteration was created from an inbox item, that
      // inbox row now has an iteration_id and would be filtered out
      // server-side on the next refetch. We can't know which inbox
      // task was attached from THIS frame alone (the iteration's
      // task list isn't fully exposed in the wire shape's
      // `IterationListItem`); the next mutation that touches the
      // iteration's tasks will broadcast `iteration.updated` with a
      // full task list, and the inbox will be reconciled on the next
      // `state.transition`-driven refetch. The trade-off is one
      // stale inbox row visible for a frame, never an inbox row
      // missing.
    }
    return subscribe("iteration.created", onCreated);
  }, [subscribe]);

  // WS subscription — `iteration.updated` (F-15). Replace the row in
  // the in-memory list.
  //
  // Per Echo grove-v2#42 (Major 3) — this event now carries the
  // header-only `IterationListItem` (the broadcast surface was tightened
  // so the kanban tabs don't pay the body / tasks byte cost on every
  // autosave). The detail surface subscribes to
  // `iteration.detail_updated` for the full row — both events fire as a
  // pair from the server's PATCH / attach / detach handlers.
  useEffect(() => {
    function onUpdated(msg: WsMessage) {
      const it = msg["iteration"] as IterationListItem | undefined;
      if (!it || typeof it !== "object" || typeof it.id !== "string") return;
      setIterations((prev) => {
        const idx = prev.findIndex((p) => p.id === it.id);
        if (idx < 0) {
          // Not in our list — append (covers the race where the
          // create frame was missed). F-13's `listIterations` filters
          // `cancelled` out by default; if the row's state is
          // `cancelled` we still want to drop it from the visible
          // list to match the server's filter.
          if (it.state === "cancelled") return prev;
          return [...prev, it];
        }
        // If the iteration was just cancelled, remove it from the
        // visible list (mirrors the server's default-list filter).
        if (it.state === "cancelled") {
          return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
        }
        const next = prev.slice();
        next[idx] = it;
        return next;
      });
      // If the updated iteration has tasks attached now, those tasks
      // would have been removed from the inbox lane (their
      // iteration_id is no longer NULL). We can't know which inbox
      // tasks were affected from the wire shape; rely on the same
      // reconciliation note as `iteration.created` above.
    }
    return subscribe("iteration.updated", onUpdated);
  }, [subscribe]);

  // WS subscription — `iteration.state_changed` (F-15). Apply the
  // state delta optimistically; the paired `iteration.updated` frame
  // replaces the rest of the row. Subscribe narrowly anyway so
  // narrow-only consumers get the column-move signal even if the
  // updated frame is throttled (Phase G).
  useEffect(() => {
    function onStateChanged(msg: WsMessage) {
      const id = msg["iterationId"];
      const to = msg["to"] as IterationState | undefined;
      if (typeof id !== "string" || !to || typeof to !== "string") return;
      setIterations((prev) => {
        const idx = prev.findIndex((p) => p.id === id);
        if (idx < 0) return prev;
        // If the iteration just got cancelled, remove it (server
        // filter parity).
        if (to === "cancelled") {
          return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
        }
        const next = prev.slice();
        const row = next[idx]!;
        if (row.state === to) return prev; // no change
        next[idx] = { ...row, state: to };
        return next;
      });
    }
    return subscribe("iteration.state_changed", onStateChanged);
  }, [subscribe]);

  const refetch = useCallback(() => {
    void doFetch();
  }, [doFetch]);

  return { iterations, inboxItems, loaded, error, refetch };
}
