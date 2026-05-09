/**
 * MIG-4.5 — Runner subscribes to `dispatch.task.received` via the surface-router.
 *
 * Architectural pattern (G-1111 §5):
 *   The surface-router fans envelopes to N adapters. Adapters declare
 *   interest with subjects + filter and a `render(envelope)` method.
 *   Adapters typically render to platforms (Discord, Mattermost, ...);
 *   the runner reuses the SAME adapter shape but `render()` *spawns a CC
 *   session* instead. The router doesn't care — it just fans envelopes.
 *   This keeps the runner symmetric with platform adapters and means a
 *   future test harness can register a no-op runner adapter to drain the
 *   bus during integration tests.
 *
 * Lifecycle (per plan-cortex-migration.md §4.5–4.6):
 *   1. Envelope arrives on `local.{org}.dispatch.task.received`.
 *   2. Listener parses payload → builds `CCSessionOpts`.
 *   3. Emits `dispatch.task.started` (correlation_id = task_id).
 *   4. Spawns the CC session and awaits completion.
 *   5. On exit: emits `completed` (success), `failed` (non-zero exit /
 *      runtime error), or `aborted` (timeout / shutdown).
 *
 * **Boundaries (per task contract):**
 *   - This file does NOT modify `dispatch-handler.ts`. The bus-driven path
 *     and the legacy direct-call path coexist until MIG-7.1 picks the
 *     entrypoint wiring.
 *   - This file does NOT modify `cc-session.ts` or `session-manager.ts`.
 *     CC spawning is byte-identical to the existing handler — we use the
 *     same `CCSession` primitive with the same opts.
 *   - This file does NOT post to Discord. Surfaces (worklog-manager via
 *     §4.7, dashboard via the bus) consume the lifecycle envelopes the
 *     runner emits and render their own way.
 *
 * **Why the listener is a SurfaceAdapter and not a separate "runner
 * subscriber" type:**
 *   The G-1111 design is explicit (§5.1): the surface-router is the single
 *   fan-out point, and adapters declare a `render(envelope)` shape. The
 *   runner is logically *also* a surface — it "renders" envelopes by
 *   producing CC sessions. Re-using the same shape keeps the router code
 *   path uniform (subject match → filter → render) and avoids inventing a
 *   parallel "consumer" registry. The semantic difference (render vs
 *   spawn) lives in the adapter implementation, not the registry.
 */

import type { Envelope } from "../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type {
  SurfaceAdapter,
  SurfaceRouter,
} from "../bus/surface-router";
import type { SystemEventSource } from "../bus/system-events";
import {
  createDispatchTaskAbortedEvent,
  createDispatchTaskCompletedEvent,
  createDispatchTaskFailedEvent,
  createDispatchTaskStartedEvent,
} from "../bus/dispatch-events";
import { CCSession, type CCSessionOpts, type CCSessionResult } from "./cc-session";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Factory for building a CC session from envelope-derived options. Default
 * implementation is `(opts) => new CCSession(opts)`. Tests inject a fake
 * factory so they can simulate session lifecycles deterministically without
 * spawning real `claude` processes.
 *
 * The factory MUST return an object that exposes `start()` (returns `this`,
 * fluent API) and `wait(): Promise<CCSessionResult>`. Real `CCSession`
 * matches; fakes implement the same surface.
 */
export interface CCSessionLike {
  start(): CCSessionLike;
  wait(): Promise<CCSessionResult>;
  kill?(): void;
}
export type CCSessionFactory = (opts: CCSessionOpts) => CCSessionLike;

const defaultCCSessionFactory: CCSessionFactory = (opts) => new CCSession(opts);

