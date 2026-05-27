/**
 * Grove Mission Control v3 — Iteration planning surface (F-13).
 *
 * Mirrors the F-8 `db/tasks.ts` shape: row-typed reads at the boundary,
 * INTEGER epoch → ISO-8601 hydration, projection types tuned for the API
 * response. The schema is per `docs/design-mc-iteration-planning.md`
 * Decision 3; the lifecycle enum is per Decision 1; endpoint shapes per
 * Decision 8.
 *
 * Scope of THIS module (F-13 schema PR):
 *   - list / get / create / update / attach / detach
 *   - inbox = upstream-imported tasks not yet attached to any iteration
 *
 * Out of scope (deferred per the F-13 PR brief):
 *   - WS broadcast (`iteration.created` etc.) — kanban PR (F-14)
 *   - Drag-and-drop endpoints — kanban PR (F-14)
 *   - GitHub auto-import — F-17
 *   - PM-agent role — Phase G
 */

import type { Database } from "bun:sqlite";
import { epochSecondsToIso } from "./tasks";
import {
  ITERATION_STATES,
  TRANSITIONS,
  type IterationState,
} from "../lib/iteration-transitions";

/**
 * Per Echo grove-v2#42 (Major 1) — the iteration lifecycle vocabulary
 * and transition matrix are owned by `lib/iteration-transitions.ts`
 * (a pure-data module with zero `db/` and zero React imports). Both
 * the SQL CHECK source (this file) and the dashboard validator
 * (`dashboard-v2/lib/iteration-status.ts`) import from there. The
 * previous duplication + "sync test" pattern was undetectable for
 * drift; the single source of truth removes the failure mode entirely.
 *
 * Re-exported here so existing `import { ITERATION_STATES, IterationState }
 * from "../db/iterations"` call sites stay green.
 */
export { ITERATION_STATES, type IterationState };

/** Recognised source systems (Decision 7 — GitHub in v1, others later). */
export type IterationSourceSystem = "github" | "jira" | "linear" | null;

/**
 * Default cap on inbox results (Decision 10 Q3 — "lean: 100, server-side").
 *
 * Mirrors the spirit of `TASKS_QUERY_LIMIT` in db/tasks.ts but at a tighter
 * 100 cap — the inbox is a streaming firehose of upstream issues, not the
 * working set, so the server pre-trims aggressively. Operators who want
 * the older tail use a paginated load (deferred to F-14 once the kanban
 * surface lands).
 */
export const INBOX_DEFAULT_LIMIT = 100;
/** Hard absolute cap so a malicious `?limit=` cannot DoS the server. */
export const INBOX_MAX_LIMIT = 500;

// ---------------------------------------------------------------------------
// Row + projection types
// ---------------------------------------------------------------------------

