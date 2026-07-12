/**
 * MIG-3b-ii: `system.*` envelope constructors.
 *
 * Per G-1111 §3.5, the `system.*` operational domain answers "what is grove
 * itself doing right now?" — adapter health, inbound dispatch lifecycle,
 * subscription state, buffer pressure, process lifecycle. The 2026-05-09
 * outage is the canonical motivating incident: with N Discord adapters in
 * one process, `console.log("shard 0 reconnecting")` was ambiguous, so the
 * degraded state went unnoticed for 8.4 hours.
 *
 * These helpers exist so callers (the Discord adapter, MessageRouter, the
 * MyelinRuntime, cortex main) construct envelopes from a single audited
 * source. Field names and enums match the §3.5.4 schemas verbatim — adding a
 * field requires updating both the spec and these helpers in the same PR.
 *
 * **Shape contract:**
 *   - `id` is a fresh `crypto.randomUUID()` per call (envelope-level idempotency key).
 *   - `timestamp` is the helper-call time (ISO 8601). Callers should not back-fill
 *     this — if you need an event-of-fact timestamp distinct from emit time
 *     (e.g. `disconnected_since`), it lives in the payload.
 *   - `source` is the dotted `{principal}.{agent}.{instance}` form required by the
 *     myelin envelope schema (G-1100.B) — e.g. `metafactory.grove.local`.
 *     The helpers take the three segments separately so callers don't string-
 *     concatenate by hand. This matches the spec §3.6 example envelopes.
 *     (The DID-style form `did:web:...` from the original task brief does
 *     not validate against the schema's `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,4}$`
 *     pattern; the dotted form is the schema-compatible carrier.)
 *   - `sovereignty` defaults to `local-only / NZ / max_hop=0 / frontier_ok=false / model_class=local-only`
 *     because `system.*` events expose internal failure modes (adapter IDs,
 *     buffer caps, error class names). They're principal-only — no federation,
 *     no frontier-model processing.
 *
 * **Known spec gap — correlation_id format:**
 *   The G-1111 §3.5.6 convention defines correlation_id strings like
 *   `"adapter:{adapter_id}:{disconnected_since_iso}"`, but the vendored myelin
 *   envelope schema (G-1100.B) constrains `correlation_id` to UUID format —
 *   non-UUID values fail validation downstream. For MIG-3b-ii we therefore
 *   OMIT `correlation_id` from `system.*` envelopes; surfaces join the pair
 *   on `(payload.adapter_id, payload.disconnected_since)` instead, which is
 *   already the natural workflow key in §3.5.6's text.
 *
 *   The `adapterCorrelationKey` helper below exposes the convention string
 *   for callers that want to log/index it locally; it's not assigned to
 *   `envelope.correlation_id` until the schema accepts non-UUID values
 *   (tracked: spec/schema reconciliation, separate iteration).
 *
 * Anti-pattern note (§4.6.2): a degraded adapter cannot reliably publish its
 * OWN `degraded` event — long-term ownership for `system.adapter.*` belongs
 * to a sibling `connection-watcher` component. For MIG-3b-ii (this slice),
 * the adapter publishes directly so the wiring exists end-to-end; the
 * connection-watcher refactor is a follow-on iteration.
 */

import type { Classification, Envelope } from "./myelin/envelope-validator";
import { buildBaseEnvelope } from "./envelope-builder";
import type { AgentHeartbeatPayload } from "../common/types/agent-heartbeat";
import { AGENT_HEARTBEAT_TYPE } from "../common/types/agent-heartbeat";
import { isUuid } from "../common/types/uuid";

/**
 * Source identifier used by every `system.*` event. Three dotted segments
 * matching the schema's `{principal}.{assistant}.{instance}` form (R4
 * vocabulary migration; myelin#185 tightened this to exactly 3 segments).
 * Kept as a struct in the helper-options shape so callers don't
 * string-concatenate by hand.
 *
 * Examples (from spec §3.6):
 *   - `metafactory.pilot.local`
 *   - `metafactory.grove.dashboard`
 *   - For cortex-emitted system.* events: `{principal}.cortex.local`
 */
export interface SystemEventSource {
  /** Boot-resolved `principal.id` — first segment (principal slug). */
  principal: string;
  /** Logical agent name — `cortex`, `grove`, `pilot`, etc. */
  agent: string;
  /** Stable instance name — usually `local` for in-process emission. */
  instance: string;
  /**
   * Principal residency code stamped into `envelope.sovereignty.data_residency`.
   * Defaults to `"NZ"` when omitted — matches the original cortex deployment.
   * Principals in other jurisdictions (AU, EU, US) pass their own ISO-3166-style
   * code so envelopes accurately reflect data residency for compliance audits.
   * The field is only used when constructing the default sovereignty object;
   * callers that override `sovereignty` directly bypass it entirely.
   */
  dataResidency?: string;
}

/**
 * Single owner of the `{principal}.{agent}.{instance}` envelope-source
 * grammar (myelin#185's 3-segment form). Every `system.*`/`github.*`/
 * `dev.*`/`review.*`/`dispatch.*`/`agents.*` emitter shares this one
 * function rather than re-deriving the string locally (cortex#1515 S1).
 *
 * The parameter is structural rather than `SystemEventSource` so
 * domain-specific source shapes (e.g. `CapabilityRegistrySource`) can
 * pass their value through without importing or extending
 * `SystemEventSource` itself — same output, no type coupling.
 */
export function buildSource(src: {
  principal: string;
  agent: string;
  instance: string;
}): string {
  return `${src.principal}.${src.agent}.${src.instance}`;
}

/**
 * Default sovereignty for `system.*` events. Expressed as a function so
 * callers receive a fresh object literal (no aliasing risk if a caller
 * mutates the returned envelope's `sovereignty`).
 *
 * `system.*` events expose internal grove state — principal-only by default,
 * never sent to frontier models. The `data_residency` field is sourced from
 * `source.dataResidency` (defaulting to `"NZ"`) so a non-NZ principal gets
 * envelopes stamped with their actual residency without having to override
 * the entire sovereignty object at every call site.
 *
 * **IAW Phase A.3:** `classification` is now an optional parameter
 * (defaulting to `"local"` for back-compat). Callers may opt into
 * `"federated"` or `"public"` when a principal-side decision determines the
 * envelope's reach. The default keeps every existing call site behaving
 * identically.
 */
export function defaultSystemSovereignty(
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

/**
 * Platforms that emit adapter lifecycle events. Subset of the §3.5.4 enum —
 * `pagerduty` / `webhook` / `nats` are valid platforms for `system.*` events
 * but those publishers don't live in cortex's adapter layer; they'll be added
 * here when their owners wire `system.adapter.*` emission.
 */
export type SystemAdapterPlatform = "discord" | "mattermost" | "slack";

/**
 * Build the `correlation_id` string from §3.5.6: `adapter:{adapter_id}:{iso}`.
 *
 * Returned but NOT assigned to `envelope.correlation_id` — see the file-level
 * "Known spec gap" note. Callers can log this string for local correlation
 * (e.g. structured-log lines tying degraded → recovered) until the schema
 * accepts non-UUID correlation_ids.
 */
export function adapterCorrelationKey(
  adapterId: string,
  disconnectedSince: Date,
): string {
  return `adapter:${adapterId}:${disconnectedSince.toISOString()}`;
}

// ---------------------------------------------------------------------------
// system.adapter.degraded
// ---------------------------------------------------------------------------

export interface SystemAdapterDegradedOpts {
  /** Envelope source — `{principal}.{agent}.{instance}` per schema. */
  source: SystemEventSource;
  /** Stable adapter instance ID, e.g. `discord-luna`. Mandatory per §3.5.4. */
  adapterId: string;
  platform: SystemAdapterPlatform;
  /** When the disconnect that led to this degraded period started. */
  disconnectedSince: Date;
  /** Threshold the disconnect crossed (ms). */
  thresholdMs: number;
  /** Most recent successful `connected` event timestamp. Optional. */
  lastConnected?: Date;
  /** How many backoff cycles fired since the disconnect. Optional. */
  reconnectAttempts?: number;
  /** Platform-specific shard/connection identifier. Optional. */
  shardId?: number;
  /**
   * IAW Phase A.3 — optional sovereignty classification. Defaults to
   * `"local"` (principal-private). Set to `"federated"` to publish on
   * `federated.{principal}.system.adapter.degraded` so peer dashboards in the
   * principal's federation policy can render the event; `"public"` for
   * global visibility. Mismatch with the publish-time subject is a
   * protocol violation (see {@link validateSubjectEnvelopeAlignment}).
   */
  classification?: Classification;
}

/**
 * Construct a `system.adapter.degraded` envelope per G-1111 §3.5.4.
 *
 * Emitted once when an adapter has been disconnected long enough to cross
 * the principal-configured threshold (default 60 s). Mandatory paging event
 * for any `system.*` subscriber that includes the `paging` platform class.
 */
export function createSystemAdapterDegradedEvent(
  opts: SystemAdapterDegradedOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.adapter.degraded",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    payload: {
      adapter_id: opts.adapterId,
      platform: opts.platform,
      disconnected_since: opts.disconnectedSince.toISOString(),
      threshold_ms: opts.thresholdMs,
      ...(opts.lastConnected !== undefined && {
        last_connected: opts.lastConnected.toISOString(),
      }),
      ...(opts.reconnectAttempts !== undefined && {
        reconnect_attempts: opts.reconnectAttempts,
      }),
      ...(opts.shardId !== undefined && { shard_id: opts.shardId }),
    },
  });
}

