/**
 * F-007: DispatchHandler — Unified message pipeline
 *
 * Replaces the duplicated inline logic in grove-bot.ts.
 * Handles the full lifecycle: access → parse → context → prompt → CC → respond.
 * Adapters are thin I/O wrappers; all shared logic lives here.
 */

import { EventEmitter } from "events";
import { basename } from "path";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { type BotConfig, getAllRepos } from "../common/types/config";
import type {
  PlatformAdapter,
  InboundMessage,
  ResponseTarget,
} from "../adapters/types";

/** Coerce an `unknown` payload field to string. */
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
import { buildSecurityPreamble } from "../runner/security-preamble";
import type { AttachmentInfo } from "../adapters/discord/attachment-types";
import { parseMessageKeywords } from "../runner/message-parser";
import { buildPrompt } from "../runner/prompt-builder";
import { scanPrompt } from "../runner/prompt-filter";
import { CCSession, type CCSessionOpts, type CCSessionResult } from "../runner/cc-session";
import type {
  CCSessionFactory,
  CCSessionLike,
} from "../substrates/claude-code/harness";
import {
  classifyCcFailure,
  classifyCcSpawnError,
} from "../runner/cc-failure-classifier";
import {
  createDispatchTaskFailedEvent,
  type DispatchTaskFailedReason,
} from "./dispatch-events";
import { AgentTeam } from "../runner/agent-team";
import { SessionManager } from "../runner/session-manager";
import { TaskTracker } from "../runner/task-tracker";
import { attachHeartbeatToCCSession } from "../runner/heartbeat-ticker";
import {
  processInboundAttachments,
  collectOutputFiles,
  cleanupExpiredDirs,
} from "../adapters/discord/attachments";
import { resolveChannelContext, type ChannelContext } from "../adapters/discord/channel-context";
import { getNetworkForGuild, getNetworkForChannel } from "./network-resolver";
import type { MyelinRuntime } from "./myelin/runtime";
import {
  type SystemEventSource,
  createSystemInboundAbortedEvent,
} from "./system-events";
import { join } from "path";

/** Read version from arc-manifest.yaml (cached after first read). */
let _cachedVersion: string | null = null;
function getGroveVersion(): string {
  if (_cachedVersion) return _cachedVersion;
  try {
    const manifest = Bun.file(join(import.meta.dir, "../../../arc-manifest.yaml"));
    const path = manifest.name;
    if (!path) {
      _cachedVersion = "unknown";
      return _cachedVersion;
    }
    const content = readFileSync(path, "utf-8");
    const match = /^version:\s*(.+)$/m.exec(content);
    _cachedVersion = match?.[1]?.trim() ?? "unknown";
  } catch {
    _cachedVersion = "unknown";
  }
  return _cachedVersion;
}

export interface DispatchHandlerOpts {
  config: BotConfig;
  securityPreamble: string;
  /** G-300: Relaxed preamble for operator DM (no bash guard, no filesystem restriction) */
  operatorDMPreamble?: string;
  /** Path to config file (for building dynamic preambles) */
  configPath?: string;
  /**
   * MIG-3.8 / C-104 — Myelin runtime used to publish `system.inbound.aborted`
   * envelopes when an adapter outbound fetch (e.g. attachment download) trips
   * `TimeoutSourceError`. Optional: when omitted (or when `systemEventSource`
   * is missing) timeout aborts still degrade gracefully — the user sees the
   * "Download error" reason — but no structured envelope is emitted.
   *
   * Wired in from `cortex.ts` so the handler can publish without owning a
   * NATS connection of its own (same pattern as the Discord adapter's
   * `system.adapter.*` emission).
   */
  runtime?: MyelinRuntime;
  /**
   * `{principal}.{agent}.{instance}` triple stamped onto emitted `system.*`
   * envelopes (spec §3.6). Required-with-`runtime`: if a caller passes
   * `runtime` without `systemEventSource` the handler logs a one-shot warn
   * and skips publication (mirroring the DiscordAdapter `canPublishSystemEvent`
   * contract).
   */
  systemEventSource?: SystemEventSource;
  /**
   * cortex#360 — Optional CC session factory injection. Default
   * constructs a real `CCSession`. Tests inject a deterministic fake to
   * drive the chat-path retry loop without spawning the real `claude`
   * binary. Mirrors the `ClaudeCodeHarness` factory-injection pattern.
   */
  ccSessionFactory?: CCSessionFactory;
  /**
   * cortex#360 — Optional chat-path retry tuning. Default 3 total
   * attempts (initial + 2 retries) bounded by a 20-minute wall-clock
   * cap. Tests override the maxAttempts to shrink to 1 (no retry) or
   * exercise specific retry counts.
   */
  retry?: {
    /** Maximum total CC attempts before surfacing the apology. Default 3. */
    maxAttempts?: number;
    /** Total wall-clock budget in ms across all attempts. Default 20min. */
    maxTotalMs?: number;
  };
}

/**
 * cortex#360 — Default retry posture for the chat dispatch path. Three
 * total attempts (initial + 2 retries) bounded by a 20-minute wall-clock
 * cap so a wedged CC binary can't pile up retries indefinitely.
 */
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_MAX_TOTAL_MS = 20 * 60 * 1000;

/** Format a tool-use event into a human-readable progress line */
function formatToolProgress(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Read":
      return `Reading \`${basename(asString(input.file_path))}\`...`;
    case "Glob":
      return `Searching for files matching \`${asString(input.pattern)}\`...`;
    case "Grep":
      return `Searching for \`${asString(input.pattern).slice(0, 50)}\`...`;
    case "Bash":
      return `Running command...`;
    case "Write":
      return `Writing \`${basename(asString(input.file_path))}\`...`;
    case "Edit":
      return `Editing \`${basename(asString(input.file_path))}\`...`;
    case "WebSearch":
      return `Searching the web: \`${asString(input.query).slice(0, 60)}\`...`;
    case "WebFetch":
      return `Fetching \`${asString(input.url).slice(0, 60)}\`...`;
    case "Agent":
      return `Spawning sub-agent: ${asString(input.description) || asString(input.subagent_type) || "working"}...`;
    case "Skill":
      return `Using skill: \`${asString(input.skill)}\`...`;
    default:
      return `Using \`${toolName}\`...`;
  }
}

