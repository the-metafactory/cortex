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
 * ### Why `--setting-sources ` (empty) and not `--bare`?
 *
 * `--bare` skips hooks ENTIRELY (and LSP, plugin sync, auto-memory, etc.).
 * That would also disable cortex's own EventLogger + bash-guard hooks,
 * which we MUST preserve — the event pipeline and the bash safety guard
 * are load-bearing. Passing an EMPTY `--setting-sources` is surgical: it
 * loads NO ambient setting source (not `user`, not `project`, not `local`)
 * while letting our `--settings` file re-introduce exactly cortex's own
 * hooks.
 *
 * ### Why drop `project` and `local`, not just `user`? (cortex#701 self-check)
 *
 * `--setting-sources project,local` excludes the principal's GLOBAL
 * `~/.claude/settings.json` (`user`) — but `--settings` is ADDITIVE, not a
 * replacement, so `project` (`<cwd>/.claude/settings.json`) and `local`
 * (`<cwd>/.claude/settings.local.json`) STILL load alongside the curated
 * file. Empirically verified (CLI 2.1.158): a project/local hook in the
 * session cwd fires INSIDE the bot session even with `--settings` present.
 *
 * That re-opens the very boundary this module closes, two ways:
 *   1. The session cwd is a WORKING REPO (first `allowedDir`). Its
 *      checked-in `.claude/settings.json` is repo content — a malicious
 *      PR/branch the bot checks out can register an arbitrary hook command
 *      that then runs in the bot session (supply-chain hook injection).
 *   2. `<cwd>/.claude/settings.local.json` is principal-personal,
 *      gitignored config — exactly the principal context a hard-isolated
 *      stack must NOT inherit.
 *
 * cortex does NOT control the CONTENTS of `.claude/` inside a working repo,
 * only which cwd it hands the session. So the only sound posture is to load
 * NONE of the ambient sources and rely solely on the curated `--settings`
 * file. We pass an EMPTY source list to do that. The issue itself lists
 * "drop project too" as the tighter, correct default.
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
 * The setting sources cortex bot sessions load: NONE. Deliberately empty.
 *
 * `user` is the principal's global `~/.claude/settings.json` (global
 * hooks/skills/plugins) — the single largest leak vector. But `project`
 * (`<cwd>/.claude/settings.json`) and `local`
 * (`<cwd>/.claude/settings.local.json`) are NOT safe to load either:
 * `--settings` is additive, so any hook/permission in the session cwd's
 * `.claude/` would fire alongside the curated file (verified, CLI 2.1.158).
 * The cwd is a working repo whose `.claude/` is repo content (project,
 * mutable by any branch/PR) and principal-personal config (local), neither
 * of which cortex controls the contents of. So we load ZERO ambient
 * sources and rely solely on the curated `--settings` file.
 *
 * Materialised on the CLI as `--setting-sources ` with an empty value,
 * which Claude Code accepts as "load no setting source" (the curated
 * `--settings` file still loads). Exported so the test suite can assert
 * the exact (empty) value and so a future config-split (#5) could, in
 * principle, RE-ADD a source from the system layer for a stack that
 * explicitly opts into repo-scoped config — never the silent default.
 */
export const CORTEX_SETTING_SOURCES = [] as const;

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
   * CLI args to append: `--setting-sources "" --settings <path>` (empty
   * source list ⇒ load no ambient source; only the curated file). Order
   * matters only in that both must precede `-p <prompt>` (handled by
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