// ---------------------------------------------------------------------------
// system.adapter.recovered
// ---------------------------------------------------------------------------

export interface SystemAdapterRecoveredOpts {
  source: SystemEventSource;
  adapterId: string;
  platform: SystemAdapterPlatform;
  /** Total degraded duration (ms). Used by surfaces to render incident length. */
  degradedForMs: number;
  /**
   * The `disconnected_since` from the paired `degraded` event. Surfaces use
   * this in `payload` to join the recovered event back to its degraded twin
   * (since correlation_id can't carry the convention key — see file header).
   * Optional: the helper accepts callers that don't know the original
   * disconnect timestamp, but pairing degrades to "best-effort" without it.
   */
  disconnectedSince?: Date;
  /** How many attempts before recovery. Optional. */
  reconnectAttempts?: number;
  /**
   * IAW Phase A.3 — optional sovereignty classification. Defaults to
   * `"local"`. See `SystemAdapterDegradedOpts.classification` for the full
   * doc.
   */
  classification?: Classification;
}

/**
 * Construct a `system.adapter.recovered` envelope per G-1111 §3.5.4.
 *
 * Pairs with the `degraded` event of the same `(adapter_id, disconnected_since)`
 * tuple. Surfaces use the pair to render incident length without parsing
 * traces.
 */
export function createSystemAdapterRecoveredEvent(
  opts: SystemAdapterRecoveredOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.adapter.recovered",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    payload: {
      adapter_id: opts.adapterId,
      platform: opts.platform,
      degraded_for_ms: opts.degradedForMs,
      ...(opts.disconnectedSince !== undefined && {
        disconnected_since: opts.disconnectedSince.toISOString(),
      }),
      ...(opts.reconnectAttempts !== undefined && {
        reconnect_attempts: opts.reconnectAttempts,
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// system.adapter.disconnected
// ---------------------------------------------------------------------------

export interface SystemAdapterDisconnectedOpts {
  source: SystemEventSource;
  adapterId: string;
  platform: SystemAdapterPlatform;
  /** When the disconnect occurred. Carried in payload for pair joining. */
  disconnectedSince: Date;
  /** Platform-specific shard/connection identifier. Optional. */
  shardId?: number;
  /** WebSocket close code (Discord) or equivalent. Optional. */
  closeCode?: number;
  /** Human-readable close reason. Optional. */
  closeReason?: string;
  /** True if this was a clean shutdown (vs unexpected drop). */
  wasClean: boolean;
  /**
   * IAW Phase A.3 — optional sovereignty classification. Defaults to
   * `"local"`. See `SystemAdapterDegradedOpts.classification` for the full
   * doc.
   */
  classification?: Classification;
}

/**
 * Construct a `system.adapter.disconnected` envelope per G-1111 §3.5.3.
 *
 * Emitted on every shard disconnect — including transient flaps that recover
 * within the degraded threshold. Surfaces filter on `was_clean` to separate
 * routine reconnects from genuine outages.
 */
export function createSystemAdapterDisconnectedEvent(
  opts: SystemAdapterDisconnectedOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.adapter.disconnected",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    payload: {
      adapter_id: opts.adapterId,
      platform: opts.platform,
      disconnected_since: opts.disconnectedSince.toISOString(),
      was_clean: opts.wasClean,
      ...(opts.shardId !== undefined && { shard_id: opts.shardId }),
      ...(opts.closeCode !== undefined && { close_code: opts.closeCode }),
      ...(opts.closeReason !== undefined && { close_reason: opts.closeReason }),
    },
  });
}

// ---------------------------------------------------------------------------
// system.inbound.aborted
// ---------------------------------------------------------------------------

/**
 * Mirrors `TimeoutSource` from `src/common/timeout.ts` — the schema-aligned
 * vocabulary for "which timeout fired". Re-exported here so adapter callers
 * have one import for system-event helpers.
 */
export type SystemInboundAbortedTimeoutSource =
  | "attachment_fetch"
  | "cloud_publisher"
  | "usage_monitor"
  | "usage_fetcher"
  | "startup_sync"
  | "cc_session_spawn"
  | "unknown";

export type SystemInboundAbortedPhase =
  | "pre_dispatch"
  | "cc_session"
  | "post_response";

export interface SystemInboundAbortedOpts {
  source: SystemEventSource;
  adapterId: string;
  /** Platform-native message ID (Discord message ID, etc.). */
  inboundMessageId: string;
  /**
   * Workflow correlation_id if one is already established (UUID format,
   * since the envelope schema constrains correlation_id to UUID). When not
   * provided, the field is omitted entirely — the spec's §3.5.6 convention
   * of using inbound_message_id as correlation_id can't apply since Discord
   * snowflake IDs aren't UUIDs.
   */
  correlationId?: string;
  /** Which named timeout fired. Mandatory — addresses the lost-stack gap. */
  timeoutSource: SystemInboundAbortedTimeoutSource;
  /** The timeout that fired (ms). */
  timeoutMs: number;
  /** Wall time from dispatch start to abort (ms). */
  elapsedMs: number;
  phase: SystemInboundAbortedPhase;
  /**
   * IAW Phase A.3 — optional sovereignty classification. Defaults to
   * `"local"`. See `SystemAdapterDegradedOpts.classification` for the full
   * doc.
   */
  classification?: Classification;
}

/**
 * Construct a `system.inbound.aborted` envelope per G-1111 §3.5.4.
 *
 * Replaces the bare `AbortError` log of the 2026-05-09 incident with a
 * structured envelope carrying the `timeout_source` enum, so a principal
 * triaging an incident can see *which* timeout fired without parsing
 * launchd logs.
 *
 * Note: spec §3.5 renames this from the older `system.dispatch.aborted` —
 * "dispatch" is now reserved for the `dispatch` *domain* (principal-dispatching-
 * work-to-agents). The migration plan still references the old name; this
 * helper uses the spec name and the old name should be considered an alias
 * in any plan-doc updates.
 */
export function createSystemInboundAbortedEvent(
  opts: SystemInboundAbortedOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.inbound.aborted",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    ...(opts.correlationId !== undefined && { correlationId: opts.correlationId }),
    payload: {
      adapter_id: opts.adapterId,
      inbound_message_id: opts.inboundMessageId,
      timeout_source: opts.timeoutSource,
      timeout_ms: opts.timeoutMs,
      elapsed_ms: opts.elapsedMs,
      phase: opts.phase,
    },
  });
}

// ---------------------------------------------------------------------------
// system.access.filtered — IAW Phase A.4 (cortex#113, cortex#109 §B)
// ---------------------------------------------------------------------------

/**
 * Why a `system.access.filtered` envelope was emitted. Mirrors the three
 * `RendererVisibility` axes — each enum value corresponds to a single
 * visibility rule that produced the drop. Surfaces can subscribe and
 * project the access-decision stream without parsing free-form text.
 *
 * IAW Phase A.4 ties this into the cortex#97 error-surfacing pattern — a
 * dropped envelope is an observable event, not a silent black hole. Phase
 * B may extend the enum with trust-decision reasons (signed_by failures,
 * unknown principals) once cortex#102 lands.
 */
export type SystemAccessFilteredReason =
  | "residency_blocked"
  | "model_class_blocked"
  | "classification_exceeds_max";

export interface SystemAccessFilteredOpts {
  source: SystemEventSource;
  /** Renderer/adapter id that dropped the envelope (e.g. `dashboard`). */
  rendererId: string;
  /** NATS subject of the dropped envelope — principals correlate by this. */
  envelopeSubject: string;
  /** Specific rule that fired. See {@link SystemAccessFilteredReason}. */
  reason: SystemAccessFilteredReason;
  /**
   * Optional sovereignty classification of THIS event (the `filtered`
   * notification itself, not the envelope it describes). Defaults to
   * `"local"` — access decisions are principal-internal. Mirror of the
   * Phase A.3 `classification` parameter on the rest of the system.*
   * helpers.
   */
  classification?: Classification;
}

