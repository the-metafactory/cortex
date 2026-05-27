/**
 * Grove Mission Control v2 — SQLite schema definitions.
 *
 * All tables use TEXT primary keys (ULIDs) and ISO 8601 timestamps.
 * Schema leaves room for future budget and dependency fields (see design spec §10).
 */

export const TABLE_NAMES = [
  "tasks",
  "agents",
  "agent_task_assignment",
  "sessions",
  "events",
  "iterations",
] as const;

export const SCHEMA_SQL: string[] = [
  // --- tasks ---
  // Schema follows design-mission-control.md §3.2: flat three-field sourceRef
  // (source_system, source_url, source_external_id) with no nesting; INTEGER
  // epoch timestamps; description and related_refs_json present from day one.
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    priority INTEGER NOT NULL DEFAULT 2,
    principal_id TEXT NOT NULL,
    source_system TEXT NOT NULL CHECK(source_system IN ('github','internal')),
    source_url TEXT,
    source_external_id TEXT,
    related_refs_json TEXT,
    status TEXT NOT NULL DEFAULT 'open'
      CHECK(status IN ('open','in_progress','done','cancelled')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // --- agents ---
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('head','hands')),
    persistent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // --- agent_task_assignment ---
  // FK policy: RESTRICT on agent and task — cannot drop a task or agent that
  // still has assignments. Forces explicit cancel-then-delete to avoid losing
  // in-flight work by accident.
  `CREATE TABLE IF NOT EXISTS agent_task_assignment (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    state TEXT NOT NULL DEFAULT 'queued'
      CHECK(state IN ('queued','dispatched','running','blocked','completed','failed','cancelled')),
    block_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- Invariant: block_reason is non-null iff state = 'blocked'.
    -- Application enforces this via state-machine + applyTransition; the
    -- CHECK is a schema-level safety net for any writer that bypasses them.
    CHECK ((state = 'blocked') = (block_reason IS NOT NULL)),
    -- block_reason must parse as JSON (the BlockReason tagged union from types.ts).
    CHECK (block_reason IS NULL OR json_valid(block_reason))
  )`,

  // --- sessions ---
  // FK policy: CASCADE off assignment — sessions are detail rows of an
  // assignment; archiving an assignment should sweep its sessions with it.
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL REFERENCES agent_task_assignment(id) ON DELETE CASCADE,
    cc_session_id TEXT,
    endpoint_kind TEXT NOT NULL
      CHECK(endpoint_kind IN ('local.process.controlled','local.observed','local.process.autonomous')),
    pid INTEGER,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
  )`,

  // --- events ---
  // FK policy: CASCADE off session — events are voluminous detail of a
  // session and should never outlive their parent.
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // --- indices ---
  `CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`,
  `CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)`,
  // Dashboard's most likely query: "last N events for session X". Composite
  // (session_id, timestamp DESC) covers it without an explicit sort.
  `CREATE INDEX IF NOT EXISTS idx_events_session_timestamp
     ON events(session_id, timestamp DESC)`,
  // F-7 drill-down pagination: `WHERE session_id = ? AND id < ? ORDER BY id
  // DESC LIMIT ?`. The (session_id, id DESC) composite matches both the
  // equality filter and the sort, so SQLite can serve the page without an
  // in-memory sort pass. Pairs naturally with generateId's single-writer
  // monotonic-id guarantee (see db/events.ts generateId docstring).
  `CREATE INDEX IF NOT EXISTS idx_events_session_id_id
     ON events(session_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ata_agent_id ON agent_task_assignment(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ata_task_id ON agent_task_assignment(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ata_state ON agent_task_assignment(state)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_assignment_id ON sessions(assignment_id)`,
  // F-20.F sweep — composite index for the "most-recent session per
  // assignment" subquery used by both `db/tasks.ts` (F-20.F denorm)
  // and `db/assignments.ts` (focus-area / drill-down). The
  // single-column `idx_sessions_assignment_id` above serves the
  // matching predicate but leaves SQLite to do an in-memory sort of
  // matching rows per assignment to satisfy
  // `ORDER BY started_at DESC, id DESC LIMIT 1`. The composite
  // covers both the predicate and the ORDER BY in one walk; LIMIT 1
  // then short-circuits without a sort pass. Negligible at the 1–2
  // sessions/assignment typical case; matters once the assignment
  // lifetime accrues compaction-driven sessions (§6.6 of the
  // mission-control spec) or the operator dispatches the same task
  // multiple times. Per Echo's PR #57 review (N3).
  `CREATE INDEX IF NOT EXISTS idx_sessions_assignment_started
     ON sessions(assignment_id, started_at DESC, id DESC)`,
  // Invariant enforcer: at most one open (ended_at IS NULL) session per
  // assignment. Defense-in-depth against spawnControlledSession races — the
  // application-level check in endpoint-resolver covers the common path,
  // this partial unique index catches the race window between check and
  // INSERT. Attempting to open a second active session yields a SQLite
  // constraint error rather than silently creating an orphan.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active_assignment
     ON sessions(assignment_id) WHERE ended_at IS NULL`,
  // F-20 — defense-in-depth against a duplicate observed registration
  // racing the application-level dup-check in handleCreateSession. The
  // controlled path inserts with cc_session_id = NULL and stays NULL
  // (no `UPDATE sessions SET cc_session_id = …` site exists in
  // src/mission-control today — the ingestor only matches on this
  // column, never writes to it), so the partial filter on
  // `cc_session_id IS NOT NULL` excludes controlled rows entirely. Only
  // observed POSTs participate. A second observed POST with the same
  // uuid yields a SQLite constraint error rather than two crosstalk-
  // prone rows. Per Echo's PR-#56 review.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active_cc_session_id
     ON sessions(cc_session_id)
     WHERE cc_session_id IS NOT NULL AND ended_at IS NULL`,
  // Task list view (design §8.4): filter by status, sort by priority then age.
  // Composite covers status= filter via leftmost-prefix and the full ORDER BY.
  `CREATE INDEX IF NOT EXISTS idx_tasks_status_priority_updated
     ON tasks(status, priority, updated_at DESC)`,

  // --- iterations (F-13 / Decision 3) ---
  // Grove-owned lifecycle for the iteration planning surface. Per F-13
  // Decision 1, state lives here as a stored column (not derived from any
  // upstream source state). `imported_body` is an audit-only snapshot of the
  // upstream body at import time; `body` is the operator-editable in-Grove
  // copy. `source_*` columns are display/reference only after import — never
  // re-read for state. NULL `source_*` is the legitimate "internal-only"
  // iteration case (Decision 2).
  `CREATE TABLE IF NOT EXISTS iterations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT,
    imported_body TEXT,
    priority INTEGER NOT NULL DEFAULT 2,
    state TEXT NOT NULL DEFAULT 'inbox'
      CHECK(state IN ('inbox','designing','queued','in_flight','blocked','done','cancelled')),
    source_system TEXT,
    source_url TEXT,
    source_parent_ref TEXT,
    imported_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Kanban query: filter by state, sort by priority then recency
  // (mirrors F-8's idx_tasks_status_priority_updated).
  `CREATE INDEX IF NOT EXISTS idx_iterations_state_priority
     ON iterations(state, priority, updated_at DESC)`,
];

/**
 * F-13 — additive schema migrations that cannot be expressed as
 * idempotent CREATE TABLE / CREATE INDEX statements.
 *
 * SQLite's `ALTER TABLE ... ADD COLUMN` throws if the column already
 * exists, so we gate it on `pragma_table_info`. Run AFTER `SCHEMA_SQL`
 * (the iterations table must exist before the FK column references it).
 *
 * Each entry: ({ table, column, ddl, post? }):
 *   - ddl runs only when `column` is absent from `table`
 *   - post[] runs unconditionally (covers the partner index, which is
 *     idempotent on its own via `CREATE INDEX IF NOT EXISTS`)
 */
export interface ColumnAddMigration {
  table: string;
  column: string;
  ddl: string;
  post?: string[];
}

export const COLUMN_ADD_MIGRATIONS: ColumnAddMigration[] = [
  // tasks.iteration_id (F-13 / Decision 3) — nullable FK back to iterations.
  // No ON DELETE clause: the schema deliberately rejects DELETE-of-iteration
  // while tasks still reference it (default RESTRICT-equivalent for SQLite).
  // Detach via UPDATE tasks SET iteration_id = NULL first, then delete.
  {
    table: "tasks",
    column: "iteration_id",
    ddl: `ALTER TABLE tasks ADD COLUMN iteration_id TEXT REFERENCES iterations(id)`,
    post: [
      `CREATE INDEX IF NOT EXISTS idx_tasks_iteration ON tasks(iteration_id)`,
    ],
  },
];
