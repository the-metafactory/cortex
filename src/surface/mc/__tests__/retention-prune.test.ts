/**
 * MC retention/prune tests (#857 orphan rows, #864 events table).
 *
 * Covers:
 *   - `ended_at` is stamped on terminal orphan transitions (the missing piece).
 *   - orphan rows older than the window prune (agent + assignment + session +
 *     events all gone); within-window orphans are retained; the shared
 *     `mc-orphan-task` anchor survives; real (non-orphan) tasks/agents/sessions
 *     are NEVER pruned even when old.
 *   - events older than the window prune; recent events retained; the prune is
 *     idempotent and transactional.
 *   - the throttle (prune does not run every tick) and best-effort posture (a
 *     prune failure does not throw out of the caller).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../db/schema";
import { applyTransition } from "../db/transitions";
import { registerOrphanSession, ORPHAN_AGENT_PREFIX } from "../db/sessions";
import { insertEvent } from "../db/events";
import {
  pruneOrphanSessions,
  pruneOldEvents,
  pruneRetention,
  reapStuckRunningOrphans,
  ORPHAN_RETENTION_MS,
  EVENTS_RETENTION_MS,
  STUCK_RUNNING_TTL_MS,
  ThrottledPrune,
} from "../db/retention";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

/** Backdate a session's ended_at to N ms before now (ISO-8601 UTC). */
function backdateEndedAt(db: Database, sessionId: string, msAgo: number): void {
  const iso = new Date(Date.now() - msAgo).toISOString();
  db.query(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(iso, sessionId);
}

/** Backdate an event's timestamp to N ms before now (ISO-8601 UTC). */
function backdateEvent(db: Database, eventId: string, msAgo: number): void {
  const iso = new Date(Date.now() - msAgo).toISOString();
  db.query(`UPDATE events SET timestamp = ? WHERE id = ?`).run(iso, eventId);
}

function rowCount(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

const DAY = 24 * 60 * 60 * 1000;

describe("ended_at stamping on terminal transitions", () => {
  let db: Database;
  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  it("stamps ended_at when an orphan assignment completes", () => {
    const orphan = registerOrphanSession(db, "cc-end-1");
    expect(orphan).not.toBeNull();
    // dispatched → running → completed
    expect(applyTransition(db, orphan!.assignmentId, orphan!.sessionId, { type: "start" }).ok).toBe(true);
    const completed = applyTransition(db, orphan!.assignmentId, orphan!.sessionId, { type: "complete" });
    expect(completed.ok).toBe(true);

    const row = db.query(`SELECT ended_at FROM sessions WHERE id = ?`).get(orphan!.sessionId) as { ended_at: string | null };
    expect(row.ended_at).toBeTruthy();
  });

  it("stamps ended_at on fail and cancel terminals too", () => {
    const o1 = registerOrphanSession(db, "cc-fail-1")!;
    applyTransition(db, o1.assignmentId, o1.sessionId, { type: "start" });
    applyTransition(db, o1.assignmentId, o1.sessionId, { type: "fail", error: "boom" });
    const failedRow = db.query(`SELECT ended_at FROM sessions WHERE id = ?`).get(o1.sessionId) as { ended_at: string | null };
    expect(failedRow.ended_at).toBeTruthy();

    const o2 = registerOrphanSession(db, "cc-cancel-1")!;
    applyTransition(db, o2.assignmentId, o2.sessionId, { type: "cancel" });
    const cancelledRow = db.query(`SELECT ended_at FROM sessions WHERE id = ?`).get(o2.sessionId) as { ended_at: string | null };
    expect(cancelledRow.ended_at).toBeTruthy();
  });

  it("does NOT stamp ended_at on a non-terminal transition", () => {
    const orphan = registerOrphanSession(db, "cc-running-1")!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" }); // → running (non-terminal)
    const row = db.query(`SELECT ended_at FROM sessions WHERE id = ?`).get(orphan.sessionId) as { ended_at: string | null };
    expect(row.ended_at).toBeNull();
  });

  it("does not clobber an already-set ended_at on a second terminal-ish apply", () => {
    const orphan = registerOrphanSession(db, "cc-idem-1")!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" });
    const completed = applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "complete" });
    expect(completed.ok).toBe(true);
    const first = db.query(`SELECT ended_at FROM sessions WHERE id = ?`).get(orphan.sessionId) as { ended_at: string };
    // A redundant transition from a terminal state is rejected by the state machine,
    // so ended_at is untouched.
    const again = applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "complete" });
    expect(again.ok).toBe(false);
    const second = db.query(`SELECT ended_at FROM sessions WHERE id = ?`).get(orphan.sessionId) as { ended_at: string };
    expect(second.ended_at).toBe(first.ended_at);
  });
});

