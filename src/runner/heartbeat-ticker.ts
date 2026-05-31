/**
 * cortex#361 — `HeartbeatTicker`.
 *
 * Fires a `system.agent.heartbeat` envelope on a fixed interval (default
 * 30 s) while a dispatch is in flight. Lives in `src/runner/` because it
 * straddles the dispatch path (chat-path: `dispatch-handler.ts`) and the
 * review path (`review-pipeline.ts`) — both wire it from outside; the
 * primitive itself knows nothing about either consumer.
 *
 * **Phase tracking.** Callers feed cc-session stream events into
 * `notePhase(phase)`. The ticker remembers the most recent phase + the
 * timestamp it was observed at; on each tick it publishes the
 * `(phase, last_activity_ms_ago)` pair. `notePhase` must be cheap because
 * cc-session can emit at high frequency (every assistant-text token is an
 * event); the implementation is a single object-field write plus a
 * `Date.now()` call.
 *
 * **Failure mode.** A failing `runtime.publish` (NATS hiccup, signer
 * fault) MUST NOT bubble back to the dispatch path. Principal pings that
 * happen to coincide with a bus outage must still complete their CC
 * session and reply on Discord. The ticker logs publish failures to
 * `process.stderr` and continues ticking; the next tick may succeed.
 *
 * **Idempotency.** `stop()` is idempotent — calling it twice (e.g. from
 * both `session.on('result', ...)` and `session.on('exit', ...)`) is
 * safe. After `stop()`, further `notePhase` calls are dropped (the
 * dispatch has finished; phase is irrelevant) so callers don't have to
 * tear down their `session.on('text', ...)` listeners before the
 * `stop()`.
 */

import type { MyelinRuntime } from "../bus/myelin/runtime";
import type {
  SystemAgentHeartbeatOpts,
  SystemEventSource,
} from "../bus/system-events";
import { createAgentHeartbeatEvent } from "../bus/system-events";
import type { AgentHeartbeatPayload } from "../common/types/agent-heartbeat";
import type { CCSession } from "./cc-session";

/** Default tick interval — 30 s, matching the cortex#361 issue body. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatTickerStartOpts {
  /**
   * Tick interval in milliseconds. Callers can override per-flavor (e.g.
   * a review with a 10-min CC budget might want 60 s ticks to keep
   * envelope volume down). Defaults to {@link DEFAULT_HEARTBEAT_INTERVAL_MS}.
   */
  intervalMs?: number;
  /** Myelin runtime — heartbeats publish via `runtime.publish`. */
  runtime: MyelinRuntime;
  /** Source triple — same as the rest of `system.*` (principal.agent.instance). */
  source: SystemEventSource;
  /** Logical agent name (`echo`, `luna`, ...). */
  agentId: string;
  /** Dispatch task identifier. */
  taskId: string;
  /** UUID-shaped correlation key. */
  correlationId: string;
  /**
   * Optional initial phase. Defaults to `"thinking"` — heartbeats fire
   * before any cc-session stream event has arrived, so "thinking" is the
   * honest default. Callers in the review-pipeline path may want to set
   * `"thinking"` explicitly when the pipeline is in the pre-CC policy
   * gate (no session yet) and `"streaming_response"` once a session has
   * been spawned.
   */
  initialPhase?: AgentHeartbeatPayload["phase"];
}

/**
 * Heartbeat ticker primitive. One instance per in-flight dispatch.
 *
 * Lifecycle:
 *   1. `new HeartbeatTicker()` — does nothing observable.
 *   2. `start(opts)` — schedules the recurring tick + publishes the first
 *      heartbeat immediately so dashboards don't have to wait `intervalMs`
 *      for the first signal. `iteration` starts at `1`.
 *   3. `notePhase(phase)` (called per cc-session stream event) — updates
 *      the cached phase + last-activity timestamp.
 *   4. `stop()` — clears the interval. Idempotent.
 */
