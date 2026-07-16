// API-P1.3 (epic #2055, Phase 1, decisions D1/D5) — `ApiAgentHarness`.
//
// The INTEGRATION KEYSTONE of the epic: the `SessionHarness` that turns raw
// provider inference into a Cortex dispatch. It makes `substrate: api-agent` +
// `inferenceProfile: X` dispatch a chat turn end-to-end against a model provider
// resolved through the `InferenceRegistry` — no CLI child, no ConversationStore
// (Phase 2), and NO TOOLS (Phase 3, D5).
//
// SHAPE: mirrors `ClaudeCodeHarness` (`../claude-code/harness.ts`) — the same
// lifecycle-envelope constructors, the same per-dispatch correlation-id
// stabilisation, the same shutdown/active-set discipline — so it is a drop-in on
// the harness-resolver seam (`runner/harness-resolver.ts`).
//
// LIFECYCLE INVARIANT (`SessionHarness` contract): exactly ONE `started` and
// exactly ONE terminal (`completed` / `failed` / `aborted`) per dispatch, all on
// one stable `correlation_id`. Every early-exit path below yields `started` then
// exactly one terminal.
//
// FAIL CLOSED (D5): a request that carries attachments or requires tools/skills
// is rejected with an `unsupported_capability` terminal BEFORE any provider call
// — never silently dropped, and never a network round-trip. Profile resolution
// also fails closed: an unknown profile / missing provider yields a `failed`
// terminal, never a throw deep in the token stream.

import { randomUUID } from "crypto";

import { isUuidLoose } from "../../common/types/uuid";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { InferenceRegistry } from "../../common/inference/registry";
import type { ModelMessage, ModelRequest } from "../../common/inference/types";
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
import {
  truncateDispatchErrorSummary,
  truncateDispatchResultSummary,
} from "../../bus/dispatch-lifecycle-summary";
import { runAgentLoop, type AgentLoopOutcome, type AgentLoopUsage } from "./agent-loop";

// Q6 defaults (design §"Streaming and lifecycle") — the same two-cap model the
// substrate protocol documents on `DispatchRequest.timeoutMs` / `inactivityMs`.
const DEFAULT_WALL_CLOCK_MS = 300_000;
const DEFAULT_INACTIVITY_MS = 60_000;

/** Module-scope warn-once latch for non-UUID `requestId` substitution. */
let warnedNonUuidRequestId = false;

/** Test-only reset of the module-scope warn-once latch. */
export function __resetApiAgentWarnedNonUuidRequestId(): void {
  warnedNonUuidRequestId = false;
}

/** Constructor options for {@link ApiAgentHarness}. */
export interface ApiAgentHarnessOpts {
  /** Envelope source triple stamped onto every lifecycle envelope. */
  source: DispatchEventSource;
  /** The inference registry the harness resolves its profile through (fail closed). */
  registry: InferenceRegistry;
  /**
   * The receiving agent's `inferenceProfile` name (from its `runtime` block).
   * `undefined` → the harness fails closed at dispatch (a clear terminal), never
   * silently falling back to a default model.
   */
  inferenceProfile: string | undefined;
  /** Optional declared capabilities (surfaces on `harness.capabilities`). */
  capabilities?: Capability[];
  /** Injectable clock (tests). Threaded to the agent loop. */
  now?: () => number;
}

/**
 * Reason a dispatch is refused up front (D5). `undefined` ⇒ serviceable.
 * Checked BEFORE any provider call so a tool/attachment request costs zero
 * network.
 */
function unsupportedCapabilityReason(req: DispatchRequest): string | undefined {
  if (req.tools.allow.length > 0) {
    return "the api-agent substrate does not execute tools (Phase 3)";
  }
  if (req.allowedSkills !== undefined && req.allowedSkills.length > 0) {
    return "the api-agent substrate does not grant skills (Phase 3)";
  }
  for (const ctx of req.context) {
    if (ctx.kind !== "attachments") continue;
    const data = ctx.data;
    const nonEmpty = Array.isArray(data) ? data.length > 0 : data != null;
    if (nonEmpty) return "the api-agent substrate does not accept attachments";
  }
  return undefined;
}

