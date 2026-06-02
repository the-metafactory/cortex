/**
 * G-1113.D.4 — fetch the phase-detail projection for the selected phase.
 * Fetches whenever `phaseId` is non-null; best-effort (failure → null detail).
 */
import { useEffect, useState } from "react";
import { getJson } from "../lib/api";
import type { PhaseDetail } from "../../api/phase-detail";

export function usePhaseDetail(phaseId: string | null): { detail: PhaseDetail | null; loaded: boolean } {
  const [detail, setDetail] = useState<PhaseDetail | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!phaseId) {
      setDetail(null);
      setLoaded(false);
      return;
    }
    let cancelled = false;
    setLoaded(false);
    void (async () => {
      try {
        const res = await getJson<PhaseDetail>(`/api/phases/${encodeURIComponent(phaseId)}`);
        if (!cancelled) {
          setDetail(res);
          setLoaded(true);
        }
      } catch (_err) {
        // Best-effort: the surface shows an empty/not-found state rather than erroring.
        if (!cancelled) {
          setDetail(null);
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phaseId]);

  return { detail, loaded };
}
