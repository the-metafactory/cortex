/**
 * CK-3 (cortex#1289) — pure re-scoping for the **right-panel cockpit**.
 *
 * The cockpit folds the four legacy standalone surfaces (ATTENTION / WORKING /
 * GOVERN / DISPATCH) into a stack-scoped panel inside `.mc-skin`. The legacy
 * surfaces were WHOLE-DASHBOARD; the cockpit is scoped to the DIVED stack
 * (`AltitudeSelection.stack`). This module is the DOM-free, I/O-free projection
 * that turns the app-scope snapshots (already fetched once + WS-kept-fresh — the
 * "single snapshot subscription" CK-3 replaces fetch-on-tab-visible with) into
 * the per-stack view the folded components render.
 *
 * ## Sovereignty boundary (ADR-0005)
 *
 * ATTENTION / WORKING / GOVERN are LOCAL operational surfaces. Across the
 * federation boundary a peer principal's stacks expose AGGREGATE metadata only —
 * never their attention queue, session interiors, or governance audit. So the
 * scoping functions here are only ever called for an OWN-LOCAL stack
 * (`stack.federated === false`); the cockpit renders a peer as an honest
 * aggregate notice instead of calling them (see `mc-cockpit.tsx`). The functions
 * still fail-closed on a federated coord (empty) as defense in depth.
 *
 * ## The list-cap caveat (governance)
 *
 * `/api/governance` returns capped row lists (`GOVERNANCE_LIST_CAP`) plus SQL
 * window aggregates that are NOT re-derivable client-side. So `scopeGovernance`
 * filters the capped rows to the stack and RE-DERIVES the summary/alarm FROM the
 * filtered rows — honest at the row level (the numbers match the rows shown), a
 * recent-window view rather than the full-window aggregate. A precise per-stack
 * window aggregate is a server-side filter (deferred; not CK-3). The reused
 * `GovernanceView` empty-state copy already carries "absence is not an all-clear".
 */

import type { StackCoord } from "./mc-shell-model";
import { stackCoordFromTile } from "./mc-dive";
import type { AgentPresenceTile } from "../hooks/use-agents";
import type { WorkingAgentTile } from "../hooks/use-working-agents";
import type { AttentionEntry } from "../../api/attention";
import type { GovernanceResponse } from "../../api/governance";
import type {
  GovernanceLayer,
  GovernanceSummary,
  GovernanceVerdictRow,
  GovernanceDenialRow,
  GovernanceDenialSummary,
} from "../../db/governance";

/** Seconds in a day — the 24h alarm window uses one day. */
const DAY_SECONDS = 86_400;

/**
 * Whether a working tile belongs to the dived stack. Mirrors the CK-1 rail
 * semantics (`mc-dive.tileMatchesStack`): a `"local"`-origin tile is the serving
 * stack's own projection (own-local by construction), a sibling-tagged tile must
 * match the dived `{principal, stack}` exactly. Cross-sibling precision is CK-4a's
 * schema-origin work — this stays row-honest for CK-3.
 */
function tileOnStack(tile: WorkingAgentTile, stack: StackCoord): boolean {
  const origin = tile.origin ?? "local";
  if (origin === "local") return true;
  return origin.principal === stack.principal && origin.stack === stack.stack;
}

/**
 * The working tiles on the dived stack. Own-local only: a federated coord returns
 * empty (defense in depth — the cockpit never calls this for a peer).
 */
export function scopeWorkingTiles(
  tiles: readonly WorkingAgentTile[],
  stack: StackCoord,
): WorkingAgentTile[] {
  if (stack.federated) return [];
  return tiles.filter((t) => tileOnStack(t, stack));
}

/**
 * The attention entries for the dived stack. `AttentionItem.stackId` carries the
 * owning stack (multi-stack federation), so we filter on it — this is what lets a
 * pane-of-glass aggregation (sibling stacks' items merged) narrow to the one the
 * principal dived into. Own-local only (a federated coord returns empty).
 */
export function scopeAttention(
  entries: readonly AttentionEntry[],
  stack: StackCoord,
): AttentionEntry[] {
  if (stack.federated) return [];
  return entries.filter((e) => e.item.stackId === stack.stack);
}

/** Does a governance row (verdict or denial) attribute to the dived stack? */
function rowOnStack(
  principal: string | null,
  rowStack: string | null,
  stack: StackCoord,
): boolean {
  // A row with no stack tag is not attributable to any single stack — exclude it
  // from a stack-scoped view (it still shows in the whole-dashboard `?legacy=1`
  // governance tab). Principal, when present, must also match.
  if (rowStack === null || rowStack !== stack.stack) return false;
  if (principal !== null && principal !== stack.principal) return false;
  return true;
}