/**
 * Build a normalized {@link ModelRequest} FROM THE DISPATCH REQUEST. Phase 1
 * rebuilds the "conversation" from the request alone (no ConversationStore —
 * that's Phase 2): the persona/system becomes `instructions`, and the prompt
 * becomes the single user turn. Text only (D5/Phase 1).
 */
function buildModelRequest(req: DispatchRequest, model: string): ModelRequest {
  const messages: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: req.prompt }] },
  ];
  const instructions = req.persona?.content;
  return {
    model,
    ...(instructions !== undefined && instructions !== ""
      ? { instructions }
      : {}),
    messages,
  };
}

/**
 * Stamp usage + provider request id onto a `completed` envelope's payload using
 * Mission Control's existing token field names (`input_tokens` / `output_tokens`
 * / `cache_read_tokens`) plus `provider_request_id` for cross-system
 * correlation. The myelin schema accepts additional payload properties (same
 * mechanism `cc_session_id` / `response_routing` ride), so this widens the
 * payload without a wire-grammar change. Cost is left unset (the provider
 * reports tokens, not price) — MC reads a NULL cost column as an honest 0.
 */
function stampUsage(
  env: Envelope,
  usage: AgentLoopUsage | undefined,
  providerRequestId: string | undefined,
): Envelope {
  if (usage === undefined && providerRequestId === undefined) return env;
  return {
    ...env,
    payload: {
      ...env.payload,
      ...(usage !== undefined
        ? {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            ...(usage.cacheReadTokens !== undefined
              ? { cache_read_tokens: usage.cacheReadTokens }
              : {}),
          }
        : {}),
      ...(providerRequestId !== undefined
        ? { provider_request_id: providerRequestId }
        : {}),
    },
  };
}

/**
 * Direct-API substrate harness — streams a model provider resolved through the
 * `InferenceRegistry` and reduces it to a Cortex dispatch lifecycle. See the
 * file header for the full contract.
 */
export class ApiAgentHarness implements SessionHarness {
  readonly id = "api-agent" as const;
  readonly capabilities: Capability[];

  private readonly source: DispatchEventSource;
  private readonly registry: InferenceRegistry;
  private readonly inferenceProfile: string | undefined;
  private readonly now: (() => number) | undefined;

  /**
   * In-flight dispatches' abort controllers — `shutdown({ graceful: false })`
   * aborts them so active agent loops settle to an `aborted` terminal fast.
   */
  private readonly activeControllers = new Set<AbortController>();
  private shuttingDown = false;

  constructor(opts: ApiAgentHarnessOpts) {
    this.source = opts.source;
    this.registry = opts.registry;
    this.inferenceProfile = opts.inferenceProfile;
    this.capabilities = opts.capabilities ?? [];
    this.now = opts.now;
  }

