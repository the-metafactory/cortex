/**
 * Sub-agent team orchestration adapted from Maestro's Group Chat pattern.
 *
 * A team has a moderator CCSession that coordinates participant sessions.
 * The moderator decides what to delegate, participants do the work,
 * and the moderator synthesizes the final response.
 *
 * Flow: user message → moderator → @mention participants → collect responses → moderator synthesis → final result
 */

import { EventEmitter } from "events";
import { CCSession, type CCSessionOpts } from "./cc-session";
import { randomUUID } from "crypto";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { TrustResolver } from "../common/agents/trust-resolver";
import type { DispatchEventSource } from "../bus/dispatch-events";
import {
  createDispatchTaskCompletedEvent,
  createDispatchTaskFailedEvent,
  createDispatchTaskStartedEvent,
} from "../bus/dispatch-events";
import {
  truncateDispatchErrorSummary,
  truncateDispatchResultSummary,
} from "../bus/dispatch-lifecycle-summary";
import { BusPeerHarness } from "../substrates/bus-peer/harness";
import type {
  Capability,
  DispatchRequest,
  MyelinEnvelope,
  SessionHarness,
} from "../common/substrates/types";

export interface TeamMember {
  name: string;
  /**
   * Local participants (default `kind: "local"`) drive a CCSession in
   * the runner's process. Bus-peer participants (B.2b — `kind:
   * "bus-peer"`) delegate to a remote cortex over the bus via
   * `BusPeerHarness`; the local member tracks the harness handle as
   * an abort point + the AsyncIterable's underlying state. The
   * runtime exposes only the parts the synthesis path cares about.
   */
  session: CCSession | BusPeerHandle;
  role: "moderator" | "participant";
  status: "idle" | "thinking" | "done";
  result?: string;
}

/**
 * IAW Phase B.2b (cortex#114, refs cortex#202) — abstraction over an
 * in-flight `BusPeerHarness.dispatch()` iterator. The agent-team
 * runner needs `start()` (kicks the iterator) and a way to abort if
 * the team is torn down before the peer's terminal envelope arrives.
 */
export interface BusPeerHandle {
  /** Begin pulling envelopes from `harness.dispatch(req)`. */
  start(): void;
  /**
   * Abort the in-flight dispatch — breaks the iterator, runs
   * `BusPeerHarness`'s cleanup (unregister handler on runtime).
   */
  abort(): void;
}

export interface TeamParticipantConfig {
  name: string;
  /** Specific prompt/role for this participant */
  prompt: string;
  /** Override allowed dirs for this participant */
  dirs?: string[];
  /** Override allowed tools for this participant */
  allowedTools?: string[];
  /** Override disallowed tools for this participant */
  disallowedTools?: string[];
  /**
   * IAW Phase B.2b (cortex#114) — participant substrate kind.
   *
   * - `"local"` (default) — drives a `CCSession` in this runner's
   *   process. Today's behaviour; unchanged for callers that don't
   *   opt in.
   * - `"bus-peer"` — dispatches the participant prompt to a remote
   *   cortex via `BusPeerHarness`. Requires
   *   `AgentTeamOpts.runtime` + `resolver` + `receivingAgentId` +
   *   `principalId` + `source` to be set. The terminal envelope's
   *   `payload.result_summary` (set by the peer) becomes the
   *   member's `result`; absence becomes an empty result string.
   *
   * The mode flips per-participant so a team can mix local CC
   * sessions with bus-peer delegations in one moderator run — useful
   * when only one capability (e.g. `security-review`) lives off-stack
   * and the rest stay local.
   */
  kind?: "local" | "bus-peer";
  /**
   * Required when `kind === "bus-peer"`. The remote agent id the
   * dispatch envelope targets — surfaces on
   * `DispatchRequest.agent.id` so the peer's substrate sees it as
   * the recipient. Today's wire format is sender-agnostic; this
   * field is for forward compatibility with cortex#107
   * principal-based routing.
   */
  peerAgentId?: string;
}

