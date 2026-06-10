/**
 * G-1114.A — Agent-presence protocol envelope payload types (INERT).
 *
 * These are the payload shapes for the four `agent`-domain presence envelopes
 * introduced by the Agent Network Topology umbrella (G-1114). They are
 * **inert**: defined, exported, and unit-tested for shape/validation, but NO
 * producer publishes them and NO subscriber consumes them yet. The first live
 * producer/subscriber lands in G-1114.B. This grounding slice lands only the
 * protocol SHAPE, reconciled to ADR-0007.
 *
 * ## Grounding (ADR-0007 — agent-presence protocol)
 *
 * 1. **`agent` domain, distinct from dispatch liveness.** Presence rides the
 *    reserved `agent` domain: `agent.{online|heartbeat|offline|capabilities-changed}`
 *    on `local.{principal}.{stack}.agent.…`. It means "this agent process is up
 *    and consuming the bus, idle or not." It is SEPARATE from the dispatch-scoped
 *    `system.agent.heartbeat` (cortex#361, see {@link AgentHeartbeatPayload} in
 *    `src/common/types/agent-heartbeat.ts`), which fires only WHILE a dispatch is
 *    in flight, keyed by `correlation_id`. An idle agent emits `agent.heartbeat`,
 *    never `system.agent.heartbeat` — two differently-scoped heartbeats by design.
 *
 * 2. **`{principal}`, never `{org}`.** The subject's second segment is the
 *    PRINCIPAL (CONTEXT.md authoritative; ADR-0001). Subjects are
 *    `local.{principal}.{stack}.agent.{action}` and the federated counterpart
 *    `federated.{principal}.{stack}.agent.{action}` — the network is NEVER a wire
 *    token (ADR-0001/0003): network membership is grouped by the registry ROSTER
 *    (ADR-0003), resolved from topology, not from a `public.metafactory.agent.*`
 *    namespace. Public scope is deferred to candidate G-1115.
 *
 * 3. **Supersedes `agents.capabilities.registered`.** `agent.online` carries the
 *    initial capability set; `agent.capabilities-changed` carries deltas. They
 *    subsume the observability-only boot-time capability-announce envelope
 *    (dual-emit → retire). Capability DISPATCH (cortex#237) is untouched — it
 *    routes on the `tasks.{capability}` subject via JetStream consumer filters,
 *    not a registry lookup.
 *
 * 4. **Peer visibility = presence + dispatch-lifecycle metadata only, never
 *    session interiors** (ADR-0005). These payloads carry identity, liveness, and
 *    declared capabilities — they deliberately carry NO tool calls, prompts, or
 *    diffs. The boundary is enforced by what is on the wire, not a UI check.
 *
 * ## Subject derivation
 *
 * The `agent` domain is expressed via the envelope's `type` field: an envelope
 * with `type: "agent.online"` derives the subject
 * `{scope}.{principal}.{stack}.agent.online` through myelin's `deriveSubject`
 * (`deriveNatsSubject` in `src/bus/myelin/envelope-validator.ts`). No new subject
 * helper is needed — the domain segment is the leading segment of `type`. The
 * four `*_TYPE` constants below are the canonical `envelope.type` literals.
 *
 * ## Envelope schema fit
 *
 * The myelin envelope schema (`src/bus/myelin/vendor/envelope.schema.json`)
 * declares `payload` as an unconstrained object ("Structure is domain-specific
 * — the envelope does not constrain payload shape"). So each of these payloads
 * lands on `envelope.payload` and round-trips through `validateEnvelope`
 * unchanged — the same property the cortex#361 heartbeat work relies on. These
 * schemas are the cortex-side shape contract for that domain-specific payload.
 */

import { z } from "zod/v4";

/**
 * Canonical `envelope.type` literals for the four agent-presence actions.
 *
 * Each derives the `agent`-domain subject for its action — e.g.
 * `AGENT_ONLINE_TYPE` ("agent.online") derives
 * `local.{principal}.{stack}.agent.online`. Exposed as constants so producers
 * and subscribers filter without re-typing the string (mirrors
 * `AGENT_HEARTBEAT_TYPE` for the dispatch-scoped heartbeat).
 */
