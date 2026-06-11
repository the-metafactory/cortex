/**
 * Grove Mission Control v2 — unit tests for F-9 working-agent grid query.
 *
 * Pins the Decision 2 state partition, Decision 1 current-primary rule,
 * tie-break by updated_at, and the +N badge count. Endpoint-level coverage
 * for GET /api/working-agents lives in api.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { initDatabase } from "../db/init";
import { listWorkingAgents, listAgentSessionTrees } from "../db/working-agents";

interface SeedAssignment {
  id: string;
  taskId: string;
  state: string;
  /** Offset in seconds subtracted from 'now' to build the updated_at. */
  updatedOffsetSec?: number;
  blockReasonJson?: string | null;
}

function seedAgent(db: Database, id: string, name = `Agent ${id}`): void {
  db.query(
    `INSERT OR IGNORE INTO agents (id, name, type) VALUES (?, ?, 'hands')`
  ).run(id, name);
}

function seedTask(db: Database, id: string, priority = 2): void {
  db.query(
    `INSERT OR IGNORE INTO tasks (id, title, priority, principal_id, source_system)
     VALUES (?, ?, ?, 'op', 'internal')`
  ).run(id, `Task ${id}`, priority);
}

function seedAssignment(db: Database, agentId: string, a: SeedAssignment): void {
  const br =
    a.state === "blocked"
      ? a.blockReasonJson ??
        JSON.stringify({
          kind: "permission.request",
          payload: { requested_action: "tool.edit" },
        })
      : null;
  const off = a.updatedOffsetSec ?? 0;
  db.query(
    `INSERT INTO agent_task_assignment
       (id, agent_id, task_id, state, block_reason, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', ? || ' seconds'))`
  ).run(a.id, agentId, a.taskId, a.state, br, -off);
}

