/**
 * Runner dispatch listener — consumes inbound dispatchable task envelopes
 * directly from the `MyelinRuntime` and spawns a substrate harness per
 * dispatch.
 *
 * **cortex#484 Option D — executor, not renderer.** Pre-#484 the
 * listener registered itself as a `SurfaceAdapter` on the
 * surface-router and ran `handleDispatchEnvelope` under the router's
 * `DEFAULT_RENDER_TIMEOUT_MS = 5000ms` envelope. That was a category
 * error per `CONTEXT.md` (§Dispatch-listener vs §Renderer): a CC
 * session takes minutes, not seconds; "rendering" is the sub-second
 * presentation concern (post a Discord message, push a dashboard
 * update). Wrapping a long-running executor in a 5s render timeout
 * surfaced as `render timeout after 5000ms` errors on every
 * Discord-originated chat dispatch (cortex#484 repro).
 *
 * Option D drops the SurfaceAdapter registration entirely. The
 * listener now subscribes via `runtime.onEnvelope()` + an inline
 * `subjectMatches` filter — symmetric with `BusDispatchListener`
 * (`src/bus/bus-dispatch-listener.ts`). The surface-router still
 * fans the same envelope to its real renderers (Discord channel
 * post, dashboard update) under the timeout that's appropriate for
 * THEM; the runner runs in its own microtask chain with no timeout
 * and tracks in-flight CC sessions on an `inFlight` Set so `stop()`
 * can drain cleanly on shutdown.
 *
 * Lifecycle:
 *   1. Envelope arrives on the runtime via NATS subscription (the
 *      listener also calls `runtime.subscribe(pattern)` at `start()`
 *      time per cortex#477 so its declared interest no longer relies
 *      on `nats.subjects[]` in `cortex.yaml` being a superset).
 *   2. `runtime.onEnvelope` fans to the registered handler, which
 *      filters by subject (`subjectMatches(pattern, subject)` against
 *      the listener's canonical Tasks-Domain pattern).
 *   3. Handler tracks the dispatch in `inFlight`, then invokes
 *      `handleDispatchEnvelope` (chain verify → policy gate →
 *      per-dispatch harness → publish lifecycle envelopes).
 *   4. The harness's contract guarantees: at least one terminal
 *      envelope (`completed` | `failed` | `aborted`) per dispatch,
 *      in order, on the same `correlation_id`.
 *   5. `stop()` unregisters the `onEnvelope` subscription, drains
 *      `runtime.subscribe` subscribers, and awaits in-flight
 *      dispatches via `Promise.allSettled`.
 *
 * **A.1b refactor history (cortex#113).** Before A.1b the listener
 * spawned `CCSession` directly and built lifecycle envelopes inline.
 * Now the listener owns *just* the envelope-to-request translation
 * and the publish loop; everything CC-specific lives in
 * `ClaudeCodeHarness`. The behavioural surface is unchanged — the
 * same four envelope types fire in the same order on the same
 * subjects with the same payloads — but the runner is now
 * substrate-agnostic at the code level. A future `BusPeerHarness`
 * slots in by switching which harness the listener constructs
 * per dispatch.
 *
 * **Boundaries:**
 *   - This file does NOT modify `dispatch-handler.ts`. The bus-driven
 *     path and the legacy direct-call path coexist.
 *   - This file does NOT modify `cc-session.ts` or `session-manager.ts`.
 *     The harness still wraps `CCSession` underneath; this file no
 *     longer imports it.
 *   - This file does NOT post to Discord. Surfaces (worklog-manager,
 *     dashboard via the bus) consume the lifecycle envelopes the
 *     runner emits and render their own way.
 */

import type { Envelope } from "../bus/myelin/envelope-validator";
import {
  getActorPrincipal,
  getSignedByChain,
  getFirstStampPrincipal,
  getTargetAssistant,
} from "../bus/myelin/envelope-validator";
import { encodeDidSegment } from "@the-metafactory/myelin/subjects";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import {
  emitFederationDenied,
  evaluateFederationGate,
  subjectMatches,
} from "../bus/surface-router";
import type { PolicyFederated, PolicyFederatedNetwork } from "../common/types/cortex-config";
import type {
  SystemAccessDeniedReason,
  SystemAccessSignedBy,
  SystemAccessSovereignty,
  SystemEventSource,
} from "../bus/system-events";
import {
  createSystemAccessAllowedEvent,
  createSystemAccessDeniedEvent,
  createSystemDispatchStageEvent,
  type SystemDispatchStage,
  type SystemDispatchStageOutcome,
} from "../bus/system-events";
import type {
  DispatchRequest,
  SessionHarness,
} from "../common/substrates/types";
import type { PolicyEngine } from "../common/policy/engine";
import { extractAgentIdFromDid } from "../common/policy/did";
import { isUuid } from "../common/types/uuid";
import { LETTER_PREFIX_ID_REGEX } from "../common/types/id";
import type {
  Intent,
  PolicyDenyReason,
  Principal,
} from "../common/policy/types";
import {
  createDispatchTaskFailedEvent,
  type ResponseRouting,
} from "../bus/dispatch-events";
import type { TrustResolver } from "../common/agents/trust-resolver";
import {
  verifySignedByChain,
  type ChainRejectionReason,
  type ChainVerificationResult,
} from "../bus/verify-signed-by-chain";
import {
  ClaudeCodeHarness,
  type CCSessionFactory as ClaudeCodeFactory,
} from "../substrates/claude-code/harness";
import {
  AgentTeamHarness,
  type AgentTeamFactory,
} from "./agent-team";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Factory for building a CC session from envelope-derived options.
 *
 * **A.1b note.** The listener no longer constructs `CCSession` directly —
 * it instantiates a `ClaudeCodeHarness` which in turn uses this factory
 * (via `ClaudeCodeHarnessOpts.ccSessionFactory`). The factory type is
 * re-exported from the harness module so existing tests
 * (`__tests__/dispatch-listener.test.ts`) keep compiling unchanged.
 *
 * Real impl: `(opts) => new CCSession(opts)`. Tests inject a fake.
 */
export type CCSessionFactory = ClaudeCodeFactory;

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
/**
 * **Known asymmetry vs. DispatchRequest / DispatchRuntime (Echo cortex#127 items 2 + 3).**
 *
 * The in-process dispatch contract carries typed knobs that this bus
 * payload intentionally does not yet surface:
 *
 *   - `DispatchRequest.inactivityMs` (top-level, alongside `timeoutMs`) —
 *     no corresponding `inactivity_ms` here.
 *   - `DispatchRuntime.bashAllowlist` / `DispatchRuntime.bashGuardDisabled` —
 *     no corresponding `bash_allowlist` / `bash_guard_disabled` here.
 *
 * Adapter-direct (non-bus) dispatches can populate these in-process
 * fields; bus-mediated dispatches today pick up the harness/dispatch-handler
 * defaults. Plumbing them through is future-facing work — natural fit for
 * the next payload-schema revision (Phase A.5+ stack identity expansion or
 * a dedicated payload-versioning PR).
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
  principal?: string;
  /**
   * cortex#491 — **Response routing** (CONTEXT.md §Response-routing): the
   * originating surface address `{ adapter_instance, channel_id,
   * thread_id? }`. Populated by a platform-adapter dispatch source so the
   * runner can ECHO it onto every `dispatch.task.{action}` lifecycle
   * envelope; the originating **dispatch sink** then delivers the reply to
   * the right channel/thread without keeping inbound state. Omitted for
   * dispatch sources with no platform reply surface (bus-peer, Offer).
   */
  response_routing?: ResponseRouting;
}

