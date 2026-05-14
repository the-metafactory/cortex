/**
 * IAW Phase A.1 (cortex#113) — `ClaudeCodeHarness`.
 *
 * The first concrete `SessionHarness` implementation. Wraps the existing
 * `CCSession` primitive (`src/runner/cc-session.ts`) behind the substrate
 * harness protocol defined in `src/common/substrates/types.ts`.
 *
 * **Why a wrapper, not a refactor of cc-session.ts?**
 *   Per cortex#113 A.1 scope and the §"What NOT to touch in this PR" rules,
 *   `cc-session.ts` stays intact. The dispatch-listener (at
 *   `src/runner/dispatch-listener.ts`) STILL calls `cc-session` directly
 *   today. This harness exists in PARALLEL — Phase A.1b flips the listener
 *   over to call `ClaudeCodeHarness.dispatch()` instead, and from that
 *   moment on the listener stops knowing about CCSession directly.
 *
 *   Two-step migration: ship the abstraction first, swap the call sites
 *   second. Keeps each PR small enough to review and revert independently.
 *
 * **Translation contract.**
 *   Input: a `DispatchRequest` from the protocol layer.
 *   Output: an async iterable of `MyelinEnvelope`s carrying the dispatch
 *   lifecycle:
 *
 *     1. `dispatch.task.started`   — yielded immediately at spawn time.
 *     2. (optional) progress envelopes — A.1 does NOT yield interim
 *        progress envelopes (no schema for them yet — that's part of
 *        cortex#109 §B and Phase A.3 emit-site parameterisation).
 *        cc-session's `text` / `tool-use` events are observed internally
 *        by the harness for inactivity-timer reset purposes only.
 *     3. Exactly ONE terminal envelope:
 *          - `dispatch.task.completed` on `success === true`
 *          - `dispatch.task.aborted`   on `aborted === true` OR
 *                                     `exitCode === 143` (SIGTERM)
 *          - `dispatch.task.failed`    on every other outcome (incl.
 *                                     constructor-throws from cc-session)
 *
 *   The terminal envelope is the LAST yield; the iterator closes
 *   immediately afterwards. This matches the protocol contract in
 *   `SessionHarness.dispatch()` doc.
 *
 * **What is COPIED vs IMPORTED from cc-session.ts:**
 *   - We IMPORT `CCSession`, `CCSessionOpts`, `CCSessionResult` directly —
 *     no copy. The harness is a new caller of the existing primitive.
 *   - We IMPORT the four lifecycle envelope constructors from
 *     `bus/dispatch-events.ts` — `createDispatchTaskStarted/Completed/
 *     Failed/AbortedEvent`. These are the same constructors
 *     `dispatch-listener.ts` uses; cortex emits ONE envelope shape per
 *     lifecycle event regardless of which caller produced it.
 *
 * **Q-lock-in alignment (design doc §5):**
 *   - Q1-α: `req.tools.allow[]` strings pass through as CC's `allowedTools`
 *     with no translation. The harness IS the substrate-native layer.
 *   - Q5: `req.requestId` is *carried* but A.1 does NOT publish on
 *     `dispatch.<harnessId>.<requestId>.>` subjects. The runner picks the
 *     subject when it publishes the yielded envelopes (A.1b/B work).
 *   - Q6: `req.timeoutMs` becomes CCSession's `timeoutMs` (its existing
 *     inactivity timer). `req.inactivityMs` is reserved for the post-A.1
 *     wall-clock + inactivity split — currently CCSession only implements
 *     the inactivity cap. We thread BOTH fields so the harness call site
 *     doesn't break when the cc-session timer model is split in A.1b.
 *
 * **Anti-scope:**
 *   - NOT publishing — the harness yields envelopes; callers publish.
 *   - NOT validating envelopes — the constructors used here all produce
 *     schema-conformant shapes by construction. The validator is a
 *     belt-and-braces check at publish time, not at construction.
 *   - NOT modifying CCSession — every interaction is via its public
 *     `start()` / `wait()` / `kill()` API.
 *   - NOT registering with a `HarnessRegistry` — no such registry exists
 *     in A.1. Wiring is dispatch-listener flip (A.1b) work.
 */

import { randomUUID } from "crypto";

import { CCSession, type CCSessionOpts, type CCSessionResult } from "../../runner/cc-session";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type {
  Capability,
  DispatchRequest,
  MyelinEnvelope,
  SessionHarness,
} from "../../common/substrates/types";
import {
  createDispatchTaskAbortedEvent,
  createDispatchTaskCompletedEvent,
  createDispatchTaskFailedEvent,
  createDispatchTaskStartedEvent,
  type DispatchEventSource,
} from "../../bus/dispatch-events";