/** Is this verdict row a "denial" for alarm purposes (mirrors summarizeGovernance)? */
function verdictIsDenial(v: GovernanceVerdictRow): boolean {
  return v.layer === "resolved"
    ? v.decision === "deny"
    : v.decision === "deny" || v.decision === "fail";
}

/**
 * Re-derive the deterministic alarm tier from a combined 24h denial count. Inlined
 * (NOT imported from `api/governance`) so this browser-bundle module never pulls in
 * that file's `bun:sqlite` value dependencies — mirrors `alarmFor` exactly.
 */
function deriveAlarm(denials24h: number): GovernanceResponse["alarm"] {
  const tier =
    denials24h === 0 ? "none" : denials24h < 5 ? "elevated" : "high";
  const note =
    tier === "none"
      ? "0 denials in the last 24h (window measured: 24h — absence of denials is not absence of risk)"
      : `${denials24h} denial${denials24h === 1 ? "" : "s"} in the last 24h (verdict denials + access denials/refusals)`;
  return { tier, denials24h, note };
}

/**
 * Re-scope the governance response to the dived stack. Filters the capped verdict
 * + denial rows to the stack and RE-DERIVES `summary`/`denialSummary`/`alarm` from
 * the filtered rows (honest at the row level — see the module header caveat).
 *
 * `nowSec` is injectable for deterministic tests; it defaults to wall-clock. A
 * federated coord returns an empty-but-shaped response (defense in depth).
 */
export function scopeGovernance(
  data: GovernanceResponse,
  stack: StackCoord,
  nowSec: number = Math.floor(Date.now() / 1000),
): GovernanceResponse {
  const cutoff24h = nowSec - DAY_SECONDS;
  const federated = stack.federated;

  const verdicts: GovernanceVerdictRow[] = federated
    ? []
    : data.verdicts.filter((v) => rowOnStack(v.principal, v.stack, stack));
  const denials: GovernanceDenialRow[] = federated
    ? []
    : data.denials.filter((d) => rowOnStack(d.principal, d.stack, stack));

  const byLayer: Record<GovernanceLayer, number> = {
    l0: 0,
    tribunal: 0,
    gate: 0,
    resolved: 0,
  };
  let allows = 0;
  let vDenials = 0;
  let defers = 0;
  let vDenials24h = 0;
  for (const v of verdicts) {
    byLayer[v.layer] += 1;
    if (v.layer === "resolved") {
      if (v.decision === "allow") allows += 1;
      else if (v.decision === "deny") vDenials += 1;
      else if (v.decision === "defer") defers += 1;
    }
    if (verdictIsDenial(v) && v.createdAt >= cutoff24h) vDenials24h += 1;
  }
  const summary: GovernanceSummary = {
    total: verdicts.length,
    allows,
    denials: vDenials,
    defers,
    byLayer,
    denials24h: vDenials24h,
  };

  const byReasonKind: Record<string, number> = {};
  let refusals = 0;
  let dDenials24h = 0;
  for (const d of denials) {
    byReasonKind[d.reasonKind] = (byReasonKind[d.reasonKind] ?? 0) + 1;
    if (d.isRefusal) refusals += 1;
    if (d.createdAt >= cutoff24h) dDenials24h += 1;
  }
  const denialSummary: GovernanceDenialSummary = {
    total: denials.length,
    refusals,
    otherDenials: denials.length - refusals,
    byReasonKind,
    denials24h: dDenials24h,
  };

  return {
    verdicts,
    summary,
    denials,
    denialSummary,
    alarm: deriveAlarm(summary.denials24h + denialSummary.denials24h),
    windowDays: data.windowDays,
    listCap: data.listCap,
  };
}

/** The stack-scoped dispatch target — a local agent + its display label. */
export interface CockpitDispatchAgent {
  tile: AgentPresenceTile;
  label: string;
}

/**
 * Pick the dispatch target for the dived stack's GOVERN lane: a LOCAL
 * (non-federated) presence agent on the stack, preferring an `online` one. Dispatch
 * is local-only (ADR-0005 / CK-4a boundary — dispatch-to-peer is FLG-10), so a
 * federated coord — or a stack with no local presence agent — yields `null` and the
 * affordance renders disabled/absent (honest, never a dead button).
 */
export function cockpitDispatchAgent(
  agents: readonly AgentPresenceTile[],
  stack: StackCoord,
  servingPrincipal: string | null,
): CockpitDispatchAgent | null {
  if (stack.federated) return null;
  const onStack = agents.filter((a) => {
    const coord = stackCoordFromTile(a, servingPrincipal);
    return (
      !coord.federated &&
      coord.principal === stack.principal &&
      coord.stack === stack.stack
    );
  });
  const chosen = onStack.find((a) => a.state === "online") ?? onStack[0];
  if (!chosen) return null;
  return { tile: chosen, label: chosen.assistant_name ?? chosen.agent_id };
}