describe("listWorkingAgents", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mc-wa-test-${Date.now()}-${Math.random()}`);
    db = initDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when no assignments exist", () => {
    seedAgent(db, "ag-idle");
    expect(listWorkingAgents(db)).toEqual([]);
  });

  it("excludes agents whose only assignments are blocked", () => {
    seedAgent(db, "ag-blocked");
    seedTask(db, "t-1");
    seedAssignment(db, "ag-blocked", {
      id: "a-1",
      taskId: "t-1",
      state: "blocked",
    });
    expect(listWorkingAgents(db)).toEqual([]);
  });

  it("excludes agents whose only assignments are terminal", () => {
    seedAgent(db, "ag-done");
    seedTask(db, "t-1");
    seedAssignment(db, "ag-done", {
      id: "a-1",
      taskId: "t-1",
      state: "completed",
    });
    expect(listWorkingAgents(db)).toEqual([]);
  });

  it("includes agents with any active-non-blocked assignment", () => {
    seedAgent(db, "ag-run");
    seedAgent(db, "ag-disp");
    seedAgent(db, "ag-queue");
    seedTask(db, "t-1");
    seedAssignment(db, "ag-run", { id: "a-r", taskId: "t-1", state: "running" });
    seedAssignment(db, "ag-disp", {
      id: "a-d",
      taskId: "t-1",
      state: "dispatched",
    });
    seedAssignment(db, "ag-queue", {
      id: "a-q",
      taskId: "t-1",
      state: "queued",
    });
    const rows = listWorkingAgents(db);
    // Sorted by rank ASC → running, dispatched, queued.
    expect(rows.map((r) => r.agent_id)).toEqual([
      "ag-run",
      "ag-disp",
      "ag-queue",
    ]);
    expect(rows.map((r) => r.primary_state_rank)).toEqual([1, 2, 3]);
  });

  it("picks running over dispatched/queued for the primary assignment", () => {
    seedAgent(db, "ag-luna");
    seedTask(db, "t-a");
    seedTask(db, "t-b");
    seedTask(db, "t-c");
    seedAssignment(db, "ag-luna", {
      id: "a-q",
      taskId: "t-a",
      state: "queued",
    });
    seedAssignment(db, "ag-luna", {
      id: "a-d",
      taskId: "t-b",
      state: "dispatched",
    });
    seedAssignment(db, "ag-luna", {
      id: "a-r",
      taskId: "t-c",
      state: "running",
    });
    const [row] = listWorkingAgents(db);
    expect(row?.primary_state).toBe("running");
    expect(row?.primary_assignment.id).toBe("a-r");
  });

  it("ties by updated_at DESC within the same state", () => {
    seedAgent(db, "ag-tie");
    seedTask(db, "t-1");
    seedTask(db, "t-2");
    seedAssignment(db, "ag-tie", {
      id: "a-old",
      taskId: "t-1",
      state: "running",
      updatedOffsetSec: 120,
    });
    seedAssignment(db, "ag-tie", {
      id: "a-new",
      taskId: "t-2",
      state: "running",
      updatedOffsetSec: 10,
    });
    const [row] = listWorkingAgents(db);
    expect(row?.primary_assignment.id).toBe("a-new");
  });

  it("counts additional active-non-blocked assignments, excluding blocked and terminal", () => {
    seedAgent(db, "ag-busy");
    for (const tId of ["t-1", "t-2", "t-3", "t-4", "t-5"]) seedTask(db, tId);
    seedAssignment(db, "ag-busy", {
      id: "a-primary",
      taskId: "t-1",
      state: "running",
    });
    seedAssignment(db, "ag-busy", {
      id: "a-2",
      taskId: "t-2",
      state: "queued",
    });
    seedAssignment(db, "ag-busy", {
      id: "a-3",
      taskId: "t-3",
      state: "dispatched",
    });
    // These should NOT be counted.
    seedAssignment(db, "ag-busy", {
      id: "a-block",
      taskId: "t-4",
      state: "blocked",
    });
    seedAssignment(db, "ag-busy", {
      id: "a-done",
      taskId: "t-5",
      state: "completed",
    });
    const [row] = listWorkingAgents(db);
    expect(row?.primary_assignment.id).toBe("a-primary");
    // primary + 2 others (queued + dispatched); blocked + completed ignored.
    expect(row?.additional_active_count).toBe(2);
  });

  it("agent may appear in working grid even if they also have a blocked assignment", () => {
    // An agent with one blocked and one running assignment is juggling two
    // tasks — surface them both in F-6 focus row AND F-9 working grid.
    // (The endpoint doesn't know about F-6; it just ensures the working-grid
    // query doesn't suppress the agent on account of a separate blocked row.)
    seedAgent(db, "ag-dual");
    seedTask(db, "t-block");
    seedTask(db, "t-run");
    seedAssignment(db, "ag-dual", {
      id: "a-b",
      taskId: "t-block",
      state: "blocked",
    });
    seedAssignment(db, "ag-dual", {
      id: "a-r",
      taskId: "t-run",
      state: "running",
    });
    const [row] = listWorkingAgents(db);
    expect(row?.primary_assignment.id).toBe("a-r");
    // additional_active_count excludes blocked per Decision 2.
    expect(row?.additional_active_count).toBe(0);
  });

  it("hydrates updated_at to ISO-8601 UTC", () => {
    seedAgent(db, "ag-iso");
    seedTask(db, "t-1");
    seedAssignment(db, "ag-iso", {
      id: "a-1",
      taskId: "t-1",
      state: "running",
    });
    const [row] = listWorkingAgents(db);
    expect(row?.primary_assignment.updated_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T.+Z$/
    );
  });

  // ── ST-P4: the additive `sessions` session-tree field ──────────────────────

  /** Seed an open session on an assignment, optionally with a parent edge. */
  function seedSession(
    sessionId: string,
    assignmentId: string,
    opts: { parentSessionId?: string | null; substrate?: string; agentName?: string } = {}
  ): void {
    db.query(
      `INSERT INTO sessions
         (id, assignment_id, cc_session_id, endpoint_kind, started_at,
          parent_session_id, substrate, agent_name)
       VALUES (?, ?, NULL, 'local.observed', datetime('now'), ?, ?, ?)`
    ).run(
      sessionId,
      assignmentId,
      opts.parentSessionId ?? null,
      opts.substrate ?? "claude-code",
      opts.agentName ?? null
    );
  }

  it("ST-P4: every tile carries a `sessions` array (additive; empty when no open sessions)", () => {
    seedAgent(db, "ag-1");
    seedTask(db, "t-1");
    seedAssignment(db, "ag-1", { id: "a-1", taskId: "t-1", state: "running" });
    const [row] = listWorkingAgents(db);
    // Additive: the field exists and is an array even with no session rows.
    expect(Array.isArray(row?.sessions)).toBe(true);
    expect(row?.sessions).toEqual([]);
  });

  it("ST-P4: projects an agent's open sessions as a nested tree", () => {
    seedAgent(db, "ag-tree");
    seedTask(db, "t-1");
    seedAssignment(db, "ag-tree", { id: "a-root", taskId: "t-1", state: "running" });
    seedAssignment(db, "ag-tree", { id: "a-child", taskId: "t-1", state: "running" });
    seedSession("s-root", "a-root", { agentName: "Luna" });
    seedSession("s-child", "a-child", { parentSessionId: "s-root" });

    const [row] = listWorkingAgents(db);
    expect(row?.sessions).toHaveLength(1);
    const root = row!.sessions[0]!;
    expect(root.session_id).toBe("s-root");
    expect(root.parent_session_id).toBeNull();
    expect(root.agent_name).toBe("Luna");
    expect(root.children.map((c) => c.session_id)).toEqual(["s-child"]);
    expect(root.children[0]!.parent_session_id).toBe("s-root");
  });

  it("ST-P4: a child whose parent is filtered out surfaces as a root (orphaned-parent → root)", () => {
    seedAgent(db, "ag-orphan");
    seedTask(db, "t-1");
    // Parent's assignment is terminal (completed) → the parent session is
    // EXCLUDED by the non-terminal WHERE, so the child's parent ref is
    // "orphaned" in the fetched set. The FK row still exists (ON DELETE CASCADE
    // means a deleted parent would take the child with it — the real
    // orphaned-parent case is a filtered-out parent, not a deleted one).
    seedAssignment(db, "ag-orphan", { id: "a-parent", taskId: "t-1", state: "completed" });
    seedAssignment(db, "ag-orphan", { id: "a-child", taskId: "t-1", state: "running" });
    seedSession("s-parent", "a-parent");
    seedSession("s-child", "a-child", { parentSessionId: "s-parent" });

    const trees = listAgentSessionTrees(db, ["ag-orphan"]);
    const forest = trees.get("ag-orphan")!;
    expect(forest).toHaveLength(1);
    expect(forest[0]!.session_id).toBe("s-child");
    // Provenance preserved even though it renders as a root.
    expect(forest[0]!.parent_session_id).toBe("s-parent");
  });

  it("ST-P4: excludes ended (terminal) sessions and sessions on terminal assignments", () => {
    seedAgent(db, "ag-mix");
    seedTask(db, "t-1");
    seedAssignment(db, "ag-mix", { id: "a-run", taskId: "t-1", state: "running" });
    seedAssignment(db, "ag-mix", { id: "a-done", taskId: "t-1", state: "completed" });
    // Open session on the running assignment → included.
    seedSession("s-open", "a-run");
    // Session on a completed assignment → excluded (non-terminal filter).
    seedSession("s-on-terminal", "a-done");
    // Ended session on the running assignment → excluded (ended_at set).
    db.query(
      `INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at, ended_at, substrate)
       VALUES ('s-ended', 'a-run', 'local.observed', datetime('now'), datetime('now'), 'claude-code')`
    ).run();

    const forest = listAgentSessionTrees(db, ["ag-mix"]).get("ag-mix") ?? [];
    expect(forest.map((n) => n.session_id)).toEqual(["s-open"]);
  });

  it("ST-P4: hydrates session timestamps to ISO-8601 UTC and carries substrate", () => {
    seedAgent(db, "ag-iso2");
    seedTask(db, "t-1");
    seedAssignment(db, "ag-iso2", { id: "a-1", taskId: "t-1", state: "dispatched" });
    seedSession("s-1", "a-1", { substrate: "codex" });
    const [row] = listWorkingAgents(db);
    const node = row!.sessions[0]!;
    expect(node.substrate).toBe("codex");
    expect(node.state).toBe("dispatched");
    expect(node.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T.+Z$/);
    expect(node.ended_at).toBeNull();
  });

  it("ST-P4 additivity: pre-change DTO fields are byte-identical (snapshot)", () => {
    seedAgent(db, "ag-snap", "Snapshot Agent");
    seedTask(db, "t-snap", 1);
    seedAssignment(db, "ag-snap", { id: "a-snap", taskId: "t-snap", state: "running" });
    const [row] = listWorkingAgents(db);
    // Strip the new field; the remainder must equal the exact pre-ST-P4 shape.
    const { sessions, primary_assignment, ...scalars } = row!;
    expect(Array.isArray(sessions)).toBe(true);
    expect(scalars).toEqual({
      agent_id: "ag-snap",
      agent_name: "Snapshot Agent",
      agent_type: "hands",
      primary_state_rank: 1,
      primary_state: "running",
      additional_active_count: 0,
    });
    expect(primary_assignment.task_id).toBe("t-snap");
    expect(primary_assignment.task_title).toBe("Task t-snap");
    expect(primary_assignment.task_priority).toBe(1);
    expect(primary_assignment.id).toBe("a-snap");
    expect(primary_assignment.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T.+Z$/);
  });
});