// ---------------------------------------------------------------------------
// Session factory — same shape as dispatch-listener uses
// ---------------------------------------------------------------------------

/**
 * Mirror of `CCSessionLike` in `runner/dispatch-listener.ts` — kept here
 * to avoid a circular dependency between the new substrates module and the
 * legacy runner module. Once A.1b flips the listener over, the two shapes
 * merge into this one.
 */
export interface CCSessionLike {
  start(): CCSessionLike;
  wait(): Promise<CCSessionResult>;
  kill?(): void;
}

export type CCSessionFactory = (opts: CCSessionOpts) => CCSessionLike;

/** Default factory — produces a real CCSession that spawns `claude`. */
const defaultCCSessionFactory: CCSessionFactory = (opts) => new CCSession(opts);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Constructor options for `ClaudeCodeHarness`.
 *
 * Every field is either operator-derived (the `source` triple, used as
 * envelope `source` for lifecycle events) or test-injection (the
 * factory). No CC-binary path here — `CCSession` already resolves
 * `claude` from `$PATH`; injecting a path is out-of-scope for A.1.
 */
export interface ClaudeCodeHarnessOpts {
  /**
   * Envelope source triple — `{org, agent, instance}` — stamped onto
   * every lifecycle envelope this harness produces. Sourced from
   * cortex.yaml's `operator.id` + the agent id + `local` (or whatever
   * the runner uses as instance label).
   *
   * Per dispatch-events.ts: `agent` here is the *cortex* agent name,
   * not the dispatched-to agent. Confusing naming inherited from the
   * envelope spec — see `DispatchEventSource` for the precise contract.
   */
  source: DispatchEventSource;
  /**
   * Optional test injection. Default constructs a real `CCSession` that
   * spawns `claude`. Tests pass a fake that yields a deterministic
   * `CCSessionResult` from `wait()`.
   */
  ccSessionFactory?: CCSessionFactory;
  /**
   * Optional declared capabilities. Surfaces in `harness.capabilities`
   * for the future capability registry (A.6 work). Defaults to an empty
   * array — the harness declares nothing on its own and lets the agent
   * config carry per-agent capability annotations instead.
   */
  capabilities?: Capability[];
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Claude Code substrate harness — in-process child via `claude --print
 * --output-format stream-json`. See file header for the full contract.
 */
export class ClaudeCodeHarness implements SessionHarness {
  // Echo cortex#125 nit: `as const` tightens the inferred literal type so
  // any downstream `switch (harness.id)` exhaustiveness check sees this
  // harness's exact substrate id rather than the wider `HarnessId` union.
  readonly id = "claude-code" as const;
  readonly capabilities: Capability[];

  private readonly source: DispatchEventSource;
  private readonly factory: CCSessionFactory;

  /**
   * In-flight sessions — used by `shutdown({ graceful: false })` to fan a
   * kill out to every active dispatch. A `Set` rather than an array
   * because we add/remove unordered and care about identity, not order.
   */
  private readonly activeSessions = new Set<CCSessionLike>();

  /**
   * Once `shutdown` has been called, refuse new dispatches. Avoids the
   * race where a `dispatch()` call lands AFTER the runner began draining
   * but BEFORE the harness reference was dropped — without this flag,
   * the new dispatch would spawn a CC session the runner can't track.
   */
  private shuttingDown = false;

  constructor(opts: ClaudeCodeHarnessOpts) {
    this.source = opts.source;
    this.factory = opts.ccSessionFactory ?? defaultCCSessionFactory;
    this.capabilities = opts.capabilities ?? [];
  }

