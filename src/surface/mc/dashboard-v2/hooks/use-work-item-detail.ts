/**
 * G-1113.D.5 — fetch the work-item detail projection for the selected work item.
 * Fetches whenever `workItemId` is non-null; best-effort (failure → null detail).
 */
import { useEffect, useState } from "react";
import { getJson } from "../lib/api";
import type { WorkItemDetail } from "../../api/work-item-detail";

export function useWorkItemDetail(workItemId: string | null): {
  detail: WorkItemDetail | null;
  loaded: boolean;
} {
  const [detail, setDetail] = useState<WorkItemDetail | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!workItemId) {
      setDetail(null);
      setLoaded(false);
      return;
    }
    let cancelled = false;
    setLoaded(false);
    void (async () => {
      try {
        // id carries `/` and `#` — encode it as a query param.
        const res = await getJson<WorkItemDetail>(`/api/work-items?id=${encodeURIComponent(workItemId)}`);
        if (!cancelled) {
          setDetail(res);
          setLoaded(true);
        }
      } catch (_err) {
        // Best-effort: the surface shows a not-found state rather than erroring.
        if (!cancelled) {
          setDetail(null);
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workItemId]);

  return { detail, loaded };
}