/**
 * Payload shape for `dispatch.task.received` envelopes — the input contract
 * from any caller that wants the runner to spawn a CC session. Spelled out
 * as an interface so producers (the future `dispatch-handler` bus emitter,
 * test fixtures, ad-hoc CLI tools) and consumers (this listener) share one
 * source of truth.
 *
 * Field naming follows the §3.4 convention (`task_id`, `agent_id`) plus
 * snake_case for everything else to match the wider envelope-payload
 * idiom (`disconnected_since`, `result_summary`, etc.).
 *
 * Required fields are the minimum the runner needs to spawn CC. Optional
 * fields map 1:1 onto `CCSessionOpts` for forward-compat. The listener
 * silently ignores unknown fields — adding a payload field is non-breaking
 * per §3.1's append-only rule.
 */
export interface DispatchTaskReceivedPayload {
  /** UUID-shaped task identifier (also envelope.correlation_id). */
  task_id: string;
  /** Agent that should execute (`cortex`, `pilot`, ...). */
  agent_id: string;
  /** The CC prompt — what claude should do. Required. */
  prompt: string;
  /** Optional CC session opts — passed through to CCSession constructor. */
  grove_channel?: string;
  grove_network?: string;
  agent_name?: string;
  resume_session_id?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  allowed_dirs?: string[];
  timeout_ms?: number;
  cwd?: string;
  additional_args?: string[];
  project?: string;
  entity?: string;
  operator?: string;
}

export interface DispatchListenerOptions {
  /** MyelinRuntime — used to publish lifecycle events back onto the bus. */
  runtime: MyelinRuntime;
  /** Surface-router — the listener registers itself as a surface adapter. */
  router: SurfaceRouter;
  /** Source identity for the lifecycle envelopes the listener emits. */
  source: SystemEventSource;
  /**
   * Subject pattern(s) to subscribe to. Defaults to
   * `local.{org}.dispatch.task.received` per the plan §4.5. Tests can
   * override with broader patterns (`local.test.dispatch.task.received`).
   */
  subjects?: string[];
  /**
   * Optional CC session factory. Default constructs a real `CCSession`.
   * Tests pass a fake to drive lifecycles without spawning processes.
   */
  ccSessionFactory?: CCSessionFactory;
  /**
   * Adapter ID for surface-router error reporting. Defaults to
   * `runner-dispatch-listener`. Configurable so multiple runner instances
   * (a future operator-controlled fleet) can disambiguate.
   */
  adapterId?: string;
}

