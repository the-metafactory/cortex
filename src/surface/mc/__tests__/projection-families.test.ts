/**
 * MC-I1.S6 (#848, ADR-0005 §4) — tests for the generalized MC projection
 * families (verdicts, heartbeats, federated attention, adapter health) and the
 * renderer's dispatcher + WS broadcast.
 *
 * Coverage axes (per the slice brief's TDD list):
 *   - verdict joinable (dispatch anchor present) + unattached (no anchor)
 *   - heartbeat liveness touch on the projected session
 *   - adapter health open/resolve
 *   - federated attention ingest; local attention IGNORED (scoping decision)
 *   - WS broadcast emitted on a projected mutation (fake registry)
 *   - idempotency under redelivery
 *   - non-dispatch families ignored by the dispatch handler and vice versa
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { SCHEMA_SQL } from "../db/schema";
import { projectDispatchLifecycle } from "../projection/dispatch-lifecycle";
import { projectReviewVerdict } from "../projection/review-verdict";
import { projectHeartbeat } from "../projection/heartbeat";
import {
  projectAttention,
  FEDERATED_ATTENTION_PREFIX,
} from "../projection/attention-projection";
import {
  projectAdapterLifecycle,
  ADAPTER_ATTENTION_PREFIX,
} from "../projection/adapter-lifecycle";
import {
  createDispatchProjectionRenderer,
  project,
} from "../projection/dispatch-lifecycle-renderer";
import {
  createDispatchTaskStartedEvent,
  type DispatchEventSource,
} from "../../../bus/dispatch-events";
import { createReviewVerdictEvent } from "../../../bus/review-events";
import { createAgentHeartbeatEvent } from "../../../bus/system-events";
import {
  createSystemAdapterDegradedEvent,
  createSystemAdapterRecoveredEvent,
} from "../../../bus/system-events";
import { attentionNotificationEnvelope } from "../attention-notify";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import type { AttentionItem } from "../types";
import type { WsClientRegistry } from "../ws/client-registry";
import type { WsServerMessage } from "../ws/types";

const SOURCE: DispatchEventSource = {
  principal: "andreas",
  agent: "cortex",
  instance: "local",
};
const CORRELATION = "99999999-9999-4999-8999-999999999999";
const TASK_ID = "88888888-8888-4888-8888-888888888888";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

/** Project a dispatch `started` keyed on CORRELATION so other families can join. */
function seedDispatchAnchor(db: Database): void {
  const env = createDispatchTaskStartedEvent({
    source: SOURCE,
    taskId: TASK_ID,
    agentId: "echo",
    startedAt: new Date("2026-06-10T12:00:00.000Z"),
    correlationId: CORRELATION,
  });
  projectDispatchLifecycle(db, env);
}

function eventsOfType(db: Database, type: string): { session_id: string; payload: string }[] {
  return db
    .query(`SELECT session_id, payload FROM events WHERE type = ?`)
    .all(type) as { session_id: string; payload: string }[];
}

function attentionRow(
  db: Database,
  id: string,
): { id: string; status: string; kind: string; severity: string } | null {
  return db
    .query(`SELECT id, status, kind, severity FROM attention_items WHERE id = ?`)
    .get(id) as { id: string; status: string; kind: string; severity: string } | null;
}

function makeVerdict(opts: { correlationId?: string } = {}): Envelope {
  return createReviewVerdictEvent({
    source: SOURCE,
    kind: "changes-requested",
    requestId: opts.correlationId ?? CORRELATION,
    correlationId: opts.correlationId ?? CORRELATION,
    payload: {
      repo: "the-metafactory/cortex",
      pr: 861,
      reviewer: "echo",
      verdict: "changes-requested",
      summary: "verdict: blockers=0 majors=2 nits=3",
      github_review_id: 123,
      github_review_url: "https://github.com/the-metafactory/cortex/pull/861#review-123",
      submitted_at: "2026-06-10T12:03:00.000Z",
      commit_id: "abc123",
      findings: { blockers: 0, majors: 2, nits: 3 },
      inline_comments: 5,
    },
  });
}

// ---------------------------------------------------------------------------
// Review verdicts
// ---------------------------------------------------------------------------

