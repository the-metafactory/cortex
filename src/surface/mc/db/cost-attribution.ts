/**
 * SES-1 / #1709 / decision D-16 — per-session token/cost + attribution read model
 * (LOCAL read model).
 *
 * The data half of Layout G's SESSIONS ledger ("every session runs on behalf of
 * an accountable human; spend rolls up"). This projects the token/cost usage the
 * `sessions` row already carries (`input_tokens` / `output_tokens` /
 * `cache_read_tokens` / `cost_usd`, populated on write) into a per-session cost +
 * attribution shape, with SUB-AGENT spend rolled UP to its initiating parent along
 * the `parent_session_id` edge. A plain projection — no new collection, no new
 * write path — the sibling of the CK-4a WORKING rollup (`db/working-aggregation.ts`).
 *
 * ── OWN-LOCAL ONLY (ADR-0005 — stated once, enforced by absence) ─────────────
 * Token counts, cost, and `attribution_target` are session INTERIORS in the
 * ADR-0005 sense: they describe what a session did and what it cost, not just
 * that it exists. This read model is therefore LOCAL-scope ONLY. It is NOT wired
 * into the public, unauthenticated `DashboardSnapshot` (`worker/src/routes/state.ts`)
 * / `/api/state` projection: the cross-stack boundary there carries CK-4a
 * METADATA only (per-origin active/sub-agent COUNTS — `WorkingOriginRollup`),
 * never a per-session cost or attribution interior. A FOREIGN (cross-stack) peer's
 * rows must never surface their token/cost/attribution here in a form that leaves
 * local scope. SES-2 (the ledger UI) consumes THIS model locally; if a future
 * slice ever surfaces any of these fields in the public DTO, that is a deliberate
 * decision made WHEN the DTO key is added + justified in
 * `worker/src/__tests__/dashboard-snapshot-contract.test.ts` — never a silent
 * pass-through (that test's `attribution_target` note records exactly this).
 *
 * ── Honest attribution (D-16) ───────────────────────────────────────────────
 *   - `forPrincipal` comes from the EXISTING session identity (`principal_id`,
 *     falling back to `home_principal`), NEVER inferred from repo/branch/heuristic.
 *     A session with neither is `null` — an honest "no principal on the row", never
 *     fabricated.
 *   - `attributionTarget` unset (NULL) renders as {@link UNATTRIBUTED} — an honest
 *     bucket, NEVER silently defaulted to a principal or project (D-16 honesty;
 *     plan-mc-future-state §6 invariant 20).
 */

import type { Database } from "bun:sqlite";

/**
 * The honest bucket a session with no `attribution_target` rolls up to. NEVER a
 * principal or project — an explicit "not yet attributed" (D-16). Exported so the
 * SES-2 ledger renderer and this model's tests share the one literal.
 */
export const UNATTRIBUTED = "unattributed" as const;

/**
 * Defense-in-depth cap on the rollup walk depth — a corrupt `parent_session_id`
 * edge (a cycle a visited-set somehow missed, or a pathologically deep tree) can
 * never make the rollup loop unboundedly or blow the stack. Mirrors the session
 * tree assembler's cap (`lib/session-tree.ts` MAX_TREE_DEPTH); real spawn trees
 * are single-digit deep.
 */
const MAX_ROLLUP_DEPTH = 64;

/**
 * One session's cost/attribution row. Own-local interior (see the header) — never
 * projected across the cross-stack boundary. `tokensIn` / `tokensOut` /
 * `cacheRead` / `cost` are the session's OWN usage; {@link SessionCostRow.rolledUp}
 * carries the parent-inclusive totals (own + all descendant sub-agents).
 */
export interface SessionCostRow {
  sessionId: string;
  /** Owning agent id, when known (a session is not an agent). NULL until synced. */
  agentId: string | null;
  /** Owning agent display name, when known. */
  agentName: string | null;
  /**
   * The accountable principal, from the EXISTING session identity
   * (`principal_id`, then `home_principal`). NEVER inferred. `null` ⇒ no principal
   * on the row (honest, never fabricated).
   */
  forPrincipal: string | null;
  /**
   * The controlled-vocab attribution target (repo/domain, D-16), or
   * {@link UNATTRIBUTED} when the column is NULL. NEVER defaulted to a principal.
   */
  attributionTarget: string;
  /** The substrate/model this session ran on (claude-code | codex | …). */
  substrate: string;
  /** `true` ⇒ this session is a SUB-AGENT (carries a `parent_session_id`). */
  isSubAgent: boolean;
  /** The initiating session, or `null` for an agent-rooted session. */
  parentSessionId: string | null;
  /** This session's OWN usage (excludes descendants). Zeroes when the row is unpopulated. */
  own: SessionUsage;
  /**
   * Parent-inclusive totals: this session's own usage PLUS every descendant
   * sub-agent's, rolled up the `parent_session_id` edge. For a leaf (no children)
   * this equals {@link SessionCostRow.own}.
   */
  rolledUp: SessionUsage;
}

