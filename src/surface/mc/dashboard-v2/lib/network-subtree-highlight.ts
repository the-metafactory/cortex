/**
 * #1068 — highlight-subtree on stack-hub select (pure logic).
 *
 * Selecting a STACK-HUB highlights its whole subtree — the hub, every agent
 * grouped under it, and the hub→agent edges wiring them — while everything else
 * dims. This is the DECISION ("given a selected hub, which ids light up?"); the
 * interaction (click/keyboard → set/toggle selection, the React context that
 * broadcasts it) is thin wiring. The decision is pure + unit-testable without a
 * DOM, exactly like the capability-hover highlight (`capability-highlight.ts`)
 * it sits beside.
 *
 * The selection is a STICKY sibling of hover: hover is transient (mouse
 * enter/leave), selection persists until the principal clicks the hub again or
 * clicks empty canvas. Both feed the SAME visual machinery (emphasize the lit
 * set, dim the rest), so a node/edge asks one question — "am I in the active
 * highlight set?" — regardless of which produced it.
 *
 * ## What the set contains
 *
 * `subtreeHighlightSet(graph, hubId)` returns the SET of element ids to light:
 *   - the hub's own node id;
 *   - every AGENT node id whose hub→agent edge originates at the hub (so the set
 *     is computed off the EDGES — the adapter wires each agent to ITS OWN stack's
 *     hub, local/sibling/foreign alike, so a foreign hub lights only ITS agents);
 *   - every hub→agent EDGE id originating at the hub.
 *
 * An unknown / non-hub id → an EMPTY set (nothing to highlight — the caller
 * treats that as "no selection", so the graph reads normally).
 */

import type { NetworkGraph } from "./network-graph-adapter";

/**
 * Compute the set of node + edge ids in `hubId`'s subtree (the hub + its agents
 * + the hub→agent edges). Deterministic: depends only on the graph's edge wiring.
 *
 * Off the EDGES (not the nodes' origin) so it composes with the adapter's
 * grouping verbatim — whatever agents the adapter wired to this hub are exactly
 * the subtree, no re-derivation of origin grouping here. A hub with no agents
 * yields `{hubId}` alone; an id that names no hub→agent edge source yields `∅`.
 */
export function subtreeHighlightSet(
  graph: NetworkGraph,
  hubId: string,
): Set<string> {
  const set = new Set<string>();
  // Only a real node may anchor a subtree; an unknown id lights nothing.
  if (!graph.nodes.some((n) => n.id === hubId)) return set;
  set.add(hubId);
  for (const edge of graph.edges) {
    if (edge.source !== hubId) continue;
    set.add(edge.id); // the hub→agent edge
    set.add(edge.target); // the agent node it points at
  }
  return set;
}

/**
 * The view's hub-selection state: the selected hub id (or `null` when nothing is
 * selected) plus the derived highlight set. Kept together so the canvas can both
 * stamp `aria-pressed`/`data-selected` on the right hub AND dim/emphasize by id.
 */
export interface SubtreeSelection {
  /** The currently-selected stack-hub id, or `null` when nothing is selected. */
  selectedHubId: string | null;
  /**
   * The ids (hub + its agents + its edges) to EMPHASIZE; everything else dims.
   * Empty when nothing is selected (the resting state — no dimming).
   */
  highlightIds: ReadonlySet<string>;
}

/** Shared resting-state selection — nothing selected, nothing highlighted. */
export const EMPTY_SUBTREE_SELECTION: SubtreeSelection = Object.freeze({
  selectedHubId: null,
  highlightIds: new Set<string>(),
});

/**
 * Toggle hub selection: clicking the ALREADY-selected hub clears it; clicking a
 * DIFFERENT hub selects that one. Pure — `(prev, clickedHubId, graph) → next`.
 *
 * Passing `null` for `clickedHubId` (e.g. empty-canvas click, or a click that
 * resolved to a non-hub) clears the selection. The next selection's highlight set
 * is computed eagerly so the canvas reads it directly.
 */
export function toggleHubSelection(
  prev: SubtreeSelection,
  clickedHubId: string | null,
  graph: NetworkGraph,
): SubtreeSelection {
  if (clickedHubId === null || clickedHubId === prev.selectedHubId) {
    return EMPTY_SUBTREE_SELECTION;
  }
  return {
    selectedHubId: clickedHubId,
    highlightIds: subtreeHighlightSet(graph, clickedHubId),
  };
}

/**
 * O(1): is this element (node or edge id) in the active subtree highlight?
 *
 * When NOTHING is selected (`highlightIds` empty) returns `false` for everything
 * — the caller reads that as "no selection", so it neither emphasizes nor dims.
 */
export function isInSubtreeHighlight(
  selection: SubtreeSelection,
  id: string,
): boolean {
  return selection.highlightIds.has(id);
}

/**
 * Is a subtree selection ACTIVE (something selected)? Drives the dim-the-rest
 * behavior: only dim non-highlighted elements when a selection exists, so the
 * resting graph (no selection) is never dimmed.
 */
export function hasSubtreeSelection(selection: SubtreeSelection): boolean {
  return selection.selectedHubId !== null;
}
