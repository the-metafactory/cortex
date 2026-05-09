/**
 * Grove Mission Control v2 — F-12 operator.curation event helper.
 *
 * Pins the four payload variants (Decision 9) round-trip through the events
 * table and that the helper writes the type column verbatim ("operator.curation",
 * sibling of "operator.input"). Pure DB-level test — no HTTP, no spawn.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { initDatabase } from "../db/init";
import {
  createOperatorCurationEvent,
  type OperatorCurationPayload,
} from "../db/events";
import { createSession } from "../db/sessions";
import { findLatestSessionForAssignment } from "../db/sessions";

interface TestContext {
  db: Database;
  tmpDir: string;
}

function setup(): TestContext {
  const tmpDir = join(tmpdir(), `mc-f12-events-${Date.now()}-${Math.random()}`);
  const db = initDatabase(join(tmpDir, "test.db"));
  return { db, tmpDir };
}

function teardown(t: TestContext): void {
  t.db.close();
  rmSync(t.tmpDir, { recursive: true, force: true });
}

function seed(db: Database): { assignmentId: string; sessionId: string } {
  db.exec(`
    INSERT INTO agents (id, name, type) VALUES ('a-1', 'Test agent', 'hands');
    INSERT INTO tasks (id, title, priority, operator_id, source_system)
      VALUES ('t-1', 'Test task', 1, 'op', 'internal');
    INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
      VALUES ('ata-1', 'a-1', 't-1', 'queued');
  `);
  const session = createSession(db, {
    assignmentId: "ata-1",
    endpointKind: "local.observed",
  });
  return { assignmentId: "ata-1", sessionId: session.id };
}

describe("createOperatorCurationEvent", () => {
  let t: TestContext;
  beforeEach(() => {
    t = setup();
  });
  afterEach(() => {
    teardown(t);
  });

  it("writes type='operator.curation' with the dispatch payload", () => {
    const { sessionId } = seed(t.db);
    const payload: OperatorCurationPayload = {
      kind: "dispatch",
      agentId: "a-2",
      reason: "fresh start",
      newAssignmentId: "ata-2",
    };
    const ev = createOperatorCurationEvent(t.db, sessionId, payload);
    expect(ev.type).toBe("operator.curation");
    expect(ev.session_id).toBe(sessionId);

    const row = t.db
      .query("SELECT type, payload FROM events WHERE id = ?")
      .get(ev.id) as { type: string; payload: string };
    expect(row.type).toBe("operator.curation");
    expect(JSON.parse(row.payload)).toEqual(
      payload as unknown as Record<string, unknown>
    );
  });

  it("round-trips the requeue payload", () => {
    const { sessionId } = seed(t.db);
    const ev = createOperatorCurationEvent(t.db, sessionId, {
      kind: "requeue",
      reason: "external dep recovered",
    });
    const row = t.db
      .query("SELECT payload FROM events WHERE id = ?")
      .get(ev.id) as { payload: string };
    const parsed = JSON.parse(row.payload);
    expect(parsed.kind).toBe("requeue");
    expect(parsed.reason).toBe("external dep recovered");
  });

  it("round-trips the handoff payload with all fields", () => {
    const { sessionId } = seed(t.db);
    const payload: OperatorCurationPayload = {
      kind: "handoff",
      fromAgentId: "a-1",
      toAgentId: "a-2",
      reason: "swap",
      newAssignmentId: "ata-3",
    };
    const ev = createOperatorCurationEvent(t.db, sessionId, payload);
    const row = t.db
      .query("SELECT payload FROM events WHERE id = ?")
      .get(ev.id) as { payload: string };
    expect(JSON.parse(row.payload)).toEqual(
      payload as unknown as Record<string, unknown>
    );
  });

  it("round-trips the abandon payload (assignment / task target kinds)", () => {
    const { sessionId } = seed(t.db);
    const ev1 = createOperatorCurationEvent(t.db, sessionId, {
      kind: "abandon",
      targetKind: "assignment",
    });
    const ev2 = createOperatorCurationEvent(t.db, sessionId, {
      kind: "abandon",
      targetKind: "task",
      reason: "no longer relevant",
    });
    const r1 = JSON.parse(
      (t.db.query("SELECT payload FROM events WHERE id = ?").get(ev1.id) as {
        payload: string;
      }).payload
    );
    const r2 = JSON.parse(
      (t.db.query("SELECT payload FROM events WHERE id = ?").get(ev2.id) as {
        payload: string;
      }).payload
    );
    expect(r1.targetKind).toBe("assignment");
    expect(r1.reason).toBeUndefined();
    expect(r2.targetKind).toBe("task");
    expect(r2.reason).toBe("no longer relevant");
  });

  it("findLatestSessionForAssignment resolves a terminal session for the curation FK", () => {
    // Decision 9 — events.session_id FK points at the latest session,
    // active or ended. Curation verbs targeting terminal assignments must
    // anchor onto a row that exists.
    const { assignmentId, sessionId } = seed(t.db);
    t.db
      .query(`UPDATE sessions SET ended_at = datetime('now') WHERE id = ?`)
      .run(sessionId);
    const found = findLatestSessionForAssignment(t.db, assignmentId);
    expect(found?.id).toBe(sessionId);
    expect(found?.ended_at).not.toBeNull();
  });

  // F-12b Decision 10 — pin the `task.imported` payload variant. The
  // helper accepts the new tagged-union variant; the round-trip preserves
  // every field (kind, source, ref, url, type).
  it("round-trips the task.imported payload (F-12b)", () => {
    const { sessionId } = seed(t.db);
    const payload: OperatorCurationPayload = {
      kind: "task.imported",
      source: "github",
      ref: "the-metafactory/grove-v2#42",
      url: "https://github.com/the-metafactory/grove-v2/issues/42",
      type: "issue",
    };
    const ev = createOperatorCurationEvent(t.db, sessionId, payload);
    expect(ev.type).toBe("operator.curation");
    const row = t.db
      .query("SELECT payload FROM events WHERE id = ?")
      .get(ev.id) as { payload: string };
    const parsed = JSON.parse(row.payload);
    expect(parsed.kind).toBe("task.imported");
    expect(parsed.source).toBe("github");
    expect(parsed.ref).toBe("the-metafactory/grove-v2#42");
    expect(parsed.url).toBe(
      "https://github.com/the-metafactory/grove-v2/issues/42"
    );
    expect(parsed.type).toBe("issue");
  });
});
