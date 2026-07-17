/**
 * G-1100.E: Myelin runtime — opt-in startup hook for cortex.
 *
 * Reads `cortex.yaml.nats?` and, if present, opens a NatsLink and starts a
 * MyelinSubscriber per configured subject pattern. Logs received
 * envelopes (subject + envelope.id + correlation_id + type) for
 * visibility — no fan-out to existing handlers in this slice; that's
 * G-1101+ work.
 *
 * Coupling rule (per docs/design-collaboration-surface.md §9):
 * If `cortex.yaml.nats` is absent, this module is a no-op — cortex starts
 * without NATS just as it always has. The agent stays installable
 * without a NATS server present.
 */

import type { ConnectionOptions, NatsConnection } from "nats";
import type { AgentConfig } from "../../common/types/config";
import type { PolicyFederatedNetwork } from "../../common/types/cortex-config";
import { NatsLink } from "../nats/connection";
import {
  buildNatsTlsOptions,
  warnFederatedCleartext,
  type MtlsMode,
  type MtlsPaths,
  type FederatedCleartextWarning,
} from "../../common/config/transport-mtls";
import {
  MyelinSubscriber,
  type EnvelopeErrorHandler,
  type EnvelopeHandler as SubscriberEnvelopeHandler,
} from "./subscriber";
import {
  deriveNatsSubject,
  principalFromConfig,
  type Envelope,
} from "./envelope-validator";
// IAW Phase B.3 — sign outbound envelopes via myelin's chain-aware
// signer. Import discipline matches B.1c: the constrained `/identity`
// subpath keeps tsc out of myelin's full source tree.
import { signEnvelope } from "@the-metafactory/myelin/identity";
// M3 (cortex#1241, ADR-0019) — per-network payload sealing on the OUTBOUND
// publish path. Encrypt-then-sign: seal `payload` with the network key FIRST,
// then the existing `signEnvelope` below signs the ciphertext. Dormant unless a
// `policy.federated.networks[]` entry sets `encryption: enabled|required`.
import { sealPayload } from "../../common/crypto/payload-encryption";
import {
  buildSealPolicyByPrincipal,
  countEncryptionEnabledNetworks,
  type NetworkSealPolicy,
} from "../../common/crypto/network-encryption-policy";

/**
 * Per-envelope handler. Receives validated envelopes from any active
 * subscription, with the actual NATS subject (so wildcard-pattern
 * subscribers can route on the concrete subject — see
 * `src/bus/surface-router.ts`, G-1111.A).
 *
 * IAW Phase F-3d (cortex#666) — `sourceLink` ADDITIVELY tags WHICH pool
 * link (and therefore which federation network) delivered an inbound
 * envelope. It is the delivering link's `linkId`:
 *
 *   - `"primary"` — the `config.nats` link (local/public + every back-compat
 *     case: zero per-network `nats:` ⇒ the only link ⇒ always `"primary"`).
 *   - a `leaf_node` name — a per-network federated leaf (F-3a Option B).
 *
 * The value is the pool's de-dup key for the delivering link, which is the
 * `leaf_node` the F-3d anti-spoof + surface-router federated gate cross-check
 * the subject's `{network_id}` segment against (a subject claiming
 * `federated.{X}.…` that arrived on a link NOT owning network X is a spoof,
 * per design §3.3 / §5). `undefined` when the delivery site has no link
 * context (test-only direct `dispatch` calls, and disabled-runtime handlers
 * that never fire).
 *
 * **Back-compat:** the third arg is optional + trailing, so every existing
 * `(envelope, subject)` handler keeps its byte-identical shape — TypeScript
 * permits a 2-arg function where a 3-arg type is expected (parameter
 * bivariance on the extra trailing param). Single-link deployments always see
 * `sourceLink === "primary"`, which is exactly the pre-F-3d behaviour with one
 * extra, ignorable fact attached.
 *
 * This slice provides the HOOK; per-network signed-federation verify
 * (TC-2d, cortex#635) is the consumer that turns the attribution into a
 * cryptographic peer-pubkey lookup keyed off the delivering network.
 */
export type EnvelopeHandler = (
  envelope: Envelope,
  subject: string,
  sourceLink?: string,
) => void;

/** Lifecycle handle so cortex can clean up on shutdown. */
export interface MyelinRuntime {
  readonly enabled: boolean;
  /**
   * Register a fan-out handler. Multiple handlers may register; each
   * receives every envelope from every active subscription. Returns
   * an unregister token so the caller can detach on shutdown.
   *
   * The runtime's existing `logEnvelope` always runs alongside any
   * registered handlers — registration is additive, not a replacement.
   */
  onEnvelope(handler: EnvelopeHandler): { unregister: () => void };
  /**
   * Publish an envelope to NATS.
   *
   * Subject is derived from `envelope.sovereignty.classification` +
   * `envelope.type` per G-1111 §3.1 and the myelin grammar:
   *
   *   - `classification === "local"`     → `local.{principal}.{type}`
   *   - `classification === "federated"` → `federated.{principal}.{type}`
   *   - `classification === "public"`    → `public.{type}` (no `{principal}` segment)
   *
   * `{principal}` is the first dotted segment of `envelope.source` (which
   * cortex's `system-events.ts` etc. populate from the boot-resolved
   * `principal.id`).
   * The 1:1 alignment between subject prefix and `sovereignty.classification`
   * is myelin's protocol-level invariant — see
   * {@link validateSubjectEnvelopeAlignment}.
   *
   * **IAW Phase A.3:** prior to this slice the runtime hardcoded
   * `local.{principal}.{type}` here, making federated/public emission structurally
   * impossible. Subject derivation now mirrors classification, so an emit
   * site that opts into `classification: "federated"` flows end-to-end
   * (envelope + subject) without further runtime changes.
   *
   * **No-op when the runtime is disabled** (no NATS configured) so callers
   * can fire-and-forget without checking `enabled` first. This matters at
   * the adapter layer, where `runtime.publish(...)` may run on every shard
   * disconnect / recover regardless of principal NATS configuration.
   *
   * Errors at publish time are logged and swallowed — emitting an
   * operational `system.*` event must not crash the bot, especially when
   * the bot is already in a degraded state. JetStream durability
   * (per design-cortex.md §3.3) is the safety net for lost events.
   *
   * Resolves immediately — Core NATS publishes are fire-and-forget at the
   * client layer; the `Promise<void>` shape leaves room to upgrade to
   * `JetStream.publish` (which IS async) without breaking callers.
   */
  publish(envelope: Envelope): Promise<void>;
  /**
   * Publish an envelope on an EXPLICIT subject — Direction A Stage 4
   * (cortex#409) escape hatch for callers that need a subject shape
   * `deriveNatsSubject` can't synthesise from `envelope.type` alone.
   *
   * Canonical use today: inbound `tasks.@{did-encoded-assistant}.{capability}`
   * (e.g. `tasks.@did-mf-cortex.chat`) — the envelope `type` schema
   * forbids `@`, so `runtime.publish(envelope)` would land on
   * `local.{principal}.{stack}.tasks.{capability}` and miss the
   * dispatch-listener's `tasks.@*.>` wildcard. Callers compose the
   * canonical subject with `directTaskSubject`-style helpers (from
   * `@the-metafactory/myelin/subjects`) and pass it here directly.
   *
   * Signs the envelope (when a signer is configured) before publish,
   * same as `publish()`. The classification↔subject-prefix invariant
   * (`local.` ↔ `classification: "local"`) is the caller's
   * responsibility — this method does NOT validate alignment; it
   * trusts the caller because the whole point is to break out of the
   * default derivation.
   *
   * **No-op when the runtime is disabled** — mirrors `publish()`.
   *
   * **Optional on the interface** so existing fake-runtime test stubs
   * (which currently expose only `publish`) keep their byte-identical
   * shape; tests that exercise the canonical-subject path opt in by
   * adding the property. Production callers that need the canonical
   * path MUST treat an undefined property as "runtime cannot publish
   * on explicit subjects" and fall back to the legacy code path —
   * matches the same defensive contract as `subscribePull`.
   */
  publishOnSubject?(envelope: Envelope, subject: string): Promise<void>;
  /**
   * Bind a JetStream pull-consumer subscription via the runtime's
   * private `NatsLink`. The runtime stays the single owner of the raw
   * connection lifecycle — callers see a `MyelinSubscriber` handle and
   * never the bare link.
   *
   * Used by `ReviewConsumer.start` (cortex#237 PR-6) and any future
   * capability-dispatch consumer that needs JetStream pull semantics
   * (architecture §7.2). Push-mode subscribers continue to flow via
   * `onEnvelope()` fan-out and don't go through this helper.
   *
   * **Returns `null` when the runtime is disabled** (no NATS configured
   * or connect failed). Callers that need a hard "subscribe or fail"
   * signal MUST check `runtime.enabled` first or treat the `null` return
   * as a deliberate no-op (boot wiring's contract: capability-side
   * features remain dormant when the bus is absent).
   *
   * **Optional on the interface** so existing fake-runtime test stubs
   * (surface-router, slack-adapter, bus-dispatch-listener, …) keep
   * their byte-identical shapes without an in-bulk update — the
   * additivity constraint per Architect's cortex#290 review. Callers
   * that depend on the helper (today: `ReviewConsumer.start`) MUST
   * treat an undefined property as equivalent to `null` — i.e. "no
   * pull subscriptions wired" — and stay dormant.
   */
  subscribePull?(opts: MyelinSubscribePullOpts): MyelinSubscriber | null;
  /**
   * cortex#477 — bind an ADDITIONAL push-mode subscription to the
   * underlying NATS link, beyond whatever `nats.subjects[]` already
   * configured at boot. The returned subscriber's `onEnvelope` fans
   * out through the same per-runtime handler set as the static
   * `nats.subjects` subscribers, so any `runtime.onEnvelope` handler
   * (incl. the `SurfaceRouter`'s) receives matching envelopes
   * automatically — callers do NOT pass their own handler.
   *
   * **Why this exists.** Listeners (today: `createDispatchListener`)
   * derive their canonical subject pattern programmatically from the
   * running principal + stack (e.g.
   * `local.{principal}.{stack}.tasks.*.>`). Pre-#477 they relied on
   * `nats.subjects[]` in `cortex.yaml` being a superset of that
   * pattern — an unenforced cross-config invariant that silently
   * broke on deployments whose config wasn't kept in lockstep with
   * the listener's declared interest. `subscribe()` lets the listener
   * self-subscribe at `start()` time, symmetric with
   * `ReviewConsumer`'s `subscribePull` model, and drops the
   * cross-config invariant entirely.
   *
   * **Returns `null` when the runtime is disabled** (no NATS configured,
   * connect failed). Callers MUST tolerate the null return — same
   * defensive contract as `subscribePull` — so push-mode listeners
   * stay dormant when the bus is absent without aborting boot.
   *
   * The runtime tracks the returned subscriber on its internal
   * `subscribers[]` list, so `runtime.stop()` drains it alongside the
   * boot-time push subscribers — callers don't have to call
   * `subscriber.stop()` themselves on runtime shutdown (though they
   * MAY do so on listener-scoped teardown, which is the dispatch-
   * listener's pattern).
   *
   * **Optional on the interface** so existing fake-runtime test stubs
   * keep their byte-identical shapes — additivity constraint same as
   * `subscribePull`. Callers MUST treat an undefined property as
   * equivalent to a `null` return.
   */
  subscribe?(pattern: string): Promise<MyelinSubscriber | null>;
  /**
   * Resolve a narrow provisioning capability against the underlying
   * link, or `null` when the runtime is disabled (no NATS configured
   * or connect failed).
   *
   * Used by the boot path to provision streams + per-agent durables
   * (cortex#338) before `ReviewConsumer.start` binds to them. The
   * return type is the narrow `ProvisionJsm` interface (subset of
   * nats.js's `JetStreamManager` we actually use) rather than the
   * concrete manager — the runtime stays decoupled from nats.js's
   * full surface, and tests can pass a stub satisfying the same
   * narrow shape (sage review on #338 → architecture).
   *
   * Like `subscribePull`, this is OPTIONAL on the interface so
   * existing fake-runtime stubs in tests stay byte-identical until
   * each test file opts in.
   *
   * Returns a Promise to match nats.js's `nc.jetstreamManager()`
   * shape — the first call does a server round-trip; subsequent calls
   * are cached.
   */
  jetstreamManager?(): Promise<import("../jetstream/types").ProvisionJsm | null>;
  /**
   * R26 P1 (cortex#1371) — resolve a narrow NATS-KV capability against the
   * PRIMARY link (same single-link rationale as `jetstreamManager`), or
   * `null` when the runtime is disabled. Opens (creating if absent —
   * nats.js's `views.kv` is create-or-bind) the named KV bucket and returns
   * the narrow `ProvisionKv` surface the admission gate consumes
   * (get / create / CAS-update). Boot-path only today (the admission
   * provisioning call) — no per-call caching; callers hold the returned
   * handle for the process lifetime.
   *
   * OPTIONAL on the interface for the same additivity reason as
   * `jetstreamManager` — existing fake-runtime test stubs keep their shapes;
   * callers MUST treat an undefined property as a `null` return.
   */
  kvBucket?(name: string): Promise<import("../jetstream/types").ProvisionKv | null>;
  /** Best-effort shutdown — drains subscribers, closes the link. */
  stop(): Promise<void>;
}

