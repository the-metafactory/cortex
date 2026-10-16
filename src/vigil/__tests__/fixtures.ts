// glossary-ignore: run
import { createEnvelope, createExecutionRunFinished, type ExecutionRunFinishedPayloadInput } from "@the-metafactory/myelin";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SUBJECT = "local.jc.default.execution.run.finished";
export const KEY = "run:flow:daily-sweep";
export const ENDED_AT = Date.parse("2026-10-12T10:00:05.000Z");
export const DELIVERY_DEFAULTS = {
  held_reason: null, sent_at: null, via: null, attempts: 0, last_error: null, transient_failures: 0,
} as const;

export function temporaryVigilDatabaseFile(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    path: join(dir, "mc.db"),
    [Symbol.dispose]() { rmSync(dir, { recursive: true, force: true }); },
  };
}

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
