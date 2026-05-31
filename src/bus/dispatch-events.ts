/**
 * MIG-4.6 — `dispatch.task.*` envelope constructors.
 *
 * Per G-1111 §3.4 the `dispatch.task` domain captures the lifecycle of a
 * task that a principal (or a sibling agent) dispatched to a runner-style
 * agent: `dispatched`, `accepted`, `rejected`, `started`, `completed`,
 * `failed`. This file ships the four lifecycle helpers cortex's runner
 * needs end-to-end (`started`, `completed`, `failed`, `aborted`).
 *
 * Note on §3.4 vs §6: the spec's §3.4 summary table omits `aborted`
 * (only lists `failed`) but the natural runtime distinction between
 * "the task failed under its own power" and "the task was killed by an
 * outside force (timeout, principal cancel, shutdown)" is load-bearing
 * for surfaces — a worklog rendering "aborted: timeout" reads very
 * differently from "failed: assertion error". We therefore add
 * `aborted` as a non-breaking sibling to `failed` per §3.1's
 * append-only rule, with a payload shape that distinguishes the two.
 *
 * **Shape contract** (mirrors `system-events.ts`):
 *   - `id` is a fresh `crypto.randomUUID()` per call (envelope idempotency key).
 *   - `timestamp` is the helper-call time. Lifecycle moments distinct from
 *     emit time (`started_at`, `completed_at`, etc.) live in payload.
 *   - `source` is the dotted `{principal}.{agent}.{instance}` per the schema.
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

/**
 * cortex#491 — **Response routing** (CONTEXT.md §Response-routing).
 *
 * The originating-surface address carried on an inbound dispatch envelope's
 * payload (`response_routing`) and ECHOED by the runner onto every
 * `dispatch.task.{action}` lifecycle envelope. A **dispatch sink** (the
 * platform adapter's outbound side) reads it off the lifecycle envelope to
 * deliver the reply to the right channel/thread WITHOUT keeping any inbound
 * state — the routing is wire-level, not in-memory.
 *
 * For a Discord/Mattermost/Slack-sourced dispatch the address is
 * `{ adapter_instance, channel_id, thread_id? }` — structurally the same
 * triple a `ResponseTarget` carries (`{ instanceId, channelId, threadId? }`),
 * but in the snake_case wire idiom the rest of the envelope payload uses.
 *
 * Future dispatch sources (MC dashboard "send task", taps) populate the
 * same shape; sinks that don't recognise the `adapter_instance` ignore the
 * envelope (see the dispatch-sink consumer in `src/adapters/dispatch-sink.ts`).
 *
 * This is the **chat-path / snowflake** shape (cortex#498). The review path
 * (cortex#502) uses the sibling {@link LogicalResponseRouting} shape — a
 * platform-NEUTRAL logical address (`{ surface, channel, thread? }`) where
 * `channel` is a repo short name and `thread` is the
 * `{repo-short}/{entity-type}/{number}` logical entity key per the
 * channel-routing SOP. Both shapes ride `payload.response_routing`; both are
 * passed verbatim by the dispatch builders (no builder-body change — the
 * field just widens to the union {@link AnyResponseRouting}). The review sink
 * resolves the logical address to a native target via
 * `PlatformAdapter.resolveLogicalTarget`; the chat dispatch sink reads the
 * snowflake triple directly.
 */
export interface ResponseRouting {
  /** Adapter instance id that sourced the dispatch (e.g. `discord-pai-collab`). */
  adapter_instance: string;
  /** Platform-native channel id to deliver the reply to. */
  channel_id: string;
  /** Thread id when the dispatch arrived in a thread/DM; omitted at channel scope. */
  thread_id?: string;
}

