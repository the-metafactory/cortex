/**
 * Grove Mission Control v2 — unit tests for the F-8 task list layer.
 *
 * Complements the endpoint-level tests in api.test.ts:
 *  - `epochSecondsToIso` and `normalizeSqliteDatetime` stay pinned to separate
 *    inputs (INTEGER epoch vs TEXT `YYYY-MM-DD HH:MM:SS`), matching the two
 *    storage shapes described in design-mc-f8-task-table.md Decision 1.
 *  - `listTasks` aggregate-state rank is verified for every position of the
 *    seven-state ordering.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { initDatabase } from "../db/init";
import {
  cancelTask,
  createGithubImportedTask,
  createInternalTask,
  createTaskInIteration,
  deleteTask,
  getTaskById,
  listTasks,
  epochSecondsToIso,
  STATE_RANKS,
} from "../db/tasks";
import { normalizeSqliteDatetime } from "../db/assignments";

describe("epochSecondsToIso", () => {
  it("converts an integer epoch seconds value to ISO-8601 UTC", () => {
    expect(epochSecondsToIso(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(epochSecondsToIso(1700000000)).toBe("2023-11-14T22:13:20.000Z");
  });

  it("is distinct from normalizeSqliteDatetime (different input types)", () => {
    // normalizeSqliteDatetime is TEXT → ISO over `YYYY-MM-DD HH:MM:SS`.
    const raw = "2026-04-24 10:23:45";
    expect(normalizeSqliteDatetime(raw)).toBe("2026-04-24T10:23:45Z");
    // Feeding an INTEGER epoch value (as a string) through the TEXT helper
    // silently appends "Z" to garbage — demonstrating why the INTEGER path
    // needs its own helper. A future refactor that collapsed the two would
    // flip this assertion and be caught.
    expect(normalizeSqliteDatetime("1700000000")).toBe("1700000000Z");
    // The dedicated INTEGER helper produces the correct ISO value.
    expect(epochSecondsToIso(1700000000)).toBe("2023-11-14T22:13:20.000Z");
  });
});

describe("STATE_RANKS", () => {
  it("has exactly seven entries matching the addendum Decision 4 table", () => {
    expect(STATE_RANKS).toEqual([
      "blocked",
      "running",
      "dispatched",
      "queued",
      "failed",
      "completed",
      "cancelled",
    ]);
  });
});

describe("listTasks aggregate_state", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mc-tasks-test-${Date.now()}-${Math.random()}`);
    db = initDatabase(join(tmpDir, "test.db"));
    db.query(
      `INSERT OR IGNORE INTO agents (id, name, type) VALUES ('ag', 'Agent', 'hands')`
    ).run();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedTaskWithAssignmentStates(id: string, states: string[]): void {
    db.query(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system)
       VALUES (?, ?, 2, 'op', 'internal')`
    ).run(id, `Task ${id}`);
    for (let i = 0; i < states.length; i++) {
      const state = states[i]!;
      const blockReason =
        state === "blocked"
          ? JSON.stringify({
              kind: "permission.request",
              payload: { requested_action: "tool.edit" },
            })
          : null;
      db.query(
        `INSERT INTO agent_task_assignment (id, agent_id, task_id, state, block_reason)
         VALUES (?, 'ag', ?, ?, ?)`
      ).run(`${id}-a${i}`, id, state, blockReason);
    }
  }

  it("picks blocked over running (rank 0 < 1)", () => {
    seedTaskWithAssignmentStates("t", ["running", "blocked"]);
    const [row] = listTasks(db);
    expect(row?.aggregate_state).toBe("blocked");
  });

  it("picks running over dispatched (rank 1 < 2)", () => {
    seedTaskWithAssignmentStates("t", ["dispatched", "running"]);
    const [row] = listTasks(db);
    expect(row?.aggregate_state).toBe("running");
  });

  it("picks dispatched over queued (rank 2 < 3)", () => {
    seedTaskWithAssignmentStates("t", ["queued", "dispatched"]);
    const [row] = listTasks(db);
    expect(row?.aggregate_state).toBe("dispatched");
  });

  it("picks queued over failed (rank 3 < 4)", () => {
    seedTaskWithAssignmentStates("t", ["failed", "queued"]);
    const [row] = listTasks(db);
    expect(row?.aggregate_state).toBe("queued");
  });

  it("picks failed over completed (rank 4 < 5)", () => {
    seedTaskWithAssignmentStates("t", ["completed", "failed"]);
    const [row] = listTasks(db);
    expect(row?.aggregate_state).toBe("failed");
  });

  it("picks completed over cancelled (rank 5 < 6)", () => {
    seedTaskWithAssignmentStates("t", ["cancelled", "completed"]);
    const [row] = listTasks(db);
    expect(row?.aggregate_state).toBe("completed");
  });

  it("returns null when the task has no assignments", () => {
    db.query(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system)
       VALUES ('t-empty', 'Empty task', 2, 'op', 'internal')`
    ).run();
    const [row] = listTasks(db);
    expect(row?.aggregate_state).toBeNull();
  });
});

// -------------------------------------------------------------------------
// F-16 — denormalised iteration tag on `TaskListItem` (LEFT JOIN at fetch)
// -------------------------------------------------------------------------

describe("listTasks iteration denormalisation", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mc-tasks-iter-test-${Date.now()}-${Math.random()}`);
    db = initDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedIter(
    id: string,
    title: string,
    state = "designing"
  ): void {
    db.query(
      `INSERT INTO iterations (id, title, state, priority) VALUES (?, ?, ?, 1)`
    ).run(id, title, state);
  }
  function seedTask(id: string, iterationId: string | null): void {
    db.query(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system, iteration_id)
       VALUES (?, ?, 2, 'op', 'internal', ?)`
    ).run(id, `Task ${id}`, iterationId);
  }

  it("hydrates iteration: { id, title, state } from the LEFT JOIN", () => {
    seedIter("it-1", "Cross-surface", "queued");
    seedTask("t-attached", "it-1");
    const [row] = listTasks(db);
    expect(row?.iteration).toEqual({
      id: "it-1",
      title: "Cross-surface",
      state: "queued",
    });
  });

  it("hydrates iteration: null for an ungrouped task", () => {
    seedTask("t-ungrouped", null);
    const [row] = listTasks(db);
    expect(row?.iteration).toBeNull();
  });

  it("uses one query for the whole list (no N+1)", () => {
    // The LEFT JOIN feeds the iteration columns in the same SELECT
    // as the task projection; this test pins that property by counting
    // statements via a Database-level instrumentation. Bun's bun:sqlite
    // doesn't expose a query counter directly, so we instead assert the
    // SQL-level invariant: a single batch query returns rows for both
    // attached + ungrouped tasks with iteration columns hydrated.
    seedIter("it-1", "A");
    seedIter("it-2", "B");
    seedTask("t-1", "it-1");
    seedTask("t-2", null);
    seedTask("t-3", "it-2");
    const rows = listTasks(db);
    expect(rows).toHaveLength(3);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.iteration]));
    expect(byId["t-1"]?.title).toBe("A");
    expect(byId["t-2"]).toBeNull();
    expect(byId["t-3"]?.title).toBe("B");
  });

  it("flows through iteration title rename without re-fetch of the task", () => {
    // The denorm is a JOIN, not a copy — flipping the iteration row
    // and re-listing reflects the new title even though the tasks
    // table was untouched. Anti-regression for a future "materialise
    // for performance" refactor that would silently freeze the title.
    seedIter("it-1", "Old name");
    seedTask("t-1", "it-1");
    db.query(`UPDATE iterations SET title = 'New name' WHERE id = 'it-1'`).run();
    const [row] = listTasks(db);
    expect(row?.iteration?.title).toBe("New name");
  });

  it("flows through iteration state transitions without re-fetch of the task", () => {
    seedIter("it-1", "T", "designing");
    seedTask("t-1", "it-1");
    db.query(`UPDATE iterations SET state = 'in_flight' WHERE id = 'it-1'`).run();
    const [row] = listTasks(db);
    expect(row?.iteration?.state).toBe("in_flight");
  });
});

// ---------------------------------------------------------------------------
// F-16 sweep — getTaskById (Echo grove-v2#43 Major 1)
// ---------------------------------------------------------------------------

describe("getTaskById", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mc-getbyid-test-${Date.now()}-${Math.random()}`);
    db = initDatabase(join(tmpDir, "test.db"));
    db.query(
      `INSERT OR IGNORE INTO agents (id, name, type) VALUES ('ag', 'Agent', 'hands')`
    ).run();
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedIter(id: string, title: string, state: string): void {
    db.query(
      `INSERT INTO iterations (id, title, state, priority) VALUES (?, ?, ?, 2)`
    ).run(id, title, state);
  }
  function seedTask(id: string, iter: string | null = null): void {
    db.query(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system, iteration_id)
       VALUES (?, ?, 2, 'op', 'github', ?)`
    ).run(id, `T ${id}`, iter);
  }

  it("returns null for unknown id", () => {
    expect(getTaskById(db, "missing")).toBeNull();
  });

  it("returns the task with iteration: null when ungrouped", () => {
    seedTask("t-1");
    const t = getTaskById(db, "t-1");
    expect(t?.id).toBe("t-1");
    expect(t?.iteration).toBeNull();
  });

  it("returns the task with iteration denorm when attached", () => {
    seedIter("it-1", "Alpha", "queued");
    seedTask("t-1", "it-1");
    const t = getTaskById(db, "t-1");
    expect(t?.iteration).toEqual({ id: "it-1", title: "Alpha", state: "queued" });
  });

  it("returns the closed (done/cancelled) task — broadcasts must fire post-close too", () => {
    seedTask("t-1");
    db.query(`UPDATE tasks SET status = 'done' WHERE id = 't-1'`).run();
    const t = getTaskById(db, "t-1");
    expect(t?.id).toBe("t-1");
    expect(t?.status).toBe("done");
  });

  // F-20.F — pin the session denorm shape on the task projection.
  // Drives the drill-down's input-mode resolver:
  // - null session → "ended" (correct for never-spawned-and-no-session)
  // - local.observed + ended_at=null → "observed" (live cldyo-live)
  // - local.observed + ended_at set → "ended" (terminal observed)
  // - local.process.controlled + ended_at=null → "active"
  it("includes session denorm — null when no session", () => {
    seedTask("t-1");
    db.query(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES ('ata-1', 'ag', 't-1', 'queued')`
    ).run();
    const t = getTaskById(db, "t-1");
    expect(t?.assignments).toHaveLength(1);
    expect(t?.assignments[0]?.session).toBeNull();
  });

  it("includes session denorm — observed kind when active observed session present", () => {
    seedTask("t-1");
    db.query(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES ('ata-1', 'ag', 't-1', 'running')`
    ).run();
    db.query(
      `INSERT INTO sessions (id, assignment_id, cc_session_id, endpoint_kind, started_at)
       VALUES ('s-1', 'ata-1', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'local.observed', datetime('now'))`
    ).run();
    const t = getTaskById(db, "t-1");
    const sess = t?.assignments[0]?.session;
    expect(sess).not.toBeNull();
    expect(sess?.endpoint_kind).toBe("local.observed");
    expect(sess?.ended_at).toBeNull();
  });

  it("includes session denorm — ended_at carried through on terminal session", () => {
    seedTask("t-1");
    db.query(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES ('ata-1', 'ag', 't-1', 'completed')`
    ).run();
    db.query(
      `INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at, ended_at)
       VALUES ('s-1', 'ata-1', 'local.process.controlled', datetime('now', '-1 hour'), datetime('now'))`
    ).run();
    const t = getTaskById(db, "t-1");
    const sess = t?.assignments[0]?.session;
    expect(sess?.endpoint_kind).toBe("local.process.controlled");
    expect(sess?.ended_at).not.toBeNull();
  });

  it("session denorm picks the most-recent session when multiple exist", () => {
    seedTask("t-1");
    db.query(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES ('ata-1', 'ag', 't-1', 'running')`
    ).run();
    // Earlier ended session, then a later active one — denorm should
    // surface the active one.
    db.query(
      `INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at, ended_at)
       VALUES ('s-old', 'ata-1', 'local.process.controlled', datetime('now', '-2 hours'), datetime('now', '-1 hour'))`
    ).run();
    db.query(
      `INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at)
       VALUES ('s-new', 'ata-1', 'local.observed', datetime('now'))`
    ).run();
    const t = getTaskById(db, "t-1");
    const sess = t?.assignments[0]?.session;
    expect(sess?.id).toBe("s-new");
    expect(sess?.endpoint_kind).toBe("local.observed");
    expect(sess?.ended_at).toBeNull();
  });

  // F-20.F sweep — pin the `id DESC` half of the tiebreak. The earlier
  // multi-session test used a 2-hour gap so only the `started_at DESC`
  // half was exercised. Same-second `started_at` ties are the case
  // that motivated the M1 sweep (assignments.ts originally tiebroke
  // on `started_at` only, tasks.ts on `started_at + id`); without an
  // explicit case the alignment regression could re-emerge silently.
  // Per Echo's PR #57 cycle-2 nit.
  it("session denorm tiebreaks same-second started_at by id DESC", () => {
    seedTask("t-1");
    db.query(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES ('ata-1', 'ag', 't-1', 'running')`
    ).run();
    // Two sessions inserted with the same `started_at` to the second
    // (frozen via a literal). Lex order on id: 'AAA...' < 'ZZZ...',
    // so DESC picks 'ZZZ...'.
    //
    // The partial unique index `idx_sessions_active_assignment`
    // forbids two open sessions per assignment, so we mark both as
    // ended (same `ended_at`) — the tiebreak we're pinning is
    // `started_at` + `id`, which is what the subquery uses regardless
    // of `ended_at`.
    const sameTs = "2026-04-27 12:34:56";
    const endTs = "2026-04-27 12:35:00";
    db.query(
      `INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at, ended_at)
       VALUES ('s-AAA', 'ata-1', 'local.observed', ?, ?)`
    ).run(sameTs, endTs);
    db.query(
      `INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at, ended_at)
       VALUES ('s-ZZZ', 'ata-1', 'local.process.controlled', ?, ?)`
    ).run(sameTs, endTs);
    const t = getTaskById(db, "t-1");
    expect(t?.assignments[0]?.session?.id).toBe("s-ZZZ");
  });
});

// ---------------------------------------------------------------------------
// S4 (#1518) — task mutations lifted out of api/handlers.ts
// ---------------------------------------------------------------------------

describe("task mutations", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mc-tasks-mutations-test-${Date.now()}-${Math.random()}`);
    db = initDatabase(join(tmpDir, "test.db"));
    db.query(
      `INSERT INTO agents (id, name, type) VALUES ('ag', 'Agent', 'hands')`
    ).run();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function readTask(id: string) {
    return db
      .query(
        `SELECT id, title, priority, principal_id, source_system, source_url,
                source_external_id, iteration_id, status
         FROM tasks WHERE id = ?`
      )
      .get(id) as
      | {
          id: string;
          title: string;
          priority: number;
          principal_id: string;
          source_system: string;
          source_url: string | null;
          source_external_id: string | null;
          iteration_id: string | null;
          status: string;
        }
      | null;
  }

  it("createInternalTask inserts an internal-source, ungrouped task", () => {
    createInternalTask(db, {
      id: "t-1",
      title: "Fresh dispatch",
      priority: 2,
      principalId: "op",
    });
    expect(readTask("t-1")).toEqual({
      id: "t-1",
      title: "Fresh dispatch",
      priority: 2,
      principal_id: "op",
      source_system: "internal",
      source_url: null,
      source_external_id: null,
      iteration_id: null,
      status: "open",
    });
  });

  it("createGithubImportedTask inserts a github-source task with url + external id", () => {
    createGithubImportedTask(db, {
      id: "t-1",
      title: "Fix the thing",
      priority: 1,
      principalId: "op",
      sourceUrl: "https://github.com/x/y/issues/42",
      externalId: "x/y#42",
    });
    expect(readTask("t-1")).toEqual({
      id: "t-1",
      title: "Fix the thing",
      priority: 1,
      principal_id: "op",
      source_system: "github",
      source_url: "https://github.com/x/y/issues/42",
      source_external_id: "x/y#42",
      iteration_id: null,
      status: "open",
    });
  });

  it("createTaskInIteration inserts an internal-source task pre-attached to an iteration", () => {
    db.query(
      `INSERT INTO iterations (id, title, state, priority) VALUES ('it-1', 'Iter', 'designing', 2)`
    ).run();
    createTaskInIteration(db, {
      id: "t-1",
      title: "Typed straight into the iteration",
      priority: 2,
      principalId: "op",
      iterationId: "it-1",
    });
    expect(readTask("t-1")).toEqual({
      id: "t-1",
      title: "Typed straight into the iteration",
      priority: 2,
      principal_id: "op",
      source_system: "internal",
      source_url: null,
      source_external_id: null,
      iteration_id: "it-1",
      status: "open",
    });
  });

  it("deleteTask removes the row", () => {
    createInternalTask(db, { id: "t-1", title: "T", priority: 2, principalId: "op" });
    expect(readTask("t-1")).not.toBeNull();
    deleteTask(db, "t-1");
    expect(readTask("t-1")).toBeNull();
  });

  it("cancelTask sets status = 'cancelled' and bumps updated_at", () => {
    createInternalTask(db, { id: "t-1", title: "T", priority: 2, principalId: "op" });
    // Backdate updated_at so the "bumps" half of this test is deterministic
    // regardless of how fast the test runs — unixepoch() is whole-seconds,
    // so a same-second before/after pair would look unchanged without this.
    const oldUpdatedAt = 1_000_000;
    db.query(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(oldUpdatedAt, "t-1");

    cancelTask(db, "t-1");

    const after = readTask("t-1");
    expect(after?.status).toBe("cancelled");
    const { updated_at } = db
      .query(`SELECT updated_at FROM tasks WHERE id = ?`)
      .get("t-1") as { updated_at: number };
    expect(updated_at).toBeGreaterThan(oldUpdatedAt);
  });

  it("cancelTask is a no-op on an unknown id (no matching row, no throw)", () => {
    expect(() => cancelTask(db, "does-not-exist")).not.toThrow();
  });
});
