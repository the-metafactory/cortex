import { createExecutionRunFinished, type MyelinEnvelope } from "@the-metafactory/myelin";
import { createEnvelope } from "@the-metafactory/myelin/envelope";
import {
  deriveNatsSubject,
  type Envelope,
} from "./myelin/envelope-validator";
import type { SurfaceAdapter } from "./surface-router";

export interface RunLedgerFunnelOptions {
  principal: string;
  stack: string;
  publish(envelope: MyelinEnvelope, subject: string): Promise<void>;
  log(line: string): void;
}

type RunOutcome = "succeeded" | "failed" | "cancelled";

interface TerminalRun {
  run_id: string;
  ran: { kind: "dispatch" | "job"; ref: string };
  outcome: RunOutcome;
  started_at: string;
  ended_at: string;
  correlation_id: string;
}

const DISPATCH_TERMINAL = {
  "dispatch.task.completed": { outcome: "succeeded", endedAt: "completed_at" },
  "dispatch.task.failed": { outcome: "failed", endedAt: "failed_at" },
  "dispatch.task.aborted": { outcome: "cancelled", endedAt: "aborted_at" },
} as const;

const PROCESS_TYPE = "system.bus.process";

const PROCESS_OUTCOME: Record<string, RunOutcome> = {
  completed: "succeeded",
  failed: "failed",
};

function requiredString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function processOutcome(envelope: Envelope): RunOutcome | undefined {
  if (envelope.type !== PROCESS_TYPE) return undefined;
  const state = String(envelope.payload.outcome);
  return Object.hasOwn(PROCESS_OUTCOME, state) ? PROCESS_OUTCOME[state] : undefined;
}

function optionalString(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function runLabel(envelope: Envelope): string {
  return envelope.type === PROCESS_TYPE
    ? `process=${String(envelope.payload.process)}`
    : `task_id=${String(envelope.payload.task_id)}`;
}

/**
 * Derived-event producer exception to SurfaceAdapter's render-only use
 * (CONTEXT.md §Dispatch ledger funnel). Ledger failures never fail the dispatch.
 */
export function createRunLedgerFunnel(options: RunLedgerFunnelOptions): SurfaceAdapter {
  const subjectFor = (type: string): string => `local.${options.principal}.${options.stack}.${type}`;
  const subjects = [...Object.keys(DISPATCH_TERMINAL), PROCESS_TYPE].map(subjectFor);

  const dispatchRun = (envelope: Envelope): TerminalRun => {
    const mapping = DISPATCH_TERMINAL[envelope.type as keyof typeof DISPATCH_TERMINAL];
    const taskId = requiredString(envelope.payload, "task_id");
    return {
      run_id: taskId,
      ran: { kind: "dispatch", ref: requiredString(envelope.payload, "agent_id") },
      outcome: mapping.outcome,
      started_at: requiredString(envelope.payload, "started_at"),
      ended_at: requiredString(envelope.payload, mapping.endedAt),
      correlation_id: envelope.correlation_id ?? taskId,
    };
  };

  const processRun = (envelope: Envelope, outcome: RunOutcome): TerminalRun => {
    const activationCorrelation = optionalString(envelope.payload, "correlation_id") ?? envelope.correlation_id;
    const runId = envelope.id;
    return {
      run_id: runId,
      ran: { kind: "job", ref: requiredString(envelope.payload, "process") },
      outcome,
      started_at: requiredString(envelope.payload, "started_at"),
      ended_at: envelope.timestamp,
      correlation_id: activationCorrelation ?? runId,
    };
  };

  const isTerminal = (envelope: Envelope): boolean =>
    Object.hasOwn(DISPATCH_TERMINAL, envelope.type) || processOutcome(envelope) !== undefined;

  const terminalRun = (envelope: Envelope): TerminalRun => {
    const outcome = processOutcome(envelope);
    return outcome === undefined ? dispatchRun(envelope) : processRun(envelope, outcome);
  };

  return {
    id: "run-ledger-funnel",
    subjects,
    async render(envelope, _signal, subject) {
      if (!isTerminal(envelope)) return;
      if ((subject ?? deriveNatsSubject(envelope, options.stack)) !== subjectFor(envelope.type)) return;

      try {
        const run = terminalRun(envelope);
        const event = createExecutionRunFinished({
          principal: options.principal,
          stack: options.stack,
          source: `${options.principal}.${options.stack}.cortex`,
          sovereignty: envelope.sovereignty,
          payload: { ...run, producer: "cortex" },
        });
        await options.publish(createEnvelope({
          ...event.input,
          sovereignty: envelope.sovereignty,
        }), event.subject);
      } catch (error) {
        const line =
          `run-ledger-funnel: ${runLabel(envelope)}: ` +
          (error instanceof Error ? error.message : String(error));
        options.log(line.replace(/[\r\n]+/g, " "));
      }
    },
  };
}