export const AGENT_ONLINE_TYPE = "agent.online" as const;
export const AGENT_HEARTBEAT_TYPE = "agent.heartbeat" as const;
export const AGENT_OFFLINE_TYPE = "agent.offline" as const;
export const AGENT_CAPABILITIES_CHANGED_TYPE = "agent.capabilities-changed" as const;

/**
 * The set of all agent-presence `envelope.type` literals, for exhaustive
 * subject/type filtering by a future subscriber.
 */
export const AGENT_PRESENCE_TYPES = [
  AGENT_ONLINE_TYPE,
  AGENT_HEARTBEAT_TYPE,
  AGENT_OFFLINE_TYPE,
  AGENT_CAPABILITIES_CHANGED_TYPE,
] as const;

export type AgentPresenceType = (typeof AGENT_PRESENCE_TYPES)[number];

/**
 * Capability-id grammar for presence payloads — dot-separated lowercase
 * segments (e.g. `code-review.typescript`). Identical rule to the config-side
 * `CapabilityIdSchema` (`src/common/types/capability.ts`); duplicated here so
 * the presence protocol does not couple to the config schema's internals. The
 * presence envelope carries only the capability IDS an agent currently
 * advertises (not the full rate/cost config envelope, which is principal-local).
 */
const PresenceCapabilityIdSchema = z
  .string()
  .min(1, "agent presence capability id is required and must be non-empty")
  .regex(
    /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/,
    "agent presence capability id must be dot-separated lowercase segments, each starting with a letter (e.g. 'code-review.typescript')",
  );

/**
 * Agent NKey public key — the stable cross-restart identity. The presence
 * protocol does not re-validate the NKey shape here (the envelope's
 * `signed_by[]` chain is the authoritative identity attestation); this is the
 * logical key the registry indexes records by.
 */
const NkeyPublicKeySchema = z
  .string()
  .min(1, "agent nkey public key is required and must be non-empty");

/**
 * RFC-3339 / ISO-8601 timestamp string. Kept as a string (matching the
 * envelope's own `timestamp` field) rather than a `Date` so the payload is
 * JSON-faithful on the wire.
 */
const IsoTimestampSchema = z
  .string()
  .min(1, "timestamp is required")
  .describe("ISO-8601 / RFC-3339 timestamp");

/**
 * The reason an agent went offline. `shutdown`/`restart` are graceful (the
 * agent emitted `agent.offline` itself); `error` is an abnormal exit the agent
 * still managed to announce. A TTL-lapse offline is inferred by the subscriber's
 * liveness FSM and never rides an `agent.offline` envelope (there is no agent
 * left to send one).
 */
export const AgentOfflineReasonSchema = z.enum(["shutdown", "restart", "error"]);
export type AgentOfflineReason = z.infer<typeof AgentOfflineReasonSchema>;

/**
 * Identity block shared by presence payloads — the logical agent identity a
 * subscriber keys its registry record on.
 *
 * - `nkey_public_key`: stable cross-restart identity.
 * - `agent_id`: the logical `agent.name` from `cortex.yaml` (`luna`, `echo`,
 *   `sage`, …). Stamped on the payload so dashboards can group by agent without
 *   parsing the envelope source triple (mirrors the cortex#361 heartbeat's
 *   `agent_id`).
 * - `assistant_name`: the Soma-layer assistant identity the agent hosts, when
 *   the agent is bound to one (an agent process is the stack-local identity; an
 *   assistant is the persistent named being). `null` when the agent hosts no
 *   named assistant.
 */
export const AgentPresenceIdentitySchema = z.object({
  nkey_public_key: NkeyPublicKeySchema,
  agent_id: z
    .string()
    .min(1, "agent_id is required and must be non-empty"),
  assistant_name: z.string().min(1).nullable(),
});
export type AgentPresenceIdentity = z.infer<typeof AgentPresenceIdentitySchema>;

/**
 * Scope block — the `{principal}.{stack}` the agent lives in. This is identity
 * provenance, NOT a network token: a federated `agent.*` envelope from
 * `andreas/work` carries `principal: "andreas"`, `stack: "work"`, and the
 * subscriber resolves which network that belongs to from the registry roster
 * (ADR-0001/0003) — the network name is never on the wire.
 */
export const AgentPresenceScopeSchema = z.object({
  principal: z
    .string()
    .min(1, "principal is required and must be non-empty"),
  stack: z.string().min(1, "stack is required and must be non-empty"),
});
export type AgentPresenceScope = z.infer<typeof AgentPresenceScopeSchema>;

