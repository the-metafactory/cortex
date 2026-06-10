/**
 * @deprecated (G-1114.B.5, ADR-0007 decision 3) — superseded by `agent.online`.
 *
 * **Why deprecated.** `agents.capabilities.registered` is the legacy boot-time
 * capability-announce envelope. ADR-0007 (decision 3) establishes that it has
 * **zero routing consumers**: Offer-mode dispatch (cortex#237) routes on the
 * `tasks.{capability}` subject via JetStream consumer filters, NOT on a registry
 * lookup of this envelope. It is therefore **observability-only**. The
 * G-1114 agent-presence protocol's `agent.online` (carrying the initial
 * capability set) + `agent.capabilities-changed` (carrying deltas) **subsume
 * it** — `agent.online` is now the source of truth for "what does this agent
 * claim to do".
 *
 * **Dual-emit window (this is where B.5 lives).** Both signals fire at boot
 * already and independently:
 *   - `publishCapabilityRegistry()` (this module) → `agents.capabilities.registered`,
 *     one envelope per agent×non-empty-capability-set, wired at `src/cortex.ts`
 *     (the cortex#237 PR-7 block).
 *   - `AgentPresenceProducer.start()` (`src/runner/agent-presence-producer.ts`,
 *     G-1114.B.2) → `agent.online`, one per agent, wired at `src/cortex.ts`.
 * Both derive their capability set from the **same** field —
 * `agent.runtime.capabilities[]` (the dispatch-routing caps). So the
 * "dual-emit during the deprecation window" mandated by ADR-0007 is ALREADY
 * in force the moment both producers are wired; B.5 marks the deprecation and
 * pins the capability-consistency invariant rather than adding new wiring. The
 * consistency invariant is regression-tested in
 * `src/bus/__tests__/capability-registry-presence-consistency.test.ts`.
 *
 * **Retirement path (NOT this PR — a later step, ADR-0007 "dual-emit then
 * retire").** Once `agent.online` is confirmed as the sole source of truth and
 * any remaining external consumer of `agents.capabilities.registered` has cut
 * over to the presence feed, the retirement step removes:
 *   1. `publishCapabilityRegistry()` + `buildCapabilityRegisteredEnvelope()` +
 *      the `CAPABILITY_REGISTERED_EVENT_TYPE` constant from this module;
 *   2. the cortex#237 PR-7 boot block in `src/cortex.ts` that calls it;
 *   3. this whole file once nothing imports it.
 * Capability dispatch (cortex#237) is **untouched** by both the deprecation and
 * the eventual retirement — it never routed on this envelope (that is exactly
 * why retirement is safe).
 *
 * ---
 *
 * cortex#237 PR-3 — capability-registry publisher.
 *
 * Per `docs/design-capability-dispatch-review-consumer.md` §3 +
 * §10.1 PR-3, this module is the **publisher half** of the runtime
 * capability registry: it reads the parsed cortex.yaml (the Phase A.6
 * schema substrate already in place at `cortex-config.ts:429-456` +
 * `cortex-config.ts:1582` + the A.6.3 cross-validation at
 * `cortex-config.ts:1765-1787`) and emits one
 * `agents.capabilities.registered` envelope per agent×capability slice.
 *
 * **What this module is:**
 *
 * - A pure publisher: given a `(publish: PublishFn)` injected dependency
 *   and the parsed config (the `CortexConfig.agents[]` slice is the
 *   minimum required surface), iterate the agents and publish a
 *   registration envelope per agent that declares at least one
 *   capability via `agents[].runtime.capabilities[]`.
 *
 * - Idempotent across calls: re-invoking with the same config produces
 *   envelopes with the same `agent_id` payload key. The bucket consumer
 *   (pilot's pre-publish gate, deferred per §13.1) reads the registry
 *   keyed by `agent_id`; duplicate registrations overwrite the same
 *   logical slot rather than accumulating. Envelope `id` + `timestamp`
 *   are fresh per call (idempotency at the *bucket* not the *wire*).
 *
 * **What this module is NOT (deliberately, per §10.1 PR boundaries):**
 *
 * - NOT the schema. The `agents[].runtime.capabilities[]` field already
 *   ships at Phase A.6 (`cortex-config.ts:429-456` for the schema,
 *   `cortex-config.ts:1582` for the top-level catalog, cross-validation
 *   at `cortex-config.ts:1765-1787`). PR-3 consumes that shape verbatim.
 *
 * - NOT the schema extension for `sovereignty` + `maxConcurrent`. Those
 *   are PR-4's job (extend `AgentRuntimeSchema` with two sibling
 *   fields). When PR-4 lands, the publisher gains those fields on the
 *   payload without a wire break — both are optional today (omitted
 *   when undefined).
 *
 * - NOT the boot wiring. PR-7 wires `publishCapabilityRegistry()` into
 *   `src/cortex.ts`'s startup sequence after `mergedAgents` is built.
 *   PR-3 only ships the function; nothing imports it yet.
 *
 * - NOT a bucket reader. v1 is publish-only per §3.5; the bucket reader
 *   ships when pilot Phase B.4 needs it (open question §13.1, dedicated
 *   follow-up).
 *
 * - NOT a NATS client. The publisher takes a `(envelope) => Promise<void>`
 *   shape — the same shape as `MyelinRuntime.publish`. Tests inject a
 *   recording mock; production wires the real runtime. This keeps the
 *   module independent of the connection layer and trivially testable.
 *
 * - NOT a KV-bucket primitive. Architecture §7.2 specifies
 *   `local.{principal}.agents.capabilities.{agent_id}` as a NATS KV bucket;
 *   myelin's signed-KV API (myelin#31) is the right home for that
 *   primitive and hasn't shipped. v1 publishes a wire envelope on the
 *   regular subject (`local.{principal}.agents.capabilities.registered`, derived
 *   from the envelope type by the runtime's subject derivation per IAW
 *   Phase A.3). The KV-bucket write is a v2 layer on top.
 *
 * **Subject derivation (load-bearing for PR-7 wiring + pilot Phase B):**
 *
 * The runtime derives subjects from `(envelope.type, envelope.sovereignty.
 * classification, envelope.source's principal segment)`:
 *
 *   - classification `"local"` → subject `local.{principal}.{type}`
 *   - With stack segment (IAW A.5) → `local.{principal}.{stack}.{type}`
 *
 * So with `type: "agents.capabilities.registered"` and `classification:
 * "local"`, the published subject is
 * `local.{principal}.agents.capabilities.registered` (or `local.{principal}.{stack}.
 * agents.capabilities.registered` when a stack id is configured). The
 * `agent_id` discriminator lives in the **payload** (not the subject)
 * for v1; subscribers filter by payload field. The KV-bucket migration
 * in v2 moves the discriminator onto the subject as the bucket key.
 */