describe("pruneOrphanSessions (#857)", () => {
  let db: Database;
  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  /** Register an orphan, drive it terminal, backdate ended_at, and return its ids. */
  function terminalOrphan(ccId: string, ageMs: number) {
    const orphan = registerOrphanSession(db, ccId)!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" });
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "complete" });
    backdateEndedAt(db, orphan.sessionId, ageMs);
    return orphan;
  }

  it("prunes orphan agent + assignment + session beyond the window", () => {
    const old = terminalOrphan("cc-old-1", ORPHAN_RETENTION_MS + DAY);

    const result = pruneOrphanSessions(db);
    expect(result.prunedSessions).toBe(1);
    expect(result.prunedAssignments).toBe(1);
    expect(result.prunedAgents).toBe(1);

    expect(db.query(`SELECT 1 FROM sessions WHERE id = ?`).get(old.sessionId)).toBeNull();
    expect(db.query(`SELECT 1 FROM agent_task_assignment WHERE id = ?`).get(old.assignmentId)).toBeNull();
    expect(db.query(`SELECT 1 FROM agents WHERE id = ?`).get(old.agentId)).toBeNull();
  });

  it("cascades the orphan session's events when the session prunes", () => {
    const old = terminalOrphan("cc-old-ev", ORPHAN_RETENTION_MS + DAY);
    insertEvent(db, { sessionId: old.sessionId, type: "stream-json", payload: { a: 1 } });
    insertEvent(db, { sessionId: old.sessionId, type: "stream-json", payload: { b: 2 } });
    expect(rowCount(db, "events")).toBeGreaterThanOrEqual(2);

    pruneOrphanSessions(db);
    const remaining = db.query(`SELECT COUNT(*) AS n FROM events WHERE session_id = ?`).get(old.sessionId) as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("retains orphan rows still inside the window", () => {
    const fresh = terminalOrphan("cc-fresh-1", DAY); // 1 day old, window is 7d
    const result = pruneOrphanSessions(db);
    expect(result.prunedSessions).toBe(0);
    expect(db.query(`SELECT 1 FROM sessions WHERE id = ?`).get(fresh.sessionId)).toBeTruthy();
    expect(db.query(`SELECT 1 FROM agents WHERE id = ?`).get(fresh.agentId)).toBeTruthy();
  });

  it("retains terminal orphans whose ended_at is NULL (defensive — never computed-age NULL)", () => {
    const orphan = registerOrphanSession(db, "cc-null-end")!;
    // Force assignment terminal WITHOUT going through applyTransition's stamping,
    // simulating a legacy row that predates the ended_at fix.
    db.query(`UPDATE agent_task_assignment SET state = 'completed' WHERE id = ?`).run(orphan.assignmentId);
    // ended_at stays NULL
    const result = pruneOrphanSessions(db);
    expect(result.prunedSessions).toBe(0);
    expect(db.query(`SELECT 1 FROM sessions WHERE id = ?`).get(orphan.sessionId)).toBeTruthy();
  });

  it("never prunes a non-terminal (still-running) orphan even when old", () => {
    const orphan = registerOrphanSession(db, "cc-running-old")!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" }); // running, ended_at NULL
    // Even if we backdate started_at, a running session has no ended_at → not terminal.
    db.query(`UPDATE sessions SET started_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 30 * DAY).toISOString(), orphan.sessionId);
    pruneOrphanSessions(db);
    expect(db.query(`SELECT 1 FROM sessions WHERE id = ?`).get(orphan.sessionId)).toBeTruthy();
  });

  it("preserves the shared mc-orphan-task anchor", () => {
    terminalOrphan("cc-anchor-1", ORPHAN_RETENTION_MS + DAY);
    pruneOrphanSessions(db);
    expect(db.query(`SELECT 1 FROM tasks WHERE id = 'mc-orphan-task'`).get()).toBeTruthy();
  });

  it("NEVER prunes real (non-orphan) tasks/agents/sessions even when old", () => {
    // A real dispatch-projected agent + assignment + session, terminal and ancient.
    db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system, status) VALUES ('real-task', 'Real', 2, 'andreas', 'github', 'done')`);
    db.exec(`INSERT INTO agents (id, name, type, persistent) VALUES ('real-agent', 'Echo', 'head', 1)`);
    db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id, state) VALUES ('real-ata', 'real-agent', 'real-task', 'completed')`);
    const sid = "real-session";
    db.query(`INSERT INTO sessions (id, assignment_id, cc_session_id, endpoint_kind, started_at, ended_at) VALUES (?, 'real-ata', 'cc-real', 'local.process.controlled', ?, ?)`)
      .run(sid, new Date(Date.now() - 60 * DAY).toISOString(), new Date(Date.now() - 60 * DAY).toISOString());

    const result = pruneOrphanSessions(db);
    expect(result.prunedSessions).toBe(0);
    expect(db.query(`SELECT 1 FROM sessions WHERE id = 'real-session'`).get()).toBeTruthy();
    expect(db.query(`SELECT 1 FROM agents WHERE id = 'real-agent'`).get()).toBeTruthy();
    expect(db.query(`SELECT 1 FROM agent_task_assignment WHERE id = 'real-ata'`).get()).toBeTruthy();
    expect(db.query(`SELECT 1 FROM tasks WHERE id = 'real-task'`).get()).toBeTruthy();
  });

  it("is idempotent — a second prune over the same state is a no-op", () => {
    terminalOrphan("cc-idem-prune", ORPHAN_RETENTION_MS + DAY);
    const first = pruneOrphanSessions(db);
    expect(first.prunedSessions).toBe(1);
    const second = pruneOrphanSessions(db);
    expect(second.prunedSessions).toBe(0);
    expect(second.prunedAssignments).toBe(0);
    expect(second.prunedAgents).toBe(0);
  });

  it("only prunes mc-orphan-prefixed agents", () => {
    const old = terminalOrphan("cc-prefix-1", ORPHAN_RETENTION_MS + DAY);
    expect(old.agentId.startsWith(ORPHAN_AGENT_PREFIX)).toBe(true);
    pruneOrphanSessions(db);
    // The agent is gone; verify no non-orphan agent id was touched by checking the
    // (separately-inserted) shadow agent survives if present.
    db.exec(`INSERT INTO agents (id, name, type, persistent) VALUES ('mc-shadow-agent', 'shadow', 'hands', 1) ON CONFLICT(id) DO NOTHING`);
    pruneOrphanSessions(db);
    expect(db.query(`SELECT 1 FROM agents WHERE id = 'mc-shadow-agent'`).get()).toBeTruthy();
  });
});

describe("pruneOldEvents (#864)", () => {
  let db: Database;
  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  /** Create a retained (non-orphan, still-running) session to hang events on. */
  function liveSession(): string {
    db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-live', 'Live', 2, 'andreas', 'internal') ON CONFLICT(id) DO NOTHING`);
    db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-live', 'Live', 'head') ON CONFLICT(id) DO NOTHING`);
    db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id, state) VALUES ('ata-live', 'a-live', 't-live', 'running') ON CONFLICT(id) DO NOTHING`);
    const sid = "s-live";
    db.query(`INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at) VALUES (?, 'ata-live', 'local.observed', ?) ON CONFLICT(id) DO NOTHING`)
      .run(sid, new Date().toISOString());
    return sid;
  }

  it("prunes events older than the window, retaining recent ones", () => {
    const sid = liveSession();
    const oldEv = insertEvent(db, { sessionId: sid, type: "stream-json", payload: {} });
    const newEv = insertEvent(db, { sessionId: sid, type: "stream-json", payload: {} });
    backdateEvent(db, oldEv.id, EVENTS_RETENTION_MS + DAY);
    backdateEvent(db, newEv.id, DAY);

    const result = pruneOldEvents(db);
    expect(result.prunedEvents).toBe(1);
    expect(db.query(`SELECT 1 FROM events WHERE id = ?`).get(oldEv.id)).toBeNull();
    expect(db.query(`SELECT 1 FROM events WHERE id = ?`).get(newEv.id)).toBeTruthy();
  });

  it("is idempotent", () => {
    const sid = liveSession();
    const oldEv = insertEvent(db, { sessionId: sid, type: "stream-json", payload: {} });
    backdateEvent(db, oldEv.id, EVENTS_RETENTION_MS + DAY);
    expect(pruneOldEvents(db).prunedEvents).toBe(1);
    expect(pruneOldEvents(db).prunedEvents).toBe(0);
  });

  it("prunes old events even when their session is retained", () => {
    const sid = liveSession(); // session stays (running, not orphan-terminal)
    const oldEv = insertEvent(db, { sessionId: sid, type: "stream-json", payload: {} });
    backdateEvent(db, oldEv.id, EVENTS_RETENTION_MS + DAY);
    pruneOldEvents(db);
    expect(db.query(`SELECT 1 FROM sessions WHERE id = ?`).get(sid)).toBeTruthy(); // session retained
    expect(db.query(`SELECT 1 FROM events WHERE id = ?`).get(oldEv.id)).toBeNull(); // old event pruned
  });
});

describe("pruneRetention (combined, transactional, best-effort)", () => {
  let db: Database;
  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  it("runs both prunes and reports a combined summary", () => {
    const orphan = registerOrphanSession(db, "cc-combined")!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" });
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "complete" });
    backdateEndedAt(db, orphan.sessionId, ORPHAN_RETENTION_MS + DAY);

    const summary = pruneRetention(db);
    expect(summary.prunedSessions).toBe(1);
    expect(summary.prunedAgents).toBe(1);
    expect(summary.ok).toBe(true);
  });

  it("is best-effort: a prune over a closed db returns ok:false, never throws", () => {
    db.close();
    let threw = false;
    const summary = (() => {
      try {
        return pruneRetention(db);
      } catch {
        threw = true;
        return null;
      }
    })();
    expect(threw).toBe(false);
    expect(summary?.ok).toBe(false);
  });
});

describe("reapStuckRunningOrphans (ST-P3 zombie fix)", () => {
  let db: Database;
  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  /**
   * Backdate a session's last-activity to N ms before now: its `started_at` AND
   * every event row already attached to it (the `state.transition` rows
   * `applyTransition` writes are real events; in production a stuck session's
   * most-recent event — raw hook OR transition — is what "last activity" reads).
   * Models a session that has been fully silent for `msAgo`.
   */
  function silenceSession(sessionId: string, msAgo: number): void {
    const iso = new Date(Date.now() - msAgo).toISOString();
    db.query(`UPDATE sessions SET started_at = ? WHERE id = ?`).run(iso, sessionId);
    db.query(`UPDATE events SET timestamp = ? WHERE session_id = ?`).run(iso, sessionId);
  }

  it("reaps a stuck-running orphan past the TTL → terminal + ended_at stamped", () => {
    const orphan = registerOrphanSession(db, "cc-stuck-1")!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" }); // → running
    // No events; backdate started_at past the TTL so "last activity" is stale.
    silenceSession(orphan.sessionId, STUCK_RUNNING_TTL_MS + 60_000);

    const result = reapStuckRunningOrphans(db);
    expect(result.reaped).toBe(1);

    const ata = db.query(`SELECT state FROM agent_task_assignment WHERE id = ?`)
      .get(orphan.assignmentId) as { state: string };
    expect(ata.state).toBe("cancelled"); // terminal — abandoned-work convention

    const sess = db.query(`SELECT ended_at FROM sessions WHERE id = ?`)
      .get(orphan.sessionId) as { ended_at: string | null };
    expect(sess.ended_at).toBeTruthy(); // stamped via applyTransition
  });

  it("reaps a stuck orphan whose LAST EVENT is past the TTL (events drive last activity)", () => {
    const orphan = registerOrphanSession(db, "cc-stuck-ev")!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" });
    insertEvent(db, { sessionId: orphan.sessionId, type: "stream-json", payload: {} });
    // Fully silence: started_at AND all events stale past the TTL.
    silenceSession(orphan.sessionId, STUCK_RUNNING_TTL_MS + 60_000);

    const result = reapStuckRunningOrphans(db);
    expect(result.reaped).toBe(1);
    const ata = db.query(`SELECT state FROM agent_task_assignment WHERE id = ?`)
      .get(orphan.assignmentId) as { state: string };
    expect(ata.state).toBe("cancelled");
  });

  it("does NOT reap an orphan with a RECENT event (still alive)", () => {
    const orphan = registerOrphanSession(db, "cc-alive")!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" });
    // Push the start + started_at far into the past...
    silenceSession(orphan.sessionId, 90 * DAY);
    // ...then a heartbeat event 1 min ago: MAX(events.timestamp) is fresh.
    const ev = insertEvent(db, { sessionId: orphan.sessionId, type: "stream-json", payload: {} });
    backdateEvent(db, ev.id, 60_000);

    const result = reapStuckRunningOrphans(db);
    expect(result.reaped).toBe(0);
    const ata = db.query(`SELECT state FROM agent_task_assignment WHERE id = ?`)
      .get(orphan.assignmentId) as { state: string };
    expect(ata.state).toBe("running"); // untouched
  });

  it("does NOT reap a freshly-started orphan within the TTL", () => {
    const orphan = registerOrphanSession(db, "cc-fresh-run")!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" });
    // started just now, no events → last activity = started_at, within TTL
    const result = reapStuckRunningOrphans(db);
    expect(result.reaped).toBe(0);
    const ata = db.query(`SELECT state FROM agent_task_assignment WHERE id = ?`)
      .get(orphan.assignmentId) as { state: string };
    expect(ata.state).toBe("running");
  });

  it("reaps a stuck orphan still in 'dispatched' (never even started) past the TTL", () => {
    const orphan = registerOrphanSession(db, "cc-stuck-disp")!;
    // born dispatched; no start event ever arrived
    silenceSession(orphan.sessionId, STUCK_RUNNING_TTL_MS + 60_000);
    const result = reapStuckRunningOrphans(db);
    expect(result.reaped).toBe(1);
    const ata = db.query(`SELECT state FROM agent_task_assignment WHERE id = ?`)
      .get(orphan.assignmentId) as { state: string };
    expect(ata.state).toBe("cancelled");
  });

  it("reaps a stuck orphan in 'blocked' past the TTL", () => {
    const orphan = registerOrphanSession(db, "cc-stuck-blocked")!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" });
    applyTransition(db, orphan.assignmentId, orphan.sessionId, {
      type: "block",
      reason: { kind: "review.checkpoint", payload: { description: "stuck" } },
    });
    silenceSession(orphan.sessionId, STUCK_RUNNING_TTL_MS + 60_000);
    const result = reapStuckRunningOrphans(db);
    expect(result.reaped).toBe(1);
    const ata = db.query(`SELECT state FROM agent_task_assignment WHERE id = ?`)
      .get(orphan.assignmentId) as { state: string };
    expect(ata.state).toBe("cancelled");
  });

  it("NEVER reaps a real (non-orphan) stuck-running assignment, even when ancient", () => {
    db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system, status) VALUES ('real-task', 'Real', 2, 'andreas', 'github', 'in_progress')`);
    db.exec(`INSERT INTO agents (id, name, type, persistent) VALUES ('real-agent', 'Echo', 'head', 1)`);
    db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id, state) VALUES ('real-ata', 'real-agent', 'real-task', 'running')`);
    const sid = "real-session";
    db.query(`INSERT INTO sessions (id, assignment_id, cc_session_id, endpoint_kind, started_at) VALUES (?, 'real-ata', 'cc-real', 'local.process.controlled', ?)`)
      .run(sid, new Date(Date.now() - 90 * DAY).toISOString());

    const result = reapStuckRunningOrphans(db);
    expect(result.reaped).toBe(0);
    const ata = db.query(`SELECT state FROM agent_task_assignment WHERE id = 'real-ata'`).get() as { state: string };
    expect(ata.state).toBe("running"); // real dispatch never touched
  });

  it("does NOT touch an already-terminal orphan", () => {
    const orphan = registerOrphanSession(db, "cc-already-term")!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" });
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "complete" });
    silenceSession(orphan.sessionId, STUCK_RUNNING_TTL_MS + 60_000);
    const result = reapStuckRunningOrphans(db);
    expect(result.reaped).toBe(0);
    const ata = db.query(`SELECT state FROM agent_task_assignment WHERE id = ?`)
      .get(orphan.assignmentId) as { state: string };
    expect(ata.state).toBe("completed"); // unchanged
  });

  it("is idempotent — a second reap over the same state is a no-op", () => {
    const orphan = registerOrphanSession(db, "cc-reap-idem")!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" });
    silenceSession(orphan.sessionId, STUCK_RUNNING_TTL_MS + 60_000);
    expect(reapStuckRunningOrphans(db).reaped).toBe(1);
    expect(reapStuckRunningOrphans(db).reaped).toBe(0);
  });

  it("composes with the terminal-age prune: reaped row becomes prunable", () => {
    // A zombie running orphan past TTL → reaped → cancelled + ended_at stamped.
    const orphan = registerOrphanSession(db, "cc-reap-then-prune")!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" });
    silenceSession(orphan.sessionId, STUCK_RUNNING_TTL_MS + 60_000);
    expect(reapStuckRunningOrphans(db).reaped).toBe(1);

    // Immediately after reaping, ended_at is "now" → within the terminal window,
    // so the prune retains it. Backdate ended_at past the window to simulate a
    // later prune cycle, then verify the prune sweeps the reaped row.
    backdateEndedAt(db, orphan.sessionId, ORPHAN_RETENTION_MS + DAY);
    const pruned = pruneOrphanSessions(db);
    expect(pruned.prunedSessions).toBe(1);
    expect(db.query(`SELECT 1 FROM sessions WHERE id = ?`).get(orphan.sessionId)).toBeNull();
  });

  it("pruneRetention runs the reaper before the prune (reap → prune in one sweep)", () => {
    const orphan = registerOrphanSession(db, "cc-full-sweep")!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" });
    silenceSession(orphan.sessionId, STUCK_RUNNING_TTL_MS + 60_000);

    const summary = pruneRetention(db);
    expect(summary.ok).toBe(true);
    expect(summary.reaped).toBe(1);
    // Reaped this cycle → ended_at is "now" → not yet prunable by terminal age.
    const ata = db.query(`SELECT state FROM agent_task_assignment WHERE id = ?`)
      .get(orphan.assignmentId) as { state: string };
    expect(ata.state).toBe("cancelled");
  });
});

describe("ThrottledPrune (caller throttle)", () => {
  it("runs on the first call then suppresses within the interval", () => {
    let runs = 0;
    let now = 1_000_000;
    const throttle = new ThrottledPrune({
      intervalMs: 60 * 60 * 1000, // 1h
      now: () => now,
      run: () => { runs += 1; },
    });

    throttle.maybeRun(); // first call → runs
    expect(runs).toBe(1);

    now += 60 * 1000; // +1 min, well within the 1h window
    throttle.maybeRun();
    expect(runs).toBe(1); // suppressed

    now += 60 * 60 * 1000; // +1h, past the window
    throttle.maybeRun();
    expect(runs).toBe(2); // runs again
  });

  it("never throws out of maybeRun even when the run throws", () => {
    const now = 0;
    const throttle = new ThrottledPrune({
      intervalMs: 1000,
      now: () => now,
      run: () => { throw new Error("prune blew up"); },
    });
    let threw = false;
    try {
      throttle.maybeRun();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it("advances the last-run clock even when the run throws (no tight-loop retry storm)", () => {
    let runs = 0;
    let now = 0;
    const throttle = new ThrottledPrune({
      intervalMs: 1000,
      now: () => now,
      run: () => { runs += 1; throw new Error("boom"); },
    });
    throttle.maybeRun();
    expect(runs).toBe(1);
    now += 100; // within window
    throttle.maybeRun();
    expect(runs).toBe(1); // suppressed despite the prior throw
  });
});
