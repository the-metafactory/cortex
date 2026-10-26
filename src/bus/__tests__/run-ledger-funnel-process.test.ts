import { describe, expect, test } from "bun:test";
import { validateExecutionRunFinished } from "@the-metafactory/myelin";
import { readRunFinished } from "../../../scripts/fixtures/reflex-consumer.mjs";
import { validateEnvelope } from "../myelin/envelope-validator";
import { createSystemBusProcessEvent } from "../system-events";
import { createDispatchTaskCompletedEvent } from "../dispatch-events";
import { harness } from "./run-ledger-funnel-harness";
import { createProcessRunner } from "../process-runner";
import { modeSpawn, reflexConsumer, routedRuntime, type ProcessMode } from "./process-ledger-harness";

const SUBJECT = "local.jc.default.system.bus.process";
const CORRELATION = "22222222-2222-4222-8222-222222222222";
const startedAt = new Date("2026-10-25T10:00:00.000Z");
const source = { principal: "jc", agent: "cortex", instance: "local", dataResidency: "CH" };

function processEvent(over: Partial<Parameters<typeof createSystemBusProcessEvent>[0]> = {}) {
  return createSystemBusProcessEvent({
    source,
    outcome: "completed",
    process: "ranger-shadow-watch",
    decisionId: "decision-1",
    correlationId: CORRELATION,
    startedAt,
    ...over,
  });
}

