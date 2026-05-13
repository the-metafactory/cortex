/**
 * MIG-4.6 — `dispatch.task.*` envelope constructors.
 *
 * Per G-1111 §3.4 the `dispatch.task` domain captures the lifecycle of a
 * task that an operator (or a sibling agent) dispatched to a runner-style
 * agent: `dispatched`, `accepted`, `rejected`, `started`, `completed`,
 * `failed`. This file ships the four lifecycle helpers cortex's runner
 * needs end-to-end (`started`, `completed`, `failed`, `aborted`).
 *
 * Note on §3.4 vs §6: the spec's §3.4 summary table omits `aborted`
 * (only lists `failed`) but the natural runtime distinction between
 * "the task failed under its own power" and "the task was killed by an
 * outside force (timeout, operator cancel, shutdown)" is load-bearing
 * for surfaces — a worklog rendering "aborted: timeout" reads very
 * differently from "failed: assertion error". We therefore add
 * `aborted` as a non-breaking sibling to `failed` per §3.1's
 * append-only rule, with a payload shape that distinguishes the two.
 *
 * **Shape contract** (mirrors `system-events.ts`):
 *   - `id` is a fresh `crypto.randomUUID()` per call (envelope idempotency key).
 *   - `timestamp` is the helper-call time. Lifecycle moments distinct from
 *     emit time (`started_at`, `completed_at`, etc.) live in payload.
 *   - `source` is the dotted `{org}.{agent}.{instance}` per the schema.
 *   - `correlation_id` is the **task UUID** when the caller provides one —
 *     the runner generates a UUID-shaped task_id at accept time so all four
 *     lifecycle events for a single task share one correlation_id. Surfaces
 *     join started→completed/failed/aborted on that key.
 *   - `sovereignty` defaults to local-only / NZ / max_hop=0 / frontier_ok=false /
 *     model_class=local-only — same rationale as `system-events.ts`: dispatch
 *     events expose internal task IDs, agent identities, and error summaries.
 *
 * **What this file is NOT:**
 *   - NOT a re-export of `system-events.ts` types. The two domains share
 *     `SystemEventSource` shape conceptually but the spec keeps them as
 *     separate domains. We import the `SystemEventSource` type from
 *     `system-events.ts` to avoid redeclaring the same shape.
 *   - NOT a renderer. Surfaces (worklog-manager, dashboard, future
 *     adapters) consume these envelopes via the surface-router and decide
 *     how to render. This file is producer-side only.
 *   - NOT validating the `task_id` format. Callers MUST pass a UUID-shaped
 *     string; the envelope validator catches malformed values downstream
 *     (since `correlation_id` constraint is UUID).
 */

import type { Classification, Envelope } from "./myelin/envelope-validator";
import { buildBaseEnvelope as buildSharedEnvelope } from "./envelope-builder";
import type { SystemEventSource } from "./system-events";

// Re-export `SystemEventSource` under a domain-neutral alias so callers
// in `runner/` import from one place. The alias is purely ergonomic;
// the underlying shape is identical.
export type DispatchEventSource = SystemEventSource;

function buildSource(src: SystemEventSource): string {
  return `${src.org}.${src.agent}.${src.instance}`;
}

/**
 * Default sovereignty for `dispatch.task.*` events. Same posture as
 * `system.*`: operator-only by default, local residency, no frontier.
 *
 * `data_residency` is sourced from `source.dataResidency` (defaulting to
 * `"NZ"` for the original cortex deployment) so a non-NZ operator gets
 * envelopes stamped with their actual residency. Mirrors the parameterisation
 * pattern in `system-events.ts` so both event domains read the same field
 * off the same source struct.
 *
 * **IAW Phase A.3:** `classification` is now an optional parameter
 * (defaulting to `"local"` for back-compat). Callers may opt into
 * `"federated"` or `"public"` when dispatch lifecycle events need to cross
 * operator boundaries (e.g. a federated multi-org dispatch). The default
 * keeps every existing call site behaving identically.
 *
 * Returned as a fresh literal per call so a downstream mutation on one
 * envelope's `sovereignty` cannot leak into a sibling envelope.
 */
