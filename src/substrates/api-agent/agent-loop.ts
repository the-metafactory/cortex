// API-P1.3 (epic #2055, Phase 1, decisions D1/D5) — the api-agent AGENT LOOP.
//
// The loop is the engine underneath `ApiAgentHarness`: it consumes a provider's
// normalized `ModelProvider.stream(request)` and reduces it to a single terminal
// OUTCOME (`completed` / `failed` / `aborted`) plus the accumulated assistant
// text, usage, and provider request id. The harness (`./harness.ts`) turns that
// outcome into the ONE terminal Myelin lifecycle envelope the `SessionHarness`
// contract requires.
//
// WHY A PURE FUNCTION (not a generator): the harness owns the lifecycle-envelope
// yields (exactly one `started`, exactly one terminal). The loop owns the
// provider-stream mechanics — timers, cancellation, event accumulation — and
// returns a value. Keeping the two apart makes the one-terminal invariant a
// property of the harness's straight-line control flow, not of interleaved
// generator state.
//
// LIMITS + CANCELLATION (D1 — cortex owns limits, not the provider): the loop
// races each provider event against a wall-clock deadline AND an inactivity gap
// (reset on every event), plus an injected `AbortSignal` for dispatch
// cancellation. A timeout maps to a `failed` outcome (basic mapping; the full
// error-kind→lifecycle table is the sibling slice API-P1.4); cancellation maps
// to `aborted`. On any early exit the loop CLOSES the provider iterator
// (`iterator.return()`), which runs the provider's stream `finally` and releases
// the underlying HTTP connection — no leaked sockets.
//
// PROVIDER ERROR SEAM (D2 — providers YIELD an `{type:"error"}` event, never
// throw): the loop consumes that event and reduces it to a `failed` outcome
// carrying ONLY the redacted `ProviderError.summary` PLUS the normalized
// secret-free facts (kind, retryability, `retryAfterMs`) the harness needs for
// the API-P1.4 error-kind→lifecycle mapping + back-pressure — never raw detail,
// headers, or secrets. A provider that nonetheless rejects `next()` (contract
// violation) is caught and collapsed to a fixed, secret-free `failed` summary
// (no `providerError` facts — a rejection is not a normalized error).
//
// NO TOOLS (D5): Phase 1 is text-only. If a provider emits a `tool_call.*` event
// the loop IGNORES it (never executes anything) — tool execution is Phase 3.

