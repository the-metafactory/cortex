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

function buildSource(src: SystemEventSource): string {
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
function defaultSystemSovereignty(
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
  /** NATS subject of the dropped envelope — operators correlate by this. */
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
 * It's a side-channel for operators who want to audit/debug "why didn't I
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
   * Envelope id of the peer's dispatch envelope. Lets operators join
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
   */
  kind: string;
  /**
   * Variant-specific fields ride through:
   *   - `principal_id` (always present today)
   *   - `missing_capability` (insufficient_role)
   *   - `reason` (sovereignty_mismatch — free-form text)
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
 *
 * Subjects (the actual `deny_subjects` / `accept_subjects` patterns
 * are principal data, not enum values — they ride on `reason.subject`
 * as free-form strings).
 */
export type SystemAccessFederationDeniedReasonKind =
  | "peer_not_in_accept_list"
  | "peer_deny_list"
  | "max_hop_exceeded";

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