/**
 * `agent.online` payload — emitted once on agent boot.
 *
 * Carries the full presence descriptor: identity, scope, the INITIAL capability
 * set (superseding the boot-time `agents.capabilities.registered` announce per
 * ADR-0007 §3), and the boot time. A subscriber upserts an `online` registry
 * record on receipt. Deliberately carries NO session interior (ADR-0005).
 */
export const AgentOnlinePayloadSchema = z.object({
  identity: AgentPresenceIdentitySchema,
  scope: AgentPresenceScopeSchema,
  /** Capability ids the agent advertises at boot. May be empty. */
  capabilities: z.array(PresenceCapabilityIdSchema).default([]),
  /** When the agent process booted. */
  started_at: IsoTimestampSchema,
});
export type AgentOnlinePayload = z.infer<typeof AgentOnlinePayloadSchema>;

/**
 * `agent.heartbeat` payload — emitted on a fixed interval while the agent is up
 * (idle or not). This is the PRESENCE heartbeat (ADR-0007 §1), distinct from the
 * dispatch-scoped `system.agent.heartbeat` (cortex#361). The subscriber's
 * liveness FSM keeps a record `online` while heartbeats arrive within the
 * 5-minute TTL, and transitions it to `offline` on TTL lapse.
 *
 * Carries only liveness — no capability list (that rides `online` /
 * `capabilities-changed`) and no dispatch progress (that is the OTHER
 * heartbeat's job).
 */
export const AgentHeartbeatPayloadSchema = z.object({
  identity: AgentPresenceIdentitySchema,
  scope: AgentPresenceScopeSchema,
  /** When this heartbeat was emitted. */
  sent_at: IsoTimestampSchema,
});
export type AgentHeartbeatPayload = z.infer<typeof AgentHeartbeatPayloadSchema>;

/**
 * `agent.offline` payload — emitted on graceful shutdown / restart, or on an
 * abnormal-but-announced exit (`error`). The liveness FSM transitions the record
 * to `offline` immediately on receipt (vs waiting out the TTL).
 */
export const AgentOfflinePayloadSchema = z.object({
  identity: AgentPresenceIdentitySchema,
  scope: AgentPresenceScopeSchema,
  reason: AgentOfflineReasonSchema,
  /** Optional human-readable detail (e.g. the error message for `error`). */
  detail: z.string().min(1).optional(),
  /** When the offline was emitted. */
  sent_at: IsoTimestampSchema,
});
export type AgentOfflinePayload = z.infer<typeof AgentOfflinePayloadSchema>;

/**
 * `agent.capabilities-changed` payload — emitted when an agent's advertised
 * capability set changes mid-life (plugin loaded, permission granted/revoked).
 * Carries the FULL new steady-state capability set (not a diff) so a subscriber
 * that missed an earlier delta still converges; the subscriber computes the diff
 * against its current record. Supersedes mid-life re-emission of
 * `agents.capabilities.registered` (ADR-0007 §3).
 */
export const AgentCapabilitiesChangedPayloadSchema = z.object({
  identity: AgentPresenceIdentitySchema,
  scope: AgentPresenceScopeSchema,
  /** The agent's full capability set AFTER the change. May be empty. */
  capabilities: z.array(PresenceCapabilityIdSchema).default([]),
  /** When the capability change was emitted. */
  sent_at: IsoTimestampSchema,
});
export type AgentCapabilitiesChangedPayload = z.infer<
  typeof AgentCapabilitiesChangedPayloadSchema
>;

/**
 * Map of `envelope.type` literal → the zod schema for its payload. Lets a
 * future subscriber validate an inbound presence envelope's payload by its
 * type without a switch statement. INERT in this slice — no caller yet.
 */
export const AGENT_PRESENCE_PAYLOAD_SCHEMAS = {
  [AGENT_ONLINE_TYPE]: AgentOnlinePayloadSchema,
  [AGENT_HEARTBEAT_TYPE]: AgentHeartbeatPayloadSchema,
  [AGENT_OFFLINE_TYPE]: AgentOfflinePayloadSchema,
  [AGENT_CAPABILITIES_CHANGED_TYPE]: AgentCapabilitiesChangedPayloadSchema,
} as const;
