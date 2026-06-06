/**
 * G-1111.A — Surface router (cortex MIG-1.9).
 *
 * Per `/tmp/g-1111-spec.md` §5: the in-process fan-out point that
 * dispatches one validated envelope to N matching surface adapters.
 * Adapters declare interest via NATS-style subject patterns plus an
 * optional payload filter; the router applies broker-side subject
 * matching first (cheap), then payload filtering (expressive), then
 * invokes `adapter.render(envelope)` with timeout + isolation.
 *
 * Component placement (spec §5.1):
 *   MyelinRuntime owns the NATS subscription. The router does NOT open
 *   its own subscriptions. Adapters never subscribe directly.
 *
 * Integration with MyelinRuntime (current cortex state):
 *   The G-1100.E `MyelinRuntime` interface today is `{ enabled, stop() }`
 *   only — it hard-codes `logEnvelope` as the per-envelope handler and
 *   exposes no public registration point for an external consumer like
 *   this router. Wiring the router to receive live envelopes therefore
 *   requires a runtime change to add an `onEnvelope(handler)` registration
 *   surface, which is explicitly out of scope for this PR (per the task
 *   contract: "DO NOT modify MyelinRuntime in this PR").
 *
 *   This file ships the router as a self-contained dispatcher whose
 *   public `dispatch(envelope, subject?)` is the integration entry point.
 *   Tests exercise it directly. A follow-up PR will add the runtime hook
 *   so production envelopes flow into `dispatch()`.
 *
 * Per spec §5.3: failing adapters MUST NOT block others. Render calls
 * fan out via `Promise.allSettled`; each is wrapped in a per-render
 * timeout (default 5s); errors and timeouts are captured via the
 * optional `onAdapterError` hook and never thrown out of `dispatch()`.
 */

import type {
  PolicyFederated,
  PolicyFederatedNetwork,
  PolicyPublic,
  RendererVisibility,
} from "../common/types/cortex-config";
import {
  createSystemAccessFederationDeniedEvent,
  createSystemAccessFilteredEvent,
  type SystemAccessFederationDeniedOpts,
  type SystemAccessFilteredReason,
  type SystemAccessSignedBy,
  type SystemAccessSovereignty,
  type SystemEventSource,
} from "./system-events";
import {
  getSignedByChain,
  principalFromEnvelope,
  type Envelope,
} from "./myelin/envelope-validator";
import type { MyelinRuntime } from "./myelin/runtime";
import { matchesFilter, type PayloadFilter } from "./payload-filter";

// =============================================================================
// Public types
// =============================================================================

/**
 * One surface adapter. Adapters are dumb-by-design — they declare their
 * NATS subject patterns + an optional payload filter and a `render()`
 * function. The router does the matching + isolation; the adapter just
 * renders.
 */
export interface SurfaceAdapter {
  /** Stable identifier — used in error reporting and metrics. */
  id: string;
  /** One or more NATS subject patterns (union — match ANY). */
  subjects: string[];
  /** Optional client-side filter applied AFTER subject match. */
  filter?: PayloadFilter;
  /**
   * IAW Phase A.4 — optional visibility constraints. When set, the router
   * evaluates the envelope's `sovereignty` against each active rule
   * (residency / model_class / max_classification) BEFORE invoking
   * `render()`. Drops emit a `system.access.filtered` envelope so principals
   * can observe access decisions.
   *
   * Unset (the v1 default) means "no visibility filter" — the adapter
   * receives every envelope that passes subject + payload filters, matching
   * pre-A.4 behaviour exactly. See {@link RendererVisibility} for rule
   * semantics.
   */
  visibility?: RendererVisibility;
  /**
   * Adapter-specific rendering. Bounded by router's renderTimeoutMs.
   *
   * `signal` is an opt-in `AbortSignal` that fires when the router's per-render
   * timeout elapses. Adapters that issue I/O (HTTP, NATS, sub-process) SHOULD
   * forward the signal to those calls so the loser of `Promise.race` is
   * actually cancelled — without it, the timed-out work keeps running in the
   * background, holding sockets and spending quota. Adapters that do nothing
   * but synchronous CPU (mocks, formatters) MAY accept the parameter and
   * ignore it; the contract is opt-in for backwards compatibility with
   * existing render functions.
   *
   * **IAW Phase D.3 (cortex#116) — `subject`.** Optional third argument
   * carrying the matched NATS subject. Adapters that need to derive
   * federation context from the wire path (e.g. the dispatch-listener
   * deriving `source_network` from `federated.{network_id}.>`) read
   * this directly rather than re-parsing the envelope. Existing
   * adapters that match `(envelope, signal)` continue to work — the
   * parameter is additive and ignored by adapters that don't accept
   * it.
   */
  render(
    envelope: Envelope,
    signal?: AbortSignal,
    subject?: string,
  ): Promise<void>;
  /** Optional liveness probe. Currently unused by the router; reserved
   *  for the dashboard's adapter-health panel (G-1111.E follow-on). */
  health?(): Promise<{ ok: boolean; lag?: number }>;
}

