/**
 * FLG-1 (docs/plan-mc-future-state.md §4.D) — guided-join handoff banner hook.
 *
 * Fetches `GET /api/networks/:net/handoff/:member` (the 3-leg seal →
 * hub-authorize → leaf-up state, whose move is next, and why leaf-up is blocked)
 * for ONE network + member. The "confirm" toggle re-reads with `?confirmed=true`
 * — mapping to the member attestation the daemon applies via the pure
 * `deriveHandoffState` (an `undefined` hub-authorize leg upgrades to done; a real
 * `false` NEVER does — the guarantee is server-side, Sage #1499).
 *
 * Deliberately LIGHT (no WebSocket refresh): handoff legs change on discrete
 * human acts (seal / authorize / leaf-up), not on the presence firehose, so a
 * fetch-on-mount + refetch-on-confirm is honest for an R1 read-glass slice. A
 * failed/unavailable read (503 no-federation, 404 not-joined, network error) is
 * swallowed to `status: null` — the banner simply renders nothing rather than
 * surfacing an error chip on a non-federated stack.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "../lib/api";
import type { HandoffStatusDTO } from "../../api/handoff";

export type {
  HandoffStatusDTO,
  HandoffLegDTO,
  HandoffLegId,
  HandoffLegStatus,
  HandoffOwner,
  LeafUpBlockedReason,
} from "../../api/handoff";

export interface HandoffHookState {
  /** The latest handoff status, or `null` while unloaded / when the read failed. */
  status: HandoffStatusDTO | null;
  loaded: boolean;
  /** Whether the member "confirm hub authorization" attestation is toggled on. */
  confirmed: boolean;
  /** Toggle the attestation; flips the query and refetches. */
  setConfirmed: (next: boolean) => void;
}

export function useHandoff(
  networkId: string,
  member: string | null,
  enabled: boolean,
): HandoffHookState {
  const [status, setStatus] = useState<HandoffStatusDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [confirmed, setConfirmedState] = useState(false);

  // Lifetime + race guard (mirrors use-networks/use-agents): a stale in-flight
  // response from a superseded fetch (older gen) or an unmounted component
  // (aliveRef false) is dropped rather than written.
  const genRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const fetchHandoff = useCallback(
    async (confirmedNow: boolean, signal?: AbortSignal) => {
      if (member === null) return;
      const myGen = ++genRef.current;
      const query = confirmedNow ? "?confirmed=true" : "";
      const path = `/api/networks/${encodeURIComponent(networkId)}/handoff/${encodeURIComponent(member)}${query}`;
      try {
        const body = await getJson<HandoffStatusDTO>(
          path,
          signal ? { signal } : undefined,
        );
        if (!aliveRef.current || genRef.current !== myGen) return;
        setStatus(body);
        setLoaded(true);
      } catch (e) {
        if (!aliveRef.current || genRef.current !== myGen) return;
        if ((e as { name?: string })?.name === "AbortError") return;
        // Swallow: a 503 (no federation), 404 (not joined), or network error
        // means "no handoff to show here" — the banner hides, never an error.
        setStatus(null);
        setLoaded(true);
      }
    },
    [networkId, member],
  );

  useEffect(() => {
    if (!enabled || member === null) return;
    const ctrl = new AbortController();
    void fetchHandoff(confirmed, ctrl.signal);
    return () => ctrl.abort();
  }, [enabled, member, confirmed, fetchHandoff]);

  const setConfirmed = useCallback((next: boolean) => setConfirmedState(next), []);

  return { status, loaded, confirmed, setConfirmed };
}
