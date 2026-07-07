/**
 * CK-2 (cortex#1289, plan-mc-future-state §4.A) — the stack-detail COCKPIT HEADER
 * model (pure, DOM-free).
 *
 * When the altitude rail is dived into a stack (STACK level or deeper), the
 * cockpit renders a header — the mockup's `◉ <stack> · LOCAL STACK` — carrying the
 * stack's rolled-up capability set, its presence counts, and a transport-verdict
 * chip. This module owns the derivations behind it so they're unit-testable
 * without a DOM (the D.1-3 pure/wrapper discipline the rest of the constellation
 * skin follows). Three things are derived:
 *
 *   1. **capability ROLLUP** — the union of every on-stack agent's declared
 *      capabilities, deduped in first-seen order. Computed by REUSING the existing
 *      {@link buildCapabilityMatchIndex} (built over just the on-stack agents,
 *      whose `allCapabilities()` IS that union) — CK-2 invents no parallel dedup.
 *   2. **LOCAL vs PEER variant** — `stack.federated` decides. A federated peer is
 *      AGGREGATE-ONLY (ADR-0005): the header shows rolled-up capabilities +
 *      presence counts, never a per-session interior (CK-1 already bars SESSION
 *      altitude for a peer; this header is the aggregate face of that boundary).
 *   3. **transport-verdict chip** — signal's verdict for `{principal}/{stack}`
 *      taken VERBATIM via {@link verdictBadge} (label + severity), or an honest
 *      `unobserved` when signal has no row for the stack. NEVER default-green.
 *
 * ## Verdicts stay VERBATIM (CONTEXT.md §Sourced-from-signal)
 *
 * The chip NEVER re-derives a verdict. It reads the {@link TransportOverlay}
 * already folded from signal's `system.transport.*` envelopes
 * (`network-transport-overlay.ts`) and maps the verbatim verdict string to its
 * severity through the canonical {@link verdictBadge} — the SAME single source of
 * truth the hub badge and the OBS-2 health fold use. A stack with no overlay row
 * folds to `unobserved` (signal dark), which the component renders visually
 * distinct from any observed verdict — never a fabricated green or red.
 */

import type { AgentPresenceTile } from "../hooks/use-agents";
import { buildCapabilityMatchIndex } from "./capability-match";
import { stackCoordFromTile } from "./mc-dive";
import { stackLabel, type StackCoord } from "./mc-shell-model";
import {
  overlayForStack,
  verdictBadge,
  type TransportOverlay,
  type VerdictBadge,
} from "./network-transport-overlay";

/** LOCAL (own) stack vs a FEDERATED peer (aggregate-only, ADR-0005). */
export type StackVariant = "local" | "peer";

/** The variant a dived stack renders as: `peer` iff it is federated. */
export function stackVariant(stack: StackCoord): StackVariant {
  return stack.federated ? "peer" : "local";
}

/**
 * The agents that live ON the dived stack. Resolves each tile to its owning stack
 * via {@link stackCoordFromTile} — the SAME resolution the dive gesture uses — and
 * keeps the ones whose `{principal}/{stack}` matches. Origin-blind beyond that: a
 * same-principal sibling and a federated peer are both matched purely on their
 * resolved coordinate, so the rollup is correct for a dived peer as well as a
 * local stack.
 */
export function agentsOnStack(
  agents: readonly AgentPresenceTile[],
  stack: StackCoord,
  servingPrincipal: string | null,
): AgentPresenceTile[] {
  return agents.filter((a) => {
    const coord = stackCoordFromTile(a, servingPrincipal);
    return coord.principal === stack.principal && coord.stack === stack.stack;
  });
}

/**
 * Roll up the on-stack agents' declared capabilities into the stack's capability
 * set — the deduped union in first-seen order. Reuses {@link buildCapabilityMatchIndex}
 * (its `allCapabilities()` is exactly this union) so the ordering + dedup match the
 * hover-highlight index the canvas already uses; CK-2 adds no parallel path.
 */
export function stackCapabilities(
  onStack: readonly AgentPresenceTile[],
): readonly string[] {
  const index = buildCapabilityMatchIndex(
    onStack.map((a) => ({
      key: a.key,
      capabilities: a.capabilities,
      origin: a.origin,
    })),
    [],
  );
  return index.allCapabilities();
}

/** Online / total presence counts — the aggregate the peer variant leans on. */
export interface StackPresence {
  online: number;
  total: number;
}

/** Count online-vs-total for the on-stack agents. */
export function stackPresence(
  onStack: readonly AgentPresenceTile[],
): StackPresence {
  let online = 0;
  for (const a of onStack) if (a.state === "online") online += 1;
  return { online, total: onStack.length };
}

/**
 * The transport-verdict chip state. `observed` carries signal's VERBATIM verdict
 * badge (label + severity + tooltip) plus the single-vantage leaf RTT; the absent
 * case is the honest `unobserved` — signal has no verdict for this stack, which is
 * NOT a health claim (never a fabricated green/red).
 */
export type StackVerdictChip =
  | { observed: true; badge: VerdictBadge; rttMs: number | null }
  | { observed: false };

/**
 * Resolve the verdict chip for a dived stack: look the stack up in the transport
 * overlay by `{principal}/{stack}`; a hit maps the VERBATIM verdict to its badge
 * (via {@link verdictBadge}), a miss is `unobserved`. Reads the overlay verbatim —
 * this function never re-derives a verdict.
 */
export function stackVerdictChip(
  overlay: TransportOverlay,
  stack: StackCoord,
): StackVerdictChip {
  const row = overlayForStack(overlay, stack.principal, stack.stack);
  if (row === null) return { observed: false };
  return { observed: true, badge: verdictBadge(row.verdict), rttMs: row.rttMs };
}

/** The full cockpit-header model the `McStackHeader` component renders. */
export interface StackHeaderModel {
  /** The dived stack coordinate (carried through for keying / tests). */
  stack: StackCoord;
  /** `{stack}` for own-local, `{principal}/{stack}` for a federated peer. */
  label: string;
  /** LOCAL vs PEER (aggregate-only). */
  variant: StackVariant;
  /** Rolled-up capability set (deduped, first-seen order). */
  capabilities: readonly string[];
  /** Online / total presence counts. */
  presence: StackPresence;
  /** The transport-verdict chip (verbatim or honest unobserved). */
  verdict: StackVerdictChip;
}

/**
 * Build the cockpit-header model for a dived stack from the live agent snapshot +
 * the transport overlay. Pure; safe to memoize on the snapshot + selection +
 * overlay. The overlay passed in should be the FULL fold of signal's roster (not a
 * render-lens-gated one), so the verdict chip is honest even when the canvas
 * transport-overlay toggle is off.
 */
export function buildStackHeader(
  agents: readonly AgentPresenceTile[],
  stack: StackCoord,
  overlay: TransportOverlay,
  servingPrincipal: string | null,
): StackHeaderModel {
  const onStack = agentsOnStack(agents, stack, servingPrincipal);
  return {
    stack,
    label: stackLabel(stack),
    variant: stackVariant(stack),
    capabilities: stackCapabilities(onStack),
    presence: stackPresence(onStack),
    verdict: stackVerdictChip(overlay, stack),
  };
}