/**
 * Construct a `system.access.filtered` envelope.
 *
 * The surface-router emits this once per `(renderer, envelope, reason)`
 * tuple when a renderer's `visibility:` config drops an inbound envelope.
 * It's a side-channel for principals who want to audit/debug "why didn't I
 * see this envelope on my dashboard?" without instrumenting every renderer.
 *
 * Per IAW Phase A.4 the emit is direct — `runtime.publish()` straight from
 * the router with no central error-surfacing helper. Phase B / cortex#97
 * may consolidate the emit pattern once the helper exists; until then this
 * is the single emit site for visibility-drop events.
 */
export function createSystemAccessFilteredEvent(
  opts: SystemAccessFilteredOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.access.filtered",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    payload: {
      renderer_id: opts.rendererId,
      envelope_subject: opts.envelopeSubject,
      reason: opts.reason,
    },
  });
}

// ---------------------------------------------------------------------------
// system.bus.peer_dispatch_received — IAW Phase B.2a visibility event
// ---------------------------------------------------------------------------

export interface SystemBusPeerDispatchReceivedOpts {
  /** Standard source attribution — who emitted this visibility event. */
  source: SystemEventSource;
  /**
   * Which local agent's `BusDispatchListener` produced this event.
   * Multi-agent stacks may run one listener per agent (the JSDoc on
   * `BusDispatchListener.receivingAgentId` explicitly contemplates
   * `peer-router` agents and per-agent listeners). Without this
   * field, a dashboard subscribed to `system.bus.peer_dispatch_received`
   * can't answer "who in our stack received this" (Echo cortex#203
   * round 1).
   */
  receivingAgentId: string;
  /**
   * Source field from the peer's dispatch envelope (the `{principal}.
   * {agent}.{instance}` triple that identifies which peer just
   * dispatched a task to us). Different from `opts.source.principal` —
   * that's US, this is THEM.
   */
  peerSource: string;
  /**
   * Envelope id of the peer's dispatch envelope. Lets principals join
   * the visibility event to the underlying dispatch on the dashboard
   * and in audit pipelines.
   */
  dispatchEnvelopeId: string;
  /**
   * Correlation id from the peer's dispatch envelope, if present.
   * Threads the visibility event to any reply chain that follows.
   */
  correlationId?: string;
  /** Wall-clock time the listener observed the inbound. */
  receivedAt: Date;
  /**
   * IAW Phase A.3 — classification on the emitted visibility event.
   * Defaults to `"local"` because peer-dispatch-received is bookkeeping
   * about our own stack; the underlying peer dispatch may itself be
   * federated, but the visibility annotation stays local-only.
   */
  classification?: Classification;
}

/**
 * IAW Phase B.2a (cortex#114) — visibility event emitted whenever
 * `BusDispatchListener` receives a valid peer dispatch envelope on the
 * bus. Surfaces "peer X dispatched a task to us at <time>" without
 * routing through the dispatch path itself (that's a follow-up; see
 * `BusDispatchListener` file header for the deferred-scope rationale).
 *
 * Sovereignty defaults to local; the visibility event is bookkeeping
 * about our own stack regardless of the underlying peer dispatch's
 * classification.
 */
export function createSystemBusPeerDispatchReceivedEvent(
  opts: SystemBusPeerDispatchReceivedOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.bus.peer_dispatch_received",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    payload: {
      receiving_agent_id: opts.receivingAgentId,
      peer_source: opts.peerSource,
      dispatch_envelope_id: opts.dispatchEnvelopeId,
      received_at: opts.receivedAt.toISOString(),
      ...(opts.correlationId !== undefined && {
        correlation_id: opts.correlationId,
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// system.bus.reflex_activation_dispatched / _failed — F-6 visibility events
// ---------------------------------------------------------------------------

interface SystemBusReflexActivationDispatchedBase {
  /** Standard source attribution — who emitted this visibility event. */
  source: SystemEventSource;
  /**
   * Reflex Decision id from the fired event — the stable identifier the
   * bridge dedups on. Threads the visibility event back to the reflex
   * Decision that produced the activation.
   */
  decisionId: string;
  /** Original reflex target (Execution Blueprint ref, e.g. `@jc/notify-discord`). */
  target: string;
  /** Capability the bridge resolved the target to. */
  capability: string;
  /** Correlation id carried from the fired event. */
  correlationId?: string;
  /**
   * Classification preserved from the fired event onto the visibility
   * annotation (sovereignty). Defaults to `"local"`.
   */
  classification?: Classification;
}

/**
 * Discriminated on `via`: the CC path (`dispatch`) re-emits a `tasks.*`
 * envelope and so carries the assistant DID + dispatch subject + envelope id;
 * the code-handler path (`handler`) invokes in-process and has none of those.
 */
export type SystemBusReflexActivationDispatchedOpts =
  | (SystemBusReflexActivationDispatchedBase & {
      via: "dispatch";
      /** Assistant DID the dispatch was addressed to. */
      targetAssistant: string;
      /** Subject the re-emitted `tasks.*` dispatch landed on. */
      dispatchSubject: string;
      /** Envelope id of the re-emitted dispatch — joins to the executor run. */
      dispatchEnvelopeId: string;
    })
  | (SystemBusReflexActivationDispatchedBase & { via: "handler" });

/**
 * F-6 — visibility event emitted when `ReflexActivationListener` resolves a
 * reflex `reflex.activation.fired` event and re-emits it as a `tasks.*`
 * dispatch the existing executor runs. Parity with
 * `system.bus.peer_dispatch_received`: bookkeeping about our own stack,
 * sovereignty defaults to local even when the underlying activation carries
 * a different classification (which is preserved on the dispatch itself).
 */
export function createSystemBusReflexActivationDispatchedEvent(
  opts: SystemBusReflexActivationDispatchedOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.bus.reflex_activation_dispatched",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    payload: {
      decision_id: opts.decisionId,
      target: opts.target,
      capability: opts.capability,
      via: opts.via,
      ...(opts.via === "dispatch" && {
        target_assistant: opts.targetAssistant,
        dispatch_subject: opts.dispatchSubject,
        dispatch_envelope_id: opts.dispatchEnvelopeId,
      }),
      ...(opts.correlationId !== undefined && {
        correlation_id: opts.correlationId,
      }),
    },
  });
}

export interface SystemBusReflexActivationFailedOpts {
  /** Standard source attribution — who emitted this visibility event. */
  source: SystemEventSource;
  /**
   * Reflex Decision id, when the fired event parsed far enough to expose
   * it. Omitted for malformed envelopes that never yielded a Decision id.
   */
  decisionId?: string;
  /** Original reflex target, when parsed. */
  target?: string;
  /**
   * Why the activation could not be dispatched. Conventional values:
   * `"unknown_target"` (no config mapping), `"publish:<detail>"` (bus or
   * policy refusal), `"parse:<detail>"` (malformed fired envelope),
   * `"build:<detail>"` (subject/envelope construction failed).
   */
  reason: string;
  /** Envelope id of the fired event that failed — joins to the source. */
  firedEnvelopeId: string;
  /** Correlation id from the fired event, if present. */
  correlationId?: string;
  classification?: Classification;
}

/**
 * F-6 — visibility event emitted when `ReflexActivationListener` cannot
 * dispatch a fired activation (unknown target, publish failure, malformed
 * envelope). The message is always acked after this is emitted (no poison
 * loop); a `term` is used only for structurally-malformed fired envelopes.
 */
export function createSystemBusReflexActivationFailedEvent(
  opts: SystemBusReflexActivationFailedOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.bus.reflex_activation_failed",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    payload: {
      reason: opts.reason,
      fired_envelope_id: opts.firedEnvelopeId,
      ...(opts.decisionId !== undefined && { decision_id: opts.decisionId }),
      ...(opts.target !== undefined && { target: opts.target }),
      ...(opts.correlationId !== undefined && {
        correlation_id: opts.correlationId,
      }),
    },
  });
}

export interface SystemBusReflexActivationSkippedOpts {
  /** Standard source attribution — who emitted this visibility event. */
  source: SystemEventSource;
  /** Reflex Decision id from the fired event. */
  decisionId: string;
  /** Original reflex target (Execution Blueprint ref). */
  target: string;
  /** Capability the bridge resolved the target to. */
  capability: string;
  /**
   * Why the dispatch was skipped. The only v1 value is `"author_trusted"` (the
   * fired activation's author is in the target's configurable `skip_authors`);
   * a named union (not an open string) keeps future call sites from drifting
   * into ad hoc reasons.
   */
  reason: "author_trusted";
  /** The matched author login that triggered the skip (audit trail). */
  author: string;
  /** Envelope id of the fired event that was skipped — joins to the source. */
  firedEnvelopeId: string;
  /** Correlation id from the fired event, if present. */
  correlationId?: string;
  classification?: Classification;
}

