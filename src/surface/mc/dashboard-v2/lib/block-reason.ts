/**
 * Render a one-line operator-friendly summary of a `BlockReason`.
 *
 * Mirrors the legacy `blockReasonOneLiner` in
 * `src/mission-control/dashboard/index.html:1094`. Behavioural contract
 * (pinned by tests so the legacy and v2 surfaces stay consistent
 * through the migration window):
 *
 *  - `null` → `"blocked"`
 *  - unknown `kind` → `"blocked"`
 *  - `permission.request` → `"approve: <action>"` (action truncated to 40),
 *    or bare `"approve"` when payload action is missing.
 *  - `tool.error` → `"error: <tool_name>"` (truncated to 40),
 *    or bare `"error"` when payload tool_name is missing.
 *  - `review.checkpoint` → `"review: <description>"` (truncated to 40),
 *    or bare `"review"` when payload description is missing.
 *
 * No target/basename rendering for `permission.request` — the legacy
 * monolith deliberately omits it; review of PR #8 (S3) trimmed it down
 * to the action only.
 */

import type { BlockReason } from "../../types";

const ONE_LINER_MAX = 40;

export function blockReasonOneLiner(br: BlockReason | null): string {
  if (!br) return "blocked";
  if (br.kind === "permission.request") {
    const v = br.payload?.requested_action;
    return v ? `approve: ${truncate(v, ONE_LINER_MAX)}` : "approve";
  }
  if (br.kind === "tool.error") {
    const v = br.payload?.tool_name;
    return v ? `error: ${truncate(v, ONE_LINER_MAX)}` : "error";
  }
  if (br.kind === "review.checkpoint") {
    const v = br.payload?.description;
    return v ? `review: ${truncate(v, ONE_LINER_MAX)}` : "review";
  }
  return "blocked";
}

function truncate(s: string, max: number): string {
  const str = String(s ?? "");
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

/**
 * "5m ago" / "2h ago" / "20s ago" — relative time short form.
 *
 * Mirrors the legacy `formatAge` in
 * `src/mission-control/dashboard/index.html:1148`: minute and hour
 * buckets render WITHOUT sub-unit precision so a blocked card on `/`
 * and `/v2` shows the same age during the migration window. Invalid
 * input → `""` (matches legacy).
 */
export function timeAgo(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const delta = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (delta < 60) return `${delta}s ago`;
  const m = Math.floor(delta / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Map `priority` to a focus-card border-class. Falls through to "pu"
 * (unknown — dashed accent) when the value is outside the F-6 spec
 * range, mirroring the legacy `priorityClass` helper.
 */
export function priorityBorderClass(priority: number): "p0" | "p1" | "p2" | "p3" | "pu" {
  if (priority === 0) return "p0";
  if (priority === 1) return "p1";
  if (priority === 2) return "p2";
  if (priority === 3) return "p3";
  return "pu";
}
