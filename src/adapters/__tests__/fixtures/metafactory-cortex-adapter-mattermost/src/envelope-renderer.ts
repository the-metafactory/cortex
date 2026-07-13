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
 *
 * cortex#1796 (S11, ADR-0024 D5 extraction lane) — VERBATIM COPY of cortex
 * core's `src/adapters/envelope-renderer.ts` (still shared there by discord/
 * slack/dispatch-sink/review-sink/filter-rejection — genuinely cross-adapter
 * shared machinery, not something this one plugin can claim ownership of and
 * relocate). Mattermost's `index.ts` only calls `formatEnvelopeAsMarkdown` —
 * copied here, along with its two private helpers, so the plugin has zero
 * cross-boundary import for its surface-router `renderEnvelope` path. Only
 * `Envelope` (SDK-exported) is a dependency — this file has no further
 * cross-boundary coupling of its own. `formatReviewVerdict` (the review-sink
 * consumer's export) is NOT copied — mattermost never calls it.
 */

import type { Envelope } from "@the-metafactory/cortex/surface-sdk";

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

  if (envelope.type === "dispatch.task.post") {
    // cortex#1039 follow-up — a brain `post` carries its OWN content (the
    // composed flow, the ask_principal prompt, per-step replies) under
    // `payload.text`. Render that verbatim; without this the sink dropped
    // every brain post on `text === null` (started/completed/failed were the
    // only rendered lifecycle types), so a bot pack could never speak.
    // Empty text → null (nothing to post). Attachment delivery (the diagram
    // PNG) is a separate sink concern — the flow falls back to fenced mermaid
    // source in `text` when no PNG, so text alone is a complete message.
    // Verbatim: post the brain's text exactly (intentional leading/trailing
    // whitespace + final newlines preserved); trim ONLY for the empty check.
    const text = typeof payload.text === "string" ? payload.text : "";
    return text.trim().length > 0 ? text : null;
  }

  if (envelope.type === "dispatch.task.completed") {
    // cortex#491 — full reply when present (chat round-trip), else the
    // dashboard summary label, else a terse default.
    const full = typeof payload.chat_response === "string" ? payload.chat_response.trim() : "";
    if (full) {
      // cortex#1149 (slice convergence B / B3) — the dev.implement consumer's
      // terminal completed rides the PR ref as a JSON blob on `chat_response`
      // (`dev-consumer.ts` — `chatResponse: JSON.stringify({ pr })`), because
      // the dispatch builder has no dedicated `pr` field. On the slice thread
      // that blob would post as raw JSON; render it instead as the clean
      // "opened PR #N · url" milestone beat. Only a `{ pr: { repo, number } }`
      // shape triggers this — any other prose falls through verbatim, so a
      // normal chat reply is never swallowed.
      const milestone = formatPrMilestone(full);
      if (milestone !== null) return milestone;
      return full;
    }
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

/**
 * cortex#1149 (slice convergence B / B3) — parse a dev.implement completed's
 * `chat_response` PR blob and render the "opened PR #N · url" milestone beat.
 *
 * The dev consumer rides the PR ref as `JSON.stringify({ pr })` on
 * `chat_response` (there's no dedicated `pr` field on the dispatch builder).
 * On the slice thread that blob would otherwise post as raw JSON. Returns the
 * milestone string for a `{ pr: { repo, number, url? } }` shape, or `null` for
 * any other text (a normal prose chat reply) so the caller falls through to
 * rendering it verbatim — the parse is intentionally narrow.
 */
function formatPrMilestone(chatResponse: string): string | null {
  // Cheap pre-check: only attempt a parse on something that looks like the
  // `{pr:...}` blob, never on arbitrary prose.
  if (!chatResponse.startsWith("{") || !chatResponse.includes('"pr"')) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(chatResponse);
  } catch {
    // Not JSON (prose that merely happens to start with `{`) — fall through.
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const pr = (parsed as Record<string, unknown>).pr;
  if (pr === null || typeof pr !== "object") return null;
  const ref = pr as Record<string, unknown>;
  const repo = typeof ref.repo === "string" ? ref.repo : null;
  const number = typeof ref.number === "number" ? ref.number : null;
  if (repo === null || number === null) return null;
  const url = typeof ref.url === "string" && ref.url.length > 0 ? ref.url : null;
  const head = `opened ${repo}#${number}`;
  return url ? `${head} · ${url}` : head;
}

/**
 * cortex#502 — render a `review.verdict.{approved|changes-requested|commented}`
 * envelope to a concise one-liner reply, or `null` for any other envelope
 * type. The verdict is the PRIMARY review reply; the **review sink**
 * (`src/adapters/review-sink.ts`) reuses this formatter (one formatter, no
 * reinvented copy — same discipline as the dispatch sink reusing
 * `formatDispatchLifecycle`). The sink owns delivery + the requester ping;
 * this stays the pure text half.
 *
 * Shape:
 *   `{emoji} {reviewer} {verdict-label} {repo}#{pr} — {b}B/{m}M/{n}N · {url}`
 *
 * e.g. `🔴 echo requested changes the-metafactory/cortex#57 — 1B/2M/3N · https://github.com/...`
 *
 * Emoji + verdict-label by `payload.verdict`:
 *   - `approved`          → ✅ "approved"
 *   - `changes-requested` → 🔴 "requested changes"
 *   - `commented`         → 💬 "commented on"
 *
 * Returns `null` (rather than a JSON fallback) for non-verdict envelopes so
 * the sink can decide whether to fall through to `formatDispatchLifecycle`.
 */
export function formatReviewVerdict(envelope: Envelope): string | null {
  if (!envelope.type.startsWith("review.verdict.")) return null;
  const payload = envelope.payload;

  const reviewer = typeof payload.reviewer === "string" ? payload.reviewer : "reviewer";
  const repo = typeof payload.repo === "string" ? payload.repo : "?";
  const pr = typeof payload.pr === "number" ? payload.pr : "?";
  const url =
    typeof payload.github_review_url === "string" ? payload.github_review_url : "";

  const verdict = typeof payload.verdict === "string" ? payload.verdict : "";
  let emoji: string;
  let verdictLabel: string;
  if (verdict === "approved") {
    emoji = "✅";
    verdictLabel = "approved";
  } else if (verdict === "changes-requested") {
    emoji = "🔴";
    verdictLabel = "requested changes";
  } else {
    // "commented" or any unknown verdict — render neutrally.
    emoji = "💬";
    verdictLabel = "commented on";
  }

  const findings = (payload.findings ?? {}) as Record<string, unknown>;
  const b = typeof findings.blockers === "number" ? findings.blockers : 0;
  const m = typeof findings.majors === "number" ? findings.majors : 0;
  const n = typeof findings.nits === "number" ? findings.nits : 0;

  const head = `${emoji} ${reviewer} ${verdictLabel} ${repo}#${pr} — ${b}B/${m}M/${n}N`;
  return url ? `${head} · ${url}` : head;
}
