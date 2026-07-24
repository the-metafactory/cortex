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
import { basename, dirname, isAbsolute, join, sep } from "path";

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
 * True when an ALREADY-`expandUserPath()`-processed string still carries a
 * form we cannot confidently resolve (cortex#2343 adversarial-review round 2,
 * finding R1). `expandUserPath` only handles the bare `~`/`~/` and `$VAR`/
 * `${VAR}` forms; anything else it leaves untouched:
 *
 *   - `~user` / `~otheruser` (any `~` NOT followed immediately by `/` or
 *     end-of-string) — the OTHER user's home directory. There is no
 *     portable, dependency-free way to resolve an arbitrary system
 *     account's home dir, and no legitimate cortex use ever needs one.
 *     Left unexpanded, the string still starts with `~`.
 *   - Any `$` that didn't match the `$VAR`/`${VAR}` regex (e.g. `$1`, `$(`,
 *     a bare trailing `$`) — an expansion form we don't model.
 *
 * The FIX PHILOSOPHY (per the adversarial review): don't keep chasing
 * individual shell-expansion variants one repro at a time — expand only the
 * known-safe forms, and FAIL CLOSED on anything else. A result that still
 * starts with `~` or still contains `$` after `expandUserPath` MUST be
 * denied by the caller, never resolved-against-cwd (which is exactly the
 * "guard checks a different path than the shell runs" bypass class).
 */
