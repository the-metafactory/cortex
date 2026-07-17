/**
 * F-2.1 (cortex#835) — `dev.implement` capability consumer.
 *
 * The one genuinely NEW piece of the agentic dev pipeline
 * (`docs/design-agentic-dev-pipeline.md` §3.1 dev-agent row, §3.4 step 2,
 * §3.5b authority, §3.6b warm sessions). Mirrors `bus/review-consumer.ts`
 * shape-for-shape — that consumer is the reference for claim semantics,
 * lifecycle co-emission, typed-failure → ack/term/nak mapping, the
 * `processEnvelope`/`start` testability split, and `correlation_id`
 * discipline. Where this consumer DIVERGES (it acts: worktree → CC →
 * gates → PR) every action is behind an INJECTED seam so tests drive the
 * full pipeline with fakes and never spawn real `claude`/`git`/`gh`.
 *
 * **DORMANT BY DEFAULT — the hard safety contract.** The consumer is only
 * instantiated + started by the boot wiring (`src/cortex.ts`) for an agent
 * that declares a `dev.implement*` capability in `runtime.capabilities[]`.
 * Every live stack today declares none, so boot is byte-identical: nothing
 * subscribes, nothing acts. This file ships the consumer + its boot helper;
 * the boot wiring gates on the capability exactly the way the review path
 * gates on `code-review*`.
 *
 * **Per-envelope pipeline (one `tasks.dev.implement` task):**
 *   1. redelivery > 1 → emit `dispatch.task.aborted` (advisory) then continue.
 *   2. validate subject (`tasks.dev.implement`) — else `cant_do` + term.
 *   3. validate payload (repo/branch/base/brief) — else `cant_do` + term.
 *   4. capability gate — agent must claim `dev.implement` — else `cant_do` + term.
 *   5. concurrency gate — at `maxConcurrent` → `not_now` + nak.
 *   6. emit `dispatch.task.started`.
 *   7. run the pipeline: worktree → CC session (warm-resume if the chain has
 *      a stored session) → gates → push + PR → emit `dispatch.task.completed
 *      {pr}` OR `dispatch.task.failed` with a typed reason:
 *        - gates red          → `cant_do` (detail names the failing gate).
 *        - worktree/forge err  → `cant_do` (detail names the step).
 *        - mid-shutdown        → `not_now` (nak).
 *   8. record the CC session id under the chain id so the next fix-cycle task
 *      resumes it (§3.6b).
 *
 * **Slice convergence A (cortex#1148):** every lifecycle envelope this
 * consumer emits ECHOES the inbound request's `payload.response_routing`
 * (the slice's logical thread address) verbatim, so a downstream surface can
 * group all of a slice's activity by that address. Pure echo — the SOURCE
 * that stamps the address is the orchestrator (pilot A′); the worker reads it
 * (via `readLogicalRouting`) and forwards it, adding NO routing/naming logic
 * (workers are capability-routed and mutually anonymous). An un-stamped
 * inbound (no `response_routing`) ⇒ no field emitted (backward compatible).
 *
 * **typed-failure → ack/term/nak** is the SAME mapping `review-consumer.ts`
 * locks in (`failedReasonToAckDecision`): `cant_do`/`wont_do`/`policy_denied`
 * → term (permanent); `not_now` → nak (transient).
 *
 * **Anti-scope (per task spec):** NOT pulse process hosting (F-3); NOT
 * `release.cut` (F-4); NOT remote backends (F-5b); NOT pilot-side dispatch.
 * NOT a registry — the capability claim is built from the constructor's
 * agent snapshot. NOT a renderer — emitted lifecycle envelopes flow through
 * the existing surface-router fan-out (worklog-manager renders them).
 */

import type { JsMsg } from "nats";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { MyelinSubscriber, AckDecision } from "../bus/myelin/subscriber";
import {
  createDispatchTaskStartedEvent,
  createDispatchTaskCompletedEvent,
  createDispatchTaskFailedEvent,
  createDispatchTaskAbortedEvent,
  type DispatchEventSource,
  type DispatchTaskFailedReason,
  type AnyResponseRouting,
} from "../bus/dispatch-events";
import type { GateFloorDecision } from "../bus/gate-floor";
import {
  parseDevImplementPayload,
  devCorrelationChainId,
  type DevImplementPayload,
} from "../bus/dev-events";
import type { CCSessionFactory, CCSessionLike } from "../substrates/claude-code/harness";
import type { CCSessionOpts, CCSessionResult } from "./cc-session";
import type { DevSessionStore } from "./dev-session-store";
import { readLogicalRouting } from "../adapters/response-routing-delivery";
import { decidePostSessionAction, type DevWorktreeStatus } from "./dev-worktree";
import { anyAdvertisedSegmentPrefixMatches } from "../common/types/capability-window";

// ---------------------------------------------------------------------------
// Injected seams — the testability + authority surface
// ---------------------------------------------------------------------------

