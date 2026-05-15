/**
 * MIG-4.5 — Runner subscribes to `dispatch.task.received` via the surface-router.
 *
 * Architectural pattern (G-1111 §5):
 *   The surface-router fans envelopes to N adapters. Adapters declare
 *   interest with subjects + filter and a `render(envelope)` method.
 *   Adapters typically render to platforms (Discord, Mattermost, ...);
 *   the runner reuses the SAME adapter shape but `render()` *dispatches
 *   to a substrate harness* instead. The router doesn't care — it just
 *   fans envelopes. This keeps the runner symmetric with platform
 *   adapters and means a future test harness can register a no-op
 *   runner adapter to drain the bus during integration tests.
 *
 * Lifecycle (per plan-cortex-migration.md §4.5–4.6, IAW Phase A.1b):
 *   1. Envelope arrives on `local.{org}.dispatch.task.received`.
 *   2. Listener parses payload → builds a `DispatchRequest`.
 *   3. Listener instantiates a per-dispatch `ClaudeCodeHarness` and
 *      iterates `harness.dispatch(req)`.
 *   4. For each yielded `MyelinEnvelope` (started / completed / failed
 *      / aborted), the listener calls `runtime.publish(envelope)` to
 *      re-emit it on the bus.
 *   5. The harness's contract guarantees: at least one terminal envelope
 *      (`completed` | `failed` | `aborted`) per dispatch, in order, on
 *      the same `correlation_id`.
 *
 * **A.1b refactor history (cortex#113 / IAW Phase A).** Before A.1b the
 * listener spawned `CCSession` directly and built lifecycle envelopes
 * inline. Now the listener owns *just* the envelope-to-request
 * translation and the publish loop; everything CC-specific lives in
 * `ClaudeCodeHarness`. The behavioural surface is unchanged — the same
 * four envelope types fire in the same order on the same subjects with
 * the same payloads — but the runner is now substrate-agnostic at the
 * code level. A future `BusPeerHarness` slots in by switching which
 * harness the listener constructs per dispatch.
 *
 * **Boundaries (per task contract):**
 *   - This file does NOT modify `dispatch-handler.ts`. The bus-driven path
 *     and the legacy direct-call path coexist until MIG-7.1 picks the
 *     entrypoint wiring.
 *   - This file does NOT modify `cc-session.ts` or `session-manager.ts`.
 *     The harness still wraps `CCSession` underneath; this file no
 *     longer imports it.
 *   - This file does NOT post to Discord. Surfaces (worklog-manager via
 *     §4.7, dashboard via the bus) consume the lifecycle envelopes the
 *     runner emits and render their own way.
 *
 * **Why the listener is a SurfaceAdapter and not a separate "runner
 * subscriber" type:**
 *   The G-1111 design is explicit (§5.1): the surface-router is the single
 *   fan-out point, and adapters declare a `render(envelope)` shape. The
 *   runner is logically *also* a surface — it "renders" envelopes by
 *   dispatching to a substrate. Re-using the same shape keeps the router
 *   code path uniform (subject match → filter → render) and avoids
 *   inventing a parallel "consumer" registry. The semantic difference
 *   (render vs dispatch) lives in the adapter implementation, not the
 *   registry.
 */