/** Verbatim shape of a row in the `iterations` table. */
export interface IterationRow {
  id: string;
  title: string;
  body: string | null;
  imported_body: string | null;
  priority: number;
  state: IterationState;
  source_system: string | null;
  source_url: string | null;
  source_parent_ref: string | null;
  imported_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * Iteration projection for the kanban list endpoint.
 *
 * Adds `task_count` (rolled up from `tasks.iteration_id`) and hydrates
 * INTEGER epoch columns to ISO-8601 UTC at the boundary. Mirrors the
 * F-8 `TaskListItem` shape (timestamps as ISO strings on the wire).
 */
export interface IterationListItem {
  id: string;
  title: string;
  priority: number;
  state: IterationState;
  source_system: string | null;
  source_url: string | null;
  source_parent_ref: string | null;
  /** Count of tasks attached to this iteration (any status). */
  task_count: number;
  /** ISO-8601 UTC. NULL for internal-only iterations. */
  imported_at: string | null;
  /** ISO-8601 UTC. */
  created_at: string;
  /** ISO-8601 UTC. */
  updated_at: string;
}

/** Detail projection — header fields + attached tasks (id+title+status). */
export interface IterationDetailTaskRow {
  id: string;
  title: string;
  /** From `tasks.status` (the legacy 4-state per-task funnel). */
  status: string;
  priority: number;
}

export interface IterationDetail extends IterationListItem {
  /** Full markdown body (Grove-owned, post-import edits land here). */
  body: string | null;
  /** Snapshot at import time. NULL for internal-only iterations. */
  imported_body: string | null;
  tasks: IterationDetailTaskRow[];
}

/**
 * Per Echo grove-v2#42 (Major 3) — narrow an `IterationDetail` to the
 * header-only `IterationListItem` shape. Used by the broadcast layer
 * to keep `iteration.created` / `iteration.updated` frames tight: the
 * kanban renderer only ever reads list-item fields, so shipping the
 * 50 KB body + tasks array on every autosave is wasted bandwidth and
 * a runtime shape lie at the kanban consumer (the cast there used to
 * say `as IterationListItem` while the wire actually carried full
 * detail). The detail surface gets its own narrower
 * `iteration.detail_updated` event with the full payload.
 */
export function toIterationListItem(
  detail: IterationDetail
): IterationListItem {
  return {
    id: detail.id,
    title: detail.title,
    priority: detail.priority,
    state: detail.state,
    source_system: detail.source_system,
    source_url: detail.source_url,
    source_parent_ref: detail.source_parent_ref,
    task_count: detail.task_count,
    imported_at: detail.imported_at,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
  };
}

/**
 * Inbox row — a task imported from upstream that isn't attached to any
 * iteration yet (Decision 1 — `inbox` is the staging lane). Reuses the
 * existing `tasks` table; an "inbox" task is one with `iteration_id IS
 * NULL` AND `source_system <> 'internal'` AND a non-cancelled status.
 *
 * The internal-source filter is what the design spec means by "upstream
 * issues not yet linked to an iteration" — principal-typed internal tasks
 * are not part of the import-from-upstream funnel and don't render in
 * the inbox lane.
 */
export interface InboxItem {
  id: string;
  title: string;
  priority: number;
  status: string;
  source_system: string;
  source_url: string | null;
  source_external_id: string | null;
  /** ISO-8601 UTC. */
  created_at: string;
  /** ISO-8601 UTC. */
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export interface ListIterationsOptions {
  /** Filter to a single state. Omit to list all non-cancelled iterations. */
  state?: IterationState;
}

/**
 * List iterations (kanban data source).
 *
 * Default: returns every iteration EXCEPT `cancelled` (the column is
 * archive-only on the board; rendering it would push the visible columns
 * off-screen). Pass `state` to scope.
 *
 * Sort: `priority ASC, updated_at DESC, id ASC` — mirrors F-8's tasks
 * ordering so the board feels like the table; resolves ties with id ASC
 * for deterministic order across calls.
 */
export function listIterations(
  db: Database,
  opts: ListIterationsOptions = {}
): IterationListItem[] {
  const params: unknown[] = [];
  let where: string;
  if (opts.state) {
    where = `WHERE i.state = ?`;
    params.push(opts.state);
  } else {
    where = `WHERE i.state != 'cancelled'`;
  }

  const rows = db
    .query(
      `SELECT
         i.id, i.title, i.priority, i.state,
         i.source_system, i.source_url, i.source_parent_ref,
         i.imported_at, i.created_at, i.updated_at,
         (SELECT COUNT(*) FROM tasks t WHERE t.iteration_id = i.id) AS task_count
       FROM iterations i
       ${where}
       ORDER BY i.priority ASC, i.updated_at DESC, i.id ASC`
    )
    .all(...(params as never[])) as (IterationRow & { task_count: number })[];

  return rows.map(hydrateListItem);
}

/**
 * Iteration detail (header + tasks). Returns `null` when the iteration
 * id does not exist — the API handler turns that into a 404.
 */
export function getIteration(db: Database, id: string): IterationDetail | null {
  const row = db
    .query(
      `SELECT id, title, body, imported_body, priority, state,
              source_system, source_url, source_parent_ref,
              imported_at, created_at, updated_at
       FROM iterations WHERE id = ?`
    )
    .get(id) as IterationRow | null;
  if (!row) return null;

  const taskRows = db
    .query(
      `SELECT id, title, status, priority
       FROM tasks
       WHERE iteration_id = ?
       ORDER BY priority ASC, updated_at DESC, id ASC`
    )
    .all(id) as IterationDetailTaskRow[];

  const taskCount = taskRows.length;
  return {
    ...hydrateListItem({ ...row, task_count: taskCount }),
    body: row.body,
    imported_body: row.imported_body,
    tasks: taskRows,
  };
}

export interface ListInboxOptions {
  /** e.g. 'github'. Omit to list every non-internal source. */
  source?: string;
  /** Caller cap. Bounded by INBOX_MAX_LIMIT. Defaults to INBOX_DEFAULT_LIMIT. */
  limit?: number;
}

/**
 * List inbox items — upstream-imported tasks that are not attached to
 * any iteration.
 *
 * Filtering rules (Decision 1):
 *   - `iteration_id IS NULL` (not yet promoted into a iteration)
 *   - `source_system != 'internal'` (principal-typed internal tasks aren't
 *     in the upstream funnel; they live in the iteration body / direct add)
 *   - `status != 'cancelled'` (the inbox is alive-only; cancelled imports
 *     stay in the audit trail but disappear from the lane)
 *
 * Order: most-recent first (`updated_at DESC, id ASC`).
 */
export function listInboxItems(
  db: Database,
  opts: ListInboxOptions = {}
): InboxItem[] {
  const requestedLimit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : INBOX_DEFAULT_LIMIT;
  const limit = Math.min(requestedLimit, INBOX_MAX_LIMIT);

  const params: unknown[] = [];
  let sourceClause = "";
  if (opts.source) {
    sourceClause = "AND source_system = ?";
    params.push(opts.source);
  }

  const rows = db
    .query(
      `SELECT id, title, priority, status,
              source_system, source_url, source_external_id,
              created_at, updated_at
       FROM tasks
       WHERE iteration_id IS NULL
         AND source_system != 'internal'
         AND status != 'cancelled'
         ${sourceClause}
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`
    )
    .all(...(params as never[]), limit) as {
      id: string;
      title: string;
      priority: number;
      status: string;
      source_system: string;
      source_url: string | null;
      source_external_id: string | null;
      created_at: number;
      updated_at: number;
    }[];

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    priority: r.priority,
    status: r.status,
    source_system: r.source_system,
    source_url: r.source_url,
    source_external_id: r.source_external_id,
    created_at: epochSecondsToIso(r.created_at),
    updated_at: epochSecondsToIso(r.updated_at),
  }));
}

