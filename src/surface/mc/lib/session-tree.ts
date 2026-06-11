/**
 * Pure session-tree assembly (ST-P4, refactor docs/refactor-mc-session-tree.md §5).
 *
 * Folds a FLAT list of session rows (each carrying `parent_session_id`) into the
 * recursive {@link SessionTreeNode} forest the dashboard renders — the
 * `initiated-by` edge from CONTEXT.md §"Session tree" (a child session names the
 * session that spawned it; an agent-rooted session has none).
 *
 * This module is PURE (no DB, no I/O) so the tree shape is unit-testable in
 * isolation from either substrate's query layer. The local API
 * (`db/working-agents.ts`) and the cloud worker (`worker/src/lib/session-tree.ts`,
 * a byte-identical duplicate — see that file's header) both feed their fetched
 * rows through an algorithm with IDENTICAL behavior, asserted by the shared
 * fixture in `__tests__/session-tree-shared-fixture.test.ts`.
 *
 * ── Why the worker keeps a duplicate, not an import ──────────────────────────
 * The CF Worker (`worker/`) is a separate package with its own `tsconfig`,
 * `bun.lock`, and bundle boundary. Reaching across `src/surface/mc/` into the
 * worker (or vice versa) would couple two independently-deployed artifacts and
 * drag the local `bun:sqlite` types into the worker bundle. Per the task's
 * scope #3 carve-out, the ~30-line pure function is DUPLICATED with a header
 * cross-link + a shared-fixture test asserting the two copies behave identically
 * — no new shared-package mechanism is invented for one small function.
 */

/**
 * One node in the session tree (ST-P4). Lifecycle metadata ONLY — no session
 * interiors (ADR-0005: interiors are local-scope, never projected to the cloud
 * or cross-principal). `children` is the recursive forest of child sessions
 * (sessions whose `parent_session_id` names this node).
 */
export interface SessionTreeNode {
  session_id: string;
  /** Self-ref to the spawning session; null ⇒ agent-rooted (a tree root). */
  parent_session_id: string | null;
  /** The substrate this session runs on (claude-code | codex | …). */
  substrate: string;
  /**
   * Lifecycle state — the owning assignment's state on local
   * (running/dispatched/queued), or the session `status` on cloud. A display
   * string; the renderer derives badges from it.
   */
  state: string;
  /** Session start (ISO-8601). */
  started_at: string;
  /** Terminal timestamp (ISO-8601), or null while the session is open. */
  ended_at: string | null;
  /** Owning agent display name, when known (a session is NOT an agent). */
  agent_name?: string | null;
  /** Title of the work the session is doing, when known. */
  task_title?: string | null;
  /** Child sessions (recursive). Empty array for a leaf. */
  children: SessionTreeNode[];
}

/**
 * A flat session row — the minimum the tree assembler needs. Both substrates
 * project their query rows into this shape before folding.
 */
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

/**
 * Maximum tree depth walked when attaching children. A defense-in-depth cap so
 * a corrupt edge (a cycle the visited-set somehow missed, or a pathologically
 * deep legitimate tree) can never make the assembler loop unboundedly or blow
 * the stack. 64 is far deeper than any real agent's spawn tree (the overnight
 * backlog's deepest was single digits).
 */
const MAX_TREE_DEPTH = 64;

/**
 * Assemble a flat list of session rows into a {@link SessionTreeNode} forest.
 *
 * Rules (refactor §5, "the agent-keyed fold"):
 *   - Key every row by `session_id`; build one node per row.
 *   - A row whose `parent_session_id` names ANOTHER row in the SAME list is
 *     attached as that parent's child.
 *   - A row with `parent_session_id === null` is a ROOT.
 *   - **Orphaned parent ref** — a row whose parent is NOT in this list (the
 *     parent went terminal / was pruned / lives under a different agent) becomes
 *     a ROOT itself. It is NEVER dropped (a session must always render somewhere).
 *   - **Cycle-safe** — a corrupt self-edge (`parent === self`) or a loop
 *     (a→b→a) can never hang the assembler: a `visited` set during the recursive
 *     walk + the {@link MAX_TREE_DEPTH} cap break any cycle, and a node already
 *     claimed as a child is never also emitted as a root.
 *
 * Stable order: roots preserve input order; children preserve input order.
 */
export function assembleSessionTree(rows: FlatSessionRow[]): SessionTreeNode[] {
  if (rows.length === 0) return [];

  // 1. Build one node per row, keyed by session_id. A later duplicate
  //    session_id (should never happen — PK) is ignored; first wins.
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

  // 2. Decide each node's role: child of an in-set parent, or a root. A node is
  //    a child iff its parent_session_id names a DIFFERENT in-set node (a
  //    self-edge `parent === self` is NOT a valid parent → treated as a root,
  //    breaking the trivial 1-cycle). Everything else (null parent, or a parent
  //    ref absent from this set — the orphaned-parent case) is a root.
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

  // 3. Cycle guard: a multi-node loop (a→b→a, where both name each other) would
  //    leave NEITHER in rootIds, so the loop would be unreachable from any root
  //    and silently dropped — violating "never drop a session". Walk the forest
  //    from the known roots with a visited-set; any node never reached is part
  //    of a cycle and is re-promoted to a root (its in-cycle parent edge is
  //    severed for rendering). The visited-set + depth cap also make the walk
  //    itself terminate on any residual cycle.
  const reachable = new Set<string>();
  for (const root of roots) markReachable(root, reachable, 0);

  for (const node of byId.values()) {
    if (!reachable.has(node.session_id)) {
      // In-cycle node unreachable from any root → sever its parent edge: detach
      // it from whichever parent claimed it, then promote to root.
      detachFromParents(node, byId);
      node.parent_session_id = null;
      roots.push(node);
      markReachable(node, reachable, 0);
    }
  }

  return roots;
}

/** Mark a node + its descendants reachable, bounded by {@link MAX_TREE_DEPTH}. */
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

/** Remove `node` from every other node's `children` (cycle-break cleanup). */
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
