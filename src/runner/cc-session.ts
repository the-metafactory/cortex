/**
 * Streaming Claude Code session wrapper.
 * Spawns CC with --output-format stream-json and emits typed events.
 * The single CC invocation primitive in cortex — the legacy synchronous
 * `invokeClaudeCode()` was retired in MIG-4.8.
 */

import { EventEmitter } from "events";
import { homedir } from "os";
import { parseStreamLine, StreamLineBuffer, type UsageStats, type StreamEvent } from "./stream-parser";
import { buildClaudeArgs, type ClaudeInvocationOpts } from "./claude-invoker";
import {
  createIsolatedSettings,
  scopeSessionEnv,
  CORTEX_SKILL_GRANTS_ENV,
  type IsolatedSettings,
} from "./session-settings";

// Re-export for convenience
export type { UsageStats, StreamEvent };

export interface CCSessionOpts {
  prompt: string;
  channel?: string;
  /** G-501: Network identifier for event routing */
  network?: string;
  agentName?: string;
  agentId?: string;
  resumeSessionId?: string;
  /**
   * ST-P1 (cortex#964, refs #952) — the parent session id for this spawn. When
   * set, `buildSessionEnv` stamps `CORTEX_PARENT_SESSION_ID` on the child's env
   * so the child's EventLogger links its events to the parent session
   * (CONTEXT.md §Session tree). Unset for an agent-rooted session.
   */
  parentSessionId?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  allowedDirs?: string[];
  timeoutMs?: number;
  cwd?: string;
  additionalArgs?: string[];
  /** Bash allowlist config — passed to bash-guard.hook.ts via CORTEX_BASH_GUARD env var. */
  bashAllowlist?: { rules: { pattern: string; repos?: string[] }[]; repos: string[] };
  /** G-300: When true, disables bash guard entirely (principal DM). */
  bashGuardDisabled?: boolean;
  /** H-001: Explicit project context (e.g., "grove", "meta-factory") */
  project?: string;
  /** H-001: Entity context (e.g., "issue/43", "pr/45", "g-204") */
  entity?: string;
  /** H-001: Principal who triggered this session (Discord username or ID) */
  principal?: string;
  /**
   * cortex#701 (Part A — session settings isolation). When `true` (the
   * DEFAULT for every bot session), the session spawns under a
   * cortex-owned curated settings scope: `--setting-sources ""` (loads NO
   * ambient setting source — not the principal's global `user`, nor the
   * cwd repo's `project`/`local` `.claude/`, which `--settings` would
   * otherwise load additively) plus a generated `--settings` file carrying
   * ONLY cortex's own hooks. The child env is scoped so principal-personal
   * `CLAUDE_*` vars can't re-introduce hooks/plugins/settings. See
   * `session-settings.ts`.
   *
   * Set to `false` ONLY for a session the principal runs as themselves
   * (where inheriting their global settings is the intent). Bot sessions
   * spawned from the dispatch path leave this unset → isolated.
   */
  settingsIsolation?: boolean;
  /**
   * cortex#701 — override the cortex-owned `.claude` directory holding the
   * installed hook symlinks. Defaults to `${HOME}/.claude`. Exists so
   * tests can point at a fixture dir; production leaves it unset.
   */
  claudeDir?: string;
  /**
   * cortex#710 (Part B) — per-skill grant list for this session. When
   * NON-EMPTY, the curated settings file registers the Skill Guard
   * PreToolUse hook (matcher `Skill`), the bare `Skill` tool is broadly
   * allowed, and this list is passed to the hook via the
   * `CORTEX_SKILL_GRANTS` env var so it denies any skill ∉ the list.
   *
   * When `undefined`/empty, no Skill hook is registered and the caller is
   * expected to keep `disallowedTools: ["Skill"]` (default-deny, no Skill
   * tool). Set together as an atomic pair by the dispatch path — never
   * {`Skill(name)` allow + bare `Skill` deny}, which is broken (cortex#706).
   *
   * Only honoured when `settingsIsolation` is on (the default). A
   * principal-as-self session (`settingsIsolation:false`) inherits the
   * principal's full skill set and does not register the gate.
   */
  allowedSkills?: string[];
}