  /**
   * Dispatch a task. See `SessionHarness.dispatch` doc for the lifecycle
   * contract. Implementation notes:
   *
   *   - We yield `dispatch.task.started` BEFORE calling `start()` so that
   *     the lifecycle envelope is observable even if `start()` throws
   *     synchronously (rare — but `Bun.spawn()` can fail at the syscall
   *     layer if `claude` is missing from $PATH).
   *   - We then call `start()` and `wait()`. cc-session's internal stream
   *     parser handles all the tool-use / text event interpretation; the
   *     harness consumes only the final result.
   *   - We translate the result to ONE terminal envelope by mirroring
   *     dispatch-listener.ts's `handleDispatchEnvelope` logic exactly,
   *     so this harness is a behavioural drop-in for the listener (which
   *     is what A.1b will leverage).
   */
  async *dispatch(req: DispatchRequest): AsyncIterable<MyelinEnvelope> {
    // Stabilise correlation_id ONCE per dispatch — the helper falls back
    // to a fresh UUID when `requestId` isn't UUID-shaped, and we need
    // every envelope in this dispatch to share the same value. Re-calling
    // the helper per envelope would mint a new UUID every time.
    const correlationId = this.correlationFor(req);

    if (this.shuttingDown) {
      // Yield a failed terminal envelope rather than throwing — keeps
      // the protocol invariant (always at least one terminal envelope).
      yield this.buildStartedEnvelope(req, new Date(), correlationId);
      yield this.buildFailedEnvelope(req, new Date(), correlationId, "harness shutting down");
      return;
    }

    const startedAt = new Date();
    yield this.buildStartedEnvelope(req, startedAt, correlationId);

    const ccOpts = this.buildCCOpts(req);

    let session: CCSessionLike | null = null;
    let result: CCSessionResult | null = null;
    let runtimeError: Error | null = null;

    try {
      session = this.factory(ccOpts);
      this.activeSessions.add(session);
      session.start();
      result = await session.wait();
    } catch (err) {
      runtimeError = err instanceof Error ? err : new Error(String(err));
    } finally {
      if (session) this.activeSessions.delete(session);
    }

    yield this.buildTerminalEnvelope(req, startedAt, correlationId, result, runtimeError);
  }

