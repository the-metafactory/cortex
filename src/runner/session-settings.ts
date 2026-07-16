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
 * By spawning bot sessions with an EMPTY `--setting-sources ""` we load NO
 * ambient source at all — not `user` (the principal's global settings), and
 * not `project`/`local` (the cwd repo's `.claude/`). Nothing from the
 * principal's global settings (hooks, skills, plugins, permissions) — and
 * nothing from the working-repo cwd — is loaded. We then layer cortex's OWN
 * curated settings on top via `--settings <path>`, containing only cortex's
 * hooks (EventLogger, bash-guard, context) plus, when the session is granted
 * skills, the Skill Guard PreToolUse hook (cortex#710). See the "Why drop
 * `project` and `local`, not just `user`?" self-check below for why the
 * tighter empty-source default (rather than `project,local`) is the only
 * sound posture.
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
 * A narrower `--setting-sources project,local` would exclude the principal's
 * GLOBAL `~/.claude/settings.json` (`user`) — but `--settings` is ADDITIVE,
 * not a replacement, so `project` (`<cwd>/.claude/settings.json`) and `local`
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

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  chmodSync,
  lstatSync,
  readdirSync,
  existsSync,
  readFileSync,
  rmSync,
} from "fs";
import { tmpdir, homedir } from "os";
import { join, basename } from "path";
import { parse as parseYaml } from "yaml";

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
  // NOTE: a substrate's config-home var (claude-code → CLAUDE_CONFIG_DIR) is
  // deliberately NOT allowlisted here. Isolation stays strict default-deny; the
  // config-home is set EXPLICITLY on the child env AFTER scoping, driven by the
  // deployment `substrates:` block. See common/substrates/config-home.ts and
  // cc-session.ts (configHomeEnv). This keeps "which config home" an intentional
  // named export, not an inherited principal-personal passthrough.
]);

/**
 * Env var carrying the per-session **skill grant list** to the Skill Guard
 * PreToolUse hook (cortex#710). Value is a JSON array of allowed skill-name
 * strings (e.g. `["code-review"]`). The hook (`skill-guard.hook.ts`) reads
 * this and DENIES any `Skill` invocation whose name is not in the list.
 *
 * Set on the child env by `cc-session.ts`, layered AFTER `scopeSessionEnv`
 * (it is not a `CLAUDE_*` var, so scoping passes it through regardless; the
 * explicit layering keeps it alongside cortex's other pipeline vars). Mirrors
 * how `CORTEX_BASH_GUARD` carries the bash-guard config to that hook.
 */
export const CORTEX_SKILL_GRANTS_ENV = "CORTEX_SKILL_GRANTS";

/**
 * Env var carrying the per-session **MCP grant list** to the MCP Guard
 * PreToolUse hook (cortex#2111). Value is a JSON array of lowercase grant
 * patterns (`"*"` | `"<server>"` | `"<server>.<tool>"` — see
 * `deriveMcpGrants` in `src/common/policy/resolve-access.ts`). The hook
 * (`mcp-guard.hook.ts`, matcher `mcp__.*`) DENIES any `mcp__*` invocation
 * not covered by a pattern; absent/malformed env → deny-all (fail-closed).
 *
 * Set on the child env by `cc-session.ts`, layered AFTER `scopeSessionEnv`
 * — exactly the {@link CORTEX_SKILL_GRANTS_ENV} pattern.
 */
export const CORTEX_MCP_GRANTS_ENV = "CORTEX_MCP_GRANTS";

/**
 * Name of the Claude Code plugin cortex materialises to carry a session's
 * granted skills (cortex#990 A1). Fixed string — the plugin is per-session
 * and single-purpose, so its name never varies. The `/`-prefixed skill
 * invocation the model sees is namespaced under it (`/cortex-granted:<skill>`).
 */
export const CORTEX_GRANTED_PLUGIN_NAME = "cortex-granted";

/**
 * Default source dir for granted skills: `~/.claude/skills`. Used when the
 * deployment declared no `configHome` for the claude-code substrate (#2132).
 * The caller (cc-session.ts) overrides this with `<configHome>/skills` when a
 * config home IS declared, so grants resolve against the SAME home the child
 * session authenticates and loads config from.
 */
export const DEFAULT_SKILL_SOURCE_DIR = join(homedir(), ".claude", "skills");

/**
 * Cortex's version string for the materialised plugin's `plugin.json`, read
 * from the repo-root `arc-manifest.yaml` (the same source `getVersion` in
 * cortex.ts uses) with a `"0.0.0"` fallback. Cosmetic for `claude plugin
 * validate` — any non-empty string validates — but we carry the real version
 * so a materialised plugin is self-describing. Computed lazily and cached so
 * module load stays free of filesystem work.
 */
