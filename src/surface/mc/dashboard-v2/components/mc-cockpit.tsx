/**
 * CK-3 (cortex#1289) — the right-panel COCKPIT.
 *
 * Folds the four legacy standalone G-1113 surfaces — ATTENTION, WORKING, GOVERN
 * (governance audit + DISPATCH) — into ONE stack-scoped panel that mounts inside
 * `McShell`'s `.mc-skin` cockpit slot. This is a FOLD, not a rebuild: the four
 * components (`AttentionView`, `WorkingGrid`, `GovernanceView`, `DispatchButton`)
 * are REUSED verbatim; `mc-cockpit.css` re-skins their `scaffold-*` markup to the
 * D1 mc tokens when they render inside `.mc-cockpit`, exactly the pane-by-pane
 * adoption pattern McShell already uses.
 *
 * ## Stack-scoped, single snapshot subscription
 *
 * The legacy surfaces were whole-dashboard + fetch-on-tab-visible. The cockpit is
 * scoped to the DIVED stack (`AltitudeSelection.stack`) via the pure
 * `mc-cockpit-scope` lib, fed by the app-scope snapshots (one fetch + WS-kept-fresh
 * per feed — the single subscription that replaces per-panel tab-gated polling).
 * No fetching happens here.
 *
 * ## Sovereignty + posture (ADR-0005 + fail-closed posture gate)
 *
 *   - A FEDERATED PEER stack exposes AGGREGATE metadata only — its attention /
 *     working / governance interiors are NOT ours. So a peer renders an honest
 *     aggregate notice, never the local lanes.
 *   - DISPATCH is a GOVERN affordance: it renders ONLY for ADMIN posture
 *     (`isAdminPosture` via `selectedNetworkPosture`) on an OWN-LOCAL stack with a
 *     local agent present. Member/unknown posture ⇒ no dispatch button, an honest
 *     member note instead (no Leave button — invariant 16; CK-7 owns the full
 *     GOVERN bar + member footer). Fail-closed: absent the admin proof, no verb.
 *   - Dispatch reuses the FND-6-gated `POST /api/sessions` path through the host's
 *     `onDispatchDirect` (App owns the call + identity context) — never a bypass.
 *
 * The mockup's on-screen posture word is the deprecated pre-migration term; this
 * cockpit renders **admin / member** only.
 */

import { AttentionView } from "./attention-view";
import { WorkingGrid } from "./working-grid";
import { WorkingAggregate } from "./working-aggregate";
import { GovernanceView } from "./governance-view";
import { DispatchButton } from "./dispatch-button";
import {
  scopeAttention,
  scopeWorkingTiles,
  scopeGovernance,
  cockpitDispatchAgent,
} from "../lib/mc-cockpit-scope";
import { stackLabel, type StackCoord, type NetworkPosture } from "../lib/mc-shell-model";
import type { AgentPresenceTile } from "../hooks/use-agents";
import type { WorkingAgentTile } from "../hooks/use-working-agents";
import type { WorkingStackAggregate } from "../hooks/use-working-aggregation";
import type { AttentionEntry } from "../../api/attention";
import type { GovernanceState } from "../hooks/use-governance";
import "./mc-cockpit.css";

export interface McCockpitProps {
  /** The dived stack (STACK level or deeper). The cockpit is scoped to it. */
  stack: StackCoord;
  /** Posture toward the selected network (`null` at the root / no network). */
  posture: NetworkPosture | null;
  /** Serving principal — classifies own-local vs federated for the dispatch pick. */
  servingPrincipal: string | null;
  /** Live presence agents (whole-dashboard) — scoped to the stack for dispatch. */
  presenceAgents: readonly AgentPresenceTile[];
  /** Working-agents snapshot (whole-dashboard) — scoped to the stack. */
  workingAgents: readonly WorkingAgentTile[];
  workingLoaded: boolean;
  workingError: string | null;
  /**
   * CK-4b (cortex#1295) — the cross-stack WORKING rollup: one METADATA tile per
   * origin stack (ADR-0005 metadata-only), rendered as the "Across stacks"
   * pane-of-glass lane ABOVE the LOCAL, drillable `WorkingGrid`. Optional so a
   * caller that doesn't wire the feed simply omits the lane (the hook lives at
   * App level, mirroring `workingAgents`). Own-local render only — a federated
   * peer bottoms out at the aggregate notice before this lane.
   */
  workingAggregation?: readonly WorkingStackAggregate[];
  workingAggregationLoaded?: boolean;
  workingAggregationError?: string | null;
  /** Attention queue (whole-dashboard) — scoped to the stack. */
  attention: readonly AttentionEntry[];
  attentionLoaded: boolean;
  /** Governance audit (whole-dashboard) — scoped to the stack. */
  governance: GovernanceState;
  /** Open the F-7 drill-down overlay (working tile / attention session link). */
  onOpenDrill: (assignmentId: string) => void;
  /** Open the work-item-detail surface (attention work-item deep link). */
  onOpenWorkItem?: (workItemId: string) => void;
  /**
   * Dispatch DIRECTLY to a local agent via the FND-6-gated `/api/sessions` path
   * (App owns the call + identity context). Admin-posture + own-local only.
   */
  onDispatchDirect?: (agent: AgentPresenceTile) => void;
  /** Agent keys with an in-flight dispatch (busy state for the button). */
  dispatchingAgentKeys?: ReadonlySet<string>;
}

