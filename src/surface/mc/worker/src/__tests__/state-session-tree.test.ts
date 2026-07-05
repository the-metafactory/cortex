/**
 * ST-P4 — D1 state-projection test for the session tree.
 *
 * Drives the REAL `buildSnapshot` (worker/src/routes/state.ts) against an
 * in-memory bun:sqlite DB loaded from the worker's own `schema.sql`, asserting
 * the `/api/state` payload now carries:
 *   - the new `parent_session_id` + `substrate` per active session, AND
 *   - a top-level `sessionTree` forest assembled from those sessions.
 *
 * Lifecycle metadata only (ADR-0005) — no interiors are projected to the cloud.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { buildSnapshot } from "../routes/state";
import { d1, loadSchema } from "./d1-shim";

/** Seed an ACTIVE session (inside the 3-hour active window). */
function seedActiveSession(
  db: Database,
  sessionId: string,
  opts: { parentSessionId?: string | null; substrate?: string; agentName?: string } = {}
): void {
  db.query(
    `INSERT INTO sessions
       (session_id, agent_id, agent_name, started_at, last_event_at, status,
        parent_session_id, substrate)
     VALUES (?, 'luna', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active', ?, ?)`
  ).run(
    sessionId,
    opts.agentName ?? "Luna",
    opts.parentSessionId ?? null,
    opts.substrate ?? "claude-code"
  );
}

describe("D1 state projection — session tree (ST-P4)", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    loadSchema(db);
  });
  afterEach(() => db.close());

  it("surfaces parent_session_id + substrate on each active session's currentTask", async () => {
    seedActiveSession(db, "s-root", { substrate: "codex" });
    const snap = await buildSnapshot(d1(db));
    const agent = snap.agents.find((a: any) => a.currentTask.sessionId === "s-root")!;
    expect(agent.currentTask.parentSessionId).toBeNull();
    expect(agent.currentTask.substrate).toBe("codex");
  });

  it("assembles a nested sessionTree from parent-linked active sessions", async () => {
    seedActiveSession(db, "s-root");
    seedActiveSession(db, "s-child", { parentSessionId: "s-root" });
    seedActiveSession(db, "s-grandchild", { parentSessionId: "s-child" });

    const snap = await buildSnapshot(d1(db));
    expect(Array.isArray(snap.sessionTree)).toBe(true);
    expect(snap.sessionTree).toHaveLength(1);
    const root = snap.sessionTree[0]!;
    expect(root.session_id).toBe("s-root");
    expect(root.children.map((c: any) => c.session_id)).toEqual(["s-child"]);
    expect(root.children[0].children.map((c: any) => c.session_id)).toEqual(["s-grandchild"]);
  });

  it("promotes a child whose parent is outside the active window to a root (orphaned-parent → root)", async () => {
    // Parent is OLD (outside the 3h active window) → not selected; the child's
    // parent ref is orphaned in the projected set and must still render.
    db.query(
      `INSERT INTO sessions
         (session_id, agent_id, agent_name, started_at, last_event_at, status, substrate)
       VALUES ('s-old-parent', 'luna', 'Luna',
               strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'),
               strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'), 'active', 'claude-code')`
    ).run();
    seedActiveSession(db, "s-child", { parentSessionId: "s-old-parent" });

    const snap = await buildSnapshot(d1(db));
    expect(snap.sessionTree).toHaveLength(1);
    expect(snap.sessionTree[0].session_id).toBe("s-child");
    expect(snap.sessionTree[0].parent_session_id).toBe("s-old-parent");
  });

  it("defaults substrate to 'claude-code' when an insert omits it (DDL DEFAULT)", async () => {
    // The D1 `substrate` column is NOT NULL DEFAULT 'claude-code'; a row whose
    // insert omits substrate gets the default. The projection surfaces it
    // verbatim (the code's `?? 'claude-code'` is belt-and-suspenders for the
    // NULL that the DDL forbids).
    db.query(
      `INSERT INTO sessions
         (session_id, agent_id, agent_name, started_at, last_event_at, status)
       VALUES ('s-default', 'luna', 'Luna',
               strftime('%Y-%m-%dT%H:%M:%fZ','now'),
               strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')`
    ).run();
    const snap = await buildSnapshot(d1(db));
    const agent = snap.agents.find((a: any) => a.currentTask.sessionId === "s-default")!;
    expect(agent.currentTask.substrate).toBe("claude-code");
    expect(
      snap.sessionTree.find((n: any) => n.session_id === "s-default")!.substrate
    ).toBe("claude-code");
  });
});