export interface DispatchListenerOptions {
  /**
   * MyelinRuntime — used to subscribe (via `onEnvelope` + `subscribe`)
   * and to publish lifecycle events back onto the bus.
   *
   * cortex#484 Option D: the listener no longer takes a `SurfaceRouter`
   * — it consumes envelopes directly from the runtime rather than
   * registering as a SurfaceAdapter. See file-header docblock for the
   * executor-vs-renderer rationale.
   */
  runtime: MyelinRuntime;
  /** Source identity for the lifecycle envelopes the listener emits. */
  source: SystemEventSource;
  /**
   * Principal stack segment (IAW Phase A.5, cortex#267) used to build the
   * subscription subject and the audit-envelope `dispatch.task.received`
   * synthesis path. When supplied, both subjects land on the 6-segment
   * stack-aware grammar `local.{principal}.{stack}.dispatch.task.received`
   * matching sage's emit-side post-IAW A.5. When omitted, the legacy
   * 5-segment form is used — bit-identical to pre-cortex#267 output, so
   * deployments without a `cortex.yaml stack:` block see no change.
   *
   * Production callers source this from `deriveStackId(loadedConfig).stack`
   * — same value `MyelinRuntime.publish` receives post-cortex#262.
   */
  stack?: string;
  /**
   * Subject pattern(s) to subscribe to. When omitted, the listener
   * derives the default from `source.principal` + optional `stack` per
   * the IAW A.5 grammar. Tests can override with broader patterns
   * (`local.test.dispatch.task.received`).
   */
  subjects?: string[];
  /**
   * Optional CC session factory. Default constructs a real `CCSession`.
   * Tests pass a fake to drive lifecycles without spawning processes.
   */
  ccSessionFactory?: CCSessionFactory;
  /**
   * Optional AgentTeam factory for delegate-mode dispatches. Production
   * omits this; tests inject a fake to prove routing without spawning
   * moderator/participant CC sessions.
   */
  agentTeamFactory?: AgentTeamFactory;
  /**
   * Listener id for log prefixes (stderr lines, future audit envelopes
   * tagged with which listener emitted them). Defaults to
   * `runner-dispatch-listener`. Configurable so multiple runner instances
   * (a future principal-controlled fleet) can disambiguate.
   *
   * Pre-cortex#484 this was the `SurfaceAdapter.id` used by the
   * surface-router; the listener no longer registers as a SurfaceAdapter
   * (Option D), but the field is preserved for log-line continuity and
   * future audit-envelope source-tagging.
   */
  adapterId?: string;
  /**
   * cortex#484 — optional federation gate config. When supplied AND the
   * listener subscribes to a `federated.*` subject, every inbound
   * `federated.{network_id}.>` envelope is gated against the declared
   * network's `accept_subjects` / `deny_subjects` lists + `max_hop`
   * budget BEFORE chain verification, policy gating, or harness
   * dispatch — mirror of the surface-router's D.2 gate.
   *
   * Why the runner needs its own gate post-Option D: pre-#484 the
   * runner registered as a SurfaceAdapter and the surface-router's
   * federation gate covered it. Option D drops that registration —
   * the runner now consumes envelopes directly off the runtime, so any
   * federation policy that should apply to the runner's subscription
   * path must be enforced here. Production wiring subscribes the runner
   * to `local.*` only (federation never applies); tests and principals
   * who explicitly subscribe the runner to `federated.*` MUST pass
   * `federated` so the deny / accept lists still gate.
   *
   * When omitted, no federation gating runs on the runner's path. The
   * surface-router's gate (configured in `cortex.ts`) continues to
   * enforce policy for other adapters (Discord, dashboard renderers).
   */
  federated?: PolicyFederated;
  /**
   * IAW Phase C.3.1 — optional PolicyEngine gate. When present, every
   * inbound `dispatch.task.received` envelope passes through
   * `engine.check(principalId, intent)` before reaching a substrate
   * harness. A deny short-circuits the dispatch (`harness.dispatch`
   * is never called) and logs to stderr; C.4 will additionally emit
   * a `system.access.denied` audit envelope here.
   *
   * When the option is `undefined` the listener falls back to the
   * pre-C.3 path: every envelope reaches a harness. This preserves
   * the legacy single-principal/dev-mode boot (no `policy:` block in
   * cortex.yaml → `policyEngineFromConfig` returns `undefined` →
   * passed through verbatim here).
   */
  policyEngine?: PolicyEngine;
  /**
   * IAW Phase B wiring (cortex#320 / v2.0.2) — when supplied, every
   * inbound `dispatch.task.received` envelope is run through
   * `verifySignedByChain` before its principal is resolved or the
   * `PolicyEngine` is consulted. A failed chain short-circuits the
   * dispatch with a `system.access.denied` + `dispatch.task.failed`
   * pair and never reaches the policy gate or a harness.
   *
   * When `undefined` the verifier is skipped entirely — preserves
   * the legacy path for tests that don't care about chain trust.
   * Production wiring in `cortex.ts` always supplies it.
   */
  trustResolver?: TrustResolver;
  /**
   * When `true` (default, v2.0.2), the chain verifier runs both the
   * structural trust check AND myelin's ed25519 verification over
   * the JCS-canonical envelope bytes. Principals with `signed_by[]`
   * peers on the bus need `nkey_pub` declared on those principals
   * for the crypto layer to admit them.
   *
   * When `false`, only the structural check runs (legacy / opt-out).
   *
   * **Note on the default.** Adapter-originated dispatches
   * (Discord/Mattermost/Slack/cc-events) arrive with an empty
   * `signed_by[]` and fall through cleanly thanks to
   * `rejectEmpty: false`. `cryptoVerify: true` therefore costs
   * nothing for legitimate adapter traffic and closes the spoof
   * vector for any signed bus-to-runner envelope.
   */
  cryptoVerify?: boolean;
  /**
   * Principal id (e.g. `andreas`). Required by `verifySignedByChain`'s
   * crypto layer (when `cryptoVerify: true`) to thread into each
   * constructed myelin Principal. When the verifier is enabled in
   * the default `cryptoVerify: true` mode AND any envelope arrives
   * with a non-empty chain, `principalId` must be supplied or
   * verification throws.
   */
  principalId?: string;
  /**
   * Agent id of the receiving side — whose `trust:` list governs
   * which peer signers we admit on inbound dispatches. Mirrors
   * `BusDispatchListenerOpts.receivingAgentId`; production wiring
   * picks the first registered agent (single-agent stacks) or the
   * designated peer-router agent (future multi-agent stacks).
   *
   * When `trustResolver` is supplied this field is required —
   * verification is skipped if either is omitted (defensive: tests
   * that supply only one configure deliberately incomplete state).
   */
  receivingAgentId?: string;
  /**
   * cortex#480 — the receiving stack's signing DID (e.g.
   * `did:mf:andreas-meta-factory`). Threaded through to
   * `verifySignedByChain` so adapter-originated dispatches signed by
   * the stack identity short-circuit the agent-registry membership
   * check (the stack is the receiver, not an agent in the registry).
   */
  stackIdentity?: string;
  /**
   * cortex#480 — the receiving stack's NKey public key. Required
   * alongside `stackIdentity` when `cryptoVerify: true` (the
   * production default) so the bytes-check has a registered
   * Principal to verify against.
   */
  stackNKeyPub?: string;
  /**
   * cortex#492 — dispatch-stage tracing toggle. When `true`, the
   * inbound path emits a `system.dispatch.stage` envelope (via
   * `runtime.publish`) AND a structured stderr line at each pipeline
   * stage, so a stall / silent-return between `received` and
   * `dispatch.task.started` is observable (the cortex#491 gap).
   *
   * When `undefined` (the default), the flag is read from the
   * `CORTEX_TRACE_DISPATCH` env var (`"1"` / `"true"` → on). Off by
   * default → zero overhead, no new log lines, no extra envelopes.
   *
   * Tests pass `true` explicitly to exercise the trace path without
   * touching `process.env`; a future `tracing:` config block in
   * cortex.yaml can set it from parsed config.
   */
  traceDispatch?: boolean;
}