/**
 * Worktree management seam (worktree-discipline SOP). Production wires a
 * real `git worktree` runner; tests inject a fake that records calls and
 * returns a fixed path. Kept narrow — the consumer needs exactly create +
 * remove, nothing else.
 */
export interface DevWorkspace {
  /**
   * Create a worktree for `branch` cut from `base` of `repo`, returning the
   * absolute path the CC session runs in (the worktree-discipline
   * `../Cortex-{slug}` pattern is the runner's to honour). Throws on
   * failure — the consumer maps the throw to a `cant_do` failure.
   */
  create(opts: {
    repo: string;
    branch: string;
    base: string;
    chainId: string;
  }): Promise<{ path: string }>;
  /** Remove a worktree (terminal cleanup; best-effort — failure logs only). */
  remove(opts: { path: string }): Promise<void>;
}

/**
 * Gate command runner. Production runs each declared gate command in the
 * worktree (e.g. `bunx tsc --noEmit`); tests inject a fake that returns a
 * fixed pass/fail. The consumer runs gates in declared order and STOPS at
 * the first failure (fail-fast — a red `tsc` means the branch isn't worth
 * linting yet).
 */
export interface DevCommandRunner {
  /**
   * Run one gate command in `cwd`. Resolves with the outcome; a non-zero
   * exit is `{ ok: false }`, NOT a throw (a failing gate is a normal,
   * expected result, not an exception). A throw (the command couldn't be
   * spawned at all) is treated by the consumer as a gate failure too.
   */
  run(opts: { command: string; cwd: string }): Promise<DevCommandResult>;
}

export interface DevCommandResult {
  ok: boolean;
  /** Short tail of stdout/stderr for the failure detail. Optional. */
  output?: string;
}

/**
 * Forge seam — push the branch + open the PR (§3.5b authority model). The
 * dev agent's forge identity is the forge implementation's concern (it
 * closes over the scoped credential); the consumer never sees the token.
 * Production wires a `git push` + `gh pr create` runner bound to the agent's
 * scoped credential; tests inject a fake returning a fixed PR ref.
 */
export interface DevForge {
  /**
   * Push the worktree branch and open a PR. Returns the PR reference. Throws
   * on failure — the consumer maps the throw to a `cant_do` failure.
   */
  openPr(opts: {
    repo: string;
    branch: string;
    base: string;
    cwd: string;
    title?: string;
    issue?: number;
    brief: string;
  }): Promise<DevPrRef>;
}

/** A reference to the PR the dev agent opened. Rides `dispatch.task.completed`. */
export interface DevPrRef {
  /** `owner/name`, echoed from the request. */
  repo: string;
  /** PR number. */
  number: number;
  /** Deep link to the PR. */
  url: string;
}

/**
 * Commit-safety seam (cortex#1230 Bug 2). After the CC session and before the
 * forge push, the consumer inspects the worktree's git state and, if the agent
 * edited but forgot to commit, commits the leftover so the run isn't lost.
 * Production wires real `git` (see `dev-consumer-boot.ts`); tests inject git
 * state. Kept narrow — exactly inspect + commit.
 */
