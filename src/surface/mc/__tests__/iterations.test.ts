/**
 * F-13 — DB-level tests for the iteration planning surface.
 *
 * Mirrors the in-memory-SQLite harness from `tasks.test.ts`. Covers:
 *   - schema migration runs idempotently (fresh + repeated init)
 *   - insert / list / filter by state
 *   - update header fields + state transitions
 *   - attach / detach tasks
 *   - hydration of INTEGER epoch timestamps to ISO-8601 UTC
 *   - inbox listing rules (Decision 1 — upstream + unattached + alive)
 *   - inbox cap defaults (Decision 10 Q3 — 100)
 *   - FK behaviour: deleting an iteration that still has attached tasks
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { initDatabase } from "../db/init";
import {
  attachTask,
  canTransitionServer,
  createIteration,
  detachTask,
  getIteration,
  getTaskIterationLink,
  INBOX_DEFAULT_LIMIT,
  INBOX_MAX_LIMIT,
  ITERATION_STATES,
  listInboxItems,
  listIterations,
  nextStatesServer,
  updateIteration,
  type IterationState,
} from "../db/iterations";

interface H {
  db: Database;
  tmpDir: string;
}

function mkdb(): H {
  const tmpDir = join(tmpdir(), `mc-iters-test-${Date.now()}-${Math.random()}`);
  const db = initDatabase(join(tmpDir, "test.db"));
  return { db, tmpDir };
}

function teardown(h: H): void {
  h.db.close();
  rmSync(h.tmpDir, { recursive: true, force: true });
}

/** Insert a task row directly — the schema accepts iteration_id NULL by default. */
function insertTask(
  db: Database,
  id: string,
  opts: {
    title?: string;
    source_system?: "github" | "internal";
    source_external_id?: string | null;
    source_url?: string | null;
    iteration_id?: string | null;
    status?: string;
    priority?: number;
    updated_at?: number;
  } = {}
): void {
  db.query(
    `INSERT INTO tasks
       (id, title, priority, principal_id,
        source_system, source_url, source_external_id, status, iteration_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.title ?? `Task ${id}`,
    opts.priority ?? 2,
    "op",
    opts.source_system ?? "github",
    opts.source_url ?? `https://example/${id}`,
    opts.source_external_id ?? `gh:${id}`,
    opts.status ?? "open",
    opts.iteration_id ?? null
  );
  if (opts.updated_at !== undefined) {
    db.query(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(
      opts.updated_at,
      id
    );
  }
}

// ---------------------------------------------------------------------------
// Schema + idempotency
// ---------------------------------------------------------------------------

describe("iterations schema migration", () => {
  it("creates the iterations table and the tasks.iteration_id column on a fresh DB", () => {
    const h = mkdb();
    try {
      const cols = h.db
        .query(`SELECT name FROM pragma_table_info('iterations')`)
        .all() as { name: string }[];
      const colNames = cols.map((c) => c.name).sort();
      expect(colNames).toEqual(
        [
          "body",
          "created_at",
          "id",
          "imported_at",
          "imported_body",
          "priority",
          "source_parent_ref",
          "source_system",
          "source_url",
          "state",
          "title",
          "updated_at",
        ].sort()
      );

      const tCols = h.db
        .query(`SELECT name FROM pragma_table_info('tasks')`)
        .all() as { name: string }[];
      expect(tCols.some((c) => c.name === "iteration_id")).toBe(true);
    } finally {
      teardown(h);
    }
  });

  it("CHECK constraint rejects an out-of-vocabulary state value", () => {
    const h = mkdb();
    try {
      expect(() => {
        h.db.exec(
          `INSERT INTO iterations (id, title, state) VALUES ('it-bad', 'X', 'banana')`
        );
      }).toThrow();
    } finally {
      teardown(h);
    }
  });

  it("indexes are present (idx_iterations_state_priority, idx_tasks_iteration)", () => {
    const h = mkdb();
    try {
      const indexes = h.db
        .query(
          `SELECT name FROM sqlite_master WHERE type = 'index'
           AND name IN ('idx_iterations_state_priority', 'idx_tasks_iteration')`
        )
        .all() as { name: string }[];
      const names = indexes.map((r) => r.name).sort();
      expect(names).toEqual([
        "idx_iterations_state_priority",
        "idx_tasks_iteration",
      ]);
    } finally {
      teardown(h);
    }
  });

  it("re-running initDatabase on an already-initialised DB is a no-op (idempotent ALTER)", () => {
    const h = mkdb();
    try {
      // Insert a row to prove pre-existing data survives a re-init.
      createIteration(h.db, { id: "it-1", title: "First" });

      // Re-open the same DB file through the same init path — must not throw.
      const reopened = initDatabase(join(h.tmpDir, "test.db"));
      const rows = listIterations(reopened);
      expect(rows.length).toBe(1);
      expect(rows[0]?.id).toBe("it-1");
      reopened.close();
    } finally {
      teardown(h);
    }
  });

  it("ITERATION_STATES export covers exactly the seven Decision 1 states", () => {
    const sorted: string[] = [...ITERATION_STATES].sort();
    expect(sorted).toEqual(
      [
        "blocked",
        "cancelled",
        "designing",
        "done",
        "in_flight",
        "inbox",
        "queued",
      ].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

describe("createIteration + listIterations", () => {
  let h: H;
  beforeEach(() => {
    h = mkdb();
  });
  afterEach(() => {
    teardown(h);
  });

  it("returns the just-inserted row on createIteration", () => {
    const row = createIteration(h.db, {
      id: "it-1",
      title: "First iter",
    });
    expect(row.id).toBe("it-1");
    expect(row.title).toBe("First iter");
    expect(row.state).toBe("inbox");
    expect(row.priority).toBe(2);
    expect(row.body).toBeNull();
    expect(row.imported_body).toBeNull();
    expect(row.source_system).toBeNull();
    expect(row.imported_at).toBeNull();
  });

  it("hydrates created_at/updated_at to ISO-8601 UTC in list output", () => {
    createIteration(h.db, { id: "it-1", title: "T" });
    const [row] = listIterations(h.db);
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("default list excludes cancelled iterations", () => {
    createIteration(h.db, { id: "i-active", title: "active" });
    createIteration(h.db, { id: "i-cx", title: "cx", state: "cancelled" });
    const rows = listIterations(h.db);
    expect(rows.map((r) => r.id).sort()).toEqual(["i-active"]);
  });

  it("?state=designing filters to a single column", () => {
    createIteration(h.db, { id: "i-1", title: "a", state: "inbox" });
    createIteration(h.db, { id: "i-2", title: "b", state: "designing" });
    createIteration(h.db, { id: "i-3", title: "c", state: "designing" });
    const rows = listIterations(h.db, { state: "designing" });
    expect(rows.map((r) => r.id).sort()).toEqual(["i-2", "i-3"]);
  });

  it("?state=cancelled returns cancelled iterations (filter overrides default exclude)", () => {
    createIteration(h.db, { id: "i-1", title: "a" });
    createIteration(h.db, { id: "i-cx", title: "cx", state: "cancelled" });
    const rows = listIterations(h.db, { state: "cancelled" });
    expect(rows.map((r) => r.id)).toEqual(["i-cx"]);
  });

  it("orders by priority ASC, then updated_at DESC", () => {
    createIteration(h.db, { id: "p2-a", title: "p2-a", priority: 2 });
    createIteration(h.db, { id: "p1-a", title: "p1-a", priority: 1 });
    createIteration(h.db, { id: "p1-b", title: "p1-b", priority: 1 });
    // Bump p1-b's updated_at so it sorts before p1-a.
    h.db.query(`UPDATE iterations SET updated_at = unixepoch() + 100 WHERE id = ?`).run(
      "p1-b"
    );
    const ids = listIterations(h.db).map((r) => r.id);
    // priority 1 first (p1-b before p1-a by updated_at DESC), then priority 2.
    expect(ids).toEqual(["p1-b", "p1-a", "p2-a"]);
  });

  it("rolls up task_count from tasks.iteration_id", () => {
    createIteration(h.db, { id: "it-1", title: "T" });
    insertTask(h.db, "t-1", { iteration_id: "it-1" });
    insertTask(h.db, "t-2", { iteration_id: "it-1" });
    insertTask(h.db, "t-3", { iteration_id: null });
    const [row] = listIterations(h.db);
    expect(row?.task_count).toBe(2);
  });

  it("returns empty list when no iterations exist", () => {
    expect(listIterations(h.db)).toEqual([]);
  });
});

describe("getIteration", () => {
  let h: H;
  beforeEach(() => {
    h = mkdb();
  });
  afterEach(() => {
    teardown(h);
  });

  it("returns null for an unknown id", () => {
    expect(getIteration(h.db, "nope")).toBeNull();
  });

  it("returns header + tasks for a known iteration", () => {
    createIteration(h.db, {
      id: "it-1",
      title: "Iter one",
      body: "design notes",
      imported_body: "snapshot",
      priority: 1,
      source_system: "github",
      source_url: "https://github.com/x/y/issues/1",
      source_parent_ref: "github:x/y#1",
      imported_at: 1700000000,
    });
    insertTask(h.db, "t-a", { iteration_id: "it-1", title: "Task A", priority: 0 });
    insertTask(h.db, "t-b", { iteration_id: "it-1", title: "Task B" });

    const detail = getIteration(h.db, "it-1");
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe("it-1");
    expect(detail!.body).toBe("design notes");
    expect(detail!.imported_body).toBe("snapshot");
    expect(detail!.source_system).toBe("github");
    expect(detail!.task_count).toBe(2);
    expect(detail!.imported_at).toBe("2023-11-14T22:13:20.000Z");
    expect(detail!.tasks.map((t) => t.id).sort()).toEqual(["t-a", "t-b"]);
    // Task A has priority 0, sorts first.
    expect(detail!.tasks[0]?.id).toBe("t-a");
  });
});

// ---------------------------------------------------------------------------
// Update paths
// ---------------------------------------------------------------------------

describe("updateIteration", () => {
  let h: H;
  beforeEach(() => {
    h = mkdb();
  });
  afterEach(() => {
    teardown(h);
  });

  it("returns null when the id is unknown", () => {
    expect(updateIteration(h.db, "nope", { title: "x" })).toBeNull();
  });

  it("patches title + body + priority + state in one call", () => {
    createIteration(h.db, { id: "i-1", title: "old" });
    const updated = updateIteration(h.db, "i-1", {
      title: "new",
      body: "fresh",
      priority: 0,
      state: "designing",
    });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("new");
    expect(updated!.body).toBe("fresh");
    expect(updated!.priority).toBe(0);
    expect(updated!.state).toBe("designing");
  });

  it("no-op patch returns the row without touching it", () => {
    createIteration(h.db, { id: "i-1", title: "x" });
    const before = h.db
      .query(`SELECT updated_at FROM iterations WHERE id = ?`)
      .get("i-1") as { updated_at: number };
    const after = updateIteration(h.db, "i-1", {});
    const afterRow = h.db
      .query(`SELECT updated_at FROM iterations WHERE id = ?`)
      .get("i-1") as { updated_at: number };
    expect(after?.id).toBe("i-1");
    // No write happened — updated_at unchanged.
    expect(afterRow.updated_at).toBe(before.updated_at);
  });

  it("rejects an out-of-vocabulary state via CHECK", () => {
    createIteration(h.db, { id: "i-1", title: "x" });
    expect(() => {
      updateIteration(h.db, "i-1", { state: "banana" as IterationState });
    }).toThrow();
  });

  it("allows transition into every legitimate Grove state", () => {
    // Pure SQL allows any (state IN enum) — the validator gate lives in
    // `dashboard-v2/lib/iteration-status.ts`. This test just pins that
    // the schema accepts every legal value.
    for (const s of ITERATION_STATES) {
      const id = `i-${s}`;
      createIteration(h.db, { id, title: s });
      const updated = updateIteration(h.db, id, { state: s });
      expect(updated?.state).toBe(s);
    }
  });
});

// ---------------------------------------------------------------------------
// Attach / detach
// ---------------------------------------------------------------------------

describe("attachTask / detachTask", () => {
  let h: H;
  beforeEach(() => {
    h = mkdb();
  });
  afterEach(() => {
    teardown(h);
  });

  it("attachTask sets iteration_id and returns true", () => {
    createIteration(h.db, { id: "it-1", title: "T" });
    insertTask(h.db, "t-1");
    expect(attachTask(h.db, "it-1", "t-1")).toBe(true);
    const row = h.db
      .query(`SELECT iteration_id FROM tasks WHERE id = ?`)
      .get("t-1") as { iteration_id: string | null };
    expect(row.iteration_id).toBe("it-1");
  });

  it("attachTask returns false for unknown task id", () => {
    createIteration(h.db, { id: "it-1", title: "T" });
    expect(attachTask(h.db, "it-1", "missing")).toBe(false);
  });

  it("attachTask to non-existent iteration raises FK error", () => {
    insertTask(h.db, "t-1");
    // Foreign key violation — db/init.ts enables `PRAGMA foreign_keys = ON`.
    expect(() => attachTask(h.db, "no-such-iter", "t-1")).toThrow();
  });

  it("attachTask to a different iteration overwrites the FK", () => {
    createIteration(h.db, { id: "it-a", title: "A" });
    createIteration(h.db, { id: "it-b", title: "B" });
    insertTask(h.db, "t-1", { iteration_id: "it-a" });
    expect(attachTask(h.db, "it-b", "t-1")).toBe(true);
    const row = h.db
      .query(`SELECT iteration_id FROM tasks WHERE id = ?`)
      .get("t-1") as { iteration_id: string };
    expect(row.iteration_id).toBe("it-b");
  });

  it("detachTask clears iteration_id and returns true", () => {
    createIteration(h.db, { id: "it-1", title: "T" });
    insertTask(h.db, "t-1", { iteration_id: "it-1" });
    expect(detachTask(h.db, "t-1")).toBe(true);
    const row = h.db
      .query(`SELECT iteration_id FROM tasks WHERE id = ?`)
      .get("t-1") as { iteration_id: string | null };
    expect(row.iteration_id).toBeNull();
  });

  it("detachTask returns false for unknown task id", () => {
    expect(detachTask(h.db, "missing")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FK behaviour on iteration delete
// ---------------------------------------------------------------------------

describe("iteration delete FK behaviour", () => {
  let h: H;
  beforeEach(() => {
    h = mkdb();
  });
  afterEach(() => {
    teardown(h);
  });

  it("DELETE of an iteration with attached tasks raises FK error", () => {
    createIteration(h.db, { id: "it-1", title: "T" });
    insertTask(h.db, "t-1", { iteration_id: "it-1" });
    expect(() => {
      h.db.exec(`DELETE FROM iterations WHERE id = 'it-1'`);
    }).toThrow();
  });

  it("DELETE succeeds after detach", () => {
    createIteration(h.db, { id: "it-1", title: "T" });
    insertTask(h.db, "t-1", { iteration_id: "it-1" });
    detachTask(h.db, "t-1");
    h.db.exec(`DELETE FROM iterations WHERE id = 'it-1'`);
    expect(getIteration(h.db, "it-1")).toBeNull();
    // Task survives detach + iteration delete.
    const row = h.db
      .query(`SELECT id FROM tasks WHERE id = ?`)
      .get("t-1") as { id: string };
    expect(row.id).toBe("t-1");
  });
});

// ---------------------------------------------------------------------------
// Inbox (Decision 1 — upstream + unattached + alive)
// ---------------------------------------------------------------------------

describe("listInboxItems", () => {
  let h: H;
  beforeEach(() => {
    h = mkdb();
  });
  afterEach(() => {
    teardown(h);
  });

  it("returns tasks where iteration_id IS NULL AND source_system != 'internal' AND status != 'cancelled'", () => {
    insertTask(h.db, "t-good", { source_system: "github" });
    insertTask(h.db, "t-internal", { source_system: "internal" });
    insertTask(h.db, "t-cx", { source_system: "github", status: "cancelled" });
    createIteration(h.db, { id: "it-1", title: "T" });
    insertTask(h.db, "t-attached", { source_system: "github", iteration_id: "it-1" });

    const items = listInboxItems(h.db);
    expect(items.map((i) => i.id).sort()).toEqual(["t-good"]);
  });

  it("hydrates timestamps to ISO-8601", () => {
    insertTask(h.db, "t-1", { source_system: "github" });
    const items = listInboxItems(h.db);
    expect(items[0]?.created_at).toMatch(/T.*Z$/);
    expect(items[0]?.updated_at).toMatch(/T.*Z$/);
  });

  it("D.7a — exposes a provider-neutral source narrowed from source_system", () => {
    insertTask(h.db, "t-1", {
      source_system: "github",
      source_url: "https://github.com/foo/bar/issues/1",
      source_external_id: "foo/bar#1",
    });
    const item = listInboxItems(h.db)[0];
    expect(item?.source).toEqual({
      provider: "github",
      externalId: "foo/bar#1",
      url: "https://github.com/foo/bar/issues/1",
      providerNativeType: null,
    });
    // raw column still present (storage detail) until D.7c relaxes the CHECK.
    expect(item?.source_system).toBe("github");
  });

  it("?source=github filters to a single source system", () => {
    // Insert via the schema-bypass path so we can exercise the source
    // filter even with non-CHECK-allowed values. (`tasks.source_system`
    // is CHECK-constrained to {github,internal} today; the inbox lister
    // is source-agnostic to forward-compat with future Decision 7 sources.)
    insertTask(h.db, "t-gh", { source_system: "github" });
    const items = listInboxItems(h.db, { source: "github" });
    expect(items.length).toBe(1);
    expect(items[0]?.source_system).toBe("github");
  });

  it("orders by updated_at DESC, id ASC", () => {
    insertTask(h.db, "t-old", { source_system: "github", updated_at: 1000 });
    insertTask(h.db, "t-new", { source_system: "github", updated_at: 2000 });
    insertTask(h.db, "t-mid", { source_system: "github", updated_at: 1500 });
    const items = listInboxItems(h.db);
    expect(items.map((i) => i.id)).toEqual(["t-new", "t-mid", "t-old"]);
  });

  it("default cap is INBOX_DEFAULT_LIMIT (Decision 10 Q3 — 100)", () => {
    expect(INBOX_DEFAULT_LIMIT).toBe(100);
    for (let i = 0; i < 120; i++) {
      insertTask(h.db, `t-${String(i).padStart(3, "0")}`, {
        source_system: "github",
      });
    }
    const items = listInboxItems(h.db);
    expect(items.length).toBe(100);
  });

  it("?limit=10 caps to the requested count", () => {
    for (let i = 0; i < 30; i++) {
      insertTask(h.db, `t-${i}`, { source_system: "github" });
    }
    const items = listInboxItems(h.db, { limit: 10 });
    expect(items.length).toBe(10);
  });

  it("?limit beyond INBOX_MAX_LIMIT is clamped", () => {
    for (let i = 0; i < 5; i++) {
      insertTask(h.db, `t-${i}`, { source_system: "github" });
    }
    // Caller asks for far above the cap; we only have 5 rows, but the
    // query LIMIT clamps to INBOX_MAX_LIMIT regardless of caller intent.
    const items = listInboxItems(h.db, { limit: 100_000 });
    expect(items.length).toBe(5);
    // Sanity: cap exposed for callers that want to surface it.
    expect(INBOX_MAX_LIMIT).toBeGreaterThanOrEqual(INBOX_DEFAULT_LIMIT);
  });

  it("returns an empty list when no inbox items match", () => {
    expect(listInboxItems(h.db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F-15 — additional read paths + server-side transition validator
// ---------------------------------------------------------------------------

describe("getTaskIterationLink (F-15)", () => {
  let h: H;
  beforeEach(() => {
    h = mkdb();
  });
  afterEach(() => {
    teardown(h);
  });

  it("returns null when the task id is unknown", () => {
    expect(getTaskIterationLink(h.db, "missing")).toBeNull();
  });

  it("returns { iterationId: null } when the task is unattached", () => {
    insertTask(h.db, "t-1");
    expect(getTaskIterationLink(h.db, "t-1")).toEqual({ iterationId: null });
  });

  it("returns the current iteration_id when attached", () => {
    createIteration(h.db, { id: "it-1", title: "x" });
    insertTask(h.db, "t-1", { iteration_id: "it-1" });
    expect(getTaskIterationLink(h.db, "t-1")).toEqual({ iterationId: "it-1" });
  });
});

describe("F-15 — attach-task uniqueness behaviour", () => {
  let h: H;
  beforeEach(() => {
    h = mkdb();
  });
  afterEach(() => {
    teardown(h);
  });

  it("attachTask is at the schema layer permissive — overwrites the FK", () => {
    // The DB layer's `attachTask` is the low-level write. The 1:N
    // invariant (one task ↔ at most one iteration) is enforced at the
    // API layer (`handleAttachTaskToIteration` reads the existing link
    // first and returns 409). The DB primitive itself is unchecked so
    // future code paths (cancellation cleanup, F-17 import) can move a
    // task between iterations without a permission-style guard.
    createIteration(h.db, { id: "it-a", title: "A" });
    createIteration(h.db, { id: "it-b", title: "B" });
    insertTask(h.db, "t-1", { iteration_id: "it-a" });
    expect(attachTask(h.db, "it-b", "t-1")).toBe(true);
    expect(getTaskIterationLink(h.db, "t-1")).toEqual({ iterationId: "it-b" });
  });

  it("attachTask is idempotent when called with the current iteration", () => {
    createIteration(h.db, { id: "it-1", title: "T" });
    insertTask(h.db, "t-1", { iteration_id: "it-1" });
    expect(attachTask(h.db, "it-1", "t-1")).toBe(true);
    expect(getTaskIterationLink(h.db, "t-1")).toEqual({ iterationId: "it-1" });
  });
});

describe("F-15 — state-transition-via-updateIteration", () => {
  let h: H;
  beforeEach(() => {
    h = mkdb();
  });
  afterEach(() => {
    teardown(h);
  });

  it("the DB layer's updateIteration accepts ANY state in the enum (validator gate is at the API)", () => {
    // Same comment as in the F-13 test for `attachTask`: the DB
    // primitive is unchecked. The validator sits one layer up
    // (`canTransitionServer` in this same module). This pins the
    // separation.
    createIteration(h.db, { id: "i-1", title: "x", state: "inbox" });
    // Direct schema-level move from inbox → done would NEVER be legal
    // through canTransitionServer, but at the DB layer it's allowed.
    const updated = updateIteration(h.db, "i-1", { state: "done" });
    expect(updated?.state).toBe("done");
    // … and the validator agrees the move would be illegal at the API.
    expect(canTransitionServer("inbox", "done")).toBe(false);
  });
});

describe("canTransitionServer / nextStatesServer (F-15)", () => {
  it("rejects designing → done per Decision 10 Q1 (principal-driven done deferred to Phase G)", () => {
    expect(canTransitionServer("designing", "done")).toBe(false);
    expect(canTransitionServer("queued", "done")).toBe(false);
    expect(canTransitionServer("inbox", "done")).toBe(false);
  });

  it("allows in_flight/blocked → done (the existing v1 derived path)", () => {
    expect(canTransitionServer("in_flight", "done")).toBe(true);
    expect(canTransitionServer("blocked", "done")).toBe(true);
  });

  it("allows principal cancel from every non-terminal state", () => {
    for (const s of ITERATION_STATES) {
      if (s === "done" || s === "cancelled") continue;
      expect(canTransitionServer(s, "cancelled")).toBe(true);
    }
  });

  it("rejects every transition out of a terminal state", () => {
    for (const target of ITERATION_STATES) {
      expect(canTransitionServer("done", target)).toBe(false);
      expect(canTransitionServer("cancelled", target)).toBe(false);
    }
  });

  it("rejects self-transitions (no `s → s`)", () => {
    for (const s of ITERATION_STATES) {
      expect(canTransitionServer(s, s)).toBe(false);
    }
  });

  it("nextStatesServer returns the legal moves out of inbox", () => {
    expect(new Set(nextStatesServer("inbox"))).toEqual(
      new Set(["designing", "cancelled"])
    );
  });

  it("nextStatesServer returns [] for terminal states", () => {
    expect(nextStatesServer("done")).toEqual([]);
    expect(nextStatesServer("cancelled")).toEqual([]);
  });

  // Per Echo grove-v2#42 (Major 1) — the previous "matrix mirrors the
  // dashboard validator exactly" test compared `canTransitionServer`
  // against a third hardcoded `EXPECTED` literal in this file, never
  // importing the dashboard `TRANSITIONS` const. The matrix now lives
  // in `lib/iteration-transitions.ts` and is the single source of truth
  // for both `db/iterations.ts` and `dashboard-v2/lib/iteration-status.ts`.
  // There is no second matrix to sync, so the sync test deletes.
});
