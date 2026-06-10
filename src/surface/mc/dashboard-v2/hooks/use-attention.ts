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

export function useAttention(
  ws: WsClient,
  enabled: boolean
): { entries: AttentionEntry[]; loaded: boolean } {
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

  return { entries, loaded };
}
