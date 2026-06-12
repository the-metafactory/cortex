/**
 * `brain-consumer.ts` — Bot Packs B-1 (`docs/design-bot-packs.md` §5, §6, §8).
 *
 * The GENERAL capability-dispatch consumer for `kind: exec` brains. It is the
 * bus-side half of the `cortex-brain/v1` per-task seam: it pull-subscribes to
 * the agent's declared (non-code-review) capability task subjects, enforces
 * backpressure + sovereignty BEFORE spawning, runs the brain via
 * {@link RunBrainTask} (`exec-brain-runner.ts`), and routes each brain effect to
 * a host action under policy.
 *
 * ## Relationship to ReviewConsumer
 *
 * Modeled on `review-consumer.ts`'s skeleton (pull subscription per capability,
 * `maxConcurrent` backpressure, sovereignty enforcement, lifecycle envelope
 * publication, drain-on-stop) but GENERAL: where ReviewConsumer hard-codes the
 * `tasks.code-review.<flavor>` subject + the CC review pipeline, BrainConsumer
 * derives `local.{principal}.{stack}.tasks.{capability}` for each of the
 * agent's declared capabilities and runs the brain protocol bridge instead.
 *
 * It reuses the SHARED dispatch lifecycle builders
 * (`createDispatchTaskStartedEvent` / `…CompletedEvent` / `…FailedEvent`) so a
 * brain task's lifecycle stitches onto the dashboard exactly like a review's —
 * no copy-pasted envelope assembly.
 *
 * ## The four brain effect hooks (this consumer's policy seam)
 *
 *   - **`onPost`** — B-1 is BUS-ORIGINATED: there is no live surface session to
 *     post into (the adapter/surface bridge is B-2). So a brain's `post` effect
 *     is published as a `dispatch.task.post` lifecycle envelope carrying the
 *     text/attachment-ref + the task's source triple. We do NOT fake a
 *     `PlatformAdapter` wiring that can't be reached from a bus task — the
 *     honest B-1 behaviour is "publish the post intent onto the bus; B-2 renders
 *     it to the thread".
 *
 *   - **`onAskPrincipal`** — resolved through a pluggable {@link PrincipalGate}.
 *     B-1 ships ONE implementation: {@link DenyAllPrincipalGate}, a fail-closed
 *     placeholder returning `fail` with reason "no principal gate configured
 *     (B-2)". The typed seam is where B-2's real surface gate (the host-side
 *     principal check — the pulse#47 lesson) lands. Tests inject a stub gate
 *     that resolves a real principal + `pass`.
 *
 *   - **`onDispatch`** — enforces TWO host-side ceilings before publishing the
 *     fleet task (§8):
 *       1. the capability MUST be in the manifest's
 *          `brain.dispatch_capabilities[]` allow-list — a brain may dispatch
 *          only what its manifest allows; a violation is `effect_rejected`
 *          (`wont_do`), which the runner delivers back to the brain.
 *       2. sovereignty is DOWNGRADE-ONLY (§5 property 6): the brain's requested
 *          `model_class` may only TIGHTEN the agent's manifest ceiling, never
 *          loosen it. A loosening request is refused the same way.
 *     An allowed dispatch publishes a task envelope on the bus under the
 *     agent's own source identity.
 *
 *   - **`result`** — publishes `dispatch.task.completed` / `dispatch.task.failed`
 *     lifecycle envelopes exactly like ReviewConsumer does, via the shared
 *     builders + the `failedReasonToAckDecision` mapping the JetStream control.
 *
 * ## Lifecycle
 *
 *   1. `new BrainConsumer(opts)` — registers; does NOT subscribe.
 *   2. `await consumer.start(opts)` — opens ONE pull subscription PER declared
 *      capability. `processEnvelope` is the testability seam (drive an envelope
 *      without a real broker).
 *   3. `await consumer.stop()` — drains in-flight brain tasks, stops every
 *      subscription. Idempotent.
 *
 * ## Anti-scope (B-1)
 *
 *   - NOT the daemon lifecycle — socket transport, supervision, drain-on-reload
 *     of a long-lived brain are B-2. This consumer is per-task only.
 *   - NOT the surface bridge — `onPost` publishes a `dispatch.task.post` envelope; the
 *     adapter that renders it is B-2.
 *   - NOT federation — B-1 binds `local.` only; cross-principal brain dispatch
 *     is out of scope.
 */