/**
 * cortex#502 — **Logical response routing** (the review-path shape).
 *
 * A platform-NEUTRAL surface address echoed onto the review lifecycle
 * (`dispatch.task.*`) AND verdict (`review.verdict.*`) envelopes. Unlike the
 * chat-path {@link ResponseRouting} (Discord snowflakes), this carries
 * LOGICAL names so the same envelope routes on Discord/Mattermost/Slack
 * unchanged — each adapter maps logical→native at the sink via
 * `PlatformAdapter.resolveLogicalTarget`.
 *
 * - `surface` — platform identity (`"discord"` | `"mattermost"` | `"slack"`).
 *   The review sink filters to envelopes whose surface matches an adapter it
 *   drives; a surface it doesn't drive is ignored (no cross-surface posting),
 *   mirroring the chat sink's `adapter_instance` filter. There is deliberately
 *   NO `adapter_instance` on the review wire — the sink resolves by surface +
 *   channel name (the SOP guarantees one logical channel per repo).
 * - `channel` — LOGICAL channel slug = repo short name (e.g. `"cortex"`).
 *   Repo→channel per the channel-routing SOP.
 * - `thread` — LOGICAL entity address `{repo-short}/{entity-type}/{number}`
 *   (e.g. `"cortex/pr/57"`). Entity→thread per the SOP. Omitted = channel-scope.
 */
export interface LogicalResponseRouting {
  /** Platform identity, e.g. `"discord"` | `"mattermost"` | `"slack"`. */
  surface: string;
  /** Logical channel slug — repo short name (e.g. `"cortex"`). */
  channel: string;
  /** Logical entity address `{repo-short}/{entity-type}/{number}`; omitted = channel-scope. */
  thread?: string;
}

/**
 * The union the dispatch builders accept for `responseRouting` and stamp
 * verbatim onto `payload.response_routing`. Chat (cortex#498) uses the
 * snowflake {@link ResponseRouting}; review (cortex#502) uses the logical
 * {@link LogicalResponseRouting}. The builders never inspect or transform the
 * value — the type widening alone admits both producers.
 */
export type AnyResponseRouting = ResponseRouting | LogicalResponseRouting;

function buildSource(src: SystemEventSource): string {
  return `${src.principal}.${src.agent}.${src.instance}`;
}

