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
  const corr = envelope.correlation_id ? ` [${envelope.correlation_id}]` : "";
  return [
    `**${envelope.type}**${corr}`,
    "```json",
    JSON.stringify(envelope.payload, null, 2),
    "```",
  ].join("\n");
}