/**
 * Pull-mode subscription parameters surfaced by {@link MyelinRuntime.subscribePull}.
 *
 * Mirrors `MyelinSubscriberOptions.pull` + the outer `pattern` / `onEnvelope`
 * fields but keeps the bare `NatsLink` private to the runtime. Caller
 * passes the JetStream stream + durable consumer name (the consumer MUST
 * already exist server-side — `subscribePull` binds, it does NOT
 * provision); the runtime threads its captured link into
 * `MyelinSubscriber.start` on the caller's behalf.
 *
 * The handler may return an `AckDecision` to drive JetStream ack/nak/term
 * explicitly (cortex#237 PR-1 — the four-way nak taxonomy the review
 * consumer relies on). A void / undefined return remains the legacy
 * resolve-as-ack default.
 */
export interface MyelinSubscribePullOpts {
  /** Subject pattern, e.g. `local.{principal}.tasks.code-review.>`. */
  pattern: string;
  /** JetStream stream name carrying the bound consumer. */
  stream: string;
  /** Durable consumer name. The consumer MUST exist server-side. */
  durable: string;
  /** Per-envelope handler. May return an AckDecision (see subscriber.ts). */
  onEnvelope: SubscriberEnvelopeHandler;
  /** Optional sink for handler throws. */
  onError?: EnvelopeErrorHandler;
  /** Optional consume() tuning forwarded to the subscriber. */
  maxMessages?: number;
  expiresMs?: number;
  thresholdMessages?: number;
}

/**
 * Start the myelin runtime if `config.nats?` is present. Returns a
 * `MyelinRuntime` whose `enabled` field reflects whether anything was
 * actually started. Errors during startup are logged and swallowed —
 * a misconfigured NATS section must NOT crash the bot (the rest of
 * grove keeps working without it).
 */
/**
 * Internal/test-only options. Production callers pass `config` only;
 * tests inject a fake `connectImpl` to avoid standing up a real
 * `nats-server`. The shape mirrors `NatsLink.connect`'s own seam
 * (typed against `ConnectionOptions` from `nats`) so a fake here is a
 * fake there — no `unknown`, no `as never` casts.
 *
 * @internal — not meant for production use; the constructor signature
 *             may change without semver guarantees.
 */
export interface MyelinRuntimeOptions {
  connectImpl?: (opts: ConnectionOptions) => Promise<NatsConnection>;
  /**
   * IAW Phase B.3 (cortex#114) — outbound envelope signer. When set,
   * `publish()` signs every outbound envelope via myelin's
   * `signEnvelope` before NATS publish; the envelope's `signed_by[]`
   * gains a fresh ed25519 stamp committed to the JCS-canonical bytes
   * of `{...envelope, signed_by: [...prior, newStamp]}`. Multi-hop
   * envelopes (forwarded across stacks) append rather than replace —
   * the prior chain is preserved.
   *
   * When undefined, `publish()` emits envelopes verbatim — same shape
   * as today, unchanged for callers that haven't opted in. Principals
   * stage the keypair via `cortex.yaml.stack.nkey_seed_path` + the
   * `loadStackSigningKey` loader (chmod 600 gated; `SU` prefix
   * required); the entrypoint wires the loaded keypair + the stack's
   * DID-shaped principal into this option.
   */
  signer?: BusEnvelopeSigner;
  /**
   * IAW Phase B.3 (cortex#114) — behaviour when the signer is
   * configured but `signEnvelope` itself throws (malformed seed,
   * unsupported principal DID format, etc.).
   *
   * - `'fallback'` (default) — log the error, publish the envelope
   *   UNSIGNED. Acceptable while the receive side
   *   (`verifyEnvelopeIdentity`) is not yet enforcing on the
   *   subscribe path (B.3 ships in that window). The bus tolerates
   *   unsigned envelopes today; a transient sign failure doesn't
   *   crash the publish path or drop the operational signal.
   *
   * - `'drop'` — log the error and SKIP the publish entirely. The
   *   envelope never reaches the wire. Use this once the receive
   *   side becomes enforcing — at that point publishing unsigned is
   *   a silent downgrade attack surface (an attacker who can fault-
   *   inject the signer would otherwise get the daemon to emit
   *   unsigned envelopes; peers in a rollout window that tolerate
   *   unsigned would accept the bypass). Flip to `'drop'` is
   *   tracked at cortex#210.
   *
   * Ignored when `signer` is undefined (no signer means no failure
   * mode to choose).
   */
  signFailureMode?: "fallback" | "drop";
  /**
   * IAW Phase A.5 (cortex#113 / closes cortex#262) — principal stack
   * segment slotted into the published subject between `{principal}` and
   * `{type}`. When set, `publish()` derives subjects in the 6-segment
   * stack-aware shape `local.{principal}.{stack}.{type}` matching post-myelin#113
   * subscribers (sage's bridge, cedar's dispatch, pilot's review-request
   * subscriber). When undefined, `publish()` falls through to the legacy
   * 5-segment form `local.{principal}.{type}` — preserves identity for callers
   * that haven't wired stack identity yet.
   *
   * The entrypoint (`src/cortex.ts` ~line 386) sources this from
   * `deriveStackId(loadedConfig)` so a multi-stack deployment routes
   * envelopes through the right wildcard. The `'default'` fallback that
   * `deriveStackId` provides is what arrives here when the principal
   * omits the `stack:` block — that matches sage's bridge default
   * (`SAGE_STACK=default`) so the Offer loop closes end-to-end.
   */
  stack?: string;
  /**
   * cortex#429 PR-C — boot-resolved principal id used to substitute
   * `{principal}` in subscribe-side subject patterns. Replaces the
   * prior read from `config.agent.operatorId` (removed together with
   * the schema field). The entrypoint passes the value resolved by
   * `resolvePrincipalId(options.principal)`; when undefined, the
   * substituter falls back to `"default"` to preserve legacy NATS-less
   * runtime no-op semantics.
   */
  principal?: string;
  /**
   * IAW Phase F-3b (cortex#659) — the federation networks the runtime
   * builds its `LinkPool` from. Sourced from `policy.federated.networks[]`
   * (which already flows through `cortex.ts` boot, separate from the
   * `AgentConfig` this function takes). Each network that declares an
   * inline `nats:` block (F-3a, Option B — `docs/design-multi-network.md`
   * §2) contributes one leaf `NatsLink`, keyed by `leaf_node` (the pool /
   * de-dup key: two networks sharing a `leaf_node` share one physical
   * link). Networks WITHOUT a `nats:` block ride the `primary` link.
   *
   * **Back-compat:** when undefined or empty — or when no network declares
   * a `nats:` block — the pool contains ONLY the `primary` link and every
   * publish routes to it, byte-identical to the pre-F-3b single-link
   * runtime. This is the load-bearing zero-network no-op invariant
   * (design §3, §7.4).
   */
  federatedNetworks?: readonly PolicyFederatedNetwork[];
  /**
   * IAW Phase F-3b (cortex#659) — sink for publish-routing errors. The
   * design (§3.2) calls for a `system.error`
   * (`unknown_network_in_publish_subject`) + skip when a publish resolves
   * to a `federated.{unknown}.*` subject (a network with no leaf in the
   * pool). The runtime has no `SystemEventSource` wired and publishing a
   * system envelope from inside the publish-routing path would itself need
   * to route (back to `primary`) with a recursion hazard — so F-3b
   * surfaces the signal through this structured callback (defaulting to a
   * `console.error` with the canonical reason) rather than a typed bus
   * envelope. A later slice (F-3c / inbound attribution, design §3.3/§8)
   * can promote it to a real `system.error` audit envelope by wiring a
   * source here. Tests use this seam to capture the routing error
   * deterministically.
   */
  onRoutingError?: (info: RoutingError) => void;
  /**
   * IAW Phase F-3c (cortex#662) — background-reconnect backoff tuning for
   * leaf links that are down at boot (or drop later). Per the RATIFIED
   * degrade-don't-crash contract (OD-F3-2), a federated leaf that fails to
   * connect must NOT crash cortex: the network goes dark / fails closed, the
   * primary link governs `enabled`, and the runtime retries the leaf in the
   * BACKGROUND with a bounded exponential backoff. When the leaf comes up the
   * pool re-attaches it and routing to that network resumes.
   *
   * `NatsLink` already sets `reconnect: true`, so an ESTABLISHED leaf that
   * drops mid-flight is reconnected by nats.js itself — F-3c owns the
   * boot-time-unreachable + pool re-attach gap (nats.js can't reconnect a
   * connection that never connected).
   *
   * Defaults (when omitted) give a gentle, bounded ladder that never spins:
   *   - `initialMs`: 1_000  (first retry after 1s)
   *   - `maxMs`:     30_000 (cap the doubling at 30s)
   *   - `factor`:    2      (exponential)
   *
   * **Back-compat:** purely additive. With ZERO leaf links (no per-network
   * `nats:`), no lifecycle machinery engages and this field is never read —
   * the runtime is byte-identical to the pre-F-3b single-link path.
   *
   * @internal — tuning surface for tests (inject a tiny `initialMs` so the
   *             reconnect fires deterministically without real wall-clock
   *             waits) and for principals who need a faster/slower ladder.
   */
  reconnectBackoff?: {
    initialMs?: number;
    maxMs?: number;
    factor?: number;
  };
  /**
   * IAW Phase F-3c (cortex#662) — test-only timer seam. When set, the
   * background-reconnect scheduler calls `setTimer(cb, ms)` instead of the
   * global `setTimeout`, and `clearTimer(handle)` instead of `clearTimeout`.
   * Lets tests drive the backoff deterministically (run the pending timer
   * synchronously) AND assert that `stop()` cancels a pending reconnect (no
   * leaked timer / no post-stop reconnect). Production omits this and the
   * runtime uses the real timers.
   *
   * @internal — not for production use.
   */
  reconnectTimer?: {
    setTimer: (cb: () => void, ms: number) => ReconnectTimerHandle;
    clearTimer: (handle: ReconnectTimerHandle) => void;
  };
  /**
   * TC-4d/4e (#627 Phase 4) — transport-mTLS posture for the LinkPool. The
   * runtime builds a `tls` block (via `buildNatsTlsOptions`) for the PRIMARY
   * link AND each federated leaf link, gated by `mode`:
   *
   *   - `off` (default / omitted) — no `tls` on any link; plaintext,
   *     byte-identical to the pre-TC-4d single-link AND F-3 multi-link paths.
   *   - `on` — offer a client cert when the cert/key/ca paths load; degrade
   *     to plaintext (loud warning) when they don't.
   *   - `require` — every link MUST present a client cert; a missing/invalid
   *     cert FAILS CLOSED (the connect throws — primary failure disables the
   *     runtime, a leaf failure leaves that network dark per the F-3c contract).
   *
   * Cross-principal federated leaves especially want mTLS, so the same posture
   * applies to leaf links — and a federated leaf that connects WITHOUT TLS
   * triggers the {@link warnFederatedCleartext} advisory regardless of mode.
   *
   * **Back-compat:** when omitted (or `mode: "off"`), no tls machinery
   * engages — the pool is byte-identical to today.
   */
  transportMtls?: {
    mode: MtlsMode;
    paths?: MtlsPaths;
    /**
     * Optional structured sink for the federated-leaf-cleartext warning. The
     * runtime has no `SystemEventSource`; a caller that does can pass a sink
     * here to promote the stderr advisory to a `system.error` audit envelope.
     */
    onFederatedCleartext?: (info: FederatedCleartextWarning) => void;
  };
}