describe("run-ledger funnel: process runs", () => {
  test("registers the stack's system.bus.process subject beside the dispatch ones", () => {
    expect(harness().funnel.subjects).toContain(SUBJECT);
  });

  test("a completed process publishes one succeeded run carrying the activation correlation", async () => {
    const { funnel, published, logs } = harness();
    const input = processEvent();
    await funnel.render(input, undefined, SUBJECT);
    expect(published).toHaveLength(1);
    const { envelope, subject } = published[0]!;
    expect(subject).toBe("local.jc.default.execution.run.finished");
    expect(envelope.type).toBe("execution.run.finished");
    expect(envelope.source).toBe("jc.default.cortex");
    expect(envelope.payload).toEqual({
      run_id: input.id,
      producer: "cortex",
      ran: { kind: "job", ref: "ranger-shadow-watch" },
      outcome: "succeeded",
      started_at: startedAt.toISOString(),
      ended_at: input.timestamp,
      correlation_id: CORRELATION,
    });
    expect(envelope.correlation_id).toBe(CORRELATION);
    expect(validateExecutionRunFinished(envelope)).toEqual({ valid: true, errors: [] });
    expect(validateEnvelope(envelope).ok).toBe(true);
    expect(logs).toEqual([]);
  });

  test("pinned Reflex evaluate releases only the stamped correlation and lets the next impulse fire", async () => {
    const { funnel, published } = harness();
    const fixture = await reflexConsumer();
    expect(fixture.guardState.runLockHolder).toBe(fixture.correlationId);
    expect(await fixture.evaluate(1)).toMatchObject({ outcome: "blocked", reason: "run-lock" });
    await funnel.render(processEvent(), undefined, SUBJECT);
    await fixture.consume(published[0]!.envelope, published[0]!.subject);
    expect(fixture.guardState.runLockHolder).toBe(fixture.correlationId);
    expect(fixture.releases).toEqual([]);
    await funnel.render(processEvent({ correlationId: fixture.correlationId }), undefined, SUBJECT);
    const finished = published[1]!;
    delete finished.envelope.correlation_id;
    await fixture.consume(finished.envelope, finished.subject);
    expect(fixture.guardState.runLockHolder).toBeNull();
    expect(fixture.releases).toEqual([{ blueprintId: "process-activation", correlationId: fixture.correlationId }]);
    expect(await fixture.evaluate(2)).toMatchObject({ outcome: "fired" });
    const nextHolder = fixture.guardState.runLockHolder;
    expect(nextHolder).not.toBe(fixture.correlationId);
    await fixture.consume(finished.envelope, finished.subject);
    expect(fixture.guardState.runLockHolder).toBe(nextHolder);
  });

  test("pinned Reflex reader accepts a non-UUID payload correlation without an envelope correlation", async () => {
    const { funnel, published } = harness();
    const correlationId = "activation-correlation-not-a-uuid";
    await funnel.render(processEvent({ correlationId }), undefined, SUBJECT);
    expect(published[0]!.envelope.correlation_id).toBeUndefined();
    expect(readRunFinished(published[0]!.envelope)).toEqual({ valid: true, correlationId, outcome: "succeeded" });
  });

  test.each(["correlation", "duration", "subject"])("pinned Reflex preserves the lock for invalid %s", async (invalid) => {
    const { funnel, published } = harness();
    const fixture = await reflexConsumer();
    await funnel.render(processEvent({ correlationId: fixture.correlationId }), undefined, SUBJECT);
    const finished = published[0]!;
    if (invalid === "correlation") finished.envelope.correlation_id = CORRELATION;
    if (invalid === "duration") delete finished.envelope.economics;
    if (invalid === "subject") finished.subject = "local.jc.other.execution.run.finished";
    await fixture.consume(finished.envelope, finished.subject);
    expect(fixture.guardState.runLockHolder).toBe(fixture.correlationId);
    expect(fixture.releases).toEqual([]);
  });

  test("a failed process publishes one failed run and still releases the lock", async () => {
    const { funnel, published } = harness();
    const fixture = await reflexConsumer();
    await funnel.render(processEvent({ outcome: "failed", reason: "exit-1", correlationId: fixture.correlationId }), undefined, SUBJECT);
    expect(published).toHaveLength(1);
    expect(published[0]!.envelope.payload.outcome).toBe("failed");
    await fixture.consume(published[0]!.envelope, published[0]!.subject);
    expect(fixture.guardState.runLockHolder).toBeNull();
  });

  test.each(["exit-1", "spawn:boom", "timeout-900000ms", "spec:bad", "no-process-name"])(
    "failure reason %s maps to failed", async (reason) => {
      const { funnel, published } = harness();
      await funnel.render(processEvent({ outcome: "failed", reason }), undefined, SUBJECT);
      expect(published).toHaveLength(1);
      expect(published[0]!.envelope.payload.outcome).toBe("failed");
    },
  );

  test("a started event publishes nothing", async () => {
    const { funnel, published, logs } = harness();
    await funnel.render(processEvent({ outcome: "started" }), undefined, SUBJECT);
    expect(published).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("without a correlation ID the run id is the fallback correlation, as for dispatch", async () => {
    const { funnel, published } = harness();
    const input = createSystemBusProcessEvent({
      source, outcome: "completed", process: "ranger-shadow-watch", decisionId: "decision-1", startedAt,
    });
    expect(input.correlation_id).toBeUndefined();
    await funnel.render(input, undefined, SUBJECT);
    expect(published).toHaveLength(1);
    expect(published[0]!.envelope.payload.run_id).toBe(input.id);
    expect(published[0]!.envelope.payload.correlation_id).toBe(input.id);
    expect(validateExecutionRunFinished(published[0]!.envelope).valid).toBe(true);
  });

  test("without correlation or decision the event id keeps the run unique", async () => {
    const { funnel, published } = harness();
    const input = createSystemBusProcessEvent({
      source, outcome: "failed", process: "ranger-shadow-watch", reason: "spec:x", startedAt,
    });
    await funnel.render(input, undefined, SUBJECT);
    expect(published[0]!.envelope.payload.run_id).toBe(input.id);
  });

  test("a terminal process event without started_at is dropped and logged once", async () => {
    const { funnel, published, logs } = harness();
    await funnel.render(processEvent({ startedAt: undefined }), undefined, SUBJECT);
    expect(published).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("process=ranger-shadow-watch");
    expect(logs[0]).toContain("started_at");
  });

  test.each([
    "local.jc.switch.system.bus.process",
    "local.other.default.system.bus.process",
    "federated.jc.default.system.bus.process",
  ])("ignores mismatched subject %s", async (subject) => {
    const { funnel, published, logs } = harness();
    await funnel.render(processEvent(), undefined, subject);
    expect(published).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("ignores other system.bus events and unknown process outcomes", async () => {
    const { funnel, published, logs } = harness();
    const unknown = processEvent();
    unknown.payload.outcome = "constructor";
    await funnel.render(unknown, undefined, SUBJECT);
    const other = processEvent();
    other.type = "system.bus.notify-discord";
    await funnel.render(other, undefined, "local.jc.default.system.bus.notify-discord");
    expect(published).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("dispatch mapping is unchanged beside the process one", async () => {
    const { funnel, published } = harness();
    await funnel.render(createDispatchTaskCompletedEvent({
      source, taskId: "t1", agentId: "sage", startedAt,
      completedAt: new Date("2026-10-25T10:00:05.000Z"),
    }), undefined, "local.jc.default.dispatch.task.completed");
    expect(published[0]!.envelope.payload).toMatchObject({
      run_id: "t1", ran: { kind: "dispatch", ref: "sage" }, outcome: "succeeded", correlation_id: "t1",
    });
  });

  test("separate runs of the same decision have distinct run identities", async () => {
    const { funnel, published } = harness();
    await funnel.render(processEvent(), undefined, SUBJECT);
    await funnel.render(processEvent(), undefined, SUBJECT);
    expect(published[0]!.envelope.payload.run_id).not.toBe(published[1]!.envelope.payload.run_id);
  });

  for (const detach of [false, true]) {
    test.each<ProcessMode>(["success", "non-zero", "spawn-error", "watchdog"])(
      `${detach ? "detached" : "synchronous"} runner %s reaches the funnel through the router exactly once`, async (mode) => {
        const { funnel, published, logs } = harness();
        const { runtime, visibility, terminalDelivery, router } = routedRuntime(funnel, SUBJECT);
        const runner = createProcessRunner({
          source,
          runtime,
          processesDir: "/unused",
          loadSpec: () => ({ name: "example-process", cwd: "/unused", argv: ["example"], params: {}, detach, timeout_ms: 5 }),
          spawn: modeSpawn(mode),
          log: { info() {}, error() {} },
        });
        const fixture = await reflexConsumer();
        let threw = false;
        try {
          await runner({ target: "example-process", payload: {}, decisionId: "decision-1", correlationId: fixture.correlationId, classification: "local" }, {
            target: "example-process", capability: "process.run", assistant: "cortex", handler: "process", process: "example-process",
          });
        } catch (error) {
          threw = true;
          expect(error).toBeInstanceOf(Error);
        }
        expect(threw).toBe(mode === "spawn-error" || (!detach && mode !== "success"));
        await terminalDelivery;
        expect(visibility).toHaveLength(2);
        expect(published).toHaveLength(1);
        const finished = published[0]!.envelope;
        expect(finished.payload).toMatchObject({
          ran: { kind: "job", ref: "example-process" },
          outcome: mode === "success" ? "succeeded" : "failed",
          started_at: visibility[0]!.payload.started_at,
          ended_at: visibility[1]!.timestamp,
          correlation_id: fixture.correlationId,
        });
        await fixture.consume(finished, published[0]!.subject);
        expect(fixture.guardState.runLockHolder).toBeNull();
        expect(logs).toEqual([]);
        await router.stop();
      },
    );
  }
});