/**
 * F-6 — visibility event emitted when `ReflexActivationListener` deliberately
 * DROPS a fired activation because its author is trusted (in the target's
 * configurable `skip_authors`). This is an honest policy SKIP, not a failure:
 * no dispatch, no error, the Decision id is marked (a redelivery re-skips
 * silently). Distinct from `_failed` (which means the bridge could not
 * dispatch) so the audit trail distinguishes "we chose not to" from "we
 * could not".
 */
export function createSystemBusReflexActivationSkippedEvent(
  opts: SystemBusReflexActivationSkippedOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.bus.reflex_activation_skipped",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    payload: {
      reason: opts.reason,
      author: opts.author,
      target: opts.target,
      capability: opts.capability,
      fired_envelope_id: opts.firedEnvelopeId,
      decision_id: opts.decisionId,
      ...(opts.correlationId !== undefined && {
        correlation_id: opts.correlationId,
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// system.bus.notify_discord — F-6 downstream code-capability visibility
// ---------------------------------------------------------------------------

export interface SystemBusNotifyDiscordOpts {
  /** Standard source attribution — who emitted this visibility event. */
  source: SystemEventSource;
  /** `posted` (webhook 2xx), `failed` (post error / non-2xx), `skipped` (no repo mapping / unparseable payload). */
  outcome: "posted" | "failed" | "skipped";
  /** GitHub repo full name from the activation payload, when known. */
  repo?: string;
  /** Reflex Decision id carried on the dispatch (provenance), when present. */
  decisionId?: string;
  /** Human-readable detail for failed/skipped outcomes. */
  reason?: string;
  /** Correlation id carried from the dispatch. */
  correlationId?: string;
  classification?: Classification;
}

/**
 * F-6 downstream — visibility event emitted by `NotifyDiscordResponder` when
 * it handles a `notify.discord` dispatch (posts to / skips / fails on a
 * per-repo Discord webhook). Bookkeeping about our own stack — sovereignty
 * defaults to local. The webhook URL is NEVER included (it is a secret).
 */
export function createSystemBusNotifyDiscordEvent(
  opts: SystemBusNotifyDiscordOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.bus.notify_discord",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    payload: {
      outcome: opts.outcome,
      ...(opts.repo !== undefined && { repo: opts.repo }),
      ...(opts.decisionId !== undefined && { decision_id: opts.decisionId }),
      ...(opts.reason !== undefined && { reason: opts.reason }),
      ...(opts.correlationId !== undefined && {
        correlation_id: opts.correlationId,
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// system.bus.process — generic `process` reflex code-handler visibility
// ---------------------------------------------------------------------------

export interface SystemBusProcessOpts {
  /** Standard source attribution — who emitted this visibility event. */
  source: SystemEventSource;
  /** `started` (run spawned), `completed` (exit 0), `failed` (non-zero / spawn error / timeout / misconfig). */
  outcome: "started" | "completed" | "failed";
  /** The process spec name that ran (from the trusted `target.process`). */
  process: string;
  /** Reflex Decision id carried on the activation (provenance), when present. */
  decisionId?: string;
  /** Human-readable detail for the failed outcome (e.g. `exit-1`, `timeout-900000ms`, `spec:…`). */
  reason?: string;
  /** Correlation id carried from the activation. */
  correlationId?: string;
  classification?: Classification;
}

/**
 * Visibility event emitted by the generic `process` code handler as it runs a
 * config-declared command (the F-6 bridge invokes it for a `handler: process`
 * target; the spec is named by `target.process`). Bookkeeping about our own
 * stack — sovereignty defaults to local.
 */
export function createSystemBusProcessEvent(
  opts: SystemBusProcessOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.bus.process",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    payload: {
      outcome: opts.outcome,
      process: opts.process,
      ...(opts.decisionId !== undefined && { decision_id: opts.decisionId }),
      ...(opts.reason !== undefined && { reason: opts.reason }),
      ...(opts.correlationId !== undefined && {
        correlation_id: opts.correlationId,
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// system.access.allowed / system.access.denied — IAW Phase C.4 (cortex#115)
// ---------------------------------------------------------------------------

/**
 * Sovereignty constraints the PolicyEngine saw on the originating
 * envelope. Mirrors `IntentSovereignty` from `src/common/policy/types.ts`
 * exactly — surfaces (audit pipeline, dashboard) get the same shape they'd
 * see if they read `envelope.sovereignty` directly. Carried verbatim on
 * every `system.access.*` envelope so consumers don't need a join back to
 * the originating envelope to render the decision context.
 */
export interface SystemAccessSovereignty {
  classification: "local" | "federated" | "public";
  data_residency: string;
  max_hop: number;
  frontier_ok: boolean;
  model_class: "local-only" | "frontier" | "any";
}

/**
 * `signed_by[]` stamp shape carried on `system.access.*` envelopes
 * (C.4.3). Mirrors the wire shape from
 * `src/bus/myelin/envelope-validator.ts:SignedBy` — duplicating
 * structurally here keeps system-events independent of the
 * envelope-validator module's internal types while preserving the
 * cryptographic attribution chain. The audit pipeline can correlate
 * `signed_by[0].principal` between the original envelope and the
 * audit one without re-parsing either.
 */
export interface SystemAccessSignedBy {
  /**
   * Originating stamp DID — `did:mf:<name>` per myelin convention.
   * Vocabulary migration 2026-05 R2 — canonical key is `identity`;
   * the transition schema accepts `principal` too. Both are optional
   * here so the audit pipeline can carry whichever the wire stamp
   * actually shipped.
   */
  identity?: string;
  /**
   * @deprecated Renamed to `identity` (vocabulary migration 2026-05, R2).
   * Pre-migration / JetStream-replayed stamps carry this key; accepted
   * on read through the transition window. Removed in the breaking major.
   */
  principal?: string;
  /** Stamp method — `"ed25519"` | `"hub-stamp"` today; extensible. */
  method?: string;
  /** ISO-8601 timestamp the signature was produced. */
  at?: string;
  /**
   * Variant-specific fields ride through verbatim: `signature`,
   * `stamped_by` (hub-stamp), `role` (myelin#31 chain semantics).
   * Keeps the surface loose-but-typed so new variants don't break
   * the audit module before it catches up. Echo cortex#221 round 1.
   */
  [k: string]: unknown;
}

/**
 * Structured reason payload on `system.access.denied` envelopes.
 * Loosely mirrors `policy/types.ts:PolicyDenyReason` but keeps the
 * audit surface independent of the policy module (subscribers
 * consume the wire; they shouldn't re-import the engine types).
 * `kind` is required so callers can branch on it at compile time;
 * variant-specific fields ride through. Echo cortex#221 round 1.
 */
export interface SystemAccessDeniedReason {
  /**
   * Discriminator — `"unknown_principal"` | `"insufficient_role"`
   * | `"sovereignty_mismatch"` today. Future kinds append per
   * G-1111 §3.1 (no wire break).
   *
   * cortex#932 (P-14 U0.2) — the consumer-side fail-closed drop sites
   * emit on this same open record. Their kinds (no wire break — the
   * field is `string`):
   *   - `"sovereignty_model_class"` — the consumer-side sovereignty gate
   *     (review-consumer Stage 1b) refused a task whose model-class demand
   *     its own class would violate. Rides `reason` (free-form, from
   *     `evaluateSovereignty`) + `enforced` (bool — `true` when the deny
   *     bit, `false` on the audit-parity would-deny).
   *   - `"chain_verify_failed"` — a foreign `federated.*` presence envelope
   *     FAILED `signed_by[]` chain verification and was dropped (never
   *     folded). Rides `verify_reason` (the verifier's `result.reason.kind`).
   *   - `"chain_verify_fault"` — the chain verifier itself THREW; the
   *     envelope is dropped fail-closed (an envelope we couldn't verify is
   *     never folded). Rides `fault` (the thrown error's message).
   *   - `"originator_denied"` — a cross-principal (`federated.*`) review
   *     request whose requester (decoded from `originator.identity`) is not
   *     a configured `peers[]` member, or is unresolvable, was denied and
   *     dropped (the #908 fail-closed class). Rides `detail` (free-form).
   */
  kind: string;
  /**
   * Variant-specific fields ride through:
   *   - `principal_id` (always present today)
   *   - `missing_capability` (insufficient_role)
   *   - `reason` (sovereignty_mismatch — free-form text)
   *   - `enforced` (sovereignty_model_class — bool)
   *   - `verify_reason` (chain_verify_failed — the verifier reason kind)
   *   - `fault` (chain_verify_fault — the thrown error message)
   *   - `detail` (originator_denied — free-form text)
   */
  [k: string]: unknown;
}

/**
 * Common shape for `system.access.allowed` and `system.access.denied`.
 * Split into a base interface so the two helpers don't drift on the
 * shared fields (source, principal_id, intent, signed_by). Each adds
 * its own discriminator-specific payload (`capabilities` on allowed,
 * `reason` on denied).
 */
interface SystemAccessCommonOpts {
  source: SystemEventSource;
  /** Principal id the gate authorised (bare, no `did:mf:` prefix). */
  principalId: string;
  /** Capability claim the gate evaluated. */
  capability: string;
  /** Sovereignty constraints carried verbatim from the originating envelope. */
  sovereignty: SystemAccessSovereignty;
  /**
   * `correlation_id` from the originating envelope. The audit envelope
   * shares this id so consumers can join "envelope X was gated → here
   * is the decision". Required because every audit envelope describes
   * exactly one originating envelope.
   */
  correlationId: string;
  /**
   * `signed_by[]` chain from the originating envelope (C.4.3). May be
   * empty for legacy unsigned envelopes — surface as `[]` rather than
   * dropping the field so the audit record always carries the
   * attribution slot.
   */
  signedBy: SystemAccessSignedBy[];
  /**
   * Subject of the originating envelope — lets surfaces filter audit
   * traffic by the wire path they care about (e.g. only audit
   * `local.{principal}.dispatch.task.received` decisions).
   */
  envelopeSubject: string;
  /**
   * Envelope id of the originating envelope (distinct from
   * `correlationId` — the originating envelope may have been part of
   * a larger workflow whose correlation_id was set upstream).
   */
  envelopeId: string;
  /** Classification override; defaults to the system.* convention. */
  classification?: Classification;
}

/**
 * Options for `createSystemAccessAllowedEvent`. The `capabilities`
 * field is the engine's effective-capability set surfaced on the
 * allow branch (union of all the principal's role grants); audit
 * consumers can verify that the actually-requested capability was
 * within scope without re-running the engine.
 */
export interface SystemAccessAllowedOpts extends SystemAccessCommonOpts {
  capabilities: readonly string[];
}

/**
 * Options for `createSystemAccessDeniedEvent`. The `reason` field is
 * the engine's structured `PolicyDenyReason` — carried verbatim as a
 * record so subscribers can branch on `reason.kind` without coupling
 * system-events.ts to the policy module's type module.
 */
export interface SystemAccessDeniedOpts extends SystemAccessCommonOpts {
  reason: SystemAccessDeniedReason;
}

/**
 * Construct a `system.access.allowed` envelope (C.4.1).
 *
 * Emitted by every gate that accepts a dispatch. Today the only
 * caller is the dispatch-listener's policy gate; future gates
 * (substrate-side validation, federation hub stamps) will emit on
 * the same subject.
 *
 * Subject convention: `local.{principal}.system.access.allowed` — surfaces
 * subscribe to `system.access.>` for the full access stream.
 */
export function createSystemAccessAllowedEvent(
  opts: SystemAccessAllowedOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.access.allowed",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    correlationId: opts.correlationId,
    payload: {
      principal_id: opts.principalId,
      capability: opts.capability,
      capabilities: [...opts.capabilities],
      intent_sovereignty: opts.sovereignty,
      envelope_id: opts.envelopeId,
      envelope_subject: opts.envelopeSubject,
      signed_by: opts.signedBy,
    },
  });
}

/**
 * Construct a `system.access.denied` envelope (C.4.2).
 *
 * Emitted by every gate that rejects a dispatch. The `reason` payload
 * carries the engine's structured `PolicyDenyReason` so subscribers
 * can render the specific deny path without parsing free-form text.
 *
 * C.4.3 — `signed_by[]` from the originating envelope is carried
 * verbatim so denied envelopes are still cryptographically
 * attributable (the rejection itself is part of the audit trail).
 *
 * Subject convention: `local.{principal}.system.access.denied`.
 */
export function createSystemAccessDeniedEvent(
  opts: SystemAccessDeniedOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.access.denied",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    correlationId: opts.correlationId,
    payload: {
      principal_id: opts.principalId,
      capability: opts.capability,
      reason: opts.reason,
      intent_sovereignty: opts.sovereignty,
      envelope_id: opts.envelopeId,
      envelope_subject: opts.envelopeSubject,
      signed_by: opts.signedBy,
    },
  });
}

// ---------------------------------------------------------------------------
// system.admission.throttled / system.admission.degraded — R26 P1 (cortex#1371)
// ---------------------------------------------------------------------------

/**
 * Structured reason payload on `system.admission.throttled` envelopes.
 * Mirrors the AdmissionGate's refusal shape (myelin `specs/admission.md` §9):
 * which tier/key refused, on what dimension, at what limit, and the retry
 * hint the requester was given. `degraded` flags decisions taken on the
 * node-local fallback (design §4.3) so audit consumers can distinguish exact
 * refusals from approximate ones.
 */
export interface SystemAdmissionThrottledReason {
  /** Refusal dimension — `"rate"` | `"concurrency"` | `"store_error"`. */
  kind: string;
  /** Tier that refused — `"stack"` | `"principal"` (3–4 reserved). */
  tier: string;
  /** The KV key that refused (myelin admission spec §3 grammar). */
  key: string;
  /** Refusing rate window (`per_minute`|`per_hour`|`per_day`) — rate only. */
  window?: string;
  limit?: number;
  observed?: number;
  /** Backpressure hint forwarded to the requester (`not_now` taxonomy). */
  retry_after_ms: number;
  /** True when decided on the degraded node-local fallback. */
  degraded: boolean;
  [k: string]: unknown;
}

/**
 * Options for `createSystemAdmissionThrottledEvent`. Extends the same common
 * audit shape as `system.access.allowed`/`denied` — an admission refusal is
 * an access decision, just a TRANSIENT one — so consumers join it on the
 * same correlation/envelope keys they already use for the deny stream.
 */
export interface SystemAdmissionThrottledOpts extends SystemAccessCommonOpts {
  reason: SystemAdmissionThrottledReason;
}

/**
 * Construct a `system.admission.throttled` envelope (R26 P1, design §4.4) —
 * the audit sibling of `system.access.denied` for the transient admission
 * gate. Emitted by every enforcement point that refuses a dispatch on rate /
 * concurrency / store-posture grounds; the paired TERMINAL lifecycle event is
 * the `dispatch.task.failed { kind: "not_now" }` the enforcement point also
 * publishes (an admission refusal never `term`s — it defers).
 *
 * Subject convention: `local.{principal}.system.admission.throttled` —
 * surfaces subscribe to `system.admission.>` for the throttle stream, or
 * join with `system.access.>` on `correlation_id`.
 */
export function createSystemAdmissionThrottledEvent(
  opts: SystemAdmissionThrottledOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.admission.throttled",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    correlationId: opts.correlationId,
    payload: {
      principal_id: opts.principalId,
      capability: opts.capability,
      reason: opts.reason,
      intent_sovereignty: opts.sovereignty,
      envelope_id: opts.envelopeId,
      envelope_subject: opts.envelopeSubject,
      signed_by: opts.signedBy,
    },
  });
}

/** Options for `createSystemAdmissionDegradedEvent`. */
export interface SystemAdmissionDegradedOpts {
  source: SystemEventSource;
  /**
   * Posture transition: `"degraded-local"` = the KV admission store errored
   * and named principals now ride node-local approximate buckets (anonymous
   * fails closed); `"recovered"` = the store is reachable again and the
   * local fallback state was discarded.
   */
  mode: "degraded-local" | "recovered";
  /** Human-facing detail (the triggering error / recovery note). */
  detail: string;
  /** The admission KV bucket concerned (`admission_{principal}_{stack}`). */
  bucket?: string;
  classification?: Classification;
}

/**
 * Construct a `system.admission.degraded` envelope (R26 P1, design §4.4:
 * degraded-mode transitions MUST be loud — never silent, the R6 lesson).
 * Emitted once per posture TRANSITION (into and out of degraded), not per
 * request; the per-request `degraded: true` flag rides the throttle events.
 */
export function createSystemAdmissionDegradedEvent(
  opts: SystemAdmissionDegradedOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.admission.degraded",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    payload: {
      mode: opts.mode,
      detail: opts.detail,
      ...(opts.bucket !== undefined && { bucket: opts.bucket }),
    },
  });
}

