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
import { NatsLink } from "../nats/connection";
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

/**
 * Per-envelope handler. Receives validated envelopes from any active
 * subscription, with the actual NATS subject (so wildcard-pattern
 * subscribers can route on the concrete subject — see
 * `src/bus/surface-router.ts`, G-1111.A).
 */
export type EnvelopeHandler = (envelope: Envelope, subject: string) => void;

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
   * as today, unchanged for callers that haven't opted in. Operators
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
   * `resolvePrincipalId(options.operator)`; when undefined, the
   * substituter falls back to `"default"` to preserve legacy NATS-less
   * runtime no-op semantics.
   */
  principal?: string;
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
  // eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/require-await
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

  // eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/require-await
  const stopDisabled = async () => {};

  // cortex#338 — disabled JSM helper mirrors `subscribePullDisabled`.
  // Boot path calls `runtime.jetstreamManager()` to provision streams /
  // consumers; a null resolution means "no link, no provisioning" and
  // the caller must skip.
  // eslint-disable-next-line @typescript-eslint/require-await
  const jetstreamManagerDisabled = async (): Promise<null> => null;

  if (!config.nats?.url) {
    return {
      enabled: false,
      onEnvelope,
      publish: publishDisabled,
      subscribePull: subscribePullDisabled,
      subscribe: subscribePushDisabled,
      jetstreamManager: jetstreamManagerDisabled,
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

  let link: NatsLink;
  const safeUrl = nats.url.replace(/\/\/[^@/]+@/, "//***@");
  try {
    link = await NatsLink.connect({
      url: nats.url,
      token: nats.token,
      // cortex#86: operator-mode auth path. NatsLink loader expands ~/
      // and enforces chmod 600; if both token and credsPath are set,
      // credsPath wins with a warn log.
      ...(nats.credsPath ? { credsPath: nats.credsPath } : {}),
      name: nats.name,
      ...(options?.connectImpl ? { connectImpl: options.connectImpl } : {}),
    });
    console.log(
      `myelin-runtime: connected to ${safeUrl} as "${nats.name}"`,
    );
  } catch (err) {
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
      stop: stopDisabled,
    };
  }

  const subscribers: MyelinSubscriber[] = [];
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
  const boundByPattern = new Map<string, MyelinSubscriber>();
  /**
   * Bind one resolved push pattern idempotently. Returns the already-bound
   * subscriber on a duplicate, or `null` if `MyelinSubscriber.start` threw.
   * Shared by the boot loop and `subscribePushEnabled`.
   */
  const bindPushPattern = (pattern: string): MyelinSubscriber | null => {
    const existing = boundByPattern.get(pattern);
    if (existing !== undefined) {
      console.log(
        `myelin-runtime: skipping duplicate subscribe to "${pattern}" (already bound)`,
      );
      return existing;
    }
    try {
      const sub = MyelinSubscriber.start(link, {
        pattern,
        onEnvelope: (env, subject) => {
          logEnvelope(env, subject);
          // Fan out to registered handlers. Each handler runs in its
          // own try/catch so one slow/failing consumer can't poison
          // the others (router-level isolation lives in the
          // surface-router; this is a defensive last line).
          for (const handler of handlers) {
            try {
              handler(env, subject);
            } catch (err) {
              console.error(
                "myelin-runtime: onEnvelope handler threw:",
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        },
      });
      subscribers.push(sub);
      boundByPattern.set(pattern, sub);
      console.log(`myelin-runtime: subscribed to "${pattern}"`);
      return sub;
    } catch (err) {
      console.error(
        `myelin-runtime: failed to subscribe to "${pattern}":`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  };
  for (const pattern of subjects) {
    bindPushPattern(pattern);
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
    await link.close().catch(() => {
      // best-effort close on no-subscribers path; ignore errors
    });
    return {
      enabled: false,
      onEnvelope,
      publish: publishDisabled,
      subscribePull: subscribePullDisabled,
      subscribe: subscribePushDisabled,
      jetstreamManager: jetstreamManagerDisabled,
      stop: stopDisabled,
    };
  }

  let stopped = false;

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

  /**
   * Shared sign + wire-publish core. `publishEnabled` derives the
   * subject from `envelope.type` via `deriveNatsSubject`; the
   * cortex#409 `publishOnSubjectEnabled` path passes an explicit
   * subject built from `directTaskSubject`-style helpers. Both then
   * share the post-stop guard, signer wiring, and stderr-logged
   * link.publish below.
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

    // IAW Phase B.3: sign before publish if the runtime was started
    // with a signer. The chain-aware `signEnvelope` appends to any
    // existing `signed_by[]` rather than overwriting — so a multi-hop
    // envelope forwarded through this stack picks up an additional
    // stamp committed to the prior chain. Failure to sign falls back
    // to the original envelope plus a log — we don't want a transient
    // crypto failure (extremely rare; bad seed bytes typically fail
    // at `loadStackSigningKey` time) to crash the publish path.
    let envelopeToPublish: Envelope = envelope;
    if (signer !== undefined && signerSeedBase64 !== undefined) {
      try {
        // Normalize signed_by to the array shape myelin's
        // `signEnvelope` expects (MyelinEnvelope tightens
        // `signed_by` to `SignedBy[] | undefined` whereas cortex's
        // back-compat Envelope still allows a single stamp). The
        // signer appends to the existing chain when present.
        const priorChain =
          envelope.signed_by === undefined
            ? undefined
            : Array.isArray(envelope.signed_by)
              ? envelope.signed_by
              : [envelope.signed_by];
        const envelopeForSigner = {
          ...envelope,
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
    link.publish(subject, JSON.stringify(envelopeToPublish));
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
    const sub = bindPushPattern(pattern);
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
  let jsmCache: Promise<import("nats").JetStreamManager> | null = null;
  const jetstreamManagerEnabled = (): Promise<import("nats").JetStreamManager> => {
    jsmCache ??= link.raw.jetstreamManager();
    return jsmCache;
  };

  return {
    enabled: true,
    onEnvelope,
    publish: publishEnabled,
    publishOnSubject: publishOnSubjectEnabled,
    subscribePull: subscribePullEnabled,
    subscribe: subscribePushEnabled,
    jetstreamManager: jetstreamManagerEnabled,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // Drain subscribers first so they exit cleanly; then close the
      // underlying link.
      await Promise.allSettled(subscribers.map((s) => s.stop()));
      await link.close().catch((err: unknown) => {
        console.error(
          "myelin-runtime: close error:",
          err instanceof Error ? err.message : String(err),
        );
      });
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
