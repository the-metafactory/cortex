/**
 * CK-4b (cortex#1295) — the cross-stack WORKING aggregate lane.
 *
 * Renders one METADATA tile per origin stack from CK-4a's `workingAggregation`
 * read model — the pane-of-glass rollup that sits above the cockpit's LOCAL,
 * drillable `WorkingGrid`. Each tile is keyed on the SCHEMA origin
 * (`origin_stack_id`), the deliberate replacement for the `working-grid`
 * `workingTileKey` React-key hack.
 *
 * ── Scope boundary (ADR-0005 / CK-4a) ────────────────────────────────────────
 * These tiles are METADATA ONLY — per-origin session counts, a sub-agent
 * (session-tree child) count, and an honest provider-retry hint. They carry NO
 * session id, prompt, or interior, and they are NOT interactive: there is no
 * drill affordance here. A federated PEER's origin renders the SAME metadata
 * tile as a local origin — the cross-stack lane SEES that a peer is working, but
 * dispatch + interior drill stay LOCAL-only (the `WorkingGrid` below, own-local).
 *
 * ── Honest pre-release copy (decision D-9) ───────────────────────────────────
 * The provider-retry chip reads "queued · retry in <delay>". The mockup's
 * "awaiting hands" capacity narrative is DEFERRED to SPX-3 and is never rendered
 * here (see `working-aggregate-display.queuedRetryLabel`).
 */

import "./working-aggregate.css";
import {
  pickWorkingAggregateMode,
  aggregateTileKey,
  originStackLabel,
  activeSessionSummary,
  subAgentSummary,
  queuedRetryLabel,
} from "../lib/working-aggregate-display";
import type { WorkingStackAggregate } from "../hooks/use-working-aggregation";

export interface WorkingAggregateProps {
  aggregates: readonly WorkingStackAggregate[];
  loaded: boolean;
  /** Boot error only (refetch failures are swallowed by the hook). */
  error: string | null;
}

export function WorkingAggregate({ aggregates, loaded, error }: WorkingAggregateProps) {
  const mode = pickWorkingAggregateMode({
    aggregates: [...aggregates],
    loaded,
    error,
  });

  return (
    <section className="working-aggregate-section" aria-label="Working across stacks">
      <h3 className="working-aggregate-title">Across stacks</h3>

      {mode === "error" && (
        <div className="working-aggregate-error" role="status">
          ⚠ {error}
        </div>
      )}
      {mode === "loading" && (
        <div className="working-aggregate-empty">Loading…</div>
      )}
      {mode === "empty" && (
        <div className="working-aggregate-empty">No stacks working right now.</div>
      )}
      {mode === "tiles" && (
        <ul className="working-aggregate-grid">
          {aggregates.map((a) => (
            <WorkingAggregateTile key={aggregateTileKey(a.originStackId)} aggregate={a} />
          ))}
        </ul>
      )}
    </section>
  );
}

function WorkingAggregateTile({ aggregate }: { aggregate: WorkingStackAggregate }) {
  const { originStackId, activeSessionCount, subAgentCount, providerRetry } = aggregate;
  const label = originStackLabel(originStackId);
  const isLocal = originStackId === null;
  const retry = queuedRetryLabel(providerRetry);

  return (
    <li
      className="working-aggregate-tile"
      data-origin={label}
      data-origin-kind={isLocal ? "local" : "cross-stack"}
    >
      <div className="working-aggregate-origin">
        <span className="working-aggregate-origin-mark" aria-hidden="true">⬣</span>
        <span className="working-aggregate-origin-label">{label}</span>
        {isLocal && (
          <span className="working-aggregate-origin-tag">this stack</span>
        )}
      </div>

      <div className="working-aggregate-counts">
        <span className="working-aggregate-active">{activeSessionSummary(activeSessionCount)}</span>
        <span className="working-aggregate-dot" aria-hidden="true">·</span>
        <span className="working-aggregate-subagents">{subAgentSummary(subAgentCount)}</span>
      </div>

      {retry && (
        <div className="working-aggregate-queued" data-state="not_now">
          <span className="working-aggregate-queued-dot" aria-hidden="true" />
          {retry}
        </div>
      )}
    </li>
  );
}
