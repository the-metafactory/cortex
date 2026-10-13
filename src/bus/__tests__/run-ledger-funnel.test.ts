import { describe, expect, test } from "bun:test";
import { validateExecutionRunFinished, type MyelinEnvelope } from "@the-metafactory/myelin";
import { validateEnvelope } from "../myelin/envelope-validator";
import {
  createDispatchTaskAbortedEvent,
  createDispatchTaskCompletedEvent,
  createDispatchTaskFailedEvent,
  createDispatchTaskStartedEvent,
} from "../dispatch-events";
import { createRunLedgerFunnel } from "../run-ledger-funnel";

const common = {
  source: { principal: "jc", agent: "cortex", instance: "default", dataResidency: "CH" },
  taskId: "t1",
  agentId: "sage",
  startedAt: new Date("2026-10-12T10:00:00.000Z"),
};
const endedAt = new Date("2026-10-12T10:00:05.000Z");
const completed = () => createDispatchTaskCompletedEvent({ ...common, completedAt: endedAt });
const failed = () => createDispatchTaskFailedEvent({ ...common, failedAt: endedAt, errorSummary: "failed" });
const aborted = () => createDispatchTaskAbortedEvent({ ...common, abortedAt: endedAt, reason: "timeout" });

function harness(publishError?: unknown) {
  const published: { envelope: MyelinEnvelope; subject: string }[] = [];
  const logs: string[] = [];
  const funnel = createRunLedgerFunnel({
    principal: "jc",
    stack: "default",
    publish: async (envelope, subject) => {
      if (publishError !== undefined) throw publishError;
      published.push({ envelope, subject });
    },
    log: (line) => logs.push(line),
  });
  return { funnel, published, logs };
}