export interface SurfaceRouterOptions {
  /** Per-render timeout in ms. Default 5000 (per spec §7.5). */
  renderTimeoutMs?: number;
  /** Hook called on render error or timeout. Signature is intentionally
   *  fire-and-forget — the router never awaits this. Throws inside this
   *  hook are swallowed (with a console.error) so a buggy hook can't
   *  poison the dispatch loop. */
  onAdapterError?(adapterId: string, err: Error): void;
  /**
   * IAW Phase A.4 — source struct used when emitting
   * `system.access.filtered` envelopes on visibility-drop. When omitted,
   * visibility filtering still runs (drops are honoured + logged) but no
   * envelope is emitted — useful in unit tests and pre-MIG-7.2 startup
   * paths where `SystemEventSource` isn't constructed yet. Production
   * callers (cortex.ts) SHOULD pass the same struct used by the rest of
   * the `system.*` emit sites so the access-decision stream stamps the
   * correct principal/agent/instance segments.
   */
  systemEventSource?: SystemEventSource;
  /**
   * IAW Phase D.2 — `policy.federated` block from cortex.yaml. When
   * supplied, the router gates every inbound `federated.*` envelope
   * against the declared network's `accept_subjects` / `deny_subjects`
   * lists + `max_hop` budget BEFORE adapter fan-out. Denials drop the
   * envelope from dispatch AND emit `system.access.denied` carrying the
   * structured reason (mirror of the C.4 dispatch-listener gate's audit
   * pattern).
   *
   * When omitted or `networks[]` is empty, the gate is fully inert —
   * `federated.*` envelopes pass through to adapter matching unchanged.
   * This mirrors the C.3.1 policy-engine contract (no `policy:` block
   * → no dispatch gating) and keeps cortex.yaml without `federated:`
   * fully back-compat with pre-D.2 behaviour. Principals opt into
   * federation enforcement by declaring at least one network.
   *
   * Subject-pattern gating only applies to envelopes whose subject
   * starts with `federated.`. Subjects in the `local.*` / `public.*`
   * domains pass through this gate untouched (visibility / dispatch
   * gates handle those).
   */
  federated?: PolicyFederated;
  /**
   * IAW S5 (#739) — the `policy.public` block. When the principal has opted
   * into the public scope (`cortex network join public`), this carries the
   * inbound allowlist. The router gates every inbound `public.*` envelope
   * against {@link evaluatePublicGate}:
   *
   *   - block ABSENT or `enabled: false` → inbound `public.*` is DROPPED
   *     (not opted in; a public sender is never auto-trusted).
   *   - `enabled: true` → admit ONLY senders whose source principal is in
   *     `allow_principals[]` (empty = drop everyone — OQ1 safe default; no
   *     open anonymous claim).
   *
   * This closes the OQ1 gap the pre-S5 router left open ("none for public" in
   * the dispatch comment): public inbound was previously ungated. Announcing
   * capabilities to the registry is a separate control-plane action and does
   * NOT relax this gate.
   */
  public?: PolicyPublic;
}

export interface SurfaceRouter {
  /** Register an adapter. Returns an unregister handle for symmetry with
   *  EventEmitter / RxJS / etc. patterns. */
  register(adapter: SurfaceAdapter): { unregister: () => void };
  /** Mark the router as ready to dispatch. Idempotent. Today this is a
   *  state transition only; once the runtime exposes an `onEnvelope`
   *  hook, `start()` will be where we register that. */
  start(): Promise<void>;
  /** Stop accepting new dispatches. After stop, `dispatch()` is a no-op
   *  (still returns a resolved promise). Idempotent. */
  stop(): Promise<void>;
  /** Dispatch one envelope to all matching adapters. Subject is optional;
   *  when omitted, it is derived from `envelope.type` for local testing.
   *  Production callers (the future runtime hook) MUST pass the actual
   *  NATS subject so wildcard patterns match correctly.
   *
   *  IAW Phase F-3d (cortex#666) — optional trailing `sourceLink` carrying
   *  the delivering pool link's `linkId` (`"primary"` or a federated
   *  `leaf_node`), threaded from the runtime's `onEnvelope` fan-out. The
   *  federation gate consumes it as an ADDITIVE anti-spoof cross-check: a
   *  `federated.{X}.…` subject delivered on a link NOT owning network X is
   *  rejected. Omitted (or `undefined`) preserves pre-F-3d behaviour
   *  exactly — the cross-check only runs when an attribution is supplied,
   *  so existing 2-arg callers and single-link deployments are unchanged. */
  dispatch(
    envelope: Envelope,
    subject?: string,
    sourceLink?: string,
  ): Promise<void>;
}

// =============================================================================
// Subject-pattern matching (NATS-style)
// =============================================================================

/**
 * NATS-style subject-pattern match.
 *
 *   `>` matches one-or-more trailing segments (must be the LAST token).
 *   `*` matches exactly one segment.
 *   Otherwise literal segment compare.
 *
 * Examples (from spec §4.2):
 *   `local.metafactory.review.>`          matches any review.* depth ≥ 1
 *   `local.metafactory.review.*.completed` matches one segment between review and completed
 *   `local.metafactory.review.cycle.completed` literal — itself only
 *
 * Edge cases:
 *   - `>` anywhere but the terminal position: treated as a literal segment
 *     (NATS rejects this at subscribe time; we mirror by being conservative).
 *   - Empty pattern or empty subject: never matches.
 *   - `>` alone matches every non-empty subject.
 */
export function subjectMatches(pattern: string, subject: string): boolean {
  if (pattern.length === 0 || subject.length === 0) return false;

  const patternParts = pattern.split(".");
  const subjectParts = subject.split(".");
  const pLen = patternParts.length;
  const sLen = subjectParts.length;

  for (let i = 0; i < pLen; i++) {
    const p = patternParts[i];

    if (p === ">") {
      // `>` must be terminal; if not, fall through to literal comparison
      // and necessarily fail (since "no segment can equal `>`" is a
      // safe interpretation of malformed patterns).
      if (i !== pLen - 1) return false;
      // Terminal `>`: needs at least one subject segment remaining.
      return sLen >= pLen;
    }

    // No more subject segments to consume — pattern is longer than
    // subject (and we haven't hit a `>`), so no match.
    if (i >= sLen) return false;

    if (p === "*") {
      // `*` matches exactly one segment (any content). Continue.
      continue;
    }

    // Literal compare.
    if (p !== subjectParts[i]) return false;
  }

  // Pattern fully consumed without a `>`. Subject must have the same
  // length to match (no excess trailing segments).
  return pLen === sLen;
}

// =============================================================================
// Implementation
// =============================================================================

const DEFAULT_RENDER_TIMEOUT_MS = 5000;

/**
 * Construct a surface router that consumes envelopes from
 * `MyelinRuntime`. On `start()`, the router registers an
 * `onEnvelope` handler with the runtime; on `stop()`, the
 * registration unwinds. Production callers should construct the
 * router after `startMyelinRuntime` returns and `await router.start()`
 * before publishing.
 */
