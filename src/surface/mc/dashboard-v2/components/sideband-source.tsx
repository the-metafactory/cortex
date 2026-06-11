/**
 * U1.1 item 2 + 4 — the sideband-timeline transcript source, LAZY-loaded.
 *
 * For fleet / remote / historical sessions the interior is reconstructed from
 * the signal sideband via U0.1's server-side proxy
 * (`GET /api/observability/traces/{id}/timeline`). This component:
 *   - fetches the timeline (same-origin; MC proxies to loopback `127.0.0.1:9092`),
 *   - maps it to the SAME `LogRow[]` grammar via `timelineToRows` (pure),
 *   - renders it through the SHARED `DrillRowList` (same row components + CSS),
 *   - degrades HONESTLY on a `SidebandError` (no crash): an "interior capture
 *     not available" line + the backend `deep_link` as the analyst's exit.
 *
 * It is `React.lazy`-imported by the drill-down (per the network-canvas chunk
 * precedent) so the `sideband-timeline` mapper + this fetch path land in a
 * SPLIT chunk and never bloat the entry bundle (#933 item 4).
 *
 * Default export so `React.lazy(() => import("./sideband-source"))` resolves it.
 */

import { useEffect, useState } from "react";
import { DrillRowList } from "./drill-log";
import { timelineToRows, type SidebandTimeline } from "../lib/sideband-timeline";
import { fidelityLabel, sidebandErrorLabel } from "../lib/source-merge";
import type { LogRow } from "../lib/event-rows";
import type { SidebandError } from "../../../../common/sideband/proxy";

export interface SidebandSourceProps {
  /** W3C trace_id ≡ correlation_id (sideband path key). */
  correlationId: string;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "rows"; rows: LogRow[] }
  | { phase: "error"; message: string; deepLink?: string };

export default function SidebandSource({ correlationId }: SidebandSourceProps) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    setState({ phase: "loading" });
    (async () => {
      try {
        const resp = await fetch(
          `/api/observability/traces/${encodeURIComponent(correlationId)}/timeline`,
          { signal: ac.signal, headers: { accept: "application/json" } },
        );
        if (!alive) return;
        if (!resp.ok) {
          let err: SidebandError | null = null;
          try {
            err = (await resp.json()) as SidebandError;
          } catch {
            // Body wasn't the structured SidebandError — fall through to the
            // generic honest label rather than crashing on a parse error.
            err = null;
          }
          if (!alive) return;
          const next: LoadState = { phase: "error", message: sidebandErrorLabel(err) };
          if (err?.deep_link) next.deepLink = err.deep_link;
          setState(next);
          return;
        }
        const tl = (await resp.json()) as SidebandTimeline;
        if (!alive) return;
        setState({ phase: "rows", rows: timelineToRows(tl) });
      } catch (e) {
        if (!alive) return;
        if ((e as { name?: string })?.name === "AbortError") return;
        // Network failure reaching MC itself — still honest, still no crash.
        setState({ phase: "error", message: sidebandErrorLabel(null) });
      }
    })();
    return () => {
      alive = false;
      ac.abort();
    };
  }, [correlationId]);

  if (state.phase === "error") {
    return (
      <div className="drill-log-wrap" role="log" aria-live="polite">
        <div className="drill-log-empty">{state.message}</div>
        {state.deepLink && (
          <a
            className="drill-log-deeplink"
            href={state.deepLink}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open in observability backend ↗
          </a>
        )}
      </div>
    );
  }

  const rows = state.phase === "rows" ? state.rows : [];
  return (
    <DrillRowList
      rows={rows}
      loaded={state.phase === "rows"}
      hasMore={false}
      error={null}
      isInitiallyEmpty={rows.length === 0}
      emptyText="No interior recorded for this session."
      fidelityBanner={fidelityLabel("preview")}
    />
  );
}
