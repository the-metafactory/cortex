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
 * MyelinRuntime, grove-bot main) construct envelopes from a single audited
 * source. Field names and enums match the §3.5.4 schemas verbatim — adding a
 * field requires updating both the spec and these helpers in the same PR.
 *
 * **Shape contract:**
 *   - `id` is a fresh `crypto.randomUUID()` per call (envelope-level idempotency key).
 *   - `timestamp` is the helper-call time (ISO 8601). Callers should not back-fill
 *     this — if you need an event-of-fact timestamp distinct from emit time
 *     (e.g. `disconnected_since`), it lives in the payload.
 *   - `source` is the dotted `{org}.{agent}.{instance}` form required by the
 *     myelin envelope schema (G-1100.B) — e.g. `metafactory.grove.local`.
 *     The helpers take the three segments separately so callers don't string-
 *     concatenate by hand. This matches the spec §3.6 example envelopes.
 *     (The DID-style form `did:web:...` from the original task brief does
 *     not validate against the schema's `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,4}$`
 *     pattern; the dotted form is the schema-compatible carrier.)
 *   - `sovereignty` defaults to `local-only / NZ / max_hop=0 / frontier_ok=false / model_class=local-only`
 *     because `system.*` events expose internal failure modes (adapter IDs,
 *     buffer caps, error class names). They're operator-only — no federation,
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

/**
 * Source identifier used by every `system.*` event. Three dotted segments
 * matching the schema's `org.agent.instance` form. Kept as a struct in the
 * helper-options shape so callers don't string-concatenate by hand.
 *
 * Examples (from spec §3.6):
 *   - `metafactory.pilot.local`
 *   - `metafactory.grove.dashboard`
 *   - For cortex-emitted system.* events: `{operatorId}.cortex.local`
 */
export interface SystemEventSource {
  /** `agent.operatorId` — first segment. */
  org: string;
  /** Logical agent name — `cortex`, `grove`, `pilot`, etc. */
  agent: string;
  /** Stable instance name — usually `local` for in-process emission. */
  instance: string;
  /**
   * Operator residency code stamped into `envelope.sovereignty.data_residency`.
   * Defaults to `"NZ"` when omitted — matches the original cortex deployment.
   * Operators in other jurisdictions (AU, EU, US) pass their own ISO-3166-style
   * code so envelopes accurately reflect data residency for compliance audits.
   * The field is only used when constructing the default sovereignty object;
   * callers that override `sovereignty` directly bypass it entirely.
   */
  dataResidency?: string;
}

function buildSource(src: SystemEventSource): string {
  return `${src.org}.${src.agent}.${src.instance}`;
}

/**
 * Default sovereignty for `system.*` events. Expressed as a function so
 * callers receive a fresh object literal (no aliasing risk if a caller
 * mutates the returned envelope's `sovereignty`).
 *
 * `system.*` events expose internal grove state — operator-only by default,
 * never sent to frontier models. The `data_residency` field is sourced from
 * `source.dataResidency` (defaulting to `"NZ"`) so a non-NZ operator gets
 * envelopes stamped with their actual residency without having to override
 * the entire sovereignty object at every call site.
 *
 * **IAW Phase A.3:** `classification` is now an optional parameter
 * (defaulting to `"local"` for back-compat). Callers may opt into
 * `"federated"` or `"public"` when an operator-side decision determines the
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
  /** Envelope source — `{org}.{agent}.{instance}` per schema. */
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
   * `"local"` (operator-private). Set to `"federated"` to publish on
   * `federated.{org}.system.adapter.degraded` so peer dashboards in the
   * operator's federation policy can render the event; `"public"` for
   * global visibility. Mismatch with the publish-time subject is a
   * protocol violation (see {@link validateSubjectEnvelopeAlignment}).
   */
  classification?: Classification;
}

/**
 * Construct a `system.adapter.degraded` envelope per G-1111 §3.5.4.
 *
 * Emitted once when an adapter has been disconnected long enough to cross
 * the operator-configured threshold (default 60 s). Mandatory paging event
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
 * structured envelope carrying the `timeout_source` enum, so an operator
 * triaging an incident can see *which* timeout fired without parsing
 * launchd logs.
 *
 * Note: spec §3.5 renames this from the older `system.dispatch.aborted` —
 * "dispatch" is now reserved for the `dispatch` *domain* (operator-dispatching-
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