function defaultDispatchSovereignty(
  source: SystemEventSource,
  classification: Classification = "local",
): Envelope["sovereignty"] {
  return {
    classification,
    data_residency: source.dataResidency ?? "NZ",
    max_hop: 0,
    frontier_ok: false,
    model_class: "local-only",
  };
}

// ---------------------------------------------------------------------------
// Common option shape — every lifecycle event carries `task_id`, `agent_id`,
// and an optional `correlation_id`. The four helpers below extend it.
// ---------------------------------------------------------------------------

/**
 * Fields every `dispatch.task.*` event carries. Spelled out as an interface
 * so each lifecycle helper's option type can `extends DispatchTaskCommonOpts`
 * without redeclaring the same fields and risking drift.
 *
 * `task_id` doubles as the natural correlation key. Callers may pass an
 * explicit `correlationId` to override (e.g., when a task is part of a
 * larger workflow whose correlation_id was assigned upstream); when omitted,
 * the envelope's `correlation_id` is set to `task_id`.
 */
export interface DispatchTaskCommonOpts {
  source: DispatchEventSource;
  /**
   * UUID-shaped task identifier. The runner generates this at accept time
   * (currently inside `dispatch-handler.ts`). Required on every lifecycle
   * envelope so surfaces can stitch the timeline.
   */
  taskId: string;
  /**
   * Agent identifier — the logical agent name that handled the task
   * (`cortex`, `pilot`, etc.). Distinct from `envelope.source` because
   * `source` is `org.agent.instance` and we want a flat agent label
   * for filters/projection.
   */
  agentId: string;
  /**
   * Optional explicit correlation_id (UUID format). When provided, this
   * value is used as `envelope.correlation_id`. When omitted, `taskId`
   * is used — the canonical "all four lifecycle events for one task
   * share one correlation key" guarantee.
   */
  correlationId?: string;
  /**
   * IAW Phase A.3 — optional sovereignty classification. Defaults to
   * `"local"` (operator-private). Set to `"federated"` when a dispatch
   * lifecycle event needs to reach peer operators (e.g. a multi-org task
   * pipeline whose progress should surface on federated dashboards);
   * `"public"` for global visibility. Mismatch with the publish-time
   * subject is a protocol violation (see
   * {@link validateSubjectEnvelopeAlignment}).
   */
  classification?: Classification;
}

/**
 * Domain-specific wrapper around `buildSharedEnvelope` (from
 * `bus/envelope-builder.ts`). Threads dispatch-specific defaults:
 * sovereignty posture, source-string assembly, and the
 * `correlation_id ?? taskId` invariant that all four lifecycle events
 * for a single task share one correlation key.
 *
 * The shared helper handles the `id`/`timestamp`/`payload`/`sovereignty`
 * skeleton; this thin wrapper exists so each dispatch-task constructor
 * doesn't have to repeat the source-build + sovereignty + correlation-
 * fallback boilerplate.
 */
function buildBaseEnvelope(
  type: string,
  common: DispatchTaskCommonOpts,
  payloadExtras: Record<string, unknown>,
): Envelope {
  return buildSharedEnvelope({
    type,
    source: buildSource(common.source),
    sovereignty: defaultDispatchSovereignty(common.source, common.classification),
    correlationId: common.correlationId ?? common.taskId,
    payload: {
      task_id: common.taskId,
      agent_id: common.agentId,
      ...payloadExtras,
    },
  });
}

// ---------------------------------------------------------------------------
// dispatch.task.started
// ---------------------------------------------------------------------------

export interface DispatchTaskStartedOpts extends DispatchTaskCommonOpts {
  /**
   * Lifecycle moment when the runner began executing the task. Distinct
   * from `envelope.timestamp` (which is emit time) so a delay between
   * "task accepted" and "started_at" is observable downstream.
   */
  startedAt: Date;
}

/**
 * Construct a `dispatch.task.started` envelope per G-1111 §3.4.
 *
 * Emitted once when the runner begins executing a task — typically right
 * after spawning the CC session. Pairs with one of `completed`, `failed`,
 * or `aborted` via the shared `correlation_id`.
 */
