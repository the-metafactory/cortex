/**
 * CK-4b (cortex#1295) — pure helpers for the cross-stack WORKING aggregate
 * render. The component uses hooks + a React renderer; this keeps the
 * per-state branching, the schema-origin keying, and the honest copy
 * derivation unit-testable without a DOM (same split as `working-grid-display`).
 *
 * ── Honest pre-release semantics (decision D-9) ──────────────────────────────
 * The mockup's WORKING tile reads "queued — awaiting hands". Pre-release we
 * render the assignment's honest `queued` / provider-retry state ONLY; the
 * `awaiting hands` capacity narrative (the SPX-2 hands-pool model) is DEFERRED
 * to SPX-3. `queuedRetryLabel` therefore NEVER emits "awaiting hands".
 */

import type {
  WorkingStackAggregate,
  ProviderRetryStatus,
} from "../hooks/use-working-aggregation";

/**
 * One of four rendering modes. No "hidden" branch (unlike the F-9 grid): the
 * cross-stack lane is always-present context inside the cockpit, never suppressed
 * by a sibling focus row.
 *
 * - `error`   — boot fetch failed; lane empty, error pill shown.
 * - `loading` — pre-boot, lane empty, no error.
 * - `empty`   — loaded, no origins working anywhere.
 * - `tiles`   — loaded, ≥1 origin rollup: render one metadata tile per origin.
 */
export type WorkingAggregateMode = "error" | "loading" | "empty" | "tiles";

export interface WorkingAggregateDisplayInput {
  aggregates: WorkingStackAggregate[];
  loaded: boolean;
  error: string | null;
}

export function pickWorkingAggregateMode(
  input: WorkingAggregateDisplayInput
): WorkingAggregateMode {
  const { aggregates, loaded, error } = input;
  if (aggregates.length > 0) return "tiles";
  if (error) return "error";
  if (!loaded) return "loading";
  return "empty";
}

/**
 * The tile's React key — keyed on the SCHEMA origin (`origin_stack_id`, CK-4a),
 * the deliberate replacement for the `working-grid` `workingTileKey` React-key
 * hack (which derived the key from the runtime federation tag). `null` ⇒ the
 * own/local bucket. Origin ids are unique per stack, so this never collides.
 */
export function aggregateTileKey(originStackId: string | null): string {
  return originStackId ?? "local";
}

/**
 * Display label for a tile's origin. `null` ⇒ own/local stack; a value ⇒ the
 * origin stack id verbatim (own sibling or federated peer — both metadata-only).
 */
export function originStackLabel(originStackId: string | null): string {
  return originStackId ?? "local";
}

/**
 * Active-session summary text — "N working". Metadata only.
 */
export function activeSessionSummary(activeSessionCount: number): string {
  return `${activeSessionCount} working`;
}

/**
 * Session-tree child-count (sub-agent) summary — accessible full text (not
 * color-only). A "sub-agent" is a child session (`parent_session_id`); the
 * count is CK-4a's `subAgentCount`. `0` ⇒ honest "no sub-agents".
 */
export function subAgentSummary(subAgentCount: number): string {
  if (subAgentCount <= 0) return "no sub-agents";
  return `${subAgentCount} sub-agent${subAgentCount === 1 ? "" : "s"}`;
}

/**
 * Honest queued / provider back-pressure label for a tile — PRE-SPAWN semantics
 * (decision D-9). `null` ⇒ no pending back-pressure (render nothing). A pending
 * `not_now` ⇒ "queued · retry in <delay>". NEVER "awaiting hands" (SPX-3).
 */
export function queuedRetryLabel(retry: ProviderRetryStatus | null): string | null {
  if (!retry) return null;
  return `queued · retry in ${formatRetryAfter(retry.retryAfterMs)}`;
}

/**
 * Format a retry delay (ms) into a compact, deterministic human string. No
 * `Date`/`Intl` — pure arithmetic so it's stable across environments and tests.
 */
export function formatRetryAfter(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1000) return "<1s";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
}