  /**
   * Graceful shutdown. With `graceful: true` we just flip the flag —
   * in-flight dispatches finish naturally, new ones get the refusal
   * path. With `graceful: false` we additionally kill every active
   * session, so their `wait()` settles fast (cc-session's kill path
   * resolves `wait()` within 2s via SIGTERM escalation).
   */
  // Substrate contract — shutdown is Promise<void> for caller symmetry
  // with other substrates whose bodies may await teardown work. Body
  // here is sync (kills are issued, dispatch finallys observe via the
  // exit listener), so the rule fires; the contract wins.
  // eslint-disable-next-line @typescript-eslint/require-await
  async shutdown(opts: { graceful: boolean }): Promise<void> {
    this.shuttingDown = true;
    if (opts.graceful) return;

    // Hard shutdown — kill every active session. Don't await — kill is
    // synchronous and `wait()` settlement happens via cc-session's own
    // exit-listener wiring on the dispatch generator side, which then
    // removes the session from `activeSessions` in the dispatch's
    // `finally` block. Echo cortex#125 nit: the previous code called
    // `activeSessions.clear()` after this loop, but that was redundant —
    // each dispatch's `finally` (`this.activeSessions.delete(session)`)
    // already removes its session once `wait()` settles. Clearing here
    // would race with in-flight dispatches that haven't yet observed
    // the kill, and (worse) skip the per-dispatch cleanup symmetry.
    for (const session of this.activeSessions) {
      try {
        session.kill?.();
      } catch (err) {
        // Best-effort: a kill on an already-exited process can throw.
        // Log and continue — we still want to attempt every session.
        process.stderr.write(
          `claude-code-harness: shutdown kill failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Translate a `DispatchRequest` to `CCSessionOpts`. Maps the protocol-
   * level camelCase fields onto cc-session's existing options shape.
   *
   * A.1b widens this from the A.1 baseline by absorbing the legacy
   * `buildCCOpts()` from `dispatch-listener.ts` — every CC-runtime knob
   * the listener used to thread is now read from `req.runtime`. The
   * harness is the single place that knows about `CCSessionOpts`.
   *
   * **Decision: prefer `req.runtime` fields over context kinds.** A.1
   * read operator/entity/project from `context[kind=env]`; A.1b adds
   * the same fields under `req.runtime` plus the eight runtime fields
   * from the legacy listener. Both paths are kept (context kind = env
   * still works for forward compat with adapters that haven't migrated)
   * but explicit `req.runtime` always wins on conflict.
   */
  private buildCCOpts(req: DispatchRequest): CCSessionOpts {
    const opts: CCSessionOpts = {
      prompt: req.prompt,
      agentId: req.agent.id,
      agentName: req.agent.displayName,
    };

    // Q1-α: harness-native tool strings pass through untouched.
    if (req.tools.allow.length > 0) {
      opts.allowedTools = [...req.tools.allow];
    }
    if (req.tools.deny && req.tools.deny.length > 0) {
      opts.disallowedTools = [...req.tools.deny];
    }

    // Q6: wall-clock cap maps to cc-session's existing inactivity timer
    // today. cc-session's timer is fundamentally inactivity-based — the
    // wall-clock split lands in A.1b alongside the listener flip. For
    // A.1, the more conservative of the two caps wins, so we set the
    // timer to `min(timeoutMs, inactivityMs)` when both are provided.
    const timeoutMs = req.timeoutMs;
    const inactivityMs = req.inactivityMs;
    if (timeoutMs !== undefined && inactivityMs !== undefined) {
      opts.timeoutMs = Math.min(timeoutMs, inactivityMs);
    } else if (timeoutMs !== undefined) {
      opts.timeoutMs = timeoutMs;
    } else if (inactivityMs !== undefined) {
      opts.timeoutMs = inactivityMs;
    }

    // A.1b: absorb the CC-specific runtime knobs the dispatch-listener
    // used to thread directly into CCSession. All optional; only set
    // when the request supplied a value (so undefined stays undefined
    // and CCSession's own defaults still apply).
    const runtime = req.runtime;
    if (runtime) {
      if (runtime.cwd !== undefined) opts.cwd = runtime.cwd;
      if (runtime.allowedDirs !== undefined) opts.allowedDirs = runtime.allowedDirs;
      if (runtime.bashAllowlist !== undefined) opts.bashAllowlist = runtime.bashAllowlist;
      if (runtime.bashGuardDisabled !== undefined) opts.bashGuardDisabled = runtime.bashGuardDisabled;
      if (runtime.additionalArgs !== undefined) opts.additionalArgs = runtime.additionalArgs;
      if (runtime.groveChannel !== undefined) opts.groveChannel = runtime.groveChannel;
      if (runtime.groveNetwork !== undefined) opts.groveNetwork = runtime.groveNetwork;
      if (runtime.resumeSessionId !== undefined) opts.resumeSessionId = runtime.resumeSessionId;
    }

    // Surface env context kinds the substrate understands. Unknown kinds
    // are silently dropped per the protocol contract. Kept alongside the
    // `req.runtime` path above for adapters that still emit env-kind
    // context blocks; `req.runtime` values take precedence on conflict.
    for (const ctx of req.context) {
      if (ctx.kind === "env" && typeof ctx.data === "object" && ctx.data !== null) {
        const env = ctx.data as Record<string, unknown>;
        if (opts.operator === undefined && typeof env.operator === "string") opts.operator = env.operator;
        if (opts.entity === undefined && typeof env.entity === "string") opts.entity = env.entity;
        if (opts.project === undefined && typeof env.project === "string") opts.project = env.project;
      }
    }

    return opts;
  }

  /**
   * Latches once a non-UUID `requestId` has been seen so the diagnostic
   * fires exactly once per harness instance — a misconfigured producer
   * dispatching dozens of bad ids per minute does not flood the log.
   * Mirrors the same warn-once pattern in `DispatchHandler.warnedMissingSource`.
   */
  private warnedNonUuidRequestId = false;

  /**
   * Per-dispatch correlation key. Uses `requestId` when valid (UUID), else
   * mints a fresh UUID. This keeps all lifecycle envelopes for one
   * dispatch on the same `correlation_id` even when the caller supplies a
   * non-UUID request id (which the envelope schema would reject).
   *
   * Same defensive pattern that lives in dispatch-listener.ts — the
   * schema only allows UUID `correlation_id`, so we shield the caller
   * from accidental validation failures at publish time.
   *
   * **Echo cortex#125 nit.** When the fallback path fires (non-UUID
   * input), we emit a one-time warning so the operator sees that the
   * substrate is silently rewriting `correlation_id` — a misconfigured
   * producer would otherwise be undetectable except by stack trace
   * comparison across envelopes.
   */
  private correlationFor(req: DispatchRequest): string {
    if (isUuid(req.requestId)) return req.requestId;
    if (!this.warnedNonUuidRequestId) {
      console.warn(
        `claude-code-harness: requestId "${req.requestId}" is not UUID-shaped — substituting a generated correlation_id (this warning fires once per harness instance)`,
      );
      this.warnedNonUuidRequestId = true;
    }
    return randomUUID();
  }

  private buildStartedEnvelope(
    req: DispatchRequest,
    startedAt: Date,
    correlationId: string,
  ): Envelope {
    return createDispatchTaskStartedEvent({
      source: this.source,
      taskId: req.requestId,
      agentId: req.agent.id,
      correlationId,
      startedAt,
    });
  }

  private buildCompletedEnvelope(
    req: DispatchRequest,
    startedAt: Date,
    correlationId: string,
    completedAt: Date,
    resultSummary?: string,
  ): Envelope {
    return createDispatchTaskCompletedEvent({
      source: this.source,
      taskId: req.requestId,
      agentId: req.agent.id,
      correlationId,
      startedAt,
      completedAt,
      ...(resultSummary !== undefined && { resultSummary }),
    });
  }

  private buildFailedEnvelope(
    req: DispatchRequest,
    startedAt: Date,
    correlationId: string,
    errorSummary: string,
  ): Envelope {
    return createDispatchTaskFailedEvent({
      source: this.source,
      taskId: req.requestId,
      agentId: req.agent.id,
      correlationId,
      startedAt,
      failedAt: new Date(),
      errorSummary: truncateError(errorSummary),
    });
  }

  private buildAbortedEnvelope(
    req: DispatchRequest,
    startedAt: Date,
    correlationId: string,
    reason: string,
  ): Envelope {
    return createDispatchTaskAbortedEvent({
      source: this.source,
      taskId: req.requestId,
      agentId: req.agent.id,
      correlationId,
      startedAt,
      abortedAt: new Date(),
      reason,
    });
  }

  /**
   * Map a `CCSessionResult` (or runtime error) to a terminal lifecycle
   * envelope. Mirrors `handleDispatchEnvelope`'s tail logic in
   * `runner/dispatch-listener.ts` — see Echo's W1 round-1 note there
   * about why we trust `result.aborted` over `exitCode === 143`.
   */
  private buildTerminalEnvelope(
    req: DispatchRequest,
    startedAt: Date,
    correlationId: string,
    result: CCSessionResult | null,
    runtimeError: Error | null,
  ): Envelope {
    if (runtimeError) {
      return this.buildFailedEnvelope(req, startedAt, correlationId, runtimeError.message);
    }

    if (!result) {
      // Defensive: factory returned a session whose wait() resolved with
      // nothing parseable. Treat as failure — silent success on a no-op
      // session is the worst-of-both-worlds outcome.
      return this.buildFailedEnvelope(
        req,
        startedAt,
        correlationId,
        "session factory returned no result",
      );
    }

    if (result.success) {
      return this.buildCompletedEnvelope(
        req,
        startedAt,
        correlationId,
        new Date(),
        result.response ? truncateSummary(result.response) : undefined,
      );
    }

    // Distinguish abort (timeout / external kill) from a regular failure.
    // Same logic as dispatch-listener.ts:388 — trust `aborted` over the
    // 143 exit code (the inactivity path resolves with exitCode 1 BEFORE
    // SIGTERM/143 actually fires).
    if (result.aborted === true || result.exitCode === 143) {
      return this.buildAbortedEnvelope(
        req,
        startedAt,
        correlationId,
        result.abortReason ?? "timeout",
      );
    }

    return this.buildFailedEnvelope(
      req,
      startedAt,
      correlationId,
      `claude exited ${result.exitCode}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Cheap UUID v4-ish validator. The envelope schema requires UUID-shaped
 * `correlation_id`; this check avoids minting a fresh UUID when the
 * caller already supplied a valid one as `requestId`.
 *
 * Pattern lifted verbatim from `bus/dispatch-events.ts` / `dispatch-
 * listener.ts` conventions — we match the same 8-4-4-4-12 hex layout
 * without enforcing the version/variant nibbles (the JSON Schema does
 * the strict check downstream).
 */
function isUuid(s: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    s,
  );
}

/**
 * Trim error messages so a verbose stack doesn't blow the worklog limit
 * downstream. 500 chars matches the `system.inbound.failed` convention
 * (system-events §3.5.4). Copied from dispatch-listener.ts:419 — same
 * cap, same rationale.
 */
function truncateError(msg: string): string {
  return msg.length > 500 ? msg.slice(0, 497) + "..." : msg;
}

/**
 * Trim CC response summaries. Surfaces typically render the first line +
 * "(more)..." — cap at 1000 chars to leave room for a label prefix
 * without truncation surprises. Copied from dispatch-listener.ts:428.
 */
function truncateSummary(text: string): string {
  const first = text.split("\n", 1)[0] ?? text;
  return first.length > 1000 ? first.slice(0, 997) + "..." : first;
}