export interface DispatchListener {
  /**
   * The surface-adapter face of the listener. Exposed primarily for
   * testing — callers don't usually register this directly because
   * `start()` does the registration. Returning it lets tests inspect
   * the SurfaceAdapter contract (subjects, render, etc.) without
   * standing up a router.
   */
  readonly surfaceConfig: SurfaceAdapter;
  /** Register with the router. Idempotent. */
  start(): Promise<void>;
  /** Unregister and stop accepting new envelopes. Idempotent. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Default subject for the runner's bus subscription. The `{org}` segment
 * is substituted at registration time using `source.org` so a misconfigured
 * runner with no operator id can still subscribe (it'll match nothing
 * unless someone publishes under `local.default.dispatch.task.received`).
 */
function defaultSubjects(org: string): string[] {
  return [`local.${org}.dispatch.task.received`];
}

export function createDispatchListener(
  opts: DispatchListenerOptions,
): DispatchListener {
  const {
    runtime,
    router,
    source,
    ccSessionFactory = defaultCCSessionFactory,
    adapterId = "runner-dispatch-listener",
  } = opts;
  const subjects = opts.subjects ?? defaultSubjects(source.org);

  let registration: { unregister: () => void } | null = null;

  const surfaceConfig: SurfaceAdapter = {
    id: adapterId,
    subjects,
    // No payload filter on the listener side — every received envelope
    // is meant for the runner. If we add multi-runner routing (filter on
    // `payload.agent_id`), it goes here as a `PayloadFilter`.
    render: (envelope) => handleDispatchEnvelope(envelope, runtime, source, ccSessionFactory),
  };

  return {
    surfaceConfig,
    async start() {
      if (registration) return;
      registration = router.register(surfaceConfig);
    },
    async stop() {
      if (!registration) return;
      registration.unregister();
      registration = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Internals — envelope → CC spawn → lifecycle emission
// ---------------------------------------------------------------------------

/**
 * Parse + validate a `dispatch.task.received` envelope payload.
 *
 * Returns `null` (not throws) on malformed payload — surfaces should
 * tolerate bad envelopes per the §3.3.4 ordering/dedupe guarantees. The
 * adapter logs and returns; the surface-router's isolation hook captures
 * the case via the missing `dispatch.task.started` event downstream
 * (a producer that emits `received` and never sees `started` knows
 * something went wrong).
 */
function parsePayload(envelope: Envelope): DispatchTaskReceivedPayload | null {
  const p = envelope.payload as Partial<DispatchTaskReceivedPayload> | undefined;
  if (!p) return null;
  if (typeof p.task_id !== "string" || typeof p.agent_id !== "string") return null;
  if (typeof p.prompt !== "string" || p.prompt.length === 0) return null;
  // TODO (deferred to MIG-7.x — Echo round-1 s2): payload-level UUID
  // validation on `task_id`. Not added here because:
  //   1. The envelope-level `validateEnvelope` already checks `envelope.id`
  //      shape — the typical caller path (dispatch-handler emitting onto
  //      the bus) sets `correlation_id = task_id` and runs through the
  //      same UUID validator already.
  //   2. Adding a second UUID regex here re-implements that check at a
  //      different layer without a clear failure mode it would catch —
  //      the only producer who could slip a non-UUID `task_id` past us
  //      is a producer that bypasses validateEnvelope, which is an
  //      architectural problem that belongs at the validator layer.
  // When MIG-7+ adds a multi-runner federation, payload-shape contracts
  // become first-class (per §4.x) — that's the right place to add a
  // payload-level Zod schema for `dispatch.task.received`.
  return p as DispatchTaskReceivedPayload;
}

/**
 * Map a parsed payload onto `CCSessionOpts`. Keeps the snake_case <-> camelCase
 * boundary in one place and avoids leaking envelope-payload field names into
 * cc-session.ts.
 */
function buildCCOpts(payload: DispatchTaskReceivedPayload): CCSessionOpts {
  const opts: CCSessionOpts = { prompt: payload.prompt };
  if (payload.grove_channel !== undefined) opts.groveChannel = payload.grove_channel;
  if (payload.grove_network !== undefined) opts.groveNetwork = payload.grove_network;
  if (payload.agent_name !== undefined) opts.agentName = payload.agent_name;
  // The agent_id from the envelope payload doubles as `agentId` on CCSession
  // — this is the visible label propagated through `GROVE_AGENT_ID` env var.
  opts.agentId = payload.agent_id;
  if (payload.resume_session_id !== undefined) opts.resumeSessionId = payload.resume_session_id;
  if (payload.allowed_tools !== undefined) opts.allowedTools = payload.allowed_tools;
  if (payload.disallowed_tools !== undefined) opts.disallowedTools = payload.disallowed_tools;
  if (payload.allowed_dirs !== undefined) opts.allowedDirs = payload.allowed_dirs;
  if (payload.timeout_ms !== undefined) opts.timeoutMs = payload.timeout_ms;
  if (payload.cwd !== undefined) opts.cwd = payload.cwd;
  if (payload.additional_args !== undefined) opts.additionalArgs = payload.additional_args;
  if (payload.project !== undefined) opts.project = payload.project;
  if (payload.entity !== undefined) opts.entity = payload.entity;
  if (payload.operator !== undefined) opts.operator = payload.operator;
  return opts;
}

/**
 * The render() implementation: parse → emit started → spawn → await →
 * emit completed/failed/aborted. Return Promise<void> so the surface-router
 * can await this with its render-timeout isolation.
 */
async function handleDispatchEnvelope(
  envelope: Envelope,
  runtime: MyelinRuntime,
  source: SystemEventSource,
  factory: CCSessionFactory,
): Promise<void> {
  const payload = parsePayload(envelope);
  if (!payload) {
    console.error(
      `cortex-runner: dispatch-listener: malformed dispatch.task.received envelope id=${envelope.id} — required fields missing`,
    );
    return;
  }

  const startedAt = new Date();
  const taskId = payload.task_id;
  const agentId = payload.agent_id;

  // Emit `dispatch.task.started` BEFORE spawning so the bus reflects the
  // intent even if the spawn itself errors synchronously. Awaiting publish
  // is cheap (it's a no-op when the runtime is disabled) and gives the
  // started event a strict happens-before relationship with the spawn.
  await runtime.publish(
    createDispatchTaskStartedEvent({ source, taskId, agentId, startedAt }),
  );

  const ccOpts = buildCCOpts(payload);
  let result: CCSessionResult | null = null;
  let runtimeError: Error | null = null;

  try {
    const session = factory(ccOpts);
    session.start();
    result = await session.wait();
  } catch (err) {
    runtimeError = err instanceof Error ? err : new Error(String(err));
  }

  // Choose terminal lifecycle event based on outcome.
  if (runtimeError) {
    // Runtime threw — failed. Distinct from `aborted` (which is "killed
    // from outside" e.g. timeout, shutdown).
    await runtime.publish(
      createDispatchTaskFailedEvent({
        source,
        taskId,
        agentId,
        startedAt,
        failedAt: new Date(),
        errorSummary: truncateError(runtimeError.message),
      }),
    );
    return;
  }

  if (!result) {
    // Defensive: factory returned nothing parseable. Treat as failure
    // rather than swallowing — silent success on a no-op session is the
    // worst-of-both-worlds outcome.
    await runtime.publish(
      createDispatchTaskFailedEvent({
        source,
        taskId,
        agentId,
        startedAt,
        failedAt: new Date(),
        errorSummary: "session factory returned no result",
      }),
    );
    return;
  }

  if (result.success) {
    await runtime.publish(
      createDispatchTaskCompletedEvent({
        source,
        taskId,
        agentId,
        startedAt,
        completedAt: new Date(),
        ...(result.response && { resultSummary: truncateSummary(result.response) }),
      }),
    );
    return;
  }

  // Distinguish abort (timeout / external kill) from a regular failure.
  //
  // History (Echo round-1 W1): the previous implementation only looked at
  // `result.exitCode === 143` (SIGTERM). That signal is UNREACHABLE for
  // the canonical inactivity-timeout case, because cc-session.ts settles
  // `wait()` via the `error` listener with `exitCode: 1` BEFORE the actual
  // SIGTERM/143 fires. The fix lives in cc-session.ts: it now exposes
  // `aborted: boolean` + `abortReason` on CCSessionResult, sourced from
  // its internal `timedOut` flag, regardless of which listener wins the
  // race. We treat that field as the source of truth and keep the
  // exit-code-143 check as defense-in-depth (e.g. a SIGTERM delivered
  // from outside without going through the inactivity timer).
  if (result.aborted === true || result.exitCode === 143) {
    await runtime.publish(
      createDispatchTaskAbortedEvent({
        source,
        taskId,
        agentId,
        startedAt,
        abortedAt: new Date(),
        reason: result.abortReason ?? "timeout",
      }),
    );
    return;
  }

  await runtime.publish(
    createDispatchTaskFailedEvent({
      source,
      taskId,
      agentId,
      startedAt,
      failedAt: new Date(),
      errorSummary: `claude exited ${result.exitCode}`,
    }),
  );
}

/**
 * Trim error messages so a verbose stack doesn't blow the worklog message
 * limit downstream. 500 chars matches `system.inbound.failed`'s limit
 * (system-events §3.5.4) — keeping the dispatch family symmetric.
 */
function truncateError(msg: string): string {
  return msg.length > 500 ? msg.slice(0, 497) + "..." : msg;
}

/**
 * Trim CC response summaries. Discord embeds tolerate ~2000 chars but
 * surfaces typically render the first line + "(more)..." — caps at 1000
 * to leave room for a label prefix without truncation surprises.
 */
function truncateSummary(text: string): string {
  const first = text.split("\n", 1)[0] ?? text;
  return first.length > 1000 ? first.slice(0, 997) + "..." : first;
}