import type {
  FinishReason,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "../../common/inference/types";
import type { ProviderError, ProviderErrorKind } from "../../common/inference/errors";

/** Token accounting accumulated from the provider's `usage` event. */
export interface AgentLoopUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

/**
 * The single terminal outcome the loop reduces a provider stream to. The harness
 * maps this 1:1 onto a terminal lifecycle envelope.
 */
export type AgentLoopOutcome =
  | {
      kind: "completed";
      /** Full accumulated assistant text (untruncated). */
      text: string;
      finishReason: FinishReason;
      usage?: AgentLoopUsage;
      providerRequestId?: string;
    }
  | {
      kind: "failed";
      /** REDACTED summary only — never raw provider detail or secrets. */
      summary: string;
      providerRequestId?: string;
      /**
       * API-P1.4 — the normalized-provider-error facts, present ONLY when this
       * failure came from a yielded provider `error` event (not a cortex-side
       * timeout / stream fault). The harness maps these onto the lifecycle
       * envelope's diagnostic fields + back-pressure hint. Carries the normalized
       * kind + numeric retry hint ONLY — never the raw body, headers, or secrets.
       */
      providerError?: {
        errorKind: ProviderErrorKind;
        retryable: boolean;
        retryAfterMs?: number;
      };
    }
  | { kind: "aborted"; reason: string };

/** Inputs to {@link runAgentLoop}. */
export interface AgentLoopOptions {
  provider: ModelProvider;
  request: ModelRequest;
  /** Wall-clock deadline for the whole dispatch, in ms. */
  wallClockMs: number;
  /** Max gap between provider events before the loop trips inactivity, in ms. */
  inactivityMs: number;
  /** Dispatch cancellation. When aborted the loop yields an `aborted` outcome. */
  signal?: AbortSignal;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

/** Result of racing the provider iterator against the limits + cancellation. */
type NextStep =
  | { type: "event"; result: IteratorResult<ModelEvent> }
  | { type: "threw" }
  | { type: "timeout" }
  | { type: "aborted" };

/**
 * Race one `iterator.next()` against a time budget and the cancellation signal.
 * Settles at most once. The pending `next()` is abandoned on timeout/abort —
 * the caller closes the iterator afterwards, which tears the stream down.
 */
function raceNext(
  iterator: AsyncIterator<ModelEvent>,
  budgetMs: number,
  signal: AbortSignal | undefined,
): Promise<NextStep> {
  return new Promise<NextStep>((resolve) => {
    let settled = false;
    const finish = (step: NextStep): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      resolve(step);
    };
    const onAbort = (): void => {
      finish({ type: "aborted" });
    };

    if (signal?.aborted) {
      // Already cancelled — resolve directly (no timer/listener to clean up).
      resolve({ type: "aborted" });
      return;
    }
    const timer = setTimeout(() => {
      finish({ type: "timeout" });
    }, budgetMs);
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    iterator.next().then(
      (result) => {
        finish({ type: "event", result });
      },
      // Providers YIELD errors rather than throwing; a rejection is a contract
      // violation. Collapse it to a fixed step — the raw error is dropped so no
      // provider/connection detail can leak into the outcome summary.
      () => {
        finish({ type: "threw" });
      },
    );
  });
}

/**
 * Best-effort close of the provider iterator so its stream `finally` runs and
 * releases the underlying HTTP connection.
 *
 * FIRE-AND-FORGET — deliberately NOT awaited. On a timeout / cancellation the
 * provider generator is suspended at `await reader.read()` on a stream that has
 * not produced a frame (e.g. a hung connection); `iterator.return()` cannot run
 * that generator's `finally` until the pending read settles, so awaiting it here
 * would re-introduce the very hang the limit exists to break. We request the
 * return (which the provider's own `finally` honours by cancelling the reader the
 * moment the read settles) and let the loop return its terminal outcome
 * immediately. Any rejection from the return is swallowed — teardown is
 * idempotent and nothing actionable remains.
 */
function closeIterator(iterator: AsyncIterator<ModelEvent>): void {
  try {
    const returned = iterator.return?.();
    if (returned !== undefined) {
      void returned.catch(() => {
        /* teardown of an already-aborted stream can reject — nothing to do. */
      });
    }
  } catch (_err) {
    // `iterator.return` itself threw synchronously (non-conforming iterator);
    // the connection teardown is idempotent, so there is nothing actionable.
  }
}

/** Map a yielded provider `error` event to a `failed` outcome (redacted only). */
function errorOutcome(
  error: ProviderError,
  accumulatedRequestId: string | undefined,
): AgentLoopOutcome {
  // Prefer the error's own provider request id for correlation; fall back to any
  // id seen earlier in the stream. API-P1.4 — carry the normalized kind +
  // retryability + retry hint alongside the redacted summary so the harness can
  // map the kind onto the lifecycle outcome + back-pressure. Only these
  // SECRET-FREE facts cross the seam — never the raw body, headers, or key.
  const requestId = error.providerRequestId ?? accumulatedRequestId;
  return {
    kind: "failed",
    summary: error.summary,
    ...(requestId !== undefined ? { providerRequestId: requestId } : {}),
    providerError: {
      errorKind: error.kind,
      retryable: error.retryable,
      ...(error.retryAfterMs !== undefined
        ? { retryAfterMs: error.retryAfterMs }
        : {}),
    },
  };
}

/**
 * Drive `provider.stream(request)` to a single terminal outcome under the
 * dispatch's limits + cancellation. See the file header for the full contract.
 */
export async function runAgentLoop(
  opts: AgentLoopOptions,
): Promise<AgentLoopOutcome> {
  const { provider, request, wallClockMs, inactivityMs, signal } = opts;
  const now = opts.now ?? ((): number => Date.now());

  if (signal?.aborted) {
    return { kind: "aborted", reason: "cancelled" };
  }

  const iterator = provider.stream(request)[Symbol.asyncIterator]();
  const wallDeadline = now() + wallClockMs;

  let text = "";
  let usage: AgentLoopUsage | undefined;
  let providerRequestId: string | undefined;
  let finishReason: FinishReason | undefined;

  try {
    for (;;) {
      const wallRemaining = wallDeadline - now();
      if (wallRemaining <= 0) {
        return {
          kind: "failed",
          summary: "wall-clock timeout",
          ...(providerRequestId !== undefined ? { providerRequestId } : {}),
        };
      }
      // The binding budget is whichever limit expires first — the inactivity
      // gap (reset every iteration) or the remaining wall-clock.
      const budget = Math.min(wallRemaining, inactivityMs);
      const step = await raceNext(iterator, budget, signal);

      if (step.type === "aborted") {
        return { kind: "aborted", reason: "cancelled" };
      }
      if (step.type === "timeout") {
        // Classify which limit bound: wall-clock if the hard deadline passed,
        // otherwise the inactivity gap. Both map to a `failed` terminal here.
        const wallHit = now() >= wallDeadline;
        return {
          kind: "failed",
          summary: wallHit ? "wall-clock timeout" : "inactivity timeout",
          ...(providerRequestId !== undefined ? { providerRequestId } : {}),
        };
      }
      if (step.type === "threw") {
        return {
          kind: "failed",
          summary: "provider stream error",
          ...(providerRequestId !== undefined ? { providerRequestId } : {}),
        };
      }

      if (step.result.done === true) break;
      const value = step.result.value;

      switch (value.type) {
        case "response.started":
          if (value.providerRequestId !== undefined) {
            providerRequestId = value.providerRequestId;
          }
          break;
        case "text.delta":
          text += value.text;
          break;
        case "usage":
          usage = {
            inputTokens: value.inputTokens,
            outputTokens: value.outputTokens,
            ...(value.cacheReadTokens !== undefined
              ? { cacheReadTokens: value.cacheReadTokens }
              : {}),
          };
          break;
        case "response.completed":
          finishReason = value.finishReason;
          break;
        case "error":
          return errorOutcome(value.error, providerRequestId);
        case "tool_call.delta":
        case "tool_call.completed":
          // D5 — no tools in Phase 1. A text-only request should never elicit a
          // tool call, but if a provider emits one we IGNORE it (never execute).
          break;
      }
    }
  } finally {
    closeIterator(iterator);
  }

  // Stream ended without an `error` event → success. `response.completed` is the
  // normal terminator; a provider that closed cleanly without one still
  // completed (finishReason defaults to "stop").
  return {
    kind: "completed",
    text,
    finishReason: finishReason ?? "stop",
    ...(usage !== undefined ? { usage } : {}),
    ...(providerRequestId !== undefined ? { providerRequestId } : {}),
  };
}
