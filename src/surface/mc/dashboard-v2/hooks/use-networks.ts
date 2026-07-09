/**
 * MC-A1 (cortex#1275) — networks-as-first-class panel hook.
 *
 * Fetches `GET /api/networks` (joined networks + their admitted roster ⋈
 * presence → membership verdict) and keeps it fresh off the same
 * `agent.presence` WebSocket refresh signal `use-agents` uses — a presence
 * mutation can flip a member between `admitted-present` / `absent-offline` / `absent-unheard`, so a
 * presence frame re-reads the membership too.
 *
 * Mirrors `use-agents` exactly (lifetime/race guard via `aliveRef` + `genRef` +
 * `AbortController`; debounced refetch; boot-error-only surfacing). Only fetches
 * when `enabled` (the Network tab is visible).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, getJson } from "../lib/api";
import type {
  ListNetworksResponse,
  NetworkMembershipDTO,
} from "../../api/networks";
import type { WsClient, WsMessage } from "./use-websocket";

export type {
  NetworkMembershipDTO,
  MembershipMemberDTO,
  RosterStatus,
  RosterScope,
} from "../../api/networks";

export interface NetworksState {
  networks: NetworkMembershipDTO[];
  loaded: boolean;
  /** Boot error only — refetch failures are swallowed (warn-only). */
  error: string | null;
}

/** Coalesce a burst of presence frames (a boot fan-out) into one refresh. */
const REFETCH_DEBOUNCE_MS = 150;

export function useNetworks(ws: WsClient, enabled: boolean): NetworksState {
  const [networks, setNetworks] = useState<NetworkMembershipDTO[]>([]);
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

  const fetchNetworks = useCallback(async (signal?: AbortSignal) => {
    const myGen = ++genRef.current;
    try {
      const body = await getJson<ListNetworksResponse>(
        "/api/networks",
        signal ? { signal } : undefined,
      );
      if (!aliveRef.current || genRef.current !== myGen) return;
      setNetworks(body.networks ?? []);
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
      if (!bootedRef.current) {
        setError(msg);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[use-networks] refetch failed:", msg);
      }
    } finally {
      if (aliveRef.current && genRef.current === myGen) setLoaded(true);
    }
  }, []);

  // Boot fetch — only when the tab is visible.
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    void fetchNetworks(ac.signal);
    return () => ac.abort();
  }, [enabled, fetchNetworks]);

  // Live refresh on the `agent.presence` broadcast (a presence change can flip a
  // member's present/absent verdict). Debounced; gated on `enabled` via a ref.
  const subscribe = ws.subscribe;
  useEffect(() => {
    function onPresence(_msg: WsMessage) {
      if (!enabledRef.current) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void fetchNetworks();
      }, REFETCH_DEBOUNCE_MS);
    }
    return subscribe("agent.presence", onPresence);
  }, [subscribe, fetchNetworks]);

  return { networks, loaded, error };
}
