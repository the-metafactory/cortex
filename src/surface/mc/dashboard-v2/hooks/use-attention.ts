/**
 * G-1113.E.3 — fetch the open attention queue for the Attention surface.
 * Only fetches when `enabled` (software mode on + Attention tab visible).
 * Best-effort: a failure yields an empty queue, not an error surface.
 *
 * C-863 — when enabled, also refreshes off the S6 `mc.projection` broadcast so
 * `attention`- and `review.verdict`-family projection writes (a blocking verdict
 * opening/clearing an attention entry) push the queue live instead of waiting for
 * the next tab re-entry. The projection subscription is a no-op while disabled
 * (the WS frame still arrives, but `enabled=false` short-circuits the refetch).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "../lib/api";
import type { AttentionEntry } from "../../api/attention";
import type { WsClient } from "./use-websocket";
import { useProjectionRefetch } from "./use-projection-refetch";

interface AttentionResponse {
  attention: AttentionEntry[];
}

export interface AttentionQueue {
  entries: AttentionEntry[];
  loaded: boolean;
  /**
   * CK-6b — reconcile the queue with server truth. Called after a resolve/dismiss
   * POST settles: on success it confirms the drop, on failure it RESTORES the row
   * (the item is still `open` server-side), so the optimistic removal self-heals.
   * Ungated (a mutation implies the surface is live), unlike the projection refetch.
   */
  refetch: () => void;
  /**
   * CK-6b — optimistically remove an item by id for instant feedback the moment a
   * lifecycle button is pressed, before the POST resolves. `refetch` reconciles.
   */
  dropOptimistic: (attentionId: string) => void;
}

export function useAttention(
  ws: WsClient,
  enabled: boolean
): AttentionQueue {
  const [entries, setEntries] = useState<AttentionEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Lifetime guard so a projection-driven refetch resolving after unmount
  // (or after the tab is left) can't setState on a dead component.
  const aliveRef = useRef(true);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await getJson<AttentionResponse>(
        "/api/attention",
        signal ? { signal } : undefined
      );
      if (!aliveRef.current) return;
      setEntries(res.attention ?? []);
      setLoaded(true);
    } catch (_err) {
      // Best-effort: the surface shows an empty state rather than an error.
      // AbortError (tab left / unmount mid-flight) is also swallowed here.
      if (!aliveRef.current) return;
      setEntries([]);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [enabled, load]);

  // C-863 — projection-driven refresh, gated on `enabled` so a frame arriving
  // while the tab is closed doesn't issue a pointless fetch. `refetch` is stable
  // for the hook lifetime; the gate is read off a ref so the subscription isn't
  // resubscribed each time `enabled` flips.
  const refetch = useCallback(() => {
    if (!enabledRef.current) return;
    void load();
  }, [load]);
  useProjectionRefetch(ws, "attention", refetch);

  // CK-6b — ungated reload for post-mutation reconcile (see AttentionQueue.refetch).
  const reload = useCallback(() => {
    void load();
  }, [load]);

  const dropOptimistic = useCallback((attentionId: string) => {
    if (!aliveRef.current) return;
    setEntries((prev) => prev.filter((e) => e.item.id !== attentionId));
  }, []);

  return { entries, loaded, refetch: reload, dropOptimistic };
}
