/**
 * Shared realpath + subpath-containment discipline (EBH-1, cortex#2343).
 *
 * Extracted so `path-guard.hook.ts` (file-tool PreToolUse guard) and
 * `bash-guard.hook.ts` (Bash read-command path checks) reuse EXACTLY the
 * same symlink-resolution + containment logic `src/adapters/loader.ts`
 * already applies to bundle install paths and manifest `entry` resolution
 * (`resolveEntryWithinBundle` ~:709-730, the containment check at ~:246,
 * :284-293) — "reuse, do not hand-roll" (issue #2343 step 2). `loader.ts`
 * itself is left untouched: it is already hardened + tested, and this slice
 * has no reason to touch it. This module is the generic primitive both the
 * loader's discipline and this new guard now conceptually share.
 *
 * Every function here is written to FAIL CLOSED: any resolution error
 * (ENOENT on every ancestor, a symlink loop, a permissions error) is
 * reported as `ok: false`, never silently treated as "contained".
 */

import { realpathSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, sep } from "path";

/**
 * Expand a single leading `~` to the invoking user's home directory. Mirrors
 * the `d.replace(/^~/, process.env.HOME ?? "~")` idiom already used at
 * `dispatch-handler.ts` (effectiveCwd / workspaceFallbackDir) so `allowedDirs`
 * / `readOnlyDirs` entries authored with a `~` prefix resolve the same way
 * here as they do when cortex builds `--add-dir` / cwd from the same config.
 */
export function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? homedir();
  if (path.startsWith("~/")) {
    return (process.env.HOME ?? homedir()) + path.slice(1);
  }
  return path;
}

/**
 * Expand shell-style `~`/`~/` and `$VAR`/`${VAR}` references in a raw path
 * token to the values a real shell would substitute — BEFORE the token is
 * ever classified as absolute/relative or joined with a cwd.
 *
 * Without this, a token like `~/.ssh/id_rsa` or `$HOME/.ssh/id_rsa` is NOT
 * absolute (`path.isAbsolute` doesn't know shell syntax), so a naive
 * `resolve(cwd, token)` treats it as a LITERAL relative path
 * (`<cwd>/~/.ssh/id_rsa`) — which usually resolves harmlessly inside an
 * allowed dir — while the real shell/tool expands it to the ACTUAL home
 * directory, almost always OUTSIDE the sandbox. This is the "guard checks a
 * different path than the shell runs" bypass (cortex#2343 adversarial
 * review finding B1). Every raw path token extracted from a tool call or a
 * Bash command MUST be passed through this BEFORE `isAbsolute`/`resolve`.
 *
 * Rules (the subset of POSIX shell expansion that matters for a path
 * argument):
 *   - A single leading `~` or `~/` expands to `process.env.HOME`.
 *   - `$VAR` / `${VAR}` anywhere in the string expands to `process.env.VAR`
 *     — an UNSET var expands to the EMPTY STRING, exactly like a real shell
 *     (`echo $NOPE` prints nothing) — never left as a literal `$VAR`
 *     substring that could dodge containment by resolving to a path that
 *     doesn't match anything in particular.
 *
 * Deliberately NOT handled:
 *   - Command substitution `$(...)` / backticks, glob expansion, `~otheruser`
 *     forms, and full shell quote-removal/word-splitting semantics.
 *     `rejectsChaining()` in bash-guard.hook.ts already refuses any command
 *     containing `$(`/backticks BEFORE any path check runs, so a token
 *     carrying one never reaches this function from that hook.
 *   - path-guard.hook.ts's file-tool inputs aren't shell-evaluated at all;
 *     `~`/`$VAR` expansion there is pure defense-in-depth (this hook has no
 *     way to know whether the specific tool implementation would itself
 *     expand them before touching the filesystem).
 */
export function expandUserPath(raw: string): string {
  const homeExpanded = expandHome(raw);
  return homeExpanded.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match: string, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? "";
      return process.env[name] ?? "";
    },
  );
}

/**
 * True when `realTarget` is `realBase` itself or a path underneath it.
 * Both arguments MUST already be realpath'd (symlinks resolved) — this
 * function does no I/O, it only compares strings. Exported so callers that
 * already hold two realpath'd strings (e.g. an already-verified base) can
 * reuse the exact comparison `loader.ts` uses, without re-deriving it.
 */
export function isWithin(realBase: string, realTarget: string): boolean {
  return realTarget === realBase || realTarget.startsWith(realBase + sep);
}

export interface RealpathResolution {
  ok: boolean;
  /** The resolved real path (only meaningful when `ok` is true). */
  real: string;
  /** Human-readable failure reason (only meaningful when `ok` is false). */
  reason: string;
}

/**
 * Resolve `absPath` to its real (symlink-followed) form, tolerating a path
 * that does not exist YET (the Write-tool case: the target file is about to
 * be created, so `realpathSync` on the full path throws ENOENT even though
 * the request is entirely legitimate).
 *
 * Strategy: walk up from the full path until an ancestor that DOES exist is
 * found, realpath THAT ancestor (resolving any symlinks in the existing
 * portion), then re-append the non-existent tail verbatim. This is the
 * standard "realpath of a prospective path" technique — it still resolves
 * every symlink that is actually resolvable, and a symlink planted in the
 * EXISTING portion pointing outside the sandbox is still caught, while a
 * plain "create this new file" request isn't spuriously denied just because
 * the leaf doesn't exist yet.
 *
 * Bounded to 1024 ascents so a pathological input (or a filesystem that
 * NEVER resolves, e.g. every ancestor including `/` throws) cannot spin
 * forever — that case reports `ok: false`, never a silent success.
 */
export function resolveProspectiveRealpath(absPath: string): RealpathResolution {
  let current = absPath;
  const tailSegments: string[] = [];

  for (let i = 0; i < 1024; i++) {
    try {
      const real = realpathSync(current);
      const real2 = tailSegments.length > 0
        ? join(real, ...tailSegments.reverse())
        : real;
      return { ok: true, real: real2, reason: "" };
    } catch (err) {
      const parent = dirname(current);
      if (parent === current) {
        // Reached the filesystem root and even IT doesn't resolve — give up.
        return {
          ok: false,
          real: "",
          reason: `"${absPath}" does not resolve to a real path: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      tailSegments.push(basename(current));
      current = parent;
    }
  }
  return {
    ok: false,
    real: "",
    reason: `"${absPath}" did not resolve within the ascent bound — refusing`,
  };
}

/**
 * Resolve+containment-check `candidatePath` against one policy root
 * (`baseDir`, e.g. one entry of `allowedDirs`/`readOnlyDirs`). Both sides are
 * tilde-expanded and realpath'd (symlinks followed) before comparison — a
 * symlink planted INSIDE an allowed dir that points OUTSIDE it resolves to
 * its real target first, so it cannot escape the check (issue #2343
 * acceptance bullet 4).
 *
 * Returns `ok: false` (never throws) when either side fails to resolve —
 * FAIL CLOSED: an unresolvable base or candidate is never treated as
 * "contained".
 */
export function isContainedIn(baseDir: string, candidatePath: string): boolean {
  const realBaseRes = resolveProspectiveRealpath(expandUserPath(baseDir));
  if (!realBaseRes.ok) return false;
  const realCandidateRes = resolveProspectiveRealpath(expandUserPath(candidatePath));
  if (!realCandidateRes.ok) return false;
  return isWithin(realBaseRes.real, realCandidateRes.real);
}
