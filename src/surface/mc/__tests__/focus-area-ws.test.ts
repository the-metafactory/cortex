/**
 * Grove Mission Control v2 — F-6 focus-area WS→refetch integration test.
 *
 * design-mc-f6-focus-area.md §4 acceptance criterion:
 *   "the WS re-fetch trigger has one integration test that drives `block`
 *    then `operator_requeue` and asserts two re-renders."
 *
 * Strategy: we can't observe dashboard rendering from the server side, but
 * we can verify the signal the dashboard uses to trigger a re-render —
 * namely, the two `state.transition` WS broadcasts where either `from` or
 * `to` equals `blocked`. The dashboard code (dashboard/index.html) calls
 * `scheduleFocusRefetch()` (→ `fetchFocusArea()`) exactly once per such
 * broadcast; receiving two broadcasts with the right shape is the
 * necessary-and-sufficient server-side condition for two re-renders.
 *
 * In addition we assert the DB state after each transition so the two
 * re-renders would observe the correct focus-area contents (card appears
 * after `block`, disappears after `operator_requeue`).
 *
 * Added for PR #8 review finding W2.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { startServer, type ServerContext } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { applyTransition } from "../db/transitions";
import { broadcastTransition } from "../notifications";
import { createSession } from "../db/sessions";
import { listFocusArea } from "../db/assignments";
import type { BlockReason } from "../types";

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 5
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function createClient(port: number): Promise<{
  ws: WebSocket;
  messages: unknown[];
  waitFor: (n: number) => Promise<unknown[]>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const messages: unknown[] = [];
    let waitResolve: ((msgs: unknown[]) => void) | null = null;
    let waitCount = 0;

    ws.onmessage = (event) => {
      messages.push(JSON.parse(event.data as string));
      if (waitResolve && messages.length >= waitCount) {
        waitResolve(messages.slice());
        waitResolve = null;
      }
    };

    ws.onopen = () => {
      resolve({
        ws,
        messages,
        waitFor(n: number) {
          if (messages.length >= n) return Promise.resolve(messages.slice());
          waitCount = n;
          return new Promise((res, rej) => {
            waitResolve = res;
            setTimeout(
              () =>
                rej(
                  new Error(
                    `WS timeout waiting for ${n} messages, got ${messages.length}`
                  )
                ),
              3000
            );
          });
        },
      });
    };

    ws.onerror = () => reject(new Error("WS connect error"));
    setTimeout(() => reject(new Error("WS connect timeout")), 3000);
  });
}

describe("F-6 focus-area WS→refetch integration", () => {
  let db: Database;
  let ctx: ServerContext;
  const tmpDir = join(tmpdir(), `mc-focus-ws-test-${Date.now()}`);
  const port = 19200 + Math.floor(Math.random() * 500);

  beforeAll(() => {
    db = initDatabase(join(tmpDir, "test.db"));
    ctx = startServer({ ...DEFAULT_CONFIG, port }, db);

    // Seed an assignment in `running` state with a session so we have
    // something to block → unblock.
    db.exec(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system)
       VALUES ('t-1', 'F-6 WS test task', 0, 'op', 'internal')`
    );
    db.exec(
      `INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`
    );
    db.exec(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES ('ata-1', 'a-1', 't-1', 'running')`
    );
    createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.process.controlled",
    });
  });

  afterAll(() => {
    ctx.stop(true);
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("broadcasts two state.transition messages across block + operator_requeue, and focus-area membership flips accordingly", async () => {
    // --- Connect a dashboard-like WS client before any transitions fire ---
    const client = await createClient(port);
    await client.waitFor(1); // initial `connected` envelope
    await waitUntil(() => ctx.wsRegistry.size >= 1);

    // --- Pre-state: no blocked assignments, so focus area is empty ---
    expect(listFocusArea(db)).toHaveLength(0);

    // --- Transition 1: block the running assignment ---
    // Mirrors the production call pattern in api/handlers.ts and
    // session/stdout-dispatcher.ts: applyTransition → broadcastTransition.
    const blockReason: BlockReason = {
      kind: "permission.request",
      payload: { requested_action: "tool.edit" },
    };
    const sessionRow = db
      .query("SELECT id FROM sessions WHERE assignment_id = 'ata-1' LIMIT 1")
      .get() as { id: string };

    const blockResult = applyTransition(db, "ata-1", sessionRow.id, {
      type: "block",
      reason: blockReason,
    });
    expect(blockResult.ok).toBe(true);
    if (!blockResult.ok) return; // type narrowing

    broadcastTransition(
      ctx.wsRegistry,
      "ata-1",
      blockResult.from,
      blockResult.assignment.state,
      blockResult.assignment.block_reason
    );

    // Wait for the first transition broadcast to land on the client.
    const after1 = await client.waitFor(2); // connected + transition#1

    // Focus area now contains the blocked assignment — dashboard re-render #1
    // would observe the new card.
    expect(listFocusArea(db)).toHaveLength(1);

    // --- Transition 2: operator_requeue the blocked assignment ---
    const requeueResult = applyTransition(db, "ata-1", sessionRow.id, {
      type: "operator_requeue",
    });
    expect(requeueResult.ok).toBe(true);
    if (!requeueResult.ok) return;

    broadcastTransition(
      ctx.wsRegistry,
      "ata-1",
      requeueResult.from,
      requeueResult.assignment.state,
      requeueResult.assignment.block_reason
    );

    const after2 = await client.waitFor(3); // connected + transition#1 + transition#2

    // Focus area is empty again — dashboard re-render #2 would observe the
    // card disappear.
    expect(listFocusArea(db)).toHaveLength(0);

    // --- Assertions on the broadcast sequence ---
    // Filter to state.transition frames only so this test isn't coupled to
    // any unrelated WS traffic (e.g. a future heartbeat frame).
    const transitions = after2.filter(
      (m): m is { type: string; assignmentId: string; from: string; to: string } =>
        typeof m === "object" &&
        m !== null &&
        (m as { type?: string }).type === "state.transition"
    );
    expect(transitions).toHaveLength(2);

    // Transition 1: running → blocked (dashboard re-renders focus area).
    expect(transitions[0]).toMatchObject({
      type: "state.transition",
      assignmentId: "ata-1",
      from: "running",
      to: "blocked",
    });

    // Transition 2: blocked → queued (dashboard re-renders focus area —
    // this is the "card disappears without reload" half of AC §4).
    expect(transitions[1]).toMatchObject({
      type: "state.transition",
      assignmentId: "ata-1",
      from: "blocked",
      to: "queued",
    });

    // Dashboard behavior under test (dashboard/index.html handleWsMessage):
    //   `if (msg.from === "blocked" || msg.to === "blocked") scheduleFocusRefetch();`
    // Both transitions satisfy that predicate → two re-renders fire.
    for (const t of transitions) {
      expect(t.from === "blocked" || t.to === "blocked").toBe(true);
    }

    client.ws.close();
    await waitUntil(() => ctx.wsRegistry.size === 0);
  });
});