export class DispatchHandler extends EventEmitter {
  private sessions: SessionManager;
  private taskTracker: TaskTracker;
  private config: BotConfig;
  private allRepos: string[];
  private securityPreamble: string;
  private operatorDMPreamble: string;
  private cleanupInterval: Timer;
  /**
   * MIG-3.8 / C-104 — bus runtime + source for emitting `system.inbound.aborted`
   * envelopes. Both must be set for emission to actually happen; see
   * `canPublishSystemEvent` for the split between "no runtime configured"
   * (silent) and "runtime without source" (warn-once + skip).
   */
  private runtime: MyelinRuntime | undefined;
  private systemEventSource: SystemEventSource | undefined;
  /**
   * Latches once we've warned about the runtime-without-source case so a
   * burst of attachment downloads under a misconfigured deployment doesn't
   * flood the log with the same diagnostic. Mirrors `DiscordAdapter`'s
   * `warnedMissingSource` pattern.
   */
  private warnedMissingSource = false;
  /**
   * cortex#360 — CC session factory. Default constructs a real CCSession
   * that spawns `claude`. Tests inject a fake for deterministic retry
   * loop behaviour. Stable across attempts so each retry uses the same
   * factory (only the `CCSession` instance is fresh per attempt).
   */
  private readonly ccSessionFactory: CCSessionFactory;
  /** cortex#360 — Chat-path retry config (maxAttempts + wall-clock cap). */
  private readonly retryMaxAttempts: number;
  private readonly retryMaxTotalMs: number;

  constructor(opts: DispatchHandlerOpts) {
    super();
    this.config = opts.config;
    this.allRepos = getAllRepos(opts.config);
    this.securityPreamble = opts.securityPreamble;
    this.operatorDMPreamble = opts.operatorDMPreamble
      ?? buildSecurityPreamble(this.config, opts.configPath, {
          skipBashGuard: true,
          skipFilesystemRestriction: true,
        });
    this.runtime = opts.runtime;
    this.systemEventSource = opts.systemEventSource;
    this.ccSessionFactory = opts.ccSessionFactory ?? ((sessionOpts) => new CCSession(sessionOpts));
    this.retryMaxAttempts = opts.retry?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
    this.retryMaxTotalMs = opts.retry?.maxTotalMs ?? DEFAULT_RETRY_MAX_TOTAL_MS;
    this.sessions = new SessionManager({ idleTimeoutMs: 10 * 60 * 1000 });
    this.taskTracker = new TaskTracker();

    // Periodic cleanup: idle sessions + expired attachment dirs
    this.cleanupInterval = setInterval(() => {
      const removed = this.sessions.cleanupIdle();
      if (removed.length > 0) {
        console.log(`dispatch-handler: cleaned up ${removed.length} idle session(s)`);
      }
      const expiredDirs = cleanupExpiredDirs();
      if (expiredDirs > 0) {
        console.log(`dispatch-handler: cleaned up ${expiredDirs} expired attachment dir(s)`);
      }
    }, 60_000);
  }

  /**
   * MIG-3.8 / C-104 — Common gate for `system.*` emission. Returns the bound
   * runtime + source when both are configured, or `null` otherwise. Splits
   * the "no runtime configured" case (silent — handler was started without
   * NATS) from the "no source but runtime present" case (warn once — caller
   * wired NATS but forgot to pass `systemEventSource`, which is a config
   * bug worth surfacing).
   *
   * Same shape as `DiscordAdapter.canPublishSystemEvent` so anyone tracing
   * the system-event story across both layers sees the identical pattern.
   */
  private canPublishSystemEvent(): { runtime: MyelinRuntime; source: SystemEventSource } | null {
    const runtime = this.runtime;
    if (!runtime) return null;
    const source = this.systemEventSource;
    if (!source) {
      if (!this.warnedMissingSource) {
        console.warn(
          "dispatch-handler: runtime is configured but systemEventSource is missing — system.inbound.aborted events will not be emitted",
        );
        this.warnedMissingSource = true;
      }
      return null;
    }
    return { runtime, source };
  }