// ---------------------------------------------------------------------------
// system.access.denied — IAW Phase D.2 federation-router variant
// ---------------------------------------------------------------------------

/**
 * Reason kinds the surface-router emits when gating inbound
 * `federated.*` envelopes against `policy.federated.networks[]`
 * (D.2). Wire-shape is the same `system.access.denied` envelope as
 * the C.4 dispatch-listener gate; only the `reason.kind` discriminator
 * + variant fields differ.
 *
 *   - `"peer_not_in_accept_list"` — subject didn't match any
 *     `accept_subjects[]` pattern, OR no matching network entry was
 *     declared for the `federated.{network_id}.<...>` prefix (D.2.1).
 *   - `"peer_deny_list"` — subject matched a `deny_subjects[]`
 *     pattern (overrides any accept-list hit) (D.2.1 / D.2.2).
 *   - `"max_hop_exceeded"` — `signed_by[].length > network.max_hop`
 *     (D.2.3). Variant fields carry the observed hop count + the
 *     network's budget so subscribers can render "3 stamps > 1
 *     allowed" without re-parsing the envelope.
 *   - `"source_link_mismatch"` — IAW Phase F-3d (cortex#666) anti-spoof:
 *     the subject claimed network `network_id`, but it was DELIVERED on a
 *     federated leaf link whose `leaf_node` does not own that network. A
 *     cross-network spoof (design §3.3 / §5). Variant fields carry the
 *     delivering link and the network's expected `leaf_node` so audit
 *     consumers can render "arrived on leaf X, expected leaf Y".
 *
 * Subjects (the actual `deny_subjects` / `accept_subjects` patterns
 * are principal data, not enum values — they ride on `reason.subject`
 * as free-form strings).
 */
