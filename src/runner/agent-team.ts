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

export interface TeamMember {
  name: string;
  session: CCSession;
  role: "moderator" | "participant";
  status: "idle" | "thinking" | "done";
  result?: string;
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
  const mentionPattern = /@([^\s@:,;!?()\[\]{}'"<>]+)/g;
  const mentions: string[] = [];
  let match;

  while ((match = mentionPattern.exec(text)) !== null) {
    const name = match[1]!.toLowerCase();
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
  private traceId: string;
  private teamId: string;
  private pendingParticipants = new Set<string>();

  constructor(private opts: AgentTeamOpts) {
    super();
    this.traceId = randomUUID();
    this.teamId = `team-${randomUUID().slice(0, 8)}`;
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

    // Pass trace context via environment
    const env = {
      PAI_TRACE_ID: this.traceId,
      PAI_PARENT_AGENT_ID: this.moderator?.sessionId ?? this.teamId,
      PAI_AGENT_ROLE: name,
    };

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

  private triggerSynthesis(): void {
    const participantResults = Array.from(this.members.values())
      .filter((m) => m.role === "participant" && m.result)
      .map((m) => ({ name: m.name, result: m.result! }));

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

    synthSession.on("result", (text: string) => {
      this.emit("synthesis", text);
    });

    synthSession.on("error", (err: Error) => {
      this.emit("error", err);
    });

    synthSession.start();
  }
}