import type { Classification, Envelope } from "./myelin/envelope-validator";
import { buildBaseEnvelope } from "./envelope-builder";

// ---------------------------------------------------------------------------
// Public types — kept narrow so the publisher composes cleanly with both
// the real `MyelinRuntime.publish` and a recording mock.
// ---------------------------------------------------------------------------

/**
 * Publish injection — same shape as `MyelinRuntime.publish`. The
 * publisher does not instantiate a NATS client; the caller passes a
 * function that knows how to land the envelope on the wire.
 *
 * Production: `runtime.publish.bind(runtime)`.
 * Tests: `const sent: Envelope[] = []; const publish = async (e) => { sent.push(e); };`
 */
export type PublishFn = (envelope: Envelope) => Promise<void>;

/**
 * Envelope source struct — `{principal}.{agent}.{instance}` per
 * `src/bus/system-events.ts:SystemEventSource`. Duplicated structurally
 * here rather than re-imported because the registry is an
 * `agents.*`-domain emitter; the structural identity with
 * `SystemEventSource` is incidental, not a coupling we want to inherit
 * (a future change to `SystemEventSource` shouldn't ripple into the
 * registry).
 */
export interface CapabilityRegistrySource {
  /** Principal id — first dotted segment of `envelope.source`. */
  principal: string;
  /** Logical agent label for the *publisher* (typically `"cortex"`). */
  agent: string;
  /** Stable instance label — usually `"local"` for in-process emission. */
  instance: string;
  /**
   * Principal residency code for `envelope.sovereignty.data_residency`.
   * Defaults to `"NZ"` when omitted (matches the original cortex
   * deployment). Mirrors the same field on `SystemEventSource`.
   */
  dataResidency?: string;
}