let cachedCortexVersion: string | undefined;
function cortexPluginVersion(): string {
  if (cachedCortexVersion !== undefined) return cachedCortexVersion;
  try {
    const manifestPath = join(import.meta.dir, "..", "..", "arc-manifest.yaml");
    const manifest = parseYaml(readFileSync(manifestPath, "utf-8")) as { version?: string };
    cachedCortexVersion = manifest.version ?? "0.0.0";
  } catch {
    cachedCortexVersion = "0.0.0";
  }
  return cachedCortexVersion;
}

/**
 * Materialise the granted skills as a Claude Code **plugin** inside `dir`
 * (cortex#990 A1). Layout, matching the validated spike:
 *
 *   plugin/
 *   ├── .claude-plugin/plugin.json   ← {name, version, description}
 *   └── skills/<grant>/              ← a read-only COPY per granted skill
 *
 * Each grant is COPIED (not symlinked) from `<skillSourceDir>/<grant>`. The
 * copy is the fix for the review's MAJOR 1: a symlinked source dir let a
 * Bash-holding session write THROUGH the link and poison the shared skill
 * source; copying severs that link. All grants land in ONE `skills/` dir, so a
 * skill's sibling-relative reference (e.g. `../gws-shared/SKILL.md`) still
 * resolves. Files are set 0444 / dirs 0555 as defence-in-depth (a same-uid
 * session can chmod its own throwaway copy back — accepted residual; the
 * shared source is already out of reach because the link is gone).
 *
 * Grant names are validated BEFORE any path use (review MAJOR 2): anything
 * that isn't a bare basename (`../secrets`, `..`, `.`, empty) is logged and
 * skipped — a crafted grant can neither escape `skills/` nor abort session
 * construction. Each copy is wrapped in try/catch for the same reason: any
 * failure (e.g. a pre-existing name) is logged and skipped, never thrown.
 *
 * Returns the plugin dir only when ≥1 skill actually materialised; when every
 * grant was invalid/missing/failed it removes the empty plugin dir and returns
 * `undefined` (review MINOR — no `--plugin-dir` for a zero-skill plugin). The
 * caller appends `--plugin-dir <pluginDir>` to the session args; `cleanup()`
 * removes the whole temp tree (the copies, never the sources).
 */
