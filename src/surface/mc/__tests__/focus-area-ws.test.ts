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
import { isFocusAreaTransition } from "../dashboard-v2/lib/focus-area-filter";

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
  let port: number;

  beforeAll(() => {
    db = initDatabase(join(tmpDir, "test.db"));
    ctx = startServer({ ...DEFAULT_CONFIG, port: 0 }, db);
    port = ctx.port;

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

  it("broadcasts two state.transition messages across block + principal_requeue, and focus-area membership flips accordingly", async () => {
    const client = await createClient(port);
    await client.waitFor(1);
    await waitUntil(() => ctx.wsRegistry.size >= 1);

    expect(listFocusArea(db)).toHaveLength(0);

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
    if (!blockResult.ok) return;

    broadcastTransition(
      ctx.wsRegistry,
      "ata-1",
      blockResult.from,
      blockResult.assignment.state,
      blockResult.assignment.block_reason
    );

    const after1 = await client.waitFor(2);

    expect(listFocusArea(db)).toHaveLength(1);

    const requeueResult = applyTransition(db, "ata-1", sessionRow.id, {
      type: "principal_requeue",
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

    const after2 = await client.waitFor(3);

    expect(listFocusArea(db)).toHaveLength(0);

    const transitions = after2.filter(
      (m): m is { type: string; assignmentId: string; from: string; to: string } =>
        typeof m === "object" &&
        m !== null &&
        (m as { type?: string }).type === "state.transition"
    );
    expect(transitions).toHaveLength(2);

    expect(transitions[0]).toMatchObject({
      type: "state.transition",
      assignmentId: "ata-1",
      from: "running",
      to: "blocked",
    });

    expect(transitions[1]).toMatchObject({
      type: "state.transition",
      assignmentId: "ata-1",
      from: "blocked",
      to: "queued",
    });

    for (const t of transitions) {
      expect(isFocusAreaTransition(t)).toBe(true);
    }

    client.ws.close();
    await waitUntil(() => ctx.wsRegistry.size === 0);
  });
});