  async *dispatch(req: DispatchRequest): AsyncIterable<MyelinEnvelope> {
    const correlationId = this.correlationFor(req);
    const startedAt = new Date();
    yield this.buildStarted(req, startedAt, correlationId);

    if (this.shuttingDown) {
      yield this.buildFailed(req, startedAt, correlationId, "harness shutting down");
      return;
    }

    // FAIL CLOSED (D5) — reject tools/attachments BEFORE any provider call. Zero
    // network: we never construct or stream the provider on this path.
    const unsupported = unsupportedCapabilityReason(req);
    if (unsupported !== undefined) {
      yield this.buildFailed(
        req,
        startedAt,
        correlationId,
        `unsupported_capability: ${unsupported}`,
      );
      return;
    }

    // Resolve the agent's inference profile — fail closed to a terminal, never a
    // throw. An absent profile is a config error surfaced as a clear failure.
    if (this.inferenceProfile === undefined) {
      yield this.buildFailed(
        req,
        startedAt,
        correlationId,
        "api-agent dispatch has no inferenceProfile configured",
      );
      return;
    }
    const resolution = this.registry.resolveProfile(this.inferenceProfile);
    if (!resolution.ok) {
      yield this.buildFailed(req, startedAt, correlationId, resolution.error.message);
      return;
    }
    const resolved = resolution.profile;

    const request = buildModelRequest(req, resolved.model);

    // One controller per dispatch, tracked for shutdown-driven cancellation.
    const controller = new AbortController();
    this.activeControllers.add(controller);
    // Close the race with a shutdown that landed between the flag check above
    // and this registration (`shutdown` can flip the flag from another task
    // between those two points). Read via a method so control-flow analysis
    // does not narrow the field to the `false` it held at the earlier check.
    if (this.isShuttingDown()) controller.abort();

    let outcome: AgentLoopOutcome;
    try {
      outcome = await runAgentLoop({
        provider: resolved.provider,
        request,
        wallClockMs: req.timeoutMs ?? DEFAULT_WALL_CLOCK_MS,
        inactivityMs: req.inactivityMs ?? DEFAULT_INACTIVITY_MS,
        signal: controller.signal,
        ...(this.now !== undefined ? { now: this.now } : {}),
      });
    } catch (err) {
      // The loop is defensive and should not throw, but a raw error must never
      // escape to the runner (it could carry provider detail). Map to a failed
      // terminal with a fixed, redacted summary; log the raw message to stderr.
      process.stderr.write(
        `api-agent-harness: agent loop threw: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      outcome = { kind: "failed", summary: "agent loop error" };
    } finally {
      this.activeControllers.delete(controller);
    }

    yield this.buildTerminal(req, startedAt, correlationId, outcome);
  }

  // Substrate contract — `shutdown` is `Promise<void>`; the body is synchronous
  // (aborts are issued, active loops observe them via the signal), so the
  // require-await rule fires. The contract wins, matching ClaudeCodeHarness.
  // eslint-disable-next-line @typescript-eslint/require-await
  async shutdown(opts: { graceful: boolean }): Promise<void> {
    this.shuttingDown = true;
    if (opts.graceful) return;
    for (const controller of this.activeControllers) {
      try {
        controller.abort();
      } catch (err) {
        // Aborting an already-settled controller can throw on some runtimes;
        // log and continue so every in-flight dispatch is signalled.
        process.stderr.write(
          `api-agent-harness: shutdown abort failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Read the shutdown flag through a call boundary (defeats CFA narrowing). */
  private isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Per-dispatch correlation key — `requestId` when UUID-shaped, else a fresh
   * UUID (the envelope schema only admits UUID `correlation_id`). Mirrors the
   * claude-code harness's defensive substitution, with a one-time warning.
   */
  private correlationFor(req: DispatchRequest): string {
    if (isUuidLoose(req.requestId)) return req.requestId;
    if (!warnedNonUuidRequestId) {
      console.warn(
        `api-agent-harness: requestId "${req.requestId}" is not UUID-shaped — ` +
          `substituting a generated correlation_id (this warning fires once per process)`,
      );
      warnedNonUuidRequestId = true;
    }
    return randomUUID();
  }

  private buildStarted(
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

  private buildFailed(
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
      errorSummary: truncateDispatchErrorSummary(errorSummary),
    });
  }

  private buildTerminal(
    req: DispatchRequest,
    startedAt: Date,
    correlationId: string,
    outcome: AgentLoopOutcome,
  ): Envelope {
    switch (outcome.kind) {
      case "completed": {
        const env = createDispatchTaskCompletedEvent({
          source: this.source,
          taskId: req.requestId,
          agentId: req.agent.id,
          correlationId,
          startedAt,
          completedAt: new Date(),
          ...(outcome.text !== ""
            ? {
                resultSummary: truncateDispatchResultSummary(outcome.text),
                // Full assistant reply for the chat round-trip (dispatch sink).
                chatResponse: outcome.text,
              }
            : {}),
        });
        return stampUsage(env, outcome.usage, outcome.providerRequestId);
      }
      case "aborted":
        return createDispatchTaskAbortedEvent({
          source: this.source,
          taskId: req.requestId,
          agentId: req.agent.id,
          correlationId,
          startedAt,
          abortedAt: new Date(),
          reason: outcome.reason,
        });
      case "failed":
      default:
        return this.buildFailed(
          req,
          startedAt,
          correlationId,
          outcome.summary,
        );
    }
  }
}
