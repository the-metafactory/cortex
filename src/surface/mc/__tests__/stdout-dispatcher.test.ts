import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../db/schema";
import { WsClientRegistry } from "../ws/client-registry";
import { createSession } from "../db/sessions";
import { applyTransition } from "../db/transitions";
import { startStdoutDispatcher } from "../session/stdout-dispatcher";
import type { WsServerMessage } from "../ws/types";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  db.exec(
    `INSERT INTO tasks (id, title, priority, operator_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`
  );
  db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'A', 'hands')`);
  db.exec(
    `INSERT INTO agent_task_assignment (id, agent_id, task_id) VALUES ('ata-1', 'a-1', 't-1')`
  );
  return db;
}

function seedRunningSession(db: Database): { sessionId: string } {
  const session = createSession(db, {
    assignmentId: "ata-1",
    endpointKind: "local.process.controlled",
    pid: 12345,
  });
  // queued → dispatched → running; mirrors what handleCreateSession does after
  // spawnControlledSession returns, so the dispatcher's terminal transition
  // operates on a realistic assignment state.
  const d = applyTransition(db, "ata-1", session.id, { type: "dispatch" });
  if (!d.ok) throw new Error(`dispatch failed: ${d.error}`);
  const s = applyTransition(db, "ata-1", session.id, { type: "start" });
  if (!s.ok) throw new Error(`start failed: ${s.error}`);
  return { sessionId: session.id };
}

/**
 * Build a ReadableStream that yields the given chunks and then closes.
 * Chunks are Uint8Array so the dispatcher exercises its UTF-8 decoder.
 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

/**
 * Subscribe to the registry and capture broadcasts. Returns a live array and
 * an unsubscribe function. Using a fake WS lets us assert ordering without
 * bringing up the real Bun server.
 */
function captureBroadcasts(registry: WsClientRegistry): WsServerMessage[] {
  const received: WsServerMessage[] = [];
  const fakeWs = {
    data: { clientId: "test-observer" },
    send(msg: string) {
      received.push(JSON.parse(msg) as WsServerMessage);
    },
  };
  registry.add(fakeWs as never);
  return received;
}

describe("startStdoutDispatcher", () => {
  let db: Database;
  let wsRegistry: WsClientRegistry;

  beforeEach(() => {
    db = setupDb();
    wsRegistry = new WsClientRegistry();
  });

  afterEach(() => {
    db.close();
  });

  it("inserts each stream-json line as an event row with stream-json.<type> prefix", async () => {
    const { sessionId } = seedRunningSession(db);
    const lines =
      '{"type":"system","subtype":"init"}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n';

    const { done } = startStdoutDispatcher(streamOf([lines]), {
      db,
      wsRegistry,
      sessionId,
      assignmentId: "ata-1",
    });
    await done;

    const rows = db
      .query(
        `SELECT type, payload FROM events WHERE session_id = ? AND type LIKE 'stream-json.%' ORDER BY id ASC`
      )
      .all(sessionId) as { type: string; payload: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.type).toBe("stream-json.system");
    expect(rows[1]!.type).toBe("stream-json.assistant");
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({
      type: "system",
      subtype: "init",
    });
  });

  it("broadcasts each parsed event via the WS registry", async () => {
    const { sessionId } = seedRunningSession(db);
    const received = captureBroadcasts(wsRegistry);

    const { done } = startStdoutDispatcher(
      streamOf(['{"type":"assistant"}\n']),
      { db, wsRegistry, sessionId, assignmentId: "ata-1" }
    );
    await done;

    const eventMsgs = received.filter((m) => m.type === "event");
    expect(eventMsgs).toHaveLength(1);
    const m = eventMsgs[0]!;
    if (m.type !== "event") throw new Error("narrowing");
    expect(m.sessionId).toBe(sessionId);
    expect(m.event.type).toBe("stream-json.assistant");
  });

  it("drives running → completed on a terminal result/success event", async () => {
    const { sessionId } = seedRunningSession(db);
    const received = captureBroadcasts(wsRegistry);

    const { done } = startStdoutDispatcher(
      streamOf(['{"type":"result","subtype":"success","result":"ok"}\n']),
      { db, wsRegistry, sessionId, assignmentId: "ata-1" }
    );
    await done;

    const row = db
      .query(`SELECT state FROM agent_task_assignment WHERE id = ?`)
      .get("ata-1") as { state: string };
    expect(row.state).toBe("completed");

    const transitions = received.filter((m) => m.type === "state.transition");
    expect(transitions).toHaveLength(1);
    const t = transitions[0]!;
    if (t.type !== "state.transition") throw new Error("narrowing");
    expect(t.from).toBe("running");
    expect(t.to).toBe("completed");
  });

  it("drives running → failed on a result/error_* event", async () => {
    const { sessionId } = seedRunningSession(db);

    const { done } = startStdoutDispatcher(
      streamOf([
        '{"type":"result","subtype":"error_during_execution","result":"boom"}\n',
      ]),
      { db, wsRegistry, sessionId, assignmentId: "ata-1" }
    );
    await done;

    const row = db
      .query(`SELECT state FROM agent_task_assignment WHERE id = ?`)
      .get("ata-1") as { state: string };
    expect(row.state).toBe("failed");
  });

  it("handles lines split across chunks without losing data", async () => {
    const { sessionId } = seedRunningSession(db);

    // The first chunk ends mid-JSON; the reader must buffer until the second
    // chunk provides the closing brace + newline. Previously, the naive line
    // split would have dropped half the object.
    const { done } = startStdoutDispatcher(
      streamOf([
        '{"type":"assis',
        'tant","message":{"content":"',
        'hello"}}\n',
      ]),
      { db, wsRegistry, sessionId, assignmentId: "ata-1" }
    );
    await done;

    const rows = db
      .query(
        `SELECT type, payload FROM events WHERE session_id = ? AND type LIKE 'stream-json.%'`
      )
      .all(sessionId) as { type: string; payload: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("stream-json.assistant");
    expect(JSON.parse(rows[0]!.payload).message.content).toBe("hello");
  });

  it("flushes a trailing line that lacks a newline", async () => {
    const { sessionId } = seedRunningSession(db);

    const { done } = startStdoutDispatcher(
      streamOf(['{"type":"result","subtype":"success"}']),
      { db, wsRegistry, sessionId, assignmentId: "ata-1" }
    );
    await done;

    const rows = db
      .query(
        `SELECT type FROM events WHERE session_id = ? AND type LIKE 'stream-json.%'`
      )
      .all(sessionId) as { type: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("stream-json.result");
  });

  it("skips malformed lines and continues dispatching", async () => {
    const { sessionId } = seedRunningSession(db);
    const received = captureBroadcasts(wsRegistry);

    const { done } = startStdoutDispatcher(
      streamOf([
        '{"type":"system"}\n',
        "not-json-at-all\n",
        '{"type":"assistant"}\n',
      ]),
      { db, wsRegistry, sessionId, assignmentId: "ata-1" }
    );
    await done;

    const rows = db
      .query(
        `SELECT type FROM events WHERE session_id = ? AND type LIKE 'stream-json.%' ORDER BY id ASC`
      )
      .all(sessionId) as { type: string }[];
    expect(rows.map((r) => r.type)).toEqual([
      "stream-json.system",
      "stream-json.assistant",
    ]);
    // Only two event broadcasts — the malformed line was skipped, not stored.
    expect(received.filter((m) => m.type === "event")).toHaveLength(2);
  });

  it("tags typeless lines as stream-json.unknown", async () => {
    const { sessionId } = seedRunningSession(db);

    const { done } = startStdoutDispatcher(
      streamOf(['{"no_type":true}\n']),
      { db, wsRegistry, sessionId, assignmentId: "ata-1" }
    );
    await done;

    const row = db
      .query(
        `SELECT type FROM events WHERE session_id = ? AND type LIKE 'stream-json.%'`
      )
      .get(sessionId) as { type: string };
    expect(row.type).toBe("stream-json.unknown");
  });

  it("survives an invalid terminal transition (e.g. blocked) without throwing", async () => {
    const { sessionId } = seedRunningSession(db);
    // Block the assignment so `complete` from running would itself be fine,
    // but from `blocked` is invalid. Simulates a race where a block event
    // landed before the terminal result event.
    const b = applyTransition(db, "ata-1", sessionId, {
      type: "block",
      reason: {
        kind: "permission.request",
        payload: {
          requested_action: "tool.edit",
        },
      },
    });
    if (!b.ok) throw new Error(`block failed: ${b.error}`);

    const { done } = startStdoutDispatcher(
      streamOf(['{"type":"result","subtype":"success"}\n']),
      { db, wsRegistry, sessionId, assignmentId: "ata-1" }
    );
    await done;

    // Event was still persisted — the dispatcher never loses audit trail.
    const rows = db
      .query(
        `SELECT type FROM events WHERE session_id = ? AND type LIKE 'stream-json.%'`
      )
      .all(sessionId) as { type: string }[];
    expect(rows.some((r) => r.type === "stream-json.result")).toBe(true);

    // State stays blocked — the invalid transition was logged, not applied.
    const row = db
      .query(`SELECT state FROM agent_task_assignment WHERE id = ?`)
      .get("ata-1") as { state: string };
    expect(row.state).toBe("blocked");
  });
});
