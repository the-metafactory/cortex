/**
 * G-1114.B.4 — agent-presence panel hook.
 *
 * Fetches `GET /api/agents` (the stack-local runtime agent-presence registry
 * snapshot) and keeps it fresh by subscribing to the additive `agent.presence`
 * WebSocket frame: every applied presence mutation (`agent.online` /
 * `agent.heartbeat` / `agent.offline` / `agent.capabilities-changed`) broadcasts
 * a refresh signal, which triggers a debounced refetch — agents pop up on boot
 * and drop off when they go offline, live, without a poll.
 *
 * The `agent.presence` frame is a REFRESH SIGNAL, not authoritative state: the
 * panel always re-reads the API rather than mutating off the frame's fields,
 * matching how `use-working-agents` refetches off `state.transition`.
 *
 * Only fetches when `enabled` (the Network tab is visible). A frame arriving
 * while the tab is closed short-circuits (no pointless fetch) but the
 * subscription stays attached so re-entering the tab is current.
 *
 * Lifetime/race guard: `aliveRef` + `genRef` (drop stale in-flight responses) +
 * `AbortController`, the same discipline as `use-working-agents` /
 * `use-attention`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, getJson } from "../lib/api";
import type { AgentPresenceTile, ListAgentsResponse } from "../../api/agents";
import type { WsClient, WsMessage } from "./use-websocket";

export type { AgentPresenceTile, AgentOrigin } from "../../api/agents";

export interface AgentsState {
  agents: AgentPresenceTile[];
  loaded: boolean;
  /** Boot error only — refetch failures are swallowed (warn-only). */
  error: string | null;
}

/** Coalesce a burst of presence frames (a boot fan-out) into one refresh. */
const REFETCH_DEBOUNCE_MS = 150;

export function useAgents(ws: WsClient, enabled: boolean): AgentsState {
  const [agents, setAgents] = useState<AgentPresenceTile[]>([]);
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

  const fetchAgents = useCallback(async (signal?: AbortSignal) => {
    const myGen = ++genRef.current;
    try {
      const body = await getJson<ListAgentsResponse>(
        "/api/agents",
        signal ? { signal } : undefined
      );
      if (!aliveRef.current || genRef.current !== myGen) return;
      setAgents(body.agents ?? []);
      setError(null);
      bootedRef.current = true;
    } catch (e) {
      if (!aliveRef.current || genRef.current !== myGen) return;
      if ((e as { name?: string })?.name === "AbortError") return;
      const msg =
        e instanceof ApiFailure
          ? e.info.message
          : e instanceof Error
            ? e.message
            : String(e);
      // Only surface boot errors; refetch failures stay quiet (parity with
      // use-working-agents). `console.warn` is the only emit path in the bundle.
      if (!bootedRef.current) {
        setError(msg);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[use-agents] refetch failed:", msg);
      }
    } finally {
      if (aliveRef.current && genRef.current === myGen) setLoaded(true);
    }
  }, []);

  // Boot fetch — only when the tab is visible.
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    void fetchAgents(ac.signal);
    return () => ac.abort();
  }, [enabled, fetchAgents]);

  // Live refresh on the `agent.presence` broadcast. Debounced so a boot
  // fan-out (several agents announcing at once) collapses into one refetch.
  // Gated on `enabled` via a ref so the subscription isn't torn down each time
  // the tab flips — a frame arriving while closed just no-ops.
  const subscribe = ws.subscribe;
  useEffect(() => {
    function onPresence(_msg: WsMessage) {
      if (!enabledRef.current) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void fetchAgents();
      }, REFETCH_DEBOUNCE_MS);
    }
    return subscribe("agent.presence", onPresence);
  }, [subscribe, fetchAgents]);

  return { agents, loaded, error };
}