/**
 * One agent's registration input — the *minimum* surface PR-3 needs
 * from the parsed config. Designed so the boot wiring (PR-7) can
 * project `Agent` → `CapabilityRegistryEntry` without re-importing the
 * full `CortexConfig` type into this module.
 */
export interface CapabilityRegistryEntry {
  /** Logical agent id (matches `Agent.id`). */
  agentId: string;
  /**
   * Capability ids the agent claims. Mirrors
   * `Agent.runtime.capabilities` from the Phase A.6 schema. An empty
   * array means "this agent has no capabilities to advertise" — the
   * publisher emits ZERO envelopes for such an agent (per spec §3.4:
   * "if agent.runtime?.capabilities?.length > 0").
   */
  capabilities: readonly string[];
}

/**
 * Options for `publishCapabilityRegistry()`. The boot wiring (PR-7)
 * builds this from the parsed cortex.yaml's `agents[]` (mapped to
 * `entries[]` by lifting `runtime.capabilities`) plus the principal's
 * source identity.
 *
 * `clock` + `instance` are injection seams so tests can assert exact
 * payload fields without time/host flakiness.
 */
export interface PublishCapabilityRegistryOptions {
  /** Source identity for `envelope.source` + sovereignty defaults. */
  source: CapabilityRegistrySource;
  /**
   * One entry per agent in the merged agents list. Agents with empty
   * `capabilities` are silently skipped (zero envelopes for them — see
   * `CapabilityRegistryEntry.capabilities` doc).
   */
  entries: readonly CapabilityRegistryEntry[];
  /**
   * Publisher injection — typically `runtime.publish.bind(runtime)`
   * in production, a recording mock in tests.
   */
  publish: PublishFn;
  /**
   * Optional instance label baked into the payload (`instance` field
   * per §3.2). Defaults to `source.instance` — principals running
   * multiple cortex daemons in the same principal namespace override
   * this to disambiguate.
   */
  instance?: string;
  /**
   * Optional clock injection — defaults to `() => new Date()`. Tests
   * inject a fixed clock to assert `registered_at` exactly without
   * tolerating ISO-string jitter.
   */
  clock?: () => Date;
  /**
   * Optional classification override. Defaults to `"local"` per
   * §3.2 ("sovereignty.classification: local"). Principals on a
   * federation policy may opt into `"federated"` to publish the
   * capability registry on `federated.{network}.agents.capabilities.
   * registered` so peer dashboards can render it; today the default is
   * the only call site. Mirror of the IAW Phase A.3 classification
   * parameter on the `system.*` + `dispatch.*` event helpers.
   */
  classification?: Classification;
}

// ---------------------------------------------------------------------------
// Constants — exported so PR-7 (boot wiring) and the future pilot-side
// reader can subscribe / route against the same string literals.
// ---------------------------------------------------------------------------

/**
 * Envelope `type` for a capability registration. Matches §3.2's spec:
 * "type: agents.capabilities.registered". The runtime derives the wire
 * subject from this (and from `sovereignty.classification`):
 *
 *   - local + no stack:  `local.{principal}.agents.capabilities.registered`
 *   - local + stack:     `local.{principal}.{stack}.agents.capabilities.registered`
 *   - federated:         `federated.{network}.agents.capabilities.registered`
 *
 * PR-7's subscriber matches against this constant rather than
 * stringly-typed literals; pilot's deferred bucket reader (§13.1) does
 * the same.
 */
