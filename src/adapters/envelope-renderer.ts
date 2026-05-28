/**
 * MIG-3b: Shared envelope-rendering helper for surface adapters.
 *
 * v1 — when a surface adapter receives a bus envelope from the
 * surface-router and has no per-event-type renderer configured, it falls
 * back to this compact code-block representation. Both Discord and
 * Mattermost accept the same markdown shape, so we share one formatter.
 *
 * v2 (per docs/architecture.md §9 — the Renderer model, MIG-7.2d): per-
 * event-type templates with sovereignty-aware redaction and per-channel
 * routing rules. This file stays as the safe default for envelopes that
 * don't match any registered template.
 *
 * Pure function. No side effects. Safe to call from any context.
 */

import type { Envelope } from "../bus/myelin/envelope-validator";

/**
 * Format an envelope as a markdown code-block message body.
 *
 * Shape:
 *   **{type}** [correlation_id?]
 *   ```json
 *   {payload}
 *   ```
 *
 * The correlation_id is included when present so a principal scanning
 * the channel can correlate envelopes across a workflow without opening
 * the envelope details.
 */
export function formatEnvelopeAsMarkdown(envelope: Envelope): string {
  const renderedDispatch = formatDispatchLifecycle(envelope);
  if (renderedDispatch) return renderedDispatch;

  const corr = envelope.correlation_id ? ` [${envelope.correlation_id}]` : "";
  return [
    `**${envelope.type}**${corr}`,
    "```json",
    JSON.stringify(envelope.payload, null, 2),
    "```",
  ].join("\n");
}

/**
 * Render a `dispatch.task.{started|completed|failed|aborted}` lifecycle
 * envelope to concise reply text, or `null` for any other envelope type.
 *
 * Exported (cortex#491) so the **dispatch sink** (`src/adapters/dispatch-sink.ts`)
 * reuses the SAME text it already produces for the surface-router render
 * path — one formatter, no drift, no reinvented copy. The sink is the
 * delivery half (`postResponse`/`sendProgress`); this stays the pure
 * text half.
 *
 * For `dispatch.task.completed` it prefers the FULL untruncated
 * `chat_response` (cortex#491 — the complete chat round-trip) and falls
 * back to `result_summary` (the first-line/1000-char dashboard label)
 * when no full reply was carried — so non-chat dispatches still render.
 */
export function formatDispatchLifecycle(envelope: Envelope): string | null {
  const payload = envelope.payload;
  const agent = typeof payload.agent_id === "string" ? payload.agent_id : "agent";
  const label = agent.charAt(0).toUpperCase() + agent.slice(1);

  if (envelope.type === "dispatch.task.started") {
    return `${label} is working...`;
  }

  if (envelope.type === "dispatch.task.completed") {
    // cortex#491 — full reply when present (chat round-trip), else the
    // dashboard summary label, else a terse default.
    const full = typeof payload.chat_response === "string" ? payload.chat_response.trim() : "";
    if (full) return full;
    const summary = typeof payload.result_summary === "string" ? payload.result_summary.trim() : "Done.";
    return summary || "Done.";
  }

  if (envelope.type === "dispatch.task.failed") {
    const summary = typeof payload.error_summary === "string" ? payload.error_summary.trim() : "unknown error";
    return `${label} failed: ${summary}`;
  }

  if (envelope.type === "dispatch.task.aborted") {
    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "aborted";
    return `${label} stopped: ${reason}`;
  }

  return null;
}
