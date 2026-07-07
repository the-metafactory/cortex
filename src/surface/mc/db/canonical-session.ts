/**
 * Canonical Mission Control session schema — the SINGLE shared source.
 *
 * ADR-0011 ("Unified Mission Control session schema across local + cloud"):
 * the MC backend is dual-substrate — a local **bun:sqlite** DB (`db/schema.ts`,
 * served at `:8767`) and a cloud **Cloudflare D1** DB (`worker/schema.sql`,
 * served at `grove.meta-factory.ai/api/*`). The two `sessions` schemas had
 * **diverged** (normalized-local vs denormalized-cloud) with no shared source —
 * the exact drift bug class of #877/#879. This module is the convergence point:
 * the canonical session columns are defined ONCE here, and both physical
 * schemas are derived/validated from this list by a CI **parity test**
 * (`__tests__/session-schema-parity.test.ts`) that fails on drift.
 *
 * The canonical shape is the **flat (denormalized) session-view** per ADR-0011
 * decision 1: `agent_id`, `agent_name`, `principal_id`, `parent_session_id`,
 * `substrate`, `status`, started/ended, metrics, and the sovereignty columns
 * live directly on the `sessions` row. Local keeps `tasks`/`agent_task_assignment`
 * underneath for the dispatch control plane (synced on write, Phase 2); cloud was
 * already flat.
 *
 * Interiors (`events`) stay LOCAL-ONLY (ADR-0005) — that is a *depth* difference
 * (what data each substrate holds), not a *shape* divergence (what a session row
 * means), so it is deliberately NOT part of this canonical session row.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NAMING RECONCILIATION (ADR-0011 — "identical schemas", prefer D1 names)
 * ─────────────────────────────────────────────────────────────────────────────
 * Two columns historically differ in name between the substrates. ADR-0011 says
 * prefer the D1 names (cloud is closer to the target), BUT Phase 0 is a
 * NO-BEHAVIOR-CHANGE foundation: renaming the local PK or the local
 * terminal-timestamp would cascade through FK columns (`events.session_id`,
 * `attention_items.session_id`), the partial unique indices, `transitions.ts`,
 * `retention.ts`, and every read query. So per the task's explicit carve-out
 * ("local may keep its existing PK column name if renaming would cascade
 * behavior changes — document as a Phase 2 TODO"), the local physical column
 * name is preserved this phase while the *canonical meaning* is shared.
 *
 *   canonical concept   | D1 column      | local column | this phase
 *   --------------------|----------------|--------------|---------------------------
 *   session identity    | session_id     | id           | KEEP both (rename = Phase 2)
 *   terminal timestamp  | completed_at   | ended_at     | KEEP both (rename = Phase 2)
 *
 * Each such split is recorded as a {@link CanonicalSessionColumn.localName} that
 * differs from {@link CanonicalSessionColumn.d1Name}, plus a
 * {@link CanonicalSessionColumn.phase2Rename} TODO marker. The parity test reads
 * these so it asserts the RIGHT physical name per substrate (not a false drift).
 *
 * TODO(Phase 2, ADR-0011): converge the two split columns to a single physical
 * name (`session_id`, `completed_at`) on the local side once the PK/timestamp
 * rename can be done with its FK + index + query cascade in one deliberate
 * migration. Until then `localName !== d1Name` is the *intended* state, gated by
 * `phase2Rename`.
 */

/** SQLite/D1 affinity used by the canonical columns. */
export type CanonicalSqliteType = "TEXT" | "INTEGER" | "REAL";

/**
 * One canonical session column. The shared source emits, from this list:
 *   (a) the bun:sqlite DDL fragment (local `schema.ts`) — via {@link localName},
 *   (b) the D1 DDL fragment (`worker/schema.sql`)        — via {@link d1Name},
 *   (c) the TS `Session` field (`types.ts`).
 */