/**
 * Default sovereignty for `dispatch.task.*` events. Same posture as
 * `system.*`: principal-only by default, local residency, no frontier.
 *
 * `data_residency` is sourced from `source.dataResidency` (defaulting to
 * `"NZ"` for the original cortex deployment) so a non-NZ principal gets
 * envelopes stamped with their actual residency. Mirrors the parameterisation
 * pattern in `system-events.ts` so both event domains read the same field
 * off the same source struct.
 *
 * **IAW Phase A.3:** `classification` is now an optional parameter
 * (defaulting to `"local"` for back-compat). Callers may opt into
 * `"federated"` or `"public"` when dispatch lifecycle events need to cross
 * principal boundaries (e.g. a federated multi-org dispatch). The default
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
   * `source` is `{principal}.{assistant}.{instance}` and we want a flat
   * agent label for filters/projection.
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
   * `"local"` (principal-private). Set to `"federated"` when a dispatch
   * lifecycle event needs to reach peer principals (e.g. a multi-org task
   * pipeline whose progress should surface on federated dashboards);
   * `"public"` for global visibility. Mismatch with the publish-time
   * subject is a protocol violation (see
   * {@link validateSubjectEnvelopeAlignment}).
   */
  classification?: Classification;
  /**
   * cortex#491 — **Response routing** echoed from the inbound dispatch
   * envelope onto this lifecycle envelope. When supplied, surfaces as
   * `payload.response_routing` so the originating **dispatch sink** can
   * target the reply without keeping inbound state. Omitted (no field on
   * the wire) for lifecycle events that have no originating surface
   * address — e.g. a bus-peer or Offer dispatch whose source did not
   * carry response routing.
   *
   * cortex#502 — the type is the union {@link AnyResponseRouting}: the
   * chat path stamps the snowflake {@link ResponseRouting} shape, the
   * review path stamps the logical {@link LogicalResponseRouting} shape.
   * The builder passes whatever it receives through verbatim.
   */
  responseRouting?: AnyResponseRouting;
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
      // cortex#491 — echo response routing when the inbound dispatch
      // carried it, so the originating dispatch sink can find its target.
      ...(common.responseRouting !== undefined && {
        response_routing: common.responseRouting,
      }),
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
  /**
   * cortex#491 — the FULL, untruncated assistant reply for chat-style
   * dispatches. `result_summary` is the first line capped at 1000 chars
   * (a dashboard label); `chat_response` is the complete text a
   * **dispatch sink** posts back to the originating channel via
   * `adapter.postResponse`. Omitted for non-chat dispatches (the sink
   * falls back to `result_summary`). Carries the same sovereignty as the
   * envelope — `local` for local chat — so the full reply on the wire
   * respects the dispatch's classification.
   */
  chatResponse?: string;
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
    // cortex#491 — full reply for the chat round-trip (dispatch sink → postResponse).
    ...(opts.chatResponse !== undefined && {
      chat_response: opts.chatResponse,
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
  /**
   * IAW Phase C.3.1 — structured machine-readable reason for failures
   * that come from upstream of the substrate (Echo cortex#220 round 2
   * M-1). Today the only producer is the dispatch-listener's policy
   * gate, which sets `kind: "policy_denied"` with a copy of the
   * engine's `PolicyDenyReason`. Subscribers correlating on task_id
   * (worklog-manager, agent-team) can branch on `payload.reason.kind`
   * to render the gate decision distinctly from substrate-side errors.
   *
   * Surfaces as `payload.reason` on the envelope (snake_case is
   * already in the wire idiom; the field shape is the discriminated
   * union below).
   *
   * Future kinds (added as new gates appear, no schema flip needed):
   *   - `substrate_unavailable` — runner couldn't construct a harness.
   *   - `validator_rejected`    — envelope validator failed late.
   *
   * Append-only per G-1111 §3.1.
   */
  reason?: DispatchTaskFailedReason;
}

/**
 * Discriminated reason for `dispatch.task.failed` envelopes synthesised
 * from upstream-of-the-substrate failure modes. C.3.1 shipped
 * `policy_denied`; IAW Wave 0 PR-A.0a (refs cortex#232, cortex#238)
 * extends the union with the four-way nak taxonomy named in
 * `docs/architecture.md` §7.3 and surfaced to pilot per
 * `docs/design-pilot-restructure.md` §4.4. New kinds are append-only
 * siblings per G-1111 §3.1.
 *
 * The discriminator `kind` enumerates five values today:
 *
 *   - `policy_denied`     — dispatch-listener's policy gate refused (carries
 *                           the engine's structured `deny` reason verbatim).
 *   - `cant_do`           — no agent matches the requested capability
 *                           (capability mismatch; persistent until a
 *                           consumer registers).
 *   - `wont_do`           — sovereignty policy refused (agent could but
 *                           policy says no; persistent — principal action
 *                           needed).
 *   - `not_now`           — backpressure (capability is registered, just
 *                           busy; transient, retry safe). Optional
 *                           `retry_after_ms` hints at a backpressure
 *                           window.
 *   - `compliance_block`  — agent's compliance attestation forbids it
 *                           (e.g. STD-NPW-AI-001 gate).
 *
 * Subscribers correlating on task_id (worklog-manager, agent-team, and the
 * planned pilot-side `subscribe-verdict.ts` per `design-pilot-restructure.md`
 * §5) branch on `payload.reason.kind` to render the gate / nak decision
 * distinctly from substrate-side errors. Surfaces as `payload.reason` on
 * the envelope.
 *
 * Anchors: `docs/architecture.md` §7.3 (nak vocabulary, canonical),
 * `docs/design-pilot-restructure.md` §4.4 + §6.2 PR-A.0a (pilot-side
 * consumption + this PR's scope), `docs/design-pi-dev-review-agent.md`
 * §4 (envelope grammar).
 */
export type DispatchTaskFailedReason =
  | {
      kind: "policy_denied";
      /**
       * The engine's structured deny reason, carried verbatim so
       * subscribers can render the specific deny path
       * (`unknown_principal` / `insufficient_role` / ...).
       */
      deny: Record<string, unknown>;
    }
  | {
      kind: "cant_do";
      /** Human-readable explanation (free-form). */
      detail: string;
    }
  | {
      kind: "wont_do";
      /** Human-readable explanation (free-form). */
      detail: string;
    }
  | {
      kind: "not_now";
      /** Human-readable explanation (free-form). */
      detail: string;
      /**
       * Optional backpressure hint: producer may suggest a retry window
       * in milliseconds. Principal-facing; pilot's CLI translates to its
       * own retry semantics (exit 4 = transient, retry safe).
       */
      retry_after_ms?: number;
    }
  | {
      kind: "compliance_block";
      /** Human-readable explanation (free-form). */
      detail: string;
    };

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
    ...(opts.reason !== undefined && { reason: opts.reason }),
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
   * `"timeout"`, `"shutdown"`, `"principal-cancel"`, `"replaced"`. Surfaces
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