import type { JsMsg } from "nats";
import type { MyelinRuntime } from "./myelin/runtime";
import type { Envelope } from "./myelin/envelope-validator";
import type { MyelinSubscriber, AckDecision } from "./myelin/subscriber";
import {
  evaluateSovereignty,
  type AgentModelClass,
  type EnvelopeSovereignty,
} from "./sovereignty-gate";
import { buildSource, type SystemEventSource } from "./system-events";
import {
  createDispatchTaskStartedEvent,
  createDispatchTaskCompletedEvent,
  createDispatchTaskFailedEvent,
  createDispatchTaskPostEvent,
  type DispatchTaskFailedReason,
  type BrainPostSource,
} from "./dispatch-events";
import { failedReasonToAckDecision } from "./review-consumer";
import type {
  RunBrainTask,
  BrainTaskHooks,
} from "../brain/exec-brain-runner";
import type {
  TaskEvent,
  TaskSource,
  PostEffect,
  AskPrincipalEffect,
  DispatchEffect,
  ResultEffect,
  GateVerdictValue,
  BrainReason,
} from "../brain/protocol";

// ---------------------------------------------------------------------------
// Principal gate — the ask_principal seam
// ---------------------------------------------------------------------------

/**
 * The host-side principal gate that answers a brain's `ask_principal` effect.
 *
 * The brain NEVER infers a verdict from chat text — the host performs the
 * principal check and forwards a {@link GateVerdictValue} carrying the
 * HOST-RESOLVED principal (the pulse#47 lesson; §5 "Protocol contract
 * details"). This is the typed seam B-2's surface gate plugs into; B-1 ships
 * only {@link DenyAllPrincipalGate}.
 */
export interface PrincipalGate {
  /**
   * Resolve a gate. Returns the verdict + the host-resolved principal id (+
   * optional notes). A `fail` verdict closes the gate negatively; the brain
   * decides how to degrade.
   */
  resolve(input: {
    agentId: string;
    taskId: string;
    gate: string;
    prompt: string;
    source: TaskSource;
  }): Promise<{ verdict: GateVerdictValue; principal: string; notes?: string }>;
}

/**
 * The B-1 fail-closed principal gate. There is no host-side surface gate in
 * B-1 (it lands in B-2), so every `ask_principal` resolves to `fail` with a
 * legible reason. A brain that needs a principal verdict in B-1 must degrade;
 * it can never get a `pass` it wasn't entitled to. The resolved principal is
 * empty because none was checked — paired with `fail`, the brain treats the
 * gate as denied.
 */