export interface AgentTeamOpts {
  /** The original user request */
  prompt: string;
  groveChannel?: string;
  /** G-501: Network identifier for event routing */
  groveNetwork?: string;
  /** Pre-configured participants */
  participants: TeamParticipantConfig[];
  /** Additional CC args for all sessions */
  additionalArgs?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  allowedDirs?: string[];
  timeoutMs?: number;
  /** Bash guard config — propagated to all team sessions (moderator + participants) */
  bashGuardDisabled?: boolean;
  bashAllowlist?: CCSessionOpts["bashAllowlist"];
  /** H-001: Explicit metadata */
  project?: string;
  entity?: string;
  operator?: string;
  /**
   * IAW Phase B.2b (cortex#114) — bus-peer dependencies. Required
   * when ANY participant has `kind: "bus-peer"`; the constructor
   * throws if a participant declares bus-peer routing without these
   * dependencies wired in (load-bearing — silent fallback to local
   * would defeat the purpose of declaring bus-peer in the first
   * place).
   */
  busPeer?: {
    runtime: MyelinRuntime;
    resolver: TrustResolver;
    receivingAgentId: string;
    principalId: string;
    source: DispatchEventSource;
  };
  /**
   * IAW Phase B.2b (cortex#114) — test-injectable factory for the
   * bus-peer handle. Production callers omit; tests pass a fake
   * that captures the dispatch request + lets the test inject the
   * terminal envelope synchronously.
   *
   * @internal — not part of the public API.
   */
  busPeerHandleFactory?: BusPeerHandleFactory;
}

export interface AgentTeamLike {
  start(): unknown;
  wait(): Promise<string>;
  abort?(): void;
  on(event: "progress", listener: (member: string, text: string) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  getTraceContext(): { traceId: string; teamId: string };
}

export type AgentTeamFactory = (opts: AgentTeamOpts) => AgentTeamLike;

export interface AgentTeamHarnessOpts {
  source: DispatchEventSource;
  capabilities?: Capability[];
  participants?: TeamParticipantConfig[];
  agentTeamFactory?: AgentTeamFactory;
}

const DEFAULT_TEAM_PARTICIPANTS: TeamParticipantConfig[] = [
  {
    name: "analyst",
    prompt: "Deep analytical perspective — examine evidence, data, and logical implications",
  },
  {
    name: "creative",
    prompt: "Creative and lateral thinking — explore unconventional angles and connections",
  },
  {
    name: "critic",
    prompt: "Critical evaluation — identify weaknesses, counterarguments, and risks",
  },
];

const defaultAgentTeamFactory: AgentTeamFactory = (opts) => new AgentTeam(opts);

/**
 * Delegate-mode meta-harness. It wraps the existing moderator +
 * participant AgentTeam orchestration behind the same SessionHarness
 * lifecycle contract as single-substrate harnesses.
 */
export class AgentTeamHarness implements SessionHarness {
  readonly id = "agent-team" as const;
  readonly capabilities: Capability[];

  private readonly source: DispatchEventSource;
  private readonly participants: TeamParticipantConfig[];
  private readonly factory: AgentTeamFactory;
  private readonly activeTeams = new Set<AgentTeamLike>();
  private shuttingDown = false;

  constructor(opts: AgentTeamHarnessOpts) {
    this.source = opts.source;
    this.capabilities = opts.capabilities ?? [];
    this.participants = opts.participants ?? DEFAULT_TEAM_PARTICIPANTS;
    this.factory = opts.agentTeamFactory ?? defaultAgentTeamFactory;
  }