/** A token/cost tuple. All fields are non-negative; a NULL column reads as 0. */
export interface SessionUsage {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cost: number;
}

/** The `sessions` columns this read model projects. */
interface CostRow {
  id: string;
  agent_id: string | null;
  agent_name: string | null;
  principal_id: string | null;
  home_principal: string | null;
  attribution_target: string | null;
  substrate: string;
  parent_session_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
}

/** A NULL usage column reads as an honest 0, never a fabricated estimate. */
function usageOf(row: CostRow): SessionUsage {
  return {
    tokensIn: row.input_tokens ?? 0,
    tokensOut: row.output_tokens ?? 0,
    cacheRead: row.cache_read_tokens ?? 0,
    cost: row.cost_usd ?? 0,
  };
}

/** Add `b` into `a` in place (accumulator fold for the rollup). */
function addInto(a: SessionUsage, b: SessionUsage): void {
  a.tokensIn += b.tokensIn;
  a.tokensOut += b.tokensOut;
  a.cacheRead += b.cacheRead;
  a.cost += b.cost;
}

/**
 * Project the `sessions` usage columns into per-session cost/attribution rows,
 * rolling SUB-AGENT spend up to the initiating parent.
 *
 * Rollup rule (D-16 "spend rolls up"): a session's {@link SessionCostRow.rolledUp}
 * total is its own usage plus the rolled-up total of every session whose
 * `parent_session_id` names it — recursively. A child whose parent is NOT in the
 * result set (terminal/pruned/foreign) still contributes its OWN row (never
 * dropped); its usage simply has no in-set parent to roll into.
 *
 * `forPrincipal` is read from the row's identity (`principal_id ?? home_principal`),
 * NEVER inferred. `attribution_target` NULL ⇒ {@link UNATTRIBUTED}.
 *
 * Cycle/orphan safety mirrors the session-tree assembler: a self-edge or a
 * multi-node loop can never make the walk hang (visited-set + {@link MAX_ROLLUP_DEPTH}),
 * and a child of an out-of-set parent is emitted as its own row.
 *
 * Deterministic order: initiating parents (roots) first in `started_at` order,
 * then descendants — the same fold order the ledger renders. Rows are returned in
 * the DB's `started_at ASC, id ASC` order (stable) for a caller that just wants a
 * flat list; the rollup itself is order-independent.
 */
export function listSessionCostAttribution(db: Database): SessionCostRow[] {
  const rows = db
    .query(
      `SELECT id, agent_id, agent_name, principal_id, home_principal,
              attribution_target, substrate, parent_session_id,
              input_tokens, output_tokens, cache_read_tokens, cost_usd
       FROM sessions
       ORDER BY started_at ASC, id ASC`
    )
    .all() as CostRow[];

  if (rows.length === 0) return [];

  // 1. Build one output row per session, keyed by id, with its OWN usage. Seed
  //    rolledUp as a COPY of own (the leaf case); step 2 folds descendants in.
  const byId = new Map<string, SessionCostRow>();
  const order: string[] = [];

  for (const row of rows) {
    if (byId.has(row.id)) continue; // PK — first wins; a dup id never double-counts.
    const own = usageOf(row);
    const forPrincipal = row.principal_id ?? row.home_principal ?? null;
    byId.set(row.id, {
      sessionId: row.id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      forPrincipal,
      attributionTarget: row.attribution_target ?? UNATTRIBUTED,
      substrate: row.substrate,
      isSubAgent: row.parent_session_id !== null,
      parentSessionId: row.parent_session_id,
      own,
      rolledUp: { ...own },
    });
    order.push(row.id);
  }

  // 2. Roll each session's total UP to its ancestors. Walk from every node up its
  //    parent chain, adding the node's OWN usage into each in-set ancestor's
  //    rolledUp. A visited-set per walk + the depth cap break any cycle; an
  //    out-of-set parent simply ends the walk (the orphan is its own root).
  for (const id of order) {
    // `order` is built from `byId.set` above, so every id resolves.
    const node = byId.get(id);
    if (node === undefined) continue; // unreachable (order mirrors byId); defensive.
    const ownUsage = node.own;
    let parentId = node.parentSessionId;
    const seen = new Set<string>([id]);
    let depth = 0;
    while (parentId !== null && depth < MAX_ROLLUP_DEPTH) {
      if (seen.has(parentId)) break; // cycle — stop before re-adding.
      seen.add(parentId);
      const ancestor = byId.get(parentId);
      if (ancestor === undefined) break; // out-of-set parent — orphan chain ends.
      addInto(ancestor.rolledUp, ownUsage);
      parentId = ancestor.parentSessionId;
      depth += 1;
    }
  }

  return order.map((id) => {
    const node = byId.get(id);
    // `order` is derived from `byId`, so this always resolves; the guard keeps the
    // map access total for the type checker without a non-null assertion.
    if (node === undefined) throw new Error(`cost-attribution: missing row ${id}`);
    return node;
  });
}