export type SystemAccessFederationDeniedReasonKind =
  | "peer_not_in_accept_list"
  | "peer_deny_list"
  | "max_hop_exceeded"
  | "source_link_mismatch";

/**
 * Options for `createSystemAccessFederationDeniedEvent` — the D.2
 * router-gate variant. Sibling to {@link SystemAccessDeniedOpts}
 * but shaped for the router's natural inputs (subject + network
 * id + observed hop count) rather than the dispatch-listener's
 * principal/capability vocabulary.
 *
 * Wire-format note: the resulting envelope still has the same
 * top-level `type: "system.access.denied"` so audit consumers
 * subscribing to `system.access.>` see both gate flavours. They
 * branch on `payload.reason.kind` to render the variant.
 *
 * `principal_id` / `capability` on the payload reuse the C.4 fields
 * so the wire shape stays stable; for federation denials they
 * carry, respectively:
 *
 *   - `principal_id` — the originating signer (`signed_by[0].principal`)
 *     or `"unknown"` for unsigned envelopes (legacy / pre-Phase-B).
 *   - `capability` — the literal string `"federated.subject_dispatch"`,
 *     since federation denials are gating the wire-level dispatch
 *     itself rather than a named capability claim. Surfaces filter on
 *     this fixed value to separate federation gating from C.4 dispatch
 *     gating.
 */
export interface SystemAccessFederationDeniedOpts {
  source: SystemEventSource;
  /**
   * `signed_by[]` chain from the originating envelope (D.2 audit).
   * Carried verbatim — even-on-deny attribution per C.4.3 contract.
   * Empty array for legacy unsigned envelopes; surfaces should
   * render "unknown signer" without crashing.
   */
  signedBy: SystemAccessSignedBy[];
  /** Sovereignty constraints from the originating envelope. */
  sovereignty: SystemAccessSovereignty;
  /** Envelope id of the rejected envelope (for join back to source). */
  envelopeId: string;
  /** Subject of the rejected envelope (full NATS subject). */
  envelopeSubject: string;
  /**
   * Correlation id from the originating envelope, if any. When the
   * peer envelope carried no correlation_id, falls back to
   * `envelopeId` so the audit record always carries a non-empty
   * join key.
   */
  correlationId: string;
  /**
   * Federation network id parsed from the envelope subject's
   * second segment (`federated.{network_id}.<...>`). Present even
   * when the network id has no policy entry — in that case it
   * still appears here for triage ("peer claimed network 'x' but
   * we don't recognise it").
   */
  networkId: string;
  /** Structured reason — see {@link SystemAccessFederationDeniedReasonKind}. */
  reason:
    | {
        kind: "peer_not_in_accept_list";
        /**
         * `true` when no declared network matched the subject prefix
         * at all (vs. matched-the-network-but-subject-wasn't-in-list).
         * Both cases share the same kind because operationally
         * they're the same denial — "we don't accept this subject
         * pattern" — but the flag lets dashboards render the more
         * specific message when triaging.
         */
        unknown_network?: boolean;
      }
    | {
        kind: "peer_deny_list";
        /** Which deny pattern matched. */
        matched_pattern: string;
      }
    | {
        kind: "max_hop_exceeded";
        /** Observed `signed_by[].length`. */
        observed_hops: number;
        /** Configured `network.max_hop`. */
        max_hop: number;
      }
    | {
        /** IAW Phase F-3d (cortex#666) — anti-spoof leaf/subject mismatch. */
        kind: "source_link_mismatch";
        /** The link the envelope actually arrived on (delivering `linkId`). */
        source_link: string;
        /** The `leaf_node` the claimed network is configured to use. */
        expected_leaf_node: string;
      };
  /** Classification override; defaults to local per system.* convention. */
  classification?: Classification;
}

/**
 * Construct a `system.access.denied` envelope from the surface-router's
 * federation gate (D.2).
 *
 * Shares the wire type + most payload fields with the C.4
 * dispatch-listener variant — surfaces subscribing to
 * `system.access.>` see both flavours and branch on `reason.kind`.
 *
 * The `principal_id` + `capability` payload fields are fixed for
 * federation denials:
 *
 *   - `principal_id` = first stamp's principal, or `"unknown"` for
 *     unsigned envelopes.
 *   - `capability` = `"federated.subject_dispatch"` — a stable
 *     filter for "this denial came from the router's subject gate,
 *     not the dispatch policy gate".
 *
 * `payload.network_id` carries the parsed network id so subscribers
 * can slice the access stream by network without re-parsing the
 * envelope subject.
 */
export function createSystemAccessFederationDeniedEvent(
  opts: SystemAccessFederationDeniedOpts,
): Envelope {
  // R11 (vocabulary migration 2026-05, post-myelin#184): stamps emit
  // `identity` only — the `?? principal` fallback has been dropped per
  // docs/migrations/0002-vocabulary-finish-2026-05.md §PR-R11.
  const principalId = opts.signedBy[0]?.identity ?? "unknown";
  return buildBaseEnvelope({
    type: "system.access.denied",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    correlationId: opts.correlationId,
    payload: {
      principal_id: principalId,
      capability: "federated.subject_dispatch",
      reason: { ...opts.reason },
      intent_sovereignty: opts.sovereignty,
      envelope_id: opts.envelopeId,
      envelope_subject: opts.envelopeSubject,
      signed_by: opts.signedBy,
      network_id: opts.networkId,
    },
  });
}

// ---------------------------------------------------------------------------
// v2.0.0 cutover (cortex#297) — `system.access.disagreement` envelope retired.
//
// The disagreement envelope existed only for the parallel-mode validation
// window introduced by cortex#296 (C.2b-242a). cortex#297 deletes the
// legacy role-resolver and the parallel-mode plumbing — PolicyEngine is
// the sole authorisation gate, leaving no "two gates" to disagree. The
// C.4 `system.access.{allowed,denied}` siblings remain the audit surface.
// ---------------------------------------------------------------------------

// (Disagreement envelope interface + builder removed in cortex#297. The
// removed exports were `SystemAccessDisagreementOpts` /
// `createSystemAccessDisagreementEvent` / `SystemAccessDecision`. See
// git history for the legacy shape.)

// ---------------------------------------------------------------------------
// system.agent.heartbeat (cortex#361)
// ---------------------------------------------------------------------------

export interface SystemAgentHeartbeatOpts {
  source: SystemEventSource;
  /** `payload.agent_id` — logical agent name (`echo`, `luna`, ...). */
  agentId: string;
  /**
   * Dispatch-scoped task identifier. For chat-path: the `task-${uuid}`
   * string. For review-pipeline: the inbound request envelope's
   * `correlation_id`.
   */
  taskId: string;
  /**
   * UUID-shaped correlation key. Set on both `envelope.correlation_id`
   * AND `payload.correlation_id` so subscribers can correlate via either
   * the schema-validated envelope field or the payload (which travels
   * intact across schema upgrades that touch the envelope shape).
   */
  correlationId: string;
  phase: AgentHeartbeatPayload["phase"];
  /**
   * Milliseconds since the most recent cc-session stream event seen by
   * the producer. Lands on `payload.last_activity_ms_ago`.
   */
  lastActivityMsAgo: number;
  /**
   * Monotonically-increasing tick counter for this dispatch. The
   * `HeartbeatTicker` increments on every tick before publishing; the
   * first heartbeat after `start()` carries `iteration: 1`.
   */
  iteration: number;
  /**
   * IAW Phase A.3 — optional sovereignty classification. Defaults to
   * `"local"` (principal-private), matching the rest of `system.*`.
   * Cross-principal heartbeats over `federated.*` are out of scope for
   * cortex#361 (see file: `agent-heartbeat.ts` "Out of scope"); when
   * that ships in a future iteration callers will opt into
   * `"federated"` here.
   */
  classification?: Classification;
}