export interface CCSessionResult {
  success: boolean;
  response: string;
  sessionId?: string;
  exitCode: number;
  durationMs: number;
  usage?: UsageStats;
  /**
   * True when the session was killed from outside (inactivity timeout,
   * manual `kill()`, future shutdown signals) rather than exiting on its
   * own. Distinct from `success === false`: a CC process can fail without
   * being aborted, and the abort path settles `wait()` via the `error`
   * listener with `exitCode: 1` BEFORE the eventual SIGTERM/143 fires —
   * so callers cannot rely on `exitCode === 143` alone to detect aborts.
   *
   * Consumers (see `dispatch-listener`) use this to emit
   * `dispatch.task.aborted` instead of `dispatch.task.failed`.
   */
  aborted?: boolean;
  /**
   * Reason for the abort, when `aborted === true`. Currently the only
   * value emitted is `"timeout"` (inactivity timer fired); the field is
   * left open-ended so future kill paths (principal cancel, runner
   * shutdown) can populate it without a breaking change.
   */
  abortReason?: "timeout";
}

/**
 * cortex#774 (G-2a/G-3a) — layer cortex's instrumentation env vars onto the
 * (already-scoped) base env for a spawned CC session.
 *
 * Sets the canonical `CORTEX_*` names — `CORTEX_CHANNEL`, `CORTEX_NETWORK`,
 * `CORTEX_AGENT_NAME`, `CORTEX_AGENT_ID`, `CORTEX_PROJECT`, `CORTEX_ENTITY`,
 * and `CORTEX_PRINCIPAL` — that the EventLogger / SurfaceContext hooks read.
 * The legacy `GROVE_*` instrumentation names are NO LONGER set here; the
 * hooks retain a `GROVE_*` read-fallback (see `surface-env.ts` /
 * `principal-env.ts`) so external setters still on `GROVE_*` keep resolving
 * during the transition.
 *
 * Pure function: does not mutate `baseEnv`. Extracted from `start()` so the
 * spawned env is unit-testable without invoking the `claude` binary.
 */
export function buildSessionEnv(
  baseEnv: Record<string, string>,
  opts: Pick<
    CCSessionOpts,
    | "channel"
    | "network"
    | "agentName"
    | "agentId"
    | "project"
    | "entity"
    | "principal"
    | "parentSessionId"
  >,
): Record<string, string> {
  return {
    ...baseEnv,
    ...(opts.channel && { CORTEX_CHANNEL: opts.channel }),
    ...(opts.network && { CORTEX_NETWORK: opts.network }),
    ...(opts.agentName && { CORTEX_AGENT_NAME: opts.agentName }),
    ...(opts.agentId && { CORTEX_AGENT_ID: opts.agentId }),
    ...(opts.project && { CORTEX_PROJECT: opts.project }),
    ...(opts.entity && { CORTEX_ENTITY: opts.entity }),
    ...(opts.principal && { CORTEX_PRINCIPAL: opts.principal }),
    // ST-P1 (cortex#964) — child-session linkage. The spawned child's
    // EventLogger reads CORTEX_PARENT_SESSION_ID to parent its events.
    ...(opts.parentSessionId && { CORTEX_PARENT_SESSION_ID: opts.parentSessionId }),
  };
}

export class CCSession extends EventEmitter {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private timeoutId: Timer | null = null;
  private lineBuffer = new StreamLineBuffer();
  private startTime = 0;
  private stdoutDone: Promise<void> = Promise.resolve();
  /** cortex#701 — materialised curated-settings file for this session; cleaned up on exit. */
  private isolatedSettings: IsolatedSettings | null = null;

  sessionId?: string;
  result?: string;
  usage?: UsageStats;

