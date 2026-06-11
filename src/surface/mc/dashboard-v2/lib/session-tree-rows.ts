/**
 * ST-P5 — tree → flat-render-rows helper for the working grid.
 *
 * The working grid renders the session forest as an indented list. React maps
 * cleanly over a FLAT array, so this pure helper walks the recursive
 * {@link SessionTreeNode} forest depth-first and emits only the rows currently
 * VISIBLE for a given expansion state. Per D5 (docs/refactor-mc-session-tree.md
 * §3) the default is COLLAPSED: a node's children are emitted only when the
 * node's `session_id` is present in the `expanded` Set.
 *
 * PURE + DOM-free so expansion logic is unit-testable without a renderer
 * (`__tests__/session-tree-rows.test.ts`). The component owns the `expanded`
 * Set as local state keyed by `session_id` (D5) so it survives poll refreshes.
 */

import type { SessionTreeNode } from "../hooks/use-working-agents";

/** One visible row in the flattened tree render. */
export interface SessionTreeRow {
  /** The session this row renders. */
  node: SessionTreeNode;
  /** Nesting depth — 0 for roots, +1 per level. Drives the indent. */
  depth: number;
  /** Whether this node has any child sessions (drives the expander). */
  hasChildren: boolean;
  /** Whether this node is currently expanded (only meaningful if hasChildren). */
  isExpanded: boolean;
  /** Number of DIRECT children — shown in the collapsed child-count badge. */
  childCount: number;
}

/**
 * Defense-in-depth recursion cap. Mirrors the assembler's MAX_TREE_DEPTH
 * (`src/surface/mc/lib/session-tree.ts`): even though the forest is already
 * cycle-broken upstream, the flatten walk caps depth so a pathological tree can
 * never blow the stack on the render path.
 */
const MAX_RENDER_DEPTH = 64;

/**
 * Flatten a session forest into the visible render rows for `expanded`.
 *
 * @param forest    root session nodes (an agent's session tree)
 * @param expanded  Set of `session_id`s whose children should be shown
 */
export function flattenSessionTree(
  forest: SessionTreeNode[],
  expanded: ReadonlySet<string>
): SessionTreeRow[] {
  const rows: SessionTreeRow[] = [];

  function walk(nodes: SessionTreeNode[], depth: number): void {
    if (depth > MAX_RENDER_DEPTH) return;
    for (const node of nodes) {
      const childCount = node.children.length;
      const hasChildren = childCount > 0;
      // A leaf is never "expanded" — there is nothing to expand. Only a node
      // with children reports its expansion state.
      const isExpanded = hasChildren && expanded.has(node.session_id);
      rows.push({ node, depth, hasChildren, isExpanded, childCount });
      if (isExpanded) walk(node.children, depth + 1);
    }
  }

  walk(forest, 0);
  return rows;
}

/**
 * Toggle a session's expansion in an immutable, copy-on-write fashion — returns
 * a NEW Set so React state updates trigger a re-render. The grid keeps the
 * expansion Set as local state keyed by `session_id` (D5); because the key is
 * the stable `session_id`, expansion survives poll refreshes (a refetch that
 * re-supplies the same session keeps its row expanded).
 */
export function toggleExpanded(
  expanded: ReadonlySet<string>,
  sessionId: string
): Set<string> {
  const next = new Set(expanded);
  if (next.has(sessionId)) next.delete(sessionId);
  else next.add(sessionId);
  return next;
}
