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
  log(message: string): void;
}

function requiredString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

/** One run per local terminal dispatch; ledger failures never fail the dispatch. */
export function createRunLedgerFunnel(options: RunLedgerFunnelOptions): SurfaceAdapter {
  const prefix = `local.${options.principal}.${options.stack}.dispatch.task`;
  const subjects = [
    `${prefix}.completed`,
    `${prefix}.failed`,
    `${prefix}.aborted`,
  ];

  return {
    id: "run-ledger-funnel",
    subjects,
    async render(envelope, _signal, subject) {
      const mapping = envelope.type === "dispatch.task.completed"
        ? { outcome: "succeeded" as const, endedAt: "completed_at" }
        : envelope.type === "dispatch.task.failed"
          ? { outcome: "failed" as const, endedAt: "failed_at" }
          : envelope.type === "dispatch.task.aborted"
            ? { outcome: "cancelled" as const, endedAt: "aborted_at" }
            : undefined;
      if (mapping === undefined) return;
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
        const message =
          `run-ledger-funnel: task_id=${String(envelope.payload.task_id)}: ` +
          (error instanceof Error ? error.message : String(error));
        options.log(message.replace(/[\r\n]+/g, " "));
      }
    },
  };
}