  constructor(private opts: CCSessionOpts) {
    super();
  }

  /** Override timeout (must be called before start()). */
  setTimeout(ms: number): void {
    this.opts.timeoutMs = ms;
  }

  /** Spawn the CC process and start parsing stream-json output. */
  start(): this {
    this.startTime = performance.now();

    // cortex#701 (Part A) — settings isolation. Default ON for every bot
    // session: load NO ambient setting source (not the principal's global
    // `user`, nor the cwd repo's `project`/`local` `.claude/`) and load a
    // cortex-owned curated settings file with ONLY cortex's hooks. The args
    // are appended to additionalArgs so they sit before `-p <prompt>`
    // (buildClaudeArgs puts the prompt last).
    const isolate = this.opts.settingsIsolation !== false;
    // cortex#710 — per-skill grants. Non-empty → curated settings registers
    // the Skill Guard hook AND the grant list is exported to it via env. The
    // two MUST move together (the #706 atomicity lesson).
    const skillGrants = this.opts.allowedSkills;
    const hasSkillGrants =
      isolate && skillGrants !== undefined && skillGrants.length > 0;
    const isolationArgs: string[] = [];
    if (isolate) {
      this.isolatedSettings = createIsolatedSettings(
        this.opts.claudeDir ?? `${homedir()}/.claude`,
        skillGrants,
      );
      isolationArgs.push(...this.isolatedSettings.args);
    }

    // cortex#710 — when grants are present, the bare `Skill` tool must be
    // PERMITTED at the permission layer so the Skill Guard hook (registered
    // in the curated settings) is the real gate. Normalise the tool lists
    // here so CCSession is self-consistent regardless of which caller built
    // them (harness pre-pairs them; the dispatch-handler direct paths rely on
    // this). Strip any `Skill` deny, and add `Skill` to a NON-EMPTY allowlist
    // that lacks it (an empty allowlist means "no --allowedTools flag →
    // allow-by-default", which already permits the bare Skill tool).
    let effectiveAllowedTools = this.opts.allowedTools;
    let effectiveDisallowedTools = this.opts.disallowedTools;
    if (hasSkillGrants) {
      if (effectiveDisallowedTools?.includes("Skill")) {
        effectiveDisallowedTools = effectiveDisallowedTools.filter((t) => t !== "Skill");
      }
      if (
        effectiveAllowedTools !== undefined &&
        effectiveAllowedTools.length > 0 &&
        !effectiveAllowedTools.includes("Skill")
      ) {
        effectiveAllowedTools = [...effectiveAllowedTools, "Skill"];
      }
    }

    // Build args from existing buildClaudeArgs, then inject stream-json
    const invokerOpts: ClaudeInvocationOpts = {
      prompt: this.opts.prompt,
      channel: this.opts.channel,
      network: this.opts.network,
      resumeSessionId: this.opts.resumeSessionId,
      allowedTools: effectiveAllowedTools,
      disallowedTools: effectiveDisallowedTools,
      allowedDirs: this.opts.allowedDirs,
      additionalArgs: [
        "--verbose",
        "--output-format", "stream-json",
        ...isolationArgs,
        ...(this.opts.additionalArgs ?? []),
      ],
    };

    const args = buildClaudeArgs(invokerOpts);

    // cortex#701 — scope the child env when isolating: drop principal-
    // personal CLAUDE_* vars that could re-introduce hooks/plugins/settings
    // (default-deny, allowlist in session-settings.ts). Cortex's own
    // pipeline vars (GROVE_*/CORTEX_*) are layered ON TOP below so they
    // always survive. When not isolating (principal-as-self), inherit the
    // full parent env unchanged (legacy behaviour).
    const baseEnv: Record<string, string> = isolate
      ? scopeSessionEnv(process.env)
      : { ...(process.env as Record<string, string>) };

    const env: Record<string, string> = {
      ...buildSessionEnv(baseEnv, this.opts),
      // cortex#710 — pass the per-skill grant list to the Skill Guard hook.
      // Only set when the curated settings actually registered the hook
      // (hasSkillGrants), so the env var and the hook move atomically. Layered
      // here (after scopeSessionEnv) alongside cortex's other pipeline vars; it
      // is not a CLAUDE_* var so scoping passes it through regardless.
      ...(hasSkillGrants && {
        [CORTEX_SKILL_GRANTS_ENV]: JSON.stringify(skillGrants),
      }),
    };

    // Pass bash allowlist config to bash-guard.hook.ts
    if (this.opts.bashGuardDisabled) {
      env.CORTEX_BASH_GUARD = JSON.stringify({ disabled: true });
    } else if (this.opts.bashAllowlist) {
      env.CORTEX_BASH_GUARD = JSON.stringify(this.opts.bashAllowlist);
    }

    // Suppress ANTHROPIC_API_KEY when OAuth token is present
    if (env.CLAUDE_CODE_OAUTH_TOKEN) {
      delete env.ANTHROPIC_API_KEY;
    }

    try {
      this.proc = Bun.spawn(["claude", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env,
        cwd: this.opts.cwd,
      });

      // Start inactivity-based timeout (resets on every stream event)
      this.resetInactivityTimer();

      // Wire stdout streaming (track promise so wireExit can await drain)
      this.stdoutDone = this.pipeStdout();

      // Wire stderr (for error detection)
      void this.pipeStderr();

      // Wire exit (waits for stdout drain before emitting "exit")
      void this.wireExit();
    } catch (error) {
      // Spawn failed before the process existed — clean up the curated
      // settings temp dir we just created (cortex#701).
      this.cleanupSettings();
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit("error", err);
      this.emit("exit", 1);
    }

    return this;
  }

