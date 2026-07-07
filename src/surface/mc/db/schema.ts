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
  "attention_items",
  "observability_events",
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
    -- G-1113.D.7c — provider-neutral: no CHECK (app-validated via isProvider at
    -- the read boundary, matching the git/work-item tables). Existing DBs are
    -- migrated off the old CHECK by REBUILD_MIGRATIONS below.
    source_system TEXT NOT NULL,
    source_url TEXT,
    source_external_id TEXT,
    related_refs_json TEXT,
    -- Slice convergence C (cortex#1150 / docs/design-slice-activity-thread.md §C):
    -- the slice-rollup link. A dispatch anchor-task points at the issue's
    -- work_item (the slice) so MC rolls up a slice's per-dispatch activity under
    -- ONE card. Queryable column (not buried in related_refs_json) so the slice
    -- card gathers its dispatches with an indexed WHERE work_item_id = ? filter,
    -- mirroring pull_requests.work_item_id. Intentionally NOT a hard FK: the
    -- work_item may be a lazily-created stub and ingestion order isn't
    -- guaranteed, matching pull_requests.work_item_id (wired, not enforced).
    work_item_id TEXT,
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
    -- CK-4a / #1295: provider back-pressure hint. When the dispatch lifecycle
    -- reports not_now { retry_after_ms } (rate/capacity exhaustion — see
    -- src/runner/dispatch-listener.ts), the assignment sits pre-spawn (queued)
    -- carrying the earliest-retry delay in ms. NULL ⇒ no pending provider retry.
    -- LOCAL-ONLY: the dispatch lifecycle never crosses the federation boundary
    -- (ADR-0005 / the CK-4a scope boundary — dispatch stays local), so the D1
    -- substrate has no analogue. The read model (db/working-aggregation.ts)
    -- PROJECTS this; the dispatch-listener → assignment WRITER is the CK-4a
    -- write-half (#1514 lane) and is deliberately NOT wired here.
    retry_after_ms INTEGER,
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
  //
  // ST-P0 / ADR-0011: the canonical (denormalized) session columns
  // (agent_id/agent_name/principal_id/status/metrics/sovereignty) +
  // session-tree fields (parent_session_id/substrate) are defined ONCE in
  // db/canonical-session.ts (CANONICAL_SESSION_COLUMNS) and asserted against
  // both physical schemas by __tests__/session-schema-parity.test.ts. They are
  // mirrored verbatim here (the DDL is the physical artifact; the shared source
  // is the contract the parity test enforces).
  //
  // NAMING NOTE (ADR-0011): the canonical names prefer the D1 spelling, but the
  // local PK stays `id` and the terminal timestamp stays `ended_at` this phase
  // — renaming them to session_id/completed_at cascades through the
  // events/attention FKs, the partial unique indices, transitions.ts and
  // retention.ts; that rename is a deliberate Phase-2 TODO (canonical-session.ts
  // CanonicalSessionColumn.phase2Rename). The new denormalized columns are
  // NULLABLE on local until Phase 2 syncs them on write; substrate is NOT NULL
  // DEFAULT 'claude-code', parent_session_id is a nullable self-ref.
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL REFERENCES agent_task_assignment(id) ON DELETE CASCADE,
    cc_session_id TEXT,
    endpoint_kind TEXT NOT NULL
      CHECK(endpoint_kind IN ('local.process.controlled','local.observed','local.process.autonomous')),
    pid INTEGER,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    -- ST-P0 / ADR-0011 canonical session columns (see canonical-session.ts) --
    parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    substrate TEXT NOT NULL DEFAULT 'claude-code',
    agent_id TEXT,
    agent_name TEXT,
    principal_id TEXT,
    status TEXT,
    duration_ms INTEGER,
    events_count INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cost_usd REAL,
    classification TEXT,
    data_residency TEXT,
    home_principal TEXT,
    -- CK-4a / #1295 / ADR-0011 canonical: the ORIGIN-stack attribution the
    -- cross-stack WORKING aggregation groups by (see canonical-session.ts).
    -- NULL ⇒ own/local-stack origin. Its lookup index idx_sessions_origin_stack_id
    -- is created by the origin_stack_id COLUMN_ADD_MIGRATIONS post[] (NOT here) —
    -- same #961/#1048 pre-existing-DB rule as parent_session_id/substrate below.
    origin_stack_id TEXT
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
  // ST-P0 / ADR-0011 — the session-tree lookup indices (children of a session;
  // sessions of a given substrate) are DELIBERATELY NOT declared here. They
  // index parent_session_id / substrate, columns that an existing pre-P0 DB does
  // not yet carry when init.ts runs this SCHEMA_SQL loop (which precedes the
  // COLUMN_ADD_MIGRATIONS loop). Declaring them here crashes initDatabase on
  // those DBs with `no such column: parent_session_id`. They are created instead
  // by the parent_session_id / substrate COLUMN_ADD_MIGRATIONS `post[]` arrays
  // below — which run AFTER the column ALTERs AND unconditionally (init.ts always
  // runs `post[]`, even when the ALTER is skipped on a fresh DB whose columns
  // came from CREATE TABLE). Their names are part of the canonical contract
  // (CANONICAL_SESSION_INDICES) the parity test asserts on both substrates; the
  // parity test scans SCHEMA_SQL + the COLUMN_ADD_MIGRATIONS post[] strings.
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
  // Slice convergence C (cortex#1150) — the slice card gathers its dispatch
  // anchor-tasks by work_item_id; indexed for a straight scan, mirroring
  // idx_pull_requests_work_item. The partner index idx_tasks_work_item is
  // DELIBERATELY NOT declared here — it indexes work_item_id, a column an
  // existing pre-C DB does not carry when init.ts runs this SCHEMA_SQL loop
  // (which precedes the COLUMN_ADD_MIGRATIONS loop). Declaring it here crashes
  // initDatabase on those DBs with `no such column: work_item_id` (the same
  // #961/#1048 bug class as parent_session_id / origin_kind). It is created
  // instead by the work_item_id COLUMN_ADD_MIGRATIONS post[] below, which runs
  // AFTER the column ALTER AND unconditionally (so fresh DBs get it too).

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

  // --- attention_items (G-1113.E.1 — design §6 / §7.4) ---
  // The cross-cutting attention queue. kind/severity/status are CHECK-bounded
  // closed enums (cast in the mapper). work_item_id / session_id are the
  // deep-link targets — FK ON DELETE SET NULL (NOT RESTRICT like the plan/work
  // tables): attention is a transient/derived projection, so when its target
  // entity churns the item survives with the link cleared rather than blocking
  // the delete. (stack_id is a plain key — no stacks table in the MC DB yet.)
  // E.2/E.3 FOLLOW-UP: if SET NULL clears the LAST link of an open item (both
  // work_item_id + session_id null), the producer/reconciler must auto-resolve
  // or dismiss it — an open item with no deep-link target violates §7.4. Storage
  // alone can't decide that; it's a producer responsibility.
  `CREATE TABLE IF NOT EXISTS attention_items (
    id TEXT PRIMARY KEY,
    stack_id TEXT NOT NULL,
    work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    kind TEXT NOT NULL
      CHECK(kind IN ('input_needed','permission','review','failed_dispatch','stale','blocked')),
    severity TEXT NOT NULL DEFAULT 'normal'
      CHECK(severity IN ('low','normal','high','critical')),
    status TEXT NOT NULL DEFAULT 'open'
      CHECK(status IN ('open','resolved','dismissed')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Queue query: open items first, by severity. Plus work-item lookup.
  `CREATE INDEX IF NOT EXISTS idx_attention_status_severity
     ON attention_items(status, severity)`,
  `CREATE INDEX IF NOT EXISTS idx_attention_work_item ON attention_items(work_item_id)`,

  // G-1115 — governance verdicts (governance upgrade Stage 5). Pipeline-level
  // audit records projected from `governance.verdict.{l0,tribunal,gate,resolved}`
  // envelopes (pulse's governed: stack, P-702). NOT session-joined: the
  // Governance tab queries time windows + counts, not session feeds. Append-only
  // from the projection's perspective; `envelope_id` UNIQUE makes redelivery
  // idempotent.
  `CREATE TABLE IF NOT EXISTS governance_verdicts (
    id TEXT PRIMARY KEY,
    envelope_id TEXT NOT NULL UNIQUE,
    layer TEXT NOT NULL
      CHECK(layer IN ('l0','tribunal','gate','resolved')),
    decision TEXT NOT NULL,
    name TEXT NOT NULL,
    tool TEXT,
    reason TEXT,
    resolved_by TEXT,
    source TEXT,
    subject TEXT,
    principal TEXT,
    stack TEXT,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_governance_created ON governance_verdicts(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_governance_decision ON governance_verdicts(decision, created_at)`,

  // P-14 U3.1 (#936) — governance access denials. Pipeline-level access-decision
  // rows projected from U0.2's (#932) `system.access.{denied,filtered}` envelopes
  // — the access-gate dimension of the governance pane, sibling to
  // `governance_verdicts` (the governed-action dimension). `kind` distinguishes
  // a hard access deny from a renderer visibility filter; `reason_kind` carries
  // the deny/filter discriminator (`sovereignty_model_class`, `chain_verify_failed`,
  // `chain_verify_fault`, `residency_blocked`, …) — the sovereignty subset is the
  // pane's REFUSALS. Append-only; `envelope_id` UNIQUE makes redelivery idempotent;
  // retention ages rows past 35d, outliving the 30d query window (db/retention.ts).
  `CREATE TABLE IF NOT EXISTS governance_denials (
    id TEXT PRIMARY KEY,
    envelope_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL
      CHECK(kind IN ('denied','filtered')),
    reason_kind TEXT NOT NULL,
    principal_id TEXT,
    capability TEXT,
    envelope_subject TEXT,
    detail TEXT,
    source TEXT,
    subject TEXT,
    principal TEXT,
    stack TEXT,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_governance_denials_created ON governance_denials(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_governance_denials_reason ON governance_denials(reason_kind, created_at)`,

  // P-14 U2.1 (#934) — Observability events. Append-only projection rows from
  // signal's four `system.*` envelope families (`system.signal.*`,
  // `system.signal.collector.*`, `system.federation.*`, `system.transport.*`),
  // surfaced on the MC Observability tab. NOT session-joined: the tab queries
  // by `family` (signal-health / federation / transport sections) and time, not
  // session feeds — modelled on `governance_verdicts`. `envelope_id` UNIQUE makes
  // at-least-once redelivery idempotent. `family` is the section discriminator;
  // `type` is the full `domain.entity.action`. Hub-scope (federation/transport)
  // is a DATA property — non-hub stacks simply have zero rows of those families,
  // which the tab renders as an honest empty state (never synthesized).
  // P-14 U3.3 (#937) — `origin_kind` / `origin_peer` carry the ORIGIN-BADGE.
  //   - `origin_kind` is `'local'` (this principal's own / sibling-stack rows,
  //     the U2.1 default) or `'foreign'` (a TRUST-VERIFIED federated peer's row,
  //     folded via the Option-D `federated-observability-fold.ts` path).
  //   - `origin_peer` is the CHAIN-VERIFIED `{principal}/{stack}` for a foreign
  //     row (NULL for local). It is derived from the verified envelope SOURCE,
  //     never from the attacker-controlled payload — so a peer row can NEVER be
  //     shown as local (the negative control's identity half).
  // Fresh DBs get them here; existing DBs backfill via COLUMN_ADD_MIGRATIONS.
  `CREATE TABLE IF NOT EXISTS observability_events (
    id TEXT PRIMARY KEY,
    envelope_id TEXT NOT NULL UNIQUE,
    family TEXT NOT NULL
      CHECK(family IN ('signal','collector','federation','transport')),
    type TEXT NOT NULL,
    stack_id TEXT,
    summary TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    origin_kind TEXT NOT NULL DEFAULT 'local'
      CHECK(origin_kind IN ('local','foreign')),
    origin_peer TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_observability_timestamp ON observability_events(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_observability_family ON observability_events(family, timestamp DESC)`,
  // ST-P0 / #1048: the origin-badge lookup index (idx_observability_origin on
  // origin_kind, origin_peer) is DELIBERATELY NOT declared here. It indexes
  // origin_kind / origin_peer, columns that an existing pre-U3.3 DB does not yet
  // carry when init.ts runs this SCHEMA_SQL loop (which precedes the
  // COLUMN_ADD_MIGRATIONS loop). Declaring it here crashes initDatabase on those
  // DBs with `no such column: origin_kind` (the #961 bug class, reintroduced by
  // U3.3 / #937, and the cause of the MC embed boot crash in #1048). It is
  // created instead by the origin_kind / origin_peer COLUMN_ADD_MIGRATIONS
  // `post[]` arrays below — which run AFTER the column ALTERs AND unconditionally
  // (init.ts always runs `post[]`, even when the ALTER is skipped on a fresh DB
  // whose columns came from CREATE TABLE).
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

  // Slice convergence C (cortex#1150) — tasks.work_item_id for EXISTING DBs.
  // Fresh DBs get it from the tasks CREATE TABLE above; an already-initialised
  // DB (the running stacks) backfills it here via the same pragma_table_info
  // gate. Nullable, no FK clause (the work_item may be a lazy stub; matches the
  // pull_requests.work_item_id "wired, not enforced" policy). The partner index
  // is idempotent via CREATE INDEX IF NOT EXISTS.
  {
    table: "tasks",
    column: "work_item_id",
    ddl: `ALTER TABLE tasks ADD COLUMN work_item_id TEXT`,
    post: [
      `CREATE INDEX IF NOT EXISTS idx_tasks_work_item ON tasks(work_item_id)`,
    ],
  },

  // ST-P0 / ADR-0011 — canonical session columns for EXISTING DBs. Fresh DBs
  // get these from the sessions CREATE TABLE above; an already-initialised DB
  // (the running stacks) backfills them here via the same pragma_table_info
  // gate the F-13/#857/#864 column-adds use. Names/types mirror
  // canonical-session.ts CANONICAL_SESSION_COLUMNS (localName) verbatim — the
  // parity test pins them.
  //
  // SQLite ALTER ADD COLUMN caveat: a NOT NULL column needs a constant DEFAULT
  // (substrate qualifies). A self-referential FK cannot be added via ALTER on a
  // table that already has rows in some SQLite builds, BUT bun:sqlite permits
  // `ADD COLUMN x REFERENCES sessions(id)` with foreign_keys ON (the FK is only
  // checked on write); existing rows have NULL parent_session_id which satisfies
  // the FK. The session-tree CASCADE applies going forward.
  {
    table: "sessions",
    column: "parent_session_id",
    ddl: `ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE`,
    post: [
      `CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id)`,
    ],
  },
  {
    table: "sessions",
    column: "substrate",
    ddl: `ALTER TABLE sessions ADD COLUMN substrate TEXT NOT NULL DEFAULT 'claude-code'`,
    post: [
      `CREATE INDEX IF NOT EXISTS idx_sessions_substrate ON sessions(substrate)`,
    ],
  },
  { table: "sessions", column: "agent_id", ddl: `ALTER TABLE sessions ADD COLUMN agent_id TEXT` },
  { table: "sessions", column: "agent_name", ddl: `ALTER TABLE sessions ADD COLUMN agent_name TEXT` },
  { table: "sessions", column: "principal_id", ddl: `ALTER TABLE sessions ADD COLUMN principal_id TEXT` },
  { table: "sessions", column: "status", ddl: `ALTER TABLE sessions ADD COLUMN status TEXT` },
  { table: "sessions", column: "duration_ms", ddl: `ALTER TABLE sessions ADD COLUMN duration_ms INTEGER` },
  { table: "sessions", column: "events_count", ddl: `ALTER TABLE sessions ADD COLUMN events_count INTEGER` },
  { table: "sessions", column: "input_tokens", ddl: `ALTER TABLE sessions ADD COLUMN input_tokens INTEGER` },
  { table: "sessions", column: "output_tokens", ddl: `ALTER TABLE sessions ADD COLUMN output_tokens INTEGER` },
  { table: "sessions", column: "cache_read_tokens", ddl: `ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER` },
  { table: "sessions", column: "cost_usd", ddl: `ALTER TABLE sessions ADD COLUMN cost_usd REAL` },
  { table: "sessions", column: "classification", ddl: `ALTER TABLE sessions ADD COLUMN classification TEXT` },
  { table: "sessions", column: "data_residency", ddl: `ALTER TABLE sessions ADD COLUMN data_residency TEXT` },
  { table: "sessions", column: "home_principal", ddl: `ALTER TABLE sessions ADD COLUMN home_principal TEXT` },

  // CK-4a / #1295 / D-8 — the cross-stack ORIGIN attribution for EXISTING DBs.
  // Fresh DBs get it from the sessions CREATE TABLE above; an already-initialised
  // DB (the running / aggregating MC-DB stacks) backfills the column here via the
  // same pragma_table_info gate. Nullable TEXT, no FK (the origin is a stack
  // IDENTITY string, not a row in this DB). The value-level backfill of existing
  // NULL rows to this daemon's own stack id is a SEPARATE, id-aware step —
  // `backfillOriginStackId(db, stackId)` in db/sessions.ts — because the schema
  // layer does not know the resolved stack id (it lives in config, wired at boot).
  // The lookup index runs in post[] (unconditional, so fresh DBs get it too).
  {
    table: "sessions",
    column: "origin_stack_id",
    ddl: `ALTER TABLE sessions ADD COLUMN origin_stack_id TEXT`,
    post: [
      `CREATE INDEX IF NOT EXISTS idx_sessions_origin_stack_id ON sessions(origin_stack_id)`,
    ],
  },

  // CK-4a / #1295 — provider back-pressure hint for EXISTING assignment DBs.
  // Fresh DBs get it from the agent_task_assignment CREATE TABLE above. Nullable
  // INTEGER (ms); a plain ADD COLUMN with no CHECK/NOT NULL, so the ALTER is safe
  // on a table with rows. LOCAL-ONLY (no D1 analogue — dispatch stays local per
  // the CK-4a scope boundary). Read by db/working-aggregation.ts; writer deferred
  // to the dispatch-listener write-half.
  {
    table: "agent_task_assignment",
    column: "retry_after_ms",
    ddl: `ALTER TABLE agent_task_assignment ADD COLUMN retry_after_ms INTEGER`,
  },

  // P-14 U3.3 (#937) — origin-badge columns for EXISTING observability DBs.
  // Fresh DBs get these from the observability_events CREATE TABLE above; an
  // already-initialised DB (the running U2.1 stacks) backfills them here.
  // `origin_kind` is NOT NULL with a constant DEFAULT 'local' (SQLite ALTER ADD
  // requires a constant default for NOT NULL) — so every pre-U3.3 row reads as
  // `local`, exactly its true origin (U2.1 only ever folded local rows safely;
  // the federated path is what U3.3 adds). `origin_peer` is nullable (NULL for
  // local). The partner index is idempotent via CREATE INDEX IF NOT EXISTS.
  {
    table: "observability_events",
    column: "origin_kind",
    ddl: `ALTER TABLE observability_events ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'local'`,
    // NOTE: the partner index idx_observability_origin spans BOTH origin_kind
    // AND origin_peer. It is created in the origin_peer entry's post[] below —
    // NOT here — because at this point origin_peer has not yet been ALTERed in
    // (this entry runs first), so a `CREATE INDEX ... (origin_kind, origin_peer)`
    // here throws `no such column: origin_peer` on an existing DB (#1048).
  },
  {
    table: "observability_events",
    column: "origin_peer",
    ddl: `ALTER TABLE observability_events ADD COLUMN origin_peer TEXT`,
    // Both origin columns now exist (origin_kind added by the entry above,
    // origin_peer by this one), so the composite index is safe to create here.
    // Runs unconditionally (init.ts always runs post[]) so fresh DBs — whose
    // columns came from CREATE TABLE — get the index too.
    post: [
      `CREATE INDEX IF NOT EXISTS idx_observability_origin ON observability_events(origin_kind, origin_peer)`,
    ],
  },
];

/**
 * G-1113.D.7c — table-rebuild migrations for EXISTING DBs.
 *
 * SQLite can't `ALTER TABLE ... DROP CONSTRAINT`, so relaxing a CHECK on an
 * existing table requires the standard rebuild recipe (new table → copy → drop
 * → rename). Fresh DBs already get the relaxed schema from SCHEMA_SQL, so each
 * rebuild is GUARDED by `detect(currentSql)` and only fires when the OLD shape
 * is still present — making it idempotent (post-migration it never re-runs).
 *
 * init.ts runs these AFTER COLUMN_ADD_MIGRATIONS (so added columns like
 * tasks.iteration_id already exist) with foreign_keys OFF, inside a transaction,
 * and a foreign_key_check afterwards.
 *
 * ⚠️ TRANSITIONAL + DATA-CRITICAL: `steps` must reproduce the table's FULL
 * current shape = base SCHEMA_SQL columns + every COLUMN_ADD_MIGRATIONS column
 * (today: tasks.iteration_id). If a future column-add lands, it MUST be added to
 * the rebuild DDL below until this migration is retired (once all deployments
 * have migrated past the source_system CHECK). The INSERT uses an explicit
 * column list — never SELECT * — so a shape mismatch fails loudly, not silently.
 */
export interface RebuildMigration {
  table: string;
  /** Fire the rebuild only when the live table's stored SQL still matches the OLD shape. */
  detect: (currentTableSql: string) => boolean;
  /** Ordered DDL/DML, run with foreign_keys OFF inside a transaction. */
  steps: string[];
}

export const REBUILD_MIGRATIONS: RebuildMigration[] = [
  {
    table: "tasks",
    // Old shape carried `CHECK(source_system IN ('github','internal'))`.
    detect: (sql) => /source_system\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*source_system\s+IN/i.test(sql),
    steps: [
      // New tasks shape: base columns (source_system CHECK dropped; status CHECK
      // kept) + every column added by COLUMN_ADD_MIGRATIONS (iteration_id;
      // work_item_id — slice convergence C, cortex#1150). init.ts runs
      // COLUMN_ADD_MIGRATIONS BEFORE this rebuild, so on an old-shape DB both
      // added columns already exist on the live `tasks` table and the INSERT
      // below can copy them.
      `CREATE TABLE tasks_new (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        priority INTEGER NOT NULL DEFAULT 2,
        principal_id TEXT NOT NULL,
        source_system TEXT NOT NULL,
        source_url TEXT,
        source_external_id TEXT,
        related_refs_json TEXT,
        work_item_id TEXT,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK(status IN ('open','in_progress','done','cancelled')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        iteration_id TEXT REFERENCES iterations(id)
      )`,
      // Explicit column list (never SELECT *) so a shape mismatch errors loudly.
      `INSERT INTO tasks_new
         (id, title, description, priority, principal_id, source_system,
          source_url, source_external_id, related_refs_json, work_item_id,
          status, created_at, updated_at, iteration_id)
       SELECT
          id, title, description, priority, principal_id, source_system,
          source_url, source_external_id, related_refs_json, work_item_id,
          status, created_at, updated_at, iteration_id
       FROM tasks`,
      `DROP TABLE tasks`,
      `ALTER TABLE tasks_new RENAME TO tasks`,
      // Recreate the indexes (SCHEMA_SQL's + the iteration_id + work_item_id partners).
      `CREATE INDEX IF NOT EXISTS idx_tasks_status_priority_updated
         ON tasks(status, priority, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_iteration ON tasks(iteration_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_work_item ON tasks(work_item_id)`,
    ],
  },
];
