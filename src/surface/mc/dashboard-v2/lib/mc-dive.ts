/**
 * CK-1 (cortex#1289) — map a constellation click to an altitude coordinate.
 *
 * The Network view's canvas speaks in stack-hub nodes and agent tiles; the
 * altitude rail speaks in {@link StackCoord}s + session ids. This pure, DOM-free
 * module bridges the two so the two derivations that MOST need pinning — the
 * sovereignty bit (own-local vs federated) and the own-local session list — are
 * unit-testable without mounting the canvas.
 *
 * The federated bit is derived with the SAME `classifyOrigin`/`isLocalCategory`
 * the node cards + graph edges use, so "federated" means one thing everywhere:
 * self + same-principal sibling ⇒ own-local (`false`); a cross-principal peer ⇒
 * federated (`true`). SESSION altitude keys off it (ADR-0005).
 */

import type { AgentPresenceTile, AgentOrigin } from "../hooks/use-agents";
import type {
  SessionTreeNode,
  WorkingAgentTile,
} from "../hooks/use-working-agents";
import type { StackHubNodeData } from "./network-graph-adapter";
import { classifyOrigin, isLocalCategory } from "./agents-display";
import type { StackCoord } from "./mc-shell-model";

/**
 * Whether an origin is a FEDERATED peer (`true`) or OWN-LOCAL (`false`). Own-local
 * covers the serving stack (self) AND same-principal siblings (DB-read
 * aggregation) — both stay this side of the ADR-0005 boundary.
 */
export function isFederatedOrigin(
  origin: AgentOrigin,
  servingPrincipal: string | null,
): boolean {
  return !isLocalCategory(classifyOrigin(origin, servingPrincipal));
}

/** The `{principal}/{stack}` an origin resolves to (mirrors the hub-grouping key). */
function originScope(
  origin: AgentOrigin,
  fallbackPrincipal: string,
  fallbackStack: string,
): { principal: string; stack: string } {
  return origin === "local"
    ? { principal: fallbackPrincipal, stack: fallbackStack }
    : { principal: origin.principal, stack: origin.stack };
}

/**
 * A clicked stack-hub → its altitude {@link StackCoord}, or `null` when the hub
 * carries no resolvable `{principal}/{stack}` (e.g. a foreign-only snapshot's
 * local hub) — the caller then declines to dive rather than fabricate one.
 */
export function stackCoordFromHub(
  data: StackHubNodeData,
  servingPrincipal: string | null,
): StackCoord | null {
  if (data.principal === null || data.stack === null) return null;
  return {
    principal: data.principal,
    stack: data.stack,
    federated: isFederatedOrigin(data.origin, servingPrincipal),
  };
}

/** A clicked agent tile → its owning stack's altitude {@link StackCoord}. */
export function stackCoordFromTile(
  tile: AgentPresenceTile,
  servingPrincipal: string | null,
): StackCoord {
  const scope = originScope(tile.origin, tile.principal, tile.stack);
  return {
    principal: scope.principal,
    stack: scope.stack,
    federated: isFederatedOrigin(tile.origin, servingPrincipal),
  };
}

/** Does a working tile belong to the given (own-local) stack? */
function tileMatchesStack(tile: WorkingAgentTile, stack: StackCoord): boolean {
  const origin = tile.origin ?? "local";
  // A `"local"`-origin tile is the SERVING stack's own projection — own-local by
  // construction. A sibling-tagged tile must match the dived stack exactly.
  if (origin === "local") return true;
  return origin.principal === stack.principal && origin.stack === stack.stack;
}

/**
 * Flatten a selected OWN-LOCAL assistant's session tree into rail SESSION drill
 * targets (id + short label). Lifecycle metadata only (ADR-0005) — never an
 * interior. Empty when the assistant has no working tile on this stack.
 *
 * Scope note (CK-1): the working projection covers the SERVING stack (and, post
 * #1008/#1065, sibling-tagged tiles). A same-principal sibling stack whose
 * sessions aren't in this projection yields an honest empty list; cross-stack
 * session aggregation is CK-4a's schema-origin work, not fabricated here.
 */
export function sessionTargetsForAssistant(
  workingAgents: readonly WorkingAgentTile[],
  assistantId: string,
  stack: StackCoord,
): { id: string; label: string }[] {
  const tile = workingAgents.find(
    (w) => w.agent_id === assistantId && tileMatchesStack(w, stack),
  );
  if (!tile) return [];
  const out: { id: string; label: string }[] = [];
  const walk = (nodes: readonly SessionTreeNode[]): void => {
    for (const n of nodes) {
      out.push({ id: n.session_id, label: n.task_title ?? n.session_id });
      if (n.children.length > 0) walk(n.children);
    }
  };
  walk(tile.sessions);
  return out;
}