describe("projectReviewVerdict", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("joins a verdict onto the dispatch anchor session via correlation_id", () => {
    seedDispatchAnchor(db);
    const res = projectReviewVerdict(db, makeVerdict());
    expect(res).not.toBeNull();
    expect(res?.attached).toBe(true);
    const evs = eventsOfType(db, "review.verdict");
    expect(evs.length).toBe(1);
    expect(evs[0]?.session_id).toBe(res?.sessionId);
  });

  it("stores an unattached verdict when no dispatch anchor matches", () => {
    // No seedDispatchAnchor — correlation_id has no projected anchor.
    const res = projectReviewVerdict(db, makeVerdict({ correlationId: "no-such" }));
    expect(res).not.toBeNull();
    expect(res?.attached).toBe(false);
    expect(eventsOfType(db, "review.verdict").length).toBe(1);
  });

  it("is idempotent on redelivery (same envelope id) — one verdict event", () => {
    seedDispatchAnchor(db);
    const env = makeVerdict();
    projectReviewVerdict(db, env);
    projectReviewVerdict(db, env);
    expect(eventsOfType(db, "review.verdict").length).toBe(1);
  });

  it("ignores a non-verdict type", () => {
    expect(
      projectReviewVerdict(db, { type: "dispatch.task.started", payload: {} }),
    ).toBeNull();
  });

  it("ignores a malformed payload (missing repo/pr)", () => {
    expect(
      projectReviewVerdict(db, {
        type: "review.verdict.approved",
        correlation_id: CORRELATION,
        payload: { verdict: "approved" },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------

describe("projectHeartbeat", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  function makeHeartbeat(iteration: number): Envelope {
    return createAgentHeartbeatEvent({
      source: SOURCE,
      agentId: "echo",
      taskId: TASK_ID,
      correlationId: CORRELATION,
      phase: "tool_use",
      lastActivityMsAgo: 1200,
      iteration,
    });
  }

  it("touches liveness on the projected session via correlation_id", () => {
    seedDispatchAnchor(db);
    const res = projectHeartbeat(db, makeHeartbeat(1));
    expect(res).not.toBeNull();
    expect(res?.iteration).toBe(1);
    const evs = eventsOfType(db, "system.agent.heartbeat");
    expect(evs.length).toBe(1);
    expect(evs[0]?.session_id).toBe(res?.sessionId);
  });

  it("returns null when no dispatch anchor exists (does not synthesise one)", () => {
    expect(projectHeartbeat(db, makeHeartbeat(1))).toBeNull();
    expect(eventsOfType(db, "system.agent.heartbeat").length).toBe(0);
  });

  it("keeps EXACTLY ONE heartbeat row per session — N ticks collapse, latest iteration wins", () => {
    seedDispatchAnchor(db);
    // A burst of distinct 30s ticks (the unbounded-growth case the #862 review
    // flagged) MUST stay at one row, carrying the latest iteration's liveness.
    for (const it of [1, 2, 3, 4, 5]) {
      projectHeartbeat(db, makeHeartbeat(it));
    }
    const evs = eventsOfType(db, "system.agent.heartbeat");
    expect(evs.length).toBe(1);
    const payload = JSON.parse(evs[0]!.payload) as { iteration: number };
    expect(payload.iteration).toBe(5);
  });

  it("an exact redelivery of the latest tick is idempotent (still one row, same iteration)", () => {
    seedDispatchAnchor(db);
    projectHeartbeat(db, makeHeartbeat(3));
    projectHeartbeat(db, makeHeartbeat(3)); // redelivery of the latest tick
    const evs = eventsOfType(db, "system.agent.heartbeat");
    expect(evs.length).toBe(1);
    expect((JSON.parse(evs[0]!.payload) as { iteration: number }).iteration).toBe(3);
  });

  it("an out-of-order OLDER tick does NOT regress the recorded liveness", () => {
    seedDispatchAnchor(db);
    projectHeartbeat(db, makeHeartbeat(5)); // latest seen
    const res = projectHeartbeat(db, makeHeartbeat(2)); // reordered older tick
    // One row, still the newer iteration — the older tick must not overwrite it.
    const evs = eventsOfType(db, "system.agent.heartbeat");
    expect(evs.length).toBe(1);
    expect((JSON.parse(evs[0]!.payload) as { iteration: number }).iteration).toBe(5);
    // The result reflects the row's retained (newer) iteration, not the stale one.
    expect(res?.iteration).toBe(5);
  });

  it("ignores a non-heartbeat type", () => {
    expect(
      projectHeartbeat(db, { type: "review.verdict.approved", payload: {} }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Adapter health
// ---------------------------------------------------------------------------

describe("projectAdapterLifecycle", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  function degraded(): Envelope {
    return createSystemAdapterDegradedEvent({
      source: SOURCE,
      adapterId: "discord-luna",
      platform: "discord",
      disconnectedSince: new Date("2026-06-10T12:00:00.000Z"),
      thresholdMs: 60_000,
    });
  }
  function recovered(): Envelope {
    return createSystemAdapterRecoveredEvent({
      source: SOURCE,
      adapterId: "discord-luna",
      platform: "discord",
      degradedForMs: 90_000,
    });
  }

  it("opens an adapter-health attention item on degraded", () => {
    const res = projectAdapterLifecycle(db, degraded());
    expect(res?.action).toBe("opened");
    const id = `${ADAPTER_ATTENTION_PREFIX}discord-luna`;
    expect(attentionRow(db, id)?.status).toBe("open");
    expect(attentionRow(db, id)?.severity).toBe("high");
  });

  it("resolves the adapter-health item on recovered", () => {
    projectAdapterLifecycle(db, degraded());
    const res = projectAdapterLifecycle(db, recovered());
    expect(res?.action).toBe("resolved");
    expect(attentionRow(db, `${ADAPTER_ATTENTION_PREFIX}discord-luna`)?.status).toBe(
      "resolved",
    );
  });

  it("is idempotent — a re-degrade upserts the same single row", () => {
    projectAdapterLifecycle(db, degraded());
    projectAdapterLifecycle(db, degraded());
    const n = (
      db
        .query(`SELECT COUNT(*) AS n FROM attention_items WHERE id LIKE 'att:adapter:%'`)
        .get() as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it("ignores a non-adapter type", () => {
    expect(
      projectAdapterLifecycle(db, { type: "system.agent.heartbeat", payload: {} }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Attention — FEDERATED only (scoping decision)
// ---------------------------------------------------------------------------

describe("projectAttention (federated-only)", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  const PEER_ITEM: AttentionItem = {
    id: "att:block:peer-assignment-1",
    stackId: "peer-stack",
    workItemId: null,
    sessionId: null,
    kind: "permission",
    severity: "high",
    status: "open",
  };

  function attEnv(action: "opened" | "resolved"): Envelope {
    return attentionNotificationEnvelope(PEER_ITEM, action, {
      source: { principal: "peer" },
      deepLinkUrl: null,
    });
  }

  it("ingests a federated attention.opened under the att:fed: namespace", () => {
    const res = projectAttention(db, attEnv("opened"), "federated.peer.work.system.attention.opened");
    expect(res?.action).toBe("opened");
    const id = `${FEDERATED_ATTENTION_PREFIX}${PEER_ITEM.id}`;
    expect(res?.itemId).toBe(id);
    expect(attentionRow(db, id)?.status).toBe("open");
  });

  it("resolves a federated attention item on resolved", () => {
    projectAttention(db, attEnv("opened"), "federated.peer.work.system.attention.opened");
    projectAttention(db, attEnv("resolved"), "federated.peer.work.system.attention.resolved");
    expect(
      attentionRow(db, `${FEDERATED_ATTENTION_PREFIX}${PEER_ITEM.id}`)?.status,
    ).toBe("resolved");
  });

  it("IGNORES a LOCAL attention envelope (does not fight the local reconciler)", () => {
    // Same envelope, but delivered on a LOCAL subject → not ingested.
    const res = projectAttention(db, attEnv("opened"), "local.andreas.work.system.attention.opened");
    expect(res).toBeNull();
    const n = (
      db.query(`SELECT COUNT(*) AS n FROM attention_items`).get() as { n: number }
    ).n;
    expect(n).toBe(0);
  });

  it("stores federated items under a DISJOINT namespace from the local reconciler", () => {
    projectAttention(db, attEnv("opened"), "federated.peer.work.system.attention.opened");
    // The local reconciler's prefixes are att:block: / att:stale:. The projected
    // id must NOT collide with the peer's RAW id (which happened to be att:block:).
    expect(attentionRow(db, PEER_ITEM.id)).toBeNull(); // raw id NOT used
    expect(
      attentionRow(db, `${FEDERATED_ATTENTION_PREFIX}${PEER_ITEM.id}`),
    ).not.toBeNull();
  });

  it("ignores a non-attention type even on a federated subject", () => {
    expect(
      projectAttention(
        db,
        { type: "system.adapter.degraded", payload: {} },
        "federated.peer.work.system.adapter.degraded",
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Renderer dispatcher + WS broadcast
// ---------------------------------------------------------------------------

describe("project() dispatcher + WS broadcast", () => {
  let db: Database;
  let broadcasts: WsServerMessage[];
  let fakeRegistry: WsClientRegistry;

  beforeEach(() => {
    db = setupDb();
    broadcasts = [];
    fakeRegistry = {
      broadcast: (msg: WsServerMessage) => {
        broadcasts.push(msg);
      },
    } as unknown as WsClientRegistry;
  });
  afterEach(() => {
    db.close();
  });

  it("broadcasts mc.projection on a dispatch-lifecycle projection", () => {
    const env = createDispatchTaskStartedEvent({
      source: SOURCE,
      taskId: TASK_ID,
      agentId: "echo",
      startedAt: new Date(),
      correlationId: CORRELATION,
    });
    project(db, env, "local.andreas.work.dispatch.task.started", fakeRegistry);
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0]).toMatchObject({ type: "mc.projection", family: "dispatch.lifecycle" });
  });

  it("broadcasts mc.projection on a verdict projection", () => {
    seedDispatchAnchor(db);
    broadcasts = []; // reset (seed used projectDispatchLifecycle directly, no broadcast)
    project(db, makeVerdict(), "local.andreas.work.review.verdict.changes-requested", fakeRegistry);
    expect(broadcasts.some((m) => m.type === "mc.projection" && m.family === "review.verdict")).toBe(true);
  });

  it("does NOT broadcast when a projection is a no-op (unjoinable heartbeat)", () => {
    const hb = createAgentHeartbeatEvent({
      source: SOURCE,
      agentId: "echo",
      taskId: TASK_ID,
      correlationId: "no-anchor",
      phase: "thinking",
      lastActivityMsAgo: 0,
      iteration: 1,
    });
    project(db, hb, "local.andreas.work.system.agent.heartbeat", fakeRegistry);
    expect(broadcasts.length).toBe(0);
  });

  it("renderer render() never throws on a malformed envelope and writes nothing", async () => {
    const adapter = createDispatchProjectionRenderer(db, fakeRegistry);
    const bad = { id: "x", type: "review.verdict.approved", payload: null } as unknown as Envelope;
    await expect(adapter.render(bad)).resolves.toBeUndefined();
    expect(eventsOfType(db, "review.verdict").length).toBe(0);
    expect(broadcasts.length).toBe(0);
  });

  it("the dispatch handler ignores non-dispatch families (and vice versa)", () => {
    // A verdict envelope routed through project() does NOT create a dispatch
    // session anchor (no dispatch task row).
    seedDispatchAnchor(db);
    const dispatchTasksBefore = (
      db.query(`SELECT COUNT(*) AS n FROM tasks WHERE id LIKE 'mc-dispatch-task-%'`).get() as { n: number }
    ).n;
    project(db, makeVerdict(), "local.andreas.work.review.verdict.changes-requested", fakeRegistry);
    const dispatchTasksAfter = (
      db.query(`SELECT COUNT(*) AS n FROM tasks WHERE id LIKE 'mc-dispatch-task-%'`).get() as { n: number }
    ).n;
    expect(dispatchTasksAfter).toBe(dispatchTasksBefore); // verdict didn't make a dispatch anchor
  });
});
