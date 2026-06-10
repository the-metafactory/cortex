/**
 * MC-I1.S4 (ADR-0005 §4) — tests for the dispatch-lifecycle projection renderer
 * (the bus→MC surface-router seam).
 *
 * Verifies:
 *   1. The adapter's subjects + id are stable + match the dispatch-lifecycle
 *      grammar (local stack-ful/stack-less + federated).
 *   2. render() routes a `dispatch.task.*` envelope into MC rows.
 *   3. render() ignores non-dispatch envelopes (no rows written).
 *   4. render() NEVER throws — a malformed envelope is swallowed + logged.
 *   5. The renderer subjects actually match real derived subjects via the
 *      surface-router's NATS matcher (the wire-level join).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { SCHEMA_SQL } from "../db/schema";
import {
  createDispatchProjectionRenderer,
  DISPATCH_PROJECTION_RENDERER_ID,
  DISPATCH_PROJECTION_SUBJECTS,
  type FailedDispatchAttentionWiring,
} from "../projection/dispatch-lifecycle-renderer";
import { subjectMatches } from "../../../bus/surface-router";
import {
  createDispatchTaskStartedEvent,
  createDispatchTaskFailedEvent,
  type DispatchEventSource,
} from "../../../bus/dispatch-events";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import type { AttentionDelta } from "../projection/failed-dispatch";
import { getAttentionItem } from "../db/attention";

const SOURCE: DispatchEventSource = {
  principal: "andreas",
  agent: "cortex",
  instance: "local",
};
const TASK_ID = "33333333-3333-4333-8333-333333333333";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

function sessionCount(db: Database): number {
  return (
    db.query(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }
  ).n;
}

describe("createDispatchProjectionRenderer", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it("exposes a stable id + the dispatch-lifecycle subjects", () => {
    const adapter = createDispatchProjectionRenderer(db);
    expect(adapter.id).toBe(DISPATCH_PROJECTION_RENDERER_ID);
    expect(adapter.subjects).toEqual(DISPATCH_PROJECTION_SUBJECTS);
  });

  it("render() projects a dispatch.task.started envelope into MC rows", async () => {
    const adapter = createDispatchProjectionRenderer(db);
    const env = createDispatchTaskStartedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: new Date("2026-06-10T12:00:00.000Z"),
    });
    await adapter.render(env);
    expect(sessionCount(db)).toBe(1);
  });

  it("render() ignores a non-dispatch envelope (no rows written)", async () => {
    const adapter = createDispatchProjectionRenderer(db);
    const env: Envelope = {
      ...createDispatchTaskStartedEvent({
        source: SOURCE,
        taskId: TASK_ID,
        agentId: "cortex",
        startedAt: new Date(),
      }),
      type: "system.heartbeat",
    };
    await adapter.render(env);
    expect(sessionCount(db)).toBe(0);
  });

  it("render() never throws on a malformed envelope", async () => {
    const adapter = createDispatchProjectionRenderer(db);
    // A dispatch type but a garbage payload — must be swallowed, not thrown.
    const bad = {
      id: "x",
      type: "dispatch.task.started",
      payload: null,
    } as unknown as Envelope;
    await expect(adapter.render(bad)).resolves.toBeUndefined();
    expect(sessionCount(db)).toBe(0);
  });

  it("subjects match real derived dispatch.task subjects via the router matcher", () => {
    // Stack-ful, stack-less, and federated derived subjects (from
    // @the-metafactory/myelin deriveSubject) must each be caught by at least
    // one of the renderer's subscribe patterns.
    const derived = [
      "local.andreas.work.dispatch.task.started",
      "local.andreas.dispatch.task.completed",
      "federated.peer.work.dispatch.task.failed",
    ];
    for (const subject of derived) {
      const hit = DISPATCH_PROJECTION_SUBJECTS.some((p) =>
        subjectMatches(p, subject),
      );
      expect(hit).toBe(true);
    }
  });

  it("subjects match the S6-generalized families (verdict / heartbeat / attention / adapter)", () => {
    // S6 (#848) extends the seam beyond dispatch.task.*: the renderer now
    // subscribes to the four additional projection families on the local
    // (stack-ful + stack-less) and federated grammars.
    const derived = [
      // review verdicts
      "local.andreas.work.review.verdict.changes-requested",
      "local.andreas.review.verdict.approved",
      "federated.peer.work.review.verdict.commented",
      // agent heartbeat
      "local.andreas.work.system.agent.heartbeat",
      "local.andreas.system.agent.heartbeat",
      "federated.peer.work.system.agent.heartbeat",
      // attention
      "local.andreas.work.system.attention.opened",
      "federated.peer.work.system.attention.resolved",
      // adapter health
      "local.andreas.work.system.adapter.degraded",
      "federated.peer.work.system.adapter.recovered",
    ];
    for (const subject of derived) {
      const hit = DISPATCH_PROJECTION_SUBJECTS.some((p) =>
        subjectMatches(p, subject),
      );
      expect(hit).toBe(true);
    }
  });

  it("does NOT match subjects outside any projection family", () => {
    const nonProjection = [
      // a chat dispatch (handled elsewhere), not a projection family
      "local.andreas.tasks.@did-mf-luna.chat",
      // a different system.* subdomain the projection doesn't own
      "local.andreas.work.system.inbound.aborted",
      // github webhook events
      "local.andreas.work.github.push.created",
    ];
    for (const subject of nonProjection) {
      const hit = DISPATCH_PROJECTION_SUBJECTS.some((p) =>
        subjectMatches(p, subject),
      );
      expect(hit).toBe(false);
    }
  });

  // --- MC-I1.S7: failed_dispatch attention notify funnel ---

  function failedEnvelope(): Envelope {
    return createDispatchTaskFailedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "cortex",
      startedAt: new Date("2026-06-10T12:00:00.000Z"),
      failedAt: new Date("2026-06-10T12:05:00.000Z"),
      errorSummary: "boom",
      reason: { kind: "cant_do", detail: "bad output" },
    });
  }

  it("opens a failed_dispatch item and funnels the opened delta to publishDelta", async () => {
    const deltas: AttentionDelta[] = [];
    const wiring: FailedDispatchAttentionWiring = {
      stackId: "work",
      publishDelta: (d) => {
        deltas.push(d);
      },
    };
    const adapter = createDispatchProjectionRenderer(db, undefined, wiring);
    await adapter.render(failedEnvelope());

    expect(getAttentionItem(db, `att:faildis:${TASK_ID}`)?.status).toBe("open");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.opened).toHaveLength(1);
    expect(deltas[0]?.resolved).toHaveLength(0);
  });

  it("funnels the resolved delta when a redispatch started clears a failed item", async () => {
    const deltas: AttentionDelta[] = [];
    const wiring: FailedDispatchAttentionWiring = {
      stackId: "work",
      publishDelta: (d) => {
        deltas.push(d);
      },
    };
    const adapter = createDispatchProjectionRenderer(db, undefined, wiring);
    await adapter.render(failedEnvelope());
    // A redispatch started for the same anchor resolves the failed item.
    await adapter.render(
      createDispatchTaskStartedEvent({
        source: SOURCE,
        taskId: TASK_ID,
        agentId: "cortex",
        startedAt: new Date("2026-06-10T12:10:00.000Z"),
      }),
    );

    expect(getAttentionItem(db, `att:faildis:${TASK_ID}`)?.status).toBe("resolved");
    // Two publishDelta calls: one opened, then one resolved.
    expect(deltas).toHaveLength(2);
    expect(deltas[1]?.resolved).toHaveLength(1);
  });

  it("still writes the DB item when no publishDelta is wired (headless)", async () => {
    // Wiring with stackId but no publisher — the DB write happens, no notify.
    const adapter = createDispatchProjectionRenderer(db, undefined, { stackId: "work" });
    await adapter.render(failedEnvelope());
    expect(getAttentionItem(db, `att:faildis:${TASK_ID}`)?.status).toBe("open");
  });

  it("produces NO failed_dispatch item when no failedDispatch wiring is supplied (S4 back-compat)", async () => {
    const adapter = createDispatchProjectionRenderer(db);
    await adapter.render(failedEnvelope());
    // The lifecycle projection still ran (assignment failed), but no attention.
    expect(getAttentionItem(db, `att:faildis:${TASK_ID}`)).toBeNull();
  });
});
