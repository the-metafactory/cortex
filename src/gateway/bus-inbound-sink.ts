/**
 * GW.a.3a — BusInboundSink: the live-path gateway sink (cortex#524).
 *
 * Implements {@link GatewayInboundSink} by delegating to
 * {@link publishInboundChatDispatchEnvelope} — the same canonical
 * dispatch-source publisher the per-stack `dispatch-handler.ts` uses. The
 * gateway is a thin demux, not a second envelope builder; all envelope
 * construction, originator attribution, and subject derivation live in the
 * publisher, not here.
 *
 * ## Follow-on slices
 *
 * - **GW.a.3b** — wire `BusInboundSink` into `cortex.ts` boot path; provide
 *   the gateway's `MyelinRuntime`. The D1 decision (gateway publishes
 *   originator-stamped + unsigned; the bound stack re-signs on ingest) is a
 *   property of the runtime injected here — this sink is signing-agnostic.
 * - **GW.a.3c** — launchd plist and process-level supervision for the gateway.
 *
 * ## Documented gaps / follow-up items
 *
 * - **agentDisplayName** — the binding carries only the `agent` id; it has no
 *   display name. `agentDisplayName` is set to the agent id as a placeholder.
 *   Proper agent→assistant/display-name resolution belongs to the bound stack's
 *   config lookup, which is out of scope for this slice. Tracked: cortex#524
 *   follow-up (agent→assistant resolution for gateway bindings).
 *
 * - **D1 signing** — the gateway publishes originator-stamped envelopes
 *   unsigned; the bound stack re-signs on ingest (CONTEXT.md §Dispatch-source,
 *   decision 2026-06-02). The re-sign mechanism is implemented in GW.a.3b by
 *   giving the gateway a signing-agnostic `MyelinRuntime` that publishes
 *   without a stack NKey. This sink delegates signing responsibility entirely
 *   to the injected runtime.
 */

import type { GatewayInboundSink, GatewayInboundDecision } from "./surface-gateway";
import type { InboundMessage } from "../adapters/types";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { PolicyEngine } from "../common/policy/engine";
import type { SystemEventSource } from "../bus/system-events";
import {
  publishInboundChatDispatchEnvelope,
  type InboundChatDispatchPublishOpts,
  type DispatchSourcePublishResult,
} from "../bus/dispatch-source-publisher";

// =============================================================================
// Public types
// =============================================================================

/**
 * Constructor-time dependencies for {@link BusInboundSink}.
 *
 * `publishFn` is injected so unit tests can assert the opts mapping with a
 * capturing fake rather than requiring a live NATS runtime.
 */
export interface BusInboundSinkDeps {
  /**
   * The gateway's Myelin runtime — used by the publisher to call
   * `runtime.publishOnSubject`. `undefined` during startup before the bus
   * connects; the publisher returns `{ published: false, reason: "missing-runtime" }`.
   *
   * D1 signing is a property of THIS runtime (wired in GW.a.3b): the gateway
   * publishes originator-stamped + unsigned; the bound stack re-signs on ingest.
   */
  runtime: MyelinRuntime | undefined;

  /**
   * The gateway's dispatch-source identity — supplies principal, agent id, and
   * instance for the envelope `source` field. `undefined` during startup before
   * the bus connects; the publisher returns `{ published: false, reason: "missing-runtime" }`.
   */
  source: SystemEventSource | undefined;

  /**
   * Policy engine that resolves `(platform, authorId)` → principal DID for
   * `originator.identity`. `undefined` causes the publisher to refuse the publish
   * with `reason: "invalid-originator"`.
   */
  policyEngine: PolicyEngine | undefined;

  /**
   * Publish function. Defaults to the real {@link publishInboundChatDispatchEnvelope}.
   * Inject a capturing fake in tests to assert opts mapping without a live runtime.
   */
  publishFn?: (opts: InboundChatDispatchPublishOpts) => Promise<DispatchSourcePublishResult>;
}

// =============================================================================
// BusInboundSink
// =============================================================================

/**
 * Live-path gateway sink that publishes a canonical `tasks.@{agent}.chat`
 * dispatch envelope for each routable inbound message.
 *
 * Constructs {@link InboundChatDispatchPublishOpts} from the gateway's routing
 * decision and the inbound message, then delegates entirely to
 * {@link publishInboundChatDispatchEnvelope}.
 *
 * On a `{ published: false }` result the sink logs the refusal to stderr with
 * full context (platform / instanceId / subject / reason) — a publish refusal
 * must surface, not silently drop. The method never throws; callers (the
 * `SurfaceGateway.handleInbound` catch-swallow loop) are free to rely on this.
 */