/**
 * Construct a `system.agent.heartbeat` envelope per cortex#361.
 *
 * Bus-side liveness signal — emitted on a fixed interval (default 30 s) by
 * `HeartbeatTicker` while a dispatch is in flight. Phase is best-effort
 * metadata derived from the most recent cc-session stream event seen; the
 * envelope's `signed_by[]` chain is the security boundary (heartbeat-
 * spoofing is bounded by stack-key possession via the normal
 * `runtime.publish` signing path).
 *
 * **Subject derivation.** The runtime's stack-aware `publish()` routes this
 * to `local.{principal}.{stack}.system.agent.heartbeat` — principal-managed
 * namespace, no upstream myelin schema entry required for the cortex-local
 * deployment. A myelin canonicalisation follow-up (filed against
 * `the-metafactory/myelin`) will lift this onto `federated.*` for cross-
 * principal use.
 */
export function createAgentHeartbeatEvent(
  opts: SystemAgentHeartbeatOpts,
): Envelope {
  const payload: AgentHeartbeatPayload = {
    agent_id: opts.agentId,
    task_id: opts.taskId,
    correlation_id: opts.correlationId,
    phase: opts.phase,
    last_activity_ms_ago: opts.lastActivityMsAgo,
    iteration: opts.iteration,
  };
  return buildBaseEnvelope({
    type: AGENT_HEARTBEAT_TYPE,
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    correlationId: opts.correlationId,
    payload: payload as unknown as Record<string, unknown>,
  });
}

// ---------------------------------------------------------------------------
// system.dispatch.stage — cortex#492 dispatch-pipeline trace events
// ---------------------------------------------------------------------------

/**
 * The pipeline stages a dispatch passes through inside the runner's
 * `handleDispatchEnvelope` (plus the `onEnvelope` fan-out entry). Each
 * value names a single gate or transition; the `outcome` discriminates
 * pass vs. fail at that gate. Surfaces (signal, the MC dashboard) can
 * project the trace stream and see EXACTLY how far a dispatch got before
 * it stalled / returned — the cortex#491 silent-drop would have been a
 * 2-minute diagnosis with this.
 *
 * Stages mirror the gate order in `dispatch-listener.ts`. The `*-start`
 * stages bracket a long await (chain verification) so a hang INSIDE that
 * await is still visible — the `-start` line lands synchronously before
 * the await; the absence of the matching terminal stage pinpoints the
 * stall.
 *
 *   - `received`            — runtime fan-out reached the listener handler
 *                              (handler ENTRY, before subject filtering).
 *   - `subject-matched`     — wire subject matched a declared pattern.
 *   - `subject-rejected`    — wire subject matched NO declared pattern
 *                              (the silent `return` at the top of the
 *                              `onEnvelope` handler — cortex#491's hidden gap).
 *   - `federation-gated`    — federation accept/deny gate ran (`outcome`
 *                              carries allow vs deny).
 *   - `parsed` / `malformed`— `dispatch.task.received` payload validated
 *                              (pass) or rejected (fail).
 *   - `recipient-validated` / `recipient-mismatch` — canonical-task
 *                              recipient agreed with the envelope target.
 *   - `chain-verify-start`  — IMMEDIATELY before the `verifySignedByChain`
 *                              await (a prime stall suspect — emitted
 *                              synchronously so a hang in verify is visible).
 *   - `chain-verified` / `chain-rejected` — verification settled (pass/fail).
 *   - `policy-decision`     — PolicyEngine allow/deny gate ran (`outcome`).
 *   - `session-spawning`    — IMMEDIATELY before `harness.dispatch(req)`
 *                              (the CC spawn — emitted before draining).
 *   - `started`             — the first harness lifecycle envelope drained.
 */
export type SystemDispatchStage =
  | "received"
  | "subject-matched"
  | "subject-rejected"
  | "federation-gated"
  | "parsed"
  | "malformed"
  | "recipient-validated"
  | "recipient-mismatch"
  | "chain-verify-start"
  | "chain-verified"
  | "chain-rejected"
  // TC-1c (#552) — Shape B re-sign on ingest. Emitted when a signer-bearing
  // stack re-stamps an empty-chain gateway-injected / adapter-originated
  // envelope with its own NKey, after the chain verifier accepts it and
  // before the policy gate. `pass` = re-stamped; `fail` = sign failed and the
  // dispatch fell through with the original unsigned envelope.
  | "resigned-on-ingest"
  // M3 (cortex#1241, ADR-0019) — verify-then-decrypt. Emitted on a `federated`
  // dispatch whose sealed payload could NOT be decrypted after the chain
  // verified (cleartext on a `required` network, missing network key, or AEAD
  // open failure). Always `fail`; the dispatch is dropped before any payload
  // field is parsed. A successful decrypt is silent (flows on to `parsed`).
  | "payload-decrypt-rejected"
  | "policy-decision"
  // R26 P1 (cortex#1371) — the admission gate (KV-arbitrated rate limiting)
  // between the policy allow and harness construction. `pass` = admitted;
  // `fail` = throttled (`not_now` terminal emitted, no spawn). Only emitted
  // when `policy.admission` is configured — absent config skips the stage
  // entirely (CO-4 inertness).
  | "admission-checked"
  | "session-spawning"
  | "started";

/**
 * Outcome of a stage. `pass` = the gate admitted the dispatch and it
 * proceeded; `fail` = the gate rejected / short-circuited (a deny, a
 * mismatch, a malformed payload). `info` = a non-gating transition
 * (e.g. `received`, `harness-dispatched`) where there is no pass/fail
 * branch — the stage simply happened.
 */
export type SystemDispatchStageOutcome = "pass" | "fail" | "info";

export interface SystemDispatchStageOpts {
  source: SystemEventSource;
  /**
   * Workflow correlation key — the originating envelope's `correlation_id`
   * (or `payload.task_id` fallback). Carried on `payload.correlation_id`
   * always; mirrored onto `envelope.correlation_id` ONLY when it is a
   * valid UUID (the envelope schema constrains `correlation_id` to UUID
   * format — see the file-level "Known spec gap" note). A non-UUID value
   * still rides the payload so surfaces can join on it regardless.
   */
  correlationId: string;
  /** Dispatch task id — `payload.task_id` for the dispatch being traced. */
  taskId: string;
  /** The stage being reported. See {@link SystemDispatchStage}. */
  stage: SystemDispatchStage;
  /** Pass / fail / info at this stage. See {@link SystemDispatchStageOutcome}. */
  outcome: SystemDispatchStageOutcome;
  /** Wire subject the dispatch arrived on (if known). */
  subject?: string;
  /** Executing agent id (`payload.agent_id`) when parsed. */
  agentId?: string;
  /**
   * Optional free-form detail — a deny reason kind, a mismatch message,
   * the verification rejection. Lets a triaging principal read the
   * "why" of a `fail` without joining to the matching
   * `system.access.denied` / `dispatch.task.failed` envelope.
   */
  detail?: string;
  /**
   * Optional sovereignty classification override. Defaults to `"local"`
   * — dispatch-stage traces are principal-internal operational telemetry,
   * matching the rest of `system.*`.
   */
  classification?: Classification;
}

/**
 * Construct a `system.dispatch.stage` trace envelope (cortex#492).
 *
 * Emitted at each stage of the runner's inbound dispatch path WHEN
 * tracing is enabled (`CORTEX_TRACE_DISPATCH=1` or `tracing.dispatch:
 * true`). Off by default — no caller emits these unless the principal
 * opts in, so there is zero overhead in the default configuration.
 *
 * The envelope is principal-local (`system.*` convention) and joins to
 * the dispatch's lifecycle envelopes via `correlation_id`. `task_id`,
 * `stage`, and `outcome` are always present; `subject` / `agent_id` /
 * `detail` ride when the emit site knows them.
 *
 * Subject convention: `local.{principal}.system.dispatch.stage` — surfaces
 * subscribe to `system.dispatch.>` (or the broader `system.>`) for the
 * trace stream.
 */
export function createSystemDispatchStageEvent(
  opts: SystemDispatchStageOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.dispatch.stage",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    // The envelope schema constrains `correlation_id` to UUID format; only
    // mirror onto the envelope field when the value qualifies. The payload
    // always carries it so the join key is never lost.
    ...(isUuid(opts.correlationId) && { correlationId: opts.correlationId }),
    payload: {
      correlation_id: opts.correlationId,
      task_id: opts.taskId,
      stage: opts.stage,
      outcome: opts.outcome,
      ...(opts.subject !== undefined && { subject: opts.subject }),
      ...(opts.agentId !== undefined && { agent_id: opts.agentId }),
      ...(opts.detail !== undefined && { detail: opts.detail }),
    },
  });
}

// ---------------------------------------------------------------------------
// system.gateway.routing_decision — cortex#596 gateway inbound observability
// ---------------------------------------------------------------------------

