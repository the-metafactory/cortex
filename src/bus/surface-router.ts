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
  /** Adapter-specific rendering. Bounded by router's renderTimeoutMs. */
  render(envelope: Envelope): Promise<void>;
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
 * `MyelinRuntime`. The runtime parameter is currently retained for the
 * future wiring hook (see file header) — the router does not call into
 * the runtime today; the runtime will call into the router via
 * `dispatch()` once an `onEnvelope` registration surface lands.
 */
export function createSurfaceRouter(
  // Reserved for the future runtime → router wiring (see file header).
  // Today the parameter is part of the contract but the router does not
  // call into the runtime; the runtime will call `dispatch()` on this
  // router once an `onEnvelope` registration surface is added there.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _runtime: MyelinRuntime,
  opts?: SurfaceRouterOptions,
): SurfaceRouter {
  const adapters: SurfaceAdapter[] = [];
  const renderTimeoutMs = opts?.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const onAdapterError = opts?.onAdapterError;

  let started = false;
  let stopped = false;

  return {
    register(adapter) {
      adapters.push(adapter);
      return {
        unregister: () => {
          const idx = adapters.indexOf(adapter);
          if (idx !== -1) adapters.splice(idx, 1);
        },
      };
    },

    async start() {
      if (started) return;
      started = true;
    },

    async stop() {
      if (stopped) return;
      stopped = true;
    },

    async dispatch(envelope, subject) {
      if (stopped) return;

      const effectiveSubject = subject ?? envelope.type;
      const matched = adapters.filter((a) => adapterMatches(a, envelope, effectiveSubject));
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
            "grove-bot: surface-router internal error — renderWithIsolation rejected:",
            r.reason instanceof Error ? r.reason.message : r.reason,
          );
        }
      }
    },
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

function adapterMatches(adapter: SurfaceAdapter, envelope: Envelope, subject: string): boolean {
  // Subject-pattern union: any matching pattern proceeds to the filter.
  let subjectHit = false;
  for (const pattern of adapter.subjects) {
    if (subjectMatches(pattern, subject)) {
      subjectHit = true;
      break;
    }
  }
  if (!subjectHit) return false;
  return matchesFilter(envelope, adapter.filter);
}

/**
 * Run `adapter.render(envelope)` under a timeout. Errors and timeouts
 * route to `onAdapterError`. **Never throws.** The contract is critical
 * for the §5.3 isolation rule — a slow or buggy adapter MUST NOT block
 * sibling adapters' renders.
 */
async function renderWithIsolation(
  adapter: SurfaceAdapter,
  envelope: Envelope,
  timeoutMs: number,
  onAdapterError: SurfaceRouterOptions["onAdapterError"],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`render timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    // Defensively wrap the render call in case it throws synchronously
    // before returning a promise.
    const renderPromise = (async () => adapter.render(envelope))();

    await Promise.race([renderPromise, timeoutPromise]);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    safeReportError(adapter.id, error, onAdapterError);
  } finally {
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
      `grove-bot: surface-router adapter "${adapterId}" render failed:`,
      err.message,
    );
    return;
  }
  try {
    hook(adapterId, err);
  } catch (hookErr) {
    // A throwing observer must not poison the dispatch loop.
    console.error(
      `grove-bot: surface-router onAdapterError hook threw for "${adapterId}":`,
      hookErr instanceof Error ? hookErr.message : hookErr,
    );
  }
}
