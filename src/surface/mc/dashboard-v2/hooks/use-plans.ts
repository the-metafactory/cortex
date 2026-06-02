/**
 * G-1113.D.3 — fetch the plan-overview projection for the Plans surface.
 * Only fetches when `enabled` (software mode on + Plans tab visible).
 * Best-effort: a failure yields an empty list, not an error surface.
 */
import { useEffect, useState } from "react";
import { getJson } from "../lib/api";
import type { PlanOverview } from "../../api/plans";

interface PlansResponse {
  plans: PlanOverview[];
}

export function usePlans(enabled: boolean): { plans: PlanOverview[]; loaded: boolean } {
  const [plans, setPlans] = useState<PlanOverview[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await getJson<PlansResponse>("/api/plans");
        if (!cancelled) {
          setPlans(res.plans ?? []);
          setLoaded(true);
        }
      } catch (_err) {
        // Best-effort: the surface shows an empty state rather than an error.
        if (!cancelled) {
          setPlans([]);
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { plans, loaded };
}
