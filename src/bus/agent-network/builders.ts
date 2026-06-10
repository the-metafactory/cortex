/**
 * G-1114.B.1 — `agent.*` presence envelope builders.
 *
 * Phase A (`envelopes.ts`) landed the four INERT presence payload types
 * (`AgentOnlinePayload`, `AgentHeartbeatPayload`, `AgentOfflinePayload`,
 * `AgentCapabilitiesChangedPayload`) + their `*_TYPE` constants. This file
 * adds the **builders** on top: one constructor per presence action that wraps
 * a payload in the full myelin envelope, ready for `runtime.publish`.
 *
 * **Mirrors `src/bus/dispatch-events.ts` exactly:**
 *   - constructs the envelope via the shared `buildBaseEnvelope` skeleton
 *     (`src/bus/envelope-builder.ts`) — same `id`/`timestamp`/`payload`/
 *     `sovereignty` skeleton the `dispatch.task.*` + `system.*` domains use;
 *   - a thin domain wrapper ({@link buildPresenceEnvelope}) threads the
 *     presence-specific defaults (source-string assembly, sovereignty posture,
 *     local|federated scope) so each per-action constructor stays a one-liner;
 *   - each constructor sets `type: "agent.online"` / `"agent.heartbeat"` / … so
 *     the subject derives to `{scope}.{principal}.{stack}.agent.{action}` via
 *     myelin's `deriveSubject` (`deriveNatsSubject` in
 *     `src/bus/myelin/envelope-validator.ts`). No new subject helper — the
 *     `agent` domain rides `envelope.type`'s leading segment (ADR-0007).
 *
 * **Signing path — NOT in the builder.** Exactly like `dispatch-events.ts`,
 * these builders produce an UNSIGNED envelope literal. Signing happens at
 * publish: `MyelinRuntime.publish(envelope)` calls `signEnvelope` with the
 * stack NKey seed and appends to `signed_by[]` before NATS publish, then
 * derives the subject via `deriveNatsSubject(envelope, stack)`. The builder
 * threads NO signer and stamps NO subject — the stack signs on publish. (See
 * `src/bus/myelin/runtime.ts` `publishEnabled`.)
 *
 * **What this file is NOT (B.1 scope):**
 *   - NOT a producer. Nothing calls these from boot/runtime yet — that is
 *     G-1114.B.2 (producer wired into the cortex boot lifecycle).
 *   - NOT a subscriber. The runtime registry subscriber is G-1114.B.3.
 *   - NOT a signer. Signing is the runtime's job at publish (see above).
 *   - NOT a renderer. Surfaces consume `agent.*` envelopes downstream.
 *
 * Builders are exported + unit-tested only. Inert beyond the builders.
 */

import type { Classification, Envelope } from "../myelin/envelope-validator";
import { buildBaseEnvelope as buildSharedEnvelope } from "../envelope-builder";
import {
  AGENT_ONLINE_TYPE,
  AGENT_HEARTBEAT_TYPE,
  AGENT_OFFLINE_TYPE,
  AGENT_CAPABILITIES_CHANGED_TYPE,
  type AgentPresenceIdentity,
  type AgentPresenceScope,
  type AgentOfflineReason,
} from "./envelopes";

/**
 * Source triple for an `agent.*` presence envelope — the dotted
 * `envelope.source` (`{principal}.{stack}.{instance}`, exactly 3 segments per
 * myelin#185). Mirrors `dispatch-events.ts`'s `DispatchEventSource`
 * (= `SystemEventSource`): `deriveNatsSubject` reads segment[0] as the
 * `{principal}` for the subject, and the stack-aware publish path supplies
 * `{stack}` separately, so subject = `{scope}.{principal}.{stack}.agent.{action}`.
 *
 * Distinct from the payload's {@link AgentPresenceScope}: `source` is the
 * envelope-level emitter address (who signed/emitted); `scope` is the
 * payload-level identity-provenance block a subscriber keys its registry record
 * on. They carry the same `{principal}`/`{stack}` values for a stack's own
 * agent, but are separate fields by design (envelope wire address vs payload
 * descriptor).
 */