export function createSurfaceRouter(
  runtime: MyelinRuntime,
  opts?: SurfaceRouterOptions,
): SurfaceRouter {
  const adapters: SurfaceAdapter[] = [];
  const renderTimeoutMs = opts?.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  // Captured as a plain function reference. unbound-method fires here
  // because the type tree sees this as a method that *might* read `this`;
  // for cortex's use case (callbacks supplied by the principal config),
  // unbound is the intended shape.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const onAdapterError = opts?.onAdapterError;
  const systemEventSource = opts?.systemEventSource;

  // IAW Phase D.2 — index networks by id for O(1) prefix lookup. The
  // schema's cross-validation (`PolicySchema.superRefine`) already
  // guarantees uniqueness of `network.id`, so this Map is collision-free.
  // We build it once at construction time; reloading the federation
  // policy at runtime requires reconstructing the router, which matches
  // the policy-block contract (engine is rebuilt on cortex.yaml reload).
  const federatedNetworksById = new Map<string, PolicyFederatedNetwork>();
  for (const network of opts?.federated?.networks ?? []) {
    federatedNetworksById.set(network.id, network);
  }

  // IAW S5 (#739) — the public-scope opt-in + allowlist. Captured once at
  // construction (same reload contract as `federated`). `undefined` ⇒ not
  // opted into public; the gate drops all inbound `public.*`.
  const policyPublic: PolicyPublic | undefined = opts?.public;

  let started = false;
  let stopped = false;
  let envelopeReg: { unregister: () => void } | null = null;

  // Forward declaration — start() needs to reference dispatch by name to
  // bind the runtime's onEnvelope handler.
  const router: SurfaceRouter = {
    register(adapter) {
      adapters.push(adapter);
      return {
        unregister: () => {
          const idx = adapters.indexOf(adapter);
          if (idx !== -1) adapters.splice(idx, 1);
        },
      };
    },

    // start/stop are sync underneath but typed Promise<void> to match the
    // SurfaceRouter interface (other implementations may do I/O here).
    // eslint-disable-next-line @typescript-eslint/require-await
    async start() {
      if (started) return;
      started = true;
      // Wire runtime → router. Each envelope from any active subscription
      // arrives at the router with its actual NATS subject (so wildcard
      // patterns route correctly).
      envelopeReg = runtime.onEnvelope((env, subject, sourceLink) => {
        // dispatch() returns a Promise; we don't await — the runtime's
        // subscriber loop must not block on adapter rendering. The router
        // already isolates adapter errors via renderWithIsolation so this
        // floating Promise resolves cleanly.
        //
        // IAW Phase F-3d (cortex#666): forward the delivering link's
        // attribution so the federation gate can cross-check the subject's
        // claimed network against the link it actually arrived on. Additive —
        // a runtime that doesn't tag (older fake stubs) passes `undefined` and
        // the gate's cross-check is skipped.
        void router.dispatch(env, subject, sourceLink);
      });
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async stop() {
      if (stopped) return;
      stopped = true;
      if (envelopeReg) {
        envelopeReg.unregister();
        envelopeReg = null;
      }
    },

    async dispatch(envelope, subject, sourceLink) {
      if (stopped) return;

      const effectiveSubject = subject ?? envelope.type;

      // IAW Phase D.2 — federation gate runs BEFORE per-adapter
      // matching. The gate decides whether the envelope is allowed
      // onto our in-process bus at all; visibility filters on
      // individual adapters are a per-renderer concern that only
      // matters once the envelope has been admitted.
      //
      // Gate engages only when the principal has declared a
      // `policy.federated.networks[]` block. Mirror of the C.3.1
      // policy-engine pattern: an unconfigured gate is a no-op (the
      // principal opted out). This keeps cortex.yaml without a
      // `federated:` block fully back-compat with pre-D.2 behaviour
      // — existing renderers continue to receive whatever traffic
      // happened to land on `federated.*` subjects via classification
      // alone, exactly as they did before this PR. Federation
      // enforcement is opt-in; absence ≠ "deny everything".
      //
      // Subjects that don't start with `federated.` always pass
      // through untouched — the gate is scoped to the federation
      // domain by design (D.2.1 explicitly: "gate inbound
      // `federated.*` envelopes"). Local/public-domain subjects are
      // governed by other gates (visibility for local, none for
      // public).
      if (
        federatedNetworksById.size > 0 &&
        effectiveSubject.startsWith("federated.")
      ) {
        const decision = evaluateFederationGate(
          effectiveSubject,
          envelope,
          federatedNetworksById,
          // IAW Phase F-3d (cortex#666) — additive anti-spoof input. When the
          // runtime tags the delivering `linkId`, the gate cross-checks the
          // subject's claimed `{network_id}` against the network the
          // attribution belongs to; `undefined` (no attribution) skips the
          // cross-check, preserving pre-F-3d behaviour.
          sourceLink,
        );
        if (decision !== "allow") {
          emitFederationDenied(
            runtime,
            systemEventSource,
            envelope,
            effectiveSubject,
            decision,
          );
          // Hard drop — denied envelopes never reach adapters. The
          // audit envelope above is the principal's only signal that
          // this dispatch was attempted; without it the deny is
          // silent.
          return;
        }
      }

      // IAW S5 (#739) — the public-scope gate. CLOSES the OQ1 gap the pre-S5
      // router left open (the comment above used to read "none for public"):
      // inbound `public.*` was previously ungated, so any public sender was
      // implicitly trusted. Now it is DENY-BY-DEFAULT — dropped unless the
      // principal opted into the public scope AND the sender's source principal
      // is on the allowlist. This is a SEPARATE branch from the federated gate
      // (above): `public.*` carries no `{principal}.{stack}` segment, so it must
      // NOT be routed through the federated peer/network resolution (a different
      // trust tier, not a federated peer — wire-protocol SOP check #5). Local
      // (`local.*`) subjects are unaffected — `evaluatePublicGate` only gates
      // `public.*` and the visibility filter governs local rendering.
      if (effectiveSubject.startsWith("public.")) {
        const decision = evaluatePublicGate(
          effectiveSubject,
          envelope,
          policyPublic,
        );
        if (decision !== "allow") {
          emitPublicDenied(
            runtime,
            systemEventSource,
            envelope,
            effectiveSubject,
            decision,
          );
          // Hard drop — a non-allowlisted public sender never reaches adapters.
          return;
        }
      }

      // Two-pass match so we can distinguish "didn't subscribe" from
      // "subscribed but visibility blocked". Visibility-drops emit a
      // `system.access.filtered` envelope; subject/payload non-matches are
      // silent (the adapter simply isn't interested).
      const matched: SurfaceAdapter[] = [];
      for (const adapter of adapters) {
        const result = adapterMatches(adapter, envelope, effectiveSubject);
        if (result.matched) {
          matched.push(adapter);
          continue;
        }
        if (result.visibilityDropReason !== undefined) {
          // IAW Phase A.4 — visibility-drop emits an observable signal. Best
          // effort: runtime.publish is fire-and-forget and may be a no-op
          // when NATS is not configured. Errors are swallowed inside the
          // runtime, so this floating Promise resolves cleanly.
          emitAccessFiltered(
            runtime,
            systemEventSource,
            adapter.id,
            effectiveSubject,
            result.visibilityDropReason,
          );
        }
      }
      if (matched.length === 0) return;

      const settled = await Promise.allSettled(
        matched.map((a) =>
          renderWithIsolation(
            a,
            envelope,
            effectiveSubject,
            renderTimeoutMs,
            onAdapterError,
          ),
        ),
      );

      // `renderWithIsolation` already swallows; the allSettled here is
      // belt-and-braces against any future change to that helper. Walk the
      // results so a future logger or metric can hang off this loop.
      for (const r of settled) {
        if (r.status === "rejected") {
          // Should not happen — renderWithIsolation never rejects. If it
          // does, log defensively rather than crash dispatch.
          console.error(
            "surface-router: internal error — renderWithIsolation rejected:",
            r.reason instanceof Error ? r.reason.message : r.reason,
          );
        }
      }
    },
  };

  return router;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Result of evaluating one adapter against one envelope.
 *
 * `matched: true` → the adapter receives the envelope.
 * `matched: false, visibilityDropReason: <reason>` → adapter's subject + payload
 *   matched, but visibility blocked. Router emits `system.access.filtered`.
 * `matched: false, visibilityDropReason: undefined` → silent non-match
 *   (subject didn't match, or payload filter blocked). No observable signal.
 *
 * The distinction matters for the cortex#97 error-surfacing pattern: a
 * non-subscriber shouldn't pollute the access-decision stream with "didn't
 * match my subject" noise, but a subscriber whose visibility config blocked
 * the envelope IS exactly the audit-relevant signal.
 */
interface AdapterMatchResult {
  matched: boolean;
  visibilityDropReason?: SystemAccessFilteredReason;
}

function adapterMatches(
  adapter: SurfaceAdapter,
  envelope: Envelope,
  subject: string,
): AdapterMatchResult {
  // Subject-pattern union: any matching pattern proceeds to the filter.
  let subjectHit = false;
  for (const pattern of adapter.subjects) {
    if (subjectMatches(pattern, subject)) {
      subjectHit = true;
      break;
    }
  }
  if (!subjectHit) return { matched: false };
  if (!matchesFilter(envelope, adapter.filter)) return { matched: false };

  // IAW Phase A.4 — visibility filter applies AFTER subject + payload.
  // Skipped entirely when the adapter has no `visibility:` block (the v1
  // default), preserving the pre-A.4 behaviour for every existing renderer.
  const dropReason = evaluateVisibility(adapter.visibility, envelope);
  if (dropReason !== undefined) {
    return { matched: false, visibilityDropReason: dropReason };
  }
  return { matched: true };
}

// =============================================================================
// IAW Phase A.4 — visibility evaluation
// =============================================================================

/**
 * Ordering of `sovereignty.classification` for the `max_classification`
 * cap rule. Mirrors myelin's reach taxonomy: `local < federated < public`.
 * An envelope's classification is "exceeds max" when its rank is strictly
 * greater than the cap's rank.
 *
 * Module-level constant (vs in-function literal) so the table is a single
 * source of truth; future schema-side changes ripple through here.
 */
const CLASSIFICATION_RANK: Record<Envelope["sovereignty"]["classification"], number> = {
  local: 0,
  federated: 1,
  public: 2,
};

/**
 * Pure evaluator: returns the first violated rule, or `undefined` when the
 * envelope passes (or when no visibility constraints are configured). Rules
 * compose with AND semantics — every set rule must pass.
 *
 * Exported so tests can probe each rule in isolation without setting up a
 * full router + adapter harness.
 *
 * IAW Phase A.4 design choice: an envelope whose sovereignty field is
 * `undefined` (impossible per schema today, but defensive in case future
 * fields become optional) is treated as unconstrained — we cannot prove a
 * violation, so we don't drop. The schema's required-field validation runs
 * BEFORE the envelope reaches the router (envelope-validator.ts), so this
 * branch is mostly a future-proofing guard.
 */
export function evaluateVisibility(
  visibility: RendererVisibility | undefined,
  envelope: Envelope,
): SystemAccessFilteredReason | undefined {
  if (!visibility) return undefined;

  // `envelope.sovereignty.*` fields are non-nullable per schema; the prior
  // `?.` + `!== undefined` guards were defensive against an older shape.
  // Rule 1: residency allowlist.
  if (visibility.hide_residency_outside !== undefined) {
    const residency = envelope.sovereignty.data_residency;
    if (!visibility.hide_residency_outside.includes(residency)) {
      return "residency_blocked";
    }
  }

  // Rule 2: model-class allowlist.
  if (visibility.require_model_class !== undefined) {
    const modelClass = envelope.sovereignty.model_class;
    if (!visibility.require_model_class.includes(modelClass)) {
      return "model_class_blocked";
    }
  }

  // Rule 3: classification cap.
  if (visibility.max_classification !== undefined) {
    const classification = envelope.sovereignty.classification;
    const capRank = CLASSIFICATION_RANK[visibility.max_classification];
    const envRank = CLASSIFICATION_RANK[classification];
    if (envRank > capRank) {
      return "classification_exceeds_max";
    }
  }

  return undefined;
}

/**
 * Emit a `system.access.filtered` envelope on the runtime. Best-effort:
 * runtime.publish swallows transport errors internally + is a no-op when
 * NATS is not configured, so a missing emit doesn't poison the dispatch
 * loop.
 *
 * When `systemEventSource` is undefined (the test-only path), the function
 * is a no-op — we cannot construct a schema-valid envelope without the
 * `source` segments. Principals wiring the router in production (cortex.ts)
 * MUST pass the source struct; tests that don't care about the side-effect
 * leave it unset.
 */
function emitAccessFiltered(
  runtime: MyelinRuntime,
  source: SystemEventSource | undefined,
  rendererId: string,
  envelopeSubject: string,
  reason: SystemAccessFilteredReason,
): void {
  if (!source) {
    // No source struct configured — log so a principal triaging silence
    // gets a hint, but don't try to construct a half-formed envelope.
    console.info(
      `surface-router: visibility drop renderer="${rendererId}" subject="${envelopeSubject}" reason=${reason} ` +
        `(no systemEventSource configured — system.access.filtered envelope NOT emitted)`,
    );
    return;
  }
  try {
    const env = createSystemAccessFilteredEvent({
      source,
      rendererId,
      envelopeSubject,
      reason,
    });
    // Fire-and-forget: runtime.publish is async but its contract is that it
    // never throws (errors are logged + swallowed internally). The floating
    // Promise resolves cleanly when the next event-loop tick runs.
    //
    // cortex#137 — defensive .catch() so a regression of the
    // "never throws" contract (refactor, new pluggable transport,
    // unhandled async path) surfaces a principal-visible signal
    // instead of silently dropping the audit envelope. Goes to
    // stderr directly rather than another bus publish so a broken
    // runtime can't swallow the alert about itself.
    runtime.publish(env).catch((publishErr: unknown) => {
      process.stderr.write(
        `[surface-router] failed to emit system.access.filtered audit envelope: ${publishErr instanceof Error ? publishErr.message : String(publishErr)}\n`,
      );
    });
  } catch (err) {
    // Defensive: createSystemAccessFilteredEvent shouldn't throw on
    // schema-valid inputs, but a future change could surface a synchronous
    // failure here. Swallow + log so a buggy emit-helper doesn't poison the
    // dispatch loop.
    console.error(
      `surface-router: failed to emit system.access.filtered for renderer="${rendererId}":`,
      err instanceof Error ? err.message : err,
    );
  }
}

// =============================================================================
// IAW Phase D.2 — federation accept/deny gate
// =============================================================================

/**
 * The router-internal verdict from the federation gate. Shaped as a
 * discriminated union so `dispatch()` can branch once and pass the
 * verdict straight into the `system.access.denied` emit helper without
 * re-deriving the variant fields.
 *
 * `"allow"` short-circuits all later work — the envelope flows through
 * to adapter matching exactly as it did pre-D.2.
 *
 * Every deny branch carries the network id we resolved (or, in the
 * `unknown_network` case, the SOURCE PRINCIPAL we failed to resolve to any
 * configured peer) so the audit envelope can surface why the envelope was
 * rejected without `dispatch()` re-parsing the subject.
 *
 * cortex#686 (ADR 0001) — the `networkId` field now carries the SOURCE
 * network id resolved from the source principal's membership in a configured
 * network's `peers[]`, NOT a subject segment. On the `unknown_network` branch
 * it carries the unresolved source principal as a searchable sentinel.
 */
export type FederationGateDecision =
  | "allow"
  | {
      kind: "peer_not_in_accept_list";
      networkId: string;
      unknown_network?: boolean;
    }
  | {
      kind: "peer_deny_list";
      networkId: string;
      matched_pattern: string;
    }
  | {
      kind: "max_hop_exceeded";
      networkId: string;
      observed_hops: number;
      max_hop: number;
    }
  | {
      /**
       * IAW Phase F-3d (cortex#666) — anti-spoof: the envelope's subject
       * claimed network `networkId`, but it was DELIVERED on a link whose
       * `leaf_node` does not own that network (`sourceLink`). A subject
       * claiming `federated.{X}.…` that arrived on a link not owning X is a
       * cross-network spoof (design §3.3 / §5 isolation layer 2). Only
       * possible when a `sourceLink` attribution is supplied — the
       * cross-check is skipped otherwise (back-compat).
       */
      kind: "source_link_mismatch";
      networkId: string;
      sourceLink: string;
      expectedLeafNode: string;
    };

/**
 * cortex#686 (ADR 0001) — resolve the SOURCE network from the SOURCE PRINCIPAL.
 *
 * Find the configured network whose `peers[]` lists `sourcePrincipal` as a
 * `principal_id`. Returns the network + its id, or `undefined` when the source
 * principal is in no configured network's peer list (an unknown/untrusted peer).
 *
 * ADR 0001 mandates that the network is resolved from deployment topology
 * (`policy.federated.networks[].peers[]`), NOT read off the wire. A peer
 * principal is, by config invariant, declared in at most the networks the local
 * stack joins; first match wins (a principal appearing in multiple networks'
 * `peers[]` is an unusual topology — the first declared network governs its
 * accept/deny rules, matching the publish-side `principalIdToLinkId` first-wins
 * resolution in `runtime.ts`).
 *
 * Pure helper — exported for tests.
 */
export function resolveSourceNetwork(
  sourcePrincipal: string,
  networksById: Map<string, PolicyFederatedNetwork>,
): { networkId: string; network: PolicyFederatedNetwork } | undefined {
  for (const [networkId, network] of networksById) {
    for (const peer of network.peers) {
      if (peer.principal_id === sourcePrincipal) {
        return { networkId, network };
      }
    }
  }
  return undefined;
}

/**
 * cortex#686 (ADR 0001, supersedes cortex#661) — federation accept/deny gate on
 * the conformant `{principal}.{stack}` grammar.
 *
 * The network is NO LONGER read off the wire. An inbound federated subject is
 * `federated.{target-principal}.{stack}.…` where segment[1] is the RECEIVING
 * principal (this stack), not a network id. The SOURCE network is resolved from
 * the SOURCE PRINCIPAL (`principalFromEnvelope` — the leading segment of
 * `envelope.source`) via its membership in a configured network's `peers[]`
 * (`resolveSourceNetwork`). This is the L1/L7 separation ADR 0001 mandates:
 * identity is on the wire (the source signs as its principal), topology
 * (which network that principal reaches us on) is in config.
 *
 * Pure function — exported so tests can probe each branch in isolation without
 * spinning up a runtime + router.
 *
 * Decision order (matches D.2 spec semantics, re-derived on the ADR-0001 grammar):
 *
 *   1. The source principal must resolve to a configured network via its
 *      `peers[]` membership. An unresolved source principal (in no configured
 *      network's peer list) is rejected as `peer_not_in_accept_list` with
 *      `unknown_network: true`, carrying the unresolved source principal as the
 *      searchable `networkId` sentinel.
 *   2. `deny_subjects[]` is checked BEFORE `accept_subjects[]` — principal
 *      intent on the deny list overrides any accept hit (D.2: "A match here
 *      overrides accept_subjects[]").
 *   3. `accept_subjects[]` must contain a matching pattern. Empty accept list
 *      means "accept nothing" (D.1 schema doc); the envelope is rejected even
 *      when no deny pattern matched.
 *   4. Hop budget last — "you're allowed but you've travelled too far", run
 *      after the accept-list so the deny-reason precedence stays intuitive.
 *
 * The F-3d anti-spoof `sourceLink` cross-check now asserts the RESOLVED source
 * network's `leaf_node` equals the delivering link — a subject that arrived on a
 * leaf not owning the resolved network is a cross-network spoof.
 */
export function evaluateFederationGate(
  subject: string,
  envelope: Envelope,
  networksById: Map<string, PolicyFederatedNetwork>,
  sourceLink?: string,
): FederationGateDecision {
  // Subject MUST start with `federated.` — caller guards this, but
  // the function is exported for tests and we'd rather fail-closed
  // than trust the precondition.
  if (!subject.startsWith("federated.")) {
    // Outside our domain — treat as "no policy applies, no deny" so
    // standalone tests of this function don't accidentally deny
    // local.* subjects. Caller should not reach this branch in
    // production (dispatch() already filters on the prefix).
    return "allow";
  }

  const parts = subject.split(".");
  // `federated.{target-principal}.{stack}.<...>` requires at least 3 segments.
  // A bare `federated` / `federated.` is malformed dispatch traffic — fail
  // closed with the `<malformed>` sentinel so principals filtering the access
  // stream by `payload.network_id` get a searchable token, not an empty cell.
  if (parts.length < 3 || parts[1] === undefined || parts[1].length === 0) {
    return {
      kind: "peer_not_in_accept_list",
      networkId: "<malformed>",
      unknown_network: true,
    };
  }

  // ADR 0001 — resolve the SOURCE network from the SOURCE PRINCIPAL (the leading
  // segment of `envelope.source`), NOT from subject segment[1] (which is the
  // RECEIVING principal under the conformant grammar). A source principal that
  // matches no configured network's `peers[]` is an unknown/untrusted peer.
  const sourcePrincipal = principalFromEnvelope(envelope);
  const resolved = resolveSourceNetwork(sourcePrincipal, networksById);
  if (resolved === undefined) {
    return {
      kind: "peer_not_in_accept_list",
      // Carry the unresolved source principal as the searchable sentinel —
      // the audit stream's `network_id` now reads "peer principal X is in no
      // configured network's peers[]" rather than a stale subject segment.
      networkId: sourcePrincipal,
      unknown_network: true,
    };
  }
  const { networkId, network } = resolved;

  // IAW Phase F-3d (cortex#666), reworked for ADR 0001 (cortex#686) — anti-spoof
  // cross-check (design §3.3 / §5 isolation layer 2). When the runtime supplied a
  // LEAF delivering-link attribution, the RESOLVED source network (from the source
  // principal's `peers[]` membership) MUST be served by that exact leaf: the
  // network's `leaf_node` has to equal `sourceLink`. A source principal whose
  // resolved network rides a different leaf than the one it arrived on is a
  // cross-network spoof, denied BEFORE deny/accept/hop checks — the delivering
  // link is more authoritative than any subject-pattern or topology rule.
  //
  // SKIPPED in two cases (both back-compat-preserving):
  //   1. `sourceLink === undefined` — no attribution (pre-F-3d callers,
  //      primary-only deployments routed without tagging). Behaviour
  //      unchanged unless the runtime opts in.
  //   2. `sourceLink === "primary"` — the envelope arrived on the primary
  //      link, which carries `local.*`/`public.*` PLUS every federated
  //      network WITHOUT a `nats:` block (those ride primary by design).
  //      A network riding primary keeps its declared `leaf_node` name, so a
  //      `leaf_node !== "primary"` equality would wrongly flag legitimate
  //      primary-routed federated traffic. The runtime's `passesSourceLinkCheck`
  //      makes the symmetric exclusion (primary delivery is never spoof-checked);
  //      this gate mirrors it. Primary-routed federated subjects remain
  //      governed by the accept/deny/hop checks below, exactly as pre-F-3d.
  if (
    sourceLink !== undefined &&
    sourceLink !== "primary" &&
    network.leaf_node !== sourceLink
  ) {
    return {
      kind: "source_link_mismatch",
      networkId,
      sourceLink,
      expectedLeafNode: network.leaf_node,
    };
  }

  // Deny-list precedence (D.2 spec): a match here ends evaluation
  // even if an accept pattern would also fire.
  for (const pattern of network.deny_subjects) {
    if (subjectMatches(pattern, subject)) {
      return {
        kind: "peer_deny_list",
        networkId,
        matched_pattern: pattern,
      };
    }
  }

  // Accept-list — at least one pattern must match. Empty list means
  // "accept nothing" by the D.1 schema doc; the loop naturally falls
  // through to the deny.
  let acceptHit = false;
  for (const pattern of network.accept_subjects) {
    if (subjectMatches(pattern, subject)) {
      acceptHit = true;
      break;
    }
  }
  if (!acceptHit) {
    return {
      kind: "peer_not_in_accept_list",
      networkId,
    };
  }

  // Hop budget. `signed_by[].length` is the chain length per
  // myelin#31; getSignedByChain normalises the optional single-stamp
  // legacy shape. `max_hop = 0` means "no hops allowed" — accept only
  // directly-attributed envelopes (chain length ≤ 0 ⇒ unsigned only,
  // matching the schema doc's "accept only directly-signed envelopes,
  // no relay").
  //
  // Comparison is `length > max_hop` (strict) so an exact-budget
  // envelope passes — the budget is the cap, not the limit-minus-one.
  const observedHops = getSignedByChain(envelope).length;
  if (observedHops > network.max_hop) {
    return {
      kind: "max_hop_exceeded",
      networkId,
      observed_hops: observedHops,
      max_hop: network.max_hop,
    };
  }

  return "allow";
}

// ===========================================================================
// S5 (#739) — public-scope allowlist gate (OQ1 safe default)
// ===========================================================================

/**
 * The decision the public gate returns. `"allow"` admits the envelope; any
 * object is a deny carrying a searchable reason for the audit stream.
 *
 *   - `public_not_enabled` — the stack has not opted into the public scope
 *     (`policy.public` absent or `enabled: false`). Inbound `public.*` is
 *     dropped. Opting in to ANNOUNCE capabilities to the registry does NOT
 *     enable inbound public trust — that is a separate control-plane action.
 *   - `public_sender_not_allowlisted` — the stack IS opted in, but the
 *     envelope's SOURCE principal is not in `allow_principals[]` (this
 *     includes the empty-allowlist case: "trust nobody on public"). This is
 *     the OQ1 safe gate: a non-allowlisted public sender is NEVER auto-trusted;
 *     open anonymous claim is deferred to the security ramp.
 */
export type PublicGateDecision =
  | "allow"
  | { kind: "public_not_enabled" }
  | { kind: "public_sender_not_allowlisted"; sourcePrincipal: string };

/**
 * IAW S5 (#739) — gate an inbound `public.*` envelope against the principal's
 * `policy.public` opt-in + allowlist. The OQ1 SAFE DEFAULT in code:
 *
 *   policy.public absent / enabled:false  → DENY (public_not_enabled)
 *   enabled:true, allow_principals = []    → DENY (public_sender_not_allowlisted)
 *   enabled:true, sender ∉ allow_principals → DENY (public_sender_not_allowlisted)
 *   enabled:true, sender ∈ allow_principals → ALLOW
 *
 * ## Trust tier — NOT a federated peer (wire-protocol SOP check #5)
 *
 * `public.*` carries NO `{principal}.{stack}` segment on the subject (scope
 * grammar: `public.{domain}.{entity}.{action}`, CONTEXT.md §Scope). So this
 * gate is DISJOINT from {@link evaluateFederationGate}: it never resolves a
 * source NETWORK from `peers[]`, never runs the leaf anti-spoof cross-check,
 * and never reads a target principal off the subject. It keys ONLY on the
 * SOURCE principal (the signing identity — leading segment of
 * `envelope.source`, via {@link principalFromEnvelope}) against the public
 * allowlist. Public is a different trust tier, not a federated peer; mixing
 * the two would mis-apply the federated peer checks to the no-principal-segment
 * scope (the precise failure the S5 brief calls out).
 *
 * Pure function — exported so tests can probe each branch without a runtime.
 * Defensive: a NON-`public.` subject returns `"allow"` (the caller only ever
 * routes `public.*` here; a leaked federated/local subject must not be denied
 * by THIS gate — its own gate governs it).
 */
export function evaluatePublicGate(
  subject: string,
  envelope: Envelope,
  policyPublic: PolicyPublic | undefined,
): PublicGateDecision {
  // Out of the public domain — not ours to gate. The caller guards on the
  // prefix; this fail-open (for THIS gate) keeps standalone tests of
  // local/federated subjects from being denied here.
  if (!subject.startsWith("public.")) {
    return "allow";
  }

  // Not opted in → drop. Absence and `enabled: false` are identical: the stack
  // is not accepting inbound public traffic. (Announcing capabilities to the
  // registry is a control-plane action that does not flip this.)
  if (!policyPublic?.enabled) {
    return { kind: "public_not_enabled" };
  }

  // Opted in — admit ONLY allowlisted source principals. An empty allowlist
  // means "trust nobody on public" (deny-by-default), NOT "trust everybody".
  const sourcePrincipal = principalFromEnvelope(envelope);
  if (!policyPublic.allow_principals.includes(sourcePrincipal)) {
    return { kind: "public_sender_not_allowlisted", sourcePrincipal };
  }
  return "allow";
}

/**
 * Emit a `system.access.denied` envelope describing a federation-gate
 * rejection. Mirrors `emitAccessFiltered` — best-effort, runtime
 * errors swallowed internally, no-op when `systemEventSource` is
 * undefined (the test-only path).
 */
/**
 * cortex#484 — exported so the runner dispatch-listener can reuse the
 * same audit-emit path when it gates federated.* subscriptions
 * inline (Option D — runner subscribes directly via the runtime
 * rather than as a SurfaceAdapter, so the surface-router's
 * federation gate no longer covers the runner's subscription path).
 * Same contract as the in-router caller: best-effort publish,
 * stderr-log on failure, no-op when `source` is undefined.
 */
export function emitFederationDenied(
  runtime: MyelinRuntime,
  source: SystemEventSource | undefined,
  envelope: Envelope,
  envelopeSubject: string,
  decision: Exclude<FederationGateDecision, "allow">,
): void {
  if (!source) {
    // Test-only path: log + return without emitting a half-formed
    // envelope. Same contract as `emitAccessFiltered` — principals
    // wiring the router in production must pass `systemEventSource`.
    console.info(
      `surface-router: federation deny subject="${envelopeSubject}" network="${decision.networkId}" reason=${decision.kind} ` +
        `(no systemEventSource configured — system.access.denied envelope NOT emitted)`,
    );
    return;
  }

  // Carry `signed_by[]` verbatim per the C.4.3 contract — denied
  // envelopes stay cryptographically attributable.
  const signedBy: SystemAccessSignedBy[] = getSignedByChain(envelope).map(
    (stamp) => ({ ...stamp }),
  );
  const sovereignty: SystemAccessSovereignty = {
    classification: envelope.sovereignty.classification,
    data_residency: envelope.sovereignty.data_residency,
    max_hop: envelope.sovereignty.max_hop,
    frontier_ok: envelope.sovereignty.frontier_ok,
    model_class: envelope.sovereignty.model_class,
  };

  let reason: SystemAccessFederationDeniedOpts["reason"];
  switch (decision.kind) {
    case "peer_not_in_accept_list":
      reason = {
        kind: "peer_not_in_accept_list",
        ...(decision.unknown_network === true && { unknown_network: true }),
      };
      break;
    case "peer_deny_list":
      reason = {
        kind: "peer_deny_list",
        matched_pattern: decision.matched_pattern,
      };
      break;
    case "max_hop_exceeded":
      reason = {
        kind: "max_hop_exceeded",
        observed_hops: decision.observed_hops,
        max_hop: decision.max_hop,
      };
      break;
    case "source_link_mismatch":
      // IAW Phase F-3d (cortex#666) — anti-spoof denial.
      reason = {
        kind: "source_link_mismatch",
        source_link: decision.sourceLink,
        expected_leaf_node: decision.expectedLeafNode,
      };
      break;
  }

  try {
    const env = createSystemAccessFederationDeniedEvent({
      source,
      signedBy,
      sovereignty,
      envelopeId: envelope.id,
      envelopeSubject,
      // Fall back to envelopeId for joinability when the peer
      // envelope lacked a correlation_id. Audit consumers always
      // get a non-empty join key.
      correlationId: envelope.correlation_id ?? envelope.id,
      networkId: decision.networkId,
      reason,
    });
    // cortex#137 — defensive .catch() so a regression of the
    // runtime.publish "never throws" contract surfaces an
    // principal-visible signal instead of dropping the federation
    // audit envelope silently. Same pattern as
    // `emitAccessFiltered` above. Direct stderr — a broken
    // runtime can't swallow alerts about itself.
    runtime.publish(env).catch((publishErr: unknown) => {
      process.stderr.write(
        `[surface-router] failed to emit system.access.federation_denied audit envelope: ${publishErr instanceof Error ? publishErr.message : String(publishErr)}\n`,
      );
    });
  } catch (err) {
    // Defensive — buildBaseEnvelope shouldn't throw on schema-valid
    // inputs, but if a future refactor makes it synchronous-throwing
    // we don't want it to poison dispatch().
    console.error(
      `surface-router: failed to emit federation system.access.denied for subject="${envelopeSubject}":`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * IAW S5 (#739) — observe a public-gate denial. The SECURITY property (a
 * non-allowlisted public sender never reaches an adapter) is enforced by the
 * hard-drop in `dispatch`; this is the OBSERVABILITY of that drop.
 *
 * Bounded by design: it logs the denial rather than emitting a fully-typed
 * `system.access.denied` envelope. The existing
 * `createSystemAccessFederationDeniedEvent` reason union is FEDERATION-specific
 * (`peer_not_in_accept_list` / `source_link_mismatch` / `max_hop_exceeded`),
 * and reusing it for a public deny would mislabel a public-tier drop as a
 * federated-peer rejection — exactly the trust-tier confusion the S5 brief
 * warns against. A dedicated `public_denied` audit-event variant is a
 * follow-up (tracked against the OQ1 security-ramp work); S5 keeps the gate's
 * observability to a structured log line and leaves the typed audit envelope
 * to the phase that also decides open-claim/enforce.
 *
 * No-op-safe: `source` is accepted for signature-symmetry with
 * {@link emitFederationDenied} (so a future typed-envelope upgrade is a
 * drop-in) but is not required to log.
 */
export function emitPublicDenied(
  _runtime: MyelinRuntime,
  _source: SystemEventSource | undefined,
  _envelope: Envelope,
  envelopeSubject: string,
  decision: Exclude<PublicGateDecision, "allow">,
): void {
  const detail =
    decision.kind === "public_sender_not_allowlisted"
      ? `source="${decision.sourcePrincipal}" not in policy.public.allow_principals`
      : "policy.public absent or enabled:false (not opted into the public scope)";
  console.info(
    `surface-router: public deny subject="${envelopeSubject}" reason=${decision.kind} — ${detail} ` +
      `(OQ1 safe default — dropped, not auto-trusted)`,
  );
}

/**
 * Run `adapter.render(envelope, signal)` under a timeout. Errors and
 * timeouts route to `onAdapterError`. **Never throws.** The contract is
 * critical for the §5.3 isolation rule — a slow or buggy adapter MUST NOT
 * block sibling adapters' renders.
 *
 * On timeout, two things happen in tandem:
 *
 *   1. `Promise.race` resolves the timeout branch, freeing the dispatch loop
 *      so sibling adapters keep getting their turn (the §5.3 isolation rule).
 *   2. The `AbortController` aborts the signal we passed into `render()`,
 *      so the loser of the race can stop its in-flight I/O instead of
 *      running to completion in the background. Without this, a hanging
 *      HTTP call or NATS request would leak past the timeout, holding
 *      sockets and spending quota long after the dispatch resolved.
 *
 * Adapters that don't accept the signal still get the race-cancellation
 * behaviour; they just don't get to wind down their own work.
 */
async function renderWithIsolation(
  adapter: SurfaceAdapter,
  envelope: Envelope,
  subject: string,
  timeoutMs: number,
  onAdapterError: SurfaceRouterOptions["onAdapterError"],
): Promise<void> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`render timeout after ${timeoutMs}ms`);
        ac.abort(err);
        reject(err);
      }, timeoutMs);
    });

    // Defensively wrap the render call in case it throws synchronously
    // before returning a promise. The third positional argument is the
    // IAW Phase D.3 (cortex#116) `subject` channel — adapters that
    // don't declare it on their render signature ignore the value
    // (positional-args extension is backward-compatible).
    const renderPromise = (async () =>
      adapter.render(envelope, ac.signal, subject))();

    await Promise.race([renderPromise, timeoutPromise]);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    safeReportError(adapter.id, error, onAdapterError);
  } finally {
    // TS narrows `timer` to `null` here because the only assignment is
    // inside the Promise constructor callback (TS doesn't track that the
    // executor runs synchronously). The clearTimeout is load-bearing —
    // without it the timeout fires post-success and the AbortController
    // aborts an already-resolved signal.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (timer !== null) clearTimeout(timer);
  }
}

function safeReportError(
  adapterId: string,
  err: Error,
  hook: SurfaceRouterOptions["onAdapterError"],
): void {
  if (!hook) {
    // Default sink: log so a missing observer doesn't make adapter
    // failures invisible.
    console.error(
      `surface-router: adapter "${adapterId}" render failed:`,
      err.message,
    );
    return;
  }
  try {
    hook(adapterId, err);
  } catch (hookErr) {
    // A throwing observer must not poison the dispatch loop.
    console.error(
      `surface-router: onAdapterError hook threw for "${adapterId}":`,
      hookErr instanceof Error ? hookErr.message : hookErr,
    );
  }
}