/** @deprecated (G-1114.B.5, ADR-0007 decision 3) — superseded by the `agent.online` capability set; retire after the dual-emit window. */
export const CAPABILITY_REGISTERED_EVENT_TYPE = "agents.capabilities.registered" as const;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function buildSource(src: CapabilityRegistrySource): string {
  return `${src.principal}.${src.agent}.${src.instance}`;
}

/**
 * Default sovereignty posture for capability-registration envelopes.
 * Matches §3.2 verbatim: `classification: local` (principal-private
 * unless overridden), residency from `source.dataResidency` (defaulting
 * to `"NZ"`), max_hop 0, no frontier, local-only model class.
 *
 * Returned as a fresh literal per call so downstream mutation on one
 * envelope's `sovereignty` can't leak into a sibling.
 */
function defaultRegistrySovereignty(
  source: CapabilityRegistrySource,
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
// Envelope builder — pure, no side effects. Useful in tests that want
// to assert envelope shape without going through the publisher mock.
// ---------------------------------------------------------------------------

/**
 * Inputs to `buildCapabilityRegisteredEnvelope`. Shape mirrors the
 * payload fields from §3.2 (plus the source/sovereignty plumbing).
 */
export interface BuildCapabilityRegisteredEnvelopeOpts {
  source: CapabilityRegistrySource;
  agentId: string;
  /** Capability ids — emitted verbatim into the `capabilities` payload field. */
  capabilities: readonly string[];
  /** ISO-8601 registration moment (the `registered_at` payload field). */
  registeredAt: Date;
  /** Instance label (the `instance` payload field). */
  instance: string;
  /** Optional classification override; defaults to `"local"`. */
  classification?: Classification;
}

/**
 * Construct one `agents.capabilities.registered` envelope per §3.2.
 *
 * Pure function — no I/O. The publisher (`publishCapabilityRegistry`)
 * calls this once per agent-with-capabilities and hands the result to
 * the injected `publish` function.
 *
 * Payload fields per §3.2 (in source-spec order so a future field
 * addition lands in the same row):
 *
 *   - `agent_id`       — discriminator for the per-agent bucket slot.
 *   - `capabilities`   — verbatim from the input (string[]).
 *   - `registered_at`  — ISO timestamp the registration was emitted at.
 *   - `instance`       — host/instance label (per §3.2 example
 *                        `"andreas.cortex.local"`).
 *
 * **Deliberately absent from PR-3:** `sovereignty` + `max_concurrent`
 * payload fields. Those are PR-4's job (extends `AgentRuntimeSchema`
 * with the two knobs); the publisher gains those payload fields in PR-4
 * once the schema can carry them. Adding placeholder fields here would
 * be schema-drift in the other direction (advertising capacity we don't
 * have).
 *
 * @deprecated (G-1114.B.5, ADR-0007 decision 3) — superseded by
 * `createAgentOnlineEvent` (`src/bus/agent-network/builders.ts`); both carry
 * the same `agent.runtime.capabilities[]` set. Retire after the dual-emit
 * window once `agent.online` is the sole source of truth.
 */
export function buildCapabilityRegisteredEnvelope(
  opts: BuildCapabilityRegisteredEnvelopeOpts,
): Envelope {
  return buildBaseEnvelope({
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- intra-module reference inside the deprecated producer itself (B.5 dual-emit window); the whole module retires together.
    type: CAPABILITY_REGISTERED_EVENT_TYPE,
    source: buildSource(opts.source),
    sovereignty: defaultRegistrySovereignty(opts.source, opts.classification),
    payload: {
      agent_id: opts.agentId,
      capabilities: [...opts.capabilities],
      registered_at: opts.registeredAt.toISOString(),
      instance: opts.instance,
    },
  });
}

// ---------------------------------------------------------------------------
// Publisher — iterates the merged agents list and emits one envelope
// per agent that has at least one capability.
// ---------------------------------------------------------------------------

/**
 * Publish one `agents.capabilities.registered` envelope per agent in
 * `opts.entries` whose `capabilities` array is non-empty.
 *
 * Per §3.4:
 *
 *   for each agent in mergedAgents:
 *     if agent.runtime?.capabilities?.length > 0:
 *       capabilityRegistry.register({ agentId, capabilities, ... })
 *
 * **Concurrency:** envelopes are published sequentially (not in
 * parallel). The cortex runtime's `publish()` is fire-and-forget at
 * the NATS layer (`Promise<void>` resolves immediately for Core NATS),
 * so sequential ordering doesn't cost wall-clock latency and gives the
 * boot path a deterministic emission order — useful for log grepping
 * and integration-test assertions. If the underlying publish ever
 * upgrades to `JetStream.publish` (per the comment on
 * `MyelinRuntime.publish`), sequential emission preserves at-least-once
 * ordering without needing a separate ack-coordinator.
 *
 * **Error handling:** the publisher does NOT catch errors thrown by
 * `publish` — those propagate to the caller (boot path in PR-7).
 * Rationale: a publish failure during startup is a real signal (the
 * runtime is misconfigured or the bus is unreachable) and the boot
 * path is the right place to decide whether to fail loud or downgrade
 * to a `system.*` event. Catching here would silently swallow that
 * signal and violate the "no empty catch blocks" rule.
 *
 * **Idempotency:** invoking twice with the same `entries` re-publishes
 * the same logical registrations with fresh envelope ids/timestamps.
 * Bucket consumers (the deferred reader per §13.1) key by `agent_id`
 * payload field and overwrite on re-receive — so re-publish is a no-op
 * at the bucket layer. The wire side may see duplicates; subscribers
 * deduplicate by `agent_id` per §3.3 contract.
 *
 * Returns the array of envelopes that were published, in emission
 * order. Useful for boot-path logging ("registered N capabilities for
 * M agents") without re-deriving the count from the publish mock.
 *
 * **DEPRECATED (G-1114.B.5, ADR-0007 decision 3)** — observability-only with
 * zero routing consumers; superseded by `AgentPresenceProducer.start()`'s
 * `agent.online` emission (`src/runner/agent-presence-producer.ts`). Both run
 * at boot and derive capabilities from the same `agent.runtime.capabilities[]`
 * field, so this is the legacy half of the ADR-0007 dual-emit window. Retire
 * (remove this function + its `src/cortex.ts` boot block) after the window;
 * capability dispatch is untouched by the removal.
 *
 * NOTE: this entry point uses a `DEPRECATED:` prose marker rather than the
 * machine `@deprecated` tag (which the constant + envelope-builder DO carry)
 * deliberately — its sole production call site lives in `src/cortex.ts`, owned
 * by a parallel work-stream during this window; emitting the `@deprecated`
 * lint signal there would force a cross-stream edit. The prose marker keeps the
 * deprecation explicit + greppable without that coupling. When the retirement
 * step removes the `src/cortex.ts` boot block, promote this back to `@deprecated`
 * (or just delete the function).
 */
export async function publishCapabilityRegistry(
  opts: PublishCapabilityRegistryOptions,
): Promise<Envelope[]> {
  const clock = opts.clock ?? (() => new Date());
  const instance = opts.instance ?? opts.source.instance;
  const published: Envelope[] = [];

  for (const entry of opts.entries) {
    if (entry.capabilities.length === 0) {
      // Spec §3.4: only register agents with at least one capability.
      // Skipping silently is the right move — an inline agent
      // declaring `runtime.capabilities: []` (or omitting `runtime`
      // entirely) is a valid config; it just doesn't participate in
      // capability dispatch.
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-deprecated -- intra-module reference inside the deprecated producer (B.5 dual-emit window); the whole module retires together.
    const envelope = buildCapabilityRegisteredEnvelope({
      source: opts.source,
      agentId: entry.agentId,
      capabilities: entry.capabilities,
      registeredAt: clock(),
      instance,
      ...(opts.classification !== undefined && { classification: opts.classification }),
    });

    await opts.publish(envelope);
    published.push(envelope);
  }

  return published;
}