import type { Envelope } from "../bus/myelin/envelope-validator";
import { getSignedByChain } from "../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type {
  SurfaceAdapter,
  SurfaceRouter,
} from "../bus/surface-router";
import type {
  SystemAccessSignedBy,
  SystemAccessSovereignty,
  SystemEventSource,
} from "../bus/system-events";
import {
  createSystemAccessAllowedEvent,
  createSystemAccessDeniedEvent,
} from "../bus/system-events";
import type {
  DispatchRequest,
  SessionHarness,
} from "../common/substrates/types";
import type { PolicyEngine } from "../common/policy/engine";
import { extractAgentIdFromDid } from "../common/policy/did";
import type {
  Intent,
  PolicyDenyReason,
  Principal,
} from "../common/policy/types";
import { createDispatchTaskFailedEvent } from "../bus/dispatch-events";
import {
  ClaudeCodeHarness,
  type CCSessionFactory as ClaudeCodeFactory,
} from "../substrates/claude-code/harness";

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
   * the legacy single-operator/dev-mode boot (no `policy:` block in
   * cortex.yaml → `policyEngineFromConfig` returns `undefined` →
   * passed through verbatim here).
   */
  policyEngine?: PolicyEngine;
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
    ccSessionFactory,
    policyEngine,
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
    //
    // `signal` is accepted for contract symmetry but not currently forwarded
    // into the substrate dispatch — the lifecycle is governed by the
    // harness's own timeout/inactivity timers (per Q6 lock-in). A follow-on
    // iteration can wire `signal.aborted` to `harness.shutdown({ graceful:
    // false })` so surface-router timeouts end the CC process eagerly
    // rather than waiting for cc-session's internal timer to fire.
    render: (envelope, _signal) =>
      handleDispatchEnvelope(envelope, runtime, source, ccSessionFactory, policyEngine),
  };

  return {
    surfaceConfig,
    // start/stop are part of the surface-listener contract — return
    // Promise<void> even when the body is sync, so callers can await
    // alongside other lifecycle hooks (cc-session, bus, taps).
    // eslint-disable-next-line @typescript-eslint/require-await
    async start() {
      if (registration) return;
      registration = router.register(surfaceConfig);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async stop() {
      if (!registration) return;
      registration.unregister();
      registration = null;
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
 * adapter logs and returns; the surface-router's isolation hook captures
 * the case via the missing `dispatch.task.started` event downstream
 * (a producer that emits `received` and never sees `started` knows
 * something went wrong).
 */
// UUID v1-v5 shape per RFC 4122 §3 — same regex used by the envelope
// validator on `envelope.id`, applied here at the payload layer for
// `payload.task_id`.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  if (!UUID_RE.test(p.task_id)) {
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
 * **persona absence.** The legacy bus-driven path does NOT carry persona
 * file data on the payload (persona injection happens at the dispatch-
 * handler layer via the prompt-builder). We therefore omit `persona`
 * from the request — the harness handles `persona === undefined` per
 * the A.1b spec (optional field).
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

  // Env-kind context block carries operator/entity/project labels.
  // Build it iff the payload supplied any of the three; the harness
  // surfaces them onto CCSessionOpts as before.
  const envContext: Record<string, unknown> = {};
  if (payload.operator !== undefined) envContext.operator = payload.operator;
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
 * The render() implementation: parse → instantiate harness → iterate
 * `harness.dispatch(req)` → publish each yielded envelope. Returns
 * `Promise<void>` so the surface-router can await with its render-timeout
 * isolation.
 *
 * **Per-dispatch harness construction (Q7 lock-in).** Every received
 * envelope spawns a fresh `ClaudeCodeHarness` instance. The harness is
 * stateless beyond its in-flight session tracking, so this is cheap;
 * the alternative (a long-lived harness shared across dispatches) would
 * couple `shutdown` semantics across unrelated dispatches and is not
 * worth the savings for A.1b. Shared infrastructure (the CC factory)
 * is threaded through via constructor opts.
 */
async function handleDispatchEnvelope(
  envelope: Envelope,
  runtime: MyelinRuntime,
  source: SystemEventSource,
  ccSessionFactory: CCSessionFactory | undefined,
  policyEngine: PolicyEngine | undefined,
): Promise<void> {
  const payload = parsePayload(envelope);
  if (!payload) {
    console.error(
      `cortex-runner: dispatch-listener: malformed dispatch.task.received envelope id=${envelope.id} — required fields missing`,
    );
    return;
  }

  // IAW Phase C.3.1 — policy gate. When the engine is configured we
  // resolve the originating principal from `envelope.signed_by[0]`
  // (the first stamp is the originator per myelin#31 chain ordering;
  // hub-stamps later in the chain re-attest but don't replace
  // origin). The capability claim is a placeholder
  // `dispatch.<agent_id>` derived from the dispatch target — until
  // C.2b carries an explicit capability tag on the payload, the
  // dispatch surface is "may principal X invoke agent Y on this
  // stack?". Sovereignty flows through verbatim so audit envelopes
  // (C.4) carry the same constraints the engine saw.
  //
  // When the engine is undefined the listener falls back to the
  // legacy unauthenticated path — the runner is booted without a
  // `policy:` block. C.2b removes the legacy path entirely.
  let gatedPrincipal: Principal | undefined;
  if (policyEngine !== undefined) {
    const decision = checkDispatchPolicy(policyEngine, envelope, payload);
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
    // consumers subscribing to `federated.{org}.system.access.>`
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
    const auditCommon = {
      source,
      principalId: decision.principalId,
      capability: decision.capability,
      sovereignty: auditSovereignty,
      correlationId: envelope.correlation_id ?? payload.task_id,
      envelopeId: envelope.id,
      envelopeSubject: `local.${source.org}.dispatch.task.received`,
      signedBy,
    };

    if (!decision.allow) {
      console.error(
        `cortex-runner: dispatch-listener: denied envelope id=${envelope.id} task_id=${payload.task_id} agent=${payload.agent_id} — reason=${decision.reason.kind}`,
      );
      // C.4.2 — emit `system.access.denied` carrying the structured
      // engine deny reason + signed_by chain. Lives on a different
      // subject than the dispatch.task.* lifecycle so audit consumers
      // (dashboard, pipeline) get a stable wire path.
      const denied = createSystemAccessDeniedEvent({
        ...auditCommon,
        reason: { ...decision.reason },
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
    gatedPrincipal = decision.principal;
  }

  // Per-dispatch harness — see fn-doc above for rationale. `source` is
  // structurally compatible between `SystemEventSource` and the harness's
  // `DispatchEventSource` (both alias the same shape in `dispatch-events.ts`).
  const harness: SessionHarness = new ClaudeCodeHarness({
    source,
    ...(ccSessionFactory !== undefined && { ccSessionFactory }),
  });

  const req = buildDispatchRequest(payload, gatedPrincipal);

  // Drain the harness's lifecycle stream onto the bus. The harness
  // guarantees at least one terminal envelope; we publish whatever it
  // yields, in order. Each `runtime.publish` awaits — keeping the
  // strict happens-before ordering the original implementation relied
  // on (`started` is observable before any terminal envelope, even when
  // the runtime is the bus's actual NATS transport).
  for await (const env of harness.dispatch(req)) {
    await runtime.publish(env);
  }
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
 * **⚠ SECURITY — pre-Phase-B authorization-without-authentication.**
 * The principal claim read here (`signed_by[0].principal`) is
 * **not yet cryptographically verified at the envelope-validator
 * layer**. Per `src/bus/myelin/envelope-validator.ts:125-126`:
 * *"IAW Phase A.2: `signed_by` is surfaced but not yet consumed
 * for trust decisions."* That means a publisher to the bus can
 * fabricate `signed_by[0].principal = "did:mf:operator"` and
 * acquire the operator role's capabilities until Phase B's
 * signature verification is mandatory at the validator. Echo
 * cortex#220 round 1.
 *
 * **What this gate IS safe for (today):**
 *   - Single-operator / dev-mode deployments where the bus is a
 *     local leaf node with no untrusted publishers.
 *   - Multi-operator deployments where every adapter+harness on
 *     the bus is operated by the same trust boundary.
 *
 * **What this gate is NOT safe for (today):**
 *   - Multi-principal trust in a deployment where untrusted
 *     processes can publish onto the bus.
 *   - Federation across operators (Phase D) — verification is
 *     mandatory there.
 *
 * The `CORTEX_POLICY_REQUIRE_UNVERIFIED_ACK=1` opt-in below makes
 * this trade-off explicit at boot. Phase B (cortex#114) wires the
 * verifier into the validator and closes the gap.
 *
 * **Principal resolution.** Read `envelope.signed_by[0].principal`
 * (originator stamp per myelin#31 chain semantics). Strip the
 * `did:mf:` prefix to match `Principal.id`. If no chain is present
 * (legacy unsigned envelope), fall back to `payload.agent_id` —
 * the engine will reject with `unknown_principal` unless the
 * agent is also a declared principal in the policy block. Both
 * paths are equally unverified today (Echo cortex#220 round 1).
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
): DispatchPolicyResult {
  const principalId = resolvePrincipalId(envelope, payload);

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
 * Strip the `did:mf:` prefix from the originator stamp's principal
 * via the shared `extractAgentIdFromDid` helper (also used by
 * `verify-signed-by-chain.ts` — Echo cortex#220 round 2 S-1). Falls
 * back to `payload.agent_id` when the envelope has no chain, AND
 * surfaces the raw DID string when the parser rejects it (malformed
 * DID method, empty tail, multi-segment colon) so the engine
 * receives a deterministic `unknown_principal` rather than silent
 * coercion.
 */
function resolvePrincipalId(
  envelope: Envelope,
  payload: DispatchTaskReceivedPayload,
): string {
  const chain = getSignedByChain(envelope);
  const origin = chain[0];
  if (origin === undefined) return payload.agent_id;
  return extractAgentIdFromDid(origin.principal) ?? origin.principal;
}