export interface CanonicalSessionColumn {
  /** Canonical/logical name (D1-preferred per ADR-0011). */
  d1Name: string;
  /**
   * Physical column name on the LOCAL bun:sqlite `sessions` table. Equals
   * {@link d1Name} for every column EXCEPT the two pre-existing splits the PK /
   * terminal-timestamp rename defers to Phase 2 (`id`, `ended_at`).
   */
  localName: string;
  type: CanonicalSqliteType;
  /** `true` ⇒ column is `NOT NULL` (with a `DEFAULT`); `false` ⇒ nullable. */
  notNull: boolean;
  /** SQL literal default (already quoted if TEXT), or null for no default. */
  default: string | null;
  /**
   * Set when {@link localName} !== {@link d1Name} as a DELIBERATE Phase-2-deferred
   * rename (ADR-0011). The parity test reads this to avoid flagging the split as
   * accidental drift; the string is the rationale surfaced in the TODO.
   */
  phase2Rename?: string;
  /** Short human note (mirrored into the DDL comment + the type doc). */
  note: string;
}

/**
 * THE canonical session column set (ADR-0011). Order matters only for readable
 * DDL output; the parity test compares as a set keyed by name.
 *
 * New canonical columns added beyond the pre-existing local `sessions` columns
 * (`id`/`assignment_id`/`cc_session_id`/`endpoint_kind`/`pid`/`started_at`/
 * `ended_at`) are nullable where the data does not exist yet on the local side
 * (`agent_id`, `agent_name`, `principal_id`, `status`, metrics, sovereignty) —
 * Phase 2 populates them on write. The two session-tree fields land NOT-NULL-ish
 * per ADR-0011: `parent_session_id` nullable (self-ref; agent-rooted sessions
 * have none), `substrate` NOT NULL DEFAULT 'claude-code'.
 */
