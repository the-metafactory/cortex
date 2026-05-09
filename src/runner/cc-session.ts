/**
 * Streaming Claude Code session wrapper.
 * Spawns CC with --output-format stream-json and emits typed events.
 * The single CC invocation primitive in cortex — the legacy synchronous
 * `invokeClaudeCode()` was retired in MIG-4.8.
 */

import { EventEmitter } from "events";
import { parseStreamLine, StreamLineBuffer, type UsageStats, type StreamEvent } from "./stream-parser";
import { buildClaudeArgs, type ClaudeInvocationOpts } from "./claude-invoker";

// Re-export for convenience
export type { UsageStats, StreamEvent };

export interface CCSessionOpts {
  prompt: string;
  groveChannel?: string;
  /** G-501: Network identifier for event routing */
  groveNetwork?: string;
  agentName?: string;
  agentId?: string;
  resumeSessionId?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  allowedDirs?: string[];
  timeoutMs?: number;
  cwd?: string;
  additionalArgs?: string[];
  /** Bash allowlist config — passed to bash-guard.hook.ts via GROVE_BASH_GUARD env var. */
  bashAllowlist?: { rules: Array<{ pattern: string; repos?: string[] }>; repos: string[] };
  /** G-300: When true, disables bash guard entirely (operator DM). */
  bashGuardDisabled?: boolean;
  /** H-001: Explicit project context (e.g., "grove", "meta-factory") */
  project?: string;
  /** H-001: Entity context (e.g., "issue/43", "pr/45", "g-204") */
  entity?: string;
  /** H-001: Operator who triggered this session (Discord username or ID) */
  operator?: string;
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
   * left open-ended so future kill paths (operator cancel, runner
   * shutdown) can populate it without a breaking change.
   */
  abortReason?: "timeout";
}

export class CCSession extends EventEmitter {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private timeoutId: Timer | null = null;
  private lineBuffer = new StreamLineBuffer();
  private startTime = 0;
  private stdoutDone: Promise<void> = Promise.resolve();

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

    // Build args from existing buildClaudeArgs, then inject stream-json
    const invokerOpts: ClaudeInvocationOpts = {
      prompt: this.opts.prompt,
      groveChannel: this.opts.groveChannel,
      groveNetwork: this.opts.groveNetwork,
      resumeSessionId: this.opts.resumeSessionId,
      allowedTools: this.opts.allowedTools,
      disallowedTools: this.opts.disallowedTools,
      allowedDirs: this.opts.allowedDirs,
      additionalArgs: [
        "--verbose",
        "--output-format", "stream-json",
        ...(this.opts.additionalArgs ?? []),
      ],
    };

    const args = buildClaudeArgs(invokerOpts);

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(this.opts.groveChannel && { GROVE_CHANNEL: this.opts.groveChannel }),
      ...(this.opts.groveNetwork && { GROVE_NETWORK: this.opts.groveNetwork }),
      ...(this.opts.agentName && { GROVE_AGENT_NAME: this.opts.agentName }),
      ...(this.opts.agentId && { GROVE_AGENT_ID: this.opts.agentId }),
      ...(this.opts.project && { GROVE_PROJECT: this.opts.project }),
      ...(this.opts.entity && { GROVE_ENTITY: this.opts.entity }),
      ...(this.opts.operator && { GROVE_OPERATOR: this.opts.operator }),
    };

    // Pass bash allowlist config to bash-guard.hook.ts
    if (this.opts.bashGuardDisabled) {
      env.GROVE_BASH_GUARD = JSON.stringify({ disabled: true });
    } else if (this.opts.bashAllowlist) {
      env.GROVE_BASH_GUARD = JSON.stringify(this.opts.bashAllowlist);
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
      this.pipeStderr();

      // Wire exit (waits for stdout drain before emitting "exit")
      this.wireExit();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit("error", err);
      this.emit("exit", 1);
    }

    return this;
  }

  /** Kill the CC process with graceful escalation (SIGINT → 2s → SIGTERM). */
  kill(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (!this.proc) return;
    // Give CC a chance to clean up sub-agents
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
    } catch (err) {
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
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      console.warn("cc-session: stderr stream closed:", err instanceof Error ? err.message : err);
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
