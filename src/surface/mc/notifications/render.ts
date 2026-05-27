/**
 * Grove Mission Control v2 — F-11 notification renderer (pure function).
 *
 * Implements the Decision 8 payload shape from
 * `docs/design-mc-f11-discord-notifications.md`. Two payloads, one for DM
 * and one for channel post, both plain text with the field order the
 * addendum pins.
 *
 * No I/O, no LLM call (Decision 8: "no LLM call on the hot path"). The
 * one-line summary is sourced from `block_reason.context` when present
 * and falls back to a truncated `recentAssistantMessage` string the
 * caller threads in. Truncation is at 80 chars, word-boundary, suffix `…`
 * — matching F-8's task-table column clamp.
 *
 * **Untrusted-string posture (Decision 8).** All agent-generated free-form
 * fields (`block_reason.context`, `tool.error.error_message`,
 * `recentAssistantMessage`) are passed through verbatim. Discord's DM/channel
 * surfaces render plain text; there is no injection attack surface to
 * defend against on the render side. The principal already trusts the
 * agent's output everywhere else (dashboard, CLI, events table).
 */
import type { BlockReason } from "../types";
import type { NotificationIntent } from "./should-notify";

/** Hard cap on task-title length in payload subject lines (Decision 8). */
const TASK_TITLE_MAX = 80;
/** Hard cap on extractive one-liner summary length (Decision 8). */
const SUMMARY_MAX = 80;

export interface RenderContext {
  /**
   * Decision 1 / Decision 3 output — drives prefix and channel selection.
   */
  intent: NotificationIntent;
  /** Display name of the agent that owns the assignment. */
  agentName: string;
  /**
   * Short identifier for the task — e.g. `"T-42"`. Caller derives this
   * from `tasks.source_external_id` when present, falling back to a short
   * prefix of `tasks.id`.
   */
  taskRef: string;
  /** Free-form task title; truncated by the renderer. */
  taskTitle: string;
  /**
   * The state being entered — drives the verb in the subject line
   * (`blocked on`, `failed`, `completed`).
   */
  toState: "blocked" | "failed" | "completed";
  /** Present iff `toState === 'blocked'`. */
  blockReason: BlockReason | null;
  /**
   * 1-indexed dispatch count for this assignment ("Cycle N"). Optional
   * — when absent the cycle line is omitted.
   */
  cycle?: number;
  /**
   * Relative timestamp string ("2s ago", "3m ago"). Caller computes; the
   * renderer is clock-free.
   */
  observedAgo: string;
  /**
   * Most recent assistant text, used as the line-5 fallback summary when
   * `block_reason.context` is absent. Already in untrusted-string form
   * — passed through verbatim, only truncated.
   */
  recentAssistantMessage?: string;
  /** Deep-link URL with a `from=` query param already appended. */
  deepLink: string;
  /** When true, append a one-line warning that grove.baseUrl is unset. */
  baseUrlWarning?: boolean;
}

/** Single-event DM payload — Decision 8's seven-line shape. */
export function renderDM(ctx: RenderContext): string {
  const lines: string[] = [];

  // Line 1 — subject: [tag] agent verb T-id "title"
  const verb = subjectVerb(ctx.toState);
  const tag = ctx.intent.urgencyTag ? `[${ctx.intent.urgencyTag}] ` : "";
  const title = truncateWordBoundary(ctx.taskTitle, TASK_TITLE_MAX);
  lines.push(`${tag}${ctx.agentName} ${verb} ${ctx.taskRef} "${title}"`);

  // Line 2 — block reason structured context (only when blocked).
  const reasonLine = renderBlockReasonLine(ctx.blockReason);
  if (reasonLine) lines.push(reasonLine);

  // Line 3 — cycle + observed-ago.
  const cycleParts: string[] = [];
  if (typeof ctx.cycle === "number" && ctx.cycle > 0) cycleParts.push(`Cycle ${ctx.cycle}`);
  cycleParts.push(`observed ${ctx.observedAgo}`);
  lines.push(cycleParts.join(" · "));

  // Line 4 — blank.
  // Line 5 — extractive summary. Source priority:
  //   1) block_reason.context (already a one-line agent rationale)
  //   2) recentAssistantMessage (truncated)
  //   3) omit entirely (renders as 6 lines instead of 7)
  const summary = pickSummary(ctx);
  if (summary) {
    lines.push("");
    lines.push(`One-liner: ${summary}`);
  }

  // Line 6 — blank.
  // Line 7 — deep-link.
  lines.push("");
  lines.push(`Open: ${ctx.deepLink}`);

  if (ctx.baseUrlWarning) {
    lines.push(BASE_URL_WARNING);
  }

  return lines.join("\n");
}