export function createDispatchTaskStartedEvent(
  opts: DispatchTaskStartedOpts,
): Envelope {
  return buildBaseEnvelope("dispatch.task.started", opts, {
    started_at: opts.startedAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// dispatch.task.completed
// ---------------------------------------------------------------------------

export interface DispatchTaskCompletedOpts extends DispatchTaskCommonOpts {
  /** When the runner began executing — copied from the matching `started` event. */
  startedAt: Date;
  /** When the task finished successfully. */
  completedAt: Date;
  /**
   * Optional human-readable summary of the result (truncated to a
   * reasonable length — surfaces typically render the first line).
   */
  resultSummary?: string;
}

/**
 * Construct a `dispatch.task.completed` envelope per G-1111 §3.4.
 *
 * Terminal success event. Carries both `started_at` and `completed_at`
 * so surfaces can render duration without joining to the `started` event;
 * matches the §3.4 "see F-19/F-20 docs" pointer that argues for self-
 * contained terminal events to keep dashboards stateless.
 */
export function createDispatchTaskCompletedEvent(
  opts: DispatchTaskCompletedOpts,
): Envelope {
  return buildBaseEnvelope("dispatch.task.completed", opts, {
    started_at: opts.startedAt.toISOString(),
    completed_at: opts.completedAt.toISOString(),
    ...(opts.resultSummary !== undefined && {
      result_summary: opts.resultSummary,
    }),
  });
}

// ---------------------------------------------------------------------------
// dispatch.task.failed
// ---------------------------------------------------------------------------

export interface DispatchTaskFailedOpts extends DispatchTaskCommonOpts {
  startedAt: Date;
  /** When the task failed (analogous to `completed_at` on the success path). */
  failedAt: Date;
  /**
   * Short, human-readable error summary. Truncated/sanitized by the caller
   * (surfaces render this as-is). Distinct from `aborted.reason` because
   * "failed" implies the task ran under its own power and produced an
   * error; "aborted" implies an outside force terminated it.
   */
  errorSummary: string;
}

/**
 * Construct a `dispatch.task.failed` envelope per G-1111 §3.4.
 *
 * Terminal failure event for tasks that ran to completion under their own
 * power but produced an error (CC exited non-zero, parsing failed, etc.).
 * Distinct from `aborted` — see `DispatchTaskAbortedOpts` doc.
 */
export function createDispatchTaskFailedEvent(
  opts: DispatchTaskFailedOpts,
): Envelope {
  return buildBaseEnvelope("dispatch.task.failed", opts, {
    started_at: opts.startedAt.toISOString(),
    failed_at: opts.failedAt.toISOString(),
    error_summary: opts.errorSummary,
  });
}

// ---------------------------------------------------------------------------
// dispatch.task.aborted
// ---------------------------------------------------------------------------

export interface DispatchTaskAbortedOpts extends DispatchTaskCommonOpts {
  startedAt: Date;
  /** When the task was aborted. */
  abortedAt: Date;
  /**
   * Why the task was aborted. Free-form but conventional values include
   * `"timeout"`, `"shutdown"`, `"operator-cancel"`, `"replaced"`. Surfaces
   * may render verbatim.
   */
  reason: string;
}

/**
 * Construct a `dispatch.task.aborted` envelope.
 *
 * Per the file-header note on §3.4: the spec's summary table doesn't
 * enumerate `aborted` separately, but the runtime distinction between
 * "task errored" (`failed`) and "task killed from outside" (`aborted`)
 * is load-bearing for the worklog surface. Add as a non-breaking sibling
 * per §3.1's append-only rule.
 */
export function createDispatchTaskAbortedEvent(
  opts: DispatchTaskAbortedOpts,
): Envelope {
  return buildBaseEnvelope("dispatch.task.aborted", opts, {
    started_at: opts.startedAt.toISOString(),
    aborted_at: opts.abortedAt.toISOString(),
    reason: opts.reason,
  });
}