export function isUnresolvedShellToken(expanded: string): boolean {
  return expanded.startsWith("~") || expanded.includes("$");
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

// =============================================================================
// THE single token→real-path reducer (cortex#2343 adversarial review round 3).
//
// ROOT CAUSE of the R1 (~user) and the bash-brace-expansion bypasses: bash
// command tokens and file-tool paths were being reduced to a real path by
// DIVERGENT code in bash-guard.hook.ts and path-guard.hook.ts. Every fix
// landed on ONE surface and left the other open (tilde-user handled in
// path-guard's env expansion but not bash's; braces handled in path-guard's
// Glob branch but never wired into bash-guard's command-path check at all).
// `reduceTokenToRealPathOrReject` is now the ONE place a raw token becomes a
// checkable real path (or an outright rejection) for BOTH hooks — a fix here
// fixes both surfaces by construction, and a hook can no longer drift out of
// sync with the other's protections.
// =============================================================================

/**
 * Glob/shell metacharacters that mark the end of a token's LITERAL
 * (containment-checkable) portion, EXCLUDING `{` — brace groups are handled
 * separately by {@link expandBraceAlternatives} so their CONTENTS get
 * inspected rather than treated as an opaque metachar boundary. `*`/`?`/`[`
 * are genuine wildcards on BOTH surfaces this module serves: Glob's
 * `pattern` argument uses them as glob syntax, and a live shell ALSO
 * performs pathname expansion on them for a Bash argument (`cat /etc/pa*`
 * really does undergo shell globbing) — so the same "derive the literal
 * prefix before the first one" treatment is correct for both.
 */
const GLOB_METACHAR_RE = /[*?[]/;

/**
 * Derive the containment-checkable literal portion of a single path/pattern
 * token (braces already resolved — see {@link expandBraceAlternatives}):
 *
 *   - No metachar in the token at all → the token IS the literal path,
 *     returned UNCHANGED (nothing to trim; the caller resolves this
 *     VERBATIM — e.g. a plain Bash argument naming one exact file, or a
 *     Read/Write `file_path`).
 *   - A metachar (`*`/`?`/`[`) IS present → returns the token's literal
 *     directory prefix up to (not including) the metachar, trimmed back to
 *     the last complete `/` segment (a partial trailing segment, e.g. the
 *     `fo` in `fo*o`, is not a real directory boundary and is dropped
 *     rather than mis-containment-checked). May be `""` when the token has
 *     no directory component before the wildcard (e.g. `*.ts`) — that means
 *     nothing is containment-checkable from the LITERAL portion alone; the
 *     caller falls back to trusting its own already-scoped root (cwd / the
 *     dispatch-configured working directory).
 *
 * Exported for unit tests.
 */
export function deriveLiteralPathPrefix(token: string): string {
  const metaIdx = token.search(GLOB_METACHAR_RE);
  if (metaIdx === -1) return token;
  const prefix = token.slice(0, metaIdx);
  const lastSlash = prefix.lastIndexOf("/");
  if (lastSlash === -1) return "";
  return prefix.slice(0, lastSlash + 1);
}

export type BraceExpansionResult =
  | { kind: "none" } // no brace group at all — treat the token as the sole alternative
  | { kind: "expanded"; alternatives: string[] } // one clean, ≥2-option brace group, resolved
  | { kind: "ambiguous" }; // nested/unbalanced/multiple/single-option brace groups — FAIL CLOSED

/**
 * Expand ONE level of brace alternatives in a path/pattern token:
 * `"{a,b,c}/x"` → `["a/x", "b/x", "c/x"]`. This is what makes
 * `cat {/tmp/secret,x}/f` (a real bash brace expansion — bash genuinely
 * runs the command once per alternative) and a Glob pattern's
 * `{../secret,x}/*` both get their HIDDEN alternatives inspected instead of
 * stopping at the opaque `{` boundary.
 *
 * FAILS CLOSED (`kind: "ambiguous"`) rather than guessing on anything this
 * simple one-level parser can't confidently handle: a nested brace group, a
 * second top-level brace group, an unbalanced `{`/`}`, or a brace group with
 * FEWER THAN TWO comma-separated options (a real shell only performs brace
 * expansion with ≥2 alternatives — `{solo}` with no comma is usually left
 * LITERAL by bash, so "expanding" it would mean containment-checking a
 * DIFFERENT string than the one bash actually reads; safer to refuse the
 * whole token than guess at a non-standard single-option form). Legitimate
 * patterns/commands never need any of these shapes, so denying them costs
 * nothing real. Exported for unit tests.
 */
export function expandBraceAlternatives(token: string): BraceExpansionResult {
  const firstOpen = token.indexOf("{");
  if (firstOpen === -1) return { kind: "none" };

  const firstClose = token.indexOf("}", firstOpen);
  if (firstClose === -1) return { kind: "ambiguous" }; // unbalanced

  const inner = token.slice(firstOpen + 1, firstClose);
  if (inner.includes("{") || inner.includes("}")) return { kind: "ambiguous" }; // nested

  const rest = token.slice(firstClose + 1);
  if (rest.includes("{") || rest.includes("}")) return { kind: "ambiguous" }; // a second group

  const prefix = token.slice(0, firstOpen);
  const options = inner.split(",");
  if (options.length < 2) return { kind: "ambiguous" }; // not a real alternation

  const alternatives = options.map((opt) => prefix + opt + rest);
  return { kind: "expanded", alternatives };
}

export interface ReducedToken {
  ok: boolean;
  /**
   * Real (symlink-resolved) paths the caller must containment-check — ONE
   * entry per token normally, but potentially several when the token
   * contained a brace group (bash's brace expansion genuinely runs the
   * command once per alternative, e.g. `cat {a,b}/f` reads BOTH `a/f` and
   * `b/f` — so BOTH must pass containment, not just one). An EMPTY array is
   * NOT a failure — it means nothing is containment-checkable from this
   * token alone (a bare wildcard with no directory component, e.g.
   * `*.ts`); the caller's own already-scoped root (cwd) covers it.
   */
  reals: string[];
  /** Populated when `ok` is false — WHY the token was rejected. */
  reason: string;
}

/**
 * THE single source of truth for turning any raw path/pattern token (a Bash
 * command argument, or a file-tool `file_path`/`path`/Glob `pattern`) into
 * zero or more checkable real paths, or an outright fail-closed rejection.
 * Both `bash-guard.hook.ts` and `path-guard.hook.ts` call this — see the
 * module-section doc above for why unifying this one function is the
 * actual fix, not another per-surface patch.
 *
 * Pipeline (each stage's rationale is documented on the function it calls):
 *   1. `expandUserPath` — expand the known-safe `~`/`~/`/`$VAR`/`${VAR}` forms.
 *   2. `isUnresolvedShellToken` — FAIL CLOSED if a `~user` form or a residual
 *      `$` survived (R1) — never resolved-against-cwd.
 *   3. Brace expansion (`expandBraceAlternatives`) if the token contains
 *      `{` — FAIL CLOSED on ambiguous brace syntax.
 *   4. For EACH alternative (exactly one, when there were no braces):
 *      - When the token had ≥2 brace alternatives, OR this alternative
 *        itself carries a genuine wildcard metachar (`*`/`?`/`[`): derive
 *        its literal prefix (`deriveLiteralPathPrefix`) and REJECT THE
 *        WHOLE TOKEN outright if that prefix is absolute or carries a `..`
 *        segment — legit brace alternatives / glob patterns never need
 *        either, so this is an unconditional veto, not a normal
 *        containment check that a coincidental in-scope match could pass.
 *        An EMPTY literal prefix (bare wildcard, no directory component)
 *        means nothing is checkable from this alternative — skip it (not a
 *        failure).
 *      - Otherwise (the common case: one plain literal token, no braces, no
 *        wildcard) resolve it NORMALLY (absolute as-is, else joined against
 *        `cwd`) — an absolute path that happens to be INSIDE an allowed dir
 *        stays ALLOWED here; the caller's ordinary containment check
 *        (`isContainedIn`) is what decides that, same as it always has for
 *        Read/Write `file_path`.
 *   5. Every candidate that reaches this point is realpath-resolved via
 *      `resolveProspectiveRealpath` (symlink-safe, tolerates a not-yet-
 *      existing Write target) and collected into `reals`.
 */
export function reduceTokenToRealPathOrReject(rawToken: string, cwd: string): ReducedToken {
  const expanded = expandUserPath(rawToken);

  if (isUnresolvedShellToken(expanded)) {
    return {
      ok: false,
      reals: [],
      reason:
        `token "${rawToken}" contains an unresolvable shell expansion (a ~user form or a ` +
        `literal "$")`,
    };
  }

  let alternatives: string[];
  if (expanded.includes("{")) {
    const braceResult = expandBraceAlternatives(expanded);
    if (braceResult.kind === "ambiguous") {
      return {
        ok: false,
        reals: [],
        reason:
          `token "${rawToken}" has brace syntax that cannot be confidently parsed (nested, ` +
          `unbalanced, single-option, or multiple brace groups)`,
      };
    }
    alternatives = braceResult.kind === "expanded" ? braceResult.alternatives : [expanded];
  } else {
    alternatives = [expanded];
  }

  const isMultiAlternative = alternatives.length > 1;
  const reals: string[] = [];

  for (const alt of alternatives) {
    const literalPrefix = deriveLiteralPathPrefix(alt);
    const hasWildcard = literalPrefix !== alt;
    const strictVeto = isMultiAlternative || hasWildcard;

    let candidate: string;
    if (strictVeto) {
      if (literalPrefix === "") continue; // nothing checkable from this alternative — not a failure
      if (isAbsolute(literalPrefix) || literalPrefix.split("/").some((seg) => seg === "..")) {
        return {
          ok: false,
          reals: [],
          reason:
            `token "${rawToken}" resolves to an absolute path or a ".." escape via ` +
            `${isMultiAlternative ? "a brace alternative" : "a wildcard"} ("${alt}") — this is ` +
            `refused unconditionally, regardless of whether it happens to land in scope`,
        };
      }
      candidate = literalPrefix;
    } else {
      candidate = alt;
    }

    const absCandidate = isAbsolute(candidate) ? candidate : join(cwd, candidate);
    const resolved = resolveProspectiveRealpath(absCandidate);
    if (!resolved.ok) {
      return { ok: false, reals: [], reason: `token "${rawToken}" ${resolved.reason}` };
    }
    reals.push(resolved.real);
  }

  return { ok: true, reals, reason: "" };
}
