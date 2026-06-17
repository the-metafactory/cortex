/**
 * F-9 working-agent grid hook (MIG-5 port).
 *
 * Fetches `GET /api/working-agents` (agent-keyed projection with the
 * current-primary assignment + `additional_active_count`) and keeps it
 * fresh via WS `state.transition` debounced refetches per F-9 Decision 8.
 *
 * Boot-vs-refetch error handling matches the legacy: first-paint
 * failures surface to the caller's error pill; subsequent refetch
 * failures only warn so a transient hiccup during a transition burst
 * doesn't pop a banner repeatedly.
 *
 * Race guard: same `genRef` + `AbortController` + `aliveRef` pattern as
 * `use-focus-area`, `use-tasks`, and `use-drill-events`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, getJson } from "../lib/api";
import type { AgentOrigin } from "../../api/agents";
import type { WsClient, WsMessage } from "./use-websocket";
import { useProjectionRefetch } from "./use-projection-refetch";

/**
 * ST-P5 — one node in an agent's session tree, mirroring the server shape
 * (`src/surface/mc/lib/session-tree.ts` → `SessionTreeNode`). Lifecycle
 * metadata only (ADR-0005 — no session interiors). `children` is the recursive
 * forest of child sessions (the `initiated-by` edge: a child names its
 * `parent_session_id`; an agent-rooted session has none).
 */
export interface SessionTreeNode {
  session_id: string;
  /** Self-ref to the spawning session; null ⇒ agent-rooted (a tree root). */
  parent_session_id: string | null;
  /** The substrate this session runs on (claude-code | codex | …). */
  substrate: string;
  /** Lifecycle state — a display string the renderer derives badges from. */
  state: string;
  /** Session start (ISO-8601). */
  started_at: string;
  /** Terminal timestamp (ISO-8601), or null while the session is open. */
  ended_at: string | null;
  /** Owning agent display name, when known (a session is NOT an agent). */
  agent_name?: string | null;
  /** Title of the work the session is doing, when known. */
  task_title?: string | null;
  /** Child sessions (recursive). Empty array for a leaf. */
  children: SessionTreeNode[];
}

export interface WorkingAgentTile {
  agent_id: string;
  agent_name: string;
  agent_type: "head" | "hands";
  primary_state_rank: 1 | 2 | 3;
  primary_state: "running" | "dispatched" | "queued";
  primary_assignment: {
    id: string;
    task_id: string;
    task_title: string;
    task_priority: number;
    updated_at: string;
  };
  additional_active_count: number;
  /**
   * #1065 — the tile's origin stack (the pane-of-glass `/api/working-agents`
   * federation tags every tile: `"local"` for the serving stack, or a sibling's
   * `{principal, stack}`). The SAME `agent_id` (e.g. `luna`) legitimately appears
   * across stacks, so the tile's React key MUST be namespaced by origin — see
   * `workingTileKey`. Defaulted to `"local"` at the fetch boundary for pre-#1008
   * (un-aggregated) responses; optional on the type so existing fixtures stay valid.
   */
  origin?: AgentOrigin;
  /**
   * ST-P5 — the owning agent's session tree (refactor §7), mirroring the server
   * projection's `sessions` field. ADDITIVE: every field above is byte-compatible
   * with the pre-ST-P5 DTO. Absent/empty ⇒ the tile renders exactly as before
   * (the working grid shows no tree). Defaulted to `[]` at the fetch boundary so
   * older responses (or a dispatch-only agent with no open sessions) are safe.
   */
  sessions: SessionTreeNode[];
}

interface ListWorkingAgentsResponse {
  agents: WorkingAgentTile[];
}

export interface WorkingAgentsState {
  agents: WorkingAgentTile[];
  loaded: boolean;
  /** Boot error only — refetch failures are swallowed (warn-only). */
  error: string | null;
}

/** Same window as F-8 so a burst of transitions collapses into one refresh. */
const REFETCH_DEBOUNCE_MS = 100;

export function useWorkingAgents(ws: WsClient): WorkingAgentsState {
  const [agents, setAgents] = useState<WorkingAgentTile[]>([]);
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

  const fetchAgents = useCallback(async (signal?: AbortSignal) => {
    const myGen = ++genRef.current;
    try {
      const body = await getJson<ListWorkingAgentsResponse>(
        "/api/working-agents",
        signal ? { signal } : undefined
      );
      if (!aliveRef.current || genRef.current !== myGen) return;
      // Normalize `sessions` to [] and `origin` to "local" per tile so a
      // pre-ST-P5 / pre-#1008 response renders exactly as before — compat path.
      setAgents(
        (body.agents ?? []).map((a) => ({
          ...a,
          sessions: a.sessions ?? [],
          origin: a.origin ?? "local",
        }))
      );
      setError(null);
      bootedRef.current = true;
    } catch (e) {
      if (!aliveRef.current || genRef.current !== myGen) return;
      if ((e as { name?: string })?.name === "AbortError") return;
      const msg = e instanceof ApiFailure ? e.info.message : (e instanceof Error ? e.message : String(e));
      // Only surface boot errors; refetch failures stay quiet (legacy parity).
      // Refetch warnings go to DevTools — `process.stderr` doesn't exist in
      // the browser bundle, so `console.warn` is the only path that emits.
      if (!bootedRef.current) {
        setError(msg);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[use-working-agents] refetch failed:", msg);
      }
    } finally {
      if (aliveRef.current && genRef.current === myGen) setLoaded(true);
    }
  }, []);

  // Boot fetch.
  useEffect(() => {
    const ac = new AbortController();
    void fetchAgents(ac.signal);
    return () => ac.abort();
  }, [fetchAgents]);

  // WS subscription — debounced refetch on every state.transition. F-9
  // Decision 8 keeps the simpler "every transition" trigger as a slightly
  // over-broad superset of the strictly-correct filter; tightening to
  // {running,dispatched,queued}-touching transitions is a future pass.
  const subscribe = ws.subscribe;
  useEffect(() => {
    function onTransition(_msg: WsMessage) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void fetchAgents();
      }, REFETCH_DEBOUNCE_MS);
    }
    return subscribe("state.transition", onTransition);
  }, [subscribe, fetchAgents]);

  // C-863 — also refresh off the S6 `mc.projection` broadcast so bus→MC
  // projection writes (dispatch-lifecycle transitions, review verdicts, agent
  // heartbeats) push the working grid live instead of waiting for the next
  // `state.transition`-driven refetch. Its own (wider) trailing debounce
  // coalesces projection bursts; the zero-arg `refetch` is stable for the hook
  // lifetime so the subscription isn't torn down every render.
  const refetch = useCallback(() => { void fetchAgents(); }, [fetchAgents]);
  useProjectionRefetch(ws, "working-agents", refetch);

  return { agents, loaded, error };
}
