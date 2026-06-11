/**
 * Pure session-tree assembly — CLOUD (CF Worker) copy (ST-P4).
 *
 * ⚠️ BYTE-FOR-BYTE DUPLICATE of `src/surface/mc/lib/session-tree.ts` (the local
 * copy). The two are kept identical on purpose; do NOT let them drift. The
 * shared-fixture test `src/surface/mc/__tests__/session-tree-shared-fixture.test.ts`
 * runs the SAME input through BOTH copies and asserts identical output — it
 * fails CI if they diverge.
 *
 * Why a duplicate and not an import: the CF Worker (`worker/`) is a separate
 * package with its own `tsconfig` and bundle boundary; importing the local
 * module would drag `bun:sqlite`-adjacent types into the worker bundle and
 * couple two independently-deployed artifacts. Per ST-P4 scope #3, the ~30-line
 * pure function is duplicated with this cross-link + the shared fixture, rather
 * than inventing a shared-package mechanism for one small function. When you
 * change one copy, change the other and keep the fixture green.
 */

export interface SessionTreeNode {
  session_id: string;
  parent_session_id: string | null;
  substrate: string;
  state: string;
  started_at: string;
  ended_at: string | null;
  agent_name?: string | null;
  task_title?: string | null;
  children: SessionTreeNode[];
}

export interface FlatSessionRow {
  session_id: string;
  parent_session_id: string | null;
  substrate: string;
  state: string;
  started_at: string;
  ended_at: string | null;
  agent_name?: string | null;
  task_title?: string | null;
}

const MAX_TREE_DEPTH = 64;

/**
 * Assemble a flat list of session rows into a {@link SessionTreeNode} forest.
 * See the local copy (`src/surface/mc/lib/session-tree.ts`) for the full rule
 * commentary — this is the byte-identical cloud duplicate.
 */
export function assembleSessionTree(rows: FlatSessionRow[]): SessionTreeNode[] {
  if (rows.length === 0) return [];

  const byId = new Map<string, SessionTreeNode>();
  for (const row of rows) {
    if (byId.has(row.session_id)) continue;
    byId.set(row.session_id, {
      session_id: row.session_id,
      parent_session_id: row.parent_session_id ?? null,
      substrate: row.substrate,
      state: row.state,
      started_at: row.started_at,
      ended_at: row.ended_at ?? null,
      agent_name: row.agent_name ?? null,
      task_title: row.task_title ?? null,
      children: [],
    });
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.parent_session_id;
    // A self-edge (`parent === self`) is NOT a valid parent → treat as a root,
    // breaking the trivial 1-cycle. Lookup yields undefined for a null /
    // out-of-set parent (the orphaned-parent case) → also a root.
    const parent =
      parentId !== null && parentId !== node.session_id
        ? byId.get(parentId)
        : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const reachable = new Set<string>();
  for (const root of roots) markReachable(root, reachable, 0);

  for (const node of byId.values()) {
    if (!reachable.has(node.session_id)) {
      detachFromParents(node, byId);
      node.parent_session_id = null;
      roots.push(node);
      markReachable(node, reachable, 0);
    }
  }

  return roots;
}

function markReachable(
  node: SessionTreeNode,
  reachable: Set<string>,
  depth: number
): void {
  if (depth > MAX_TREE_DEPTH) return;
  if (reachable.has(node.session_id)) return;
  reachable.add(node.session_id);
  for (const child of node.children) markReachable(child, reachable, depth + 1);
}

function detachFromParents(
  node: SessionTreeNode,
  byId: Map<string, SessionTreeNode>
): void {
  for (const candidate of byId.values()) {
    if (candidate === node) continue;
    const idx = candidate.children.indexOf(node);
    if (idx !== -1) candidate.children.splice(idx, 1);
  }
}