export class DenyAllPrincipalGate implements PrincipalGate {
  async resolve(): Promise<{
    verdict: GateVerdictValue;
    principal: string;
    notes?: string;
  }> {
    return {
      verdict: "fail",
      principal: "",
      notes: "no principal gate configured (B-2)",
    };
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal snapshot of an agent's runtime the BrainConsumer needs. Kept narrow
 * so tests build a fixture without the full Zod-validated `Agent`.
 */
/**
 * Finite default concurrency for exec brains (sage cortex#1033 round 3):
 * one subprocess at a time unless the manifest raises it explicitly.
 */
export const DEFAULT_BRAIN_MAX_CONCURRENT = 1;

export interface BrainConsumerAgent {
  /** Logical agent id — stamped onto every emitted envelope. */
  id: string;
  /**
   * The capabilities this brain OFFERS the fleet (`runtime.capabilities`).
   * The consumer binds one subscription per capability and routes inbound
   * `tasks.{capability}` envelopes to the brain.
   */
  capabilities: readonly string[];
  /**
   * The manifest ALLOW-LIST for `dispatch` effects (`brain.dispatch_capabilities`).
   * A brain `dispatch` for a capability NOT in this list is refused host-side
   * (§8). Empty = a brain that may dispatch nothing.
   */
  dispatchCapabilities: readonly string[];
  /** Optional `maxConcurrent` — admit at most this many in-flight tasks. */
  maxConcurrent?: number;
  /**
   * The agent's declared model class — the manifest ceiling for the
   * consumer-side sovereignty gate AND the downgrade-only `dispatch`
   * sovereignty check. Absent → the gate fails closed for local-only tasks.
   */
  modelClass?: AgentModelClass;
}

/**
 * Construction options. Every dependency is injected — no module-scope
 * singletons. Production wires the real `runtime` + `runBrainTask`; tests
 * inject doubles.
 */
export interface BrainConsumerOpts {
  /** The agent this consumer serves. */
  agent: BrainConsumerAgent;
  /** Envelope source `{principal}.{agent}.{instance}` for emitted lifecycle envelopes. */
  source: SystemEventSource;
  /** The myelin runtime — used for `publish` + `subscribePull`. */
  runtime: MyelinRuntime;
  /**
   * The configured per-task brain runner (from `makeExecBrainRunner` over the
   * manifest's `brain` block). Injected so the consumer never owns spawn
   * policy; tests pass a stub that resolves a deterministic result.
   */
  runBrainTask: RunBrainTask;
  /**
   * Optional persona text delivered to the brain on each `task` event (per-task
   * brains receive persona on the task; §5 "Persona delivery"). Omitted → no
   * persona field on the wire.
   */
  persona?: string;
  /**
   * The principal gate answering `ask_principal` effects. Defaults to
   * {@link DenyAllPrincipalGate} (B-1 fail-closed). B-2 injects the surface gate.
   */
  principalGate?: PrincipalGate;
  /**
   * When `true`, the consumer-side sovereignty gate HARD-DENIES a task whose
   * envelope demands a model class the agent's class would violate. When
   * `false`/absent it runs in audit-parity (evaluate + log, but proceed) —
   * mirrors ReviewConsumer's `sovereigntyEnforce` default rationale (a
   * self-declared class is spoofable until bound to the signing identity).
   */
  sovereigntyEnforce?: boolean;
  /** Test seam — clock. Defaults to `() => new Date()`. */
  clock?: () => Date;
}

/**
 * Options for {@link BrainConsumer.start} when binding real JetStream pull
 * consumers. ONE subscription opens per declared capability; the caller
 * supplies a per-capability `(capability) => { pattern, stream, durable }`
 * resolver so the boot wiring owns the subject grammar + durable naming.
 */
export interface BrainConsumerStartOpts {
  /**
   * Resolve the pull-subscription parameters for one capability. Returning
   * `null` skips binding that capability (e.g. a capability with no provisioned
   * stream). The boot path derives
   * `local.{principal}.{stack}.tasks.{capability}` + a per-(agent,capability)
   * durable.
   */
  resolve(capability: string): {
    pattern: string;
    stream: string;
    durable: string;
    maxMessages?: number;
    expiresMs?: number;
    thresholdMessages?: number;
  } | null;
}

/** Boot/log info per the consumer's `start()` outcome. */
export interface BrainConsumerStartedInfo {
  agentId: string;
  capabilities: readonly string[];
  /** Capabilities whose pull subscription actually opened on the broker. */
  subscribedCapabilities: readonly string[];
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

/**
 * Per-agent, capability-addressed brain consumer (Bot Packs B-1).
 */
export class BrainConsumer {
  readonly agent: BrainConsumerAgent;

  private readonly source: SystemEventSource;
  private readonly runtime: MyelinRuntime;
  private readonly runBrainTask: RunBrainTask;
  private readonly persona: string | undefined;
  private readonly principalGate: PrincipalGate;
  private readonly sovereigntyEnforce: boolean;
  private readonly clock: () => Date;

  /** The manifest dispatch allow-list, as a Set for O(1) membership. */
  private readonly dispatchAllow: Set<string>;
  /** Promises for in-flight brain tasks so `stop()` can drain. */
  private readonly inFlight = new Set<Promise<void>>();
  /** Open pull subscriptions (one per bound capability). */
  private readonly subscribers: MyelinSubscriber[] = [];

  private started = false;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

  constructor(opts: BrainConsumerOpts) {
    this.agent = opts.agent;
    this.source = opts.source;
    this.runtime = opts.runtime;
    this.runBrainTask = opts.runBrainTask;
    this.persona = opts.persona;
    this.principalGate = opts.principalGate ?? new DenyAllPrincipalGate();
    this.sovereigntyEnforce = opts.sovereigntyEnforce ?? false;
    this.clock = opts.clock ?? (() => new Date());
    this.dispatchAllow = new Set(opts.agent.dispatchCapabilities);
  }

  /**
   * Bind one pull subscription per declared capability. Idempotent-guarded
   * (throws if already started). A capability whose `resolve` returns null —
   * or whose `subscribePull` returns null (runtime dormant) — is skipped and
   * NOT counted as subscribed, so the boot log can be honest.
   */
  async start(opts: BrainConsumerStartOpts): Promise<BrainConsumerStartedInfo> {
    if (this.started) {
      throw new Error(
        `brain-consumer: already started for agent="${this.agent.id}"`,
      );
    }
    this.started = true;
    const subscribedCapabilities: string[] = [];

    for (const capability of this.agent.capabilities) {
      const resolved = opts.resolve(capability);
      if (resolved === null) continue;

      const subscribePullOpts: {
        pattern: string;
        stream: string;
        durable: string;
        onEnvelope: (envelope: Envelope, subject: string) => Promise<AckDecision>;
        maxMessages?: number;
        expiresMs?: number;
        thresholdMessages?: number;
      } = {
        pattern: resolved.pattern,
        stream: resolved.stream,
        durable: resolved.durable,
        // Capture THIS capability so the routed task carries the right id even
        // though one consumer serves several capabilities.
        onEnvelope: async (envelope, subject) =>
          this.processEnvelope(envelope, subject, null, capability),
      };
      if (resolved.maxMessages !== undefined) {
        subscribePullOpts.maxMessages = resolved.maxMessages;
      }
      if (resolved.expiresMs !== undefined) {
        subscribePullOpts.expiresMs = resolved.expiresMs;
      }
      if (resolved.thresholdMessages !== undefined) {
        subscribePullOpts.thresholdMessages = resolved.thresholdMessages;
      }

      // `subscribePull` is OPTIONAL on MyelinRuntime (the additivity constraint
      // ReviewConsumer also honours). An undefined property or a null return
      // means the runtime is disabled — skip, leave the capability unsubscribed.
      const sub = this.runtime.subscribePull
        ? this.runtime.subscribePull(subscribePullOpts)
        : null;
      if (sub === null) continue;
      this.subscribers.push(sub);
      await sub.ready;
      subscribedCapabilities.push(capability);
    }

    return {
      agentId: this.agent.id,
      capabilities: this.agent.capabilities,
      subscribedCapabilities,
    };
  }

  /**
   * Drive one envelope through the brain. Public for tests (which call this
   * directly without a broker). Always returns an `AckDecision` so the
   * subscriber can drive ack/nak/term without exception handling.
   *
   * Pipeline:
   *   1. backpressure gate (over `maxConcurrent` → nak `not_now`);
   *   2. sovereignty gate (envelope demand vs. agent model class);
   *   3. emit `dispatch.task.started`;
   *   4. run the brain (effects routed to host hooks);
   *   5. publish the terminal `dispatch.task.completed`/`failed` + map the ack.
   */
  async processEnvelope(
    envelope: Envelope,
    _subject: string,
    msg: JsMsg | null,
    capability: string,
  ): Promise<AckDecision> {
    // Avoid an unused-parameter lint on the JsMsg handle: B-1 has no redelivery
    // branch (unlike ReviewConsumer's §2.3 aborted-emit) — the per-task brain
    // re-runs cleanly on redelivery. Kept in the signature for parity + B-2.
    void msg;

    const correlationId = envelope.id;

    // 1. Backpressure (§5 "Backpressure is host-side"). Over the ceiling →
    //    publish a `not_now` failed envelope + nak with a retry hint. An
    //    OMITTED maxConcurrent defaults to a FINITE cap (sage cortex#1033
    //    round 3): every accepted task spawns a subprocess, so an unbounded
    //    default would let a task burst grow processes without limit.
    const concurrencyCap = this.agent.maxConcurrent ?? DEFAULT_BRAIN_MAX_CONCURRENT;
    if (this.inFlight.size >= concurrencyCap) {
      const retryAfterMs = 1000;
      await this.publishFailed(correlationId, {
        kind: "not_now",
        detail: `agent at maxConcurrent (${concurrencyCap}) — try again`,
        retry_after_ms: retryAfterMs,
      });
      return { kind: "nak", delayMs: retryAfterMs };
    }

    // 2. Sovereignty ceiling — BEFORE spawn (the manifest is the ceiling; this
    //    is where it bites). Audit-parity by default; hard-deny under enforce.
    const sov = evaluateSovereignty(
      toEnvelopeSovereignty(envelope),
      this.agent.modelClass,
    );
    if (sov.decision === "deny") {
      if (this.sovereigntyEnforce) {
        process.stderr.write(
          `cortex/brain-consumer: sovereignty DENIED (enforce) for ` +
            `agent="${this.agent.id}" capability=${capability} envelope=${envelope.id} — ${sov.reason}\n`,
        );
        await this.publishFailed(correlationId, {
          kind: "wont_do",
          detail: sov.reason,
        });
        return { kind: "term", reason: `wont_do: ${sov.reason}` };
      }
      // Audit-parity: observable, does not yet bite.
      process.stderr.write(
        `cortex/brain-consumer: sovereignty would DENY (audit-parity) for ` +
          `agent="${this.agent.id}" capability=${capability} envelope=${envelope.id} — ${sov.reason}\n`,
      );
    }

    // 2b. Shutdown guard BEFORE `started` (sage cortex#1033 round 2): a task
    // refused because the consumer is draining must never be recorded as
    // started — publish the not_now failure and nak for the next boot.
    if (this.stopped) {
      await this.publishFailed(correlationId, {
        kind: "not_now",
        detail: "brain consumer is shutting down",
        retry_after_ms: 0,
      });
      return { kind: "nak", delayMs: 0 };
    }

    // 3. Emit dispatch.task.started — paired with the terminal via correlation.
    const startedAt = this.clock();
    await this.safePublish(
      createDispatchTaskStartedEvent({
        source: this.source,
        taskId: crypto.randomUUID(),
        agentId: this.agent.id,
        correlationId,
        startedAt,
      }),
      "dispatch.task.started",
    );

    // 4+5. Run the brain, then publish the terminal envelope + map the ack.
    const taskPromise = this.runOne(
      envelope,
      capability,
      startedAt,
      correlationId,
    );
    const drainSentinel = taskPromise.then(() => undefined);
    this.inFlight.add(drainSentinel);
    try {
      return await taskPromise;
    } finally {
      this.inFlight.delete(drainSentinel);
    }
  }

  /**
   * Stop accepting new envelopes + drain in-flight brain tasks. Idempotent;
   * concurrent callers share one Promise.
   */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopped = true;
      // One subscriber per capability — stop them in one parallel wave
      // (sage cortex#1033 round 2): shutdown latency is the slowest broker
      // stop, not the sum.
      const stops = await Promise.allSettled(this.subscribers.map((sub) => sub.stop()));
      stops.forEach((res) => {
        if (res.status === "rejected") {
          process.stderr.write(
            `brain-consumer: subscriber stop failed for agent=${this.agent.id}: ` +
              `${res.reason instanceof Error ? res.reason.message : String(res.reason)}\n`,
          );
        }
      });
      if (this.inFlight.size > 0) {
        await Promise.allSettled(Array.from(this.inFlight));
      }
    })();
    return this.stopPromise;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Build the `task` event, run the brain with the host hooks, then publish the
   * terminal lifecycle envelope and return the `AckDecision`.
   */
  private async runOne(
    envelope: Envelope,
    capability: string,
    startedAt: Date,
    correlationId: string,
  ): Promise<AckDecision> {
    if (this.stopped) {
      // Mid-shutdown: don't start new brain runs. Publish a failed envelope so
      // a waiter doesn't hang, and nak so the next boot picks it up.
      await this.publishFailed(correlationId, {
        kind: "not_now",
        detail: "brain consumer is shutting down",
        retry_after_ms: 0,
      });
      return { kind: "nak", delayMs: 0 };
    }

    const source = deriveTaskSource(envelope);
    const task: TaskEvent = {
      v: 1,
      type: "task",
      task_id: correlationId,
      capability,
      payload: envelope.payload,
      source,
      ...(this.persona !== undefined && { persona: this.persona }),
    };

    let result: ResultEffect;
    try {
      const run = await this.runBrainTask(task, this.makeHooks(source));
      result = run.result;
    } catch (err) {
      // The runner has a non-throwing contract (it synthesizes a failed result
      // on spawn failure / no-result / timeout), but a future regression could
      // throw. Map to a transient failure so a waiter gets a retry signal.
      const detail = err instanceof Error ? err.message : String(err);
      await this.publishFailed(correlationId, {
        kind: "not_now",
        detail: `brain runner threw unexpectedly: ${detail}`,
        retry_after_ms: 0,
      });
      return { kind: "nak", delayMs: 0 };
    }

    // Terminal: publish completed/failed + map the JetStream control.
    //
    // cortex#1033 §HonestOracle blocker — the terminal envelope IS the task
    // result; downstream waiters join on `dispatch.task.completed`/`…failed` via
    // correlation_id. If that publish fails we must NOT ack: acking a dropped
    // terminal strands the waiter (the result vanishes while the broker believes
    // the task is done). ReviewConsumer's verdict path acks-after-swallow today
    // (its `safePublish` logs-and-returns); rather than copy that latent bug, the
    // brain path naks-with-redelivery so JetStream re-delivers and the per-task
    // brain re-runs cleanly (idempotent — `processEnvelope` re-runs the brain on
    // redelivery, see the §"NOT redelivery branch" note above). The review path
    // retains its pre-existing behaviour (out of scope for this PR — noted in the
    // disposition report).
    if (result.status === "complete") {
      const ok = await this.safePublish(
        createDispatchTaskCompletedEvent({
          source: this.source,
          taskId: crypto.randomUUID(),
          agentId: this.agent.id,
          correlationId,
          startedAt,
          completedAt: this.clock(),
          ...(result.summary !== undefined && { resultSummary: result.summary }),
        }),
        "dispatch.task.completed",
      );
      if (!ok) {
        // Terminal publish lost — redeliver so the result is not silently
        // dropped. `delayMs: 0` lets JetStream re-deliver on its own cadence.
        return { kind: "nak", delayMs: 0 };
      }
      return { kind: "ack" };
    }

    // status === "failed" — carry the brain's typed reason verbatim.
    const reason = brainReasonToDispatchReason(result.reason);
    const failedOk = await this.publishFailed(correlationId, reason);
    if (!failedOk) {
      // Same rule as the completed path: a dropped `dispatch.task.failed` is a
      // lost terminal result — nak-with-redelivery rather than ack the failure
      // into the void.
      return { kind: "nak", delayMs: 0 };
    }
    return failedReasonToAckDecision(reason);
  }

  /**
   * Build the {@link BrainTaskHooks} the runner routes brain effects through.
   * Each hook performs the host action under policy; the runner owns
   * task_id correlation + scratch confinement BEFORE these are called.
   */
  private makeHooks(source: TaskSource): BrainTaskHooks {
    const brainPostSource: BrainPostSource = {
      surface: source.surface,
      channel: source.channel,
      thread: source.thread,
      user: source.user,
    };
    return {
      // `post` — B-1 publishes a `dispatch.task.post` lifecycle envelope (no
      // live surface session; the adapter bridge is B-2). The runner has already
      // validated the attachment SHAPE + scratch confinement. NON-TERMINAL: a
      // lost post is a breadcrumb, not a stranded result, so the `safePublish`
      // success flag is intentionally ignored here.
      onPost: async (post: PostEffect): Promise<void> => {
        await this.safePublish(
          createDispatchTaskPostEvent({
            source: this.source,
            taskId: crypto.randomUUID(),
            agentId: this.agent.id,
            correlationId: post.task_id,
            text: post.text,
            taskSource: brainPostSource,
            ...(post.attachment !== undefined && {
              attachment: post.attachment,
            }),
          }),
          "dispatch.task.post",
        );
      },

      // `ask_principal` — resolve through the pluggable principal gate. B-1's
      // DenyAllPrincipalGate fails closed; a stub gate (tests / B-2) may pass.
      onAskPrincipal: async (
        ask: AskPrincipalEffect,
      ): Promise<{
        verdict: GateVerdictValue;
        principal: string;
        notes?: string;
      }> => {
        const verdict = await this.principalGate.resolve({
          agentId: this.agent.id,
          taskId: ask.task_id,
          gate: ask.gate,
          prompt: ask.prompt,
          source,
        });
        return verdict;
      },

      // `dispatch` — enforce the manifest allow-list + downgrade-only
      // sovereignty BEFORE publishing the fleet task (§8).
      onDispatch: async (
        dispatch: DispatchEffect,
      ): Promise<{ rejected: false } | { rejected: true; reason: BrainReason }> => {
        // Ceiling 1 — capability must be in the manifest dispatch allow-list.
        if (!this.dispatchAllow.has(dispatch.capability)) {
          return {
            rejected: true,
            reason: {
              kind: "wont_do",
              detail: `capability "${dispatch.capability}" is not in the brain's dispatch allow-list`,
            },
          };
        }
        // Ceiling 2 — sovereignty is downgrade-only: the brain may TIGHTEN the
        // agent's manifest model-class ceiling, never loosen it.
        const downgradeCheck = checkDowngradeOnly(
          dispatch.sovereignty?.model_class,
          this.agent.modelClass,
        );
        if (!downgradeCheck.ok) {
          return {
            rejected: true,
            reason: { kind: "wont_do", detail: downgradeCheck.detail },
          };
        }
        // Allowed — publish a fleet task envelope under the agent's identity.
        // SECURITY (cortex#1033 §Security blocker): an OMITTED dispatch
        // sovereignty must inherit the AGENT's manifest ceiling, never default
        // to the loosest class. `checkDowngradeOnly(undefined, …)` above passes
        // (inherit), but the downstream envelope would otherwise be stamped
        // `any`/frontier-ok by `buildDispatchTaskEnvelope`'s fallback — letting a
        // `local-only` brain publish a frontier-allowed task. Resolve the
        // effective class HERE (request ?? agent ceiling) so the published
        // envelope carries the tightened ceiling the downgrade-only check
        // promised. A class-less agent (undefined ceiling) still falls through to
        // `any` inside the builder — that is the documented loosest default.
        await this.safePublish(
          buildDispatchTaskEnvelope({
            source: this.source,
            capability: dispatch.capability,
            payload: dispatch.payload,
            modelClass: dispatch.sovereignty?.model_class ?? this.agent.modelClass,
          }),
          `dispatch:${dispatch.capability}`,
        );
        return { rejected: false };
      },

      // `log` — diagnostic; forwarded to stderr, not surfaced to the principal.
      onLog: (log): void => {
        process.stderr.write(
          `cortex/brain-consumer: [${log.level}] agent=${this.agent.id}: ${log.text}\n`,
        );
      },
    };
  }

  /**
   * Publish a `dispatch.task.failed` envelope for a terminal failure. Returns
   * the underlying `safePublish` success flag so the terminal caller in
   * {@link runOne} can nak-with-redelivery on a dropped terminal (cortex#1033
   * §HonestOracle). The PRE-SPAWN refusal callers in `processEnvelope`
   * (backpressure / sovereignty-deny / shutdown) intentionally ignore the flag:
   * they already carry their own nak/term AckDecision and a lost
   * refusal-breadcrumb does not strand a result the way a dropped post-run
   * terminal does.
   */
  private async publishFailed(
    correlationId: string,
    reason: DispatchTaskFailedReason,
  ): Promise<boolean> {
    const now = this.clock();
    return this.safePublish(
      createDispatchTaskFailedEvent({
        source: this.source,
        taskId: crypto.randomUUID(),
        agentId: this.agent.id,
        correlationId,
        startedAt: now,
        failedAt: now,
        errorSummary: failedSummary(reason),
        reason,
      }),
      "dispatch.task.failed",
    );
  }

  /**
   * Single publish path — traps + logs publish errors (CLAUDE.md "no empty
   * catch blocks"). A failed publish is noisy but must not crash the consumer
   * or prevent `processEnvelope` from returning an `AckDecision`. Mirrors
   * ReviewConsumer's `safePublish` (local-only — B-1 has no federated routing).
   *
   * Returns `true` on a clean publish, `false` when the publish threw (and was
   * logged). NON-TERMINAL callers (`dispatch.task.started`, `dispatch.task.post`)
   * ignore the result — a lost lifecycle breadcrumb is noise, not a correctness
   * breach. The TERMINAL callers (`completed`/`failed`) inspect it: a lost
   * terminal envelope IS a correctness breach (a waiter never sees the result),
   * so they must NOT ack a dropped terminal — see {@link runOne}.
   */
  private async safePublish(envelope: Envelope, label: string): Promise<boolean> {
    try {
      await this.runtime.publish(envelope);
      return true;
    } catch (err) {
      process.stderr.write(
        `brain-consumer: publish failed for ${label} (agent=${this.agent.id}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Derive the brain's `task.source` triple from an inbound envelope. B-1 tasks
 * are bus-originated, so there is no native surface session: `surface` is
 * `"bus"` and the channel/thread/user are read from the envelope's
 * `payload.response_routing` / `payload.source` when present, else empty.
 *
 * The brain sees this only as metadata (§5 property 3); the B-2 surface bridge
 * is what turns a `dispatch.task.post` carrying it into a real thread reply.
 */
export function deriveTaskSource(envelope: Envelope): TaskSource {
  const p = envelope.payload as Record<string, unknown> | undefined;
  const routing =
    p && typeof p.response_routing === "object" && p.response_routing !== null
      ? (p.response_routing as Record<string, unknown>)
      : undefined;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    surface: routing && typeof routing.surface === "string" ? routing.surface : "bus",
    channel: routing ? str(routing.channel) : "",
    thread: routing ? str(routing.thread) : "",
    user: p ? str(p.user) : "",
  };
}

/** Narrow an `Envelope.sovereignty` to the gate's `EnvelopeSovereignty` shape. */
function toEnvelopeSovereignty(envelope: Envelope): EnvelopeSovereignty {
  return {
    model_class: envelope.sovereignty.model_class,
    frontier_ok: envelope.sovereignty.frontier_ok,
  };
}

/**
 * Downgrade-only check for a `dispatch` effect's requested model class (§5
 * property 6). The agent's manifest class is the CEILING; the brain may request
 * an EQUAL or TIGHTER class, never a looser one.
 *
 * Strictness ordering (tighter → looser): `local-only` < `frontier` < `any`.
 * A request to move toward `any` from a tighter ceiling is a LOOSENING and is
 * refused. Requesting nothing (undefined) is always fine — it inherits the
 * ceiling. A class-less agent (undefined ceiling) is treated as the loosest
 * (`any`), so any explicit request is a valid tighten.
 */
export function checkDowngradeOnly(
  requested: string | undefined,
  ceiling: AgentModelClass | undefined,
): { ok: true } | { ok: false; detail: string } {
  if (requested === undefined) return { ok: true };
  const rank: Record<string, number> = {
    "local-only": 0,
    frontier: 1,
    any: 2,
  };
  const reqRank = rank[requested];
  if (reqRank === undefined) {
    return {
      ok: false,
      detail: `unknown requested model_class "${requested}"`,
    };
  }
  // A class-less agent has the loosest ceiling (any).
  const ceilRank = ceiling !== undefined ? rank[ceiling] ?? 2 : 2;
  if (reqRank > ceilRank) {
    return {
      ok: false,
      detail: `dispatch sovereignty may only tighten the manifest ceiling: requested "${requested}" is looser than the agent's "${ceiling ?? "any"}"`,
    };
  }
  return { ok: true };
}

/**
 * Build a fleet `dispatch` task envelope for an ALLOWED brain dispatch. The
 * envelope type is `tasks.{capability}` and carries the brain's payload under
 * the agent's own source identity. The optional `modelClass` (the brain's
 * downgrade request) stamps the envelope sovereignty so the downstream consumer
 * honours the tightened class.
 */
export function buildDispatchTaskEnvelope(opts: {
  source: SystemEventSource;
  capability: string;
  payload: Record<string, unknown>;
  modelClass?: string;
}): Envelope {
  const now = new Date().toISOString();
  const modelClass = isModelClass(opts.modelClass) ? opts.modelClass : "any";
  return {
    id: crypto.randomUUID(),
    source: buildSource(opts.source),
    type: `tasks.${opts.capability}`,
    timestamp: now,
    sovereignty: {
      classification: "local",
      data_residency: opts.source.dataResidency ?? "NZ",
      max_hop: 0,
      // A tightened class implies frontier is NOT permitted; only an explicit
      // `any`/`frontier` clears frontier.
      frontier_ok: modelClass !== "local-only",
      model_class: modelClass,
    },
    payload: opts.payload,
  };
}

function isModelClass(v: string | undefined): v is "local-only" | "frontier" | "any" {
  return v === "local-only" || v === "frontier" || v === "any";
}

/** Map a brain-emitted `result.failed.reason` onto a dispatch failed reason. */
export function brainReasonToDispatchReason(
  reason: BrainReason,
): DispatchTaskFailedReason {
  switch (reason.kind) {
    case "not_now":
      return {
        kind: "not_now",
        detail: reason.detail,
        ...(reason.retry_after_ms !== undefined && {
          retry_after_ms: reason.retry_after_ms,
        }),
      };
    case "cant_do":
      return { kind: "cant_do", detail: reason.detail };
    case "wont_do":
      return { kind: "wont_do", detail: reason.detail };
  }
}

/** A short error summary for the `dispatch.task.failed` envelope. */
function failedSummary(reason: DispatchTaskFailedReason): string {
  if (reason.kind === "policy_denied") {
    return `policy_denied: ${Object.keys(reason.deny).join(",") || "(no detail)"}`;
  }
  return `${reason.kind}: ${reason.detail}`;
}