/**
 * Outcome of the SurfaceGateway's inbound routing decision.
 *
 *   - `routed`      — the inbound message matched a binding and its canonical
 *                     `tasks.@{agent}.chat` dispatch envelope was published to
 *                     the bound stack. `stack` / `subject` carry the target the
 *                     inbound reached.
 *   - `unroutable`  — the inbound reached NO bound stack. Two sub-cases share
 *                     this outcome, discriminated by whether `agent` is present:
 *                       (1) NO binding matched at all (cortex#596) — emitted from
 *                           the gateway's `onUnroutable` path; `reason` carries
 *                           the `unroutableReason()` string (e.g. `no binding for
 *                           discord guildId "X"`) and `agent`/`stack` are absent.
 *                       (2) a binding matched but the dispatch to the bound stack
 *                           was REFUSED by the dispatch-source publisher
 *                           (`{ published: false }`) — `reason` carries the refusal
 *                           (`invalid-originator`, `missing-runtime`, …) and
 *                           `agent` is the matched agent.
 *                     In both cases nothing reached a stack — the inbound is dropped.
 *
 * Two outcomes of ONE decision, so they share a single envelope type
 * discriminated on `outcome` — the same shape the sibling
 * `system.bus.notify_discord` (`posted`/`failed`/`skipped`) and
 * `system.bus.process` (`started`/`completed`/`failed`) visibility events use,
 * rather than two near-identical `.routed` / `.unroutable` types.
 */
export type SystemGatewayRoutingOutcome = "routed" | "unroutable";

export interface SystemGatewayRoutingDecisionOpts {
  source: SystemEventSource;
  /** Routing outcome — see {@link SystemGatewayRoutingOutcome}. */
  outcome: SystemGatewayRoutingOutcome;
  /** Platform the inbound arrived on (`discord` / `slack` / `mattermost` / …). */
  platform: string;
  /** Adapter connection-instance key (`msg.instanceId`) that received it. */
  instanceId: string;
  /**
   * Target agent id from the binding match. Optional because the no-binding-match
   * unroutable case (cortex#596) has NO binding and therefore NO agent — the
   * inbound arrived on a `(platform, instance)` the gateway owns but matched no
   * surface binding, so there is genuinely nothing to attribute an agent to. The
   * routed branch (and the publish-refusal unroutable branch) DO carry a matched
   * agent and always set it. Omitted from the payload when absent.
   */
  agent?: string;
  /** Target principal from the binding match, when resolved. */
  principal?: string;
  /**
   * Target stack from the binding match. Present on `routed`; may still be
   * absent for a stackless (binding-resolver gap-4) binding.
   */
  stack?: string;
  /** Canonical dispatch subject the routed envelope landed on — `routed` only. */
  subject?: string;
  /** Dispatch-source publisher refusal reason — `unroutable` only. */
  reason?: string;
  /**
   * IAW Phase A.3 — optional sovereignty classification. Defaults to
   * `"local"` (principal-private), matching the rest of `system.*`.
   */
  classification?: Classification;
}

/**
 * Construct a `system.gateway.routing_decision` envelope (cortex#596).
 *
 * The SurfaceGateway is a thin demux in front of the per-stack runners; it
 * carries its own source identity `{principal}.gateway.{instance}` (see
 * `gatewaySource()` in `src/gateway/gateway-adapters.ts`). This event is the
 * structured replacement for the interim stdout routing hunt-line the gateway
 * dry-run relied on — a dashboard glance instead of a stdout tail (#596).
 *
 * **New `system.gateway.*` family — why its own leaf.** The sibling `system.*`
 * families are concern-scoped: `system.adapter.*` = adapter connection
 * lifecycle, `system.inbound.*` = STACK-side inbound dispatch lifecycle
 * (`system.inbound.aborted` is a timeout during an already-routed dispatch),
 * `system.bus.*` = bus listener/handler visibility. The gateway's demux
 * routing decision — which stack an inbound reached, or why it did not — fits
 * none of those and PRECEDES the stack-side `system.inbound.*` lifecycle, so it
 * takes its own `gateway` leaf. `git grep system.gateway` was empty before this
 * event: an unclaimed, natural namespace.
 *
 * Subject convention: `local.{principal}.system.gateway.routing_decision` —
 * surfaces subscribe to `system.gateway.>` (or the broader `system.>`).
 */
export function createSystemGatewayRoutingDecisionEvent(
  opts: SystemGatewayRoutingDecisionOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.gateway.routing_decision",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    payload: {
      outcome: opts.outcome,
      platform: opts.platform,
      instance_id: opts.instanceId,
      ...(opts.agent !== undefined && { agent: opts.agent }),
      ...(opts.principal !== undefined && { principal: opts.principal }),
      ...(opts.stack !== undefined && { stack: opts.stack }),
      ...(opts.subject !== undefined && { subject: opts.subject }),
      ...(opts.reason !== undefined && { reason: opts.reason }),
    },
  });
}

// ---------------------------------------------------------------------------
// system.plugin.load_failed / system.plugin.loaded — cortex#1792 (S6,
// ADR-0024 D1/D3/D5)
// ---------------------------------------------------------------------------

/**
 * New `system.plugin.*` family — the plugin loader's (`src/adapters/loader.ts`)
 * per-bundle outcome events. A new leaf, not folded into `system.adapter.*`
 * (adapter CONNECTION lifecycle, not plugin LOAD lifecycle — a plugin failure
 * can be a renderer, which has no adapter-connection concept at all) or
 * `system.bus.*` (listener/handler visibility, not code-loading visibility).
 * `git grep system.plugin` was empty before this event.
 *
 * ADR-0024 §3.3 / D3 requires per-plugin fail-isolation: ONE bad bundle
 * (bad manifest, incompatible `sdkRange`, a throwing `import()`, a
 * malformed default export, a duplicate-platform shadow attempt) is skipped
 * with a `system.error`-class event; the daemon and every other plugin stay
 * live. `createSystemPluginLoadFailedEvent` is that event. Reason strings
 * NEVER echo a manifest or bundle config VALUE (only field paths / static
 * messages) — a plugin bundle load failure must not leak a secret a
 * misconfigured renderer manifest happened to carry.
 *
 * `createSystemPluginLoadedEvent` is the success twin — cortex#1893 (the
 * separate boot-coverage hard-fail slice, ADR-0024 §OQ9) consumes "which
 * plugins loaded" to decide whether `local.{principal}.system.>` coverage
 * holds; this event (plus the loader's own structured return value) is the
 * surface it reads.
 */
export interface SystemPluginLoadFailedOpts {
  source: SystemEventSource;
  /** arc package name the bundle installed under (`arc list --json`'s `name`). */
  bundleName: string;
  /** Plugin kind the manifest declared, when parsing got that far. */
  kind?: "adapter" | "renderer";
  /** Plugin id the manifest declared, when parsing got that far. */
  pluginId?: string;
  /**
   * Which stage of discover → gate → import → register the failure
   * occurred at. Kept as an open string (not a closed enum) so a future
   * stage doesn't need a schema change — `loader.ts` is the single source
   * of truth for the values it actually emits.
   */
  stage: string;
  /** Human-readable, secret-free failure detail. */
  reason: string;
  classification?: Classification;
}

/**
 * Construct a `system.plugin.load_failed` envelope. Subject convention:
 * `local.{principal}.system.plugin.load_failed` — surfaces subscribe to
 * `system.plugin.>` (or the broader `system.>`).
 */
export function createSystemPluginLoadFailedEvent(
  opts: SystemPluginLoadFailedOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.plugin.load_failed",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    payload: {
      bundle_name: opts.bundleName,
      ...(opts.kind !== undefined && { kind: opts.kind }),
      ...(opts.pluginId !== undefined && { plugin_id: opts.pluginId }),
      stage: opts.stage,
      reason: opts.reason,
    },
  });
}

export interface SystemPluginLoadedOpts {
  source: SystemEventSource;
  bundleName: string;
  kind: "adapter" | "renderer";
  pluginId: string;
  /** True when this plugin loaded under the OQ9 first-party-renderer
   *  exemption rather than because `system.plugins.external` was on. */
  firstParty: boolean;
  classification?: Classification;
}

/**
 * Construct a `system.plugin.loaded` envelope — the success twin of
 * {@link createSystemPluginLoadFailedEvent}. Subject convention:
 * `local.{principal}.system.plugin.loaded`.
 */
export function createSystemPluginLoadedEvent(
  opts: SystemPluginLoadedOpts,
): Envelope {
  return buildBaseEnvelope({
    type: "system.plugin.loaded",
    source: buildSource(opts.source),
    sovereignty: defaultSystemSovereignty(opts.source, opts.classification),
    payload: {
      bundle_name: opts.bundleName,
      kind: opts.kind,
      plugin_id: opts.pluginId,
      first_party: opts.firstParty,
    },
  });
}