export interface DevGitInspector {
  /**
   * Inspect the worktree at `cwd`: commits ahead of `origin/<base>` and whether
   * the working tree has uncommitted changes (tracked or untracked). Throws on
   * a git failure — the consumer maps the throw to a `cant_do` failure.
   */
  status(opts: {
    cwd: string;
    base: string;
    branch: string;
  }): Promise<DevWorktreeStatus>;
  /**
   * Commit ALL changes in the worktree at `cwd` with `message` (the fallback
   * commit when the agent forgot). MUST produce a SIGNED commit — the forge
   * push boundary refuses unsigned commits (W5.0). Throws on failure.
   */
  commitAll(opts: { cwd: string; message: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Construction options
// ---------------------------------------------------------------------------

/**
 * Minimal snapshot of cortex.yaml `agents[]` data the consumer needs. Kept
 * narrow so tests build a fixture without the full Zod `Agent` shape —
 * mirrors `ReviewConsumerAgent`.
 */
export interface DevConsumerAgent {
  /** Logical agent id (e.g. `"forge"`). Stamped onto every emitted envelope. */
  id: string;
  /**
   * Capability ids this agent claims, e.g. `["dev.implement"]`. The consumer
   * claims a task when it holds `dev.implement` (exact) or the bare `dev`
   * capability (wildcard over the dev family).
   */
  capabilities: readonly string[];
  /**
   * Optional per-agent `maxConcurrent`. When set, the consumer admits at most
   * `maxConcurrent` in-flight implements; further tasks nak `not_now`. When
   * undefined, `DEFAULT_MAX_CONCURRENT` (1) applies — a dev implement is a
   * heavy, long-running action and serial-by-default is the safe posture
   * (parallel claims across repos are a deliberate opt-in via a higher cap;
   * worktree isolation makes them safe — design §3.5 row "dev concurrency").
   */
  maxConcurrent?: number;
}

/**
 * Per-request CC prompt builder. Production assembles the security preamble
 * + the brief + the assistant prefix; tests inject a deterministic stub.
 * Returning a string (not `CCSessionOpts`) keeps the consumer free of
 * skill-allowlist / cwd / timeout policy — those flow through `sessionOpts`.
 * Mirrors `ReviewPromptBuilder`.
 */
export type DevPromptBuilder = (input: {
  agentId: string;
  payload: DevImplementPayload;
}) => string;

/** Construction options. Every dependency injected — no module-scope singletons. */
/**
 * CO-2/CO-4 (epic cortex#939) — the per-offer-scope ADMISSION GATE seam for the
 * dev lane (structural twin of `bus/review-consumer.ts`'s `OfferAdmissionGate`).
 * Given an inbound envelope + the subject it arrived on, returns the gate-floor
 * decision for the offer-scope that subject's prefix denotes. Production wires
 * `admitOfferedDispatch` (CO-4); omit to disable.
 *
 * BYTE-IDENTICAL: a `local.` subject (the only scope bound with no
 * `policy.offerings`) admits unconditionally, so the gate is inert today; it
 * bites only on the `federated.`/`public.` subjects CO-2 newly binds.
 */
export type DevOfferAdmissionGate = (
  envelope: Envelope,
  subject: string,
) => GateFloorDecision;

export interface DevConsumerOpts {
  /** The agent this consumer serves. One consumer per agent. */
  agent: DevConsumerAgent;
  /** Envelope source (`{principal}.{agent}.{instance}`). */
  source: DispatchEventSource;
  /** The myelin runtime — used for `publish` of lifecycle envelopes. */
  runtime: MyelinRuntime;
  /** CC session factory — the execution seam. Tests inject a fake. */
  ccSessionFactory: CCSessionFactory;
  /** Per-request CC prompt builder. */
  promptBuilder: DevPromptBuilder;
  /** Worktree create/remove seam. */
  workspace: DevWorkspace;
  /** Gate command runner seam. */
  commandRunner: DevCommandRunner;
  /** Forge push + PR-open seam (carries the agent's scoped identity). */
  forge: DevForge;
  /**
   * Commit-safety seam (cortex#1230 Bug 2) — inspect the worktree's git state
   * after the CC session and commit leftover changes the agent forgot. Tests
   * inject git state; production wires real `git`.
   */
  gitInspector: DevGitInspector;
  /**
   * Warm-session store (§3.6b). Maps correlation-chain id → CC session id so
   * a fix-cycle resumes the implement session. Tests inject
   * `MemoryDevSessionStore`; production wires `FileDevSessionStore`.
   */
  sessionStore: DevSessionStore;
  /**
   * Optional per-request `CCSessionOpts` overrides (cwd is set by the
   * consumer to the worktree path; allowedDirs/bashAllowlist/timeouts flow
   * through here). `resumeSessionId` is injected by the consumer for warm
   * resume — a value here is ignored on the warm path.
   */
  sessionOpts?: Partial<Omit<CCSessionOpts, "prompt" | "cwd" | "resumeSessionId">>;
  /**
   * CO-2/CO-4 (epic cortex#939) — the per-offer-scope admission gate. Runs
   * after the subject/payload checks, before the capability gate. Omit to
   * disable (the default — byte-identical to pre-CO-2). See
   * {@link DevOfferAdmissionGate}.
   */
  offerAdmission?: DevOfferAdmissionGate;
  /** Test seam — clock. Defaults to `() => new Date()`. */
  clock?: () => Date;
}

/**
 * Boot/log entry the consumer produces — surfaced so `src/cortex.ts` can
 * render a uniform "ready"/"DORMANT" line. `subscribed: false` when the
 * runtime is disabled (no NATS / G-1111 pending) so the boot path logs
 * honestly. Mirrors `ReviewConsumerStartedInfo`.
 */
export interface DevConsumerStartedInfo {
  agentId: string;
  subscribed: boolean;
}

/** Options for {@link DevConsumer.start} when binding a JetStream pull consumer. */
export interface DevConsumerStartOpts {
  /** Subject pattern, e.g. `local.{principal}.{stack}.tasks.dev.implement`. */
  pattern: string;
  /** JetStream stream name carrying the bound consumer. */
  stream: string;
  /** Durable consumer name. */
  durable: string;
  maxMessages?: number;
  expiresMs?: number;
  thresholdMessages?: number;
}

/** Default per-consumer concurrency — serial. See {@link DevConsumerAgent.maxConcurrent}. */
export const DEFAULT_MAX_CONCURRENT = 1;

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

export class DevConsumer {
  readonly agent: DevConsumerAgent;

  private readonly source: DispatchEventSource;
  private readonly runtime: MyelinRuntime;
  private readonly ccSessionFactory: CCSessionFactory;
  private readonly promptBuilder: DevPromptBuilder;
  private readonly workspace: DevWorkspace;
  private readonly commandRunner: DevCommandRunner;
  private readonly forge: DevForge;
  private readonly gitInspector: DevGitInspector;
  private readonly sessionStore: DevSessionStore;
  private readonly sessionOpts?: Partial<
    Omit<CCSessionOpts, "prompt" | "cwd" | "resumeSessionId">
  >;
  /** CO-2/CO-4 — per-offer-scope admission gate. Undefined disables the gate. */
  private readonly offerAdmission: DevOfferAdmissionGate | undefined;
  private readonly clock: () => Date;
  /** Effective concurrency cap — agent value or the serial default. */
  private readonly maxConcurrent: number;

  /** In-flight pipelines so `stop()` can drain. */
  private readonly inFlight = new Set<Promise<void>>();

  private subscriber: MyelinSubscriber | null = null;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

  constructor(opts: DevConsumerOpts) {
    this.agent = opts.agent;
    this.source = opts.source;
    this.runtime = opts.runtime;
    this.ccSessionFactory = opts.ccSessionFactory;
    this.promptBuilder = opts.promptBuilder;
    this.workspace = opts.workspace;
    this.commandRunner = opts.commandRunner;
    this.forge = opts.forge;
    this.gitInspector = opts.gitInspector;
    this.sessionStore = opts.sessionStore;
    if (opts.sessionOpts !== undefined) this.sessionOpts = opts.sessionOpts;
    this.offerAdmission = opts.offerAdmission;
    this.clock = opts.clock ?? (() => new Date());
    this.maxConcurrent = opts.agent.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  /**
   * Bind a JetStream pull consumer and start delivering envelopes into
   * `processEnvelope`. Returns `subscribed: false` (dormant) when the runtime
   * is disabled or omits `subscribePull` — the boot path logs DORMANT and the
   * consumer's drain works against the empty in-flight set. Same contract as
   * `ReviewConsumer.start`.
   */
  async start(opts: DevConsumerStartOpts): Promise<DevConsumerStartedInfo> {
    if (this.subscriber !== null) {
      throw new Error(`dev-consumer: already started for agent="${this.agent.id}"`);
    }
    const subscribePullOpts: {
      pattern: string;
      stream: string;
      durable: string;
      onEnvelope: (envelope: Envelope, subject: string) => Promise<AckDecision>;
      maxMessages?: number;
      expiresMs?: number;
      thresholdMessages?: number;
    } = {
      pattern: opts.pattern,
      stream: opts.stream,
      durable: opts.durable,
      onEnvelope: async (envelope, subject) =>
        this.processEnvelope(envelope, subject, null),
    };
    if (opts.maxMessages !== undefined) subscribePullOpts.maxMessages = opts.maxMessages;
    if (opts.expiresMs !== undefined) subscribePullOpts.expiresMs = opts.expiresMs;
    if (opts.thresholdMessages !== undefined) {
      subscribePullOpts.thresholdMessages = opts.thresholdMessages;
    }
    const sub = this.runtime.subscribePull
      ? this.runtime.subscribePull(subscribePullOpts)
      : null;
    if (sub === null) {
      return { agentId: this.agent.id, subscribed: false };
    }
    this.subscriber = sub;
    await this.subscriber.ready;
    return { agentId: this.agent.id, subscribed: true };
  }

  /**
   * Drive one envelope through the pipeline. Public for tests (which call it
   * directly); production arrives via `start()`'s `onEnvelope` handler.
   *
   * `msg` carries `info.redeliveryCount` for the redelivery aborted-emit;
   * tests pass `null` to skip that branch. ALWAYS returns an `AckDecision`.
   */
  async processEnvelope(
    envelope: Envelope,
    subject: string,
    msg: JsMsg | null,
  ): Promise<AckDecision> {
    // Redelivery > 1 → advisory `dispatch.task.aborted` BEFORE re-running.
    // Mirrors review-consumer §2.3: the per-attempt pipeline still runs and
    // emits its own terminal envelope; this is the early "in trouble" signal
    // so a watcher can react before the dead-letter window runs out.
    // Slice convergence A (cortex#1148) — read the slice's logical thread
    // address off the inbound request ONCE, then echo it verbatim onto every
    // lifecycle envelope this consumer emits, so a downstream surface can
    // group all of a slice's activity by that address. PURE ECHO: the SOURCE
    // that stamps `response_routing` is the orchestrator (pilot A′); the
    // worker reads it and forwards it, adding no routing/naming logic (workers
    // are capability-routed and mutually anonymous). `undefined` (the inbound
    // carried none) means "pass nothing" — behaviour for un-stamped dispatches
    // is byte-identical (backward compatible). The review path reads the SAME
    // logical shape (`bus/review-consumer.ts` `readLogicalResponseRouting`).
    const responseRouting = readLogicalRouting(envelope) ?? undefined;

    const deliveryCount = redeliveryCountFrom(msg);
    if (deliveryCount > 1) {
      await this.safePublish(
        createDispatchTaskAbortedEvent({
          source: this.source,
          taskId: crypto.randomUUID(),
          agentId: this.agent.id,
          correlationId: envelope.id,
          ...(responseRouting !== undefined && { responseRouting }),
          startedAt: this.clock(),
          abortedAt: this.clock(),
          reason: `redelivery (attempt ${deliveryCount})`,
        }),
        "dispatch.task.aborted",
      );
    }

    // 1. Subject/type gate.
    if (envelope.type !== "tasks.dev.implement") {
      await this.publishFailed(
        envelope,
        {
          kind: "cant_do",
          detail: `envelope type "${envelope.type}" is not a tasks.dev.implement request`,
        },
        `unrecognised dev subject: ${subject}`,
        responseRouting,
      );
      return { kind: "term", reason: "non-dev subject" };
    }

    // 2. Payload gate.
    const payload = parseDevImplementPayload(envelope);
    if (payload === null) {
      await this.publishFailed(
        envelope,
        {
          kind: "cant_do",
          detail: "payload validation failed (missing/invalid repo, branch, base, or brief)",
        },
        `bad payload for ${subject}`,
        responseRouting,
      );
      return { kind: "term", reason: "payload validation failed" };
    }

    // 2.7. CO-2/CO-4 — per-offer-scope ADMISSION GATE. A dispatch that arrived
    //      at a WIDER scope (`federated.`/`public.`) must clear that scope's
    //      gate floor before the capability/concurrency gates. BYTE-IDENTICAL:
    //      a `local.` subject admits unconditionally, so this is inert today;
    //      it bites only on the `federated.`/`public.` subjects CO-2 newly
    //      binds. Omitted (no-offerings boot / tests) ⇒ skipped. A refusal is
    //      published as `dispatch.task.failed` and term/nak'd per the lane's
    //      `failedReasonToAckDecision`.
    if (this.offerAdmission !== undefined) {
      const decision = this.offerAdmission(envelope, subject);
      if (!decision.admit) {
        process.stderr.write(
          `cortex/dev-consumer: offer-scope admission DENIED for ` +
            `agent="${this.agent.id}" subject=${subject} envelope=${envelope.id} — ${decision.refusal.kind}\n`,
        );
        await this.publishFailed(
          envelope,
          decision.refusal,
          `offer-scope admission denied for ${subject}`,
          responseRouting,
        );
        return failedReasonToAckDecision(decision.refusal);
      }
    }

    // 3. Capability gate — does THIS agent claim dev.implement?
    if (!this.claims()) {
      await this.publishFailed(
        envelope,
        {
          kind: "cant_do",
          detail: `agent "${this.agent.id}" does not claim dev.implement`,
        },
        "no capability match for dev.implement",
        responseRouting,
      );
      return { kind: "term", reason: "no capability match" };
    }

    // 4. Concurrency gate — at the cap → nak `not_now`.
    //
    // TOCTOU parity note (review-consumer posture): the size-check and the
    // later `inFlight.add` are not atomic, so two near-simultaneous
    // deliveries could both observe `size < cap` and over-admit by one. This
    // is the SAME window `ReviewConsumer`'s maxConcurrent gate carries, and it
    // is benign for the same reason: JetStream delivers to a durable pull
    // consumer SERIALLY (one in-flight `onEnvelope` at a time per the pull
    // batch), so the two callers don't actually race on this path in
    // production. If a future push-mode or parallel-batch delivery ever makes
    // the race real, BOTH consumers harden together (a single shared
    // admit-token primitive) — they must not drift.
    if (this.inFlight.size >= this.maxConcurrent) {
      const retryAfterMs = 5000;
      await this.publishFailed(
        envelope,
        {
          kind: "not_now",
          detail: `agent at maxConcurrent (${this.maxConcurrent}) — try again`,
          retry_after_ms: retryAfterMs,
        },
        "dev consumer at maxConcurrent",
        responseRouting,
      );
      return { kind: "nak", delayMs: retryAfterMs };
    }

    // 5. Mid-shutdown refusal — don't start new pipelines while draining.
    if (this.stopped) {
      await this.publishFailed(
        envelope,
        { kind: "not_now", detail: "dev consumer is shutting down", retry_after_ms: 0 },
        "consumer shutting down before pipeline start",
        responseRouting,
      );
      return { kind: "nak", delayMs: 0 };
    }

    // 6. Emit started — paired with the eventual terminal via correlation_id.
    const startedAt = this.clock();
    await this.safePublish(
      createDispatchTaskStartedEvent({
        source: this.source,
        taskId: crypto.randomUUID(),
        agentId: this.agent.id,
        correlationId: envelope.id,
        ...(responseRouting !== undefined && { responseRouting }),
        startedAt,
      }),
      "dispatch.task.started",
    );

    // 7. Run the pipeline. Track the promise for `stop()` drain.
    const pipelinePromise = this.runPipeline(envelope, payload, startedAt, responseRouting);
    const tracked = pipelinePromise.then((decision) => ({ decision }));
    const drainSentinel = tracked.then(() => undefined);
    this.inFlight.add(drainSentinel);
    try {
      const { decision } = await tracked;
      return decision;
    } finally {
      this.inFlight.delete(drainSentinel);
    }
  }

  /**
   * Stop accepting new envelopes and drain in-flight pipelines. Idempotent.
   * The drain awaits every in-flight `processEnvelope` (incl. terminal
   * publish) so a watcher sees the terminal envelope from a mid-flight
   * implement at SIGTERM instead of a phantom timeout. Mirrors
   * `ReviewConsumer.stop`.
   */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopped = true;
      const sub = this.subscriber;
      if (sub) {
        try {
          await sub.stop();
        } catch (err) {
          process.stderr.write(
            `dev-consumer: subscriber stop failed for agent=${this.agent.id}: ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      if (this.inFlight.size > 0) {
        await Promise.allSettled(Array.from(this.inFlight));
      }
    })();
    return this.stopPromise;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Capability claim: exact `dev.implement` or the bare `dev` family wildcard.
   *  cortex#2020 dual-accept window (RFC-0008 §4.2): the ratified segment-prefix
   *  matcher is ORed on top of today's exact/family membership — additive, so an
   *  agent advertising a deeper `dev.implement.<deeper>` also claims the
   *  `dev.implement` request, and no match that lands today is removed. */
  private claims(): boolean {
    return (
      this.agent.capabilities.includes("dev.implement") ||
      this.agent.capabilities.includes("dev") ||
      anyAdvertisedSegmentPrefixMatches("dev.implement", this.agent.capabilities)
    );
  }

  /**
   * The act: worktree → CC (warm-resume if the chain has a stored session) →
   * gates → push + PR → terminal envelope. Returns the `AckDecision`.
   *
   * Every step's failure is mapped to a typed `dispatch.task.failed` reason
   * + the matching ack control; a step that throws is captured (never
   * propagated) so `processEnvelope` always returns an `AckDecision`. The
   * worktree is removed on every exit path (best-effort).
   */
  private async runPipeline(
    envelope: Envelope,
    payload: DevImplementPayload,
    startedAt: Date,
    responseRouting: AnyResponseRouting | undefined,
  ): Promise<AckDecision> {
    const chainId = devCorrelationChainId(envelope);
    let worktreePath: string | null = null;

    try {
      // 7a. Worktree.
      try {
        const created = await this.workspace.create({
          repo: payload.repo,
          branch: payload.branch,
          base: payload.base,
          chainId,
        });
        worktreePath = created.path;
      } catch (err) {
        return await this.failTerminal(envelope, startedAt, {
          kind: "cant_do",
          detail: `worktree create failed: ${errText(err)}`,
        }, responseRouting);
      }

      // 7b. CC session — warm-resume when the chain has a stored session id.
      const resumeId = await this.sessionStore.get(chainId);
      // Guardrail default (review parity, §3.5b): when the boot wiring did
      // NOT declare an `allowedDirs` scope, default it to the WORKTREE only —
      // the one directory this session legitimately writes to. The worktree
      // path is per-task (not known at boot), so the narrow default is set
      // HERE rather than in the boot opts. A boot-supplied `allowedDirs`
      // (e.g. the repo root + shared caches) wins; we only fill the empty
      // case so the higher-authority push session is never unrestricted.
      const bootDirs = this.sessionOpts?.allowedDirs;
      const allowedDirs =
        bootDirs !== undefined && bootDirs.length > 0 ? bootDirs : [worktreePath];
      const ccOpts: CCSessionOpts = {
        prompt: this.promptBuilder({ agentId: this.agent.id, payload }),
        agentId: this.agent.id,
        cwd: worktreePath,
        ...(this.sessionOpts ?? {}),
        // After the spread so the worktree-default (or boot value) is the
        // effective scope — never dropped by an empty `sessionOpts.allowedDirs`.
        allowedDirs,
        ...(resumeId !== undefined && { resumeSessionId: resumeId }),
      };

      let ccResult: CCSessionResult;
      try {
        const session: CCSessionLike = this.ccSessionFactory(ccOpts);
        session.start();
        ccResult = await session.wait();
      } catch (err) {
        return await this.failTerminal(envelope, startedAt, {
          kind: "cant_do",
          detail: `cc session threw: ${errText(err)}`,
        }, responseRouting);
      }

      // Persist the session id for the next fix-cycle resume (§3.6b) — even on
      // a CC failure, so a fix cycle resumes the SAME session that got partway.
      if (ccResult.sessionId !== undefined && ccResult.sessionId.length > 0) {
        await this.sessionStore.set(chainId, ccResult.sessionId);
      }

      if (!ccResult.success) {
        const reason: DispatchTaskFailedReason = ccResult.aborted
          ? {
              kind: "not_now",
              detail: `cc session aborted (${ccResult.abortReason ?? "timeout"}) — retry`,
              retry_after_ms: 0,
            }
          : {
              kind: "cant_do",
              detail: `cc session exited ${ccResult.exitCode} without completing the brief`,
            };
        return await this.failTerminal(envelope, startedAt, reason, responseRouting);
      }

      // 7b-2. Commit safety (cortex#1230 Bug 2). The pipeline pushes + opens
      //       the PR, but the AGENT must commit. The brief now tells it to
      //       (orchestrator-command `buildBrief`); this is the belt-and-braces
      //       backstop for the two real failure modes:
      //         - agent edited but forgot to commit → commit the leftover so
      //           the run isn't lost (+ WARN — the agent should commit itself).
      //         - agent produced nothing at all     → a CLEAR typed failure
      //           naming "no implementation", NOT forge's confusing "no commits
      //           to verify" surfaced from deep in the push path.
      let gitStatus: DevWorktreeStatus;
      try {
        gitStatus = await this.gitInspector.status({
          cwd: worktreePath,
          base: payload.base,
          branch: payload.branch,
        });
      } catch (err) {
        return await this.failTerminal(envelope, startedAt, {
          kind: "cant_do",
          detail: `git state inspection failed: ${errText(err)}`,
        }, responseRouting);
      }

      const postSession = decidePostSessionAction(gitStatus);
      if (postSession.kind === "fail-no-implementation") {
        return await this.failTerminal(envelope, startedAt, {
          kind: "cant_do",
          detail:
            "session produced no implementation/commits — no commits ahead of " +
            `${payload.base} and a clean working tree`,
        }, responseRouting);
      }
      if (postSession.kind === "commit-then-proceed") {
        const message = fallbackCommitMessage(payload);
        try {
          await this.gitInspector.commitAll({ cwd: worktreePath, message });
        } catch (err) {
          return await this.failTerminal(envelope, startedAt, {
            kind: "cant_do",
            detail: `fallback commit of the session's uncommitted changes failed: ${errText(err)}`,
          }, responseRouting);
        }
        process.stderr.write(
          `dev-consumer: agent left uncommitted changes for ${payload.repo}` +
            `${payload.issue !== undefined ? `#${payload.issue}` : ""} — committed ` +
            `them with a fallback message (the agent should commit its own work)\n`,
        );
      }

      // 7c. Gates — run in declared order, stop at the first red.
      const gates = payload.gates ?? [];
      for (const command of gates) {
        let gateResult: DevCommandResult;
        try {
          gateResult = await this.commandRunner.run({ command, cwd: worktreePath });
        } catch (err) {
          return await this.failTerminal(envelope, startedAt, {
            kind: "cant_do",
            detail: `gate "${command}" could not run: ${errText(err)}`,
          }, responseRouting);
        }
        if (!gateResult.ok) {
          const tail = gateResult.output ? ` — ${truncate(gateResult.output)}` : "";
          return await this.failTerminal(envelope, startedAt, {
            kind: "cant_do",
            detail: `gate "${command}" failed${tail}`,
          }, responseRouting);
        }
      }

      // 7d. Push + PR.
      let pr: DevPrRef;
      try {
        pr = await this.forge.openPr({
          repo: payload.repo,
          branch: payload.branch,
          base: payload.base,
          cwd: worktreePath,
          brief: payload.brief,
          ...(payload.title !== undefined && { title: payload.title }),
          ...(payload.issue !== undefined && { issue: payload.issue }),
        });
      } catch (err) {
        return await this.failTerminal(envelope, startedAt, {
          kind: "cant_do",
          detail: `forge openPr failed: ${errText(err)}`,
        }, responseRouting);
      }

      // 7e. Terminal success — `dispatch.task.completed` carrying the PR ref.
      await this.safePublish(
        createDispatchTaskCompletedEvent({
          source: this.source,
          taskId: crypto.randomUUID(),
          agentId: this.agent.id,
          correlationId: envelope.id,
          ...(responseRouting !== undefined && { responseRouting }),
          startedAt,
          completedAt: this.clock(),
          resultSummary: `opened ${pr.repo}#${pr.number}`,
          // The PR ref is the load-bearing result the reactor advances on. It
          // rides `chat_response` as a JSON blob so a surface can render the
          // deep link AND a programmatic consumer can parse it — the dispatch
          // builder has no dedicated `pr` field, and adding one is a wire-
          // schema change out of scope for F-2 (FLAGGED in the PR body).
          chatResponse: JSON.stringify({ pr }),
        }),
        "dispatch.task.completed",
      );
      return { kind: "ack" };
    } finally {
      // Best-effort worktree cleanup on every exit path. A removal failure is
      // logged, never thrown — a leaked worktree is a janitorial concern, not
      // a reason to nak a task whose terminal envelope already shipped.
      if (worktreePath !== null) {
        try {
          await this.workspace.remove({ path: worktreePath });
        } catch (err) {
          process.stderr.write(
            `dev-consumer: worktree remove failed for ${worktreePath} ` +
              `(agent=${this.agent.id}): ${errText(err)}\n`,
          );
        }
      }
    }
  }

  /**
   * Publish a `dispatch.task.failed` for a pipeline-internal failure and
   * return the matching `AckDecision`. The `errorSummary` mirrors the
   * reason's detail so the worklog + dead-letter views agree.
   */
  private async failTerminal(
    envelope: Envelope,
    startedAt: Date,
    reason: DispatchTaskFailedReason,
    responseRouting: AnyResponseRouting | undefined,
  ): Promise<AckDecision> {
    await this.safePublish(
      createDispatchTaskFailedEvent({
        source: this.source,
        taskId: crypto.randomUUID(),
        agentId: this.agent.id,
        correlationId: envelope.id,
        ...(responseRouting !== undefined && { responseRouting }),
        startedAt,
        failedAt: this.clock(),
        errorSummary: reasonDetail(reason),
        reason,
      }),
      "dispatch.task.failed",
    );
    return failedReasonToAckDecision(reason);
  }

  /**
   * Publish a `dispatch.task.failed` built locally for a pre-pipeline failure
   * branch (bad subject/payload, no capability, backpressure, shutdown).
   * Threads `correlation_id = envelope.id` (the request id) per the lifecycle
   * contract.
   */
  private async publishFailed(
    request: Envelope,
    reason: DispatchTaskFailedReason,
    errorSummary: string,
    responseRouting?: AnyResponseRouting,
  ): Promise<void> {
    const now = this.clock();
    await this.safePublish(
      createDispatchTaskFailedEvent({
        source: this.source,
        taskId: crypto.randomUUID(),
        agentId: this.agent.id,
        correlationId: request.id,
        ...(responseRouting !== undefined && { responseRouting }),
        startedAt: now,
        failedAt: now,
        errorSummary,
        reason,
      }),
      "dispatch.task.failed",
    );
  }

  /**
   * SINGLE PUBLISH PATH — every lifecycle envelope the consumer emits routes
   * through here. Traps + logs publish errors (CLAUDE.md "no empty catch")
   * so a failed publish never crashes the consumer or stops the handler from
   * returning an `AckDecision`. Mirrors `ReviewConsumer.safePublish` (local
   * mode only — federated dev dispatch is F-5, out of scope).
   */
  private async safePublish(envelope: Envelope, label: string): Promise<void> {
    try {
      await this.runtime.publish(envelope);
    } catch (err) {
      process.stderr.write(
        `dev-consumer: publish failed for ${label} (agent=${this.agent.id}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Map a `DispatchTaskFailedReason` to the JetStream `AckDecision`. The SAME
 * mapping `review-consumer.ts` locks in: permanent failures term (so the
 * dead-letter view carries a structured reason), transient `not_now` naks
 * with the retry hint. Duplicated rather than imported to keep the dev
 * consumer free of a `bus/review-consumer.ts` dependency (the two are
 * sibling capability consumers, not a shared base).
 */
export function failedReasonToAckDecision(
  reason: DispatchTaskFailedReason | undefined,
): AckDecision {
  if (!reason) return { kind: "ack" };
  switch (reason.kind) {
    case "cant_do":
      return { kind: "term", reason: `cant_do: ${reason.detail}` };
    case "wont_do":
      return { kind: "term", reason: `wont_do: ${reason.detail}` };
    case "policy_denied": {
      const denyKeys = Object.keys(reason.deny);
      const summary = denyKeys.length > 0 ? denyKeys.join(",") : "(no deny detail)";
      return { kind: "term", reason: `policy_denied: ${summary}` };
    }
    case "not_now": {
      const out: AckDecision = { kind: "nak" };
      if (reason.retry_after_ms !== undefined) out.delayMs = reason.retry_after_ms;
      return out;
    }
    case "compliance_block":
      return { kind: "term", reason: "v1 does not handle compliance_block" };
  }
}

/** Human-readable detail for a reason — used as the `error_summary`. */
function reasonDetail(reason: DispatchTaskFailedReason): string {
  switch (reason.kind) {
    case "cant_do":
    case "wont_do":
    case "not_now":
    case "compliance_block":
      return reason.detail;
    case "policy_denied":
      return `policy_denied: ${Object.keys(reason.deny).join(",")}`;
  }
}

/** Read JetStream redelivery count from a `JsMsg`; `1` when no msg (tests). */
function redeliveryCountFrom(msg: JsMsg | null): number {
  if (!msg) return 1;
  const info = (msg.info as { redeliveryCount?: number } | undefined) ?? undefined;
  if (info && typeof info.redeliveryCount === "number") return info.redeliveryCount;
  return msg.redelivered ? 2 : 1;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the conventional-commit message for the fallback commit when the agent
 * edited but forgot to commit (cortex#1230 Bug 2). Prefers the issue ref for a
 * short, stable subject; falls back to a truncated brief. The `(dev-loop
 * fallback commit)` suffix marks it as the safety-net commit in the log.
 */
export function fallbackCommitMessage(payload: DevImplementPayload): string {
  const subject =
    payload.issue !== undefined
      ? `implement ${payload.repo}#${payload.issue}`
      : truncate(payload.brief, 60);
  return `feat: ${subject} (dev-loop fallback commit)`;
}

/** Cap a gate's output tail for the failure detail. */
function truncate(s: string, max = 500): string {
  const trimmed = s.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
