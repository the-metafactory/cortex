import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../db/schema";
import { ingestEvents } from "../hooks/ingestor";
import type { RawHookEvent } from "../hooks/types";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);

  // Seed: task → agent → assignment → observed session with cc_session_id
  db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
  db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Luna', 'head')`);
  db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id) VALUES ('ata-1', 'a-1', 't-1')`);
  db.exec(
    `INSERT INTO sessions (id, assignment_id, cc_session_id, endpoint_kind)
     VALUES ('s-obs', 'ata-1', 'cc-session-abc', 'local.observed')`
  );

  return db;
}

function makeRawEvent(
  eventId: string,
  sessionId: string,
  eventType = "test.event"
): RawHookEvent {
  return {
    event_id: eventId,
    event_type: eventType,
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    agent_id: "luna",
    agent_name: "Luna",
    source: { hook: "PostToolUse", tool_name: "tool.bash" },
    payload: { test: true },
  };
}

describe("ingestEvents", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it("ingests events matching a registered session", () => {
    const events = [
      makeRawEvent("e-1", "cc-session-abc", "tool.bash"),
      makeRawEvent("e-2", "cc-session-abc", "assistant.message"),
    ];

    const result = ingestEvents(db, events);
    expect(result.count).toBe(2);
    expect(result.events).toHaveLength(2);

    // Order explicitly by id ASC — without an ORDER BY SQLite may return rows
    // in any order the chosen index walks them (the (session_id, id DESC)
    // composite would yield reverse order). id is ULID-monotonic so ASC
    // matches insertion order.
    const rows = db
      .query("SELECT * FROM events WHERE session_id = 's-obs' ORDER BY id ASC")
      .all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe("tool.bash");
    expect(rows[1].type).toBe("assistant.message");
  });

  // MC-I1.S5 (ADR-0005 §3) — the old "drop events for unregistered sessions"
  // contract is replaced by orphan auto-registration. An unknown
  // cc_session_id now creates a `local.observed` orphan session and ingests
  // its events instead of dropping them.
  it("auto-registers an orphan session for an unknown cc_session_id and ingests its events", () => {
    const events = [
      makeRawEvent("e-1", "unknown-session-xyz"),
    ];

    const result = ingestEvents(db, events);
    // `result.count` is the number of INGESTED hook events (1). The F-20
    // dispatched → running auto-transition additionally writes a
    // `state.transition` event into the DB, but that's not counted as an
    // ingested hook event.
    expect(result.count).toBe(1);
    expect(result.events).toHaveLength(1);

    // An orphan session row now exists for the unknown cc_session_id, and it's
    // observed (distinguishable from controlled dispatch sessions).
    const orphanSession = db
      .query(
        `SELECT id, endpoint_kind FROM sessions WHERE cc_session_id = 'unknown-session-xyz'`
      )
      .get() as { id: string; endpoint_kind: string } | null;
    expect(orphanSession).not.toBeNull();
    expect(orphanSession!.endpoint_kind).toBe("local.observed");

    // The hook event landed against the orphan session (filter out the
    // F-20 state.transition the auto-start writes — the hook event's type is
    // the default `test.event` from makeRawEvent).
    const rows = db
      .query("SELECT * FROM events WHERE session_id = ? AND type = 'test.event'")
      .all(orphanSession!.id);
    expect(rows).toHaveLength(1);
  });

  it("handles mixed registered and unregistered sessions (orphan auto-registered)", () => {
    const events = [
      makeRawEvent("e-1", "cc-session-abc"),   // matched (registered)
      makeRawEvent("e-2", "unknown-session"),   // orphan auto-registered
      makeRawEvent("e-3", "cc-session-abc"),   // matched (registered)
    ];

    const result = ingestEvents(db, events);
    // 2 registered + 1 orphan = all 3 ingested now (none dropped).
    expect(result.count).toBe(3);

    const orphan = db
      .query(`SELECT id FROM sessions WHERE cc_session_id = 'unknown-session'`)
      .get();
    expect(orphan).not.toBeNull();
  });

  it("returns 0 for empty events array", () => {
    const result = ingestEvents(db, []);
    expect(result.count).toBe(0);
    expect(result.events).toHaveLength(0);
  });

  it("preserves source metadata in payload", () => {
    const events = [makeRawEvent("e-1", "cc-session-abc", "tool.bash")];
    ingestEvents(db, events);

    const row = db.query("SELECT payload FROM events LIMIT 1").get() as any;
    const payload = JSON.parse(row.payload);
    expect(payload.source_hook).toBe("PostToolUse");
    expect(payload.source_tool).toBe("tool.bash");
    expect(payload.agent_name).toBe("Luna");
    expect(payload.original_event_id).toBe("e-1");
  });

  it("still ingests events for ended sessions (events can lag lifecycle)", () => {
    // End the session — simulates auto-exit handler marking ended_at before
    // the ingestor processes remaining events (especially session.end itself).
    db.exec(`UPDATE sessions SET ended_at = datetime('now') WHERE id = 's-obs'`);

    const events = [makeRawEvent("e-1", "cc-session-abc", "session.end")];
    const result = ingestEvents(db, events);

    // Should still ingest — events are facts about what happened, and the
    // session.end event is the most important lifecycle marker.
    expect(result.count).toBe(1);

    const rows = db.query("SELECT * FROM events WHERE session_id = 's-obs'").all();
    expect(rows).toHaveLength(1);
  });

  // MC-I1.S5 — observability: one stderr line per orphan auto-register, NOT
  // per event, and the line names the cc_session_id.
  it("logs a single orphan auto-register line to stderr (once, not per event)", () => {
    const written: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk: string) => {
      written.push(chunk);
      return true;
    };

    try {
      // Three events for the SAME unknown session — registration happens once.
      const events = [
        makeRawEvent("e-1", "totally-unknown-session"),
        makeRawEvent("e-2", "totally-unknown-session"),
        makeRawEvent("e-3", "totally-unknown-session"),
      ];
      const result = ingestEvents(db, events);

      expect(result.count).toBe(3);
      const autoRegLines = written.filter((s) =>
        s.includes("auto-registered observed session")
      );
      expect(autoRegLines).toHaveLength(1);
      expect(autoRegLines[0]).toContain("totally-unknown-session");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  // F-20 — observed sessions auto-transition `dispatched → running` on the
  // first event ingested. Pin the assignment to `dispatched` (the state
  // POST /api/sessions leaves observed sessions in) before ingesting.
  it("auto-transitions observed dispatched → running on first event", () => {
    db.exec(
      `UPDATE agent_task_assignment SET state = 'dispatched' WHERE id = 'ata-1'`
    );
    const events = [makeRawEvent("e-1", "cc-session-abc", "tool.bash")];
    const result = ingestEvents(db, events);
    expect(result.count).toBe(1);

    const row = db
      .query("SELECT state FROM agent_task_assignment WHERE id = 'ata-1'")
      .get() as { state: string };
    expect(row.state).toBe("running");

    // A state.transition event was written into the DB alongside the
    // ingested event.
    const transitions = db
      .query(
        "SELECT payload FROM events WHERE session_id = 's-obs' AND type = 'state.transition'"
      )
      .all() as { payload: string }[];
    expect(transitions).toHaveLength(1);
    const p = JSON.parse(transitions[0]!.payload);
    expect(p.from).toBe("dispatched");
    expect(p.to).toBe("running");
  });

  // F-20 — observed sessions auto-transition `running → completed` on a
  // Stop / SessionEnd hook event. Bounds cycle time so F-18 metrics
  // don't skew (per Echo's PR-#54 review).
  it("auto-transitions observed running → completed on SessionEnd event", () => {
    db.exec(
      `UPDATE agent_task_assignment SET state = 'running' WHERE id = 'ata-1'`
    );
    const events = [makeRawEvent("e-1", "cc-session-abc", "SessionEnd")];
    ingestEvents(db, events);

    const row = db
      .query("SELECT state FROM agent_task_assignment WHERE id = 'ata-1'")
      .get() as { state: string };
    expect(row.state).toBe("completed");
  });

  it("auto-transitions observed running → completed on Stop event", () => {
    db.exec(
      `UPDATE agent_task_assignment SET state = 'running' WHERE id = 'ata-1'`
    );
    const events = [makeRawEvent("e-1", "cc-session-abc", "Stop")];
    ingestEvents(db, events);

    const row = db
      .query("SELECT state FROM agent_task_assignment WHERE id = 'ata-1'")
      .get() as { state: string };
    expect(row.state).toBe("completed");
  });

  // F-20 — controlled sessions own their state-machine driving via
  // handleCreateSession; the ingestor must not race those transitions.
  it("does NOT auto-transition controlled sessions", () => {
    // Seed a controlled session alongside the existing observed one.
    db.exec(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES ('ata-ctrl', 'a-1', 't-1', 'dispatched')`
    );
    db.exec(
      `INSERT INTO sessions (id, assignment_id, cc_session_id, endpoint_kind)
       VALUES ('s-ctrl', 'ata-ctrl', 'cc-session-ctrl', 'local.process.controlled')`
    );

    const events = [
      makeRawEvent("e-1", "cc-session-ctrl", "tool.bash"),
      makeRawEvent("e-2", "cc-session-ctrl", "Stop"),
    ];
    ingestEvents(db, events);

    // State unchanged — ingestor doesn't touch controlled sessions.
    const row = db
      .query("SELECT state FROM agent_task_assignment WHERE id = 'ata-ctrl'")
      .get() as { state: string };
    expect(row.state).toBe("dispatched");
  });

  // ==========================================================================
  // MC-I1.S5 (ADR-0005 §3) — orphan observed-session auto-registration.
  // ==========================================================================

  it("creates the orphan session exactly once across two ingest batches (dedupe)", () => {
    // First batch — auto-registers.
    ingestEvents(db, [makeRawEvent("e-1", "orphan-dedupe", "tool.bash")]);
    // Second batch, same cc_session_id — must NOT create a second session.
    ingestEvents(db, [makeRawEvent("e-2", "orphan-dedupe", "tool.bash")]);

    const sessions = db
      .query(`SELECT id FROM sessions WHERE cc_session_id = 'orphan-dedupe'`)
      .all();
    expect(sessions).toHaveLength(1);

    // Both HOOK events landed against the single orphan session. (The first
    // batch also wrote one F-20 `state.transition` event for the
    // dispatched → running auto-start; filter to the hook events.)
    const events = db
      .query(
        `SELECT e.id FROM events e
         JOIN sessions s ON s.id = e.session_id
         WHERE s.cc_session_id = 'orphan-dedupe' AND e.type = 'tool.bash'`
      )
      .all();
    expect(events).toHaveLength(2);

    // And exactly one assignment / one agent for it.
    const sessionRow = db
      .query(
        `SELECT assignment_id FROM sessions WHERE cc_session_id = 'orphan-dedupe'`
      )
      .get() as { assignment_id: string };
    const assignments = db
      .query(`SELECT id FROM agent_task_assignment WHERE id = ?`)
      .all(sessionRow.assignment_id);
    expect(assignments).toHaveLength(1);
  });

  // ST-P2: the observed session attaches to the REAL owning agent (resolved
  // from agent_id), and the display name lands on the SESSION's agent_name
  // column — not on a per-session agent. makeRawEvent sets agent_id='luna'.
  it("attaches the observed session to the real owning agent and stores the display name on the session", () => {
    const ev = makeRawEvent("e-1", "orphan-named", "tool.bash");
    ev.agent_id = "luna";
    ev.agent_name = "Luna";
    ingestEvents(db, [ev]);

    const owning = db
      .query(
        `SELECT ag.id AS id, ag.name AS name, ag.type AS type, ag.persistent AS persistent
         FROM agents ag
         JOIN agent_task_assignment a ON a.agent_id = ag.id
         JOIN sessions s ON s.assignment_id = a.id
         WHERE s.cc_session_id = 'orphan-named'`
      )
      .get() as { id: string; name: string; type: string; persistent: number } | null;
    expect(owning).not.toBeNull();
    expect(owning!.id).toBe("luna"); // the REAL identity, not mc-orphan-{cc}
    expect(owning!.name).toBe("Luna");

    // Display name + owning agent are denormalized onto the session row.
    const sess = db
      .query(
        `SELECT agent_id, agent_name, substrate FROM sessions WHERE cc_session_id = 'orphan-named'`
      )
      .get() as { agent_id: string; agent_name: string; substrate: string };
    expect(sess.agent_id).toBe("luna");
    expect(sess.agent_name).toBe("Luna");
    expect(sess.substrate).toBe("claude-code"); // default when payload carries none
  });

  it("resolves an observed: identity from agent_name when no agent_id is present", () => {
    const ev = makeRawEvent("e-1", "orphan-nameonly", "tool.bash");
    delete (ev as { agent_id?: string }).agent_id;
    ev.agent_name = "Sage";
    ingestEvents(db, [ev]);

    const sess = db
      .query(`SELECT agent_id, agent_name FROM sessions WHERE cc_session_id = 'orphan-nameonly'`)
      .get() as { agent_id: string; agent_name: string };
    expect(sess.agent_id).toBe("observed:sage");
    expect(sess.agent_name).toBe("Sage");
  });

  it("orphan assignment is born 'dispatched' and auto-transitions to 'running' on first event", () => {
    ingestEvents(db, [makeRawEvent("e-1", "orphan-running", "tool.bash")]);

    const row = db
      .query(
        `SELECT a.state AS state
         FROM agent_task_assignment a
         JOIN sessions s ON s.assignment_id = a.id
         WHERE s.cc_session_id = 'orphan-running'`
      )
      .get() as { state: string };
    // F-20 auto-transition runs against the orphan exactly like any observed
    // session: dispatched → running on the first ingested event.
    expect(row.state).toBe("running");
  });

  it("orphan session auto-transitions running → completed on a Stop event in a later batch", () => {
    ingestEvents(db, [makeRawEvent("e-1", "orphan-complete", "tool.bash")]); // → running
    ingestEvents(db, [makeRawEvent("e-2", "orphan-complete", "Stop")]); // → completed

    const row = db
      .query(
        `SELECT a.state AS state
         FROM agent_task_assignment a
         JOIN sessions s ON s.assignment_id = a.id
         WHERE s.cc_session_id = 'orphan-complete'`
      )
      .get() as { state: string };
    expect(row.state).toBe("completed");
  });

  it("orphan sessions are queryable through the assignment-anchored joins (the storage-shape edge)", () => {
    // This is the blast-radius assertion: orphans must surface through the
    // SAME assignment→session LEFT JOIN the dashboard list endpoints use. If
    // we had relaxed assignment_id to NULL with no assignment row, this join
    // would yield zero rows and the orphan would be invisible.
    ingestEvents(db, [makeRawEvent("e-1", "orphan-visible", "tool.bash")]);

    const joined = db
      .query(
        `SELECT a.id AS assignment_id, a.state AS state,
                s.endpoint_kind AS endpoint_kind, t.id AS task_id, ag.id AS agent_id
         FROM agent_task_assignment a
         JOIN tasks t ON t.id = a.task_id
         JOIN agents ag ON ag.id = a.agent_id
         LEFT JOIN sessions s ON s.id = (
           SELECT id FROM sessions
           WHERE assignment_id = a.id
           ORDER BY started_at DESC, id DESC
           LIMIT 1
         )
         WHERE s.cc_session_id = 'orphan-visible'`
      )
      .get() as
      | {
          assignment_id: string;
          state: string;
          endpoint_kind: string;
          task_id: string;
          agent_id: string;
        }
      | null;
    expect(joined).not.toBeNull();
    expect(joined!.endpoint_kind).toBe("local.observed");
    // ST-P2: the session attaches to the REAL owning agent (makeRawEvent's
    // agent_id='luna'), NOT a per-session mc-orphan- agent.
    expect(joined!.agent_id).toBe("luna");
    expect(joined!.agent_id.startsWith("mc-orphan-")).toBe(false);
  });

  // ST-P2 — the 1,044-tile fix: many observed sessions for the SAME owning
  // identity collapse onto ONE agent, NOT one agent per cc_session_id.
  it("does NOT mint a new agent per observed session — sessions of one identity share one agent", () => {
    const agentsBefore = (
      db.query(`SELECT COUNT(*) AS n FROM agents`).get() as { n: number }
    ).n;

    // Three distinct cc_session_ids, all the same wrapper identity (luna).
    for (const cc of ["sess-a", "sess-b", "sess-c"]) {
      const ev = makeRawEvent(`e-${cc}`, cc, "tool.bash");
      ev.agent_id = "luna";
      ev.agent_name = "Luna";
      ingestEvents(db, [ev]);
    }

    // Three SESSIONS exist …
    const sessions = db
      .query(`SELECT id FROM sessions WHERE cc_session_id IN ('sess-a','sess-b','sess-c')`)
      .all();
    expect(sessions).toHaveLength(3);

    // … but exactly ONE new agent ('luna') was created for all of them.
    const lunaAgents = db.query(`SELECT id FROM agents WHERE id = 'luna'`).all();
    expect(lunaAgents).toHaveLength(1);
    const agentsAfter = (
      db.query(`SELECT COUNT(*) AS n FROM agents`).get() as { n: number }
    ).n;
    expect(agentsAfter).toBe(agentsBefore + 1); // exactly one new agent, not three

    // No legacy per-session mc-orphan- agents anywhere.
    expect(db.query(`SELECT 1 FROM agents WHERE id LIKE 'mc-orphan-%'`).get()).toBeNull();
  });

  it("distinct identities get distinct owning agents, sharing the single orphan task", () => {
    const evA = makeRawEvent("e-1", "orphan-a", "tool.bash");
    evA.agent_id = "luna"; evA.agent_name = "Luna";
    const evB = makeRawEvent("e-2", "orphan-b", "tool.bash");
    evB.agent_id = "echo"; evB.agent_name = "Echo";
    ingestEvents(db, [evA]);
    ingestEvents(db, [evB]);

    expect(db.query(`SELECT 1 FROM agents WHERE id = 'luna'`).get()).toBeTruthy();
    expect(db.query(`SELECT 1 FROM agents WHERE id = 'echo'`).get()).toBeTruthy();

    // … but they share the SINGLE catch-all orphan task (bookkeeping anchor).
    const tasks = db.query(`SELECT id FROM tasks WHERE id = 'mc-orphan-task'`).all();
    expect(tasks).toHaveLength(1);
  });

  // ==========================================================================
  // ST-P2 — parent_session_id capture: explicit wire field + prompt-correlation.
  // ==========================================================================

  it("sets parent_session_id + substrate from the event payload when present (P1 wire contract)", () => {
    // The parent must exist as a real session for the self-FK to hold.
    const parentEv = makeRawEvent("e-parent", "cc-session-abc", "tool.bash");
    ingestEvents(db, [parentEv]); // 'cc-session-abc' is the seeded session 's-obs'
    const parentSessionId = "s-obs";

    const childEv = makeRawEvent("e-child", "child-cc", "tool.bash");
    childEv.agent_id = "luna"; childEv.agent_name = "Luna";
    childEv.payload = { ...childEv.payload, parent_session_id: parentSessionId, substrate: "codex" };
    ingestEvents(db, [childEv]);

    const sess = db
      .query(`SELECT parent_session_id, substrate FROM sessions WHERE cc_session_id = 'child-cc'`)
      .get() as { parent_session_id: string | null; substrate: string };
    expect(sess.parent_session_id).toBe(parentSessionId);
    expect(sess.substrate).toBe("codex");
  });

  it("tolerates absent P1 fields — parent stays NULL, substrate defaults", () => {
    const ev = makeRawEvent("e-1", "child-noparent", "tool.bash");
    ev.agent_id = "luna"; ev.agent_name = "Luna";
    // payload carries no parent_session_id / substrate (P1 may merge later).
    ingestEvents(db, [ev]);
    const sess = db
      .query(`SELECT parent_session_id, substrate FROM sessions WHERE cc_session_id = 'child-noparent'`)
      .get() as { parent_session_id: string | null; substrate: string };
    expect(sess.parent_session_id).toBeNull();
    expect(sess.substrate).toBe("claude-code");
  });

  it("correlates parent via a recent spawn prompt when no explicit parent field (D1b happy path)", () => {
    // Parent (the seeded 's-obs' / cc-session-abc) emits a tool.agent.spawned
    // carrying the prompt it handed the child.
    const spawnEv = makeRawEvent("e-spawn", "cc-session-abc", "tool.agent.spawned");
    spawnEv.payload = {
      ...spawnEv.payload,
      tool_input: { prompt: "Investigate the flaky retention test and fix it" },
    };
    ingestEvents(db, [spawnEv]);

    // Child's FIRST prompt (agent.task.started → prompt_preview) matches.
    const childStart = makeRawEvent("e-cstart", "child-correlated", "agent.task.started");
    childStart.agent_id = "luna"; childStart.agent_name = "Luna";
    childStart.payload = {
      ...childStart.payload,
      prompt_preview: "Investigate the flaky retention test and fix it",
    };
    ingestEvents(db, [childStart]);

    const sess = db
      .query(`SELECT parent_session_id FROM sessions WHERE cc_session_id = 'child-correlated'`)
      .get() as { parent_session_id: string | null };
    expect(sess.parent_session_id).toBe("s-obs"); // correlated to the parent session
  });

  it("does NOT correlate when two distinct spawns share the same prompt (D1b ambiguity → skip)", () => {
    // Seed a second real session to host the ambiguous second spawn.
    db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id, state) VALUES ('ata-2', 'a-1', 't-1', 'running')`);
    db.exec(`INSERT INTO sessions (id, assignment_id, cc_session_id, endpoint_kind, started_at) VALUES ('s-obs2', 'ata-2', 'cc-session-2', 'local.observed', datetime('now'))`);

    const prompt = "Run the full suite and report failures verbatim";
    const spawn1 = makeRawEvent("e-sp1", "cc-session-abc", "tool.agent.spawned");
    spawn1.payload = { ...spawn1.payload, tool_input: { prompt } };
    const spawn2 = makeRawEvent("e-sp2", "cc-session-2", "tool.agent.spawned");
    spawn2.payload = { ...spawn2.payload, tool_input: { prompt } };
    ingestEvents(db, [spawn1]);
    ingestEvents(db, [spawn2]);

    const childStart = makeRawEvent("e-amb", "child-ambiguous", "agent.task.started");
    childStart.agent_id = "luna"; childStart.agent_name = "Luna";
    childStart.payload = { ...childStart.payload, prompt_preview: prompt };
    ingestEvents(db, [childStart]);

    const sess = db
      .query(`SELECT parent_session_id FROM sessions WHERE cc_session_id = 'child-ambiguous'`)
      .get() as { parent_session_id: string | null };
    expect(sess.parent_session_id).toBeNull(); // ambiguous → left agent-rooted
  });

  it("does NOT correlate when the only matching spawn is outside the time window (D1b timeout)", () => {
    const prompt = "Refactor the ingestor correlation into its own module please";
    const spawnEv = makeRawEvent("e-old-spawn", "cc-session-abc", "tool.agent.spawned");
    spawnEv.payload = { ...spawnEv.payload, tool_input: { prompt } };
    ingestEvents(db, [spawnEv]);
    // Backdate the spawn event well past the 10-min correlation window.
    db.query(`UPDATE events SET timestamp = ? WHERE type = 'tool.agent.spawned'`)
      .run(new Date(Date.now() - 60 * 60 * 1000).toISOString());

    const childStart = makeRawEvent("e-late", "child-timeout", "agent.task.started");
    childStart.agent_id = "luna"; childStart.agent_name = "Luna";
    childStart.payload = { ...childStart.payload, prompt_preview: prompt };
    ingestEvents(db, [childStart]);

    const sess = db
      .query(`SELECT parent_session_id FROM sessions WHERE cc_session_id = 'child-timeout'`)
      .get() as { parent_session_id: string | null };
    expect(sess.parent_session_id).toBeNull(); // stale spawn → no edge
  });
});
