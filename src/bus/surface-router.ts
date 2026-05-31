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
   *  NATS subject so wildcard patterns match correctly. */
  dispatch(envelope: Envelope, subject?: string): Promise<void>;
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
      envelopeReg = runtime.onEnvelope((env, subject) => {
        // dispatch() returns a Promise; we don't await — the runtime's
        // subscriber loop must not block on adapter rendering. The router
        // already isolates adapter errors via renderWithIsolation so this
        // floating Promise resolves cleanly.
        void router.dispatch(env, subject);
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

    async dispatch(envelope, subject) {
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
 * Every deny branch carries the network id we resolved (or attempted
 * to resolve, in the `unknown_network` case) so the audit envelope can
 * surface "peer claimed network 'x'" without `dispatch()` re-parsing
 * the subject.
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
    };

/**
 * Parse `federated.{network_id}.<...>` and check the subject against
 * the resolved network's policy. Pure function — exported so tests can
 * probe each branch in isolation without spinning up a runtime + router.
 *
 * Decision order (matches D.2 spec semantics):
 *
 *   1. Subject must declare a network id (`federated.<id>.<...>`).
 *      Bare `federated` or `federated.` is rejected as
 *      `peer_not_in_accept_list` with `unknown_network: true`.
 *   2. The network id must be in `policy.federated.networks[]`.
 *      Missing → same deny kind with `unknown_network: true`.
 *   3. `deny_subjects[]` is checked BEFORE `accept_subjects[]` —
 *      principal intent on the deny list overrides any accept hit.
 *      D.2 spec: "A match here overrides accept_subjects[]".
 *   4. `accept_subjects[]` must contain a matching pattern. Empty
 *      accept list means "accept nothing" (D.1 schema doc); the
 *      envelope is rejected even when no deny pattern matched.
 *   5. Hop budget last — by spec it's the cheapest check but
 *      conceptually it's "you're allowed but you've travelled too
 *      far", so running it after the accept-list keeps the deny
 *      reason precedence intuitive (accept-misses report first).
 */
export function evaluateFederationGate(
  subject: string,
  envelope: Envelope,
  networksById: Map<string, PolicyFederatedNetwork>,
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
  // `federated.{id}.<...>` requires at least 3 segments — `federated`,
  // `{id}`, and one or more rest segments. A 2-segment `federated.x`
  // is technically a network announcement subject but D.2 only gates
  // dispatch traffic, which always has trailing segments. We deny
  // the malformed shape to fail closed.
  //
  // Echo cortex#226 round 1: report a sentinel `"<malformed>"` rather
  // than the literal empty string for the network id — principals
  // filtering the access stream by `payload.network_id` get a
  // searchable token instead of an empty cell. `unknown_network: true`
  // still flags this branch separately from "id present but not
  // declared" so the dashboard can render the more specific message.
  if (parts.length < 3 || parts[1] === undefined || parts[1].length === 0) {
    return {
      kind: "peer_not_in_accept_list",
      networkId: "<malformed>",
      unknown_network: true,
    };
  }

  const networkId = parts[1];
  const network = networksById.get(networkId);
  if (!network) {
    return {
      kind: "peer_not_in_accept_list",
      networkId,
      unknown_network: true,
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
