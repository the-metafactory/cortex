// glossary-ignore: run
import { createEnvelope, createExecutionRunFinished, type ExecutionRunFinishedPayloadInput } from "@the-metafactory/myelin";

export const SUBJECT = "local.jc.default.execution.run.finished";
export const KEY = "run:flow:daily-sweep";
export const ENDED_AT = Date.parse("2026-10-12T10:00:05.000Z");

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
