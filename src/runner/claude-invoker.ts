/**
 * T-3.3: Claude Invoker
 * Spawns claude --print with channel context. Supports --resume for threaded sessions.
 */

export interface ClaudeInvocationOpts {
  prompt: string;
  groveChannel?: string;
  /** G-501: Network identifier for event routing */
  groveNetwork?: string;
  timeoutMs?: number;
  additionalArgs?: string[];
  /** If set, resume an existing CC session (for threaded conversations) */
  resumeSessionId?: string;
  /** Tools to allow (passed as --allowedTools) */
  allowedTools?: string[];
  /** Tools to deny (passed as --disallowedTools) */
  disallowedTools?: string[];
  /** Directories the agent can access (passed as --add-dir) */
  allowedDirs?: string[];
}

export interface ClaudeResult {
  success: boolean;
  response: string;
  exitCode: number;
  durationMs: number;
  /** Session ID from CC (for storing in session manager) */
  sessionId?: string;
}

/**
 * Build the claude CLI args. Exported for testing.
 */
export function buildClaudeArgs(opts: ClaudeInvocationOpts): string[] {
  const args: string[] = ["--print"];

  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }

  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }

  if (opts.disallowedTools && opts.disallowedTools.length > 0) {
    args.push("--disallowedTools", opts.disallowedTools.join(","));
  }

  if (opts.allowedDirs && opts.allowedDirs.length > 0) {
    for (const dir of opts.allowedDirs) {
      args.push("--add-dir", dir);
    }
  }

  if (opts.additionalArgs) {
    args.push(...opts.additionalArgs);
  }

  // Use -p flag instead of positional arg — positional gets consumed by variadic flags like --add-dir
  args.push("-p", opts.prompt);

  return args;
}

export async function invokeClaudeCode(opts: ClaudeInvocationOpts): Promise<ClaudeResult> {
  const start = performance.now();
  const timeout = opts.timeoutMs ?? 120_000;

  const args = buildClaudeArgs(opts);

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    GROVE_CHANNEL: opts.groveChannel ?? "",
  };

  // G-501: Pass network identifier if provided
  if (opts.groveNetwork) {
    env.GROVE_NETWORK = opts.groveNetwork;
  }

  // Suppress ANTHROPIC_API_KEY when OAuth token is present
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    delete env.ANTHROPIC_API_KEY;
  }

  try {
    const proc = Bun.spawn(["claude", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    // Timeout handling
    const timeoutId = setTimeout(() => {
      proc.kill("SIGTERM");
    }, timeout);

    const exitCode = await proc.exited;
    clearTimeout(timeoutId);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const durationMs = Math.round(performance.now() - start);

    if (exitCode !== 0) {
      console.error(`grove-bot: claude exited ${exitCode}: ${stderr.trim().slice(0, 500)}`);
    }

    // Try to extract session ID from stderr (CC prints it there)
    const sessionMatch = stderr.match(/session:\s*([a-f0-9-]+)/i)
      ?? stderr.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);

    return {
      success: exitCode === 0,
      response: stdout.trim(),
      exitCode,
      durationMs,
      sessionId: sessionMatch?.[1],
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    return {
      success: false,
      response: error instanceof Error ? error.message : String(error),
      exitCode: 1,
      durationMs,
    };
  }
}