  /**
   * cortex#701 — remove the per-session curated-settings temp dir. Called
   * on process exit (wireExit) and on spawn failure. Idempotent.
   */
  private cleanupSettings(): void {
    if (this.isolatedSettings) {
      this.isolatedSettings.cleanup();
      this.isolatedSettings = null;
    }
  }

  /** Kill the CC process with graceful escalation (SIGINT → 2s → SIGTERM). */
  kill(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (!this.proc) return;
    // Give CC a chance to clean up child sessions
    this.proc.kill("SIGINT");
    const proc = this.proc;
    setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch (err) {
        console.warn("cc-session: SIGTERM failed (process likely already exited):", err instanceof Error ? err.message : err);
      }
    }, 2_000);
  }

  /**
   * Await full completion — returns a CCSessionResult.
   * The sync-compatible path: `start() + wait()` produces the same
   * final blob as a request/response invocation, while the underlying
   * stream still emits incremental tool-use / text events for callers
   * that listen.
   */
  async wait(): Promise<CCSessionResult> {
    if (!this.proc) {
      this.start();
    }

    return new Promise<CCSessionResult>((resolve) => {
      // Must listen for "error" to prevent unhandled EventEmitter crash
      // (e.g. timeout fires emit("error") with no listener → process crash).
      //
      // The inactivity-timeout path settles HERE first (with exitCode: 1),
      // BEFORE wireExit() observes the eventual SIGTERM and emits "exit"
      // with exitCode: 143. Callers therefore cannot rely on exit code 143
      // alone to detect aborts — they must check `aborted` instead.
      this.on("error", (err: Error) => {
        void err; // referenced by name above for documentation; payload is on `this.timedOut`
        const durationMs = Math.round(performance.now() - this.startTime);
        resolve({
          success: false,
          response: this.result ?? "",
          sessionId: this.sessionId,
          exitCode: 1,
          durationMs,
          usage: this.usage,
          ...(this.timedOut && { aborted: true, abortReason: "timeout" as const }),
        });
      });

      this.on("exit", (code: number) => {
        const durationMs = Math.round(performance.now() - this.startTime);
        resolve({
          success: code === 0,
          response: this.result ?? "",
          sessionId: this.sessionId,
          exitCode: code,
          durationMs,
          usage: this.usage,
          // The exit path can also be reached on inactivity timeout —
          // wireExit() races with the error listener and may win when CC
          // exits in response to SIGINT before the error has been emitted.
          // Either way, `this.timedOut` is the source of truth.
          ...(this.timedOut && { aborted: true, abortReason: "timeout" as const }),
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Inactivity timeout — resets on every stream event from CC
  // ---------------------------------------------------------------------------

  private resetInactivityTimer(): void {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    const timeout = this.opts.timeoutMs ?? 120_000;
    this.timeoutId = setTimeout(() => {
      const mins = Math.round(timeout / 60_000);
      console.error(`cc-session: timed out after ${mins} minutes of inactivity`);
      this.timedOut = true;
      this.kill();
      this.emit("error", new Error(`Timed out after ${mins} minute${mins !== 1 ? "s" : ""} of inactivity`));
    }, timeout);
  }

  // ---------------------------------------------------------------------------
  // Internal stream wiring
  // ---------------------------------------------------------------------------

  private async pipeStdout(): Promise<void> {
    if (!this.proc?.stdout) return;

    const stdout = this.proc.stdout;
    if (typeof stdout === "number") return;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = this.lineBuffer.feed(chunk);

        for (const line of lines) {
          this.processLine(line);
        }
      }

      // Flush any remaining buffer
      const remaining = this.lineBuffer.flush();
      if (remaining) this.processLine(remaining);
    } catch (_err) {
      // Stream closed — expected on process exit
    }
  }

  private async pipeStderr(): Promise<void> {
    if (!this.proc?.stderr) return;
    const stderr = this.proc.stderr;
    if (typeof stderr === "number") return;

    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];

    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      console.warn("cc-session: stderr stream closed:", err instanceof Error ? err.message : String(err));
    }

    const stderrText = chunks.join("");
    if (stderrText.trim()) {
      // Only emit if there's meaningful stderr (not just progress indicators)
      const meaningful = stderrText.trim().split("\n").filter(
        (l: string) => !l.startsWith("⠋") && !l.startsWith("⠙") && l.trim()
      ).join("\n");
      if (meaningful) {
        this.emit("stderr", meaningful);
      }
    }
  }

  private timedOut = false;

  private async wireExit(): Promise<void> {
    if (!this.proc) return;

    const exitCode = await this.proc.exited;

    // Wait for stdout to fully drain before firing exit — prevents race
    // where clearProgress runs before late tool-use events are processed.
    await this.stdoutDone;

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    // cortex#701 — drop the curated-settings temp dir now the process has
    // exited (the file is only needed for the lifetime of the CC process).
    this.cleanupSettings();

    // Don't emit a second "error" if timeout already handled it (exit 143 = SIGTERM from kill)
    if (exitCode !== 0 && !this.result && !this.timedOut) {
      this.emit("error", new Error(`Claude exited with code ${exitCode}`));
    }

    this.emit("exit", exitCode);
  }

  private processLine(line: string): void {
    const event = parseStreamLine(line);
    if (!event) return;

    // Any parsed event = CC is alive. Reset inactivity timer.
    this.resetInactivityTimer();

    switch (event.type) {
      case "init":
        if (event.sessionId) {
          this.sessionId = event.sessionId;
          this.emit("session-id", event.sessionId);
        }
        break;

      case "text":
        if (event.text) {
          this.emit("text", event.text);
        }
        break;

      case "tool_use":
        if (event.toolName) {
          this.emit("tool-use", event.toolName, event.toolInput ?? {});
        }
        break;

      case "result":
        this.result = event.text ?? "";
        if (event.sessionId) {
          this.sessionId = event.sessionId;
        }
        if (event.usage) {
          this.usage = event.usage;
          this.emit("usage", event.usage);
        }
        this.emit("result", this.result);
        break;
    }
  }
}