export interface DispatchListener {
  /**
   * Resolved subject patterns this listener subscribes to. Exposed
   * primarily for testing — production callers don't read this because
   * `start()` wires everything via the runtime. Tests assert on the
   * canonical Tasks-Domain pattern that `start()` will hand to
   * `runtime.subscribe()` + the inline `onEnvelope` filter.
   *
   * Pre-cortex#484 this lived on `surfaceConfig.subjects`; Option D
   * drops the `SurfaceAdapter` surface but preserves the testable
   * accessor under a direct property so existing test shape stays
   * largely intact (sub-property rename only).
   */
  readonly subjects: readonly string[];
  /**
   * Listener id (matches `adapterId` opt). Carried on stderr log
   * prefixes so multi-runner deployments can disambiguate. Mirrors
   * the pre-#484 `surfaceConfig.id` field.
   */
  readonly id: string;
  /** Wire up `onEnvelope` + `subscribe`. Idempotent. */
  start(): Promise<void>;
  /**
   * Unregister and drain in-flight dispatches. Idempotent. Awaits
   * `Promise.allSettled` over every in-flight CC session so callers
   * that need a clean cutoff (test teardown, shutdown sequences) can
   * trust no late publish side effects land afterwards. Mirrors
   * `BusDispatchListener.stop()`.
   */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Build the canonical `dispatch.task.received` subject for `{principal}`
 * (+ optional `{stack}`). Used by both `defaultSubjects` (subscribe-side)
 * and the audit-envelope fallback in `handleDispatchEnvelope`
 * (synthesised when an inbound envelope arrived without a wire
 * subject). Single source of truth so the next subject-shape change
 * (e.g. cortex#264 underscore-regex resolution) updates both paths in
 * lockstep — cortex#276 Maintainability finding cycle 2.
 *
 * IAW Phase A.5 (cortex#267): emits the 6-segment stack-aware grammar
 * when `stack` is supplied; falls through to the legacy 5-segment form
 * for backward compatibility with pre-A.5 deployments.
 */
function dispatchReceivedSubject(principal: string, stack?: string): string {
  if (stack === undefined) {
    return `local.${principal}.dispatch.task.received`;
  }
  return `local.${principal}.${stack}.dispatch.task.received`;
}

/**
 * Direction A Stage 4 (#409) — canonical Tasks Domain subscription pattern.
 *
 * Per `myelin/specs/namespace.md` §Tasks Domain and cortex/CONTEXT.md (post
 * cortex#414), Direct/Delegate inbound dispatches publish onto
 * `local.{principal}.{stack}.tasks.@{did-encoded-assistant}.{capability}`.
 * The router uses NATS-style whole-token wildcards, so the subscribe-side
 * pattern is `tasks.*.>`: `*` matches the entire `@did-encoded-assistant`
 * segment and `>` matches any capability subtree (`chat`, `code-review`,
 * `release`, etc.).
 *
 * The listener subscribes to this PATTERN once per stack (via
 * `runtime.subscribe`) and filters incoming `onEnvelope` fan-outs via
 * `subjectMatches`; matching envelopes flow into `handleDispatchEnvelope`
 * for chain verification, policy gating, and per-dispatch harness
 * spawn. Legacy subjects can still be supplied explicitly through
 * `subjects` for old tests/config, but production defaults are
 * canonical-only.
 */
function canonicalTasksDirectSubject(principal: string, stack?: string): string {
  if (stack === undefined) {
    return `local.${principal}.tasks.*.>`;
  }
  return `local.${principal}.${stack}.tasks.*.>`;
}

/**
 * Default subject(s) for the runner's bus subscription. The `{principal}`
 * segment is substituted at registration time using `source.principal` so a
 * misconfigured runner with no principal id can still subscribe (it'll match
 * nothing unless someone publishes under `local.default.…`).
 *
 * Direction A Stage 4-B — canonical Tasks Domain dispatch is now the
 * default subscription. Tests and explicit principal overrides can still
 * pass `subjects` for legacy/federated fixtures, but production defaults
 * no longer subscribe to the pre-spec `dispatch.task.received` subject.
 */
function defaultSubjects(principal: string, stack?: string): string[] {
  return [canonicalTasksDirectSubject(principal, stack)];
}

/**
 * cortex#492 — read the dispatch-trace toggle from the environment.
 * `CORTEX_TRACE_DISPATCH=1` (or `true`, case-insensitive) turns tracing
 * on; anything else (including unset) leaves it off. Centralised so the
 * env-var contract lives in one place and the listener / handler read
 * the same parse.
 */
function traceDispatchEnabledFromEnv(): boolean {
  const raw = process.env.CORTEX_TRACE_DISPATCH;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * cortex#492 — the per-dispatch trace context. Mutates nothing; carries
 * the stable correlation/task keys + the latest known subject/agent so
 * each `trace()` call doesn't have to re-thread them.
 */
interface DispatchTraceContext {
  correlationId: string;
  taskId: string;
  subject?: string;
  agentId?: string;
}

/**
 * cortex#492 — derive a best-effort trace context from a raw inbound
 * envelope BEFORE the payload is validated. Used by the `onEnvelope`
 * pre-parse stages (`received`, `subject-matched`, `subject-rejected`,
 * `federation-gated`) where the trusted `DispatchTaskReceivedPayload`
 * isn't available yet.
 *
 * `correlationId` / `taskId` fall back to `envelope.correlation_id` then
 * `envelope.id` so the trace always carries a non-empty join key.
 * `agentId` is an untrusted peek at `payload.agent_id` — purely for the
 * trace's human-facing detail; the authoritative agent id is resolved by
 * the verified parse downstream.
 */
function rawEnvelopeTraceContext(
  envelope: Envelope,
  subject: string | undefined,
): DispatchTraceContext {
  const join = envelope.correlation_id ?? envelope.id;
  const payload = envelope.payload as
    | Partial<DispatchTaskReceivedPayload>
    | undefined;
  const taskId =
    typeof payload?.task_id === "string" ? payload.task_id : join;
  const agentId =
    typeof payload?.agent_id === "string" ? payload.agent_id : undefined;
  return {
    correlationId: join,
    taskId,
    ...(subject !== undefined && { subject }),
    ...(agentId !== undefined && { agentId }),
  };
}

/**
 * cortex#492 — emit a single dispatch-stage trace.
 *
 * **The stderr leg is primary and load-bearing.** It is written
 * SYNCHRONOUSLY, and every call site places it BEFORE the `await` it
 * brackets. This is the whole point: the motivating bug (cortex#491) was
 * a SILENT executor stall where an `await` (chain verification or a bus
 * publish) never resolved — so the trace must already be in the log
 * before that await is entered. If the next await hangs, the principal
 * still sees exactly how far the dispatch got.
 *
 * **The envelope leg is the nice-to-have.** When the runtime can publish,
 * a `system.dispatch.stage` envelope is emitted fire-and-forget so signal
 * + the MC dashboard can join the trace on `correlation_id` (signal's
 * ingestion join key ≡ the envelope `correlation_id` ≡ W3C trace_id).
 * The publish is NEVER awaited (publish may be the thing that hangs) and
 * a rejection is swallowed-and-logged to stderr — it must never block or
 * throw into the dispatch.
 *
 * **Gated:** when `enabled` is `false` this is a hard no-op — no line, no
 * envelope, no allocation beyond the call. The default configuration
 * (`CORTEX_TRACE_DISPATCH` unset) leaves it off → zero overhead.
 */
function trace(
  enabled: boolean,
  runtime: MyelinRuntime,
  source: SystemEventSource,
  stage: SystemDispatchStage,
  outcome: SystemDispatchStageOutcome,
  ctx: DispatchTraceContext,
  detail?: string,
): void {
  if (!enabled) return;
  // ---- PRIMARY LEG: synchronous, hang-proof stderr line. ----
  // Anchored on correlation_id (signal/VictoriaLogs join key). Written
  // first and unconditionally so a hang in the NEXT await still leaves
  // this stage in the log.
  process.stderr.write(
    `cortex-trace: stage=${stage} outcome=${outcome} ` +
      `correlation_id=${ctx.correlationId} task_id=${ctx.taskId}` +
      ` agent_id=${ctx.agentId ?? "<unknown>"}` +
      ` subject=${ctx.subject ?? "<none>"}` +
      (detail !== undefined ? ` detail=${detail}` : "") +
      "\n",
  );
  // ---- SECONDARY LEG: fire-and-forget envelope. Must never block or ----
  // ---- throw into the dispatch (swallow-and-stderr per no-empty-catch). ----
  try {
    const env = createSystemDispatchStageEvent({
      source,
      correlationId: ctx.correlationId,
      taskId: ctx.taskId,
      stage,
      outcome,
      ...(ctx.subject !== undefined && { subject: ctx.subject }),
      ...(ctx.agentId !== undefined && { agentId: ctx.agentId }),
      ...(detail !== undefined && { detail }),
    });
    // Do NOT await — publish may be the stall. A rejected promise is
    // logged (not swallowed) so a broken envelope leg surfaces without
    // blocking or crashing the dispatch.
    void runtime.publish(env).catch((err: unknown) => {
      process.stderr.write(
        `cortex-trace: envelope publish failed for stage=${stage} ` +
          `correlation_id=${ctx.correlationId}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  } catch (err) {
    // Synchronous failure (envelope build, etc.). Log per no-empty-catch;
    // never re-throw into the dispatch. The primary stderr leg above has
    // already landed, so the trace is not lost.
    process.stderr.write(
      `cortex-trace: envelope emit threw for stage=${stage} ` +
        `correlation_id=${ctx.correlationId}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

export function createDispatchListener(
  opts: DispatchListenerOptions,
): DispatchListener {
  const {
    runtime,
    source,
    ccSessionFactory,
    agentTeamFactory,
    policyEngine,
    trustResolver,
    receivingAgentId,
    principalId,
    stackIdentity,
    stackNKeyPub,
    adapterId = "runner-dispatch-listener",
  } = opts;
  // v2.0.2 default: structural trust + ed25519 crypto verification.
  // Adapter-originated dispatches arrive with empty `signed_by[]` and
  // fall through `rejectEmpty: false`; signed bus traffic MUST verify.
  const cryptoVerify = opts.cryptoVerify ?? true;
  // cortex#492 — resolve the trace toggle once at construction: explicit
  // option wins, else fall back to the `CORTEX_TRACE_DISPATCH` env var.
  // Off by default → the trace helper short-circuits to a no-op.
  const traceDispatch = opts.traceDispatch ?? traceDispatchEnabledFromEnv();
  const subjects = opts.subjects ?? defaultSubjects(source.principal, opts.stack);

  // cortex#484 — federation gate config (Option D). Index networks by id
  // for O(1) prefix lookup on each inbound envelope. Empty map (or
  // undefined `federated` opt) means "no federation gating on this
  // listener" — matches the surface-router's pre-#484 inert-gate
  // semantics. The map is built once at construction time; reloads
  // require reconstructing the listener (same contract the
  // surface-router has for federation reloads).
  const federatedNetworksById = new Map<string, PolicyFederatedNetwork>();
  for (const network of opts.federated?.networks ?? []) {
    federatedNetworksById.set(network.id, network);
  }

  // cortex#484 Option D — `onEnvelope` registration handle. The
  // runner consumes envelopes directly from the runtime rather than
  // registering as a SurfaceAdapter (which would put it under the
  // surface-router's 5s render-timeout — see file-header docblock).
  let envelopeRegistration: { unregister: () => void } | null = null;
  // cortex#477 — push-mode NATS subscriptions owned by this listener.
  // The listener self-subscribes via `runtime.subscribe(pattern)` at
  // `start()` time so its declared interest no longer depends on
  // `nats.subjects[]` in `cortex.yaml` being a superset of the
  // canonical Tasks-Domain pattern. Stored so `stop()` can drain the
  // subscribers cleanly on teardown even when the runtime stays
  // running.
  interface RuntimeSubscriber { stop(): Promise<void>; }
  let runtimeSubscribers: RuntimeSubscriber[] = [];
  // cortex#484 — in-flight dispatches tracked here so `stop()` can
  // drain via `Promise.allSettled`. Mirrors
  // `BusDispatchListener.inFlight` — each inbound runs in its own
  // microtask chain (no serial queue), and `stop()` awaits drain
  // before returning so test teardown / shutdown sequences see a
  // clean cutoff.
  const inFlight = new Set<Promise<void>>();

  /**
   * Run one dispatch in its own microtask, catching its own errors
   * so the runtime's `onEnvelope` fan-out doesn't see a throw from
   * a slow / failing CC session. Returns the promise so the caller
   * can track it on `inFlight` for drain.
   */
  const runOneDispatch = async (
    envelope: Envelope,
    subject: string | undefined,
  ): Promise<void> => {
    try {
      await handleDispatchEnvelope(envelope, subject, {
        runtime,
        source,
        ccSessionFactory,
        agentTeamFactory,
        policyEngine,
        stack: opts.stack,
        trustResolver,
        cryptoVerify,
        principalId,
        receivingAgentId,
        stackIdentity,
        stackNKeyPub,
        traceDispatch,
      });
    } catch (err) {
      process.stderr.write(
        `[${adapterId}] handleDispatchEnvelope threw on envelope ` +
          `${envelope.id} (correlation_id=` +
          `${envelope.correlation_id ?? "<none>"}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };

  /**
   * Track an in-flight dispatch promise and remove it on settle.
   * Sibling helper that owns the bookkeeping — mirrors
   * `BusDispatchListener.trackInFlight`.
   */
  const trackInFlight = (dispatchPromise: Promise<void>): void => {
    inFlight.add(dispatchPromise);
    void dispatchPromise.finally(() => inFlight.delete(dispatchPromise));
  };

  /**
   * Subject filter — only envelopes whose wire subject matches one of
   * the listener's declared patterns are dispatched. NATS' wildcard
   * grammar (`*` whole-token, `>` multi-segment) is implemented by
   * the shared `subjectMatches` helper exported from `surface-router`,
   * so the runner sees exactly the same match semantics it had as a
   * SurfaceAdapter pre-#484.
   *
   * When `subject` is undefined (some test fakes don't carry one)
   * the filter falls through to "match" — preserves the pre-#484
   * behaviour where the SurfaceAdapter's subject array was only
   * consulted on subject-bearing envelopes. Defensive: a malformed
   * fake without a subject still reaches `handleDispatchEnvelope`
   * which has its own validation.
   */
  const matchesAnyDeclaredSubject = (subject: string | undefined): boolean => {
    if (subject === undefined) return true;
    for (const pattern of subjects) {
      if (subjectMatches(pattern, subject)) return true;
    }
    return false;
  };

  return {
    subjects,
    id: adapterId,
    async start() {
      if (envelopeRegistration) return;
      // cortex#484 Option D — register as an `onEnvelope` handler
      // directly on the runtime, symmetric with `BusDispatchListener`.
      // The handler filters by subject + dispatches in a tracked
      // microtask; no render-timeout wraps the CC session.
      envelopeRegistration = runtime.onEnvelope((envelope, subject) => {
        // cortex#492 — best-effort trace context from the raw envelope
        // before the payload is parsed. `task_id` falls back to the
        // correlation_id / envelope id; `agent_id` is a peek at the
        // payload (the trusted parse happens later in the handler).
        const traceCtx = rawEnvelopeTraceContext(envelope, subject);
        // `received` — the runtime fan-out reached this listener. This is
        // the FIRST observable point after `myelin-runtime: received
        // envelope`; pre-#492 nothing was emitted here.
        trace(traceDispatch, runtime, source, "received", "info", traceCtx);
        if (!matchesAnyDeclaredSubject(subject)) {
          // cortex#491's hidden gap — the silent `return` when the wire
          // subject matched NO declared pattern. Pre-#492 a dispatch that
          // landed here vanished with zero output between
          // `myelin-runtime: received envelope` and nothing. Now it's a
          // visible `subject-rejected` trace.
          trace(
            traceDispatch,
            runtime,
            source,
            "subject-rejected",
            "fail",
            traceCtx,
            `subject matched none of [${subjects.join(", ")}]`,
          );
          return;
        }
        trace(traceDispatch, runtime, source, "subject-matched", "pass", traceCtx);
        // cortex#484 — federation gate runs BEFORE chain verification
        // and policy gating, mirroring the surface-router's D.2 order:
        // an envelope that fails the network's accept/deny rules never
        // reaches the harness path (no `dispatch.task.*` lifecycle is
        // emitted). Gate engages only when the listener was given a
        // `federated.networks[]` block AND the inbound subject is in
        // the `federated.*` domain; subjects in the `local.*` /
        // `public.*` domains pass through untouched (the gate is
        // scoped to the federation domain by design, per D.2.1).
        if (
          federatedNetworksById.size > 0
          && subject.startsWith("federated.")
        ) {
          const decision = evaluateFederationGate(
            subject,
            envelope,
            federatedNetworksById,
          );
          if (decision !== "allow") {
            trace(
              traceDispatch,
              runtime,
              source,
              "federation-gated",
              "fail",
              traceCtx,
              decision.kind,
            );
            emitFederationDenied(runtime, source, envelope, subject, decision);
            return;
          }
          trace(
            traceDispatch,
            runtime,
            source,
            "federation-gated",
            "pass",
            traceCtx,
          );
        }
        trackInFlight(runOneDispatch(envelope, subject));
      });
      // cortex#477 — self-subscribe via `runtime.subscribe()` so the
      // runner's declared interest no longer depends on
      // `nats.subjects[]` in `cortex.yaml`. `subscribe` is OPTIONAL
      // on the `MyelinRuntime` interface (additivity constraint per
      // Architect cortex#290) — undefined means the runtime stub
      // doesn't model push subscriptions, and we stay dormant (same
      // contract as `subscribePull`). The returned subscriber may
      // also be `null` if the runtime is disabled (no NATS configured
      // / connect failed); that's a legitimate dormant state, not an
      // error.
      if (runtime.subscribe) {
        for (const pattern of subjects) {
          const sub = await runtime.subscribe(pattern);
          if (sub) {
            runtimeSubscribers.push(sub);
          }
        }
      }
    },
    async stop() {
      if (!envelopeRegistration) return;
      envelopeRegistration.unregister();
      envelopeRegistration = null;
      // Drain listener-owned runtime subscribers FIRST so no new
      // envelopes arrive while we wait for in-flight dispatches.
      const drained = runtimeSubscribers;
      runtimeSubscribers = [];
      await Promise.allSettled(drained.map((s) => s.stop()));
      // Then drain in-flight CC sessions. `allSettled` because each
      // dispatch already catches its own errors via `runOneDispatch`;
      // we just need the microtask chain to flush before returning so
      // callers awaiting `stop()` trust no late publish side effects
      // land afterwards. Mirrors `BusDispatchListener.stop()`.
      await Promise.allSettled(Array.from(inFlight));
    },
  };
}

// ---------------------------------------------------------------------------
// Internals — envelope → substrate dispatch → lifecycle emission
// ---------------------------------------------------------------------------

/**
 * Parse + validate a `dispatch.task.received` envelope payload.
 *
 * Returns `null` (not throws) on malformed payload — surfaces should
 * tolerate bad envelopes per the §3.3.4 ordering/dedupe guarantees. The
 * listener logs and returns; downstream consumers detect the malformed
 * envelope via the missing `dispatch.task.started` event
 * (a producer that emits `received` and never sees `started` knows
 * something went wrong).
 */
// cortex#196 — strict UUID v1-v5 check (`isUuid`) is now shared in
// `src/common/types/uuid.ts`; the local `UUID_RE` regex was inlined
// here pre-extraction.

function parsePayload(envelope: Envelope): DispatchTaskReceivedPayload | null {
  const p = envelope.payload as Partial<DispatchTaskReceivedPayload> | undefined;
  if (!p) return null;
  if (typeof p.task_id !== "string" || typeof p.agent_id !== "string") return null;
  if (typeof p.prompt !== "string" || p.prompt.length === 0) return null;
  // Per Echo's review (cortex#34): the envelope-level validator only checks
  // `envelope.id`'s shape, not `payload.task_id`. Without this gate, a
  // malformed publisher could slip a non-UUID `task_id` through to the
  // substrate harness + worklog-manager and break correlation across
  // `started` / `completed` / `failed` envelopes downstream. Reject at
  // parse time so no envelopes are published and no CC process is
  // spawned for a bad id.
  if (!isUuid(p.task_id)) {
    console.warn(
      `dispatch-listener: rejecting envelope ${envelope.id} — task_id missing or not UUID-shaped`,
    );
    return null;
  }
  return p as DispatchTaskReceivedPayload;
}

/**
 * Translate a parsed `DispatchTaskReceivedPayload` into the protocol-
 * level `DispatchRequest` the substrate harness consumes.
 *
 * **A.1b boundary.** This is the snake_case → camelCase translation layer
 * on the listener side. The harness consumes camelCase `DispatchRequest`
 * fields; the envelope payload uses snake_case per §3.4. The mapping is
 * a pure projection — no defaults, no policy decisions, no enrichment.
 *
 * **Why CC-runtime fields live on `req.runtime` and not the top level.**
 * `DispatchRequest` is the substrate-agnostic contract. Fields like
 * `cwd`, `bashAllowlist`, `groveChannel`, etc. are CC-specific. Putting
 * them under `runtime` means future harnesses (`bus-peer`, `cursor`, ...)
 * see a clean separation: dispatch-contract on top, substrate-specific
 * knobs in the `runtime` block. CC reads what it needs; others ignore.
 *
 * **assistant prompt file absence.** The legacy bus-driven path does NOT
 * carry assistant prompt-file data on the payload (prompt injection happens
 * at the dispatch-handler layer via the prompt-builder). We therefore omit
 * `persona` from the request — the harness handles `persona === undefined`
 * per the A.1b spec (optional field).
 */
function buildDispatchRequest(
  payload: DispatchTaskReceivedPayload,
  principal?: Principal,
): DispatchRequest {
  const tools: DispatchRequest["tools"] = {
    allow: payload.allowed_tools ?? [],
    ...(payload.disallowed_tools !== undefined && { deny: payload.disallowed_tools }),
  };

  // Build the runtime block lazily — only attach the field for keys the
  // payload actually carried. Keeps an explicit "empty payload" indis-
  // tinguishable from "payload with no runtime block" at the harness end.
  const runtime: NonNullable<DispatchRequest["runtime"]> = {};
  if (payload.cwd !== undefined) runtime.cwd = payload.cwd;
  if (payload.allowed_dirs !== undefined) runtime.allowedDirs = payload.allowed_dirs;
  if (payload.additional_args !== undefined) runtime.additionalArgs = payload.additional_args;
  if (payload.grove_channel !== undefined) runtime.groveChannel = payload.grove_channel;
  if (payload.grove_network !== undefined) runtime.groveNetwork = payload.grove_network;
  if (payload.resume_session_id !== undefined) runtime.resumeSessionId = payload.resume_session_id;
  const hasRuntime = Object.keys(runtime).length > 0;

  // Env-kind context block carries principal/entity/project labels.
  // Build it iff the payload supplied any of the three; the harness
  // surfaces them onto CCSessionOpts as before.
  const envContext: Record<string, unknown> = {};
  if (payload.principal !== undefined) envContext.principal = payload.principal;
  if (payload.entity !== undefined) envContext.entity = payload.entity;
  if (payload.project !== undefined) envContext.project = payload.project;
  const hasEnvContext = Object.keys(envContext).length > 0;

  const req: DispatchRequest = {
    prompt: payload.prompt,
    tools,
    context: hasEnvContext ? [{ kind: "env", data: envContext }] : [],
    agent: {
      id: payload.agent_id,
      displayName: payload.agent_name ?? payload.agent_id,
    },
    requestId: payload.task_id,
    ...(hasRuntime && { runtime }),
    ...(payload.timeout_ms !== undefined && { timeoutMs: payload.timeout_ms }),
    ...(principal !== undefined && { principal }),
  };

  return req;
}

/**
 * Core dispatch path: parse → chain-verify → policy-gate → instantiate
 * harness → iterate `harness.dispatch(req)` → publish each yielded
 * envelope. Returns `Promise<void>` and is tracked on the listener's
 * `inFlight` Set; `stop()` drains via `Promise.allSettled`.
 *
 * cortex#484 Option D — pre-#484 this was the SurfaceAdapter's
 * `render()` callback and ran under a 5s timeout. The listener now
 * wires it directly off `runtime.onEnvelope`, so the CC session's
 * own timers (harness-side `timeoutMs` / inactivity) govern lifetime
 * rather than the surface-router's renderer-oriented timeout.
 *
 * **Per-dispatch harness construction (Q7 lock-in).** Every received
 * envelope spawns a fresh `ClaudeCodeHarness` instance. The harness is
 * stateless beyond its in-flight session tracking, so this is cheap;
 * the alternative (a long-lived harness shared across dispatches) would
 * couple `shutdown` semantics across unrelated dispatches and is not
 * worth the savings for A.1b. Shared infrastructure (the CC factory)
 * is threaded through via constructor opts.
 */
/**
 * Per-dispatch wiring grouped into one shape so the handler signature
 * stays narrow (cortex#276 cycle 3 — Sage Maintainability suggestion).
 * Mutates nothing — pure dependency injection.
 */
interface DispatchHandlerContext {
  runtime: MyelinRuntime;
  source: SystemEventSource;
  ccSessionFactory: CCSessionFactory | undefined;
  agentTeamFactory: AgentTeamFactory | undefined;
  policyEngine: PolicyEngine | undefined;
  stack: string | undefined;
  /**
   * IAW Phase B wiring (cortex#320). When `trustResolver` and
   * `receivingAgentId` are both supplied, every inbound envelope is
   * chain-verified before principal resolution.
   */
  trustResolver: TrustResolver | undefined;
  cryptoVerify: boolean;
  principalId: string | undefined;
  receivingAgentId: string | undefined;
  /** cortex#480 — receiving stack's signing DID for own-stack trust. */
  stackIdentity: string | undefined;
  /** cortex#480 — receiving stack's NKey pubkey for crypto-verify pass. */
  stackNKeyPub: string | undefined;
  /**
   * cortex#492 — when `true`, emit a `system.dispatch.stage` trace at
   * each gate inside the handler. Resolved by `createDispatchListener`
   * from the explicit option or `CORTEX_TRACE_DISPATCH`; the handler
   * just reads it and passes it to `trace()`.
   */
  traceDispatch: boolean;
}

async function handleDispatchEnvelope(
  envelope: Envelope,
  subject: string | undefined,
  ctx: DispatchHandlerContext,
): Promise<void> {
  const {
    runtime,
    source,
    ccSessionFactory,
    agentTeamFactory,
    policyEngine,
    stack,
    trustResolver,
    cryptoVerify,
    principalId,
    receivingAgentId,
    stackIdentity,
    stackNKeyPub,
    traceDispatch,
  } = ctx;
  // cortex#492 — pre-parse trace context. Refined to the trusted payload
  // fields (`task_id`, `agent_id`) once the parse succeeds.
  let traceCtx = rawEnvelopeTraceContext(envelope, subject);
  const payload = parsePayload(envelope);
  if (!payload) {
    trace(
      traceDispatch,
      runtime,
      source,
      "malformed",
      "fail",
      traceCtx,
      "required fields missing or task_id not UUID-shaped",
    );
    console.error(
      `cortex-runner: dispatch-listener: malformed dispatch.task.received envelope id=${envelope.id} — required fields missing`,
    );
    return;
  }
  // Refine the trace context with the trusted parsed fields.
  traceCtx = {
    correlationId: envelope.correlation_id ?? payload.task_id,
    taskId: payload.task_id,
    agentId: payload.agent_id,
    ...(subject !== undefined && { subject }),
  };
  trace(traceDispatch, runtime, source, "parsed", "pass", traceCtx);

  const recipientMismatch = validateCanonicalTaskRecipient(
    envelope,
    payload,
    subject,
  );
  if (recipientMismatch !== null) {
    trace(
      traceDispatch,
      runtime,
      source,
      "recipient-mismatch",
      "fail",
      traceCtx,
      recipientMismatch,
    );
    process.stderr.write(
      `[runner/dispatch-listener] dropped envelope ${envelope.id} ` +
        `(correlation_id=${envelope.correlation_id ?? "<none>"} ` +
        `task_id=${payload.task_id} agent=${payload.agent_id}): ` +
        `${recipientMismatch}\n`,
    );
    await emitCanonicalRecipientMismatch(
      runtime,
      source,
      envelope,
      payload,
      recipientMismatch,
    );
    return;
  }
  trace(
    traceDispatch,
    runtime,
    source,
    "recipient-validated",
    "pass",
    traceCtx,
  );

  // IAW Phase B wiring (cortex#320, v2.0.2) — verify the envelope's
  // `signed_by[]` chain BEFORE resolving the principal. The runner used
  // to read `signed_by[0].identity` at face value (cortex#220 round 1's
  // "authorization-without-authentication" gap; the field was named
  // `principal` pre-myelin#184). Now we structurally
  // trust-check every ed25519 stamp and, by default, also cryptographically
  // verify each stamp's signature over the JCS-canonical envelope bytes.
  //
  // **`rejectEmpty: false`** — adapter-originated dispatches
  // (Discord/Mattermost/Slack/cc-events) arrive with no `signed_by[]`.
  // Empty chains are legitimate and fall through to the existing
  // PolicyEngine path; only signed chains must verify.
  //
  // **Fail-closed when `trustResolver` is wired but `receivingAgentId`
  // is not.** PR #322 round-1 caught this: `cortex.ts:mergedAgents` is
  // empty when the principal's config declares no agents (or when an
  // intermediate boot stage hasn't populated yet), `receivingAgentId`
  // becomes `undefined`, and the prior bypass-branch silently skipped
  // verification while the boot log claimed `signed_by chain verified`
  // — re-opening exactly the cortex#220 round-1 gap this PR was
  // supposed to close. The bus-side `BusDispatchListener` already
  // guards this state by refusing to construct without a
  // `receivingAgentId`; the runner-side equivalent is this fail-closed
  // deny inside the handler so the contract is enforced regardless
  // of caller wiring.
  if (trustResolver !== undefined && receivingAgentId === undefined) {
    trace(
      traceDispatch,
      runtime,
      source,
      "chain-rejected",
      "fail",
      traceCtx,
      "receiving_agent_unconfigured",
    );
    process.stderr.write(
      `[runner/dispatch-listener] receivingAgentId not configured — denying ` +
        `envelope ${envelope.id} (correlation_id=` +
        `${envelope.correlation_id ?? "<none>"}): trustResolver wired but ` +
        `no local agent identity available for chain verification\n`,
    );
    await emitReceivingAgentUnconfiguredDeny(
      runtime,
      source,
      envelope,
      payload,
      subject,
      stack,
    );
    return;
  }

  // When `trustResolver` is undefined (deployment hasn't wired one —
  // tests or pre-v2.0.2 configs), skip verification entirely. This is
  // the only legitimate skip path; production wiring in `cortex.ts`
  // always supplies `trustResolver`.
  if (trustResolver !== undefined && receivingAgentId !== undefined) {
    let verification: ChainVerificationResult;
    // cortex#492 — emitted SYNCHRONOUSLY before the verify await. This is
    // a prime stall suspect: a hang inside `verifySignedByChain` (crypto,
    // resolver I/O) leaves `chain-verify-start` in the log with no matching
    // `chain-verified` / `chain-rejected` — pinpointing the stall.
    trace(
      traceDispatch,
      runtime,
      source,
      "chain-verify-start",
      "info",
      traceCtx,
    );
    try {
      verification = await verifySignedByChain(envelope, {
        resolver: trustResolver,
        receivingAgentId,
        rejectEmpty: false,
        cryptoVerify,
        ...(cryptoVerify && principalId !== undefined && { principalId }),
        // cortex#480 — own-stack trust short-circuit + crypto registry
        // entry for self-signed adapter-originated dispatches.
        ...(stackIdentity !== undefined && { stackIdentity }),
        ...(stackNKeyPub !== undefined && { stackNKeyPub }),
      });
    } catch (err) {
      // `verifySignedByChain` throws when `cryptoVerify: true` and
      // `principalId` is missing on a non-empty chain. Treat as a
      // verification failure (deny + log) so the runner doesn't crash.
      const detail = err instanceof Error ? err.message : String(err);
      trace(
        traceDispatch,
        runtime,
        source,
        "chain-rejected",
        "fail",
        traceCtx,
        `crypto_verify_failed: ${detail}`,
      );
      process.stderr.write(
        `[runner/dispatch-listener] chain verification threw on ` +
          `envelope ${envelope.id} (correlation_id=` +
          `${envelope.correlation_id ?? "<none>"}): ${detail}\n`,
      );
      await emitChainVerificationDeny(
        runtime,
        source,
        envelope,
        payload,
        subject,
        stack,
        { kind: "crypto_verify_failed", myelinReason: detail },
      );
      return;
    }

    if (!verification.valid) {
      trace(
        traceDispatch,
        runtime,
        source,
        "chain-rejected",
        "fail",
        traceCtx,
        `${verification.reason.kind} at chain index ${verification.rejectedAt}`,
      );
      process.stderr.write(
        `[runner/dispatch-listener] dropped envelope ${envelope.id} ` +
          `(correlation_id=${envelope.correlation_id ?? "<none>"} ` +
          `task_id=${payload.task_id} agent=${payload.agent_id}): ` +
          `${verification.reason.kind} at chain index ` +
          `${verification.rejectedAt}\n`,
      );
      await emitChainVerificationDeny(
        runtime,
        source,
        envelope,
        payload,
        subject,
        stack,
        verification.reason,
      );
      return;
    }
    trace(
      traceDispatch,
      runtime,
      source,
      "chain-verified",
      "pass",
      traceCtx,
    );
  }

  // IAW Phase C.3.1 — policy gate. The engine resolves the originating
  // principal from `envelope.signed_by[0]` (the first stamp is the
  // originator per myelin#31 chain ordering; hub-stamps later in the
  // chain re-attest but don't replace origin). The capability claim is
  // a placeholder `dispatch.<agent_id>` derived from the dispatch
  // target — until cortex#237's review-consumer surface carries an
  // explicit capability tag on the payload, the dispatch surface is
  // "may principal X invoke agent Y on this stack?". Sovereignty flows
  // through verbatim so audit envelopes (C.4) carry the same
  // constraints the engine saw.
  //
  // v2.0.0 (cortex#297) + v2.0.1 (cortex#311): the schema requires a
  // `policy:` block at boot, AND `cortex.ts` no longer re-binds the
  // engine to undefined via env-var ack. So `policyEngine` here is
  // undefined ONLY when the principal declared `policy: { principals: [] }`
  // — an explicit "no auth surface" deployment. We fail closed in that
  // case: deny every dispatch with a clear reason so audit consumers
  // see the misconfiguration immediately rather than every dispatch
  // succeeding silently.
  //
  // IAW Phase D.3 — derive `source_network` from the matched
  // subject when the envelope arrived via `federated.{id}.>`. Local
  // dispatches (subjects like `local.{principal}.dispatch.task.received`)
  // leave it `undefined` so the engine skips the federation branch.
  const sourceNetwork = extractSourceNetwork(subject);
  let gatedPrincipal: Principal | undefined;
  if (policyEngine === undefined) {
    // v2.0.1 (cortex#311): fail-closed when policy engine is unavailable.
    // In v2.0.0+ this only happens when principal declared empty
    // principals[]; cortex.ts has already emitted a boot warning, so we
    // just deny + emit a terminal failure for any dispatch that arrives.
    trace(
      traceDispatch,
      runtime,
      source,
      "policy-decision",
      "fail",
      traceCtx,
      "policy_engine_uninitialised",
    );
    console.error(
      `cortex-runner: dispatch-listener: policy engine uninitialised (empty principals[]?) — denying envelope id=${envelope.id} task_id=${payload.task_id} agent=${payload.agent_id}`,
    );
    const now = new Date();
    const failed = createDispatchTaskFailedEvent({
      source,
      taskId: payload.task_id,
      agentId: payload.agent_id,
      startedAt: now,
      failedAt: now,
      errorSummary: "policy engine uninitialised — declare at least one principal in policy.principals[] to enable the authorisation gate",
      reason: {
        kind: "policy_denied",
        deny: {
          kind: "policy_engine_uninitialised",
          detail: "principal declared empty policy.principals[]; declare at least one principal to engage the authorisation gate",
        },
      },
    });
    await runtime.publish(failed);
    return;
  }

  {
    const decision = checkDispatchPolicy(
      policyEngine,
      envelope,
      payload,
      sourceNetwork,
    );
    // C.4.3 — carry `signed_by[]` from the originating envelope
    // verbatim so the audit record is cryptographically attributable
    // (even on deny). Normalised to an array via `getSignedByChain`;
    // empty for legacy unsigned envelopes.
    //
    // TODO(phase-D, Echo cortex#221 round 1): audit envelopes are
    // always emitted with `local` sovereignty via
    // `defaultSystemSovereignty` — the originating envelope's
    // classification rides on `payload.intent_sovereignty` only.
    // Once federated dispatch is gated by this same surface,
    // consumers subscribing to `federated.{principal}.system.access.>`
    // will miss federated denials. Decide then whether to (a)
    // mirror `intent_sovereignty.classification` onto the audit
    // envelope itself, (b) emit two envelopes (local + federated),
    // or (c) keep audit local-only and expose a federated audit
    // surface separately. Tracked here so the trade-off is visible.
    const signedBy: SystemAccessSignedBy[] = getSignedByChain(envelope).map(
      (stamp) => ({ ...stamp }),
    );
    const auditSovereignty: SystemAccessSovereignty = {
      classification: envelope.sovereignty.classification,
      data_residency: envelope.sovereignty.data_residency,
      max_hop: envelope.sovereignty.max_hop,
      frontier_ok: envelope.sovereignty.frontier_ok,
      model_class: envelope.sovereignty.model_class,
    };
    // IAW Phase D.3 — when the inbound envelope's subject was a real
    // wire subject (the runtime forwards it on `onEnvelope`), use
    // it verbatim on the audit envelope. The pre-D.3 path always
    // synthesised `local.{principal}.dispatch.task.received` regardless of
    // whether the envelope arrived locally or on `federated.{net}.*`.
    // Synthesising the local subject on federated traffic would
    // misrepresent the wire path on audit consumers. Fall back to the
    // synthesised local subject when `subject` is undefined (legacy
    // callers / unit tests that don't pass a subject).
    //
    // IAW Phase A.5 (cortex#267): the synthesised fallback honours the
    // principal's stack via the shared `dispatchReceivedSubject` helper —
    // single source of truth across the listener's subscribe-side
    // default AND this audit-envelope synthesis path (cortex#276
    // Maintainability finding cycle 2).
    const auditEnvelopeSubject = subject ?? dispatchReceivedSubject(source.principal, stack);
    const auditCommon = {
      source,
      principalId: decision.principalId,
      capability: decision.capability,
      sovereignty: auditSovereignty,
      correlationId: envelope.correlation_id ?? payload.task_id,
      envelopeId: envelope.id,
      envelopeSubject: auditEnvelopeSubject,
      signedBy,
    };

    if (!decision.allow) {
      trace(
        traceDispatch,
        runtime,
        source,
        "policy-decision",
        "fail",
        traceCtx,
        decision.reason.kind,
      );
      console.error(
        `cortex-runner: dispatch-listener: denied envelope id=${envelope.id} task_id=${payload.task_id} agent=${payload.agent_id} — reason=${decision.reason.kind}${
          sourceNetwork !== undefined ? ` source_network=${sourceNetwork}` : ""
        }`,
      );
      // C.4.2 / D.3.2 — emit `system.access.denied` carrying the
      // structured engine deny reason + signed_by chain. Lives on a
      // different subject than the dispatch.task.* lifecycle so audit
      // consumers (dashboard, pipeline) get a stable wire path. The
      // `source_network` enrichment is delegated to `enrichDenyReason`
      // so the cast that bridges `PolicyDenyReason` (tight discriminated
      // union) → `SystemAccessDeniedReason` (`[k: string]: unknown`
      // open record) lives in one localised helper rather than on the
      // dispatch path (Echo cortex#227 round 1).
      const denied = createSystemAccessDeniedEvent({
        ...auditCommon,
        reason: enrichDenyReason(decision.reason, sourceNetwork),
      });
      await runtime.publish(denied);
      // Echo cortex#220 round 2 M-1 — also synthesise a terminal
      // `dispatch.task.failed` so subscribers correlating on
      // task_id (worklog-manager.ts, agent-team.ts) see a terminal
      // lifecycle event. Both envelopes are emitted on a denied
      // dispatch: one on system.access.* (audit), one on
      // dispatch.task.* (lifecycle).
      const now = new Date();
      const failed = createDispatchTaskFailedEvent({
        source,
        taskId: payload.task_id,
        agentId: payload.agent_id,
        startedAt: now,
        failedAt: now,
        errorSummary: `policy gate denied dispatch: ${decision.reason.kind}`,
        reason: {
          kind: "policy_denied",
          deny: { ...decision.reason },
        },
      });
      await runtime.publish(failed);
      return;
    }
    // C.4.1 — emit `system.access.allowed` for every accepted
    // dispatch. The audit consumer can see the gate-effective
    // capability set and the sovereignty constraints the engine
    // accepted, without re-running the engine.
    const allowed = createSystemAccessAllowedEvent({
      ...auditCommon,
      capabilities: decision.capabilities,
    });
    await runtime.publish(allowed);
    trace(
      traceDispatch,
      runtime,
      source,
      "policy-decision",
      "pass",
      traceCtx,
      decision.capability,
    );
    gatedPrincipal = decision.principal;
  }

  // Per-dispatch harness — see fn-doc above for rationale. `source` is
  // structurally compatible between `SystemEventSource` and the harness's
  // `DispatchEventSource` (both alias the same shape in `dispatch-events.ts`).
  const req = buildDispatchRequest(payload, gatedPrincipal);
  const harness: SessionHarness =
    envelope.distribution_mode === "delegate"
      ? new AgentTeamHarness({
          source,
          ...(agentTeamFactory !== undefined && { agentTeamFactory }),
        })
      : new ClaudeCodeHarness({
          source,
          ...(ccSessionFactory !== undefined && { ccSessionFactory }),
        });

  // cortex#492 — emitted SYNCHRONOUSLY immediately before draining the
  // harness (the CC spawn). `harness.dispatch(req)` is the long-running
  // executor: a hang here (a CC process that never yields its first
  // envelope) leaves `session-spawning` in the log with no matching
  // `started` — the cortex#491 stall class made visible.
  trace(
    traceDispatch,
    runtime,
    source,
    "session-spawning",
    "info",
    traceCtx,
    envelope.distribution_mode === "delegate" ? "agent-team" : "claude-code",
  );

  // Drain the harness's lifecycle stream onto the bus. The harness
  // guarantees at least one terminal envelope; we publish whatever it
  // yields, in order. Each `runtime.publish` awaits — keeping the
  // strict happens-before ordering the original implementation relied
  // on (`started` is observable before any terminal envelope, even when
  // the runtime is the bus's actual NATS transport).
  //
  // cortex#491 — ECHO response routing onto every lifecycle envelope so
  // the originating dispatch sink can target the reply without state. The
  // harness is substrate-agnostic and never sees the inbound payload; the
  // runner — which parsed it — does the echo here. `undefined` when the
  // dispatch source carried no `response_routing` (bus-peer / Offer): the
  // envelope passes through verbatim, exactly as before this change.
  const responseRouting = payload.response_routing;
  let firstYield = true;
  for await (const env of harness.dispatch(req)) {
    if (firstYield) {
      firstYield = false;
      // The harness produced its first lifecycle envelope — the session
      // is actually running. Closes the trace: a dispatch that reaches
      // `started` got all the way through to a live CC session.
      trace(traceDispatch, runtime, source, "started", "info", traceCtx);
    }
    await runtime.publish(echoResponseRouting(env, responseRouting));
  }
}

/**
 * cortex#491 — return a lifecycle envelope with `payload.response_routing`
 * echoed from the inbound dispatch. Returns the envelope unchanged when
 * there is no routing to echo, or when the harness already stamped one
 * (defensive — the runner is the single echo authority, but we never
 * clobber an existing value). Builds a fresh payload object so the
 * harness's own envelope reference is not mutated in place.
 */
function echoResponseRouting(
  env: Envelope,
  responseRouting: ResponseRouting | undefined,
): Envelope {
  if (responseRouting === undefined) return env;
  const payload = env.payload;
  if (payload.response_routing !== undefined) return env;
  return {
    ...env,
    payload: { ...payload, response_routing: responseRouting },
  };
}

// ---------------------------------------------------------------------------
// Policy gating helpers (C.3.1)
// ---------------------------------------------------------------------------

/**
 * Result of the policy gate: an `allow` carries the authenticated
 * principal forward to the harness; a `deny` carries the structured
 * reason for the stderr log (and the future C.4 audit envelope).
 */
type DispatchPolicyResult =
  | {
      allow: true;
      principal: Principal | undefined;
      /** Effective capabilities surfaced on the allow branch (C.4.1). */
      capabilities: readonly string[];
      /** Capability the gate evaluated — carried onto the audit envelope. */
      capability: string;
      /** Principal id the gate resolved — carried onto the audit envelope. */
      principalId: string;
    }
  | {
      allow: false;
      reason: PolicyDenyReason;
      capability: string;
      principalId: string;
    };

/**
 * Build an `Intent` from the envelope + payload and ask the engine.
 *
 * **Chain verification (cortex#320, v2.0.2).** Inbound envelopes are
 * chain-verified by `handleDispatchEnvelope` BEFORE this function is
 * called: `signed_by[]` is structurally trust-checked against the
 * receiving agent's `trust:` list, and (by default) cryptographically
 * verified against the principal's NKey roster via myelin's
 * `verifyEnvelopeIdentity`. Empty chains — produced today by all
 * adapter-originated dispatches (Discord/Mattermost/Slack/cc-events) —
 * are accepted and fall through to this gate; signed chains must
 * verify. This closes the cortex#220 round-1
 * "authorization-without-authentication" gap that lived here pre-Phase-B.
 *
 * **Principal resolution.** Read `envelope.signed_by[0].identity`
 * (originator stamp per myelin#31 chain semantics; renamed from
 * `principal` in myelin#184 / R11). Strip the `did:mf:` prefix to
 * match `Principal.id`. If no chain is present (legitimate for
 * adapter-originated dispatches), fall back to `payload.agent_id` —
 * the engine will reject with `unknown_principal` unless the agent
 * is also a declared principal in the policy block.
 *
 * **Capability claim.** `dispatch.<agent_id>` — the dispatch surface
 * is "may principal X invoke agent Y on this stack?". C.2b will let
 * envelopes carry an explicit `capability` claim on the payload; for
 * now the implicit form keeps the gate operative without a payload
 * schema change.
 */
function checkDispatchPolicy(
  engine: PolicyEngine,
  envelope: Envelope,
  payload: DispatchTaskReceivedPayload,
  sourceNetwork: string | undefined,
): DispatchPolicyResult {
  const principalId = resolvePrincipalId(envelope, payload);

  // IAW Phase D.3 — surface `source_network` onto the intent when the
  // inbound wire subject was `federated.{network_id}.>`. The engine
  // uses it to evaluate the per-network policy slice; local
  // dispatches leave it `undefined` so the federation branch stays
  // inert (preserves C.3 behaviour for the legacy path).
  const intent: Intent = {
    capability: `dispatch.${payload.agent_id}`,
    sovereignty: {
      classification: envelope.sovereignty.classification,
      data_residency: envelope.sovereignty.data_residency,
      max_hop: envelope.sovereignty.max_hop,
      frontier_ok: envelope.sovereignty.frontier_ok,
      model_class: envelope.sovereignty.model_class,
    },
    payload_summary: `dispatch agent=${payload.agent_id} task_id=${payload.task_id}`,
    ...(sourceNetwork !== undefined && { source_network: sourceNetwork }),
  };

  const decision = engine.check(principalId, intent);
  if (!decision.allow) {
    return {
      allow: false,
      reason: decision.reason,
      capability: intent.capability,
      principalId,
    };
  }
  // The engine doesn't return a Principal — only the decision +
  // effective capabilities. The dispatch-listener doesn't need the
  // full Principal object on the request *yet* (C.3.2 substrate-side
  // consumers haven't shipped); we forward `undefined` for now so
  // the contract is in place but no harness branches on the value.
  // C.3b adds engine.getPrincipal(id) and threads it through.
  return {
    allow: true,
    principal: undefined,
    capabilities: decision.capabilities,
    capability: intent.capability,
    principalId,
  };
}

/**
 * Resolve the policy-attribution principal id for a dispatch envelope.
 *
 * cortex#346 / myelin#161 — defers to myelin's `getActorPrincipal()` so
 * the precedence rule lives in ONE place (envelope schema owner):
 *
 *   1. `envelope.originator?.identity` ← policy-attribution claim,
 *      covered by the envelope signature (SIGNABLE_FIELDS post-#161).
 *      Tampering with `originator.identity` OR `originator.attribution`
 *      invalidates the chain → caught by `verifySignedByChain` upstream.
 *      (Originator block still dual-reads the deprecated `principal`
 *      key during the R2 transition window; stamp-level `principal`
 *      was retired in myelin#184 / R11.)
 *   2. `envelope.signed_by[0]?.identity` ← legacy compat for pre-#161
 *      envelopes that never set an `originator`.
 *   3. `payload.agent_id` ← adapter-direct (non-bus) dispatches with no
 *      signed chain; belt-and-braces called out as out-of-scope-to-remove
 *      in cortex#346.
 *
 * `getActorPrincipal` returns a DID (`did:mf:<name>`) for cases 1+2, so
 * we still run the returned value through `extractAgentIdFromDid` to
 * strip the `did:mf:` prefix. When the parser rejects the DID (malformed
 * method, empty tail, multi-segment colon) we surface the raw string so
 * the engine receives a deterministic `unknown_principal` rather than
 * silent coercion (Echo cortex#220 round 2 S-1).
 *
 * **cortex#486 — resolver-side platform-id lookup removed.** PR #483
 * (cortex#482) briefly performed a reverse-lookup here when the bare
 * agent id matched a `<platform>-<authorId>` shape. That cleared the
 * chat round-trip, but at the wrong layer: per CONTEXT.md §Dispatch-
 * source the adapter is required to populate `originator.identity`
 * with the **resolved** human/agent DID. cortex#486 moved the
 * `(platform, authorId) → principal_id` resolution into
 * `adapterOriginatorIdentity` (`src/bus/dispatch-source-publisher.ts`),
 * so by the time the envelope lands here `originator.identity` is
 * already `did:mf:<principal-id>` and a simple `did:mf:` strip is
 * enough. Unresolvable platform identities now fail closed at publish
 * time (`invalid-originator`) — they never reach this function.
 */
function resolvePrincipalId(
  envelope: Envelope,
  payload: DispatchTaskReceivedPayload,
): string {
  const actorDid = getActorPrincipal(envelope);
  if (actorDid === undefined) return payload.agent_id;
  const agentId = extractAgentIdFromDid(actorDid);
  if (agentId === undefined) return actorDid;
  return agentId;
}

/**
 * IAW Phase D.3.2 (cortex#116, Echo cortex#227 round 1) — produce the
 * `SystemAccessDeniedReason` payload for a deny audit envelope from
 * an engine `PolicyDenyReason`, optionally enriched with the
 * `source_network` that the dispatch arrived on.
 *
 * The audit reason rides on `SystemAccessDeniedReason` whose `kind:
 * string` + `[k: string]: unknown` shape was carved by Echo cortex#221
 * round 1 to decouple the audit surface from the tighter
 * `PolicyDenyReason` discriminated union — additive fields like
 * `source_network` can land on the wire without forcing every audit
 * consumer to update its types. Keeping the enrichment in one place
 * gives principals a single function to inspect when reasoning about
 * "what shape does a deny envelope land with for federated traffic?"
 *
 * D.3 federation-specific reasons (`unknown_network`,
 * `stack_not_in_network`) already carry `source_network` via the
 * discriminator — the merge is a no-op for those; the value lives on
 * the same field name and the spread overwrites with an identical
 * literal.
 */
function enrichDenyReason(
  reason: PolicyDenyReason,
  source_network: string | undefined,
): SystemAccessDeniedReason {
  // `SystemAccessDeniedReason` is structurally `{ kind: string; [k:
  // string]: unknown }` — open enough to accept any spread of a
  // `PolicyDenyReason` discriminated-union member directly. No cast
  // needed (Echo cortex#227 round 1 — kept the helper for the
  // localisation reasons in the JSDoc, even though the cast that
  // motivated extraction is no longer required at the assignment
  // site).
  return {
    ...reason,
    ...(source_network !== undefined && { source_network }),
  };
}

/**
 * IAW Phase D.3 (cortex#116) — derive the federation network id from
 * a NATS subject of the form `federated.{network_id}.<...>`. Returns
 * `undefined` for any other subject shape (including local dispatches
 * and undefined inputs).
 *
 * The `{network_id}` grammar matches `PolicyFederatedNetworkSchema.id`
 * — lowercase alphanumeric + hyphen, starting with a letter. A
 * subject whose second segment doesn't match this grammar yields
 * `undefined` (defensive — the schema rejects malformed network ids
 * at config-load, but the wire path could still surface unexpected
 * subjects).
 *
 * Examples:
 *   `federated.research-collab.tasks.code-review` → `"research-collab"`
 *   `federated.research-collab` → `undefined` (no trailing segments,
 *     not a dispatch subject)
 *   `local.metafactory.dispatch.task.received` → `undefined`
 *   `undefined` → `undefined`
 */
function extractSourceNetwork(subject: string | undefined): string | undefined {
  if (subject === undefined) return undefined;
  const parts = subject.split(".");
  if (parts.length < 3) return undefined;
  if (parts[0] !== "federated") return undefined;
  const networkId = parts[1];
  if (networkId === undefined || networkId.length === 0) return undefined;
  if (!LETTER_PREFIX_ID_REGEX.test(networkId)) return undefined;
  return networkId;
}

/**
 * Canonical Direct/Delegate subjects carry the target assistant in the
 * `tasks.@{did}.{capability}` segment. Enforce that this wire recipient,
 * the envelope target, and the payload's executing agent agree before
 * policy or substrate dispatch sees the work.
 */
function validateCanonicalTaskRecipient(
  envelope: Envelope,
  payload: DispatchTaskReceivedPayload,
  subject: string | undefined,
): string | null {
  if (subject === undefined) return null;
  const parts = subject.split(".");
  const tasksIndex = parts.indexOf("tasks");
  if (tasksIndex === -1) return null;
  const assistantSegment = parts[tasksIndex + 1];
  if (!assistantSegment?.startsWith("@")) {
    return null;
  }

  const targetDid = getTargetAssistant(envelope);
  if (targetDid === undefined) {
    return "canonical task subject has an assistant segment but envelope.target_assistant is missing";
  }

  let expectedSegment: string;
  try {
    expectedSegment = encodeDidSegment(targetDid);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `envelope.target_assistant is not a valid DID: ${detail}`;
  }

  if (assistantSegment !== expectedSegment) {
    return `subject assistant ${assistantSegment} does not match envelope target ${expectedSegment}`;
  }

  const targetAgentId = extractAgentIdFromDid(targetDid);
  if (targetAgentId === undefined) {
    return `envelope.target_assistant ${targetDid} is not a did:mf agent identity`;
  }
  if (payload.agent_id !== targetAgentId) {
    return `payload.agent_id ${payload.agent_id} does not match envelope target agent ${targetAgentId}`;
  }

  return null;
}

async function emitCanonicalRecipientMismatch(
  runtime: MyelinRuntime,
  source: SystemEventSource,
  envelope: Envelope,
  payload: DispatchTaskReceivedPayload,
  detail: string,
): Promise<void> {
  const now = new Date();
  const failed = createDispatchTaskFailedEvent({
    source,
    taskId: payload.task_id,
    agentId: payload.agent_id,
    startedAt: now,
    failedAt: now,
    errorSummary: `canonical task recipient mismatch: ${detail}`,
    reason: {
      kind: "cant_do",
      detail,
    },
  });
  await runtime.publish(failed);
}

// ---------------------------------------------------------------------------
// Chain-verification deny path (cortex#320)
// ---------------------------------------------------------------------------

/**
 * Emit the audit + lifecycle envelope pair for a chain-verification
 * failure (cortex#320, v2.0.2). Mirrors the policy-gate deny pair —
 * `system.access.denied` (audit) plus `dispatch.task.failed`
 * (lifecycle terminal, Echo cortex#220 round 2 M-1 contract) — but
 * tags the reason with `kind: "chain_verification_failed"` so audit
 * consumers can distinguish a forged / unsigned envelope from a
 * legitimate principal failing the policy gate.
 *
 * The `principalId` on the audit envelope is set to the raw
 * `signed_by[0].identity` (or `"<unverified>"` for empty chains)
 * deliberately — the chain didn't verify, so we don't claim a
 * resolved principal. Subscribers correlating on principal id
 * branch on `reason.kind === "chain_verification_failed"` first.
 */
async function emitChainVerificationDeny(
  runtime: MyelinRuntime,
  source: SystemEventSource,
  envelope: Envelope,
  payload: DispatchTaskReceivedPayload,
  subject: string | undefined,
  stack: string | undefined,
  chainReason: ChainRejectionReason,
): Promise<void> {
  const chain = getSignedByChain(envelope);
  // R2 (vocabulary migration 2026-05) — dual-read via the shared
  // `getFirstStampPrincipal` helper so the transition logic lives in
  // one place. Sage cortex#396 maintainability suggestion.
  const claimedPrincipal = getFirstStampPrincipal(envelope);
  // Strip did:mf: prefix when present so audit consumers see a bare id
  // shape consistent with the engine's principal-id idiom; fall through
  // to the raw DID otherwise (preserves the wire claim verbatim).
  const principalId =
    extractAgentIdFromDid(claimedPrincipal) ?? claimedPrincipal;

  const signedBy: SystemAccessSignedBy[] = chain.map((stamp) => ({ ...stamp }));
  const auditSovereignty: SystemAccessSovereignty = {
    classification: envelope.sovereignty.classification,
    data_residency: envelope.sovereignty.data_residency,
    max_hop: envelope.sovereignty.max_hop,
    frontier_ok: envelope.sovereignty.frontier_ok,
    model_class: envelope.sovereignty.model_class,
  };
  const auditEnvelopeSubject =
    subject ?? dispatchReceivedSubject(source.principal, stack);

  const reasonPayload: SystemAccessDeniedReason = {
    kind: "chain_verification_failed",
    chain_reason: chainReason,
  };

  const denied = createSystemAccessDeniedEvent({
    source,
    principalId,
    capability: `dispatch.${payload.agent_id}`,
    sovereignty: auditSovereignty,
    correlationId: envelope.correlation_id ?? payload.task_id,
    envelopeId: envelope.id,
    envelopeSubject: auditEnvelopeSubject,
    signedBy,
    reason: reasonPayload,
  });
  await runtime.publish(denied);

  const now = new Date();
  const failed = createDispatchTaskFailedEvent({
    source,
    taskId: payload.task_id,
    agentId: payload.agent_id,
    startedAt: now,
    failedAt: now,
    errorSummary: `chain verification failed: ${chainReason.kind}`,
    reason: {
      kind: "policy_denied",
      deny: {
        kind: "chain_verification_failed",
        chain_reason: chainReason,
      },
    },
  });
  await runtime.publish(failed);
}

/**
 * Emit the deny pair when verification is wired but `receivingAgentId`
 * is unconfigured — a runner-level config error, not a chain-content
 * rejection. PR #322 round-1 M-1 fix: the prior bypass branch silently
 * skipped verification when the principal's config produced no local
 * agents (mergedAgents empty), re-opening cortex#220 round-1's gap.
 * Fail-closed here so the contract is enforced regardless of upstream
 * wiring; principals see the deny on the audit surface and the
 * dispatch fails loudly rather than slipping through unverified.
 */
async function emitReceivingAgentUnconfiguredDeny(
  runtime: MyelinRuntime,
  source: SystemEventSource,
  envelope: Envelope,
  payload: DispatchTaskReceivedPayload,
  subject: string | undefined,
  stack: string | undefined,
): Promise<void> {
  const chain = getSignedByChain(envelope);
  // R2 (vocabulary migration 2026-05) — same shared dual-read helper.
  const claimedPrincipal = getFirstStampPrincipal(envelope);
  const principalId =
    extractAgentIdFromDid(claimedPrincipal) ?? claimedPrincipal;

  const signedBy: SystemAccessSignedBy[] = chain.map((stamp) => ({ ...stamp }));
  const auditSovereignty: SystemAccessSovereignty = {
    classification: envelope.sovereignty.classification,
    data_residency: envelope.sovereignty.data_residency,
    max_hop: envelope.sovereignty.max_hop,
    frontier_ok: envelope.sovereignty.frontier_ok,
    model_class: envelope.sovereignty.model_class,
  };
  const auditEnvelopeSubject =
    subject ?? dispatchReceivedSubject(source.principal, stack);

  const denied = createSystemAccessDeniedEvent({
    source,
    principalId,
    capability: `dispatch.${payload.agent_id}`,
    sovereignty: auditSovereignty,
    correlationId: envelope.correlation_id ?? payload.task_id,
    envelopeId: envelope.id,
    envelopeSubject: auditEnvelopeSubject,
    signedBy,
    reason: {
      kind: "receiving_agent_unconfigured",
      detail:
        "runner has no local agent identity configured — cortex.yaml " +
        "must declare at least one agent before verification can run; " +
        "see cortex#322 + cortex#220 for the contract details",
    },
  });
  await runtime.publish(denied);

  const now = new Date();
  const failed = createDispatchTaskFailedEvent({
    source,
    taskId: payload.task_id,
    agentId: payload.agent_id,
    startedAt: now,
    failedAt: now,
    errorSummary:
      "receiving_agent_unconfigured — runner has no local agent identity for chain verification",
    reason: {
      kind: "policy_denied",
      deny: {
        kind: "receiving_agent_unconfigured",
        detail:
          "cortex.yaml declared 0 agents — chain verification can't run without a local receivingAgentId",
      },
    },
  });
  await runtime.publish(failed);
}