export const CANONICAL_SESSION_COLUMNS: CanonicalSessionColumn[] = [
  // --- identity ---
  {
    d1Name: "session_id",
    localName: "id",
    type: "TEXT",
    notNull: true,
    default: null,
    phase2Rename:
      "local PK is `id`; renaming to `session_id` cascades through events.session_id / attention_items.session_id FKs, the partial unique indices, and every read query — deferred to Phase 2 (ADR-0011).",
    note: "Session identity (PK). Canonical name session_id; local physical PK stays `id` until the Phase-2 rename.",
  },
  // --- ownership / attribution (denormalized onto the row, ADR-0011 decision 1) ---
  {
    d1Name: "agent_id",
    localName: "agent_id",
    type: "TEXT",
    notNull: false,
    default: null,
    note: "Owning agent (the bus runtime identity). NULL on local until Phase 2 syncs it off the assignment join.",
  },
  {
    d1Name: "agent_name",
    localName: "agent_name",
    type: "TEXT",
    notNull: false,
    default: null,
    note: "Owning agent display name, carried as a SESSION column (a session is not an agent). NULL on local until Phase 2.",
  },
  {
    d1Name: "principal_id",
    localName: "principal_id",
    type: "TEXT",
    notNull: false,
    default: null,
    note: "Principal the session belongs to. NULL on local until Phase 2 syncs it off tasks.principal_id.",
  },
  // --- session tree (ADR-0011: canonical from the start) ---
  {
    d1Name: "parent_session_id",
    localName: "parent_session_id",
    type: "TEXT",
    notNull: false,
    default: null,
    note: "Self-ref to the session that spawned this one. NULL ⇒ agent-rooted session. The session-tree edge (CONTEXT.md §Session tree).",
  },
  {
    d1Name: "substrate",
    localName: "substrate",
    type: "TEXT",
    notNull: true,
    default: "'claude-code'",
    note: "The substrate this session runs on (claude-code | codex | …). An attribute of a session, derived from HarnessId (refactor §3 D4).",
  },
  // --- lifecycle ---
  {
    d1Name: "status",
    localName: "status",
    type: "TEXT",
    notNull: false,
    default: null,
    note: "Denormalized lifecycle status. NULL on local until Phase 2 syncs it off agent_task_assignment.state.",
  },
  {
    d1Name: "started_at",
    localName: "started_at",
    type: "TEXT",
    notNull: true,
    default: null,
    note: "Session start (ISO 8601). The one timestamp whose name already agrees across substrates.",
  },
  {
    d1Name: "completed_at",
    localName: "ended_at",
    type: "TEXT",
    notNull: false,
    default: null,
    phase2Rename:
      "local terminal timestamp is `ended_at`; renaming to `completed_at` touches the partial unique indices, transitions.ts terminal-stamping, and retention.ts reaping — deferred to Phase 2 (ADR-0011).",
    note: "Terminal timestamp. Canonical name completed_at; local physical column stays `ended_at` until the Phase-2 rename.",
  },
  // --- metrics ---
  {
    d1Name: "duration_ms",
    localName: "duration_ms",
    type: "INTEGER",
    notNull: false,
    default: null,
    note: "Wall-clock duration. NULL until known.",
  },
  {
    d1Name: "events_count",
    localName: "events_count",
    type: "INTEGER",
    notNull: false,
    default: null,
    note: "Number of events observed for the session.",
  },
  {
    d1Name: "input_tokens",
    localName: "input_tokens",
    type: "INTEGER",
    notNull: false,
    default: null,
    note: "Input tokens consumed.",
  },
  {
    d1Name: "output_tokens",
    localName: "output_tokens",
    type: "INTEGER",
    notNull: false,
    default: null,
    note: "Output tokens produced.",
  },
  {
    d1Name: "cache_read_tokens",
    localName: "cache_read_tokens",
    type: "INTEGER",
    notNull: false,
    default: null,
    note: "Prompt-cache read tokens.",
  },
  {
    d1Name: "cost_usd",
    localName: "cost_usd",
    type: "REAL",
    notNull: false,
    default: null,
    note: "Estimated cost in USD.",
  },
  // --- sovereignty (IAW D.5 — lifted off the myelin envelope) ---
  {
    d1Name: "classification",
    localName: "classification",
    type: "TEXT",
    notNull: false,
    default: null,
    note: "'local' | 'federated' | 'public' | NULL. NULL for pre-IAW publishers.",
  },
  {
    d1Name: "data_residency",
    localName: "data_residency",
    type: "TEXT",
    notNull: false,
    default: null,
    note: "e.g. 'nz', 'eu', NULL.",
  },
  {
    d1Name: "home_principal",
    localName: "home_principal",
    type: "TEXT",
    notNull: false,
    default: null,
    note: "principal.home_principal (post-did:mf: strip).",
  },
  // --- cross-stack origin (CK-4a / #1295 / decision D-8) ---
  {
    d1Name: "origin_stack_id",
    localName: "origin_stack_id",
    type: "TEXT",
    notNull: false,
    default: null,
    note:
      "The stack this session ORIGINATED on — the schema-level attribution the cross-stack WORKING aggregation groups by (#1295). D-8 adopts a column + backfill that EXTENDS the ADR-0011 canonical row rather than forking a parallel origin table, so both substrates carry it and the read model stays a plain GROUP BY. NULL ⇒ own/local-stack origin (the pre-CK-4a and single-stack case) — an honest 'unattributed to a specific peer stack', never fabricated. Never sourced from an attacker-controlled payload; stamped from the stack's own resolved identity on write / backfill.",
  },
];

/** The two indices the session-tree refactor adds to BOTH substrates (Phase 0). */
export const CANONICAL_SESSION_INDICES = [
  "idx_sessions_parent_session_id",
  "idx_sessions_substrate",
] as const;

/**
 * Render one column's DDL clause for a given substrate.
 * `local` uses {@link CanonicalSessionColumn.localName}; `d1` uses
 * {@link CanonicalSessionColumn.d1Name}.
 */
export function columnDdl(
  col: CanonicalSessionColumn,
  substrate: "local" | "d1"
): string {
  const name = substrate === "local" ? col.localName : col.d1Name;
  let clause = `${name} ${col.type}`;
  if (col.notNull) clause += " NOT NULL";
  if (col.default !== null) clause += ` DEFAULT ${col.default}`;
  return clause;
}

/** All canonical columns that did NOT pre-exist the session-tree refactor —
 *  the additive set Phase 0 must ADD to both physical schemas. */
export const CANONICAL_ADDED_COLUMNS = CANONICAL_SESSION_COLUMNS.filter((c) =>
  [
    "agent_id",
    "agent_name",
    "principal_id",
    "parent_session_id",
    "substrate",
    "status",
    "duration_ms",
    "events_count",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cost_usd",
    "classification",
    "data_residency",
    "home_principal",
    "origin_stack_id",
  ].includes(c.d1Name)
);