/**
 * IAW Phase F-3c (cortex#662) — opaque, non-null handle for a scheduled
 * background-reconnect timer. The real timer seam returns the Node/Bun
 * `setTimeout` handle; the test seam returns its own bookkeeping object.
 * Modelled as a non-null `object` so a `reconnectHandle !== null` check
 * (the "is a retry pending?" predicate) is meaningful and lint-clean.
 */
export type ReconnectTimerHandle = object;

/**
 * IAW Phase F-3b (cortex#659), reworked for ADR 0001 (supersedes cortex#661) —
 * structured publish-routing error surfaced via
 * {@link MyelinRuntimeOptions.onRoutingError}. The only `reason` is
 * `unknown_network_in_publish_subject`: a `federated.{principal}.{stack}.*`
 * publish whose TARGET PRINCIPAL (subject segment[1]) resolves to no leaf via
 * the `peers[]` topology map. The reason literal is kept stable across the ADR
 * for callback-contract compatibility; the discriminated shape leaves room for
 * additional routing failure modes without breaking the contract.
 */
export interface RoutingError {
  reason: "unknown_network_in_publish_subject";
  /** The resolved subject the publish targeted. */
  subject: string;
  /**
   * The subject segment that failed to resolve to a pool link. Under ADR 0001
   * this is the TARGET PRINCIPAL (`federated.{principal}.…` segment[1]) — the
   * network is no longer on the wire. Field name retained for the stable
   * discriminated shape; reads as "the unresolved routing key".
   */
  networkId: string;
  /** The envelope id, for joinability with the audit/event stream. */
  envelopeId: string;
}

/**
 * Outbound envelope signer surface — what `MyelinRuntime` needs to
 * sign a single envelope. Kept narrow so test doubles + future
 * hardware-backed signers (yubikey / TPM) can implement without
 * leaking the `nkeys.js` KeyPair shape across module boundaries.
 *
 * `rawSeedBytes` is the 32-byte ed25519 seed — what myelin's
 * `signEnvelope` consumes after base64-encoding. Production callers
 * pass `keyPair.getRawSeed()` directly; tests construct from a
 * generated keypair.
 *
 * `principal` is the DID-shaped string that lands on the new stamp's
 * `signed_by[].identity` field (R11 — renamed from `principal` per
 * myelin#184). Convention: `did:mf:<name>` per myelin spec.
 */
export interface BusEnvelopeSigner {
  rawSeedBytes: Uint8Array;
  principal: string;
}

/**
 * Build a `{principal}` + `{stack}.` placeholder substituter for principal-
 * configured subject patterns (cortex#269 / cortex#279 cycle 2).
 *
 * Used by `MyelinRuntime.publish`'s `nats.subjects` resolution and by
 * `cortex.ts`'s renderer-config boot path. Extracted so both call
 * sites can't drift on the substitution rule (stack-less deployments
 * collapse `{stack}.` to empty; stack-aware deployments emit
 * `${stack}.`).
 *
 * Returns a closure so the resolved `(principal, stack)` pair is captured
 * once and applied to N pattern strings without reallocating the
 * substitution rules per call.
 */
export function makeSubjectPlaceholderSubstituter(opts: {
  principal: string;
  stack?: string;
}): (subjects: readonly string[]) => string[] {
  const stackToken = opts.stack !== undefined ? `${opts.stack}.` : "";
  return (subjects: readonly string[]) =>
    subjects.map((s) =>
      // R4 (vocabulary migration 2026-05, myelin#185 breaking cut +
      // cortex#453) — `{principal}` is the canonical token. The transition
      // window accepting `{org}` retired with myelin#185; `migrate-config`
      // rewrites legacy bot.yaml `{org}` tokens to `{principal}` before
      // they reach runtime, and the envelope grammar `{principal}.{stack}.
      // {assistant}` (per `specs/namespace.md`) is the only form the schema
      // validator now accepts.
      s
        .replaceAll("{principal}", opts.principal)
        .replaceAll("{stack}.", stackToken),
    );
}