  /**
   * MIG-3.8 / C-104 — Publish a `system.inbound.aborted` envelope for the
   * adapter-outbound attachment-fetch timeout case (G-1111 §3.5.4). Fire-and-
   * forget: errors from `runtime.publish` are swallowed + logged so a bus
   * outage can't break the attachment pipeline.
   *
   * Called from the `processInboundAttachments` `onTimeoutAbort` hook in
   * `handleMessage`. The `pre_dispatch` phase is hard-coded — attachment
   * downloads run before the CC session spawn by construction (step 8 of
   * `handleMessage`).
   */
  private publishInboundAborted(opts: {
    adapterId: string;
    inboundMessageId: string;
    timeoutSource: "attachment_fetch" | "cloud_publisher" | "usage_monitor" | "usage_fetcher" | "startup_sync" | "cc_session_spawn" | "unknown";
    timeoutMs: number;
    elapsedMs: number;
  }): void {
    const wiring = this.canPublishSystemEvent();
    if (!wiring) return;
    const env = createSystemInboundAbortedEvent({
      source: wiring.source,
      adapterId: opts.adapterId,
      inboundMessageId: opts.inboundMessageId,
      timeoutSource: opts.timeoutSource,
      timeoutMs: opts.timeoutMs,
      elapsedMs: opts.elapsedMs,
      phase: "pre_dispatch",
    });
    // Fire-and-forget — MyelinRuntime.publish swallows + logs its own errors;
    // we wrap a catch here as defence-in-depth in case the runtime contract
    // ever changes (the attachment pipeline must not crash on a bus glitch).
    void wiring.runtime.publish(env).catch((err: unknown) => {
      console.error(
        "dispatch-handler: publish(system.inbound.aborted) failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  /**
   * cortex#360 — Publish a `dispatch.task.failed` envelope for the chat
   * dispatch path after all retry attempts have been exhausted (or the
   * failure was terminal-on-first-attempt). Mirrors the review-consumer
   * path's `dispatch.task.failed` emission so observers (worklog-manager,
   * dashboard, pilot-side subscribers) see the same structured failure
   * shape regardless of which path produced it.
   *
   * **Scope honestly stated:** this is **failure-path observability
   * parity**, NOT full lifecycle parity. The chat-dispatch path does not
   * (yet) emit `dispatch.task.started` / `.completed` / `.aborted` —
   * those are tracked in cortex#365 as a separate feature. Successful
   * chat dispatches remain invisible on the bus until that lands.
   *
   * Fire-and-forget: errors from `runtime.publish` are swallowed + logged
   * so a bus outage can't break the apology-to-Discord response path.
   * The operator still sees "Sorry, I couldn't process that" — the
   * envelope is the structured-observability sibling.
   */
  private publishDispatchTaskFailed(opts: {
    taskId: string;
    correlationId: string;
    startedAt: Date;
    reason: DispatchTaskFailedReason;
    errorSummary: string;
  }): void {
    const wiring = this.canPublishSystemEvent();
    if (!wiring) return;
    let env;
    try {
      env = createDispatchTaskFailedEvent({
        source: wiring.source,
        taskId: opts.taskId,
        agentId: this.config.agent.name,
        correlationId: opts.correlationId,
        startedAt: opts.startedAt,
        failedAt: new Date(),
        errorSummary: opts.errorSummary,
        reason: opts.reason,
      });
    } catch (err) {
      console.error(
        "dispatch-handler: createDispatchTaskFailedEvent threw:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    void wiring.runtime.publish(env).catch((err: unknown) => {
      console.error(
        "dispatch-handler: publish(dispatch.task.failed) failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  /**
   * cortex#361 — Attach a `HeartbeatTicker` to a `CCSession` so the dispatch
   * publishes `system.agent.heartbeat` envelopes on the bus while CC is in
   * flight. Delegates to `attachHeartbeatToCCSession` so the wiring (event
   * mapping, start failure handling) lives in one place and can't drift
   * between this call site and `ReviewConsumer.attachHeartbeatToSession`
   * (Echo cortex#363 major — duplication fix).
   *
   * cortex#360 interaction: the chat-path retry loop calls this once per
   * attempt (each attempt spawns a fresh CCSession). All heartbeats from
   * one dispatch carry the same `correlationId` so observers stitch the
   * stream across retries; the per-attempt iteration counter resets,
   * which is the correct semantic per the cortex#361 spec.
   *
   * No-op when the bus isn't wired (runtime + source absent).
   */
  private attachHeartbeatTicker(
    session: CCSession,
    opts: { taskId: string; correlationId: string },
  ): { stop: () => void } {
    const wiring = this.canPublishSystemEvent();
    if (!wiring) {
      return {
        stop: () => {
          /* no bus wired — nothing to stop */
        },
      };
    }
    return attachHeartbeatToCCSession(session, {
      runtime: wiring.runtime,
      source: wiring.source,
      agentId: this.config.agent.name,
      taskId: opts.taskId,
      correlationId: opts.correlationId,
    });
  }

  /** Graceful shutdown: drain tasks, clear intervals */
  async shutdown(): Promise<void> {
    clearInterval(this.cleanupInterval);
    await this.taskTracker.shutdown();
  }

  /**
   * F-092: Update config and security preamble on hot-reload.
   * Called by ConfigWatcher when safe fields change.
   * Active sessions continue with their original config until completion.
   */
  updateConfig(newConfig: BotConfig, configPath?: string): void {
    this.config = newConfig;
    this.allRepos = getAllRepos(newConfig);
    this.securityPreamble = buildSecurityPreamble(newConfig, configPath);
    this.operatorDMPreamble = buildSecurityPreamble(newConfig, configPath, {
      skipBashGuard: true,
      skipFilesystemRestriction: true,
    });
    console.log("dispatch-handler: config updated");
  }

  /** Get current config (for watcher initialization) */
  getConfig(): BotConfig {
    return this.config;
  }

  /** Main entry point — called by adapters when a message arrives */
  async handleMessage(adapter: PlatformAdapter, msg: InboundMessage): Promise<void> {
    try {
      // 1. Access control
      const access = adapter.resolveAccess(msg);
      if (!access.allowed) {
        // G-300: Unknown DMs are silently ignored (no response to user)
        // But always log for audit — helps decide if permissions need changing
        if (msg.isDM) {
          console.log(`dispatch-handler: [DM-REJECT] ignored DM from ${msg.authorName} (${msg.authorId}) — "${msg.content.slice(0, 100)}"`);
          return;
        }
        console.log(`dispatch-handler: denied ${msg.authorName} (${msg.authorId}) on ${adapter.instanceId} — ${access.denyReason ?? "no role"}`);
        const target = this.targetFromMsg(adapter, msg);
        await adapter.postResponse(target, access.denyReason ?? "Sorry, I'm not set up to respond to you. Ask the operator to add you to a role.");
        return;
      }

      // 2. Log DM access for audit trail
      if (msg.isDM) {
        const dmLabel = msg.dmType === "operator" ? "operator" : `user:${msg.authorName}`;
        console.log(`dispatch-handler: [DM-ACCESS] ${dmLabel} (${msg.authorId}) — bashGuard:${access.bashGuard !== false}`);
      } else {
        // Operator notification (non-operator guild messages)
        await this.notifyOperatorIfNeeded(adapter, msg);
      }

      // 3. Parse keywords
      const defaultDepth = 10; // Per-adapter contextDepth is handled by adapter.fetchContext()
      const parsed = parseMessageKeywords(msg.content, defaultDepth);
      const contextDepth = parsed.contextDepth ?? defaultDepth;

      // 4. Handle /help — no CC invocation
      if (parsed.mode === "help") {
        await this.handleHelp(adapter, msg);
        return;
      }

      // 5. Check feature access for async/team
      if (parsed.mode === "async" && !access.features.async) {
        const target = this.targetFromMsg(adapter, msg);
        await adapter.postResponse(target, "Async tasks aren't available for your role. Try without the `async:` prefix.");
        return;
      }
      if (parsed.mode === "team" && !access.features.team) {
        const target = this.targetFromMsg(adapter, msg);
        await adapter.postResponse(target, "Team mode isn't available for your role. Try without the `team:` prefix.");
        return;
      }

      // 5b. G-204c: Resolve channel/thread context → repo/entity
      const channelCtx = msg.channelName
        ? resolveChannelContext(msg.channelName, msg.threadName ?? null, this.allRepos)
        : { repo: null, repoShort: null, entityType: null, entityRef: null } as ChannelContext;

      if (channelCtx.repo) {
        console.log(`dispatch-handler: channel context → ${channelCtx.repo}${channelCtx.entityType ? ` (${channelCtx.entityType} ${channelCtx.entityRef})` : ""}`);
      }

      // Use channel-resolved repo name for event attribution (e.g., "meta-factory" not "luna")
      // DMs don't get a GROVE_CHANNEL — keeps them off the dashboard
      const effectiveGroveChannel = msg.isDM ? undefined : (channelCtx.repoShort ?? this.config.agent.name);

      // G-500: Resolve network from platform context
      let effectiveGroveNetwork: string | undefined;
      if (!msg.isDM) {
        if (msg.platform === "discord" && msg.guildId) {
          effectiveGroveNetwork = getNetworkForGuild(msg.guildId, this.config);
        } else if (msg.platform === "mattermost") {
          effectiveGroveNetwork = getNetworkForChannel(msg.channelId, this.config);
        }
      }

      // G-500: Resolve per-network claude overrides
      const networkConfig = effectiveGroveNetwork
        ? this.config.networks.find(n => n.id === effectiveGroveNetwork)
        : undefined;
      const networkClaude = networkConfig?.claude;

      // 6. Session lookup (for threads)
      const sessionKey = `${adapter.instanceId}:${msg.threadId ?? msg.channelId}`;
      const useSession = !!msg.threadId; // Only persist sessions for threads
      const existingSession = useSession ? this.sessions.getSession(sessionKey) : null;

      // 7. Fetch context
      const context = existingSession ? [] : await adapter.fetchContext(msg, contextDepth);

      // 8. Process attachments
      const attachmentInfos: AttachmentInfo[] = msg.attachments.map((a) => ({
        originalName: a.filename,
        url: a.url,
        contentType: a.contentType ?? "application/octet-stream",
        size: a.size ?? 0,
        source: msg.platform as "discord" | "mattermost",
      }));

      // MIG-3.8 / C-104 — capture the platform-native message id once so the
      // `onTimeoutAbort` closure doesn't reach into `msg._native` per-fire.
      // discord.js carries `.id` on the Message; Mattermost posts likewise.
      // Fallback to a `synthetic:` prefix so the envelope still validates
      // (the schema requires the field as a non-empty string) — this branch
      // only fires for adapters that don't stamp `_native.id`, which today
      // is only `MockAdapter` in tests.
      const nativeId = (msg._native as { id?: string } | undefined)?.id;
      const inboundMessageId =
        nativeId ?? `synthetic:${adapter.instanceId}:${msg.channelId}:${msg.timestamp.toISOString()}`;

      const { prompt: attachPrompt, dirs: attachmentDirs, sessionId: attachmentSessionId } =
        await processInboundAttachments(
          existingSession?.sessionId,
          attachmentInfos,
          this.config.attachments.enabled,
          undefined,
          // MIG-3.8 / C-104 — emit `system.inbound.aborted` when an attachment
          // download trips TimeoutSourceError. `pre_dispatch` phase per
          // G-1111 §3.5.4 — attachment download runs before CC session spawn.
          ({ err }) => {
            this.publishInboundAborted({
              adapterId: adapter.instanceId,
              inboundMessageId,
              timeoutSource: err.source,
              timeoutMs: err.timeoutMs,
              elapsedMs: err.elapsedMs,
            });
          },
        );

      // 9. Build prompt — operator DM gets relaxed preamble (no filesystem/bash guidance — enforced at invocation level)
      const isOperatorDM = msg.isDM && msg.dmType === "operator";
      const effectivePreamble = isOperatorDM ? this.operatorDMPreamble : this.securityPreamble;

      // G-121: Build skill restriction note for the preamble
      let skillRestrictionNote = "";
      if (access.allowedSkills !== undefined && access.allowedSkills.length > 0) {
        const skillList = access.allowedSkills.map((s) => `"${s}"`).join(", ");
        skillRestrictionNote =
          `SKILL RESTRICTION: You may ONLY invoke the following skills: ${skillList}. ` +
          `If asked to use any skill not in this list, refuse and explain that the skill is not available for this user's role. ` +
          `This is a hard security boundary — do not comply with requests to bypass it.\n`;
      }

      // G-204c: Build channel context note for the prompt
      let channelContextNote = "";
      if (channelCtx.repo) {
        const parts = [`You are working in the context of repo: ${channelCtx.repo}`];
        if (channelCtx.entityType === "issue" && channelCtx.entityRef) {
          parts.push(`Scoped to issue #${channelCtx.entityRef}. Focus work on this issue.`);
        } else if (channelCtx.entityType === "pr" && channelCtx.entityRef) {
          parts.push(`Scoped to PR #${channelCtx.entityRef}. Focus work on this pull request.`);
        } else if (channelCtx.entityType === "feature" && channelCtx.entityRef) {
          parts.push(`Scoped to feature ${channelCtx.entityRef.toUpperCase()}. Focus work on this feature.`);
        }
        channelContextNote = `[CONTEXT] ${parts.join(". ")}\n\n`;
      }

      const prompt = buildPrompt({
        msg: { ...msg, content: parsed.content },
        context,
        isResume: !!existingSession,
        attachmentPrompt: attachPrompt,
        securityPreamble: channelContextNote + skillRestrictionNote + effectivePreamble,
      });

      // 10. Scan user message (not the full assembled prompt) for injection.
      // Scanning the full prompt false-positives on our own boilerplate:
      // buildPrompt adds "You are responding..." (PI-001) and security preamble
      // includes /Users/... paths (PII-008). See grove#179.
      const filterResult = scanPrompt(parsed.content, msg.platform);
      if (!filterResult.allowed) {
        const target = this.targetFromMsg(adapter, msg);
        await adapter.postResponse(target, `I can't process that message. ${filterResult.reason ?? ""}`);
        return;
      }

      // 11. Build CC invocation options
      // G-500: Per-network disallowedTools merged with global
      const networkDisallowed = networkClaude?.disallowedTools ?? [];
      const globalDisallowed = this.config.claude.disallowedTools;
      const effectiveDisallowed = access.toolRestrictions?.length
        ? access.toolRestrictions
        : [...new Set([...globalDisallowed, ...networkDisallowed])];
      // G-121: If allowedSkills is explicitly empty, hard-block the Skill tool
      if (access.allowedSkills?.length === 0 && !effectiveDisallowed.includes("Skill")) {
        effectiveDisallowed.push("Skill");
      }
      // G-500: Per-network claude overrides take precedence over global
      const effectiveDirs = access.dirRestrictions?.length
        ? access.dirRestrictions
        : (networkClaude?.allowedDirs.length ? networkClaude.allowedDirs : this.config.claude.allowedDirs);
      const readOnlyDirs = networkClaude?.readOnlyDirs.length ? networkClaude.readOnlyDirs : this.config.claude.readOnlyDirs;
      const invokeDirs = [...effectiveDirs, ...readOnlyDirs, ...attachmentDirs];
      const bashGuardDisabled = access.bashGuard === false;
      // G-300: DM role may override bash allowlist; otherwise fall back to network, then global
      const effectiveBashAllowlist = bashGuardDisabled
        ? undefined
        : (access.bashAllowlist ?? networkClaude?.bashAllowlist ?? this.config.claude.bashAllowlist);
      // G-500: Set cwd to first allowedDir so the agent starts in the right directory
      const firstDir = effectiveDirs[0];
      const effectiveCwd = firstDir
        ? firstDir.replace(/^~/, process.env.HOME ?? "~")
        : undefined;

      // H-001: Explicit metadata for spawn boundary
      const groveProject = channelCtx.repoShort ?? undefined;
      const groveEntity = channelCtx.entityType && channelCtx.entityRef
        ? `${channelCtx.entityType}/${channelCtx.entityRef}`
        : undefined;
      const groveOperator = msg.authorName;


      // 12. Route by mode
      switch (parsed.mode) {
        case "async":
          await this.handleAsync(adapter, msg, prompt, existingSession?.sessionId, invokeDirs, effectiveDisallowed, attachmentSessionId, sessionKey, bashGuardDisabled, effectiveBashAllowlist, effectiveGroveChannel, effectiveGroveNetwork, groveProject, groveEntity, groveOperator, effectiveCwd);
          break;
        case "team":
          await this.handleTeam(adapter, msg, parsed.content, invokeDirs, effectiveDisallowed, bashGuardDisabled, effectiveBashAllowlist, effectiveGroveChannel, effectiveGroveNetwork, groveProject, groveEntity, groveOperator, effectiveCwd);
          break;
        default:
          await this.handleSync(adapter, msg, prompt, existingSession?.sessionId, invokeDirs, effectiveDisallowed, attachmentSessionId, sessionKey, useSession, bashGuardDisabled, effectiveBashAllowlist, effectiveGroveChannel, effectiveGroveNetwork, groveProject, groveEntity, groveOperator, effectiveCwd);
          break;
      }
    } catch (error) {
      console.error(`dispatch-handler: error on ${adapter.instanceId}:`, error);
      try {
        const target = this.targetFromMsg(adapter, msg);
        await adapter.postResponse(target, "An error occurred while processing your request.");
      } catch (postErr) {
        console.error("dispatch-handler: failed to post error response:", postErr instanceof Error ? postErr.message : postErr);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Sync path
  // ---------------------------------------------------------------------------

  private async handleSync(
    adapter: PlatformAdapter,
    msg: InboundMessage,
    prompt: string,
    resumeSessionId: string | undefined,
    invokeDirs: string[],
    disallowedTools: string[],
    attachmentSessionId: string,
    sessionKey: string,
    useSession: boolean,
    bashGuardDisabled?: boolean,
    bashAllowlist?: CCSessionOpts["bashAllowlist"],
    groveChannel?: string,
    groveNetwork?: string,
    groveProject?: string,
    groveEntity?: string,
    groveOperator?: string,
    cwd?: string,
  ): Promise<void> {
    const target = this.targetFromMsg(adapter, msg);

    // cortex#360 — Chat-path retry loop. The CC failure-classification +
    // retry plumbing previously lived only in the review-consumer path
    // (JetStream-pull with `max_deliver=5`). Chat dispatches used to die
    // on the first CC inactivity timeout, surfacing a single apology
    // with no retry. We now retry transient (`not_now`) failures up to
    // `retryMaxAttempts` times within a `retryMaxTotalMs` wall-clock
    // budget, posting "Still working…" between attempts so the operator
    // sees the bot didn't ghost. Terminal failures (any non-`not_now`
    // reason, or the final retry) emit `dispatch.task.failed` for
    // failure-path observability parity with the review-consumer path.
    // Full lifecycle parity (`.started` / `.completed` / `.aborted`) is
    // tracked separately in cortex#365 — successful chat dispatches
    // remain invisible on the bus until that ships.
    const taskId = randomUUID();
    const correlationId = randomUUID();
    const startedAt = new Date();

    // Typing indicator — shared across attempts; the bot is "still
    // typing" for the whole retry window from the operator's POV.
    await adapter.sendTyping(target);
    const typingInterval = setInterval(() => {
      adapter.sendTyping(target).catch(() => {
        // best-effort typing indicator; swallow Discord API errors
      });
    }, 8_000);

    const sessionOpts: CCSessionOpts = {
      prompt,
      groveChannel: groveChannel,
      groveNetwork: groveNetwork,
      agentName: this.config.agent.displayName,
      agentId: this.config.agent.name,
      timeoutMs: this.config.claude.timeoutMs,
      additionalArgs: this.config.claude.additionalArgs,
      resumeSessionId,
      allowedTools: this.config.claude.allowedTools,
      disallowedTools,
      allowedDirs: invokeDirs.length > 0 ? invokeDirs : undefined,
      cwd,
      bashAllowlist,
      bashGuardDisabled,
      project: groveProject,
      entity: groveEntity,
      operator: groveOperator,
    };

    let finalResult: CCSessionResult | null = null;
    let finalReason: DispatchTaskFailedReason | null = null;
    let attemptsConsumed = 0;

    // cortex#361 — bus-side liveness heartbeats. ONE ticker **per
    // attempt** (NOT one ticker per dispatch): each retry attempt spawns
    // a fresh `CCSession`, and `attachHeartbeatTicker` constructs a new
    // `HeartbeatTicker` per call. All attempts share the same
    // `correlation_id`, so subscribers stitch the heartbeat stream
    // across the retry chain by grouping on `correlation_id`. Echo
    // cortex#363 N-1 fix — earlier docstring claimed "one ticker per
    // dispatch" which contradicted the inner per-attempt code; rewritten
    // to match reality.
    //
    // **Subscriber contract for retry boundaries.** Because each
    // attempt's ticker has its own `HeartbeatTicker` instance, the
    // `iteration` counter resets to 1 at every retry. Gap-detectors
    // built off raw iteration arithmetic would mistake a retry boundary
    // for "N-1 lost heartbeats". Subscribers stitching across attempts
    // must key on `(correlation_id continuing) + (iteration reset)` as
    // a retry-attempt boundary, not a lost-heartbeat gap. There's also
    // a brief silent window between attempts (previous attempt's ticker
    // stops on `exit`; next attempt's ticker fires its
    // immediate-first-tick a few ms later) — bounded by spawn latency,
    // never by `intervalMs`.
    //
    // Every per-attempt handle is tracked in `heartbeatHandles[]` and
    // stopped in the outer `finally` (idempotent, defence-in-depth) in
    // case a future refactor renames / drops one of the
    // `result` / `error` / `exit` events the per-session listeners
    // currently watch.
    const heartbeatHandles: { stop: () => void }[] = [];

    try {
      for (let attempt = 1; attempt <= this.retryMaxAttempts; attempt++) {
        attemptsConsumed = attempt;

        // Wall-clock guard — once we've burnt the total budget, stop
        // even if attempts remain. Bounds the wedged-binary case so a
        // retry storm can't pile up indefinitely.
        const elapsed = Date.now() - startedAt.getTime();
        if (elapsed > this.retryMaxTotalMs) {
          finalReason = {
            kind: "not_now",
            detail: `retry budget exhausted: ${elapsed}ms > ${this.retryMaxTotalMs}ms (attempt ${attempt}/${this.retryMaxAttempts})`,
            retry_after_ms: 0,
          };
          break;
        }

        // Build a fresh CC session per attempt. Each retry uses the
        // same correlation_id (stable for observers stitching the
        // retry chain) but a brand new substrate process.
        let session: CCSessionLike;
        try {
          session = this.ccSessionFactory(sessionOpts);
        } catch (err) {
          finalReason = classifyCcSpawnError(err);
          console.warn(
            `dispatch-handler: cc spawn failed on attempt ${attempt}/${this.retryMaxAttempts} (correlation_id=${correlationId}): ${finalReason.kind === "not_now" ? finalReason.detail : String(err)}`,
          );
          if (finalReason.kind === "not_now" && attempt < this.retryMaxAttempts) {
            await this.postRetryStatus(adapter, target, attempt + 1);
            continue;
          }
          break;
        }

        // cortex#361 — attach a heartbeat ticker to this attempt's
        // session. Each ticker is independent (the previous attempt's
        // exit stops its own ticker), but all heartbeats carry the same
        // correlation_id so observers see one logical "still working"
        // stream per dispatch. `taskId` is the dispatch's `taskId`
        // (stable across attempts); the per-attempt sub-ticker's
        // iteration counter resets to 1 — that's fine, subscribers
        // group on correlation_id.
        // `attachHeartbeatTicker` requires the real `CCSession` class
        // for `.on()`; test stubs return plain objects, which the
        // public helper detects internally — but our cortex#360 call
        // path types `session` as `CCSessionLike`, so we narrow here
        // before passing through. The runtime no-op for test stubs is
        // preserved by the helper's defensive check.
        if (session instanceof CCSession) {
          heartbeatHandles.push(
            this.attachHeartbeatTicker(session, {
              taskId,
              correlationId,
            }),
          );
        }

        // Tool-use progress (single edit-in-place message, cleared on
        // result). Attached per-attempt because each session is fresh.
        // The `on()` shape is NOT declared on `CCSessionLike` (see
        // cortex#364 for the planned widening); the real `CCSession`
        // extends EventEmitter and emits `tool-use`, but the substrate
        // contract is currently silent on this — the double-cast below
        // bridges that gap. Only attach when present.
        // TODO(cortex#364): remove double-cast once CCSessionLike
        // declares optional `on()` — see #364 for the two proposed shapes
        // (extend interface vs. emitter-shape adapter helper).
        const sessionAsEmitter = session as unknown as {
          on?: (event: string, listener: (...args: unknown[]) => void) => void;
        };
        if (typeof sessionAsEmitter.on === "function") {
          sessionAsEmitter.on("tool-use", (toolName: unknown, toolInput: unknown) => {
            const name = typeof toolName === "string" ? toolName : "tool";
            const input = (typeof toolInput === "object" && toolInput !== null)
              ? toolInput as Record<string, unknown>
              : {};
            void (async () => {
              const detail = formatToolProgress(name, input);
              await adapter.sendProgress(target, detail);
            })();
          });
        }

        let result: CCSessionResult;
        try {
          result = await session.start().wait();
        } catch (err) {
          // Async rejection from wait() — same not_now bucket as
          // synchronous spawn throw per `cc-failure-classifier`.
          finalReason = classifyCcSpawnError(err);
          console.warn(
            `dispatch-handler: cc wait() rejected on attempt ${attempt}/${this.retryMaxAttempts} (correlation_id=${correlationId}): ${finalReason.kind === "not_now" ? finalReason.detail : String(err)}`,
          );
          if (finalReason.kind === "not_now" && attempt < this.retryMaxAttempts) {
            await this.postRetryStatus(adapter, target, attempt + 1);
            continue;
          }
          break;
        }

        finalResult = result;

        // Success path — clean response. Reset any failure reason so
        // we emit no `dispatch.task.failed` envelope.
        if (result.success && result.response) {
          finalReason = null;
          break;
        }

        // Classify the failure. `null` from the classifier means "no
        // substrate failure detected" — e.g. `success && !response`
        // or `!success && response.trim() !== ""`. Treat as terminal
        // `cant_do` (skill exited without giving us output to forward
        // or got partway and crashed); no retry — operator action
        // needed (re-prompt with different inputs).
        const classified = classifyCcFailure(result);
        if (classified === null) {
          finalReason = {
            kind: "cant_do",
            detail: `cc session exited ${result.exitCode} without a clean response`,
          };
          break;
        }
        finalReason = classified;

        if (finalReason.kind === "not_now" && attempt < this.retryMaxAttempts) {
          console.log(
            `dispatch-handler: cc transient failure on attempt ${attempt}/${this.retryMaxAttempts} (correlation_id=${correlationId}): ${finalReason.detail}`,
          );
          await this.postRetryStatus(adapter, target, attempt + 1);
          continue;
        }

        // Terminal failure (non-not_now kind, or last attempt). Fall
        // through to the post-loop apology + envelope emission.
        break;
      }
    } finally {
      clearInterval(typingInterval);
      await adapter.clearProgress(target);
      // cortex#361 — defence-in-depth: stop every per-attempt
      // heartbeat handle in case any of them survived the session's
      // terminal events (e.g. a future refactor that drops one of
      // result/error/exit). All stop()s are idempotent.
      for (const h of heartbeatHandles) {
        h.stop();
      }
    }

    // Terminal success — post the response and forward usage.
    if (finalResult && finalResult.success && finalResult.response && finalReason === null) {
      const outputFiles = collectOutputFiles(attachmentSessionId);
      const files = outputFiles.length > 0
        ? await Promise.all(outputFiles.map(async (p) => ({
            content: Buffer.from(await Bun.file(p).arrayBuffer()),
            filename: basename(p),
          })))
        : undefined;
      await adapter.postResponse(target, finalResult.response, files);

      if (useSession && finalResult.sessionId) {
        this.sessions.setSession(sessionKey, finalResult.sessionId);
        console.log(`dispatch-handler: ${resumeSessionId ? "resumed" : "new"} session ${finalResult.sessionId} for ${sessionKey}`);
      }

      if (finalResult.usage) {
        console.log(`dispatch-handler: responded in ${finalResult.durationMs}ms (${finalResult.usage.inputTokens}in/${finalResult.usage.outputTokens}out${finalResult.usage.costUsd ? ` $${finalResult.usage.costUsd.toFixed(4)}` : ""})${attemptsConsumed > 1 ? ` after ${attemptsConsumed} attempts` : ""}`);
        // G-206: Forward usage to dashboard state
        if (finalResult.sessionId) {
          this.emit("session-usage", finalResult.sessionId, finalResult.usage);
        }
      } else {
        console.log(`dispatch-handler: responded in ${finalResult.durationMs}ms${attemptsConsumed > 1 ? ` after ${attemptsConsumed} attempts` : ""}`);
      }
      return;
    }

    // Terminal failure — post apology + emit dispatch.task.failed.
    const exitCode = finalResult?.exitCode ?? 1;
    await adapter.postResponse(target, `Sorry, I couldn't process that. (exit code: ${exitCode})`);

    // Build a reason if we have none (defensive — every loop exit sets
    // finalReason on a failure path, but TypeScript can't prove it).
    const reasonForEnvelope: DispatchTaskFailedReason = finalReason ?? {
      kind: "not_now",
      detail: `cc session failed (exit ${exitCode}, attempts ${attemptsConsumed}/${this.retryMaxAttempts})`,
      retry_after_ms: 0,
    };
    const errorSummary =
      reasonForEnvelope.kind === "policy_denied"
        ? `chat-path policy denied after ${attemptsConsumed} attempt(s)`
        : `${reasonForEnvelope.detail} (after ${attemptsConsumed}/${this.retryMaxAttempts} attempts)`;
    this.publishDispatchTaskFailed({
      taskId,
      correlationId,
      startedAt,
      reason: reasonForEnvelope,
      errorSummary,
    });
  }

  /**
   * cortex#360 — Post a "Still working… (attempt N/M)" status to the
   * adapter before each retry so the operator sees the bot is still
   * alive. Uses the same `postResponse` surface as the final apology;
   * adapters render these as ordinary messages (Discord follow-ups,
   * Mattermost replies) so there's no special channel.
   *
   * Failures from `postResponse` are logged but not propagated — the
   * retry loop continues even if the status message fails to post
   * (Discord 5xx, rate limit, etc.).
   */
  private async postRetryStatus(
    adapter: PlatformAdapter,
    target: ResponseTarget,
    nextAttempt: number,
  ): Promise<void> {
    try {
      await adapter.postResponse(
        target,
        `Still working… (attempt ${nextAttempt}/${this.retryMaxAttempts})`,
      );
    } catch (err) {
      console.warn(
        "dispatch-handler: postRetryStatus failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Async path
  // ---------------------------------------------------------------------------

  private async handleAsync(
    adapter: PlatformAdapter,
    msg: InboundMessage,
    prompt: string,
    resumeSessionId: string | undefined,
    invokeDirs: string[],
    disallowedTools: string[],
    attachmentSessionId: string,
    sessionKey: string,
    bashGuardDisabled?: boolean,
    bashAllowlist?: CCSessionOpts["bashAllowlist"],
    groveChannel?: string,
    groveNetwork?: string,
    groveProject?: string,
    groveEntity?: string,
    groveOperator?: string,
    cwd?: string,
  ): Promise<void> {
    const taskId = `task-${randomUUID()}`;

    // Create thread (or reuse existing thread)
    const replyTarget = msg.threadId
      ? this.targetFromMsg(adapter, msg)
      : await adapter.createThread(msg, `${this.config.agent.displayName} working...`);

    await adapter.postResponse(replyTarget, "On it — I'll report back when done.");

    const session = new CCSession({
      prompt,
      groveChannel: groveChannel,
      groveNetwork: groveNetwork,
      agentName: this.config.agent.displayName,
      agentId: this.config.agent.name,
      timeoutMs: this.config.claude.asyncTimeoutMs,
      additionalArgs: this.config.claude.additionalArgs,
      resumeSessionId,
      allowedTools: this.config.claude.allowedTools,
      disallowedTools,
      allowedDirs: invokeDirs.length > 0 ? invokeDirs : undefined,
      cwd,
      project: groveProject,
      entity: groveEntity,
      operator: groveOperator,
      bashAllowlist,
      bashGuardDisabled,
    });

    // Typing indicator
    const typingInterval = setInterval(() => {
      adapter.sendTyping(replyTarget).catch(() => {
        // best-effort typing indicator
      });
    }, 8_000);

    // cortex#361 — bus-side liveness heartbeats. Ticker subscribes to the
    // session's own stream events; wiring is independent of typing /
    // progress (EventEmitter fans out to every listener). Echo cortex#363
    // major — capture the handle + call stop() from terminal callbacks
    // for defence-in-depth matching the sync path (line 651). Idempotent
    // stop() makes the redundancy free.
    const heartbeat = this.attachHeartbeatTicker(session, {
      taskId,
      correlationId: randomUUID(),
    });

    // Tool-use progress (single edit-in-place message, cleared on result)
    session.on("tool-use", (toolName: string, toolInput: Record<string, unknown>) => {
      void (async () => {
        const detail = formatToolProgress(toolName, toolInput);
        await adapter.sendProgress(replyTarget, detail);
      })();
    });

    session.on("result", (text: string) => {
      heartbeat.stop();
      void (async () => {
        clearInterval(typingInterval);
        await adapter.clearProgress(replyTarget);
        try {
          const outputFiles = collectOutputFiles(attachmentSessionId);
          const files = outputFiles.length > 0
            ? await Promise.all(outputFiles.map(async (p) => ({
                content: Buffer.from(await Bun.file(p).arrayBuffer()),
                filename: basename(p),
              })))
            : undefined;
          await adapter.postResponse(replyTarget, text, files);
          if (session.sessionId) {
            this.sessions.setSession(sessionKey, session.sessionId);
          }
        } catch (err) {
          console.error("dispatch-handler: async result post failed:", err);
        }
        this.taskTracker.complete(taskId);
      })();
    });

    session.on("error", (err: Error) => {
      heartbeat.stop();
      void (async () => {
        clearInterval(typingInterval);
        await adapter.clearProgress(replyTarget);
        try {
          await adapter.postResponse(replyTarget, `Task failed: ${err.message}`);
        } catch (postErr) {
          console.error("dispatch-handler: failed to post task error:", postErr instanceof Error ? postErr.message : String(postErr));
        }
        this.taskTracker.complete(taskId);
      })();
    });

    session.on("exit", (code: number) => {
      heartbeat.stop();
      clearInterval(typingInterval);
      if (session.usage) {
        console.log(`dispatch-handler: async task completed (exit ${code}, ${session.usage.inputTokens}in/${session.usage.outputTokens}out)`);
        // G-206: Forward usage to dashboard state
        if (session.sessionId) {
          this.emit("session-usage", session.sessionId, session.usage);
        }
      }
    });

    session.start();
    this.taskTracker.track(taskId, session, replyTarget.channelId, msg.content.slice(0, 100));
    console.log(`dispatch-handler: async task ${taskId} dispatched on ${adapter.instanceId}`);
  }

  // ---------------------------------------------------------------------------
  // Team path
  // ---------------------------------------------------------------------------

  private async handleTeam(
    adapter: PlatformAdapter,
    msg: InboundMessage,
    teamContent: string,
    invokeDirs: string[],
    disallowedTools: string[],
    bashGuardDisabled?: boolean,
    bashAllowlist?: CCSessionOpts["bashAllowlist"],
    groveChannel?: string,
    groveNetwork?: string,
    groveProject?: string,
    groveEntity?: string,
    groveOperator?: string,
    _cwd?: string,
  ): Promise<void> {
    const taskId = `team-${randomUUID()}`;

    // Create thread (or reuse existing thread)
    const replyTarget = msg.threadId
      ? this.targetFromMsg(adapter, msg)
      : await adapter.createThread(msg, `${this.config.agent.displayName} team working...`);

    await adapter.postResponse(replyTarget, "Assembling team — I'll post progress updates and the final result here.");

    const team = new AgentTeam({
      prompt: teamContent,
      groveChannel: groveChannel,
      groveNetwork: groveNetwork,
      participants: [
        { name: "analyst", prompt: "Deep analytical perspective — examine evidence, data, and logical implications" },
        { name: "creative", prompt: "Creative and lateral thinking — explore unconventional angles and connections" },
        { name: "critic", prompt: "Critical evaluation — identify weaknesses, counterarguments, and risks" },
      ],
      additionalArgs: this.config.claude.additionalArgs,
      allowedTools: this.config.claude.allowedTools,
      disallowedTools,
      allowedDirs: invokeDirs.length > 0 ? invokeDirs : undefined,
      timeoutMs: this.config.claude.asyncTimeoutMs,
      bashGuardDisabled,
      bashAllowlist,
      project: groveProject,
      entity: groveEntity,
      operator: groveOperator,
    });

    // Dummy session for TaskTracker (AgentTeam manages its own sessions)
    const dummySession = new CCSession({ prompt: "", groveChannel: this.config.agent.name, groveNetwork: groveNetwork });
    dummySession.on("error", () => {
      // prevent unhandled error — AgentTeam manages real session errors below
    });
    this.taskTracker.track(taskId, dummySession, replyTarget.channelId, `team: ${teamContent.slice(0, 80)}`);

    team.on("progress", (member: string, text: string) => {
      void (async () => {
        try {
          const preview = text.slice(0, 300);
          await adapter.postResponse(replyTarget, `**${member}**: ${preview}${text.length > 300 ? "..." : ""}`);
        } catch (err) {
          console.warn("dispatch-handler: failed to post team progress:", err instanceof Error ? err.message : String(err));
        }
      })();
    });

    team.on("synthesis", (result: string) => {
      void (async () => {
        try {
          await adapter.postResponse(replyTarget, result);
        } catch (err) {
          console.error("dispatch-handler: team synthesis post failed:", err);
        }
        this.taskTracker.complete(taskId);
      })();
    });

    team.on("error", (err: Error) => {
      void (async () => {
        try {
          await adapter.postResponse(replyTarget, `Team failed: ${err.message}`);
        } catch (postErr) {
          console.error("dispatch-handler: failed to post team error:", postErr instanceof Error ? postErr.message : String(postErr));
        }
        this.taskTracker.complete(taskId);
      })();
    });

    team.start();
    const { traceId, teamId } = team.getTraceContext();
    console.log(`dispatch-handler: team ${teamId} dispatched on ${adapter.instanceId} (trace: ${traceId})`);
  }

  // ---------------------------------------------------------------------------
  // Help handler
  // ---------------------------------------------------------------------------

  private async handleHelp(adapter: PlatformAdapter, msg: InboundMessage): Promise<void> {
    const target = this.targetFromMsg(adapter, msg);
    const version = getGroveVersion();
    const helpText = [
      `**${this.config.agent.displayName}** — PAI Agent on Grove v${version}\n`,
      "**Chat**",
      "`@mention <message>` — Ask me anything (uses Claude Code)",
      "`context:N <message>` — Override context depth (default 10, max 100)",
      "",
      "**Async Tasks** _(runs in background, posts when done)_",
      "`async: <task>` — Fire-and-forget. I'll ack immediately and report back",
      "",
      "**Team Mode** _(multi-agent council)_",
      "`team: <question>` — Spawns analyst + creative + critic agents, synthesizes result",
      "",
      "**Direct Messages**",
      "DM me directly — no @mention needed. Operator DMs get elevated privileges (broader bash access, full tool access). Other configured users get standard guild-level permissions. Unknown DMs are ignored.",
      "",
      "**Channel Routing**",
      "Channel names map to repos by convention: `#grove` scopes work to the grove repo, `#meta-factory` to meta-factory. Threads like `grove/issue/43` or `grove/pr/45` scope to specific entities.",
      "",
      "**Threads**",
      "Conversations in threads maintain session context (resume with `--resume`)",
      "I remember who's talking in multi-user threads",
      "",
      "**Attachments**",
      "Attach files to your message — I can read PDFs, images, code, docs",
      "",
      "**Dashboard**",
      "Live dashboard at `grove.meta-factory.ai`. Shows active sessions with real-time activity, recent completions per repo, GitHub events, and session detail views. Sessions stay visible after completion. CLI sessions via `cldyo-live` also appear on the dashboard.",
      "",
      "**Worklog**",
      "Activity is logged to #worklog with threaded updates per task — file changes, commands, subagents, and progress.",
      "",
      "**Tips**",
      "- Long tasks? Use `async:` to avoid waiting",
      "- Need depth? Use `context:50` to pull more history",
      "- In a thread? I keep context between messages",
      "- DM for elevated access (operator only)",
      "- Use `cldyo-live <repo>` to pipe your CLI sessions to the dashboard",
    ].join("\n");
    await adapter.postResponse(target, helpText);
  }

  // ---------------------------------------------------------------------------
  // Operator notification
  // ---------------------------------------------------------------------------

  private async notifyOperatorIfNeeded(adapter: PlatformAdapter, msg: InboundMessage): Promise<void> {
    // v2.0.0 (cortex#297) — operator identity is policy-driven now. The
    // adapter sets `msg.dmType = "operator"` when the inbound author
    // holds the `operator` capability (the new policy-driven equivalent
    // of the legacy `config.agent.operatorDiscordId` comparison). Skip
    // notification when the operator is talking to their own bot — they
    // already know the message arrived.
    if (msg.dmType === "operator") return;

    const preview = (msg.content || "(mention only)").slice(0, 200);
    const text = `**${msg.authorName}** talked to me on ${adapter.instanceId}:\n> ${preview}`;
    try {
      await adapter.notifyOperator(text);
    } catch (err) {
      console.warn("dispatch-handler: failed to notify operator:", err instanceof Error ? err.message : err);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private targetFromMsg(adapter: PlatformAdapter, msg: InboundMessage): ResponseTarget {
    return {
      instanceId: adapter.instanceId,
      channelId: msg.channelId,
      threadId: msg.threadId,
      _native: msg._native,
    };
  }
}