describe("run-ledger funnel", () => {
  test("declares exactly this stack's three terminal subjects", () => {
    expect(harness().funnel.subjects).toEqual([
      "local.jc.default.dispatch.task.completed",
      "local.jc.default.dispatch.task.failed",
      "local.jc.default.dispatch.task.aborted",
    ]);
  });

  test("completed produces one valid cortex envelope with only the settled payload", async () => {
    const { funnel, published, logs } = harness();
    const input = completed();
    // Extra dispatch fields, including free text, never enter the run ledger.
    input.payload.serves = { goal: "goal-id" };
    input.payload.state = { subject: "a", value: "b" };
    input.payload.detail_ref = "dispatch-detail";
    input.payload.result_summary = "private prose";
    await funnel.render(input, undefined, "local.jc.default.dispatch.task.completed");
    expect(published).toHaveLength(1);
    const event = published[0]!;
    expect(event.subject).toBe("local.jc.default.execution.run.finished");
    expect(event.envelope.type).toBe("execution.run.finished");
    expect(event.envelope.source).toBe("jc.default.cortex");
    expect(event.envelope.id).not.toBe(input.id);
    expect(event.envelope.sovereignty).toEqual(input.sovereignty);
    expect(event.envelope.payload).toEqual({
      run_id: "t1",
      producer: "cortex",
      ran: { kind: "dispatch", ref: "sage" },
      outcome: "succeeded",
      started_at: common.startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      correlation_id: "t1",
    });
    expect(event.envelope.economics?.actual?.duration_ms).toBe(5000);
    expect(event.envelope).not.toHaveProperty("correlation_id");
    expect(validateExecutionRunFinished(event.envelope))
      .toEqual({ valid: true, errors: [] });
    expect(validateEnvelope(event.envelope).ok).toBe(true);
    expect(logs).toEqual([]);
  });

  test.each([
    ["failed with policy_denied", () => createDispatchTaskFailedEvent({
      ...common, failedAt: endedAt, errorSummary: "denied",
      reason: { kind: "policy_denied", deny: { kind: "unknown_principal" } },
    }), "failed"],
    ["failed without reason", failed, "failed"],
    ["principal cancellation", () => createDispatchTaskAbortedEvent({
      ...common, abortedAt: endedAt, reason: "principal-cancel",
    }), "cancelled"],
    ["timeout", aborted, "cancelled"],
  ] as const)("maps %s solely by terminal type", async (_label, makeEvent, outcome) => {
    const { funnel, published } = harness();
    const input = makeEvent();
    await funnel.render(input, undefined, `local.jc.default.${input.type}`);
    expect(published).toHaveLength(1);
    expect(published[0]!.envelope.payload.outcome).toBe(outcome);
    expect(published[0]!.envelope.payload.ended_at).toBe(endedAt.toISOString());
    const output = published[0]!.envelope;
    expect(validateExecutionRunFinished(output).valid).toBe(true);
  });

  test.each(["t1", "22222222-2222-4222-8222-222222222222"])(
    "passes correlation ID %s through unchanged", async (correlationId) => {
      const { funnel, published } = harness();
      await funnel.render(createDispatchTaskCompletedEvent({
        ...common, completedAt: endedAt, correlationId,
      }));
      expect(published).toHaveLength(1);
      expect(published[0]!.envelope.payload.correlation_id).toBe(correlationId);
      if (correlationId !== "t1") expect(published[0]!.envelope.correlation_id).toBe(correlationId);
      const output = published[0]!.envelope;
      expect(validateExecutionRunFinished(output).valid).toBe(true);
    },
  );

  test.each([
    "local.jc.switch.dispatch.task.completed",
    "local.other.default.dispatch.task.completed",
    "federated.jc.default.dispatch.task.completed",
    "public.dispatch.task.completed",
    "local.jc.default.dispatch.task.failed",
  ])("ignores unrelated or mismatched subject %s", async (subject) => {
    const { funnel, published, logs } = harness();
    await funnel.render(completed(), undefined, subject);
    expect(published).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("ignores a non-terminal event even on a terminal subject", async () => {
    const { funnel, published, logs } = harness();
    await funnel.render(createDispatchTaskStartedEvent(common), undefined,
      "local.jc.default.dispatch.task.completed");
    expect(published).toEqual([]);
    expect(logs).toEqual([]);
  });

  test.each([
    [completed, "started_at"], [completed, "completed_at"], [completed, "agent_id"],
    [failed, "started_at"], [failed, "failed_at"], [failed, "agent_id"],
    [aborted, "started_at"], [aborted, "aborted_at"], [aborted, "agent_id"],
  ] as const)("drops missing terminal field and logs once (%#)", async (makeEvent, field) => {
    const { funnel, published, logs } = harness();
    const input = makeEvent();
    delete input.payload[field];
    await expect(funnel.render(input)).resolves.toBeUndefined();
    expect(published).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("task_id=t1");
    expect(logs[0]).toContain(field);
  });

  test.each([
    ["agent_id", 17], ["agent_id", ""], ["started_at", "not-a-date"],
    ["completed_at", "2026-10-12T09:59:59.000Z"], ["task_id", ""],
  ] as const)("drops malformed %s=%s and logs the error", async (field, value) => {
    const { funnel, published, logs } = harness();
    const input = completed();
    input.payload[field] = value;
    await expect(funnel.render(input)).resolves.toBeUndefined();
    expect(published).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`task_id=${String(input.payload.task_id)}`);
    expect(logs[0]).toContain(field === "completed_at" ? "ended_at" : field);
  });

  test("drops a correlation ID rejected by A5b", async () => {
    const { funnel, published, logs } = harness();
    const input = completed();
    input.correlation_id = "";
    await expect(funnel.render(input)).resolves.toBeUndefined();
    expect(published).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("task_id=t1");
    expect(logs[0]).toContain("correlation_id");
  });

  test.each([new Error("publish refused"), "transport down"])(
    "publish rejection logs once and resolves", async (error) => {
      const { funnel, published, logs } = harness(error);
      const input = completed();
      const before = structuredClone(input);
      await expect(funnel.render(input)).resolves.toBeUndefined();
      expect(published).toEqual([]);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("task_id=t1");
      expect(logs[0]).toContain(error instanceof Error ? error.message : error);
      expect(input).toEqual(before);
    },
  );

  test("a multiline publish error produces one log line", async () => {
    const { funnel, logs } = harness(new Error("publish refused\nconnection closed"));
    await expect(funnel.render(completed())).resolves.toBeUndefined();
    expect(logs).toEqual(["run-ledger-funnel: task_id=t1: publish refused connection closed"]);
  });
});