  async *dispatch(req: DispatchRequest): AsyncIterable<MyelinEnvelope> {
    const startedAt = new Date();
    const correlationId = req.requestId;

    yield createDispatchTaskStartedEvent({
      source: this.source,
      taskId: req.requestId,
      agentId: req.agent.id,
      startedAt,
      correlationId,
    });

    if (this.shuttingDown) {
      yield createDispatchTaskFailedEvent({
        source: this.source,
        taskId: req.requestId,
        agentId: req.agent.id,
        startedAt,
        failedAt: new Date(),
        errorSummary: "agent-team harness shutting down",
        correlationId,
      });
      return;
    }

    let team: AgentTeamLike | null = null;
    try {
      team = this.factory(this.buildTeamOpts(req));
      this.activeTeams.add(team);
      const waitForResult = team.wait();
      team.start();
      const result = await waitForResult;
      yield createDispatchTaskCompletedEvent({
        source: this.source,
        taskId: req.requestId,
        agentId: req.agent.id,
        startedAt,
        completedAt: new Date(),
        resultSummary: truncateDispatchResultSummary(result),
        correlationId,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      yield createDispatchTaskFailedEvent({
        source: this.source,
        taskId: req.requestId,
        agentId: req.agent.id,
        startedAt,
        failedAt: new Date(),
        errorSummary: truncateDispatchErrorSummary(error.message),
        correlationId,
      });
    } finally {
      if (team !== null) {
        this.activeTeams.delete(team);
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async shutdown(opts: { graceful: boolean }): Promise<void> {
    this.shuttingDown = true;
    if (opts.graceful) return;
    for (const team of this.activeTeams) {
      team.abort?.();
    }
  }

  private buildTeamOpts(req: DispatchRequest): AgentTeamOpts {
    const env = this.envContext(req);
    return {
      prompt: req.prompt,
      participants: this.participants.map((p) => ({ ...p })),
      ...(req.runtime?.groveChannel !== undefined && { groveChannel: req.runtime.groveChannel }),
      ...(req.runtime?.groveNetwork !== undefined && { groveNetwork: req.runtime.groveNetwork }),
      ...(req.runtime?.additionalArgs !== undefined && { additionalArgs: req.runtime.additionalArgs }),
      ...(req.tools.allow.length > 0 && { allowedTools: [...req.tools.allow] }),
      ...(req.tools.deny !== undefined && { disallowedTools: [...req.tools.deny] }),
      ...(req.runtime?.allowedDirs !== undefined && { allowedDirs: req.runtime.allowedDirs }),
      ...(req.timeoutMs !== undefined && { timeoutMs: req.timeoutMs }),
      ...(env.project !== undefined && { project: env.project }),
      ...(env.entity !== undefined && { entity: env.entity }),
      ...(env.operator !== undefined && { operator: env.operator }),
    };
  }

  private envContext(req: DispatchRequest): {
    project?: string;
    entity?: string;
    operator?: string;
  } {
    for (const ctx of req.context) {
      if (ctx.kind !== "env" || typeof ctx.data !== "object" || ctx.data === null) {
        continue;
      }
      const env = ctx.data as Record<string, unknown>;
      return {
        ...(typeof env.project === "string" && { project: env.project }),
        ...(typeof env.entity === "string" && { entity: env.entity }),
        ...(typeof env.operator === "string" && { operator: env.operator }),
      };
    }
    return {};
  }
}

/**
 * IAW Phase B.2b (cortex#114) — factory that builds a `BusPeerHandle`
 * for a single bus-peer participant. Production wiring uses the
 * `defaultBusPeerHandleFactory` below which constructs a real
 * `BusPeerHarness` + iterates `dispatch()`; tests pass a fake.
 */
export type BusPeerHandleFactory = (
  config: BusPeerHandleConfig,
) => BusPeerHandle;

export interface BusPeerHandleConfig {
  /** Remote agent id (`TeamParticipantConfig.peerAgentId`). */
  peerAgentId: string;
  /** Display name on the local member record. */
  participantName: string;
  /** Prompt to send the remote substrate. */
  prompt: string;
  /** Bus deps from `AgentTeamOpts.busPeer`. */
  runtime: MyelinRuntime;
  resolver: TrustResolver;
  receivingAgentId: string;
  principalId: string;
  source: DispatchEventSource;
  /** Callback when the remote returns its terminal envelope. */
  onResult: (resultSummary: string) => void;
  /** Callback when dispatch errors before terminal. */
  onError: (err: Error) => void;
  /** Soft timeout in ms; abort if no terminal arrives. */
  timeoutMs: number;
}

/**
 * IAW Phase B.2b (cortex#114) — default production factory for
 * bus-peer participant handles. Constructs a `BusPeerHarness`,
 * builds a `DispatchRequest`, and iterates `harness.dispatch(req)`
 * in an async generator. Terminal envelopes flip the handle into
 * the result callback; non-terminal progress envelopes flow into
 * `onProgress`-style callbacks once those land (today the team
 * only consumes terminal results).
 *
 * Abort semantics: `BusPeerHarness.dispatch()` is an async generator
 * that exits cleanly when the consumer breaks. The handle wraps the
 * iterator; `abort()` calls `.return()` on the iterator which
 * triggers the harness's try/finally cleanup (unregister handler
 * on runtime).
 */
export function defaultBusPeerHandleFactory(
  config: BusPeerHandleConfig,
): BusPeerHandle {
  const harness = new BusPeerHarness({
    runtime: config.runtime,
    resolver: config.resolver,
    receivingAgentId: config.receivingAgentId,
    source: config.source,
  });

  const dispatchRequest: DispatchRequest = {
    prompt: config.prompt,
    tools: { allow: [], deny: [] },
    context: [],
    agent: {
      id: config.peerAgentId,
      displayName: config.participantName,
    },
    requestId: randomUUID(),
  };

  let iterator: AsyncIterator<MyelinEnvelope> | undefined;
  let aborted = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  return {
    start(): void {
      timeoutHandle = setTimeout(() => {
        if (!aborted) {
          aborted = true;
          void iterator?.return?.(undefined);
          config.onError(
            new Error(
              `bus-peer dispatch timed out after ${config.timeoutMs}ms for peerAgentId=${config.peerAgentId}`,
            ),
          );
        }
      }, config.timeoutMs);

      // Async loop pulls envelopes until terminal arrives or abort
      // breaks the iterator. The harness yields started → progress*
      // → terminal; we discard non-terminal envelopes (today's
      // synthesis path consumes only the final result_summary).
      const drain = async (): Promise<void> => {
        try {
          const iterable = harness.dispatch(dispatchRequest);
          iterator = iterable[Symbol.asyncIterator]();
          for (;;) {
            const next = await iterator.next();
            if (next.done === true) break;
            const envelope = next.value;
            if (
              envelope.type === "dispatch.task.completed" ||
              envelope.type === "dispatch.task.failed" ||
              envelope.type === "dispatch.task.aborted"
            ) {
              if (aborted) return;
              // Result extraction: the peer cortex emits a
              // `dispatch.task.completed` with `payload.result_summary`
              // carrying its synthesized response. Absence becomes an
              // empty string so the team's synthesis still runs (the
              // missing payload is a peer-side bug worth surfacing on
              // the dashboard, not a reason to fail the whole team).
              const summary =
                typeof envelope.payload.result_summary === "string"
                  ? envelope.payload.result_summary
                  : "";
              config.onResult(summary);
              return;
            }
          }
        } catch (err) {
          if (aborted) return;
          config.onError(err instanceof Error ? err : new Error(String(err)));
        } finally {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
          }
        }
      };
      void drain();
    },
    abort(): void {
      aborted = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      void iterator?.return?.(undefined);
    },
  };
}

/**
 * Build the moderator system prompt that tells it about available participants.
 */
function buildModeratorPrompt(userPrompt: string, participants: TeamParticipantConfig[]): string {
  const participantList = participants
    .map((p) => `- @${p.name}: ${p.prompt}`)
    .join("\n");

  return [
    "You are a moderator coordinating a team of specialist agents.",
    "Your job is to break down the user's request and delegate work to the appropriate participants.",
    "",
    "Available participants:",
    participantList,
    "",
    "Instructions:",
    "- Analyze the user's request and decide how to delegate",
    "- For each participant you want to engage, include their @name in your response",
    "- Each participant will work independently on their assigned portion",
    "- You will receive their results and synthesize a final response",
    "- If a participant's response is insufficient, you can @mention them again for clarification",
    "- Return your final answer to the user WITHOUT any @mentions when you're satisfied",
    "",
    `User request: ${userPrompt}`,
  ].join("\n");
}

/**
 * Build the synthesis prompt the moderator gets after all participants respond.
 */
function buildSynthesisPrompt(
  userPrompt: string,
  participantResults: { name: string; result: string }[]
): string {
  const results = participantResults
    .map((p) => `### @${p.name}\n${p.result}`)
    .join("\n\n");

  return [
    "All participants have responded. Review their work and produce a final, synthesized response for the user.",
    "",
    `Original request: ${userPrompt}`,
    "",
    "Participant responses:",
    results,
    "",
    "Synthesize these into a cohesive final response. Do NOT include @mentions — this goes directly to the user.",
  ].join("\n");
}

/** Extract @mentions from moderator output */
function extractMentions(text: string, knownNames: string[]): string[] {
  const mentionPattern = /@([^\s@:,;!?()[\]{}'"<>]+)/g;
  const mentions: string[] = [];
  let match;

  while ((match = mentionPattern.exec(text)) !== null) {
    const name = (match[1] ?? "").toLowerCase();
    const matched = knownNames.find(
      (k) => k.toLowerCase() === name || k.toLowerCase().replace(/\s+/g, "-") === name
    );
    if (matched) mentions.push(matched);
  }

  return [...new Set(mentions)]; // Deduplicate
}

export class AgentTeam extends EventEmitter {
  private members = new Map<string, TeamMember>();
  private moderator?: CCSession;
  private synthesis?: CCSession;
  private traceId: string;
  private teamId: string;
  private pendingParticipants = new Set<string>();

  constructor(private opts: AgentTeamOpts) {
    super();
    this.traceId = randomUUID();
    this.teamId = `team-${randomUUID().slice(0, 8)}`;

    // IAW Phase B.2b — fail loud at construction time when a
    // participant declares `kind: "bus-peer"` but the team wasn't
    // wired with the bus dependencies. Silent fallback to local
    // would defeat the explicit per-participant routing choice.
    const busPeers = opts.participants.filter((p) => p.kind === "bus-peer");
    if (busPeers.length > 0) {
      if (opts.busPeer === undefined) {
        throw new Error(
          `AgentTeam: ${busPeers.length} bus-peer participant(s) declared ` +
            `(${busPeers.map((p) => p.name).join(", ")}) but opts.busPeer is missing — ` +
            "wire runtime + resolver + receivingAgentId + principalId + source",
        );
      }
      const missingPeerAgentId = busPeers.find(
        (p) => p.peerAgentId === undefined || p.peerAgentId === "",
      );
      if (missingPeerAgentId !== undefined) {
        throw new Error(
          `AgentTeam: bus-peer participant "${missingPeerAgentId.name}" is missing peerAgentId — ` +
            "the remote agent id is required for outbound dispatch",
        );
      }
    }
  }

  /** Start the team: spawn moderator, which triggers participant dispatch. */
  start(): this {
    const moderatorPrompt = buildModeratorPrompt(this.opts.prompt, this.opts.participants);

    this.moderator = new CCSession({
      prompt: moderatorPrompt,
      groveChannel: this.opts.groveChannel,
      groveNetwork: this.opts.groveNetwork,
      additionalArgs: this.opts.additionalArgs,
      allowedTools: this.opts.allowedTools,
      disallowedTools: this.opts.disallowedTools,
      allowedDirs: this.opts.allowedDirs,
      timeoutMs: this.opts.timeoutMs ?? 900_000,
      bashGuardDisabled: this.opts.bashGuardDisabled,
      bashAllowlist: this.opts.bashAllowlist,
      project: this.opts.project,
      entity: this.opts.entity,
      operator: this.opts.operator,
    });

    this.members.set("moderator", {
      name: "moderator",
      session: this.moderator,
      role: "moderator",
      status: "thinking",
    });

    // When moderator produces a result, check for @mentions
    this.moderator.on("result", (text: string) => {
      this.handleModeratorResponse(text);
    });

    this.moderator.on("error", (err: Error) => {
      this.emit("error", err);
    });

    this.moderator.start();
    this.emit("progress", "moderator", "Analyzing request and delegating to participants...");

    return this;
  }

  /** Await the team's final synthesized result. */
  async wait(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.on("synthesis", resolve);
      this.on("error", reject);
    });
  }

  /** Get trace context for observability. */
  getTraceContext(): { traceId: string; teamId: string } {
    return { traceId: this.traceId, teamId: this.teamId };
  }

  abort(): void {
    this.moderator?.kill();
    this.synthesis?.kill();
    for (const member of this.members.values()) {
      if (member.session instanceof CCSession) {
        member.session.kill();
      } else {
        member.session.abort();
      }
    }
    if (this.listenerCount("error") > 0) {
      this.emit("error", new Error("AgentTeam aborted"));
    }
  }

  private handleModeratorResponse(text: string): void {
    const participantNames = this.opts.participants.map((p) => p.name);
    const mentions = extractMentions(text, participantNames);

    if (mentions.length === 0) {
      // No @mentions — this is the final synthesized response
      this.emit("synthesis", text);
      return;
    }

    // Dispatch to mentioned participants
    this.emit("progress", "moderator", `Delegating to: ${mentions.join(", ")}`);

    for (const name of mentions) {
      this.pendingParticipants.add(name);
      this.spawnParticipant(name);
    }
  }

  private spawnParticipant(name: string): void {
    const config = this.opts.participants.find((p) => p.name === name);
    if (!config) return;

    // IAW Phase B.2b — bus-peer participants delegate to a remote
    // cortex via `BusPeerHarness` instead of spawning a local
    // CCSession. The constructor already validated that `busPeer`
    // dependencies + `peerAgentId` are set when any participant
    // declared `kind: "bus-peer"`; this branch can trust them.
    if (config.kind === "bus-peer") {
      this.spawnBusPeerParticipant(name, config);
      return;
    }

    const participantPrompt = [
      `You are "${name}", a specialist participant in a team working on a task.`,
      `Your role: ${config.prompt}`,
      "",
      `The team is working on: ${this.opts.prompt}`,
      "",
      "Provide your specialist analysis or work. Be thorough but focused on your area.",
      "Start with a 1-3 sentence plain-text overview, then provide details.",
    ].join("\n");

    const session = new CCSession({
      prompt: participantPrompt,
      groveChannel: this.opts.groveChannel,
      groveNetwork: this.opts.groveNetwork,
      additionalArgs: this.opts.additionalArgs,
      allowedTools: config.allowedTools ?? this.opts.allowedTools,
      disallowedTools: config.disallowedTools ?? this.opts.disallowedTools,
      allowedDirs: config.dirs ?? this.opts.allowedDirs,
      timeoutMs: this.opts.timeoutMs ?? 900_000,
      bashGuardDisabled: this.opts.bashGuardDisabled,
      bashAllowlist: this.opts.bashAllowlist,
      project: this.opts.project,
      entity: this.opts.entity,
      operator: this.opts.operator,
    });

    // Trace context env vars are passed via CC's environment-inheritance;
    // future PR will wire them through CCSession opts explicitly. Tracked
    // in worklog as the "trace context not forwarded" item.
    // (PAI_TRACE_ID / PAI_PARENT_AGENT_ID / PAI_AGENT_ROLE pending wiring.)

    this.members.set(name, {
      name,
      session,
      role: "participant",
      status: "thinking",
    });

    session.on("result", (text: string) => {
      const member = this.members.get(name);
      if (member) {
        member.status = "done";
        member.result = text;
      }
      this.emit("progress", name, text.slice(0, 200));
      this.pendingParticipants.delete(name);

      // Check if all participants have responded
      if (this.pendingParticipants.size === 0) {
        this.triggerSynthesis();
      }
    });

    session.on("error", (err: Error) => {
      const member = this.members.get(name);
      if (member) {
        member.status = "done";
        member.result = `Error: ${err.message}`;
      }
      this.pendingParticipants.delete(name);
      this.emit("progress", name, `Failed: ${err.message}`);

      if (this.pendingParticipants.size === 0) {
        this.triggerSynthesis();
      }
    });

    session.start();
  }

  /**
   * IAW Phase B.2b (cortex#114) — spawn a participant that delegates
   * its work to a remote cortex over the bus rather than running
   * locally. The remote substrate (peer cortex's BusDispatchListener)
   * receives our `dispatch.task.dispatched` envelope, the peer's
   * own runner does the work, and emits a terminal envelope with
   * the synthesized result back over the bus.
   *
   * Result extraction: the peer's `dispatch.task.completed` envelope
   * carries `payload.result_summary`; absence becomes an empty
   * string so the synthesis step still runs (a missing payload is
   * a peer-side bug, not a reason to fail this team).
   *
   * Timeout: the team's overall `timeoutMs` (default 15 min) bounds
   * the peer wait. On timeout, the harness's iterator is broken
   * (clean unregister via the try/finally inside `BusPeerHarness`)
   * and the member is marked failed.
   */
  private spawnBusPeerParticipant(
    name: string,
    config: TeamParticipantConfig,
  ): void {
    // Validated at construction time; the non-null assertions here
    // are documentation that the precondition holds.
    const busPeer = this.opts.busPeer;
    const peerAgentId = config.peerAgentId;
    if (busPeer === undefined || peerAgentId === undefined) {
      this.emit(
        "error",
        new Error(
          `AgentTeam: bus-peer participant "${name}" missing dependencies at spawn — ` +
            "constructor validation should have caught this",
        ),
      );
      return;
    }

    const participantPrompt = [
      `You are "${name}", a specialist participant in a team working on a task.`,
      `Your role: ${config.prompt}`,
      "",
      `The team is working on: ${this.opts.prompt}`,
      "",
      "Provide your specialist analysis or work. Be thorough but focused on your area.",
      "Start with a 1-3 sentence plain-text overview, then provide details.",
    ].join("\n");

    const factory =
      this.opts.busPeerHandleFactory ?? defaultBusPeerHandleFactory;

    const handle = factory({
      peerAgentId,
      participantName: name,
      prompt: participantPrompt,
      runtime: busPeer.runtime,
      resolver: busPeer.resolver,
      receivingAgentId: busPeer.receivingAgentId,
      principalId: busPeer.principalId,
      source: busPeer.source,
      timeoutMs: this.opts.timeoutMs ?? 900_000,
      onResult: (resultSummary) => {
        const member = this.members.get(name);
        if (member) {
          member.status = "done";
          member.result = resultSummary;
        }
        this.emit("progress", name, resultSummary.slice(0, 200));
        this.pendingParticipants.delete(name);
        if (this.pendingParticipants.size === 0) {
          this.triggerSynthesis();
        }
      },
      onError: (err) => {
        const member = this.members.get(name);
        if (member) {
          member.status = "done";
          member.result = `Error: ${err.message}`;
        }
        this.pendingParticipants.delete(name);
        this.emit("progress", name, `Failed: ${err.message}`);
        if (this.pendingParticipants.size === 0) {
          this.triggerSynthesis();
        }
      },
    });

    this.members.set(name, {
      name,
      session: handle,
      role: "participant",
      status: "thinking",
    });

    handle.start();
  }

  private triggerSynthesis(): void {
    const participantResults = Array.from(this.members.values())
      .filter((m): m is typeof m & { result: string } =>
        m.role === "participant" && typeof m.result === "string"
      )
      .map((m) => ({ name: m.name, result: m.result }));

    if (participantResults.length === 0) {
      this.emit("error", new Error("No participant results to synthesize"));
      return;
    }

    this.emit("progress", "moderator", "All participants responded — synthesizing...");

    // Spawn a new moderator session for synthesis
    const synthesisPrompt = buildSynthesisPrompt(this.opts.prompt, participantResults);

    const synthSession = new CCSession({
      prompt: synthesisPrompt,
      groveChannel: this.opts.groveChannel,
      additionalArgs: this.opts.additionalArgs,
      allowedTools: this.opts.allowedTools,
      disallowedTools: this.opts.disallowedTools,
      allowedDirs: this.opts.allowedDirs,
      timeoutMs: this.opts.timeoutMs ?? 900_000,
      bashGuardDisabled: this.opts.bashGuardDisabled,
      bashAllowlist: this.opts.bashAllowlist,
      project: this.opts.project,
      entity: this.opts.entity,
      operator: this.opts.operator,
    });
    this.synthesis = synthSession;

    synthSession.on("result", (text: string) => {
      this.emit("synthesis", text);
    });

    synthSession.on("error", (err: Error) => {
      this.emit("error", err);
    });

    synthSession.start();
  }
}
