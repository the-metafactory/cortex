/**
 * G-1113.E.3 — fetch the open attention queue for the Attention surface.
 * Only fetches when `enabled` (software mode on + Attention tab visible).
 * Best-effort: a failure yields an empty queue, not an error surface.
 */
import { useEffect, useState } from "react";
import { getJson } from "../lib/api";
import type { AttentionEntry } from "../../api/attention";

interface AttentionResponse {
  attention: AttentionEntry[];
}

export function useAttention(enabled: boolean): { entries: AttentionEntry[]; loaded: boolean } {
  const [entries, setEntries] = useState<AttentionEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await getJson<AttentionResponse>("/api/attention");
        if (!cancelled) {
          setEntries(res.attention ?? []);
          setLoaded(true);
        }
      } catch (_err) {
        // Best-effort: the surface shows an empty state rather than an error.
        if (!cancelled) {
          setEntries([]);
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { entries, loaded };
}