export class HeartbeatTicker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private opts: HeartbeatTickerStartOpts | undefined;
  private lastActivityAt = Date.now();
  private phase: AgentHeartbeatPayload["phase"] = "thinking";
  private iteration = 0;
  /**
   * Echo cortex#363 minor — backpressure guard. Counts publishes that
   * have been issued via `void runtime.publish(...).catch(...)` but not
   * yet settled. Under a NATS hiccup where each publish stalls past
   * `intervalMs`, unbounded ticks would accumulate pending promises;
   * the guard skips a tick when a publish from the previous tick is
   * still in flight so the in-flight count is bounded at 1.
   */
  private inFlight = 0;

  /**
   * Begin ticking. Publishes the first heartbeat synchronously (well —
   * `void runtime.publish(...)`, since publish is async but we don't
   * await it) before scheduling the recurring `setInterval`. Calling
   * `start` twice on the same instance throws — callers must `stop()`
   * before re-starting (the dispatch-handler / review-pipeline lifecycle
   * never re-uses an instance, so this is defensive only).
   */
  start(opts: HeartbeatTickerStartOpts): void {
    if (this.timer !== undefined) {
      throw new Error(
        "HeartbeatTicker.start called twice without stop() in between",
      );
    }
    this.opts = opts;
    this.lastActivityAt = Date.now();
    this.phase = opts.initialPhase ?? "thinking";
    this.iteration = 0;
    const interval = opts.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    // First heartbeat fires immediately. Dashboards / surface-router
    // liveness consumers don't have to wait `interval` for the agent to
    // become visible.
    this.tick();
    this.timer = setInterval(() => {
      this.tick();
    }, interval);
  }

  /**
   * Record an activity event observed from the cc-session stream. Cheap:
   * one object-field write + one `Date.now()`. Safe to call after
   * `stop()` (drops silently — the dispatch is over).
   */
  notePhase(phase: AgentHeartbeatPayload["phase"]): void {
    if (this.timer === undefined) {
      // Either we've stopped, or we never started. Drop silently so
      // callers don't have to tear down listeners before `stop()`.
      return;
    }
    this.phase = phase;
    this.lastActivityAt = Date.now();
  }

  /**
   * Stop the recurring ticker. Idempotent — calling twice is a no-op.
   * Does NOT publish a final heartbeat; the terminal envelope (verdict /
   * dispatch.task.completed) is the "done" signal, not a heartbeat.
   */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.opts = undefined;
  }

  /**
   * Internal — build + publish one heartbeat envelope. Errors swallowed +
   * logged so a bus outage can't crash the dispatch path. Increments the
   * iteration counter BEFORE building the envelope so the first tick
   * after `start()` carries `iteration: 1`.
   */
  private tick(): void {
    const opts = this.opts;
    if (!opts) return;
    // Echo cortex#363 minor — bound the in-flight publish count to 1.
    // If the previous tick's publish hasn't settled by the time this
    // tick fires, the bus is slower than `intervalMs`; skip and log
    // once per backpressure event so principals can see it forming
    // without the log being chatty under steady-state operation.
    if (this.inFlight > 0) {
      console.warn(
        `heartbeat-ticker: skipping tick — previous publish still in flight ` +
          `(task=${opts.taskId} iteration=${this.iteration})`,
      );
      return;
    }
    this.iteration += 1;
    const lastActivityMsAgo = Math.max(0, Date.now() - this.lastActivityAt);
    const envelopeOpts: SystemAgentHeartbeatOpts = {
      source: opts.source,
      agentId: opts.agentId,
      taskId: opts.taskId,
      correlationId: opts.correlationId,
      phase: this.phase,
      lastActivityMsAgo,
      iteration: this.iteration,
    };
    let envelope;
    try {
      envelope = createAgentHeartbeatEvent(envelopeOpts);
    } catch (err) {
      // Envelope construction itself failing is a programming bug, not
      // an operational one — but keeping the swallow here means a
      // mis-built envelope from a future schema-tightening doesn't kill
      // a long-running dispatch. Log loudly so it surfaces in stderr.
      console.error(
        "heartbeat-ticker: createAgentHeartbeatEvent failed:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    this.inFlight += 1;
    const iterationForLog = this.iteration;
    void opts.runtime
      .publish(envelope)
      .catch((err: unknown) => {
        console.error(
          `heartbeat-ticker: runtime.publish failed (task=${opts.taskId} iteration=${iterationForLog}):`,
          err instanceof Error ? err.message : String(err),
        );
      })
      .finally(() => {
        this.inFlight -= 1;
      });
  }
}

/**
 * Echo cortex#363 major — single attachment helper. Both
 * `DispatchHandler.attachHeartbeatTicker` and
 * `ReviewConsumer.attachHeartbeatToSession` collapsed into this primitive
 * to eliminate duplication. The two call sites now hold no per-call
 * wiring logic of their own — they construct opts + call this function.
 *
 * Wires:
 *   - `tool-use`          → `notePhase('tool_use')`
 *   - `text`              → `notePhase('streaming_response')`
 *   - `result`            → `notePhase('publishing_verdict')` + `stop()`
 *   - `error`             → `stop()`
 *   - `exit`              → `stop()`
 *
 * Returns a `{ stop }` handle. Calling it is safe at any point —
 * `HeartbeatTicker.stop()` is idempotent and the registered event
 * listeners ALSO stop the ticker, so callers can rely on either the
 * handle or the session's terminal events (whichever fires first).
 *
 * When `HeartbeatTicker.start()` throws (only happens on a double-start
 * — a programming bug, not an operational one), this function logs +
 * returns a no-op handle so call sites don't have to branch on
 * exceptions.
 */
export function attachHeartbeatToCCSession(
  session: CCSession,
  opts: HeartbeatTickerStartOpts,
): { stop: () => void } {
  const ticker = new HeartbeatTicker();
  try {
    ticker.start(opts);
  } catch (err) {
    console.error(
      `heartbeat-ticker: attachHeartbeatToCCSession start failed (task=${opts.taskId}):`,
      err instanceof Error ? err.message : String(err),
    );
    return {
      stop: () => {
        /* ticker.start() failed; nothing to stop */
      },
    };
  }
  session.on("tool-use", () => {
    ticker.notePhase("tool_use");
  });
  session.on("text", () => {
    ticker.notePhase("streaming_response");
  });
  session.on("result", () => {
    ticker.notePhase("publishing_verdict");
    ticker.stop();
  });
  session.on("error", () => {
    ticker.stop();
  });
  session.on("exit", () => {
    ticker.stop();
  });
  return {
    stop: () => {
      ticker.stop();
    },
  };
}
