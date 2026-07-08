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
import { GovernBar } from "./govern-bar";
import {
  scopeAttention,
  scopeWorkingTiles,
  scopeGovernance,
  cockpitDispatchAgent,
} from "../lib/mc-cockpit-scope";
import { stackLabel, type StackCoord, type NetworkPosture } from "../lib/mc-shell-model";
import type { NetworkMembershipDTO } from "../hooks/use-networks";
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
  /**
   * CK-7 (cortex#1673) — the dived network id, feeding the GOVERN bar's two
   * named banners (handoff + admission-request), the doctor drill, and the
   * member footer copy. `null` when no network is resolved.
   */
  networkId?: string | null;
  /**
   * CK-7 — the serving (local) principal: the handoff banner's member and the
   * member footer's "you". `null` ⇒ the handoff banner self-effaces.
   */
  localPrincipal?: string | null;
  /**
   * CK-7 — the dived network's membership DTO, when resolved. Feeds the GOVERN
   * bar's admin-authoritative gate (`isAdminPosture`) and the admission-request
   * count. `null` ⇒ the bar falls back to `posture` for the gate.
   */
  network?: NetworkMembershipDTO | null;
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
   * CK-6b — resolve/dismiss an attention item via the FND-6-gated CK-6a route
   * (`POST /api/attention/:id/{resolve,dismiss}`). App owns the call + identity
   * context (mirrors `onDispatchDirect`). Only wired on the own-local render path
   * below — a federated peer bottoms out at the aggregate notice, so its attention
   * interior (and these mutations) never render (ADR-0005). Approve/Deny is NOT
   * part of this contract (SPX-7/SPX-8, post-release).
   */
  onAttentionLifecycle?: (attentionId: string, action: "resolve" | "dismiss") => void;
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
  networkId = null,
  localPrincipal = null,
  network = null,
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
  onAttentionLifecycle,
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
          {...(onAttentionLifecycle ? { onLifecycle: onAttentionLifecycle } : {})}
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

      {/* ── GOVERN — read-only audit + the CK-7 posture-gated GOVERN bar shell ─ */}
      <section className="mc-cockpit-lane mc-cockpit-govern" aria-label="Govern (stack)">
        <div className="mc-cockpit-lane-head">
          <span className="mc-cockpit-lane-title">GOVERN</span>
        </div>

        <GovernanceView state={scopedGovernance} />

        {/* CK-7 (cortex#1673) — the GOVERN bar SHELL: the posture-gated verb rail
            (empty per-verb harness — NO verbs wired), the two named banners
            (handoff FLG-1 + admission-request), the doctor drill (FLG-3), and the
            member footer (participate + CLI-only Leave, invariant 16). Every admin
            affordance gates on the same admin-authoritative read the Pier queue
            uses (fail-closed). */}
        <GovernBar
          posture={posture}
          networkId={networkId}
          localPrincipal={localPrincipal}
          network={network}
        />

        {/* CK-3 — the one already-LIVE govern verb (direct dispatch), admin
            posture + own-local + a local agent present. The GOVERN bar's rail
            names a `dispatch` slot as `live`; THIS is the control it points at. */}
        {isAdmin ? (
          <div className="mc-cockpit-dispatch">
            {dispatchTarget && onDispatchDirect ? (
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
            )}
          </div>
        ) : null}
      </section>
    </div>
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