export async function startMyelinRuntime(
  config: AgentConfig,
  options?: MyelinRuntimeOptions,
): Promise<MyelinRuntime> {
  // Fan-out registry — populated regardless of whether NATS itself
  // starts. Callers (like the surface-router) can safely register
  // even when the runtime is a no-op; their handlers simply never
  // fire, which is the right semantic for a bot started without
  // NATS configured.
  const handlers = new Set<EnvelopeHandler>();
  const onEnvelope = (handler: EnvelopeHandler) => {
    handlers.add(handler);
    return {
      unregister: () => {
        handlers.delete(handler);
      },
    };
  };

  // Disabled `publish` — same opt-in semantics as `onEnvelope`. Adapters
  // call `runtime.publish(...)` from inside reconnect callbacks regardless
  // of whether NATS is configured; making this a no-op (rather than a
  // throw) keeps adapter code simple. The `enabled === false` flag is the
  // explicit signal for callers who DO want to gate.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const publishDisabled = async (_envelope: Envelope) => {};

  // Subscribe-pull no-op for the disabled paths (no NATS configured,
  // connect failed, or subscriber pattern list empty). Returning `null`
  // is the documented signal — capability-side features such as the
  // review consumer treat it as "bus dormant, stay dormant" and skip
  // their pull subscription without aborting boot. See
  // `MyelinRuntime.subscribePull` docblock.
  const subscribePullDisabled = (_opts: MyelinSubscribePullOpts): null => null;

  // cortex#477 — push-mode subscribe no-op for disabled paths. Mirrors
  // `subscribePullDisabled` (returns null on the same "bus dormant"
  // contract). Listeners (e.g. dispatch-listener) tolerate the null and
  // stay dormant rather than aborting boot.
  // eslint-disable-next-line @typescript-eslint/require-await
  const subscribePushDisabled = async (_pattern: string): Promise<null> => null;

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const stopDisabled = async () => {};

  // cortex#338 — disabled JSM helper mirrors `subscribePullDisabled`.
  // Boot path calls `runtime.jetstreamManager()` to provision streams /
  // consumers; a null resolution means "no link, no provisioning" and
  // the caller must skip.
  // eslint-disable-next-line @typescript-eslint/require-await
  const jetstreamManagerDisabled = async (): Promise<null> => null;

  // R26 P1 (cortex#1371) — disabled KV helper mirrors `jetstreamManagerDisabled`:
  // null means "no link, no bucket" and the admission boot path degrades.
  // eslint-disable-next-line @typescript-eslint/require-await
  const kvBucketDisabled = async (): Promise<null> => null;

  if (!config.nats?.url) {
    return {
      enabled: false,
      onEnvelope,
      publish: publishDisabled,
      subscribePull: subscribePullDisabled,
      subscribe: subscribePushDisabled,
      jetstreamManager: jetstreamManagerDisabled,
      kvBucket: kvBucketDisabled,
      stop: stopDisabled,
    };
  }

  const nats = config.nats;
  // IAW Phase A.3 follow-up (cortex#130 item 1): subscribe-side `{principal}` is
  // resolved via the shared `principalFromConfig` helper. The publish-side
  // (`deriveNatsSubject` → `principalFromEnvelope`) extracts the same segment
  // from `envelope.source` at emit time. Both helpers live in
  // `envelope-validator.ts` and the invariant they jointly preserve
  // (subscribe `{principal}` === publish `{principal}` for envelopes this stack emits)
  // has a regression test at
  // `src/bus/myelin/__tests__/runtime-principal-symmetry.test.ts`.
  //
  // cortex#269 — `{stack}.` substituted alongside `{principal}` via the shared
  // `makeSubjectPlaceholderSubstituter` helper (defined above; also used
  // by the renderer-config boot path in `src/cortex.ts`). Stack-less
  // deployments collapse `{stack}.` to empty, preserving legacy 5-segment
  // subscribe patterns. The default `["local.{principal}.>"]` pattern is
  // unaffected — multi-segment `>` wildcard already matches both shapes.
  // A pattern like `local.{principal}.{stack}.system.>` resolves to either
  // `local.{principal}.{stack}.system.>` (stack-aware) or `local.{principal}.system.>`
  // (legacy) depending on whether the boot path supplied a stack.
  // cortex#429 PR-C — `principal` flows in via options (sourced from
  // the entrypoint's `resolvePrincipalId`) since the legacy
  // `config.agent.operatorId` schema field has been retired.
  // `principalFromConfig` retains the `?? "default"` fallback semantics
  // for compatibility with no-op runtimes (NATS absent) and tests that
  // exercise the substituter without a boot-resolved principal.
  const substituter = makeSubjectPlaceholderSubstituter({
    principal: principalFromConfig(options?.principal),
    stack: options?.stack,
  });
  const subjects = substituter(nats.subjects);

  // cortex#337 — empty `nats.subjects` is the documented default
  // today. Pre-#337 this branch returned a fully-disabled runtime
  // (publish: publishDisabled, subscribePull: subscribePullDisabled),
  // which left capability-side consumers (ReviewConsumer) structurally
  // dormant even when NATS was configured. The runtime now opens the
  // link unconditionally (any url-configured case → live link), skips
  // push-mode subscribers when `subjects` is empty, and exposes a real
  // `publish` + `subscribePull`. Pull-mode capability consumers can
  // wire themselves; push-mode broad-pattern subscribers stay absent
  // by design.
  const pushSubscribersConfigured = subjects.length > 0;
  if (!pushSubscribersConfigured) {
    console.info(
      "myelin-runtime: nats.url configured, nats.subjects empty — entering pull-only mode (capability consumers may subscribe via subscribePull; no push-mode broad-pattern subscribers will start)",
    );
  }

  // IAW Phase F-3b (cortex#659) — the LinkPool. A `PoolLink` bundles one
  // `NatsLink` with its OWN subscriber set, `boundByPattern` dedupe map,
  // and lazily-built `jsmCache`. Pre-F-3b these were module-singletons
  // closed over the single `link`; the dedupe and JetStream-manager caching
  // are per-physical-link (a double-bind is per-link; a JSM round-trip is
  // per-connection), so they belong on the link, not the runtime.
  //
  // IAW Phase F-3c (cortex#662) — the degrade-don't-crash lifecycle. A leaf
  // that is DOWN at boot is no longer simply absent from the pool (F-3b);
  // it becomes a TRACKED entry with `link: null` + `status: "disconnected"`
  // and a background-reconnect timer. `selectLink` fails closed on a down
  // leaf (its network's `federated.*` publishes skip via the routing-error
  // sink), the PRIMARY link is unaffected, and `enabled` stays true. When
  // the leaf's connection becomes available the reconnect attaches it and
  // flips `status` to `"connected"`, resuming routing. The `primary` link is
  // never down-tracked here — its failure governs `enabled` and short-
  // circuits boot above (F-3b contract preserved).
  type LeafStatus = "connected" | "disconnected" | "retrying";
  interface PoolLink {
    /** Pool key — `'primary'` for `config.nats`; `leaf_node` for a leaf. */
    readonly linkId: string;
    /**
     * The live `NatsLink`, or `null` for a leaf that is currently down
     * (boot-unreachable, or dropped and not yet reconnected). Always
     * non-null for `primary`.
     */
    link: NatsLink | null;
    /**
     * IAW Phase F-3c — up/down lifecycle state. `primary` is always
     * `"connected"` (its down-state ends the runtime). A leaf cycles
     * `disconnected` → `retrying` → `connected` (or back to `disconnected`
     * on a failed retry) under the background-reconnect scheduler.
     */
    status: LeafStatus;
    /**
     * The leaf's connect options, retained so the background-reconnect
     * scheduler can re-attempt `NatsLink.connect` with the same parameters.
     * `null` for `primary` (never reconnected by this machinery).
     */
    readonly connectOpts: Parameters<typeof NatsLink.connect>[0] | null;
    /**
     * Handle for a pending background-reconnect timer (test-seam or real),
     * or `null` when no retry is scheduled. `stop()` clears this so no timer
     * leaks and no reconnect fires after shutdown. Typed as
     * {@link ReconnectTimerHandle} (a non-null opaque handle) so the
     * `!== null` "a timer is pending" check is meaningful.
     */
    reconnectHandle: ReconnectTimerHandle | null;
    /** Current backoff delay (ms) for the NEXT reconnect attempt. */
    backoffMs: number;
    /** This link's own bound push subscriptions (cortex#491 dedupe is per-link). */
    readonly subscribers: MyelinSubscriber[];
    readonly boundByPattern: Map<string, MyelinSubscriber>;
    /** Lazily-resolved JetStreamManager for this link (cortex#338). */
    jsmCache: Promise<import("nats").JetStreamManager> | null;
  }

  const safeUrlOf = (url: string): string => url.replace(/\/\/[^@/]+@/, "//***@");

  // The primary link backs `local.*` / `public.*` and every back-compat
  // case (zero per-network `nats:` ⇒ this is the ONLY link in the pool).
  let primary: PoolLink;
  // F-3c: hold the primary `NatsLink` in a non-null binding so the
  // back-compat `link` alias, the JSM helper, and any other primary-only
  // reference avoid a forbidden non-null assertion on the now-nullable
  // `PoolLink.link`. Primary is the ONE link guaranteed live past this block.
  let primaryLink: NatsLink;
  // TC-4d (#627 Phase 4) — transport-mTLS posture for the whole pool. `off`
  // (default / omitted) builds no tls block on any link ⇒ plaintext,
  // byte-identical to today. `require` fails closed at connect (a missing/
  // invalid cert throws below, which for the primary disables the runtime).
  const mtlsMode: MtlsMode = options?.transportMtls?.mode ?? "off";
  const mtlsPaths: MtlsPaths | undefined = options?.transportMtls?.paths;
  const primaryTls = buildNatsTlsOptions(mtlsMode, mtlsPaths, {
    site: "primary link",
  });
  try {
    primaryLink = await NatsLink.connect({
      url: nats.url,
      token: nats.token,
      // cortex#86: operator-mode auth path. NatsLink loader expands ~/
      // and enforces chmod 600; if both token and credsPath are set,
      // credsPath wins with a warn log.
      ...(nats.credsPath ? { credsPath: nats.credsPath } : {}),
      name: nats.name,
      // TC-4d: transport mTLS (undefined ⇒ plaintext, unchanged).
      ...(primaryTls !== undefined ? { tls: primaryTls } : {}),
      ...(options?.connectImpl ? { connectImpl: options.connectImpl } : {}),
    });
    primary = {
      linkId: "primary",
      link: primaryLink,
      // F-3c: primary is always connected; its down-state ends the runtime
      // (the catch below), so it never enters the leaf reconnect lifecycle.
      status: "connected",
      connectOpts: null,
      reconnectHandle: null,
      backoffMs: 0,
      subscribers: [],
      boundByPattern: new Map(),
      jsmCache: null,
    };
    console.log(
      `myelin-runtime: connected to ${safeUrlOf(nats.url)} as "${nats.name}" (link=primary)`,
    );
  } catch (err) {
    // Primary down ⇒ runtime disabled, exactly as the pre-F-3b single-link
    // path. The primary link governs `enabled` (design §3.4, OD-F3-2):
    // per-network leaf degradation is F-3c — F-3b keeps the primary-down
    // contract identical so the back-compat case is byte-for-byte.
    console.error(
      "myelin-runtime: failed to connect — continuing without NATS:",
      err instanceof Error ? err.message : String(err),
    );
    return {
      enabled: false,
      onEnvelope,
      publish: publishDisabled,
      subscribePull: subscribePullDisabled,
      subscribe: subscribePushDisabled,
      jetstreamManager: jetstreamManagerDisabled,
      kvBucket: kvBucketDisabled,
      stop: stopDisabled,
    };
  }

  // The pool, keyed by `linkId`. `primary` is always present; leaf links
  // are added below. `pool.get('primary')` is the back-compat default for
  // every selection path.
  const pool = new Map<string, PoolLink>();
  pool.set(primary.linkId, primary);

  // IAW Phase F-3c (cortex#662) — background-reconnect machinery. Resolved
  // ONCE here; never engaged when zero leaf links exist (the loop below adds
  // nothing to retry), keeping the zero-network back-compat path untouched.
  //
  // `stopped` is declared further down (after PASS 2) for the publish/
  // subscribe guards; the reconnect scheduler also checks it so a timer that
  // fires mid-shutdown is a no-op. Hoist a forward-readable flag here so the
  // scheduler closure can see it; the later `let stopped = false` is replaced
  // by this single declaration.
  const reconnectInitialMs = options?.reconnectBackoff?.initialMs ?? 1_000;
  const reconnectMaxMs = options?.reconnectBackoff?.maxMs ?? 30_000;
  const reconnectFactor = options?.reconnectBackoff?.factor ?? 2;
  // Test seam: deterministic timers. Production uses real setTimeout/
  // clearTimeout — both Node and Bun return an OBJECT handle from
  // `setTimeout`, satisfying the non-null `ReconnectTimerHandle`.
  const setReconnectTimer: (cb: () => void, ms: number) => ReconnectTimerHandle =
    options?.reconnectTimer?.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearReconnectTimer: (handle: ReconnectTimerHandle) => void =
    options?.reconnectTimer?.clearTimer ??
    ((handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

  let stopped = false;
  // Read `stopped` through a function in async closures so TS doesn't narrow
  // the captured `let` to its pre-`await` value — `stop()` can flip it mid-
  // reconnect (the shutdown race the leaf-reconnect guards exist to catch).
  const isStopped = (): boolean => stopped;

  /**
   * IAW Phase F-3c (cortex#662) — re-attempt one DOWN leaf's connection in
   * the background with bounded exponential backoff. On success the leaf's
   * `NatsLink` is attached to its existing `PoolLink` entry (so `selectLink`
   * resolves it and `federated.{net}.*` publishes resume) and its status
   * flips to `"connected"`. On failure the delay doubles (capped at
   * `reconnectMaxMs`) and another retry is scheduled — bounded, never a
   * spin. A reconnect timer that fires after `stop()` is a no-op (the
   * `stopped` guard) and `stop()` clears any pending handle so no timer
   * leaks.
   *
   * Up/down transitions log via the routing-error sink's sibling channel
   * (`console.*` per the F-3b seam — no `SystemEventSource` in the runtime).
   */
  const scheduleReconnect = (entry: PoolLink): void => {
    if (stopped) return; // shutting down — do not schedule.
    // Capture the (post-guard non-null) connect opts in a local so the inner
    // async closure doesn't re-narrow `entry.connectOpts` — primary's null
    // connectOpts never reaches here (it's never down-scheduled).
    const connectOpts = entry.connectOpts;
    if (connectOpts === null) return; // primary never reconnects here.
    entry.status = "retrying";
    const delay = entry.backoffMs;
    entry.reconnectHandle = setReconnectTimer(() => {
      // Clear the handle first: this timer has fired, so it no longer needs
      // cancelling, and a re-schedule below installs a fresh one.
      entry.reconnectHandle = null;
      if (stopped) return; // raced with stop() — abandon.
      // Fire-and-forget the async attempt; the closure owns its own retry
      // scheduling so a rejected promise can't escape into an unhandled
      // rejection (we await + catch inside).
      void (async () => {
        try {
          const leafLink = await NatsLink.connect(connectOpts);
          // Re-read `stopped` THROUGH a function so TS's control-flow
          // analysis doesn't narrow it to the pre-`await` value: `stop()`
          // may have flipped it WHILE this connect was in flight (the
          // shutdown race this guard exists to catch).
          if (isStopped()) {
            // Connected during shutdown — close immediately, don't attach.
            await leafLink.close().catch(() => {
              // best-effort close on the shutdown race; ignore.
            });
            return;
          }
          entry.link = leafLink;
          entry.status = "connected";
          entry.backoffMs = reconnectInitialMs; // reset for any future drop.
          console.log(
            `myelin-runtime: leaf "${entry.linkId}" reconnected — routing to its network resumes`,
          );
        } catch (err) {
          // Still down — double the backoff (capped) and try again.
          entry.status = "disconnected";
          entry.backoffMs = Math.min(entry.backoffMs * reconnectFactor, reconnectMaxMs);
          console.error(
            `myelin-runtime: leaf "${entry.linkId}" reconnect failed; retrying in ${entry.backoffMs}ms:`,
            err instanceof Error ? err.message : String(err),
          );
          scheduleReconnect(entry);
        }
      })();
    }, delay);
  };

  // IAW Phase F-3b — build one leaf link per DISTINCT federated network
  // `leaf_node` that declared an inline `nats:` block (F-3a, Option B). The
  // `leaf_node` is the de-dup key: two networks sharing a `leaf_node` share
  // ONE physical link (the F-3a cross-validator guarantees their `nats:`
  // blocks are consistent, so the first declaration wins and the second is
  // a no-op). Networks WITHOUT a `nats:` block contribute nothing here —
  // they ride the primary link.
  //
  // `network_id → linkId` is the publish-routing resolution map, built once
  // here (no per-message Map rebuild — design §3.2, mirrors
  // `network-resolver.ts` cached-lookup discipline). A network whose
  // `leaf_node` has no leaf link resolves to `'primary'` (rides primary),
  // preserving the back-compat default.
  //
  // NAME-COLLISION (design §3.2): this keys off
  // `options.federatedNetworks` (← `policy.federated.networks[]`), NEVER
  // `config.networks[]` (the legacy grove Discord-guild → cloud-publish
  // table owned by `network-resolver.ts`). The two must never cross.
  const federatedNetworks = options?.federatedNetworks ?? [];

  // PASS 1 — build one leaf link per DISTINCT `leaf_node` that some network
  // declared a `nats:` block for. The first network with a given
  // `leaf_node` defines the connection; later networks sharing it reuse the
  // link (the F-3a cross-validator guarantees their `nats:` blocks agree,
  // so we don't re-read them). A `leaf_node` whose construction throws is
  // simply absent from the pool (the degrade-don't-crash seam below).
  for (const network of federatedNetworks) {
    if (network.nats === undefined) continue; // rides primary — resolved in PASS 2.
    const leafId = network.leaf_node;
    if (pool.has(leafId)) continue; // already built by an earlier sharing network.
    // TC-4d (#627 Phase 4) — same transport-mTLS posture as the primary,
    // applied per-leaf. Cross-principal federated leaves especially want
    // mTLS; under `require` a leaf with a missing/invalid cert throws below
    // and that network goes dark (F-3c degrade-don't-crash), while primary is
    // unaffected. `off` ⇒ no tls block ⇒ plaintext, byte-identical to today.
    const leafTls = buildNatsTlsOptions(mtlsMode, mtlsPaths, {
      site: `leaf "${leafId}"`,
    });
    // TC-4e — a FEDERATED leaf that ends up WITHOUT TLS is a cross-principal
    // cleartext-confidentiality risk. Warn loudly (advisory, regardless of
    // posture) when neither a tls block was built NOR the URL is `tls://`.
    const leafProtected = leafTls !== undefined || network.nats.url.startsWith("tls://");
    if (!leafProtected) {
      warnFederatedCleartext(
        {
          leafId,
          networkId: network.id,
          safeUrl: safeUrlOf(network.nats.url),
        },
        options?.transportMtls?.onFederatedCleartext,
      );
    }
    // The connect options retained on the PoolLink so the F-3c background-
    // reconnect scheduler can re-attempt with the SAME parameters.
    const leafConnectOpts: Parameters<typeof NatsLink.connect>[0] = {
      url: network.nats.url,
      ...(network.nats.credsPath ? { credsPath: network.nats.credsPath } : {}),
      name: network.nats.name,
      // TC-4d: transport mTLS for this leaf (undefined ⇒ plaintext).
      ...(leafTls !== undefined ? { tls: leafTls } : {}),
      ...(options?.connectImpl ? { connectImpl: options.connectImpl } : {}),
    };
    try {
      const leafLink = await NatsLink.connect(leafConnectOpts);
      pool.set(leafId, {
        linkId: leafId,
        link: leafLink,
        status: "connected",
        connectOpts: leafConnectOpts,
        reconnectHandle: null,
        backoffMs: reconnectInitialMs,
        subscribers: [],
        boundByPattern: new Map(),
        jsmCache: null,
      });
      console.log(
        `myelin-runtime: connected to ${safeUrlOf(network.nats.url)} as "${network.nats.name}" (link=${leafId}, network=${network.id})`,
      );
    } catch (err) {
      // IAW Phase F-3c (cortex#662) — RATIFIED degrade-don't-crash (design
      // §3.4, OD-F3-2). A per-network leaf being down at boot must NOT take
      // the daemon down. Pre-F-3c (F-3b) the failed `leaf_node` was simply
      // ABSENT from the pool; F-3c instead inserts a TRACKED entry in the
      // `disconnected` state with `link: null` and schedules a background
      // reconnect. The network still fails closed — `selectLink` skips a
      // down leaf's `federated.*` publishes (routing-error sink), the
      // PRIMARY link governs `enabled` (stays true), and primary traffic is
      // unaffected. When the leaf becomes reachable the reconnect attaches
      // it and routing to that network resumes.
      console.error(
        `myelin-runtime: failed to connect leaf "${leafId}" (network=${network.id}) at ${safeUrlOf(network.nats.url)} — that network is dark; primary unaffected; scheduling background reconnect:`,
        err instanceof Error ? err.message : String(err),
      );
      const downEntry: PoolLink = {
        linkId: leafId,
        link: null,
        status: "disconnected",
        connectOpts: leafConnectOpts,
        reconnectHandle: null,
        backoffMs: reconnectInitialMs,
        subscribers: [],
        boundByPattern: new Map(),
        jsmCache: null,
      };
      pool.set(leafId, downEntry);
      scheduleReconnect(downEntry);
    }
  }

  // PASS 2 — map each network id to its target `linkId`:
  //   - its `leaf_node`, IF a pool entry for that `leaf_node` exists (it
  //     declared `nats:`, OR a sibling sharing the `leaf_node` did). Under
  //     F-3c a leaf that FAILED to connect at boot is now a TRACKED pool
  //     entry (status `"disconnected"`, `link: null`) rather than absent —
  //     so it maps to its `leaf_node` here too. `selectLink` reads the
  //     entry's live/down state and fails closed (skip + routing error)
  //     while the link is null, then routes normally once the background
  //     reconnect attaches it. This is the F-3c change from F-3b, where a
  //     failed leaf was UNMAPPED and could never recover its routing.
  //   - else `'primary'` (no `nats:` anywhere for this `leaf_node` ⇒ rides
  //     primary, today's behaviour).
  const networkIdToLinkId = new Map<string, string>();
  for (const network of federatedNetworks) {
    if (pool.has(network.leaf_node)) {
      // A pool entry exists for this `leaf_node` (live OR down-tracked) —
      // route this network to it. `selectLink` gates on the entry's status.
      networkIdToLinkId.set(network.id, network.leaf_node);
    } else {
      // No `nats:` anywhere for this `leaf_node` — ride the primary link.
      networkIdToLinkId.set(network.id, primary.linkId);
    }
  }

  // ADR 0001 (supersedes cortex#661) — the `{target_principal} → linkId` routing
  // map. Federated subjects carry `federated.{principal}.{stack}.…` (segment[1] is
  // the TARGET PRINCIPAL — same identity grammar as `local.*`), and the network is
  // NEVER on the wire. `selectLink` resolves which leaf a federated publish targets
  // from the target principal via the deployment topology: each network's
  // `peers[].principal_id` enumerates the remote principals reachable on that
  // network, and the network already maps to a `linkId` above. Composing the two
  // gives `principal_id → linkId` — built ONCE here at boot (no per-message Map
  // rebuild), the L1/topology resolution the ADR's layering mandates (Cortex L7
  // addresses by identity; myelin/L1 resolves the route).
  //
  // A target principal that appears in NO network's `peers[]` is unknown — its
  // `federated.*` publish fails closed (routing error + skip), never leaks onto
  // primary or another leaf (design §5 — no cross-network leakage). When the same
  // principal is declared on two networks, the FIRST network's link wins; a
  // collision is logged so the deploying principal can disambiguate (multi-homing a single
  // principal across networks is unusual and out of scope for this slice).
  const principalIdToLinkId = new Map<string, string>();
  for (const network of federatedNetworks) {
    const linkId = networkIdToLinkId.get(network.id) ?? primary.linkId;
    for (const peer of network.peers) {
      const existing = principalIdToLinkId.get(peer.principal_id);
      if (existing !== undefined && existing !== linkId) {
        console.error(
          `myelin-runtime: peer principal "${peer.principal_id}" is declared on more than one federated network with different leaf links (keeping link="${existing}", ignoring link="${linkId}" from network="${network.id}") — a principal should be reachable on a single network leaf; the deploying principal should disambiguate policy.federated.networks[].peers[]`,
        );
        continue;
      }
      principalIdToLinkId.set(peer.principal_id, linkId);
    }
  }

  // M3 (cortex#1241, ADR-0019) — per-target-principal OUTBOUND seal policy,
  // derived once at init from `policy.federated.networks[]`. Maps a target
  // principal (the SECOND subject segment of `federated.{principal}.{stack}.…`)
  // to the network it lives on + that network's encryption posture + key. Empty
  // when no network sets `encryption: enabled|required` — the seal step below is
  // then a pure no-op and the publish path is byte-identical to pre-M3.
  //
  // cortex#1246 BLOCKER fix: also pass the OWN principal id so a SELF-addressed
  // federated subject (`federated.{ownPrincipal}.…` — how a federated Offer /
  // probe-echo is published) resolves to its own network's seal policy and seals,
  // instead of falling through unsealed (segment[1] == own principal is never in
  // its own `peers[]`). Only the unambiguous single-encryption-network case maps
  // here; `encryptionEnabledNetworkCount` drives the multi-network warn-once
  // below.
  const myPrincipal = principalFromConfig(options?.principal);
  const sealPolicyByPrincipal = buildSealPolicyByPrincipal(
    federatedNetworks,
    myPrincipal,
  );
  const encryptionEnabledNetworkCount =
    countEncryptionEnabledNetworks(federatedNetworks);
  // Loud-but-not-fatal warning dedup: warn ONCE per network when sealing is
  // requested (`enabled`/`required`) but the network key is absent (PR5b has
  // not yet delivered `K`). We publish cleartext in that case — federation
  // stays up, but "federating in the clear" is visible (ADR-0019 §7).
  const sealKeyMissingWarned = new Set<string>();
  // cortex#1246 — warn-once dedup for a self-addressed federated egress
  // (`federated.{ownPrincipal}.…`, e.g. an Offer) that could NOT be sealed
  // because the stack is on MULTIPLE encryption-enabled networks and the network
  // is unresolvable from a self-addressed subject alone. Single-network seals
  // correctly (own principal is mapped in `sealPolicyByPrincipal`); this defends
  // the multi-network gap so it is loud, never silent.
  let selfAddressedAmbiguousSealWarned = false;

  // Back-compat alias: every existing reference to the single `link` now
  // targets the primary link's `NatsLink`. The subscribe/pull/jsm helpers
  // below stay bound to `primary` (design §3.5 — `subscribePull` and the
  // boot-time push subscribers are primary-only in F-3b; per-network
  // subscribe is F-3d inbound attribution).
  //
  // F-3c (cortex#662): `PoolLink.link` is now `NatsLink | null` to model a
  // down leaf, but PRIMARY is always connected here (its connect succeeded
  // above; a primary failure short-circuited the whole runtime). Reuse the
  // non-null `primaryLink` binding rather than asserting on `primary.link`.
  const link = primaryLink;
  // `subscribers` / `boundByPattern` for the boot-time push loop + the
  // self-subscribe path are the PRIMARY link's (design §3.5). Leaf links
  // carry their own empty sets (publish-only in F-3b).
  const subscribers = primary.subscribers;
  // cortex#491 — idempotent push-subscribe per RESOLVED pattern. Core-NATS
  // push subscriptions are independent: if two subscribers bind to patterns
  // that both match a subject, the broker delivers the envelope to BOTH, and
  // each runs the full `for (const handler of handlers)` fan-out — so every
  // registered sink (surface-router, worklog-manager, review-sink) fires
  // TWICE for one publish. This is exactly the double-bind documented around
  // `nats.subjects: []` in cortex.yaml: listing a pattern that a self-
  // subscribe path (runtime.subscribe per cortex#477/#479) also binds
  // re-creates the subscriber and double-delivers.
  //
  // The minimal, semantics-preserving fix is exact-pattern dedupe keyed by
  // the resolved (post-substituter) pattern string: never create a second
  // MyelinSubscriber for a pattern already bound. We deliberately do NOT do
  // subsumption-merge (collapsing `a.b.>` into `a.>`) — that would CHANGE
  // which subjects a subscriber receives and is harder to prove safe. Exact
  // dedupe kills the double-bind without altering match semantics. The
  // shared `handlers` Set, the surface-router's single registration, and
  // `adapterMatches` are untouched (chat sink unaffected).
  //
  // The map spans BOTH the boot-time `nats.subjects` loop below AND the
  // later `runtime.subscribe` self-subscribe path (`subscribePushEnabled`),
  // so a config pattern that collides with a self-subscribe binds exactly
  // once: whichever path runs first creates the subscriber; the second
  // returns the SAME handle instead of double-binding.
  //
  // F-3b (cortex#659): the dedupe map is now PER-LINK — it lives on each
  // `PoolLink` (`poolLink.boundByPattern`). Boot-time `nats.subjects` push
  // subscribers + the `runtime.subscribe` self-subscribe path bind on the
  // PRIMARY link's map (design §3.5); F-3d (cortex#666) per-leaf inbound
  // subscriptions bind on each leaf's own map. `bindPushPattern` now takes the
  // target `PoolLink` explicitly rather than closing over a single map.

  /**
   * IAW Phase F-3d (cortex#666) — fan an inbound envelope out to every
   * registered handler, tagging the delivering link's `linkId` as
   * `sourceLink`. Each handler runs in its own try/catch so one slow/failing
   * consumer can't poison the others (router-level isolation lives in the
   * surface-router; this is the defensive last line).
   *
   * `sourceLink` is the `PoolLink.linkId` of whichever link's subscriber
   * delivered the envelope — `"primary"` for the `config.nats` link, the
   * `leaf_node` for a federated leaf. The anti-spoof assertion (§3.3 / §5)
   * runs at the per-link subscriber site (`bindPushPattern`) BEFORE this
   * fan-out, so a `federated.{X}.…` subject that arrived on a link not owning
   * network X never reaches handlers at all. The `sourceLink` carried here is
   * the surplus attribution TC-2d (cortex#635) keys its per-network verify
   * off — F-3d is the structural prerequisite, not the verify itself.
   */
  const fanOut = (env: Envelope, subject: string, sourceLink: string): void => {
    for (const handler of handlers) {
      try {
        handler(env, subject, sourceLink);
      } catch (err) {
        console.error(
          "myelin-runtime: onEnvelope handler threw:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  };

  /**
   * IAW Phase F-3d (cortex#666) — source-link attribution gate, reworked for
   * ADR 0001 (supersedes cortex#661).
   *
   * Under cortex#661 a federated subject's segment[1] was the SENDER's target
   * `{network_id}`, so this gate dropped any envelope whose `{network_id}` did
   * not map to the delivering leaf (a cross-network spoof). ADR 0001 removes the
   * network from the wire entirely: each leaf now subscribes only to
   * `federated.{my-principal}.{my-stack}.>` (envelopes addressed to THIS stack),
   * so segment[1] is OUR OWN principal, never a network — the old network→leaf
   * spoof check has nothing to key off and is retired.
   *
   * The cross-principal TRUST decision (is the SENDER — resolved from the
   * `signed_by[]` chain / `envelope.source`, NOT from the subject — a legitimate
   * peer on a network owning this leaf?) now lives entirely at the verify layer
   * (TC-2d `verify-signed-by-chain`, keyed off the delivering `sourceLink`) and
   * the surface-router federation gate. This function therefore lets every
   * leaf-delivered envelope fan out; the `sourceLink` tag (which leaf delivered
   * it) is still attached by `fanOut` so those downstream gates can do their
   * per-network peer-pubkey lookup. Returning `true` here is NOT "trust it" — it
   * is "attribute it and defer the trust decision to the layer that owns it."
   *
   * Returns `true` to fan out. (Always, post-ADR-0001 — kept as a function so
   * the fan-out call site and the design's "anti-spoof seam" stay greppable and
   * a future network-aware drop can re-enter here without touching the caller.)
   *
   * **Back-compat:** with zero leaf links the primary subscriber is the only one
   * bound and `linkId === "primary"`, so this returns `true` for every subject —
   * byte-identical to the pre-F-3d single-link delivery path.
   */
  const passesSourceLinkCheck = (subject: string, linkId: string): boolean => {
    // Primary delivery + non-federated subjects always pass (unchanged).
    if (linkId === primary.linkId) return true;
    if (!subject.startsWith("federated.")) return true;
    // ADR 0001 — leaf-delivered federated traffic is addressed to our own
    // principal/stack (segment[1] is OUR principal, not a sender network), so
    // there is no network segment to validate here. Attribute via `sourceLink`
    // (the delivering leaf) and defer the cross-principal trust decision to the
    // verify layer + surface-router gate. Fan out.
    return true;
  };

  /**
   * Bind one resolved push pattern idempotently ON A SPECIFIC POOL LINK.
   * Returns the already-bound subscriber on a duplicate, or `null` if
   * `MyelinSubscriber.start` threw. Shared by the boot loop (primary +
   * per-leaf F-3d subscriptions) and `subscribePushEnabled`.
   *
   * IAW Phase F-3d (cortex#666): the dedupe map + `subscribers[]` are the
   * TARGET link's own (per-link, per design §3.5 / the cortex#491 per-link
   * dedupe), and the fan-out tags `poolLink.linkId` as `sourceLink`. A leaf
   * subscriber additionally runs `passesSourceLinkCheck` before fanning out
   * (anti-spoof). Primary keeps its pre-F-3d behaviour exactly (the check is
   * a no-op for `linkId === "primary"`).
   */
  const bindPushPattern = (
    poolLink: PoolLink,
    pattern: string,
  ): MyelinSubscriber | null => {
    const existing = poolLink.boundByPattern.get(pattern);
    if (existing !== undefined) {
      console.log(
        `myelin-runtime: skipping duplicate subscribe to "${pattern}" on link="${poolLink.linkId}" (already bound)`,
      );
      return existing;
    }
    // A down leaf (link === null) cannot bind a subscription; the background
    // reconnect re-binds the leaf's interest when it attaches (F-3c/F-3d).
    const targetLink = poolLink.link;
    if (targetLink === null) {
      console.error(
        `myelin-runtime: cannot subscribe to "${pattern}" on down link="${poolLink.linkId}" — skipping (background reconnect will re-bind)`,
      );
      return null;
    }
    try {
      const sub = MyelinSubscriber.start(targetLink, {
        pattern,
        onEnvelope: (env, subject) => {
          logEnvelope(env, subject);
          // Anti-spoof BEFORE fan-out (leaf links only; no-op for primary).
          if (!passesSourceLinkCheck(subject, poolLink.linkId)) return;
          fanOut(env, subject, poolLink.linkId);
        },
      });
      poolLink.subscribers.push(sub);
      poolLink.boundByPattern.set(pattern, sub);
      console.log(
        `myelin-runtime: subscribed to "${pattern}" on link="${poolLink.linkId}"`,
      );
      return sub;
    } catch (err) {
      console.error(
        `myelin-runtime: failed to subscribe to "${pattern}" on link="${poolLink.linkId}":`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  };
  // Boot-time push subscribers from `nats.subjects[]` bind on the PRIMARY link
  // (design §3.5 — broad-pattern push is primary-only; leaf links carry
  // network-scoped subscriptions wired just below).
  for (const pattern of subjects) {
    bindPushPattern(primary, pattern);
  }

  // IAW Phase F-3d (cortex#666) — per-leaf inbound subscriptions, reworked for
  // ADR 0001 (supersedes cortex#661). Each leaf link subscribes to the federated
  // traffic addressed to THIS stack — `federated.{my-principal}.{my-stack}.>` —
  // so an inbound envelope on that leaf fans out tagged with the leaf's `linkId`
  // as `sourceLink` (design §3.3 — "each subscriber binds to exactly one link and
  // tags `sourceLink`"). The cross-principal TRUST decision (was the SENDER a
  // legitimate peer on a network owning this leaf?) is the verify layer's job
  // (TC-2d, keyed off `sourceLink`), not the subscription pattern's.
  //
  // GRAMMAR (ADR 0001): the subject is `federated.{principal}.{stack}.…` where
  // `{principal}` is the TARGET principal — the SAME identity grammar as
  // `local.*`. The network is NEVER on the wire; a stack accepts federated
  // traffic addressed to its OWN principal/stack. Pre-ADR (cortex#661) this loop
  // subscribed per-network to `federated.{network_id}.>` — a transport-topology
  // value on the wire that `CONTEXT.md` forbids. Now the receiving stack's own
  // identity is the subscription key, symmetric with the `local.*` subscribe
  // patterns the boot loop above resolves via `makeSubjectPlaceholderSubstituter`.
  //
  // Subscribe ONCE per DISTINCT leaf link (multiple networks may share a
  // `leaf_node`; the stack's inbound interest is the same regardless of which
  // network the peer rode in on). `bindPushPattern`'s per-link dedupe also makes
  // a repeated bind a no-op, so iterating distinct leaves is belt-and-braces.
  //
  // **Back-compat:** with zero leaf links this loop binds nothing — the pool is
  // primary-only and delivery is byte-identical to pre-F-3d. A DOWN leaf
  // (link === null) is skipped by `bindPushPattern`; the F-3c background
  // reconnect attaches the link but re-binding its interest on reconnect is
  // deferred (the leaf comes back publish-capable; inbound re-bind is a TC-2d-
  // adjacent follow-up, noted in the PR).
  // `myPrincipal` is resolved once above (seal-policy build site).
  const myStack = options?.stack;
  // `federated.{my-principal}.{my-stack}.>` (stack-aware) or
  // `federated.{my-principal}.>` (stack-less — the `>` multi-segment wildcard
  // matches the stack-defaulting form too). Mirrors the `local.*` grammar
  // `deriveSubject` emits, so inbound subscribe and outbound emit agree on
  // `{principal}.{stack}` end to end.
  const inboundFederatedPattern =
    myStack !== undefined
      ? `federated.${myPrincipal}.${myStack}.>`
      : `federated.${myPrincipal}.>`;
  const leafLinksSeen = new Set<string>();
  for (const linkId of networkIdToLinkId.values()) {
    if (linkId === primary.linkId) continue; // rides primary — no leaf sub.
    if (leafLinksSeen.has(linkId)) continue; // one inbound sub per distinct leaf.
    leafLinksSeen.add(linkId);
    const leaf = pool.get(linkId);
    if (leaf === undefined) continue; // defensive — mapping invariant holds.
    bindPushPattern(leaf, inboundFederatedPattern);
  }

  // cortex#337 — pre-#337 a non-empty `subjects[]` that ALL failed to
  // subscribe collapsed back to the disabled path. Preserve that
  // safety net: when push-mode subscribers were configured but none
  // came up, the link is closed and the runtime returns disabled —
  // there is no principal intent for a pull-only path here, just a
  // broken subscribe. Pull-only mode (empty subjects → enabled link)
  // is the new path; failed push subscribers are still treated as a
  // boot failure for that configuration shape.
  if (pushSubscribersConfigured && subscribers.length === 0) {
    // F-3b: close EVERY pool link on this disabled-fallback path, not just
    // primary — leaf links opened above must not leak when the runtime
    // collapses back to disabled. `allSettled` so one link's close error
    // doesn't block another's.
    //
    // F-3c (cortex#662): also flip `stopped` and cancel any pending
    // background-reconnect timers a down leaf scheduled in PASS 1 — this
    // disabled-fallback path is a shutdown, so no reconnect must fire and no
    // timer must leak. A leaf with `link: null` (down at boot, never
    // attached) has nothing to close; skip its close.
    stopped = true;
    for (const p of pool.values()) {
      if (p.reconnectHandle !== null) {
        clearReconnectTimer(p.reconnectHandle);
        p.reconnectHandle = null;
      }
    }
    await Promise.allSettled(
      [...pool.values()].map((p) =>
        p.link === null
          ? Promise.resolve()
          : p.link.close().catch(() => {
              // best-effort close on no-subscribers path; ignore errors
            }),
      ),
    );
    return {
      enabled: false,
      onEnvelope,
      publish: publishDisabled,
      subscribePull: subscribePullDisabled,
      subscribe: subscribePushDisabled,
      jetstreamManager: jetstreamManagerDisabled,
      kvBucket: kvBucketDisabled,
      stop: stopDisabled,
    };
  }

  // `publishEnabled` is async because we await `signEnvelope` when a
  // signer is configured (B.3). `NatsLink.publish` itself is fire-and-
  // forget at the Core NATS client layer; the awaitable surface is
  // preserved for symmetry with `publishDisabled` and the
  // `MyelinRuntime.publish: (env) => Promise<void>` contract.
  const signer = options?.signer;
  const signFailureMode = options?.signFailureMode ?? "fallback";
  // Stack identity (cortex#262) — captured at runtime init so per-publish
  // `deriveNatsSubject` calls don't re-read options on every emit. When
  // undefined the publish path falls through to the legacy 5-segment
  // grammar via `deriveNatsSubject(envelope)`; explicit stack flows
  // through as `deriveNatsSubject(envelope, stack)`.
  const stack = options?.stack;
  // Pre-encode the seed to the base64 shape myelin's `signEnvelope`
  // consumes — done once at runtime init rather than per-publish so
  // every call doesn't reallocate the encoding. Tests can pass a
  // synthetic seed via `MyelinRuntimeOptions.signer.rawSeedBytes`
  // without going through the file loader.
  const signerSeedBase64 = signer
    ? Buffer.from(signer.rawSeedBytes).toString("base64")
    : undefined;

  // IAW Phase F-3b (cortex#659) — the routing-error sink (design §3.2).
  // Defaults to a structured `console.error` carrying the canonical
  // `unknown_network_in_publish_subject` reason; a later slice can wire a
  // real `system.error` audit envelope via `options.onRoutingError`.
  const onRoutingError =
    options?.onRoutingError ??
    ((info: RoutingError) => {
      console.error(
        `myelin-runtime: ${info.reason} subject=${info.subject} network=${info.networkId} id=${info.envelopeId} — SKIPPING publish (no link in pool for this federated network)`,
      );
    });

  /**
   * IAW Phase F-3b (cortex#659), reworked for ADR 0001 (supersedes cortex#661)
   * — PURE link selection from the RESOLVED subject. No global mutable routing
   * state, no per-message Map rebuild: reads `principal_id → linkId` (built once
   * at boot from `policy.federated.networks[].peers[]`) and the `pool`.
   *
   *   | resolved subject                   | target link                          |
   *   |------------------------------------|--------------------------------------|
   *   | `local.…`                          | `primary`                            |
   *   | `public.…`                         | `primary` (public mesh deferred §3.5)|
   *   | `federated.{principal}.{stack}.…`  | the leaf owning that target principal|
   *   | `federated.{unknown-principal}.…`  | none → routing error + skip          |
   *
   * Returns the selected `PoolLink`, or `null` to signal "skip the publish" (the
   * only `null` case is an unknown target principal — one that appears in no
   * network's `peers[]` — which also fires `onRoutingError`).
   *
   * ADR 0001 — `{principal}` is the subject's SECOND segment (the TARGET
   * principal — the SAME identity grammar as `local.*`), NOT a `network_id`.
   * The network is NEVER on the wire; this function resolves WHICH leaf the
   * target principal lives behind from the deployment topology (`peers[]`), the
   * L1/L7 separation the ADR's layering mandates. cortex#661 had keyed segment[1]
   * as a target `network_id` — a transport-topology value leaking into the L7
   * identity address, which `CONTEXT.md` forbids and which can't even address a
   * specific principal on a multi-principal network. This reverts that: address
   * by identity, resolve the route from topology.
   *
   * A stack can therefore be re-homed to a different network without changing its
   * subjects (topology change ≠ identity change) — the load-bearing property
   * behind isolated multi-network deployments.
   *
   * BACK-COMPAT (the load-bearing zero-leaf invariant): with zero leaf links (no
   * per-network `nats:`) the pool is primary-only, so the `pool.size === 1`
   * short-circuit below returns `primary` for EVERY subject — including any stray
   * `federated.*` — WITHOUT reading segment[1] at all. The unknown-principal skip
   * is therefore a multi-link-ONLY concept and never engages in the zero-leaf
   * case; a `federated.*` subject was already not separately routable pre-F-3b
   * (it just published on the single link), and that is preserved byte-for-byte.
   */
  const selectLink = (subject: string, envelopeId: string): PoolLink | null => {
    // Non-federated subjects (`local.*`, `public.*`, and anything that
    // isn't a federated subject) always go to primary.
    if (!subject.startsWith("federated.")) {
      return primary;
    }
    // Primary-only pool ⇒ federated traffic rides primary, exactly as the
    // single-link runtime did pre-F-3b. No routing error in this case: the
    // unknown-principal skip is a multi-link-only concept.
    if (pool.size === 1) {
      return primary;
    }
    // ADR 0001 — `federated.{principal}.{stack}.…`: segment[1] is the TARGET
    // PRINCIPAL. Resolve which leaf hosts that principal via the topology map
    // (`peers[].principal_id → network → linkId`, built once at boot). The
    // `RoutingError.networkId` field is retained for the discriminated shape but
    // now carries the unresolved target principal — the value that failed to
    // resolve to a leaf.
    const targetPrincipal = subject.split(".")[1];
    if (targetPrincipal === undefined || targetPrincipal.length === 0) {
      // Malformed `federated.` / `federated..…` — treat as unroutable.
      onRoutingError({
        reason: "unknown_network_in_publish_subject",
        subject,
        networkId: "<malformed>",
        envelopeId,
      });
      return null;
    }
    const linkId = principalIdToLinkId.get(targetPrincipal);
    const target = linkId === undefined ? undefined : pool.get(linkId);
    if (target === undefined) {
      // Unknown target principal (in no network's peers[]) — fail closed:
      // signal + skip, NEVER leak onto primary or another leaf (design §5).
      onRoutingError({
        reason: "unknown_network_in_publish_subject",
        subject,
        networkId: targetPrincipal,
        envelopeId,
      });
      return null;
    }
    // IAW Phase F-3c (cortex#662) — the target leaf is KNOWN but currently
    // DOWN (boot-unreachable, or dropped and not yet reconnected). Fail
    // closed exactly like an unknown network: a dark network routes nothing,
    // and the publish must NEVER fall back onto primary or another leaf
    // (design §5 — no cross-network leakage). The background-reconnect
    // scheduler will attach `target.link` when the leaf returns, after which
    // this same path routes the network's traffic normally. F-3b left such a
    // leaf UNMAPPED so it could never recover; F-3c tracks it down + retries.
    if (target.link === null) {
      // Target principal's leaf is KNOWN but currently DOWN (boot-unreachable or
      // dropped, awaiting F-3c background reconnect). Fail closed exactly like an
      // unknown principal — never fall back onto primary or another leaf.
      onRoutingError({
        reason: "unknown_network_in_publish_subject",
        subject,
        networkId: targetPrincipal,
        envelopeId,
      });
      return null;
    }
    return target;
  };

  /**
   * M3 (cortex#1241, ADR-0019) — OUTBOUND payload seal, encrypt-then-sign.
   *
   * Seals `envelope.payload` with the target network's key so the signer below
   * signs the ciphertext. Engages ONLY when:
   *   - the resolved subject is `federated.*` (only federated payloads are sealed
   *     — `local.*`/`public.*` are never encrypted, ADR-0019 §6), AND
   *   - the target principal (subject segment[1]) is on a network whose
   *     `encryption` is `enabled`/`required` (in `sealPolicyByPrincipal`), AND
   *   - that network holds a key.
   * ALL federated dispatch modes (Direct/Delegate/Offer) flow through this one
   * chokepoint, so all three are sealed uniformly with the per-network key.
   *
   * When sealing is requested but no key is held, it warns ONCE per network
   * (loud-but-not-fatal) and returns the cleartext envelope — federation stays
   * up. Any seal failure also falls back to cleartext + a log (never crash the
   * publish path). Returns `envelope` unchanged in every non-sealing case.
   */
  const maybeSealOutbound = async (
    envelope: Envelope,
    subject: string,
  ): Promise<Envelope> => {
    if (!subject.startsWith("federated.")) return envelope;
    const targetPrincipal = subject.split(".")[1];
    if (targetPrincipal === undefined || targetPrincipal.length === 0) {
      return envelope;
    }
    const policy: NetworkSealPolicy | undefined =
      sealPolicyByPrincipal.get(targetPrincipal);
    if (policy === undefined) {
      // cortex#1246 — no seal policy resolved for this federated subject. For a
      // peer-addressed subject this is correct (the target's network is not
      // encryption-enabled → cleartext as today). But a SELF-addressed subject
      // (`federated.{ownPrincipal}.…`, e.g. an Offer) only lands here when the
      // stack is on MULTIPLE encryption-enabled networks (single-network maps the
      // own principal in `sealPolicyByPrincipal`): the network is unresolvable
      // from a self-addressed subject alone, so we publish cleartext but WARN
      // ONCE — a federated Offer in the clear must never be silent (ADR-0019 §7).
      if (
        targetPrincipal === myPrincipal &&
        encryptionEnabledNetworkCount > 1 &&
        !selfAddressedAmbiguousSealWarned
      ) {
        selfAddressedAmbiguousSealWarned = true;
        console.error(
          `myelin-runtime: self-addressed federated subject "${subject}" (own principal="${myPrincipal}") could NOT be sealed — the stack is on ${encryptionEnabledNetworkCount} encryption-enabled networks and the network is not resolvable from a self-addressed subject alone (cortex#1246 multi-network follow-up). Publishing IN THE CLEAR. This is a loud-but-not-fatal warning.`,
        );
      }
      return envelope; // network not encryption-enabled (or unresolvable self-addr)
    }
    if (policy.key === undefined) {
      // Encryption requested but PR5b has not delivered `K` yet — warn once,
      // publish cleartext (ADR-0019 §7 loud-but-not-fatal). The federated link
      // stays up; "federating in the clear" is visible in the log.
      if (!sealKeyMissingWarned.has(policy.net)) {
        sealKeyMissingWarned.add(policy.net);
        console.error(
          `myelin-runtime: network="${policy.net}" has encryption="${policy.mode}" but NO payload_key — publishing federated payloads to principal="${targetPrincipal}" IN THE CLEAR until the network key is delivered (ADR-0019 §7). This is a loud-but-not-fatal warning.`,
        );
      }
      return envelope;
    }
    try {
      return await sealPayload(envelope, policy.net, policy.key);
    } catch (err) {
      // Never crash the publish path on a seal failure — fall back to cleartext
      // (a `required` network's receiver will reject it, surfacing the problem
      // without dropping the sender). Log so the failure is visible.
      console.error(
        `myelin-runtime: payload seal failed for id=${envelope.id} network="${policy.net}" — publishing cleartext:`,
        err instanceof Error ? err.message : err,
      );
      return envelope;
    }
  };

  /**
   * Shared sign + wire-publish core. `publishEnabled` derives the
   * subject from `envelope.type` via `deriveNatsSubject`; the
   * cortex#409 `publishOnSubjectEnabled` path passes an explicit
   * subject built from `directTaskSubject`-style helpers. Both then
   * share the post-stop guard, signer wiring, and stderr-logged
   * link.publish below.
   *
   * F-3b (cortex#659): selects the target `PoolLink` from the resolved
   * subject FIRST (pure `selectLink`), then signs + publishes on THAT
   * link. An unknown federated network skips the publish (returns after
   * `onRoutingError` already fired inside `selectLink`).
   */
  const signAndPublishOnSubject = async (
    envelope: Envelope,
    subject: string,
  ): Promise<void> => {
    if (stopped) {
      // Post-stop publish: short-circuit. The runtime's `link.drain()`
      // (called inside `stop()` below) flushes pending publishes before the
      // underlying connection closes; a publish call that races between
      // `stopped = true` and `link.close()` would either flush along with
      // drain or be dropped silently — never crash the caller. The check
      // here is belt-and-braces: the underlying nats client is already
      // drain-safe, but short-circuiting at this layer keeps the contract
      // explicit ("publish-after-stop is a no-op") and saves a JSON.stringify
      // of the envelope on the shutdown path.
      return;
    }

    // F-3b (cortex#659): select the target link from the resolved subject
    // BEFORE signing. An unknown federated network returns null —
    // `selectLink` already fired `onRoutingError`; skip the publish (do
    // NOT fall back to primary, per design §3.2: a misrouted federated
    // subject must never leak onto the wrong link).
    const target = selectLink(subject, envelope.id);
    if (target === null) {
      return;
    }
    // F-3c (cortex#662): `selectLink` only ever returns a `PoolLink` whose
    // `link` is live (primary is always up; a down leaf fails closed inside
    // `selectLink`). Capture the non-null link in a local so the publish
    // below avoids a forbidden non-null assertion on the nullable
    // `PoolLink.link`. The guard documents the invariant explicitly.
    const targetLink = target.link;
    if (targetLink === null) {
      // Unreachable in practice (selectLink's contract), but a typed guard
      // beats an assertion — and if a future selectLink path ever returned a
      // down link, this fails closed (skip) rather than dereferencing null.
      return;
    }

    // M3 (cortex#1241, ADR-0019) — ENCRYPT-THEN-SIGN. Seal the `payload` with
    // the target network's key BEFORE the signer runs below, so the existing
    // `signed_by` signature covers the CIPHERTEXT (the §4 verify-before-decrypt
    // property). The seal is gated on a `federated.*` subject whose target
    // principal lives on an encryption-enabled network that holds a key; in
    // every other case `sealed` === `envelope` and the path is unchanged.
    const sealed = await maybeSealOutbound(envelope, subject);

    // IAW Phase B.3: sign before publish if the runtime was started
    // with a signer. The chain-aware `signEnvelope` appends to any
    // existing `signed_by[]` rather than overwriting — so a multi-hop
    // envelope forwarded through this stack picks up an additional
    // stamp committed to the prior chain. Failure to sign falls back
    // to the original envelope plus a log — we don't want a transient
    // crypto failure (extremely rare; bad seed bytes typically fail
    // at `loadStackSigningKey` time) to crash the publish path.
    //
    // M3: the signer operates on `sealed` (ciphertext-in-`payload` when the
    // seal engaged), so the chain signs the sealed form — encrypt-then-sign.
    let envelopeToPublish: Envelope = sealed;
    if (signer !== undefined && signerSeedBase64 !== undefined) {
      try {
        // Normalize signed_by to the array shape myelin's
        // `signEnvelope` expects (MyelinEnvelope tightens
        // `signed_by` to `SignedBy[] | undefined` whereas cortex's
        // back-compat Envelope still allows a single stamp). The
        // signer appends to the existing chain when present.
        const priorChain =
          sealed.signed_by === undefined
            ? undefined
            : Array.isArray(sealed.signed_by)
              ? sealed.signed_by
              : [sealed.signed_by];
        const envelopeForSigner = {
          ...sealed,
          ...(priorChain !== undefined && { signed_by: priorChain }),
        };
        envelopeToPublish = await signEnvelope(
          envelopeForSigner as Parameters<typeof signEnvelope>[0],
          signerSeedBase64,
          signer.principal,
        );
      } catch (err) {
        // Sign failure handling — see `MyelinRuntimeOptions.signFailureMode`
        // for the full rationale. `fallback` publishes unsigned (safe
        // while subscribe side is non-enforcing); `drop` skips publish
        // entirely (safe once subscribe side enforces verification).
        //
        // Log message deliberately omits `err.message` interpolation
        // when the error origin is myelin's `signEnvelope` — that
        // function constructs error strings from inputs (e.g.
        // "Invalid private key: expected 32-byte Ed25519 seed, got N
        // bytes") and we don't want even partial seed-shape facts
        // landing in principal logs. The error class + envelope id
        // gives principals enough to triage.
        const reason = err instanceof Error ? err.name : "unknown";
        if (signFailureMode === "drop") {
          console.error(
            `myelin-runtime: sign failed for id=${envelope.id} type=${envelope.type} reason=${reason} — DROPPING (signFailureMode=drop)`,
          );
          return;
        }
        console.error(
          `myelin-runtime: sign failed for id=${envelope.id} type=${envelope.type} reason=${reason} — publishing unsigned (signFailureMode=fallback)`,
        );
      }
    }

    // cortex#420 major-3: do NOT swallow `link.publish` errors here.
    // The legacy `publish()` contract ("logged and swallowed") is
    // preserved by `publishEnabled` below catching + logging at its
    // call site; the cortex#409 `publishOnSubject` path needs
    // transport-level failures to PROPAGATE so the dispatch-handler
    // can fall through to the legacy in-process path (silent drops
    // here would mean inbound chat dispatches are lost when the bus
    // is unreachable).
    //
    // F-3b (cortex#659): publish on the SELECTED link, not the module
    // singleton — `federated.{network_id}.…` lands on that network's leaf,
    // `local.*` / `public.*` on primary.
    //
    // F-3c (cortex#662): publish on the captured non-null `targetLink`
    // (narrowed above) — a down leaf never reaches here.
    // RFC-0007 §6.3 (grill D12): carry the envelope id as `Nats-Msg-Id` so
    // JetStream deduplicates a duplicated/retried publish of the same
    // envelope within the stream's `duplicate_window`. `envelope.id` is the
    // canonical, signature-stable id (sealing/signing above never rewrite
    // it), so it is the dedup key the spec names.
    targetLink.publish(subject, JSON.stringify(envelopeToPublish), envelope.id);
  };

  const publishEnabled = async (envelope: Envelope): Promise<void> => {
    // IAW Phase A.3: subject derivation now mirrors
    // `envelope.sovereignty.classification`. Prior code hardcoded
    // `local.{principal}.{type}` here, making federated/public emission
    // structurally impossible — `{principal}` came from the boot-resolved
    // principal id and the classification prefix was always "local".
    // `deriveNatsSubject` reads classification + extracts `{principal}`
    // from `envelope.source` so the 1:1 subject↔classification invariant
    // (`validateSubjectEnvelopeAlignment`) holds for every emit site
    // without further changes. `envelope.source`'s first segment is the
    // same value the boot-resolved `principal.id` produces when emit-site
    // helpers assemble it (cortex#429 PR-C — flows in via
    // `MyelinRuntimeOptions.principal`), so subscribe-side `{principal}`
    // substitution stays symmetric.
    //
    // IAW Phase A.5 (cortex#262 closes): pass `stack` so subjects land in
    // the 6-segment `local.{principal}.{stack}.{type}` grammar that sage's
    // bridge + pilot's review-request subscriber expect. When undefined,
    // `deriveNatsSubject` returns the legacy 5-segment shape — preserving
    // emit-site behavior for deployments that haven't wired stack identity.
    const subject = deriveNatsSubject(envelope, stack);
    try {
      await signAndPublishOnSubject(envelope, subject);
    } catch (err) {
      // Legacy `publish()` contract — errors at publish time are
      // logged and swallowed (a failing operational event must NOT
      // escalate into a crash, particularly when the bot is already
      // in a degraded state). The cortex#409 `publishOnSubject`
      // path lets transport errors propagate; this wrapper preserves
      // the long-standing fire-and-forget posture on `publish()`.
      // cortex#420 major-3.
      console.error(
        `myelin-runtime: publish failed for subject=${subject} id=${envelope.id} type=${envelope.type}:`,
        err instanceof Error ? err.message : err,
      );
    }
  };

  /**
   * cortex#409 Direction A Stage 4 — publish on an EXPLICIT subject.
   * See the docblock on `MyelinRuntime.publishOnSubject` for the
   * canonical use case (Direct-mode `tasks.@{did-encoded-assistant}.{capability}`
   * subjects whose `@`-prefixed segment cannot live in `envelope.type`).
   *
   * Subject alignment with `envelope.sovereignty.classification` is the
   * caller's responsibility — this method does NOT call
   * `validateSubjectEnvelopeAlignment` because callers compose subjects
   * with classification-aware helpers (`directTaskSubject` already
   * emits `local.` / `federated.` per its input). Adding a guard here
   * would be belt-and-braces; we defer to the helper's contract.
   */
  const publishOnSubjectEnabled = async (
    envelope: Envelope,
    subject: string,
  ): Promise<void> => {
    await signAndPublishOnSubject(envelope, subject);
  };

  // Subscribe-pull helper for the enabled path — wraps
  // `MyelinSubscriber.start` against the closure-captured `link` so
  // capability-side consumers (e.g. ReviewConsumer, future
  // capability-dispatch consumers) can bind to JetStream pull consumers
  // without seeing the bare link. Each subscriber is tracked on the
  // local `subscribers[]` array so `stop()` drains it alongside the
  // runtime's own subscriptions.
  const subscribePullEnabled = (
    opts: MyelinSubscribePullOpts,
  ): MyelinSubscriber => {
    if (stopped) {
      // Post-stop subscribe attempts are a contract violation — the
      // runtime is no longer servicing new subscriptions. Throw rather
      // than silently return a dormant subscriber so the principal-
      // facing call site (consumer.start) surfaces the misuse via its
      // own try/catch + stderr path.
      throw new Error(
        "myelin-runtime: subscribePull called after stop()",
      );
    }
    const pull: {
      stream: string;
      durable: string;
      maxMessages?: number;
      expiresMs?: number;
      thresholdMessages?: number;
    } = { stream: opts.stream, durable: opts.durable };
    if (opts.maxMessages !== undefined) pull.maxMessages = opts.maxMessages;
    if (opts.expiresMs !== undefined) pull.expiresMs = opts.expiresMs;
    if (opts.thresholdMessages !== undefined) {
      pull.thresholdMessages = opts.thresholdMessages;
    }
    const sub = MyelinSubscriber.start(link, {
      pattern: opts.pattern,
      mode: "pull",
      pull,
      onEnvelope: opts.onEnvelope,
      ...(opts.onError !== undefined && { onError: opts.onError }),
    });
    subscribers.push(sub);
    return sub;
  };

  // cortex#477 — push-mode subscribe helper for the enabled path. Lets
  // listeners (today: `createDispatchListener`) self-subscribe to their
  // declared interest at `start()` time rather than relying on
  // `nats.subjects[]` in `cortex.yaml` being a superset (an unenforced
  // cross-config invariant that silently broke deployments whose config
  // wasn't kept in lockstep with the listener's canonical pattern). The
  // returned subscriber fans out through the same `handlers` set used by
  // the boot-time push subscribers — any `runtime.onEnvelope` handler
  // (e.g. the `SurfaceRouter`'s) receives matching envelopes without
  // any extra wiring on the caller's side. Tracked on the same
  // `subscribers[]` array so `runtime.stop()` drains it alongside the
  // boot-time subs.
  //
  // Returns `null` if `MyelinSubscriber.start` throws — same
  // log-and-continue contract as the boot-time loop above. Throwing on
  // post-stop is symmetric with `subscribePullEnabled` (deliberate
  // contract violation; caller should surface via its own try/catch).
  const subscribePushEnabled = async (
    pattern: string,
  ): Promise<MyelinSubscriber | null> => {
    if (stopped) {
      throw new Error("myelin-runtime: subscribe called after stop()");
    }
    // cortex#491 — route through the shared idempotent binder so a self-
    // subscribe that collides with a boot-time `nats.subjects` pattern (or
    // an earlier self-subscribe of the same pattern) returns the EXISTING
    // subscriber instead of double-binding the shared `handlers` Set. The
    // binder owns its own try/catch + logging; `null` means start() threw.
    // F-3d (cortex#666): the self-subscribe path stays bound to the PRIMARY
    // link (design §3.5 — broad-pattern push is primary-only; per-network
    // inbound is the boot-time per-leaf loop above). Primary delivery is never
    // spoof-checked, so a self-subscribed handler sees `sourceLink: "primary"`.
    const sub = bindPushPattern(primary, pattern);
    if (sub === null) return null;
    // Await readiness on every call (including the deduped return): the
    // already-bound subscriber's `ready` promise resolves immediately when
    // it has already settled, so the caller's "subscription is live" contract
    // holds whether this call created the subscriber or reused it.
    await sub.ready;
    return sub;
  };

  // cortex#338 — expose the live JetStreamManager so the boot path can
  // provision streams + per-agent durables before `ReviewConsumer.start`
  // binds to them. Cached on first call so the boot path doesn't pay a
  // server round-trip per per-agent provisioning call.
  //
  // F-3b (cortex#659): `jetstreamManager` stays bound to the PRIMARY link
  // (design §3.5 — no per-network JetStream durables in F-3). The cache
  // lives on the primary `PoolLink` (`primary.jsmCache`).
  const jetstreamManagerEnabled = (): Promise<import("nats").JetStreamManager> => {
    // F-3c (cortex#662): primary is always connected here (a primary failure
    // short-circuits the runtime above) — use the non-null `primaryLink`
    // binding rather than asserting on the now-nullable `primary.link`.
    primary.jsmCache ??= primaryLink.raw.jetstreamManager();
    return primary.jsmCache;
  };

  // R26 P1 (cortex#1371) — narrow KV capability, PRIMARY-link-bound like the
  // JSM above (no per-network KV). `views.kv` creates the bucket when absent
  // (history=1: only the latest revision of an admission counter matters) and
  // binds otherwise — idempotent, matching the provisioning helpers' contract.
  // nats.js's `KV` satisfies the narrow `ProvisionKv` shape structurally.
  const kvBucketEnabled = async (
    name: string,
  ): Promise<import("nats").KV> => {
    return primaryLink.raw.jetstream().views.kv(name, { history: 1 });
  };

  return {
    enabled: true,
    onEnvelope,
    publish: publishEnabled,
    publishOnSubject: publishOnSubjectEnabled,
    subscribePull: subscribePullEnabled,
    subscribe: subscribePushEnabled,
    jetstreamManager: jetstreamManagerEnabled,
    kvBucket: kvBucketEnabled,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // IAW Phase F-3c (cortex#662) — cancel any pending background-reconnect
      // timers FIRST, before draining, so no leaf reconnect fires during or
      // after teardown (no leaked timer, no post-stop reconnect). Setting
      // `stopped` above also makes any reconnect callback that races past the
      // clear a no-op (it re-checks `stopped`). This is the load-bearing
      // "stop() cancels pending reconnect timers" guarantee.
      for (const p of pool.values()) {
        if (p.reconnectHandle !== null) {
          clearReconnectTimer(p.reconnectHandle);
          p.reconnectHandle = null;
        }
      }
      // F-3b (cortex#659): drain EVERY pool link's subscribers, then close
      // EVERY link. `allSettled` throughout so one link's drain/close
      // failure does not block another's (design §3.4). Leaf links carry
      // empty subscriber sets in F-3b (publish-only) but are drained +
      // closed uniformly so F-3c/F-3d can add per-link subscribers without
      // touching this teardown.
      await Promise.allSettled(
        [...pool.values()].flatMap((p) => p.subscribers.map((s) => s.stop())),
      );
      // F-3c (cortex#662): a DOWN leaf has `link: null` (never connected) —
      // nothing to close; skip it. Live links (primary + reconnected leaves)
      // close best-effort.
      await Promise.allSettled(
        [...pool.values()].map((p) =>
          p.link === null
            ? Promise.resolve()
            : p.link.close().catch((err: unknown) => {
                console.error(
                  `myelin-runtime: close error (link=${p.linkId}):`,
                  err instanceof Error ? err.message : String(err),
                );
              }),
        ),
      );
      console.log("myelin-runtime: stopped");
    },
  };
}

/**
 * Default envelope handler for G-1100.E — log enough context that an
 * principal triaging a missing-message complaint can find the envelope
 * in the bus. Fan-out to specific event handlers (pilot errand
 * projection, signal alert ingestion, etc.) is the next iteration's
 * work and uses the same Envelope type from this layer.
 */
function logEnvelope(env: Envelope, subject: string): void {
  const corr = env.correlation_id ? ` correlation=${env.correlation_id}` : "";
  console.log(
    `myelin-runtime: received envelope subject=${subject} id=${env.id} type=${env.type}${corr}`,
  );
}
