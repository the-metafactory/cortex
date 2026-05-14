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

import type { RendererVisibility } from "../common/types/cortex-config";
import {
  createSystemAccessFilteredEvent,
  type SystemAccessFilteredReason,
  type SystemEventSource,
} from "./system-events";
import type { Envelope } from "./myelin/envelope-validator";
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
   * `render()`. Drops emit a `system.access.filtered` envelope so operators
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
   */
  render(envelope: Envelope, signal?: AbortSignal): Promise<void>;
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
   * correct operator/agent/instance segments.
   */
  systemEventSource?: SystemEventSource;
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
  // for cortex's use case (callbacks supplied by the operator config),
  // unbound is the intended shape.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const onAdapterError = opts?.onAdapterError;
  const systemEventSource = opts?.systemEventSource;

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
        matched.map((a) => renderWithIsolation(a, envelope, renderTimeoutMs, onAdapterError)),
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
 * `source` segments. Operators wiring the router in production (cortex.ts)
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
    // No source struct configured — log so an operator triaging silence
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
    void runtime.publish(env);
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
    // before returning a promise.
    const renderPromise = (async () => adapter.render(envelope, ac.signal))();

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
