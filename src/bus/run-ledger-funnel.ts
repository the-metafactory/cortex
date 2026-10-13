import { createExecutionRunFinished, type MyelinEnvelope } from "@the-metafactory/myelin";
import { createEnvelope } from "@the-metafactory/myelin/envelope";
import {
  deriveNatsSubject,
} from "./myelin/envelope-validator";
import type { SurfaceAdapter } from "./surface-router";

export interface RunLedgerFunnelOptions {
  principal: string;
  stack: string;
  publish(envelope: MyelinEnvelope, subject: string): Promise<void>;
  log(line: string): void;
}

const TERMINAL = {
  "dispatch.task.completed": { outcome: "succeeded", endedAt: "completed_at" },
  "dispatch.task.failed": { outcome: "failed", endedAt: "failed_at" },
  "dispatch.task.aborted": { outcome: "cancelled", endedAt: "aborted_at" },
} as const;

function requiredString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Derived-event producer exception to SurfaceAdapter's render-only use
 * (CONTEXT.md §Dispatch ledger funnel). Ledger failures never fail the dispatch.
 */
export function createRunLedgerFunnel(options: RunLedgerFunnelOptions): SurfaceAdapter {
  const subjects = Object.keys(TERMINAL).map(type =>
    `local.${options.principal}.${options.stack}.${type}`);

  return {
    id: "run-ledger-funnel",
    subjects,
    async render(envelope, _signal, subject) {
      if (!Object.hasOwn(TERMINAL, envelope.type)) return;
      const mapping = TERMINAL[envelope.type as keyof typeof TERMINAL];
      if ((subject ?? deriveNatsSubject(envelope, options.stack)) !==
        `local.${options.principal}.${options.stack}.${envelope.type}`) return;

      try {
        const taskId = requiredString(envelope.payload, "task_id");
        const event = createExecutionRunFinished({
          principal: options.principal,
          stack: options.stack,
          source: `${options.principal}.${options.stack}.cortex`,
          sovereignty: envelope.sovereignty,
          payload: {
            run_id: taskId,
            producer: "cortex",
            ran: { kind: "dispatch", ref: requiredString(envelope.payload, "agent_id") },
            outcome: mapping.outcome,
            started_at: requiredString(envelope.payload, "started_at"),
            ended_at: requiredString(envelope.payload, mapping.endedAt),
            correlation_id: envelope.correlation_id ?? taskId,
          },
        });
        await options.publish(createEnvelope({
          ...event.input,
          sovereignty: envelope.sovereignty,
        }), event.subject);
      } catch (error) {
        const line =
          `run-ledger-funnel: task_id=${String(envelope.payload.task_id)}: ` +
          (error instanceof Error ? error.message : String(error));
        options.log(line.replace(/[\r\n]+/g, " "));
      }
    },
  };
}