/** Single-event channel-post payload — Decision 8's three-line shape. */
export function renderChannel(ctx: RenderContext): string {
  const verb = subjectVerb(ctx.toState);
  const tag = ctx.intent.urgencyTag ? `[${ctx.intent.urgencyTag}] ` : "";
  const title = truncateWordBoundary(ctx.taskTitle, TASK_TITLE_MAX);
  const subject = `${tag}${ctx.agentName} ${verb} ${ctx.taskRef} "${title}"`;

  const lines: string[] = [subject];

  // Optional context line. For terminal `failed`, prefer block-reason +
  // root-cause when available; otherwise omit and let the deep-link carry
  // the load.
  const contextLine = renderChannelContextLine(ctx);
  if (contextLine) lines.push(contextLine);

  lines.push("");
  lines.push(ctx.deepLink);

  if (ctx.baseUrlWarning) {
    lines.push(BASE_URL_WARNING);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Coalesced summary payload (Decision 7)
// ---------------------------------------------------------------------

export interface CoalesceItem {
  /** Per-item urgency tag — e.g. `"P0-HIGH"`. */
  urgencyTag: string | null;
  agentName: string;
  taskRef: string;
  taskTitle: string;
  /** "permission.request: tool.bash", "tool.error: exit 1", etc. */
  reasonLine: string;
}

export interface CoalesceContext {
  /** N — count of distinct items in this burst. */
  count: number;
  /**
   * Highest-priority urgency tag of the burst — used in the summary
   * subject line and prefix. May be `null` if no item carries a tag.
   */
  topUrgencyTag: string | null;
  items: CoalesceItem[];
  /** Deep-link to the highest-priority assignment. */
  deepLink: string;
  baseUrlWarning?: boolean;
}

/**
 * Coalesced DM body — Decision 7 example shape.
 *
 *     [P1] 3 agents blocked
 *     - Luna · T-42 "fix webhook HMAC" · permission.request: tool.bash
 *     - rev  · T-43 "review PR #45"    · tool.error: exit 1
 *     - impl · T-44 "draft migration"  · permission.request: tool.edit
 *
 *     Dashboard: https://...
 */
export function renderCoalescedDM(c: CoalesceContext): string {
  const tag = c.topUrgencyTag ? `[${c.topUrgencyTag}] ` : "";
  const subject = `${tag}${c.count} agents blocked`;

  const bullets = c.items.map((item) => {
    const title = truncateWordBoundary(item.taskTitle, 60);
    return `- ${item.agentName} · ${item.taskRef} "${title}" · ${item.reasonLine}`;
  });

  const lines = [subject, ...bullets, "", `Dashboard: ${c.deepLink}`];
  if (c.baseUrlWarning) lines.push(BASE_URL_WARNING);
  return lines.join("\n");
}

/** Coalesced channel-post body — same shape as DM (per addendum), prefixed
 *  with the channel-throttle subject. */
export function renderCoalescedChannel(c: CoalesceContext): string {
  return renderCoalescedDM(c);
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const BASE_URL_WARNING = "Deep link unavailable; configure `grove.baseUrl`.";

function subjectVerb(state: "blocked" | "failed" | "completed"): string {
  if (state === "blocked") return "blocked on";
  if (state === "failed") return "failed";
  return "completed";
}

function renderBlockReasonLine(reason: BlockReason | null): string | null {
  if (!reason) return null;
  if (reason.kind === "permission.request") {
    const action = reason.payload.requested_action;
    const target = reason.payload.target;
    return target
      ? `permission.request: ${action} ${target}`
      : `permission.request: ${action}`;
  }
  if (reason.kind === "tool.error") {
    const tool = reason.payload.tool_name;
    const msg = reason.payload.error_message;
    return `tool.error: ${tool} — "${msg}"`;
  }
  // BlockReason has exactly three kinds; after the two `if` returns
  // above, narrowing leaves only "review.checkpoint".
  return `review.checkpoint: "${reason.payload.description}"`;
}

function renderChannelContextLine(ctx: RenderContext): string | null {
  if (ctx.toState !== "failed") {
    // For P0 completed (the one channel-completed cell), the subject is
    // already enough — no context line.
    return null;
  }
  // Failed: prefer the block-reason line if present, else the recent
  // assistant message, else nothing.
  const reasonLine = renderBlockReasonLine(ctx.blockReason);
  if (reasonLine) return reasonLine;
  if (ctx.recentAssistantMessage) {
    const msg = truncateWordBoundary(ctx.recentAssistantMessage, SUMMARY_MAX);
    return `Root cause: ${msg}`;
  }
  return null;
}

function pickSummary(ctx: RenderContext): string | null {
  if (ctx.blockReason?.kind === "permission.request") {
    const c = ctx.blockReason.payload.context;
    if (c && c.length > 0) return truncateWordBoundary(c, SUMMARY_MAX);
  }
  if (ctx.recentAssistantMessage && ctx.recentAssistantMessage.length > 0) {
    return truncateWordBoundary(ctx.recentAssistantMessage, SUMMARY_MAX);
  }
  return null;
}

/**
 * Truncate a string to `max` characters at the nearest word boundary, with
 * `…` suffix when truncation actually happened.
 *
 * Strategy: find the last whitespace ≤ (max - 1). If none, hard-cut at
 * (max - 1). The `- 1` reserves one character for the ellipsis.
 */
export function truncateWordBoundary(s: string, max: number): string {
  if (s.length <= max) return s;
  const cap = max - 1;
  const slice = s.slice(0, cap);
  const lastSpace = slice.lastIndexOf(" ");
  // Require the word boundary to fall in the latter half — otherwise we'd
  // truncate "fix webhook HMAC verification with a long tail" to just "fix…".
  if (lastSpace > cap / 2) {
    return slice.slice(0, lastSpace) + "…";
  }
  return slice + "…";
}
