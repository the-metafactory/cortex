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
  principalFromEnvelope,
} from "../bus/myelin/envelope-validator";
import { encodeDidSegment } from "@the-metafactory/myelin/subjects";
import type { MyelinRuntime, BusEnvelopeSigner } from "../bus/myelin/runtime";
import { signEnvelope } from "@the-metafactory/myelin/identity";
import {
  emitFederationDenied,
  evaluateFederationGate,
  resolveSourceNetwork,
  subjectMatches,
} from "../bus/surface-router";
import type {
  AgentRuntime,
  PolicyFederated,
  PolicyFederatedNetwork,
} from "../common/types/cortex-config";
import type { InferenceRegistry } from "../common/inference/registry";
import type {
  SystemAccessDeniedReason,
  SystemAccessSignedBy,
  SystemAccessSovereignty,
  SystemEventSource,
} from "../bus/system-events";
import {
  createSystemAccessAllowedEvent,
  createSystemAccessDeniedEvent,
  createSystemAdmissionThrottledEvent,
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
// R26 P1 (cortex#1371) — the substrate admission gate (KV-arbitrated rate
// limiting) + the anonymous public principal id it fails closed for.
import type { AdmissionGate, AdmissionLease } from "../bus/admission";
import { PUBLIC_PRINCIPAL_ID } from "../common/policy/factory";
import { isUuid } from "../common/types/uuid";
// M3 (cortex#1241, ADR-0019) — verify-then-decrypt the sealed dispatch payload.
import { readMarker, NetworkKeyring } from "../common/crypto/payload-encryption";
import { openInboundEnvelope } from "../common/crypto/inbound-payload";
import { buildNetworkKeyring } from "../common/crypto/network-encryption-policy";
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
import type { FederatedPeerResolution } from "../common/registry";
import {
  verifySignedByChain,
  type ChainRejectionReason,
  type ChainVerificationResult,
} from "../bus/verify-signed-by-chain";
import type { CCSessionFactory as ClaudeCodeFactory } from "../substrates/claude-code/harness";
import type { AgentTeamFactory } from "./agent-team";
// API-P0.5 (#2060) — harness selection lives in the resolver seam. The
// `ClaudeCodeHarness` / `AgentTeamHarness` classes are constructed there now,
// not inline here, so this file imports only the resolver.
import { DefaultHarnessResolver } from "./harness-resolver";

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
 * payload intentionally does not surface:
 *
 *   - `DispatchRequest.inactivityMs` (top-level, alongside `timeoutMs`) —
 *     no corresponding `inactivity_ms` here.
 *   - `DispatchRuntime.bashAllowlist` / `DispatchRuntime.bashGuardDisabled` —
 *     no corresponding `bash_allowlist` / `bash_guard_disabled` here.
 *
 * **cortex#127 — bash allowlist is now plumbed receiving-side, NOT via the
 * payload.** The fix for the GUILD-only-stack bounce (dispatched sessions
 * never got `CORTEX_BASH_GUARD` set, so the bash-guard hook fell through to
 * an unanswerable `claude --print` permission prompt) plumbs
 * `bashAllowlist` / `bashGuardDisabled` through the LISTENER, sourced from
 * the EXECUTING stack's `claude.bashAllowlist` config in `cortex.ts` — see
 * {@link DispatchListenerOptions.bashAllowlist}. The wire payload still has
 * NO `bash_allowlist` / `bash_guard_disabled` field by design: the receiving
 * stack's configured allowlist is authoritative, and letting a remote
 * dispatcher supply one would let it weaken/replace/expand the guard on a
 * public-facing surface. So the absence here is now intentional and
 * load-bearing, not a TODO.
 *
 * `inactivity_ms` remains genuinely unplumbed; adapter-direct (non-bus)
 * dispatches can populate it in-process, bus-mediated ones pick up the
 * harness/dispatch-handler default. Surfacing it is future-facing work
 * (Phase A.5+ or a dedicated payload-versioning PR).
 */
export interface DispatchTaskReceivedPayload {
  /** UUID-shaped task identifier (also envelope.correlation_id). */
  task_id: string;
  /** Agent that should execute (`cortex`, `pilot`, ...). */
  agent_id: string;
  /** The CC prompt — what claude should do. Required. */
  prompt: string;
  /**
   * Optional CC session opts — passed through to CCSession constructor.
   * GV-2 (cortex#1077): `cortex_channel`/`cortex_network` are the canonical
   * dispatch-payload labels; `grove_channel`/`grove_network` are the legacy
   * aliases kept for back-compat. The source DUAL-WRITES both; the listener
   * reads cortex-first with a grove fallback. The grove aliases retire at the
   * breaking v3.0.0 (cortex#774 lockstep). All optional.
   */
  cortex_channel?: string;
  cortex_network?: string;
  grove_channel?: string;
  grove_network?: string;
  agent_name?: string;
  resume_session_id?: string;
  /**
   * ST-P1 (cortex#964, refs #952) — the parent session id for this dispatch
   * (session-tree linkage). `buildDispatchRequest` maps it onto
   * `req.runtime.parentSessionId`; the claude-code harness then stamps it onto
   * `CCSessionOpts.parentSessionId`. Name PINNED for the ST-P2 producer.
   */
  parent_session_id?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  /**
   * cortex#710 — per-skill grant list. `undefined` → harness default
   * (default-deny, no Skill tool); `[]` → explicit no-skills; `[...]` →
   * grant exactly those skills via the Skill Guard PreToolUse hook.
   */
  allowed_skills?: string[];
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
   * TC-0 (#628) — whether an empty `signed_by[]` chain is REJECTED.
   * Default `false` (the historical hard-coded value): adapter-originated
   * dispatches arrive with no chain and fall through to the policy gate.
   * `cortex.ts` sets this from the security posture — `enforce` →
   * `true` (reject unsigned adapter traffic), `off`/`permissive` → `false`.
   */
  rejectEmpty?: boolean;
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
   * API-P1.3 (#2063) — receiving agents' runtime configs indexed by agent id,
   * used to thread the DISPATCHED-TO agent's `substrate` + `inferenceProfile`
   * into the harness resolver. When present, the handler looks up the
   * `receivingAgentId`'s `AgentRuntime` here and passes it to
   * `HarnessResolver.resolve(...)` so `substrate: api-agent` agents dispatch
   * through the `ApiAgentHarness`. Absent (or an agent with no `substrate`)
   * preserves the pre-P1.3 behaviour — every ordinary dispatch → claude-code.
   */
  agentRuntimesById?: Map<string, AgentRuntime>;
  /**
   * API-P1.3 (#2063) — the inference registry the `api-agent` substrate resolves
   * its profile through. Threaded to `HarnessResolver`. Absent on stacks with no
   * `inference` config → an `api-agent` dispatch fails closed at the harness.
   */
  inferenceRegistry?: InferenceRegistry;
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
   * TC-1c (#552) — **Shape B re-sign on ingest.** The receiving stack's
   * envelope signer (`{ rawSeedBytes, principal }`, the SAME
   * {@link BusEnvelopeSigner} `cortex.ts` hands to `startMyelinRuntime`).
   * When supplied, an inbound dispatch that arrived with an **empty
   * `signed_by[]`** (a gateway Shape-A injection or an adapter-originated
   * dispatch) is re-stamped IN PLACE with the stack NKey — right after
   * `verifySignedByChain` accepts it and BEFORE the policy gate — so the
   * downstream `system.access.*` audit envelopes (and any further
   * processing) are cryptographically attributable to the stack. The
   * stack vouches for the gateway-injected request; the gateway stays a
   * pure transport that never touches identity (CONTEXT.md §Dispatch-
   * source, decision 2026-06-02).
   *
   * **Posture-gated.** `cortex.ts` supplies this ONLY when
   * `security.signing` resolves `attachSigner: true` (`permissive` /
   * `enforce`) AND a stack seed loaded. Under `signing: off` (the default)
   * the field is `undefined` → no re-sign → byte-identical to today's pure
   * Shape A. This is the load-bearing back-compat invariant.
   *
   * **In-place, not re-publish.** Re-publishing on the same
   * `tasks.@{agent}.chat` subject the listener subscribes to would loop;
   * the same dispatch must carry the stamp before the harness runs, so we
   * append via myelin `signEnvelope` and continue the handler with the
   * re-stamped envelope.
   *
   * **Empty-chain-only.** Only an envelope with NO existing chain is
   * re-stamped — never double-stamp an already-signed envelope (a real
   * signed dispatch, or our own re-stamped traffic), which also keeps the
   * own-stack short-circuit and the loop-safety invariant intact. Policy
   * attribution is unaffected: `resolvePrincipalId` reads
   * `originator.identity` first (the gateway stamps it), only falling back
   * to `signed_by[0]` when no originator exists — appending a stack stamp
   * to a previously-empty chain does NOT change the policy-resolved
   * principal.
   */
  resignSigner?: BusEnvelopeSigner;
  /**
   * TC-2d (cortex#635) — federated.* peer-pubkey resolution seam. When
   * supplied AND `cryptoVerify: true`, an inbound `federated.*` dispatch
   * has its **signer peer principal** resolved to a verified Ed25519
   * identity before the crypto-verify pass (the cross-principal trust
   * chain capstone). `cortex.ts` wires this ONLY under
   * `signing === "enforce"`; `off`/`permissive` leave it `undefined`
   * (ZERO registry I/O — federated envelopes verify local-only, as today).
   * Inert for `local.*` dispatches. See `verify-signed-by-chain.ts` JSDoc.
   */
  resolveFederatedPeer?: (
    peerPrincipal: string,
  ) => Promise<FederatedPeerResolution>;
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
  /**
   * cortex#127 — **receiving-stack bash allowlist (RECEIVING-STACK-
   * AUTHORITATIVE).** The EXECUTING stack's own `claude.bashAllowlist`
   * config, applied to EVERY dispatch this listener runs so the spawned
   * Claude Code session gets `CORTEX_BASH_GUARD` set (via
   * `CCSessionOpts.bashAllowlist` → cc-session env serialisation). Without
   * it, the bash-guard PreToolUse hook treats the session as a non-Grove
   * session and falls through to Claude Code's permission prompt — which is
   * unanswerable in async `claude --print`, so every allowlisted command
   * bounces. That blocked all GUILD-only stacks (`andreas/community`,
   * `andreas/halden`); meta-factory dodged it only because principal DMs get
   * full access with no guard.
   *
   * **Security — stack config wins, full stop.** This is the receiving
   * stack's OWN configured value, threaded from `cortex.ts`
   * (`config.claude.bashAllowlist`). It is NEVER sourced from the wire
   * payload: `DispatchTaskReceivedPayload` deliberately carries no
   * `bash_allowlist` field (see the asymmetry docblock above), so a remote
   * dispatcher cannot supply, weaken, replace, or expand the allowlist. The
   * listener injects this onto every `DispatchRequest.runtime` regardless of
   * the inbound envelope. When omitted (no `claude.bashAllowlist` in config),
   * nothing is injected → the default-deny posture is preserved (the guard
   * hook denies every Bash command in a Grove session with no allowlist).
   *
   * Same shape as `CCSessionOpts.bashAllowlist` /
   * `DispatchRuntime.bashAllowlist`.
   */
  bashAllowlist?: {
    rules: { pattern: string; repos?: string[] }[];
    repos: string[];
  };
  /**
   * cortex#127 — receiving-stack bash-guard disable flag. When `true`,
   * the spawned session runs with the bash guard OFF (the highest-privilege
   * posture, e.g. principal DMs). Like {@link bashAllowlist} this is the
   * RECEIVING stack's own configured value — never wire-supplied — and is
   * injected onto every `DispatchRequest.runtime`. There is no corresponding
   * config field today (cortex.yaml `claude` has no `bashGuardDisabled`), so
   * `cortex.ts` does not currently pass it; the option exists so the
   * plumbing is complete and a future config knob is a one-line wire-up.
   */
  bashGuardDisabled?: boolean;
  /**
   * R26 P1 (cortex#1371) — the substrate ADMISSION GATE (design
   * `docs/design-substrate-rate-limiting.md` Design B; myelin
   * `specs/admission.md`). When supplied, every policy-ALLOWED dispatch is
   * admission-checked (KV-arbitrated token bucket + in-flight lease, keyed on
   * the envelope-resolved requester principal) BEFORE the harness is
   * constructed; a refusal emits `system.admission.throttled` plus a terminal
   * `dispatch.task.failed { kind: "not_now", retry_after_ms }` and never
   * spawns. `cortex.ts` supplies this ONLY when `policy.admission` is
   * configured — `undefined` (the default) is the CO-4 inert posture:
   * byte-identical behaviour, zero admission reads.
   */
  admissionGate?: AdmissionGate;
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
 * `agentId` / `taskId` are an untrusted peek at the payload — purely for the
 * trace's human-facing detail; the authoritative ids are resolved by the
 * verified parse downstream.
 *
 * M3 (cortex#1246 NIT) — this is a PRE-VERIFY peek, so it must honour the
 * "nothing reads the sealed payload before verify→decrypt" invariant in letter,
 * not just in spirit. A SEALED body is `{ciphertext,nonce}` (no `task_id` /
 * `agent_id`), so the peek would read `undefined` and leak nothing today — but
 * to keep the invariant true regardless of future fields, the payload peek is
 * skipped entirely when an `extensions.enc` marker is present. A sealed envelope
 * therefore traces on `correlation_id` / `id` only; the real ids appear once the
 * verified parse runs post-decrypt. Cleartext (transition-window) envelopes,
 * whose fields were on the wire anyway, keep the richer trace detail.
 */
function rawEnvelopeTraceContext(
  envelope: Envelope,
  subject: string | undefined,
): DispatchTraceContext {
  const join = envelope.correlation_id ?? envelope.id;
  // Never peek a sealed payload pre-verify — fall back to the join key only.
  const sealed = readMarker(envelope) !== undefined;
  const payload = sealed
    ? undefined
    : (envelope.payload as Partial<DispatchTaskReceivedPayload> | undefined);
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
    agentRuntimesById,
    inferenceRegistry,
    principalId,
    stackIdentity,
    stackNKeyPub,
    resignSigner,
    resolveFederatedPeer,
    bashAllowlist,
    bashGuardDisabled,
    admissionGate,
    adapterId = "runner-dispatch-listener",
  } = opts;
  // v2.0.2 default: structural trust + ed25519 crypto verification.
  // Adapter-originated dispatches arrive with empty `signed_by[]` and
  // fall through `rejectEmpty: false`; signed bus traffic MUST verify.
  const cryptoVerify = opts.cryptoVerify ?? true;
  // TC-0 (#628) — empty-chain rejection. Default `false` preserves the
  // historical hard-coded behaviour (adapter dispatches fall through);
  // `cortex.ts` flips it to `true` under `security.signing: enforce`.
  const rejectEmpty = opts.rejectEmpty ?? false;
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
        rejectEmpty,
        principalId,
        receivingAgentId,
        agentRuntimesById,
        inferenceRegistry,
        stackIdentity,
        stackNKeyPub,
        resignSigner,
        resolveFederatedPeer,
        federatedNetworksById,
        traceDispatch,
        bashAllowlist,
        bashGuardDisabled,
        admissionGate,
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
      envelopeRegistration = runtime.onEnvelope((envelope, subject, sourceLink) => {
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
            // IAW Phase F-3d (cortex#666) — additive anti-spoof input. The
            // runtime tags the delivering `linkId`; the gate cross-checks the
            // subject's claimed network against the link it arrived on.
            // `undefined` (no attribution) skips the cross-check (back-compat).
            sourceLink,
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
 * M3 (cortex#1241, ADR-0019) — the cleartext ROUTING identifiers for the
 * PRE-verify deny-audit emitters, derived from SIGNED cleartext metadata ONLY
 * (never the payload, which may be sealed before verify+decrypt). `task_id`
 * comes from `correlation_id` (the dispatch's join key, also the task id by
 * convention); `agent_id` from the signed `target_assistant` DID when present
 * (Offer mode has no named target → `"unknown"`). Used purely to populate the
 * `dispatch.<agent_id>` capability + correlation on a verify-FAILURE audit
 * envelope — the request was rejected, so precise content is unavailable and
 * unnecessary.
 */
function routingDescriptorPreVerify(
  envelope: Envelope,
  _subject: string | undefined,
): Pick<DispatchTaskReceivedPayload, "task_id" | "agent_id"> {
  const targetDid = getTargetAssistant(envelope);
  const agentId =
    targetDid !== undefined ? extractAgentIdFromDid(targetDid) : undefined;
  return {
    task_id: envelope.correlation_id ?? envelope.id,
    agent_id: agentId ?? "unknown",
  };
}

/**
 * cortex#1246 NIT — memoise the inbound {@link NetworkKeyring} per networks map.
 * `decryptInboundDispatch` rebuilt the keyring on EVERY sealed/`required`
 * inbound; the `federatedNetworksById` map is constructed once in the listener
 * factory and read-only for its lifetime (`payload_key` is read-only in M3), so
 * keying a `WeakMap` on the map identity yields the same keyring on every call
 * without re-deriving it. The `WeakMap` lets the cache entry GC with the map.
 */
const inboundKeyringByNetworksMap = new WeakMap<
  Map<string, PolicyFederatedNetwork>,
  NetworkKeyring
>();

function inboundKeyringFor(
  networksById: Map<string, PolicyFederatedNetwork>,
): NetworkKeyring {
  let keyring = inboundKeyringByNetworksMap.get(networksById);
  if (keyring === undefined) {
    keyring = buildNetworkKeyring([...networksById.values()]);
    inboundKeyringByNetworksMap.set(networksById, keyring);
  }
  return keyring;
}

/** Outcome of {@link decryptInboundDispatch}. */
type InboundDecryptOutcome =
  | { status: "cleartext"; envelope: Envelope }
  | { status: "opened"; envelope: Envelope }
  | { status: "rejected"; reason: string };

/**
 * M3 (cortex#1241, ADR-0019) — verify-then-DECRYPT step for an inbound
 * `federated` dispatch. Called AFTER `verifySignedByChain` accepts the sealed
 * bytes. Resolves the network (the sealed envelope's `extensions.enc.net`
 * marker, or the source network from the subject for a cleartext inbound) and
 * its `encryption` posture, then applies the transition window via
 * {@link openInboundEnvelope}:
 *   - sealed + key held → decrypt (status "opened");
 *   - cleartext on an `enabled`/`off` network → accept as-is (status "cleartext");
 *   - cleartext on a `required` network, or sealed with a missing/failing key →
 *     "rejected" (the caller drops + logs).
 * The keyring is derived from the network config the listener already holds
 * (`federatedNetworksById`) — no extra wiring, PR5b populates `payload_key`.
 */
async function decryptInboundDispatch(
  envelope: Envelope,
  subject: string | undefined,
  networksById: Map<string, PolicyFederatedNetwork>,
): Promise<InboundDecryptOutcome> {
  const marker = readMarker(envelope);
  const netId = marker?.net ?? extractSourceNetwork(envelope, subject, networksById);
  const netCfg = netId !== undefined ? networksById.get(netId) : undefined;
  const mode = (netCfg?.encryption ?? "off");
  // Fast path: a cleartext envelope on a non-`required` network needs no work
  // (and a non-federated network with no marker never sealed anything).
  if (marker === undefined && mode !== "required") {
    return { status: "cleartext", envelope };
  }
  const keyring = inboundKeyringFor(networksById);
  const outcome = await openInboundEnvelope(envelope, keyring, { mode });
  if (outcome.status === "rejected") {
    return { status: "rejected", reason: outcome.reason };
  }
  return { status: outcome.status, envelope: outcome.envelope };
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
 * `cwd`, `bashAllowlist`, `channel`, etc. are CC-specific. Putting
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
  // GV-2 (cortex#1077): read the canonical `cortex_*` label first, fall back
  // to the legacy `grove_*` alias (a pre-GV-2 source still sends grove only).
  const channelLabel = payload.cortex_channel ?? payload.grove_channel;
  if (channelLabel !== undefined) runtime.channel = channelLabel;
  const networkLabel = payload.cortex_network ?? payload.grove_network;
  if (networkLabel !== undefined) runtime.network = networkLabel;
  if (payload.resume_session_id !== undefined) runtime.resumeSessionId = payload.resume_session_id;
  // ST-P1 (cortex#964) — map the session-tree parent onto the runtime block.
  if (payload.parent_session_id !== undefined) runtime.parentSessionId = payload.parent_session_id;
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
    // cortex#710 — per-skill grants ride the payload's `allowed_skills`.
    // Omitted when the payload didn't carry it (→ harness default-deny).
    ...(payload.allowed_skills !== undefined && {
      allowedSkills: payload.allowed_skills,
    }),
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
  /** TC-0 (#628) — posture-gated empty-chain rejection. */
  rejectEmpty: boolean;
  principalId: string | undefined;
  receivingAgentId: string | undefined;
  /** API-P1.3 (#2063) — receiving agents' runtime configs by id, for substrate selection. */
  agentRuntimesById: Map<string, AgentRuntime> | undefined;
  /** API-P1.3 (#2063) — inference registry the `api-agent` substrate resolves through. */
  inferenceRegistry: InferenceRegistry | undefined;
  /** cortex#480 — receiving stack's signing DID for own-stack trust. */
  stackIdentity: string | undefined;
  /** cortex#480 — receiving stack's NKey pubkey for crypto-verify pass. */
  stackNKeyPub: string | undefined;
  /**
   * TC-1c (#552) — Shape B re-sign signer. When supplied (posture
   * `permissive`/`enforce` + a loaded stack seed), an empty-chain inbound
   * envelope is re-stamped with the stack NKey on ingest. See
   * {@link DispatchListenerOptions.resignSigner}.
   */
  resignSigner: BusEnvelopeSigner | undefined;
  /**
   * TC-2d (cortex#635) — federated.* peer-pubkey resolution seam.
   * Inert for `local.*`; `undefined` unless `signing === "enforce"`.
   */
  resolveFederatedPeer:
    | ((peerPrincipal: string) => Promise<FederatedPeerResolution>)
    | undefined;
  /**
   * cortex#686 (ADR 0001) — federated networks indexed by id, used to resolve
   * the SOURCE network from the SOURCE PRINCIPAL's `peers[]` membership for the
   * `source_network` audit annotation (ADR 0001 — the network is never on the
   * wire). Built once by `createDispatchListener`; empty map = no federation.
   */
  federatedNetworksById: Map<string, PolicyFederatedNetwork>;
  /**
   * cortex#492 — when `true`, emit a `system.dispatch.stage` trace at
   * each gate inside the handler. Resolved by `createDispatchListener`
   * from the explicit option or `CORTEX_TRACE_DISPATCH`; the handler
   * just reads it and passes it to `trace()`.
   */
  traceDispatch: boolean;
  /**
   * cortex#127 — RECEIVING-STACK-AUTHORITATIVE bash allowlist. The
   * executing stack's own `claude.bashAllowlist`, injected onto every
   * `DispatchRequest.runtime` so the spawned session gets
   * `CORTEX_BASH_GUARD` set. NEVER sourced from the wire payload — see
   * {@link DispatchListenerOptions.bashAllowlist}.
   */
  bashAllowlist:
    | { rules: { pattern: string; repos?: string[] }[]; repos: string[] }
    | undefined;
  /**
   * cortex#127 — receiving-stack bash-guard disable flag. Same
   * receiving-side authority as {@link bashAllowlist}. `undefined` today
   * (no config knob); injected onto `DispatchRequest.runtime` when set.
   */
  bashGuardDisabled: boolean | undefined;
  /**
   * R26 P1 (cortex#1371) — admission gate. `undefined` ⇒ `policy.admission`
   * is not configured ⇒ the admission stage is skipped entirely (CO-4
   * inertness). See {@link DispatchListenerOptions.admissionGate}.
   */
  admissionGate: AdmissionGate | undefined;
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
    rejectEmpty,
    principalId,
    receivingAgentId,
    agentRuntimesById,
    inferenceRegistry,
    stackIdentity,
    stackNKeyPub,
    resignSigner,
    resolveFederatedPeer,
    federatedNetworksById,
    traceDispatch,
    bashAllowlist,
    bashGuardDisabled,
    admissionGate,
  } = ctx;
  // cortex#492 — pre-parse trace context from CLEARTEXT METADATA ONLY. M3
  // (cortex#1241, ADR-0019) reorder: NOTHING reads the payload before
  // verify + decrypt — the NATS subject already routed the envelope here, and
  // only cleartext metadata (id, correlation_id) feeds the trace. The trusted
  // payload parse (task_id / agent_id / prompt) + canonical-recipient check run
  // AFTER `verifySignedByChain` and AFTER decrypt, further down. This is a
  // correctness fix independent of encryption: never parse/process the fields
  // of an unverified envelope.
  let traceCtx = rawEnvelopeTraceContext(envelope, subject);
  // M3 — routing identifiers for the PRE-verify deny-audit emitters (chain
  // rejection / receiving-agent guard), derived from cleartext SIGNED metadata
  // only: `task_id` ← `correlation_id`; `agent_id` ← the signed
  // `target_assistant` DID when present (else "unknown" — Offer has no named
  // target). These emitters never touch the sealed payload.
  const preVerifyRouting = routingDescriptorPreVerify(envelope, subject);

  // IAW Phase B wiring (cortex#320, v2.0.2) — verify the envelope's
  // `signed_by[]` chain BEFORE resolving the principal. The runner used
  // to read `signed_by[0].identity` at face value (cortex#220 round 1's
  // "authorization-without-authentication" gap; the field was named
  // `principal` pre-myelin#184). Now we structurally
  // trust-check every ed25519 stamp and, by default, also cryptographically
  // verify each stamp's signature over the JCS-canonical envelope bytes.
  //
  // **`rejectEmpty`** — adapter-originated dispatches
  // (Discord/Mattermost/Slack/cc-events) arrive with no `signed_by[]`.
  // By default (`off`/`permissive` posture) empty chains are legitimate
  // and fall through to the existing PolicyEngine path; only signed
  // chains must verify. TC-0 (#628): under `security.signing: enforce`
  // the resolved `rejectEmpty: true` is threaded here so unsigned
  // adapter dispatches are rejected at the chain gate.
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
      preVerifyRouting,
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
        rejectEmpty,
        cryptoVerify,
        ...(cryptoVerify && principalId !== undefined && { principalId }),
        // cortex#480 — own-stack trust short-circuit + crypto registry
        // entry for self-signed adapter-originated dispatches.
        ...(stackIdentity !== undefined && { stackIdentity }),
        ...(stackNKeyPub !== undefined && { stackNKeyPub }),
        // TC-2d (cortex#635) — federated.* peer-pubkey resolution seam.
        // Inert for local.* dispatches; `undefined` under off/permissive.
        ...(resolveFederatedPeer !== undefined && { resolveFederatedPeer }),
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
        preVerifyRouting,
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
          `task_id=${preVerifyRouting.task_id} agent=${preVerifyRouting.agent_id}): ` +
          `${verification.reason.kind} at chain index ` +
          `${verification.rejectedAt}\n`,
      );
      await emitChainVerificationDeny(
        runtime,
        source,
        envelope,
        preVerifyRouting,
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

  // TC-1c (#552) — Shape B re-sign on ingest. The shared surface gateway
  // (cortex#524) injects inbound dispatches UNSIGNED + `originator`-stamped
  // (Shape A): it runs in a separate process with a signer-less runtime and
  // cannot call `runtime.publish` to sign. When this stack has its own
  // signer (posture `permissive`/`enforce` + a loaded stack seed; `cortex.ts`
  // only passes `resignSigner` then), we re-stamp the envelope HERE — just
  // after the chain verifier accepted it, before the policy gate and the
  // harness — so the stack becomes the cryptographic origin for
  // gateway-injected traffic and the downstream `system.access.*` audit
  // envelopes carry a stack `signed_by[]` stamp (CONTEXT.md §Dispatch-source,
  // decision 2026-06-02). The stack vouches for the request; the gateway
  // stays a pure transport that never touches identity.
  //
  // Gated on an EMPTY chain only. An envelope that already carries a stamp
  // (a real signed dispatch, or our own re-stamped traffic that re-entered
  // the listener) is left untouched — we never double-stamp, which also
  // closes any re-consume loop and preserves the own-stack short-circuit.
  // Policy attribution is unaffected: `resolvePrincipalId`/`getActorPrincipal`
  // read `originator.identity` FIRST (the gateway stamps it) and only fall
  // back to `signed_by[0]` when no originator exists, so appending a stack
  // stamp to a previously-empty chain does not change the resolved principal.
  //
  // In-place (not a bus re-publish): re-publishing on the same
  // `tasks.@{agent}.chat` subject the listener subscribes to would loop, and
  // the SAME dispatch must carry the stamp before the harness runs. We reuse
  // myelin's append-mode `signEnvelope` (the same primitive
  // `MyelinRuntime.signAndPublishOnSubject` uses) and continue with the
  // re-stamped envelope. A sign failure is non-fatal: log + fall through with
  // the original (unsigned) envelope, mirroring the runtime's `fallback`
  // posture — a transient crypto failure must not drop the dispatch.
  if (
    resignSigner !== undefined &&
    getSignedByChain(envelope).length === 0
  ) {
    try {
      const reSignerSeedBase64 = Buffer.from(
        resignSigner.rawSeedBytes,
      ).toString("base64");
      envelope = await signEnvelope(
        envelope as Parameters<typeof signEnvelope>[0],
        reSignerSeedBase64,
        resignSigner.principal,
      );
      trace(
        traceDispatch,
        runtime,
        source,
        "resigned-on-ingest",
        "pass",
        traceCtx,
        resignSigner.principal,
      );
    } catch (err) {
      // Non-fatal — see the `signFailureMode: "fallback"` rationale in
      // `MyelinRuntime.signAndPublishOnSubject`. We deliberately omit
      // `err.message` interpolation: myelin's `signEnvelope` builds error
      // strings from seed inputs, and we don't want partial seed-shape facts
      // landing in logs. The error class + envelope id is enough to triage.
      const reason = err instanceof Error ? err.name : "unknown";
      trace(
        traceDispatch,
        runtime,
        source,
        "resigned-on-ingest",
        "fail",
        traceCtx,
        reason,
      );
      process.stderr.write(
        `[runner/dispatch-listener] re-sign on ingest failed for envelope ` +
          `${envelope.id} (correlation_id=${envelope.correlation_id ?? "<none>"}) ` +
          `reason=${reason} — continuing with unsigned envelope (Shape A fallback)\n`,
      );
    }
  }

  // M3 (cortex#1241, ADR-0019) — VERIFY-THEN-DECRYPT. The chain verified the
  // SEALED bytes above (encrypt-then-sign: `signed_by` covers the ciphertext);
  // now decrypt so the parse/process below reads cleartext. Only `federated`
  // envelopes are ever sealed — `local`/`public` skip entirely (byte-identical
  // to pre-M3). The transition window accepts cleartext-but-signed inbound on
  // an `enabled` network and rejects it on a `required` one. A sealed envelope
  // whose key is missing / fails to open is dropped (logged) — never processed.
  if (envelope.sovereignty.classification === "federated") {
    const decryptOutcome = await decryptInboundDispatch(
      envelope,
      subject,
      federatedNetworksById,
    );
    if (decryptOutcome.status === "rejected") {
      trace(
        traceDispatch,
        runtime,
        source,
        "payload-decrypt-rejected",
        "fail",
        traceCtx,
        decryptOutcome.reason,
      );
      process.stderr.write(
        `[runner/dispatch-listener] dropped federated envelope ${envelope.id} ` +
          `(correlation_id=${envelope.correlation_id ?? "<none>"}): ` +
          `payload decrypt rejected (${decryptOutcome.reason})\n`,
      );
      return;
    }
    // "opened" → cleartext payload restored; "cleartext" → transition accept.
    envelope = decryptOutcome.envelope;
  }

  // M3 reorder — the trusted payload parse + canonical-recipient check NOW run,
  // AFTER verify + decrypt (cortex#1241). `parsePayload` reads task_id /
  // agent_id / prompt from the (now-cleartext) payload.
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
  const sourceNetwork = extractSourceNetwork(envelope, subject, federatedNetworksById);
  let gatedPrincipal: Principal | undefined;
  // R26 P1 (cortex#1371) — in-flight admission lease, acquired by the
  // admission gate below (only when `max_concurrent` tiers are configured)
  // and released in the `finally` around the harness drain: the harness
  // guarantees at least one terminal lifecycle envelope per dispatch, so the
  // drain loop's end IS the dispatch's end.
  let admissionLease: AdmissionLease | undefined;
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

    // R26 P1 (cortex#1371) — ADMISSION GATE (enforcement point 1, design
    // §4.2). Runs AFTER the policy allow and BEFORE harness construction:
    // permanent refusals (policy) come before transient ones (rate) — the
    // gate floor's ordering rule (`gate-floor.ts:195-202`) — and admission
    // KV I/O stays off the path of requests that were going to be denied
    // anyway. Keyed on the SAME principal the policy gate resolved
    // (`decision.principalId` ← `originator.identity` → `signed_by[0]`), so
    // admission and authorization can never key on divergent identities
    // (myelin `specs/admission.md` §1). `admissionGate` is `undefined` when
    // `policy.admission` is absent — this whole stage is then skipped
    // (CO-4 inertness: byte-identical behaviour, zero admission reads).
    if (admissionGate !== undefined) {
      const admission = await admissionGate.check({
        principalId: decision.principalId,
        anonymous: decision.principalId === PUBLIC_PRINCIPAL_ID,
        leaseId: payload.task_id,
      });
      if (!admission.admit) {
        const retryAfterMs = admission.retry_after_ms;
        trace(
          traceDispatch,
          runtime,
          source,
          "admission-checked",
          "fail",
          traceCtx,
          `${admission.reason} tier=${admission.tier}${admission.window !== undefined ? ` window=${admission.window}` : ""}${admission.degraded ? " degraded" : ""}`,
        );
        process.stderr.write(
          `[runner/dispatch-listener] admission throttled envelope ` +
            `${envelope.id} (correlation_id=${envelope.correlation_id ?? "<none>"} ` +
            `task_id=${payload.task_id} principal=${decision.principalId}): ` +
            `${admission.reason} tier=${admission.tier} key=${admission.key}` +
            (admission.window !== undefined ? ` window=${admission.window}` : "") +
            `${admission.limit !== undefined ? ` limit=${admission.limit}` : ""} ` +
            `retry_after_ms=${retryAfterMs}${admission.degraded ? " (degraded)" : ""}\n`,
        );
        // Audit leg — `system.admission.throttled`, the transient sibling of
        // `system.access.denied` (design §4.4). Same audit-common fields so
        // consumers join both streams on correlation/envelope keys.
        const throttled = createSystemAdmissionThrottledEvent({
          ...auditCommon,
          reason: {
            kind: admission.reason,
            tier: admission.tier,
            key: admission.key,
            ...(admission.window !== undefined && { window: admission.window }),
            ...(admission.limit !== undefined && { limit: admission.limit }),
            ...(admission.observed !== undefined && {
              observed: admission.observed,
            }),
            retry_after_ms: retryAfterMs,
            degraded: admission.degraded,
          },
        });
        await runtime.publish(throttled);
        // Lifecycle leg — TERMINAL `not_now` on the dispatch's correlation id
        // (Q6 sign-off): interactive surfaces render `errorSummary` (the
        // friendly string); the structured taxonomy rides `reason.detail` +
        // `retry_after_ms`. NEVER `term` semantics — rate exhaustion is
        // transient by definition.
        const retrySeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
        const now = new Date();
        const failed = createDispatchTaskFailedEvent({
          source,
          taskId: payload.task_id,
          agentId: payload.agent_id,
          startedAt: now,
          failedAt: now,
          errorSummary: `busy — try again in ~${retrySeconds}s`,
          reason: {
            kind: "not_now",
            detail:
              `admission: ${admission.reason === "concurrency" ? "concurrency limit" : admission.reason === "rate" ? "rate limit" : "admission store unavailable"} ` +
              `(principal=${decision.principalId}, tier=${admission.tier}` +
              (admission.window !== undefined ? `, window=${admission.window}` : "") +
              `${admission.limit !== undefined ? `, limit=${admission.limit}` : ""})`,
            retry_after_ms: retryAfterMs,
          },
        });
        await runtime.publish(failed);
        return;
      }
      admissionLease = admission.lease;
      trace(
        traceDispatch,
        runtime,
        source,
        "admission-checked",
        "pass",
        traceCtx,
        admission.degraded ? "degraded-local" : undefined,
      );
    }
  }

  // Per-dispatch harness — see fn-doc above for rationale. `source` is
  // structurally compatible between `SystemEventSource` and the harness's
  // `DispatchEventSource` (both alias the same shape in `dispatch-events.ts`).
  const req = buildDispatchRequest(payload, gatedPrincipal);

  // cortex#127 — RECEIVING-STACK-AUTHORITATIVE bash guard injection.
  //
  // The bus payload carries NO bash allowlist (by design — a remote
  // dispatcher must not be able to weaken/replace/expand the guard on this
  // public-facing surface). Instead the EXECUTING stack's own configured
  // `claude.bashAllowlist` (threaded from `cortex.ts`) is injected onto
  // EVERY dispatch's `runtime` block here, so the spawned CC session gets
  // `CORTEX_BASH_GUARD` set (`runtime.bashAllowlist` → the claude-code
  // harness `buildCCOpts` → `CCSessionOpts.bashAllowlist` → cc-session env
  // serialisation). Without this the guard hook treated the dispatched
  // session as a non-Grove session and fell through to an unanswerable
  // `claude --print` permission prompt, bouncing every allowlisted command
  // and blocking all GUILD-only stacks (cortex#127).
  //
  // Security invariant: this overwrites whatever (if anything) was on
  // `req.runtime.bashAllowlist` — and since `buildDispatchRequest` never
  // populates it from the payload, there is nothing wire-supplied to
  // overwrite. Stack config is the single source of truth. When
  // `bashAllowlist` is undefined (no `claude.bashAllowlist` in config) we
  // inject nothing, preserving default-deny (the guard denies every Bash
  // command in a Grove session that has no allowlist).
  if (bashAllowlist !== undefined || bashGuardDisabled !== undefined) {
    const runtime = req.runtime ?? {};
    if (bashAllowlist !== undefined) runtime.bashAllowlist = bashAllowlist;
    if (bashGuardDisabled !== undefined) {
      runtime.bashGuardDisabled = bashGuardDisabled;
    }
    req.runtime = runtime;
  }

  // API-P0.5 (#2060, D3) — harness selection lives in the HarnessResolver
  // seam, not inline. API-P1.3 (#2063) threads the DISPATCHED-TO agent's
  // runtime config into the seam so `substrate: api-agent` agents resolve
  // through the `ApiAgentHarness`. We look the receiving agent up by
  // `receivingAgentId` in the runtime map (both may be absent — legacy /
  // single-agent stacks — in which case `receivingAgent` is undefined and the
  // resolver falls to the `claude-code` default, byte-identical to pre-P1.3).
  const receivingAgent =
    receivingAgentId !== undefined
      ? agentRuntimesById?.get(receivingAgentId)
      : undefined;
  const harnessResolver = new DefaultHarnessResolver({
    source,
    ccSessionFactory,
    agentTeamFactory,
    ...(inferenceRegistry !== undefined && { inferenceRegistry }),
  });
  const harness: SessionHarness = harnessResolver.resolve(
    receivingAgent,
    envelope.distribution_mode,
  );

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
    // API-P1.3 — trace the ACTUAL resolved substrate (was hard-coded to
    // delegate?agent-team:claude-code; now `api-agent` is a live third value).
    harness.id,
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
  try {
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
  } finally {
    // R26 P1 (cortex#1371) — release the in-flight admission lease when the
    // dispatch terminates (the harness guarantees a terminal envelope, and a
    // throw lands here too). `release` is idempotent and never throws — a
    // failed release is logged gate-side and the lease TTL self-heals.
    if (admissionLease !== undefined && admissionGate !== undefined) {
      await admissionGate.release(admissionLease);
    }
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
 * cortex#686 (ADR 0001, supersedes cortex#661) — resolve the SOURCE network id
 * from the SOURCE PRINCIPAL via deployment topology, NOT from a subject segment.
 *
 * Under ADR 0001 the network is NEVER on the wire: an inbound federated subject
 * is `federated.{target-principal}.{stack}.…` where segment[1] is the RECEIVING
 * principal. The source network is resolved from the source principal (the
 * leading segment of `envelope.source`, via `principalFromEnvelope`) by finding
 * the configured network whose `peers[]` lists that principal — the same
 * `resolveSourceNetwork` topology lookup the federation gate uses. This keeps
 * the `source_network` audit-annotation on `system.access.denied` correct under
 * the conformant grammar instead of mis-tagging it with the receiving principal.
 *
 * Returns the resolved network id, or `undefined` when:
 *   - the envelope is not federated (`local.*` / `public.*` subjects, where the
 *     engine skips the federation branch), or
 *   - the source principal is in no configured network's `peers[]` (the
 *     federation gate has already denied such an envelope before this is read).
 *
 * IAW Phase D.3 (cortex#116) — the consumer of this value is the engine's
 * federation branch + the `system.access.denied` audit annotation.
 */
function extractSourceNetwork(
  envelope: Envelope,
  subject: string | undefined,
  networksById: Map<string, PolicyFederatedNetwork>,
): string | undefined {
  // Only federated traffic carries a source network. Local/public dispatches
  // leave it undefined so the engine skips the federation branch — same
  // contract as the pre-ADR subject-prefix guard.
  if (!subject?.startsWith("federated.")) {
    return undefined;
  }
  const sourcePrincipal = principalFromEnvelope(envelope);
  const resolved = resolveSourceNetwork(sourcePrincipal, networksById);
  return resolved?.networkId;
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
  // M3 (cortex#1241) — narrowed to the cleartext ROUTING identifiers this deny
  // audit needs. A chain-verify failure runs BEFORE decrypt, so the sealed
  // payload is unavailable; the caller passes `routingDescriptorPreVerify(...)`
  // (task_id ← correlation_id, agent_id ← target_assistant DID). A full
  // `DispatchTaskReceivedPayload` is still assignable (post-decrypt callers).
  payload: Pick<DispatchTaskReceivedPayload, "task_id" | "agent_id">,
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
  // M3 (cortex#1241) — narrowed to cleartext ROUTING identifiers (runs
  // pre-verify, pre-decrypt; the sealed payload is unavailable).
  payload: Pick<DispatchTaskReceivedPayload, "task_id" | "agent_id">,
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