export interface AgentPresenceSource {
  /** Boot-resolved `principal.id` — first dotted segment of `envelope.source`. */
  principal: string;
  /** The principal's stack slug — second dotted segment of `envelope.source`. */
  stack: string;
  /** Stable instance name — usually `local` for in-process emission. */
  instance: string;
  /**
   * Principal residency code stamped into `envelope.sovereignty.data_residency`.
   * Defaults to `"NZ"` when omitted — same convention as `system-events.ts` /
   * `dispatch-events.ts`. Principals in other jurisdictions pass their own
   * ISO-3166-style code.
   */
  dataResidency?: string;
}

function buildSource(src: AgentPresenceSource): string {
  return `${src.principal}.${src.stack}.${src.instance}`;
}

/**
 * Default sovereignty for `agent.*` presence events.
 *
 * Same posture as `system.*` / `dispatch.task.*`: principal-only by default
 * (`classification` defaults to `"local"`), local residency, `max_hop=0`,
 * `frontier_ok=false`, `model_class="local-only"`. Presence carries identity +
 * declared capabilities (never session interiors — ADR-0005), so it stays
 * principal-private unless a caller explicitly opts into `"federated"` to feed
 * a peer-principal Network view (G-1114.E).
 *
 * `data_residency` is sourced from `source.dataResidency` (defaulting to
 * `"NZ"`). Returned as a fresh literal per call so a downstream mutation on one
 * envelope's `sovereignty` cannot leak into a sibling envelope. Mirrors
 * `dispatch-events.ts`'s `defaultDispatchSovereignty`.
 */