// ---------------------------------------------------------------------------
// Write paths
// ---------------------------------------------------------------------------

export interface CreateIterationInput {
  id: string;
  title: string;
  body?: string | null;
  imported_body?: string | null;
  priority?: number;
  state?: IterationState;
  source_system?: string | null;
  source_url?: string | null;
  source_parent_ref?: string | null;
  imported_at?: number | null;
}

/**
 * Insert a new iteration row. The caller supplies the id (mirrors
 * `db/tasks.ts` and `db/sessions.ts` patterns where the id is generated
 * upstream via `events.generateId`). `state` defaults to the schema's
 * `'inbox'` default; `priority` defaults to 2.
 *
 * Returns the just-inserted row in canonical hydrated shape (same shape
 * as `getIteration`'s header without the tasks list).
 */
export function createIteration(
  db: Database,
  input: CreateIterationInput
): IterationRow {
  db.query(
    `INSERT INTO iterations
       (id, title, body, imported_body, priority, state,
        source_system, source_url, source_parent_ref, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.title,
    input.body ?? null,
    input.imported_body ?? null,
    input.priority ?? 2,
    input.state ?? "inbox",
    input.source_system ?? null,
    input.source_url ?? null,
    input.source_parent_ref ?? null,
    input.imported_at ?? null
  );
  const row = db
    .query(
      `SELECT id, title, body, imported_body, priority, state,
              source_system, source_url, source_parent_ref,
              imported_at, created_at, updated_at
       FROM iterations WHERE id = ?`
    )
    .get(input.id) as IterationRow;
  return row;
}

/**
 * Patchable header fields. State transitions go through the same path
 * but the API layer is responsible for validating the move via
 * `dashboard-v2/lib/iteration-status.ts#canTransition` first.
 *
 * Source columns are intentionally NOT patchable from this API path —
 * they're set at import time and frozen (Decision 1, Decision 9). Future
 * principal-driven re-import is a separate explicit action.
 */
export interface UpdateIterationPatch {
  title?: string;
  body?: string | null;
  priority?: number;
  state?: IterationState;
}

/**
 * Apply a patch to an iteration. Returns the updated row, or `null` if
 * no row exists with that id.
 *
 * Touches `updated_at` whenever any field changes (mirrors the `tasks`
 * table's curation paths in `api/handlers.ts` which set `updated_at =
 * unixepoch()` on every mutation).
 */
export function updateIteration(
  db: Database,
  id: string,
  patch: UpdateIterationPatch
): IterationRow | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    params.push(patch.title);
  }
  if (patch.body !== undefined) {
    sets.push("body = ?");
    params.push(patch.body);
  }
  if (patch.priority !== undefined) {
    sets.push("priority = ?");
    params.push(patch.priority);
  }
  if (patch.state !== undefined) {
    sets.push("state = ?");
    params.push(patch.state);
  }
  if (sets.length === 0) {
    // No-op patch — return the row as-is rather than touching updated_at.
    return (
      (db
        .query(
          `SELECT id, title, body, imported_body, priority, state,
                  source_system, source_url, source_parent_ref,
                  imported_at, created_at, updated_at
           FROM iterations WHERE id = ?`
        )
        .get(id) as IterationRow | null) ?? null
    );
  }
  sets.push("updated_at = unixepoch()");
  params.push(id);
  const result = db
    .query(`UPDATE iterations SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(params as never[]));
  if (result.changes === 0) return null;
  return (
    (db
      .query(
        `SELECT id, title, body, imported_body, priority, state,
                source_system, source_url, source_parent_ref,
                imported_at, created_at, updated_at
         FROM iterations WHERE id = ?`
      )
      .get(id) as IterationRow | null) ?? null
  );
}

/**
 * F-17 — find an iteration by its `source_parent_ref`. Returns the
 * canonical row when one exists, otherwise null.
 *
 * Used by the GitHub auto-import path (`api/iteration-import.ts`) as
 * the idempotency check before creating a Grove iteration row for an
 * `iteration`-labelled GitHub parent issue. Per
 * `docs/design-mc-iteration-planning.md` Decision 1 ("Grove owns the
 * lifecycle. Source is import-only.") the check is a `WHERE
 * source_system = ? AND source_parent_ref = ?` exact match — the
 * canonical ref string `owner/repo#N` is the dedup key (mirrors F-12b's
 * `tasks.source_external_id` dedup).
 *
 * Decision 1 + 9 (no write-back) imply the lookup is read-only and
 * never tries to reconcile mismatches between the upstream and the
 * stored row — the principal's edits are sovereign once import landed.
 */
export function findIterationBySourceParentRef(
  db: Database,
  sourceSystem: string,
  sourceParentRef: string
): IterationRow | null {
  return (
    (db
      .query(
        `SELECT id, title, body, imported_body, priority, state,
                source_system, source_url, source_parent_ref,
                imported_at, created_at, updated_at
         FROM iterations
         WHERE source_system = ? AND source_parent_ref = ?
         LIMIT 1`
      )
      .get(sourceSystem, sourceParentRef) as IterationRow | null) ?? null
  );
}

/**
 * F-17 — refresh the audit-only `imported_body` snapshot for an
 * existing iteration row WITHOUT touching the principal-editable
 * `body`, `title`, `priority`, or `state` columns.
 *
 * Per `docs/design-mc-iteration-planning.md` Decision 9 ("Source is
 * upstream-only. No write-back, ever.") the in-Grove `body` /
 * principal edits are sovereign — a subsequent `issues.edited` upstream
 * webhook MUST NOT clobber them. This helper exists so the auto-import
 * path can keep the audit snapshot fresh while leaving the live row
 * the principal sees in the dashboard exactly as they last saved it.
 *
 * Touches `updated_at` so the kanban re-sorts (the snapshot refresh is
 * still a real mutation; the principal can see "the upstream issue
 * changed" implicitly via the row moving).
 *
 * Returns true when the row was found and the snapshot updated, false
 * when the iteration id is unknown.
 */
export function updateIterationImportedBody(
  db: Database,
  id: string,
  importedBody: string | null
): boolean {
  const result = db
    .query(
      `UPDATE iterations
       SET imported_body = ?, updated_at = unixepoch()
       WHERE id = ?`
    )
    .run(importedBody, id);
  return result.changes > 0;
}

/**
 * F-15 sweep — bump `iterations.updated_at` to the current epoch for
 * the given id. Used by attach/detach call sites that need to re-sort
 * the kanban after a side mutation (a tasks-table write doesn't touch
 * the iteration row by itself).
 *
 * Per Echo grove-v2#42 (Nit 1) — the `UPDATE iterations SET updated_at
 * = unixepoch() WHERE id = ?` idiom used to be inlined in two
 * handler.ts call sites. This helper is the single source of truth for
 * the timestamp formula; if `unixepoch()` is ever swapped for
 * `strftime` it changes here only.
 *
 * Returns true when the row was found and touched, false when the id
 * is unknown.
 */
export function touchIteration(db: Database, id: string): boolean {
  const result = db
    .query(`UPDATE iterations SET updated_at = unixepoch() WHERE id = ?`)
    .run(id);
  return result.changes > 0;
}

/**
 * Attach an existing task to an iteration.
 *
 * Cardinality is 1:N (Decision 3 — one iteration ↔ many tasks; one task
 * has at most one iteration). This sets `tasks.iteration_id` directly;
 * a task can be re-attached by calling this again with a different
 * iteration id. Per Decision 3 a task contributing to two iterations is
 * "the principal's signal to clone, not to model nesting" — there's no
 * many-to-many join table to populate.
 *
 * Returns true when the task row was found and updated, false when the
 * task id is unknown (caller surfaces 404). FK enforces that the
 * iteration id exists.
 */
export function attachTask(
  db: Database,
  iterationId: string,
  taskId: string
): boolean {
  const result = db
    .query(
      `UPDATE tasks SET iteration_id = ?, updated_at = unixepoch() WHERE id = ?`
    )
    .run(iterationId, taskId);
  return result.changes > 0;
}

/**
 * F-15 — read the current `iteration_id` (or `null`) for a task, plus
 * a tiny existence flag. Used by the attach endpoint to enforce the
 * 1:N invariant before mutating: per Decision 3 a task that contributes
 * to two iterations is the principal's signal to clone, not to model
 * nesting — so attaching a task that's already attached elsewhere is a
 * 409 with the existing iteration id, not a silent overwrite.
 *
 * Returns:
 *   - `null` when the task id is unknown (caller surfaces 404).
 *   - `{ iterationId: null }` when the task exists but isn't attached.
 *   - `{ iterationId: '...' }` when the task is attached.
 */
export function getTaskIterationLink(
  db: Database,
  taskId: string
): { iterationId: string | null } | null {
  const row = db
    .query(`SELECT iteration_id FROM tasks WHERE id = ?`)
    .get(taskId) as { iteration_id: string | null } | null;
  if (!row) return null;
  return { iterationId: row.iteration_id };
}

/**
 * Detach a task from any iteration (sets `iteration_id = NULL`). The
 * task row is preserved — detach is "unlink", not "delete".
 *
 * Returns true when the task row was found, false otherwise.
 */
export function detachTask(db: Database, taskId: string): boolean {
  const result = db
    .query(
      `UPDATE tasks SET iteration_id = NULL, updated_at = unixepoch() WHERE id = ?`
    )
    .run(taskId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// F-15 — server-side transition validator
// ---------------------------------------------------------------------------
//
// The dashboard owns its own copy of this matrix in
// `dashboard-v2/lib/iteration-status.ts` (different layer, can't share
// imports — the dashboard bundles for the browser via `bun build`,
// pulling DB code into that bundle would drag `bun:sqlite` into a
// browser target). The two matrices MUST stay identical; the
// `iteration-transition-sync.test.ts` (added in F-15) walks every cell
// of both matrices and asserts they agree.
//
// Why server-side at all? PATCH /api/iterations/:id is the only path
// that can move state. Trusting the client (the dashboard) to gate the
// transition would mean a hand-rolled curl could bypass the lifecycle.
// The handler calls `canTransitionServer` before invoking
// `updateIteration` and returns 400 on a rejected move with the legal
// next-states in the message — so the principal sees the friendlier
// "queued → designing isn't legal; allowed: in_flight, designing,
// cancelled" instead of an opaque 500.
//
// Decision 10 Q1 — principal-driven `done` from non-`in_flight`/non-
// `blocked` states is rejected here. F-15 keeps the matrix tight; the
// override is a Phase G feature with its own threat model. The error
// message names `cancel` as the alternative for operators who hit the
// wrong door.
//
// Per Echo grove-v2#42 (Major 1) — the matrix used to be redeclared
// here as `SERVER_TRANSITIONS`. It now lives in
// `lib/iteration-transitions.ts` and is the single source of truth
// shared with the dashboard validator. These wrappers stay so existing
// `canTransitionServer` / `nextStatesServer` import sites keep working.

/** True iff `proposed` is a legal next state from `current`. */
export function canTransitionServer(
  current: IterationState,
  proposed: IterationState
): boolean {
  // TS narrows TRANSITIONS[current] to a Set when `current` is a known
  // IterationState; the `!allowed` guards remain load-bearing for
  // forward-compat if the union expands.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  const allowed = TRANSITIONS[current];
  if (!allowed) return false;
  return allowed.has(proposed);
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
}

/** Enumerate the legal next states from `current`. Order is matrix-insertion. */
export function nextStatesServer(current: IterationState): IterationState[] {
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  const allowed = TRANSITIONS[current];
  if (!allowed) return [];
  return [...allowed];
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hydrateListItem(
  row: IterationRow & { task_count: number }
): IterationListItem {
  return {
    id: row.id,
    title: row.title,
    priority: row.priority,
    state: row.state,
    source_system: row.source_system,
    source_url: row.source_url,
    source_parent_ref: row.source_parent_ref,
    task_count: row.task_count,
    imported_at:
      row.imported_at === null
        ? null
        : epochSecondsToIso(row.imported_at),
    created_at: epochSecondsToIso(row.created_at),
    updated_at: epochSecondsToIso(row.updated_at),
  };
}