function materialiseGrantedPlugin(
  dir: string,
  skillGrants: readonly string[],
  skillSourceDir: string,
): string | undefined {
  if (skillGrants.length === 0) return undefined;

  const pluginDir = join(dir, "plugin");
  const skillsDir = join(pluginDir, "skills");
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: CORTEX_GRANTED_PLUGIN_NAME,
        version: cortexPluginVersion(),
        description: "cortex per-session granted skills",
      },
      null,
      2,
    ),
  );

  let materialised = 0;
  for (const grant of skillGrants) {
    // Reject unsafe grant names BEFORE building any path (review MAJOR 2). A
    // bare character class like /^[\w.-]+$/ is NOT enough — `..` matches it —
    // so require the name to equal its own basename AND exclude the dot names
    // and the empty string explicitly.
    if (
      grant.length === 0 ||
      grant === "." ||
      grant === ".." ||
      basename(grant) !== grant
    ) {
      process.stderr.write(`cortex: skill grant '${grant}' invalid — skipped\n`);
      continue;
    }

    const target = join(skillSourceDir, grant);
    if (!existsSync(target)) {
      process.stderr.write(
        `cortex: skill grant '${grant}' not found under ${skillSourceDir} — skipped\n`,
      );
      continue;
    }

    try {
      const dest = join(skillsDir, grant);
      // Recursive COPY (not symlink) severs the write path back to the shared
      // source. `dereference: true` is LOAD-BEARING, not cosmetic: an installed
      // skill dir is itself typically a symlink (e.g. ~/.claude/skills/gws-drive
      // → ~/.soma/skills/gws-drive), and a non-dereferencing copy would just
      // recreate that symlink — leaving the write-through-to-source hole open.
      // Dereferencing materialises real files, fully severing the link. Then
      // lock it down read-only as defence-in-depth.
      //
      // Trust note: dereference also copies a skill's OWN inner symlink targets
      // into the plugin — transitive trust of the granted skill's content. Safe
      // at same-uid (the session could already read those targets directly);
      // REVISIT if cortex ever runs sessions at lower fs privilege than the
      // daemon, where a skill's symlink could pull in bytes the session may not
      // otherwise read.
      cpSync(target, dest, { recursive: true, dereference: true });
      chmodTreeReadOnly(dest);
      materialised++;
    } catch (err) {
      // Never let a crafted/racy grant abort session construction.
      process.stderr.write(
        `cortex: skill grant '${grant}' — materialise failed, skipped: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  if (materialised === 0) {
    // Every grant was invalid/missing/failed — don't advertise an empty plugin.
    rmSync(pluginDir, { recursive: true, force: true });
    return undefined;
  }
  return pluginDir;
}

/**
 * Recursively set a materialised skill tree read-only: files 0444, dirs 0555.
 * Defence-in-depth over the copy (cortex#990 A1, review MAJOR 1). Symlinks
 * inside a skill are left untouched (chmod would follow to a target outside the
 * copy); they are removed with the tree at cleanup regardless. 0555 keeps dirs
 * traversable/readable, so this and a later read both still work.
 */
function chmodTreeReadOnly(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) chmodTreeReadOnly(join(path, entry));
    chmodSync(path, 0o555);
  } else {
    chmodSync(path, 0o444);
  }
}

/**
 * Restore writable permissions across a tree so `rmSync` can remove it. The
 * read-only skill copies (0444 files under 0555 dirs) block removal — a
 * read-only DIRECTORY can't have its entries unlinked. Chmod each dir writable
 * BEFORE descending (0700 keeps it traversable), same-uid so always permitted.
 * Best-effort per node; the caller still force-removes afterwards.
 */
function restoreWritableTree(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    try {
      chmodSync(path, 0o700);
    } catch {
      /* best-effort */
    }
    for (const entry of readdirSync(path)) restoreWritableTree(join(path, entry));
  }
}

/**
 * Build the curated settings object cortex spawns bot sessions under.
 *
 * Contains ONLY cortex's own hooks (resolved to the installed symlink
 * paths under `${claudeDir}/hooks/`). It never re-adds the principal's
 * skills/hooks because it is the ONLY settings file loaded — the spawn
 * passes an EMPTY `--setting-sources` so no ambient source (`user`,
 * `project`, `local`) loads alongside it.
 *
 * ## Skill gating (cortex#710, Part B)
 *
 * When `skillGrants` is a NON-EMPTY array, the session is meant to have
 * those skills. We register the **Skill Guard** PreToolUse hook (matcher
 * `Skill`) here; the caller broadly ALLOWS the bare `Skill` tool (so the
 * permission rule is permissive) and the hook is the real gate — it denies
 * any skill name ∉ the grant list (see `skill-guard.hook.ts`). The grant
 * list itself reaches the hook via the {@link CORTEX_SKILL_GRANTS_ENV} env
 * var on the child, NOT via this file.
 *
 * When `skillGrants` is `undefined`/empty, NO Skill hook is registered:
 * the caller keeps the default-deny `disallowedTools: ["Skill"]` rule
 * instead (no Skill tool at all). This is the #706 lesson made atomic — a
 * session is either {broad `Skill` allow + this gate hook} or {no `Skill`
 * tool}, never the broken {`Skill(name)` allow + bare `Skill` deny}.
 *
 * ## MCP gating (cortex#2111)
 *
 * When `mcpGrants` is DEFINED (including `[]`), the session came from a
 * policy-resolved decision and the `mcp__*` namespace is deny-by-default:
 * we register the **MCP Guard** PreToolUse hook (matcher `mcp__.*`), which
 * denies any MCP invocation not covered by the grant list. The list reaches
 * the hook via the {@link CORTEX_MCP_GRANTS_ENV} env var on the child (set
 * by cc-session.ts, atomically with this registration). Note the asymmetry
 * with skills: an EMPTY skill-grant list skips the hook (the `Skill` deny
 * rule covers it), but an empty MCP grant list still REGISTERS the hook —
 * there is no inventory-based deny rule that can reach `mcp__*` names
 * (that's the whole #2111 gap), so the hook IS the deny.
 *
 * When `mcpGrants` is `undefined` (a path that never went through
 * `resolvePolicyAccess` — review pipeline, dev consumer), no MCP hook is
 * registered and existing behaviour is unchanged.
 *
 * @param claudeDir Absolute path to the cortex-owned `.claude` dir holding
 *   the installed hook symlinks. Defaults to `${HOME}/.claude`.
 * @param skillGrants Per-session skill grant list. Non-empty → register the
 *   Skill Guard hook. Undefined/empty → no Skill hook (default-deny lives
 *   in the caller's `disallowedTools`).
 * @param mcpGrants Per-session MCP grant list (cortex#2111). Defined →
 *   register the MCP Guard hook (deny-by-default over `mcp__*`).
 */
export function buildCuratedSettings(
  claudeDir: string,
  skillGrants?: readonly string[],
  mcpGrants?: readonly string[],
): Record<string, unknown> {
  const hook = (name: string) => ({
    type: "command",
    command: `${claudeDir}/hooks/${name}`,
  });

  // PreToolUse always carries the Bash guard. When the session is granted
  // skills, ALSO register the Skill guard (matcher `Skill`) — the per-skill
  // gate that backs the broad `Skill` allow the caller layers in.
  const preToolUse: { matcher: string; hooks: ReturnType<typeof hook>[] }[] = [
    { matcher: "Bash", hooks: [hook("CortexBashGuard.hook.ts")] },
  ];
  if (skillGrants !== undefined && skillGrants.length > 0) {
    preToolUse.push({ matcher: "Skill", hooks: [hook("CortexSkillGuard.hook.ts")] });
  }
  // cortex#2111 — defined mcpGrants (even []) arms the namespace gate. The
  // matcher is a regex: every tool name starting `mcp__` routes through the
  // guard.
  if (mcpGrants !== undefined) {
    preToolUse.push({ matcher: "mcp__.*", hooks: [hook("CortexMcpGuard.hook.ts")] });
  }

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
      PreToolUse: preToolUse,
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
   * source list ⇒ load no ambient source; only the curated file). When the
   * session is granted skills, ALSO carries `--plugin-dir <pluginDir>` (the
   * materialised granted-skills plugin, cortex#990 A1). Order matters only in
   * that all must precede `-p <prompt>` (handled by buildClaudeArgs putting
   * the prompt last).
   */
  args: string[];
  /**
   * Absolute path to the materialised granted-skills plugin dir, or
   * `undefined` when the session was granted no skills (or every grant was
   * invalid/missing/failed). Exposed so callers/tests can locate it (e.g. to
   * run `claude plugin validate`); it lives INSIDE the temp dir, so `cleanup()`
   * removes it.
   */
  pluginDir?: string;
  /** Remove the temp dir. Safe to call multiple times. */
  cleanup: () => void;
}

/**
 * Write the curated settings file to a fresh per-session temp dir and
 * return the args + cleanup. The caller spawns `claude` with
 * `[...buildClaudeArgs(opts), ...isolated.args]` (or threads `args` into
 * additionalArgs) and invokes `cleanup()` on session exit.
 *
 * @param claudeDir Absolute path to the cortex-owned `.claude` dir holding
 *   the installed hook symlinks.
 * @param skillGrants Per-session skill grant list (cortex#710). Non-empty →
 *   the curated file registers the Skill Guard PreToolUse hook; the caller
 *   must ALSO broadly allow the `Skill` tool and set the
 *   {@link CORTEX_SKILL_GRANTS_ENV} env var. Undefined/empty → no Skill hook.
 * @param mcpGrants Per-session MCP grant list (cortex#2111). Defined (even
 *   `[]`) → the curated file registers the MCP Guard PreToolUse hook and the
 *   caller must set the {@link CORTEX_MCP_GRANTS_ENV} env var. Undefined →
 *   no MCP hook (non-policy path, behaviour unchanged).
 * @param skillSourceDir Dir the granted skills are symlinked FROM (cortex#990
 *   A1). Defaults to {@link DEFAULT_SKILL_SOURCE_DIR} (`~/.claude/skills`); the
 *   caller passes `<configHome>/skills` when the deployment relocated the
 *   claude-code config home (#2132). Only consulted when `skillGrants` is
 *   non-empty.
 */
export function createIsolatedSettings(
  claudeDir: string,
  skillGrants?: readonly string[],
  mcpGrants?: readonly string[],
  skillSourceDir: string = DEFAULT_SKILL_SOURCE_DIR,
): IsolatedSettings {
  const dir = mkdtempSync(join(tmpdir(), "cortex-session-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify(buildCuratedSettings(claudeDir, skillGrants, mcpGrants), null, 2),
    {
      mode: 0o600,
    },
  );

  const args = [
    "--setting-sources",
    CORTEX_SETTING_SOURCES.join(","),
    "--settings",
    settingsPath,
  ];

  // cortex#990 A1 — when the session is granted skills, materialise them as a
  // --plugin-dir plugin ALONGSIDE the curated settings (the isolation posture,
  // empty --setting-sources included, is untouched). Empty/undefined grants →
  // no plugin, no extra arg → byte-identical to the pre-#990 behaviour.
  const pluginDir =
    skillGrants !== undefined && skillGrants.length > 0
      ? materialiseGrantedPlugin(dir, skillGrants, skillSourceDir)
      : undefined;
  if (pluginDir !== undefined) {
    args.push("--plugin-dir", pluginDir);
  }

  return {
    settingsPath,
    args,
    pluginDir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // The granted-skills copies are materialised read-only (0444 files
        // under 0555 dirs), and a read-only DIRECTORY blocks removal of its
        // entries. Restore writable perms (same-uid, always permitted) and
        // retry once before giving up.
        try {
          restoreWritableTree(dir);
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          // Best-effort cleanup of an OS temp dir. A leftover dir is inert
          // (no secrets — only hook paths + read-only skill copies) and the OS
          // reclaims tmp eventually; log rather than throw so session teardown
          // can't fail on a transient fs error.
          process.stderr.write(
            `session-settings: temp cleanup failed for ${dir}: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        }
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
