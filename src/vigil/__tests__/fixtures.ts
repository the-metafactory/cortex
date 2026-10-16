// glossary-ignore: run
import { createEnvelope, createExecutionRunFinished, type ExecutionRunFinishedPayloadInput } from "@the-metafactory/myelin";

export const SUBJECT = "local.jc.default.execution.run.finished";
export const KEY = "run:flow:daily-sweep";
export const ENDED_AT = Date.parse("2026-10-12T10:00:05.000Z");

/** Captures an interval so tests can advance Vigil without wall-clock waits. */
export function fakeTickScheduler() {
  let callback: (() => void) | undefined;
  let intervalMs: number | undefined;
  let cancellations = 0;
  return {
    schedule: (fn: () => void, ms: number) => {
      callback = fn;
      intervalMs = ms;
      return () => { cancellations += 1; };
    },
    tick: () => callback?.(),
    get intervalMs() { return intervalMs; },
    get cancellations() { return cancellations; },
  };
}

export const flushTick = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

const SOVEREIGNTY = { classification: "local", data_residency: "CH", max_hop: 0, frontier_ok: false, model_class: "any" } as const;

export function ledgerEnvelope(overrides: Partial<ExecutionRunFinishedPayloadInput> = {}, stack = "default") {
  const event = createExecutionRunFinished({
    source: `jc.${stack}.pulse`,
    principal: "jc", stack,
    sovereignty: SOVEREIGNTY,
    payload: {
      run_id: crypto.randomUUID(), producer: "pulse",
      ran: { kind: "flow", ref: "daily-sweep" }, outcome: "failed",
      started_at: "2026-10-12T10:00:00.000Z", ended_at: "2026-10-12T10:00:05.000Z",
      ...overrides,
    },
  });
  return createEnvelope({ ...event.input, sovereignty: SOVEREIGNTY });
}
