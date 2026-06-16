/**
 * Claude CLI argument builder.
 *
 * Originally this module also exported `invokeClaudeCode()` — a synchronous
 * spawn helper that produced a final result blob. That entry point was
 * superseded by `cc-session.ts`'s streaming `CCSession`, which emits
 * incremental events (tool-use, text, result) and supports the same
 * one-shot use case via `start().wait()`. MIG-4.8 retires the legacy
 * `invokeClaudeCode` per `docs/v1-to-v2-cutover.md` §7. The shared
 * `buildClaudeArgs` helper stays because `cc-session.ts` uses it to
 * construct the CLI argv — moving the function elsewhere would just
 * shuffle imports.
 *
 * What this module exports today:
 *   - `ClaudeInvocationOpts` — the option bag shape consumed by
 *     `buildClaudeArgs`. Kept symmetric with the historical opts so a
 *     future `JsonInvoker` (e.g. for SSE streaming) can reuse the type.
 *   - `buildClaudeArgs(opts)` — pure function: opts → string[] of CLI args
 *     to spawn `claude` with. No side effects. Tested directly by
 *     `claude-invoker-resume.test.ts`.
 */

export interface ClaudeInvocationOpts {
  prompt: string;
  channel?: string;
  /** G-501: Network identifier for event routing */
  network?: string;
  timeoutMs?: number;
  additionalArgs?: string[];
  /** If set, resume an existing CC session (for threaded conversations) */
  resumeSessionId?: string;
  /**
   * ST-P1 (cortex#964, refs #952) — the parent session id for this spawn.
   * Carried to the child via the `CORTEX_PARENT_SESSION_ID` env var (stamped in
   * `cc-session.ts` `buildSessionEnv`), NOT as a CLI arg — `buildClaudeArgs`
   * never emits a flag for it. Present on the opts for symmetry with
   * `CCSessionOpts` and so non-CCSession invokers can thread it through env.
   */
  parentSessionId?: string;
  /** Tools to allow (passed as --allowedTools) */
  allowedTools?: string[];
  /** Tools to deny (passed as --disallowedTools) */
  disallowedTools?: string[];
  /** Directories the agent can access (passed as --add-dir) */
  allowedDirs?: string[];
}

/**
 * Build the claude CLI args. Pure function — no spawn, no side effects.
 *
 * Used by `cc-session.ts` to construct the argv for the streaming spawn;
 * also used by tests to lock in flag-ordering invariants without going
 * through a process spawn.
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
