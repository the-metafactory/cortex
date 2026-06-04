/**
 * Session settings isolation (cortex#701, Part A — TRUST-PATH/security).
 *
 * ## Problem this closes
 *
 * Bot CC sessions used to spawn a bare `claude`, which inherits the
 * principal's *full* personal environment: `...process.env` plus the
 * global `~/.claude/settings.json` ("user" settings source). That means
 * every hook the principal registered globally (memory injectors, personal
 * context, integrations) fired *inside* every grove/work/halden bot
 * session — injecting principal-personal context into stacks that are
 * supposed to be isolated. For a hard-isolated stack (own NATS, no
 * federation bridge) this silently crosses the very boundary the stack
 * exists to enforce.
 *
 * ## The mechanism
 *
 * `claude` exposes two relevant flags (verified against CLI 2.1.158):
 *
 *   --setting-sources <sources>   Comma-separated list of setting sources
 *                                 to load (user, project, local).
 *   --settings <file-or-json>     Path to a settings JSON file (additive).
 *
 * The principal's global `~/.claude/settings.json` is the **user** source.
 * By spawning bot sessions with `--setting-sources project,local` we
 * EXCLUDE the `user` source entirely — nothing from the principal's global
 * settings (hooks, skills, plugins, permissions) is loaded. We then layer
 * cortex's OWN curated settings on top via `--settings <path>`, containing
 * only cortex's hooks (EventLogger, bash-guard, context) plus the
 * explicitly-granted skills/tools for this session.
 *
 * ### Why `--setting-sources project,local` and not `--bare`?
 *
 * `--bare` skips hooks ENTIRELY (and LSP, plugin sync, auto-memory, etc.).
 * That would also disable cortex's own EventLogger + bash-guard hooks,
 * which we MUST preserve — the event pipeline and the bash safety guard
 * are load-bearing. `--setting-sources` is surgical: it drops only the
 * principal-personal `user` source while letting our `--settings` file
 * re-introduce exactly cortex's own hooks.
 *
 * ### Why generate a per-session temp file (not a checked-in file)?
 *
 * Two reasons:
 *   1. The hook commands resolve to installed symlinks under
 *      `~/.claude/hooks/Cortex*.hook.ts` (arc lays these down from
 *      `arc-manifest.yaml`'s `provides.hooks`). The absolute path depends
 *      on `$HOME` at runtime, so the file is host-specific — not something
 *      to check in.
 *   2. The per-skill/per-tool grants (Part B) are computed per session
 *      from the policy decision. A generated file lets us bake exactly the
 *      granted capabilities into the settings, so the curated scope is
 *      truly least-privilege and self-describing.
 *
 * The file is written to a unique per-session dir under the OS temp root
 * and cleaned up when the session exits.
 *
 * ### Env scoping
 *
 * We still need the child's env, but we must NOT re-introduce principal
 * hooks via env vars. We therefore strip env vars that Claude Code uses to
 * inject behaviour that could re-add principal context, while preserving:
 *   - PATH, HOME, and the shell essentials (so `claude` + tools resolve),
 *   - cortex's OWN pipeline vars (CORTEX_* / GROVE_* — EventLogger reads
 *     these), the bash-guard config var, and auth (OAuth token / API key).
 * See {@link scopeSessionEnv}.
 */

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * The setting sources cortex bot sessions load. Deliberately EXCLUDES
 * `user` — that's the principal's global `~/.claude/settings.json` and the
 * single largest leak vector (global hooks/skills/plugins). `project` +
 * `local` are repo-scoped and live inside the cwd cortex hands the
 * session; cortex controls the cwd, so those are in-policy.
 *
 * Exported so the test suite can assert the exact value and so a future
 * config-split (#5) can override it from the system layer if a stack ever
 * needs an even tighter scope (e.g. drop `project` too).
 */
export const CORTEX_SETTING_SOURCES = ["project", "local"] as const;

/**
 * Claude Code env vars that can re-introduce principal-personal behaviour
 * (hooks, plugins, extra setting files, alternate config dirs) into a
 * child session. Stripped from the curated env so isolation can't be
 * silently defeated through the environment after we've excluded the
 * `user` setting source on the command line.
 *
 * Adversarial note (cortex#701 self-check): excluding the `user` source
 * via `--setting-sources` is necessary but not sufficient — Claude Code
 * also honours env-based overrides. `CLAUDE_CODE_EXTRA_SETTINGS_SOURCES`
 * (or similar) and any var that points at an alternate hooks/plugins/
 * config location would re-open the boundary. We default to deny: any var
 * whose name starts with `CLAUDE_` is dropped UNLESS it is on the
 * {@link CORTEX_PRESERVED_CLAUDE_ENV} allowlist below. New Claude env vars
 * a future CLI introduces are therefore excluded by default, not
 * accidentally inherited.
 */
export const CORTEX_PRESERVED_CLAUDE_ENV = new Set<string>([
  // Auth — required for the session to talk to the API at all.
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  // Entitlement / model selection that cortex itself may set.
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
]);

/**
 * Build the curated settings object cortex spawns bot sessions under.
 *
 * Contains ONLY cortex's own hooks (resolved to the installed symlink
 * paths under `${claudeDir}/hooks/`) plus an optional permissions block
 * carrying the explicitly-granted tools. Skills are gated separately via
 * the `Skill` tool allow/deny on the CLI (see dispatch-handler Part B);
 * this object never re-adds the principal's skills because it is the ONLY
 * settings file loaded besides the repo-scoped project/local sources.
 *
 * @param claudeDir Absolute path to the cortex-owned `.claude` dir holding
 *   the installed hook symlinks. Defaults to `${HOME}/.claude`.
 */
export function buildCuratedSettings(claudeDir: string): Record<string, unknown> {
  const hook = (name: string) => ({
    type: "command",
    command: `${claudeDir}/hooks/${name}`,
  });

  // Mirrors src/settings/cortex-hooks.json (the reference fallback) but
  // pinned to ABSOLUTE installed paths so it stands alone without relying
  // on the principal's settings.json having registered anything. These are
  // cortex's hooks and ONLY cortex's hooks.
  return {
    hooks: {
      SessionStart: [{ hooks: [hook("CortexContext.hook.ts")] }],
      PostToolUse: [{ hooks: [hook("CortexEventLogger.hook.ts")] }],
      Stop: [{ hooks: [hook("CortexEventLogger.hook.ts")] }],
      UserPromptSubmit: [{ hooks: [hook("CortexEventLogger.hook.ts")] }],
      PreToolUse: [
        { matcher: "Bash", hooks: [hook("CortexBashGuard.hook.ts")] },
      ],
    },
  };
}

/**
 * A materialised curated-settings file plus the CLI args that load it
 * under the isolated source scope, and a `cleanup()` to remove the temp
 * dir when the session ends.
 */
export interface IsolatedSettings {
  /** Path to the generated curated settings JSON. */
  settingsPath: string;
  /**
   * CLI args to append: `--setting-sources project,local --settings <path>`.
   * Order matters only in that both must precede `-p <prompt>` (handled by
   * buildClaudeArgs putting the prompt last).
   */
  args: string[];
  /** Remove the temp dir. Safe to call multiple times. */
  cleanup: () => void;
}

/**
 * Write the curated settings file to a fresh per-session temp dir and
 * return the args + cleanup. The caller spawns `claude` with
 * `[...buildClaudeArgs(opts), ...isolated.args]` (or threads `args` into
 * additionalArgs) and invokes `cleanup()` on session exit.
 */
export function createIsolatedSettings(claudeDir: string): IsolatedSettings {
  const dir = mkdtempSync(join(tmpdir(), "cortex-session-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(buildCuratedSettings(claudeDir), null, 2), {
    mode: 0o600,
  });

  return {
    settingsPath,
    args: [
      "--setting-sources",
      CORTEX_SETTING_SOURCES.join(","),
      "--settings",
      settingsPath,
    ],
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        // Best-effort cleanup of an OS temp dir. A leftover dir is inert
        // (mode 0600, no secrets — only hook paths) and the OS reclaims
        // tmp eventually; log rather than throw so session teardown can't
        // fail on a transient fs error.
        process.stderr.write(
          `session-settings: temp cleanup failed for ${dir}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    },
  };
}

/**
 * Produce the curated child env from the parent env: preserve PATH/HOME/
 * shell essentials, cortex's own pipeline + auth vars, and any non-Claude
 * vars; DROP principal-personal Claude vars that could re-introduce
 * hooks/plugins/settings (default-deny on `CLAUDE_*`, allowlist via
 * {@link CORTEX_PRESERVED_CLAUDE_ENV}).
 *
 * Cortex's own pipeline vars (CORTEX_*, GROVE_*, the bash-guard config)
 * are layered on by the caller AFTER this scoping, so they always win.
 */
export function scopeSessionEnv(
  parentEnv: Record<string, string | undefined>,
): Record<string, string> {
  const scoped: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (key.startsWith("CLAUDE_") && !CORTEX_PRESERVED_CLAUDE_ENV.has(key)) {
      // Drop principal-personal Claude config that could re-add hooks/
      // plugins/settings sources. Default-deny: unknown CLAUDE_* vars are
      // excluded.
      continue;
    }
    scoped[key] = value;
  }
  return scoped;
}
