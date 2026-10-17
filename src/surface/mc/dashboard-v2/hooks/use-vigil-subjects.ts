import { useEffect, useState } from "react";
import { getJson } from "../lib/api";
import type { VigilSubjectsResponse, VigilSubjectView } from "../../api/vigil";

export function useVigilSubjects(active: boolean) {
  const [subjects, setSubjects] = useState<VigilSubjectView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setSubjects([]);
    setLoaded(false);
    setError(null);
    void getJson<VigilSubjectsResponse>("/api/vigil/subjects", { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setSubjects(response.subjects);
        setEnabled(response.enabled !== false);
        setLoaded(true);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError("Could not load watched subjects.");
        setLoaded(true);
      });
    return () => controller.abort();
  }, [active]);

  return { subjects, loaded, enabled, error };
}
