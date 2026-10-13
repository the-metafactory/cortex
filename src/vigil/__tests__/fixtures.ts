import { createEnvelope, createExecutionRunFinished, type ExecutionRunFinishedPayloadInput } from "@the-metafactory/myelin";

export const SUBJECT = "local.jc.default.execution.run.finished";
export const KEY = "run:flow:daily-sweep";
export const ENDED_AT = Date.parse("2026-10-12T10:00:05.000Z");

export function ledgerEnvelope(overrides: Partial<ExecutionRunFinishedPayloadInput> = {}) {
  const event = createExecutionRunFinished({
    source: "jc.default.pulse",
    principal: "jc", stack: "default",
    sovereignty: { classification: "local", data_residency: "CH", max_hop: 0, frontier_ok: false, model_class: "any" },
    payload: {
      run_id: crypto.randomUUID(), producer: "pulse",
      ran: { kind: "flow", ref: "daily-sweep" }, outcome: "failed",
      started_at: "2026-10-12T10:00:00.000Z", ended_at: "2026-10-12T10:00:05.000Z",
      ...overrides,
    },
  });
  return createEnvelope({ ...event.input, sovereignty: { classification: "local", data_residency: "CH", max_hop: 0, frontier_ok: false, model_class: "any" } });
}
