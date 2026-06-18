/**
 * MC-I1.S6 (#848) — tests for the `ensureAgentRow` DRY helper (the deferred
 * #861-review finding-3 pickup) AND the three call sites it now backs.
 *
 * The helper itself: insert-only-name idempotency + the type/persistent
 * parameterisation. The call sites: `ensureNamedAgent` / the dispatch anchor
 * still land the SAME rows; `registerOrphanSession` now (ST-P2) lands the REAL
 * owning agent (not a per-session `mc-orphan-{cc}` agent — the 1,044-tile fix).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { SCHEMA_SQL } from "../db/schema";
import { ensureAgentRow } from "../db/agents";
import { registerOrphanSession, resolveOwningAgentId } from "../db/sessions";
import { projectDispatchLifecycle } from "../projection/dispatch-lifecycle";
import {
  createDispatchTaskStartedEvent,
  type DispatchEventSource,
} from "../../../bus/dispatch-events";

const SOURCE: DispatchEventSource = {
  principal: "andreas",
  agent: "cortex",
  instance: "local",
};
const TASK_ID = "44444444-4444-4444-8444-444444444444";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

interface AgentRow {
  id: string;
  name: string;
  type: string;
  persistent: number;
}

function agent(db: Database, id: string): AgentRow | null {
  return db
    .query(`SELECT id, name, type, persistent FROM agents WHERE id = ?`)
    .get(id) as AgentRow | null;
}

describe("ensureAgentRow", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("inserts a head/persistent agent", () => {
    ensureAgentRow(db, { id: "echo", name: "Echo", type: "head", persistent: true });
    expect(agent(db, "echo")).toEqual({
      id: "echo",
      name: "Echo",
      type: "head",
      persistent: 1,
    });
  });

  it("inserts a hands/non-persistent agent", () => {
    ensureAgentRow(db, { id: "worker", name: "Worker", type: "hands", persistent: false });
    expect(agent(db, "worker")).toEqual({
      id: "worker",
      name: "Worker",
      type: "hands",
      persistent: 0,
    });
  });

  it("is insert-only on the name — a second call never clobbers a principal-edited name", () => {
    ensureAgentRow(db, { id: "luna", name: "Luna", type: "head", persistent: true });
    // Principal renames the agent out-of-band.
    db.query(`UPDATE agents SET name = ? WHERE id = ?`).run("Luna (renamed)", "luna");
    // A re-dispatch calls ensureAgentRow again with the ORIGINAL name.
    ensureAgentRow(db, { id: "luna", name: "Luna", type: "head", persistent: true });
    expect(agent(db, "luna")?.name).toBe("Luna (renamed)");
  });

  it("is idempotent — repeated calls do not create duplicate rows", () => {
    ensureAgentRow(db, { id: "echo", name: "Echo", type: "head", persistent: true });
    ensureAgentRow(db, { id: "echo", name: "Echo", type: "head", persistent: true });
    const n = (
      db.query(`SELECT COUNT(*) AS n FROM agents WHERE id = 'echo'`).get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(1);
  });
});

describe("ensureAgentRow — call sites behaviour unchanged", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  // ST-P2: registerOrphanSession no longer mints a per-session agent. It
  // resolves the REAL owning agent from the supplied identity and lands ONE
  // head/persistent agent for it; the display name rides on the session column.
  it("registerOrphanSession lands a head/persistent owning agent resolved from agentId", () => {
    const cc = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    registerOrphanSession(db, cc, { agentId: "luna", displayName: "Luna" });
    const row = agent(db, resolveOwningAgentId(cc, "luna", "Luna"));
    expect(row).not.toBeNull();
    expect(row?.id).toBe("luna"); // the REAL wrapper identity, not mc-orphan-{cc}
    expect(row?.type).toBe("head");
    expect(row?.persistent).toBe(1);
    expect(row?.name).toBe("Luna");
    // The display name also lands on the session row (a session is not an agent).
    const sess = db
      .query(`SELECT agent_id, agent_name FROM sessions WHERE cc_session_id = ?`)
      .get(cc) as { agent_id: string; agent_name: string };
    expect(sess.agent_id).toBe("luna");
    expect(sess.agent_name).toBe("Luna");
  });

  it("registerOrphanSession resolves an observed: identity from displayName when no agentId", () => {
    const cc = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    registerOrphanSession(db, cc, { displayName: "Andreas" });
    const id = resolveOwningAgentId(cc, undefined, "Andreas");
    expect(id).toBe("observed:andreas");
    expect(agent(db, id)?.name).toBe("Andreas");
  });

  it("registerOrphanSession falls back to observed:{cc} for a fully anonymous session", () => {
    const cc = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    registerOrphanSession(db, cc);
    const id = resolveOwningAgentId(cc, undefined, undefined);
    expect(id).toBe(`observed:${cc}`);
    // No legacy per-session mc-orphan- agent is minted.
    const legacy = db.query(`SELECT 1 FROM agents WHERE id LIKE 'mc-orphan-%'`).get();
    expect(legacy).toBeNull();
  });

  it("the dispatch anchor still lands a head/persistent agent (S4 copy path)", () => {
    projectDispatchLifecycle(
      db,
      createDispatchTaskStartedEvent({
        source: SOURCE,
        taskId: TASK_ID,
        agentId: "echo",
        startedAt: new Date("2026-06-10T12:00:00.000Z"),
      }),
    );
    const row = agent(db, "echo");
    expect(row).not.toBeNull();
    expect(row?.type).toBe("head");
    expect(row?.persistent).toBe(1);
  });
});