export class BusInboundSink implements GatewayInboundSink {
  private readonly runtime: MyelinRuntime | undefined;
  private readonly source: SystemEventSource | undefined;
  private readonly policyEngine: PolicyEngine | undefined;
  private readonly publishFn: (
    opts: InboundChatDispatchPublishOpts,
  ) => Promise<DispatchSourcePublishResult>;

  constructor(deps: BusInboundSinkDeps) {
    this.runtime = deps.runtime;
    this.source = deps.source;
    this.policyEngine = deps.policyEngine;
    this.publishFn = deps.publishFn ?? publishInboundChatDispatchEnvelope;
  }

  /**
   * Publish one routable inbound message as a canonical dispatch envelope.
   *
   * Maps the gateway routing decision and inbound message to
   * {@link InboundChatDispatchPublishOpts}, calls the publisher, and logs any
   * refusal to stderr. Never throws.
   */
  async publish(
    decision: GatewayInboundDecision,
    msg: InboundMessage,
  ): Promise<void> {
    const { match } = decision;

    // Generate a unique task id using the repo-standard crypto.randomUUID()
    // (produces RFC-4122 v4, validated by STRICT_UUID_REGEX in uuid.ts).
    const taskId = crypto.randomUUID();

    const opts: InboundChatDispatchPublishOpts = {
      runtime: this.runtime,
      source: this.source,
      policyEngine: this.policyEngine,
      stack: match.stack,
      agentName: match.agent,
      // agentDisplayName: binding carries no display name — use agent id as
      // placeholder. Proper agent→assistant/display resolution belongs to the
      // bound stack's config lookup (documented gap, see module doc).
      agentDisplayName: match.agent,
      taskId,
      msg,
      // prompt = raw inbound text. The gateway is a thin demux; prompt-building
      // and security-preamble injection are the bound stack's substrate
      // harness's responsibility (design §2.2/§4).
      prompt: msg.content,
      principal: match.principal,
      // cortex#651 (F-1b) — route the inbound request SUBJECT under the
      // binding's parsed principal so a cross-principal binding lands on the
      // BOUND stack's runner subscription (local.{bindingPrincipal}.{stack}.tasks.*),
      // not the gateway principal. Gap-4 bindings have match.principal === undefined
      // → the publisher falls back to source.principal (the gateway principal),
      // which is the intended gap-4 default. Same-principal bindings set this to
      // the gateway principal → identical subject, no behaviour change.
      // F-1 (#629) did the outbound (reply) leg; this completes the inbound leg.
      subjectPrincipal: match.principal,
      // The publisher derives response_routing from msg.instanceId directly via
      // responseRoutingFromMessage() — consistent with decision.responseRouting.
      // We do NOT double-stamp it here.
      allowedDirs: [],
      // cortex#701 — the gateway grants NO skills and emits the bare `Skill`
      // deny so the bound stack's harness (which consumes this envelope via
      // the runner subscription, NOT via dispatch-handler — so it never runs
      // the skill gate) spawns the session with the Skill tool denied.
      // Without this, an envelope carrying empty allow/deny lists spawns a
      // session where the `Skill` tool is AVAILABLE BY DEFAULT (verified,
      // CLI 2.1.158) — a fail-open hole on the gateway path. Fail-closed.
      // Per-skill grants on this path are the cortex#701 Part B follow-up
      // (PreToolUse-hook design); until it lands the gateway path has no
      // skills, by design.
      disallowedTools: ["Skill"],
      // Optional opts — the gateway does not own these; the bound stack applies
      // its own policy and session context.
      resumeSessionId: undefined,
      timeoutMs: undefined,
      cwd: undefined,
      additionalArgs: undefined,
      groveChannel: undefined,
      groveNetwork: undefined,
      project: undefined,
      entity: undefined,
    };

    const result = await this.publishFn(opts);

    if (!result.published) {
      // A publish refusal must surface. Log with full context so the principal
      // can diagnose invalid-originator, missing-runtime, etc. Not an empty
      // catch — this is the error path.
      process.stderr.write(
        `[bus-inbound-sink] publish refused — dropping inbound message. ` +
          `platform=${msg.platform} instanceId=${msg.instanceId} ` +
          `agent=${match.agent} ` +
          `stack=${match.stack ?? "<unresolved>"} ` +
          `principal=${match.principal ?? "<unresolved>"} ` +
          (result.subject !== undefined ? `subject=${result.subject} ` : "") +
          `reason=${result.reason ?? "<unknown>"}\n`,
      );
    }
  }
}
