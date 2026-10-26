import type { MyelinEnvelope } from "@the-metafactory/myelin";
import { Pipeline, readRunFinished, runOutcomeSubject } from "../../../scripts/fixtures/reflex-consumer.mjs";
import type { MyelinRuntime } from "../myelin/runtime";
import type { Spawn } from "../process-runner";
import { createSurfaceRouter, type SurfaceAdapter } from "../surface-router";

export type ProcessMode = "success" | "non-zero" | "spawn-error" | "watchdog";

export function routedRuntime(funnel: SurfaceAdapter, subject: string) {
  const router = createSurfaceRouter({} as MyelinRuntime);
  router.register(funnel);
  const visibility: MyelinEnvelope[] = [];
  let terminalDelivered!: () => void;
  const terminalDelivery = new Promise<void>((resolve) => { terminalDelivered = resolve; });
  const runtime = {
    async publish(envelope: MyelinEnvelope) {
      visibility.push(envelope);
      await router.dispatch(envelope, subject);
      if (envelope.payload.outcome !== "started") terminalDelivered();
    },
  } as unknown as MyelinRuntime;
  return { runtime, visibility, terminalDelivery, router };
}

export function modeSpawn(mode: ProcessMode): Spawn {
  return () => {
    if (mode === "spawn-error") throw new Error("spawn failure");
    let end!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { end = resolve; });
    if (mode !== "watchdog") end(mode === "success" ? 0 : 1);
    return { exited, kill: () => { end(143); } };
  };
}

export async function reflexConsumer() {
  const blueprint = {
    id: "process-activation", kind: "manual", policy: "auto", target: "example-process",
    guards: { runLock: "skip" }, payload: {},
  };
  const guardState = { runLockHolder: null as string | null };
  const decisions = new Map<string, { id: string; blueprintId: string; correlationId?: string }>();
  const firedEvents = new Map<string, { decisionId: string; correlationId: string }>();
  const keys = new Set<string>();
  const releases: { blueprintId: string; correlationId: string }[] = [];
  const repo = {
    async hasIdempotencyKey(_blueprintId: string, key: string) { return keys.has(key); },
    async getGuardState() { return guardState; },
    async recordDecision(input: { blueprintId: string; correlationId?: string }) {
      const decision = { ...input, id: crypto.randomUUID() };
      decisions.set(decision.id, decision);
      return decision;
    },
    async putIdempotencyKey(_blueprintId: string, key: string) { keys.add(key); },
    async acquireRunLock(_blueprintId: string, correlationId: string) { guardState.runLockHolder = correlationId; },
    async recordFiredEvent(event: { decisionId: string; correlationId: string }) { firedEvents.set(event.correlationId, event); },
    async findFiredByCorrelation(correlationId: string) { return firedEvents.get(correlationId); },
    async getDecision(id: string) { return decisions.get(id); },
    async releaseRunLock(blueprintId: string, correlationId: string) {
      releases.push({ blueprintId, correlationId });
      if (guardState.runLockHolder === correlationId) guardState.runLockHolder = null;
    },
    async takeBufferedImpulse() { return null; },
  };
  const pipeline = new Pipeline({
    store: { get: (id: string) => id === blueprint.id ? blueprint : undefined },
    repo,
    bus: { async publishFired() {}, async publishDecision() {} },
  });
  const evaluate = (sequence: number) => pipeline.evaluate({
    blueprintId: blueprint.id, kind: "manual", payload: { sequence },
    receivedAt: new Date().toISOString(), actor: { type: "system", id: "test" },
  });
  const fired = await evaluate(0);
  if (fired.outcome !== "fired") throw new Error("Reflex fixture did not fire");
  return {
    correlationId: fired.correlationId as string,
    guardState,
    releases,
    evaluate,
    async consume(envelope: MyelinEnvelope, subject: string) {
      if (subject !== runOutcomeSubject({ principal: "jc", stack: "default" })) return;
      const result = readRunFinished(envelope);
      if (result.valid) await pipeline.onRunCompleted(result.correlationId, result.outcome);
    },
  };
}
