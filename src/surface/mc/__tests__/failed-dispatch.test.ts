/**
 * MC-I1.S7 (#849) — failed_dispatch attention producer.
 *
 * Event-driven off the dispatch-lifecycle seam: a `dispatch.task.failed` /
 * `aborted` opens an `att:faildis:` item; a principal-cancel aborted does not;
 * a later `started` / `completed` for the same anchor auto-resolves it; the
 * `att:faildis:` namespace is disjoint from the reconciler's prefixes.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import {
  getAttentionItem,
  listOpenAttention,
  upsertAttentionItem,
  dismissAttentionItem,
} from "../db/attention";
import {
  produceFailedDispatchAttention,
  FAILED_DISPATCH_PREFIX,
  PRINCIPAL_CANCEL_REASON,
} from "../projection/failed-dispatch";
import { projectDispatchLifecycle } from "../projection/dispatch-lifecycle";
import { reconcileAttention } from "../db/attention-sources";

const STACK = "test-stack";

describe("failed_dispatch attention producer (MC-I1.S7)", () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths) if (existsSync(p)) rmSync(p);
    paths.length = 0;
  });
  function freshDb() {
    const p = join(tmpdir(), `faildis-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return initDatabase(p);
  }

  /** Drive a started envelope so a dispatch anchor (session) exists for deep-linking. */
  function seedAnchor(db: ReturnType<typeof initDatabase>, correlationId: string, agentId = "echo") {
    projectDispatchLifecycle(db, {
      type: "dispatch.task.started",
      correlation_id: correlationId,
      payload: { task_id: correlationId, agent_id: agentId },
    });
  }

  function failedEnvelope(correlationId: string, reason?: Record<string, unknown>) {
    return {
      type: "dispatch.task.failed",
      correlation_id: correlationId,
      payload: {
        task_id: correlationId,
        agent_id: "echo",
        error_summary: "assertion failed: expected 1, got 2",
        ...(reason !== undefined && { reason }),
      },
    };
  }

  it("opens a failed_dispatch item on dispatch.task.failed (with the nak reason captured)", () => {
    const db = freshDb();
    seedAnchor(db, "corr-1");

    const delta = produceFailedDispatchAttention(
      db,
      failedEnvelope("corr-1", { kind: "cant_do", detail: "bad output" }),
      { stackId: STACK },
    );

    expect(delta.opened).toHaveLength(1);
    expect(delta.resolved).toHaveLength(0);
    const item = getAttentionItem(db, `${FAILED_DISPATCH_PREFIX}corr-1`);
    expect(item).not.toBeNull();
    expect(item?.kind).toBe("failed_dispatch");
    expect(item?.status).toBe("open");
    // Deep-links via the dispatch anchor's session.
    expect(item?.sessionId).not.toBeNull();
  });

  it("renders severity from the nak reason: policy_denied → critical, not_now → normal", () => {
    const db = freshDb();
    seedAnchor(db, "corr-policy");
    seedAnchor(db, "corr-transient");

    produceFailedDispatchAttention(
      db,
      failedEnvelope("corr-policy", { kind: "policy_denied", deny: { reason: "unknown_principal" } }),
      { stackId: STACK },
    );
    produceFailedDispatchAttention(
      db,
      failedEnvelope("corr-transient", { kind: "not_now", detail: "backpressure" }),
      { stackId: STACK },
    );

    expect(getAttentionItem(db, `${FAILED_DISPATCH_PREFIX}corr-policy`)?.severity).toBe("critical");
    expect(getAttentionItem(db, `${FAILED_DISPATCH_PREFIX}corr-transient`)?.severity).toBe("normal");
  });

  it("opens on an aborted that is NOT a principal-cancel", () => {
    const db = freshDb();
    seedAnchor(db, "corr-timeout");

    const delta = produceFailedDispatchAttention(
      db,
      {
        type: "dispatch.task.aborted",
        correlation_id: "corr-timeout",
        payload: { task_id: "corr-timeout", agent_id: "echo", reason: "timeout" },
      },
      { stackId: STACK },
    );

    expect(delta.opened).toHaveLength(1);
    expect(getAttentionItem(db, `${FAILED_DISPATCH_PREFIX}corr-timeout`)?.severity).toBe("high");
  });

  it("does NOT open on a principal-cancel aborted", () => {
    const db = freshDb();
    seedAnchor(db, "corr-cancel");

    const delta = produceFailedDispatchAttention(
      db,
      {
        type: "dispatch.task.aborted",
        correlation_id: "corr-cancel",
        payload: { task_id: "corr-cancel", agent_id: "echo", reason: PRINCIPAL_CANCEL_REASON },
      },
      { stackId: STACK },
    );

    expect(delta.opened).toHaveLength(0);
    expect(delta.resolved).toHaveLength(0);
    expect(getAttentionItem(db, `${FAILED_DISPATCH_PREFIX}corr-cancel`)).toBeNull();
  });

  it("auto-resolves on a later started (redispatch retried)", () => {
    const db = freshDb();
    seedAnchor(db, "corr-retry");
    produceFailedDispatchAttention(db, failedEnvelope("corr-retry"), { stackId: STACK });
    expect(getAttentionItem(db, `${FAILED_DISPATCH_PREFIX}corr-retry`)?.status).toBe("open");

    const delta = produceFailedDispatchAttention(
      db,
      {
        type: "dispatch.task.started",
        correlation_id: "corr-retry",
        payload: { task_id: "corr-retry", agent_id: "echo" },
      },
      { stackId: STACK },
    );

    expect(delta.resolved).toHaveLength(1);
    expect(getAttentionItem(db, `${FAILED_DISPATCH_PREFIX}corr-retry`)?.status).toBe("resolved");
  });

  it("auto-resolves on a later completed (redispatch succeeded)", () => {
    const db = freshDb();
    seedAnchor(db, "corr-success");
    produceFailedDispatchAttention(db, failedEnvelope("corr-success"), { stackId: STACK });

    const delta = produceFailedDispatchAttention(
      db,
      {
        type: "dispatch.task.completed",
        correlation_id: "corr-success",
        payload: { task_id: "corr-success", agent_id: "echo" },
      },
      { stackId: STACK },
    );

    expect(delta.resolved).toHaveLength(1);
    expect(getAttentionItem(db, `${FAILED_DISPATCH_PREFIX}corr-success`)?.status).toBe("resolved");
  });

  it("is idempotent on redelivery of the same failed (no duplicate opened delta)", () => {
    const db = freshDb();
    seedAnchor(db, "corr-dup");

    const first = produceFailedDispatchAttention(db, failedEnvelope("corr-dup"), { stackId: STACK });
    const second = produceFailedDispatchAttention(db, failedEnvelope("corr-dup"), { stackId: STACK });

    expect(first.opened).toHaveLength(1);
    expect(second.opened).toHaveLength(0); // already open → no re-notify
    expect(listOpenAttention(db).filter((i) => i.id === `${FAILED_DISPATCH_PREFIX}corr-dup`)).toHaveLength(1);
  });

  it("does NOT resurrect a DISMISSED item on a redelivered failed (no opened delta)", () => {
    // PR #873 review major 1 — dismiss-resurrection (#621 class). A dismissed
    // item must stay dismissed across NATS at-least-once redelivery.
    const db = freshDb();
    seedAnchor(db, "corr-dismiss");
    produceFailedDispatchAttention(db, failedEnvelope("corr-dismiss"), { stackId: STACK });
    // The principal dismisses it.
    dismissAttentionItem(db, `${FAILED_DISPATCH_PREFIX}corr-dismiss`);
    expect(getAttentionItem(db, `${FAILED_DISPATCH_PREFIX}corr-dismiss`)?.status).toBe("dismissed");

    // The same failed envelope is redelivered → must NOT flip back to open or notify.
    const redeliver = produceFailedDispatchAttention(db, failedEnvelope("corr-dismiss"), { stackId: STACK });
    expect(redeliver.opened).toHaveLength(0);
    expect(redeliver.resolved).toHaveLength(0);
    expect(getAttentionItem(db, `${FAILED_DISPATCH_PREFIX}corr-dismiss`)?.status).toBe("dismissed");
  });

  it("a resolve of an absent/already-resolved item yields no resolved delta", () => {
    const db = freshDb();
    seedAnchor(db, "corr-noop");

    // No prior failed → a started resolves nothing.
    const delta = produceFailedDispatchAttention(
      db,
      {
        type: "dispatch.task.started",
        correlation_id: "corr-noop",
        payload: { task_id: "corr-noop", agent_id: "echo" },
      },
      { stackId: STACK },
    );
    expect(delta.resolved).toHaveLength(0);
  });

  it("opens with a null session link when no anchor was projected (terminal raced its projection)", () => {
    const db = freshDb();
    // No seedAnchor — the failed arrives with no projected dispatch anchor.
    const delta = produceFailedDispatchAttention(db, failedEnvelope("corr-orphan"), { stackId: STACK });
    expect(delta.opened).toHaveLength(1);
    expect(getAttentionItem(db, `${FAILED_DISPATCH_PREFIX}corr-orphan`)?.sessionId).toBeNull();
  });

  it("ignores a non-terminal/non-redispatch type (empty delta)", () => {
    const db = freshDb();
    const delta = produceFailedDispatchAttention(
      db,
      { type: "system.agent.heartbeat", correlation_id: "x", payload: {} },
      { stackId: STACK },
    );
    expect(delta).toEqual({ opened: [], resolved: [] });
  });

  // --- Prefix disjointness (CRITICAL) ---

  it("the reconciler never sweeps an att:faildis: item, and the producer never touches reconciler items", () => {
    const db = freshDb();
    seedAnchor(db, "corr-disjoint");
    produceFailedDispatchAttention(db, failedEnvelope("corr-disjoint"), { stackId: STACK });

    // Seed a reconciler-owned item directly (att:block:) that is NOT currently derivable.
    upsertAttentionItem(db, {
      id: "att:block:phantom",
      stackId: STACK,
      workItemId: null,
      sessionId: null,
      kind: "blocked",
      severity: "high",
      status: "open",
    });

    // Run the reconciler with no derivable state: it resolves its OWN orphaned
    // att:block: item but must leave the att:faildis: item OPEN.
    const result = reconcileAttention(db, { stackId: STACK });
    expect(result.resolved.map((i) => i.id)).toContain("att:block:phantom");
    expect(getAttentionItem(db, `${FAILED_DISPATCH_PREFIX}corr-disjoint`)?.status).toBe("open");

    // And the producer's resolve only touches att:faildis: — a started for the
    // same anchor resolves the faildis item, never the att:block: one.
    upsertAttentionItem(db, {
      id: "att:block:phantom2",
      stackId: STACK,
      workItemId: null,
      sessionId: null,
      kind: "blocked",
      severity: "high",
      status: "open",
    });
    produceFailedDispatchAttention(
      db,
      { type: "dispatch.task.started", correlation_id: "corr-disjoint", payload: { task_id: "corr-disjoint", agent_id: "echo" } },
      { stackId: STACK },
    );
    expect(getAttentionItem(db, "att:block:phantom2")?.status).toBe("open");
  });
});
