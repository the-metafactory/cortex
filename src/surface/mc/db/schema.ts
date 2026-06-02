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
  "git_repositories",
  "git_branches",
  "git_commits",
  "git_tags",
  "pull_requests",
  "reviews",
  "checks",
  "deployments",
  "artifacts",
  "releases",
  "plans",
  "plan_phases",
  "work_items",
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
  // mission-control spec) or the principal dispatches the same task
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
  // upstream body at import time; `body` is the principal-editable in-Grove
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

  // --- git_repositories (G-1113.C.1 — design §3.8/§6) ---
  // First-class Git objects. `provider` is intentionally NOT CHECK-constrained
  // (unlike tasks.source_system): the full Provider union is app-validated via
  // isProvider at the boundary, keeping the model provider-neutral/extensible.
  `CREATE TABLE IF NOT EXISTS git_repositories (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    owner TEXT,
    name TEXT NOT NULL,
    url TEXT,
    default_branch TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // --- git_branches (G-1113.C.1) ---
  `CREATE TABLE IF NOT EXISTS git_branches (
    id TEXT PRIMARY KEY,
    -- ON DELETE RESTRICT: a repository can't be dropped while branches reference
    -- it. Ingestion (C.5) only ever upserts Git objects, never deletes them, so
    -- this is a safety net against orphaned branches rather than a live policy.
    repository_id TEXT NOT NULL REFERENCES git_repositories(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    base_ref TEXT,
    head_sha TEXT,
    provider TEXT NOT NULL,
    external_id TEXT,
    url TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Branch lookup by repository (per-repo panel, C.7).
  `CREATE INDEX IF NOT EXISTS idx_git_branches_repository
     ON git_branches(repository_id, name)`,

  // --- git_commits (G-1113.C.2 — design §6) ---
  // Per §6 a commit has no provider field (it's repository-scoped); the
  // ON DELETE RESTRICT policy matches git_branches (ingestion upserts only).
  `CREATE TABLE IF NOT EXISTS git_commits (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES git_repositories(id) ON DELETE RESTRICT,
    sha TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    url TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // --- git_tags (G-1113.C.2) ---
  // provider left app-validated via isProvider (no CHECK), matching the other
  // Git objects.
  `CREATE TABLE IF NOT EXISTS git_tags (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES git_repositories(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    target_sha TEXT,
    provider TEXT NOT NULL,
    url TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Commit lookup by repository + sha; tag lookup by repository.
  `CREATE INDEX IF NOT EXISTS idx_git_commits_repository
     ON git_commits(repository_id, sha)`,
  `CREATE INDEX IF NOT EXISTS idx_git_tags_repository
     ON git_tags(repository_id, name)`,

  // --- pull_requests (G-1113.C.3 — design §6) ---
  // work_item_id is intentionally NOT a FK (the task/work-item linkage is wired
  // in Phase D); state/review_state CHECK-constrained (closed enums, like
  // tasks.status); provider app-validated via isProvider (no CHECK).
  `CREATE TABLE IF NOT EXISTS pull_requests (
    id TEXT PRIMARY KEY,
    work_item_id TEXT,
    repository_id TEXT NOT NULL REFERENCES git_repositories(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL,
    provider_native_type TEXT NOT NULL,
    external_id TEXT NOT NULL,
    number_or_key TEXT NOT NULL,
    title TEXT NOT NULL,
    source_branch TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    url TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open'
      CHECK(state IN ('draft','open','merged','closed')),
    review_state TEXT NOT NULL DEFAULT 'none'
      CHECK(review_state IN ('none','needs_review','changes_requested','approved')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // --- reviews (G-1113.C.3) ---
  `CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE RESTRICT,
    reviewer TEXT,
    state TEXT NOT NULL
      CHECK(state IN ('approved','changes_requested','commented','pending','dismissed')),
    provider TEXT NOT NULL,
    url TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // PR lookup by repository + work item; reviews by PR.
  `CREATE INDEX IF NOT EXISTS idx_pull_requests_repository
     ON pull_requests(repository_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pull_requests_work_item
     ON pull_requests(work_item_id)`,
  // C.6 — task→PR link lookup is keyed by external_id (the canonical ref).
  `CREATE INDEX IF NOT EXISTS idx_pull_requests_external_id
     ON pull_requests(external_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_pull_request
     ON reviews(pull_request_id)`,

  // --- checks / builds (G-1113.C.4 — §3.8 "check / status check" + "build") ---
  // One entity, `kind` distinguishes; state CHECK-constrained; provider
  // app-validated via isProvider (no CHECK); FK → repo ON DELETE RESTRICT.
  `CREATE TABLE IF NOT EXISTS checks (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES git_repositories(id) ON DELETE RESTRICT,
    commit_sha TEXT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'check' CHECK(kind IN ('check','build')),
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK(state IN ('pending','success','failure','error','neutral','cancelled')),
    provider TEXT NOT NULL,
    url TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // --- deployments (G-1113.C.4) ---
  `CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES git_repositories(id) ON DELETE RESTRICT,
    environment TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK(state IN ('pending','in_progress','success','failure','inactive')),
    provider TEXT NOT NULL,
    url TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // --- artifacts (G-1113.C.4) ---
  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES git_repositories(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    url TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // --- releases (G-1113.C.4 — design §6) ---
  // repository_id is NULLABLE per §6 (FK still holds when present; NULL skips
  // the check). state CHECK-constrained.
  `CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY,
    repository_id TEXT REFERENCES git_repositories(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL,
    external_id TEXT,
    name TEXT NOT NULL,
    tag_name TEXT,
    url TEXT,
    state TEXT NOT NULL DEFAULT 'draft'
      CHECK(state IN ('draft','published','failed','archived')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // lookups by repository
  `CREATE INDEX IF NOT EXISTS idx_checks_repository ON checks(repository_id, commit_sha)`,
  `CREATE INDEX IF NOT EXISTS idx_deployments_repository ON deployments(repository_id)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_repository ON artifacts(repository_id)`,
  `CREATE INDEX IF NOT EXISTS idx_releases_repository ON releases(repository_id)`,

  // --- plans (G-1113.D.1 — design §6) ---
  // kind/status CHECK-constrained (closed enums); provider app-validated via
  // isProvider (no CHECK).
  `CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    kind TEXT NOT NULL
      CHECK(kind IN ('research','design','iteration','migration','release','rollout','incident')),
    source_document_url TEXT,
    provider TEXT NOT NULL,
    external_id TEXT,
    umbrella_work_item_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK(status IN ('draft','active','blocked','done','cancelled')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // --- plan_phases (G-1113.D.1) ---
  // `phase_order` column (avoids the SQL reserved word ORDER); maps to the
  // PlanPhase.order field.
  `CREATE TABLE IF NOT EXISTS plan_phases (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    phase_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'not_started'
      CHECK(status IN ('not_started','active','blocked','done','cancelled')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Phase lookup by plan, ordered.
  `CREATE INDEX IF NOT EXISTS idx_plan_phases_plan ON plan_phases(plan_id, phase_order)`,

  // --- work_items (G-1113.D.4 — design §6) ---
  // The cockpit's work-management noun (distinct from `tasks`). Links up to a
  // plan + phase, and self-references via parent_id for sub-items. Per §6,
  // `status` and `priority` are open provider-native strings — NOT CHECK-
  // constrained (unlike plan/phase status), so any provider's vocabulary maps
  // through. `provider` is app-validated via isProvider (no CHECK), matching
  // the Git-object tables. All FKs ON DELETE RESTRICT: ingestion only upserts,
  // never deletes, so these are orphan safety-nets rather than live policy.
  `CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    plan_id TEXT REFERENCES plans(id) ON DELETE RESTRICT,
    phase_id TEXT REFERENCES plan_phases(id) ON DELETE RESTRICT,
    parent_id TEXT REFERENCES work_items(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL,
    external_id TEXT,
    url TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Work-item lookup by phase (phase detail, D.4) and by plan.
  `CREATE INDEX IF NOT EXISTS idx_work_items_phase ON work_items(phase_id)`,
  `CREATE INDEX IF NOT EXISTS idx_work_items_plan ON work_items(plan_id)`,
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