function defaultPresenceSovereignty(
  source: AgentPresenceSource,
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
 * Fields every `agent.*` presence builder carries — the envelope emitter
 * `source` triple plus the payload identity + scope blocks, and the optional
 * scope classification. Spelled out as an interface so each per-action option
 * type can `extends AgentPresenceCommonOpts` without redeclaring + drifting.
 *
 * Mirrors `dispatch-events.ts`'s `DispatchTaskCommonOpts` shape (common fields
 * factored out, per-action extras added by each constructor's own opts type).
 *
 * Note — no `correlationId`: presence envelopes are NOT correlated lifecycle
 * events (there is no task to stitch). The dispatch heartbeat (cortex#361)
 * carries a `correlation_id`; this presence protocol deliberately does not
 * (ADR-0007 §1 — two differently-scoped heartbeats by design).
 */
export interface AgentPresenceCommonOpts {
  /** Envelope emitter address — assembled into `envelope.source`. */
  source: AgentPresenceSource;
  /** Payload identity block — the logical agent identity a subscriber keys on. */
  identity: AgentPresenceIdentity;
  /** Payload scope block — `{principal}.{stack}` identity provenance. */
  scope: AgentPresenceScope;
  /**
   * Optional sovereignty classification. Defaults to `"local"`
   * (principal-private). Set to `"federated"` when a presence envelope should
   * reach peer principals' Network views (G-1114.E). A mismatch with the
   * publish-time subject prefix is a protocol violation (the runtime's
   * `validateSubjectEnvelopeAlignment` catches it).
   */
  classification?: Classification;
}

/**
 * Domain-specific wrapper around `buildSharedEnvelope` (from
 * `bus/envelope-builder.ts`). Threads presence-specific defaults: sovereignty
 * posture + source-string assembly + the shared `identity`/`scope` payload
 * head. Each per-action constructor passes only its action-specific payload
 * extras.
 *
 * The shared helper handles the `id`/`timestamp`/`payload`/`sovereignty`
 * skeleton; this thin wrapper exists so each `agent.*` constructor doesn't
 * repeat the source-build + sovereignty + identity/scope boilerplate. Exactly
 * the `buildBaseEnvelope` role in `dispatch-events.ts`.
 *
 * No `correlation_id` is set — see {@link AgentPresenceCommonOpts}.
 */
function buildPresenceEnvelope(
  type: string,
  common: AgentPresenceCommonOpts,
  payloadExtras: Record<string, unknown>,
): Envelope {
  return buildSharedEnvelope({
    type,
    source: buildSource(common.source),
    sovereignty: defaultPresenceSovereignty(common.source, common.classification),
    payload: {
      identity: common.identity,
      scope: common.scope,
      ...payloadExtras,
    },
  });
}

// ---------------------------------------------------------------------------
// agent.online
// ---------------------------------------------------------------------------

export interface AgentOnlineOpts extends AgentPresenceCommonOpts {
  /**
   * Capability ids the agent advertises at boot. Defaults to `[]` when
   * omitted (the payload field defaults to an empty set per ADR-0007 §3).
   */
  capabilities?: string[];
  /** When the agent process booted. */
  startedAt: Date;
}

/**
 * Construct an `agent.online` envelope per ADR-0007.
 *
 * Emitted once on agent boot. Carries the full presence descriptor: identity,
 * scope, the INITIAL capability set (superseding the boot-time
 * `agents.capabilities.registered` announce — ADR-0007 §3), and the boot time.
 * Derives `{scope}.{principal}.{stack}.agent.online` on publish.
 */
export function createAgentOnlineEvent(opts: AgentOnlineOpts): Envelope {
  return buildPresenceEnvelope(AGENT_ONLINE_TYPE, opts, {
    capabilities: opts.capabilities ?? [],
    started_at: opts.startedAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// agent.heartbeat
// ---------------------------------------------------------------------------

export interface AgentHeartbeatOpts extends AgentPresenceCommonOpts {
  /** When this heartbeat was emitted. */
  sentAt: Date;
}

/**
 * Construct an `agent.heartbeat` envelope per ADR-0007 §1.
 *
 * Emitted on a fixed interval while the agent is up (idle or not). This is the
 * PRESENCE heartbeat — liveness ONLY: no capability list (that rides
 * `agent.online` / `agent.capabilities-changed`) and NO `correlation_id` /
 * `phase` (that is the dispatch-scoped `system.agent.heartbeat`'s shape,
 * cortex#361 — NOT this one). Derives
 * `{scope}.{principal}.{stack}.agent.heartbeat` on publish.
 */
export function createAgentHeartbeatEvent(opts: AgentHeartbeatOpts): Envelope {
  return buildPresenceEnvelope(AGENT_HEARTBEAT_TYPE, opts, {
    sent_at: opts.sentAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// agent.offline
// ---------------------------------------------------------------------------

export interface AgentOfflineOpts extends AgentPresenceCommonOpts {
  /** Why the agent went offline — `shutdown` / `restart` / `error`. */
  reason: AgentOfflineReason;
  /**
   * Optional human-readable detail (e.g. the error message for `error`).
   * OMITTED from the payload (not an empty string) when not provided — same
   * absent-optional discipline as `dispatch-events.ts`'s `result_summary`.
   */
  detail?: string;
  /** When the offline was emitted. */
  sentAt: Date;
}

/**
 * Construct an `agent.offline` envelope per ADR-0007.
 *
 * Emitted on graceful shutdown / restart, or on an abnormal-but-announced exit
 * (`error`). A subscriber's liveness FSM transitions the record to `offline`
 * immediately on receipt (vs waiting out the TTL). A TTL-lapse offline is
 * inferred by the subscriber and never rides an `agent.offline` envelope (no
 * agent left to send one). Derives `{scope}.{principal}.{stack}.agent.offline`.
 */
export function createAgentOfflineEvent(opts: AgentOfflineOpts): Envelope {
  return buildPresenceEnvelope(AGENT_OFFLINE_TYPE, opts, {
    reason: opts.reason,
    ...(opts.detail !== undefined && { detail: opts.detail }),
    sent_at: opts.sentAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// agent.capabilities-changed
// ---------------------------------------------------------------------------

export interface AgentCapabilitiesChangedOpts extends AgentPresenceCommonOpts {
  /**
   * The agent's FULL new steady-state capability set (not a diff) so a
   * subscriber that missed an earlier delta still converges. Defaults to `[]`
   * (all capabilities revoked) when omitted.
   */
  capabilities?: string[];
  /** When the capability change was emitted. */
  sentAt: Date;
}

/**
 * Construct an `agent.capabilities-changed` envelope per ADR-0007 §3.
 *
 * Emitted when an agent's advertised capability set changes mid-life (plugin
 * loaded, permission granted/revoked). Carries the FULL new steady-state set
 * (the subscriber computes the diff against its current record). Supersedes
 * mid-life re-emission of `agents.capabilities.registered`. Derives
 * `{scope}.{principal}.{stack}.agent.capabilities-changed`.
 */
export function createAgentCapabilitiesChangedEvent(
  opts: AgentCapabilitiesChangedOpts,
): Envelope {
  return buildPresenceEnvelope(AGENT_CAPABILITIES_CHANGED_TYPE, opts, {
    capabilities: opts.capabilities ?? [],
    sent_at: opts.sentAt.toISOString(),
  });
}