export function McCockpit({
  stack,
  posture,
  servingPrincipal,
  presenceAgents,
  workingAgents,
  workingLoaded,
  workingError,
  workingAggregation = [],
  workingAggregationLoaded = false,
  workingAggregationError = null,
  attention,
  attentionLoaded,
  governance,
  onOpenDrill,
  onOpenWorkItem,
  onDispatchDirect,
  dispatchingAgentKeys,
}: McCockpitProps) {
  // A federated peer is AGGREGATE-ONLY (ADR-0005) — none of the local operational
  // lanes are ours to render. Show the honest boundary instead.
  if (stack.federated) {
    return (
      <div className="mc-cockpit mc-cockpit--peer" aria-label="stack cockpit">
        <PeerAggregateNotice stack={stack} />
      </div>
    );
  }

  const scopedAttention = scopeAttention(attention, stack);
  const scopedWorking = scopeWorkingTiles(workingAgents, stack);
  const scopedGovernance: GovernanceState = {
    ...governance,
    data: governance.data ? scopeGovernance(governance.data, stack) : null,
  };

  const isAdmin = posture === "admin";
  const dispatchTarget = cockpitDispatchAgent(presenceAgents, stack, servingPrincipal);

  return (
    <div className="mc-cockpit" aria-label="stack cockpit">
      {/* ── ATTENTION — who needs me, on this stack ─────────────────────────── */}
      <section className="mc-cockpit-lane" aria-label="Attention (stack)">
        <AttentionView
          entries={scopedAttention}
          loaded={attentionLoaded}
          {...(onOpenWorkItem ? { onOpenWorkItem } : {})}
          onOpenAssignment={onOpenDrill}
        />
      </section>

      {/* ── WORKING — whose hands are working, on this stack ────────────────── */}
      <section className="mc-cockpit-lane" aria-label="Working (stack)">
        {/* CK-4b — the cross-stack "Across stacks" pane-of-glass rollup
            (metadata-only, ADR-0005) sits ABOVE the LOCAL, drillable grid. */}
        <WorkingAggregate
          aggregates={workingAggregation}
          loaded={workingAggregationLoaded}
          error={workingAggregationError}
        />
        <WorkingGrid
          agents={scopedWorking}
          loaded={workingLoaded}
          error={workingError}
          // focusItemCount 0 keeps the lane always-present (never the "hide when a
          // focus row exists" branch — the cockpit lane is not the focus row).
          focusItemCount={0}
          drillOpen={false}
          onOpen={onOpenDrill}
        />
      </section>

      {/* ── GOVERN — read-only audit + the posture-gated DISPATCH verb ──────── */}
      <section className="mc-cockpit-lane mc-cockpit-govern" aria-label="Govern (stack)">
        <div className="mc-cockpit-lane-head">
          <span className="mc-cockpit-lane-title">GOVERN</span>
        </div>

        <GovernanceView state={scopedGovernance} />

        <div className="mc-cockpit-dispatch">
          {isAdmin ? (
            dispatchTarget && onDispatchDirect ? (
              <div className="mc-cockpit-dispatch-row">
                <span className="mc-cockpit-dispatch-label">
                  Dispatch to <strong>{dispatchTarget.label}</strong>
                </span>
                <DispatchButton
                  agentLabel={dispatchTarget.label}
                  busy={dispatchingAgentKeys?.has(dispatchTarget.tile.key) ?? false}
                  onConfirm={() => onDispatchDirect(dispatchTarget.tile)}
                  className="mc-cockpit-dispatch-btn"
                />
              </div>
            ) : (
              <p className="mc-cockpit-note dim">
                No local agent online to dispatch to on this stack.
              </p>
            )
          ) : (
            <MemberGovernNote posture={posture} />
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * The member-posture govern note. Govern verbs (admission, keys, dispatch) are the
 * network admin's — a member observes. Leave is deliberately NOT a button (it is
 * CLI-only by design, invariant 16); CK-7 owns the fuller member footer.
 */
function MemberGovernNote({ posture }: { posture: NetworkPosture | null }) {
  return (
    <p className="mc-cockpit-note dim">
      {posture === "member"
        ? "You participate in this network — admission, keys, and dispatch are the network admin's."
        : "Govern verbs are the network admin's."}
    </p>
  );
}

/**
 * The federated-peer aggregate notice. Across the sovereignty boundary (ADR-0005)
 * a peer's attention / working / governance interiors are not ours — only the
 * aggregate face (rendered by the CK-2 stack header). The cockpit says so honestly
 * rather than showing empty local lanes.
 */
function PeerAggregateNotice({ stack }: { stack: StackCoord }) {
  return (
    <div className="mc-cockpit-peer-notice">
      <div className="mc-cockpit-lane-head">
        <span className="mc-cockpit-lane-title">AGGREGATE ONLY</span>
      </div>
      <p className="mc-cockpit-note dim">
        <strong>{stackLabel(stack)}</strong> is a federated peer. Its attention,
        working sessions, and governance audit stay on its own Mission Control —
        the sovereignty boundary (ADR-0005) exposes aggregate metadata here, never a
        peer&rsquo;s operational interiors.
      </p>
    </div>
  );
}
