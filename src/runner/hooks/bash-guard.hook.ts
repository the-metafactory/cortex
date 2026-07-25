#!/usr/bin/env bun
/**
 * Cortex Bash Guard — PreToolUse hook for Bash commands in cortex sessions.
 *
 * Only activates when the surface channel env var is set (cortex bot session):
 * cc-session sets `CORTEX_CHANNEL`; the legacy `GROVE_CHANNEL` name is retained
 * as a read-fallback during the GROVE_* → CORTEX_* transition (cortex#767/#774).
 * Enforces a command allowlist with repo restrictions for gh CLI.
 * Non-cortex sessions pass through unchanged.
 *
 * Config via CORTEX_BASH_GUARD env var (JSON):
 *   { "rules": [{ "pattern": "^gh\\s+pr", "repos": ["owner/repo"] }] }
 *
 * If no config env var, uses sensible defaults (gh, git read-only, ls, pwd).
 *
 * Block behaviour (cortex#bash-guard-observability):
 *   - Emits Claude Code's structured PreToolUse *deny* decision on stdout
 *     ({"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *       "permissionDecision":"deny","permissionDecisionReason":"…"}}).
 *     The reason surfaces to the agent (and the Cortex→Discord relay)
 *     instead of being lost in an exit-code-2 + stderr line.
 *   - Also emits a `tool.bash.blocked` telemetry event into the cc-events
 *     pipeline (HTTP POST to the dashboard ingest endpoint, with a JSONL
 *     fallback) so blocks are observable. Best-effort — never blocks the
 *     deny decision.
 *
 * ## Known limitations (cortex#2343/#2359 adversarial review, 7 rounds — L1's last)
 *
 * This guard inspects the command STRING, not a real shell parse tree — it
 * is a best-effort classifier against bash's word-evaluation rules and each
 * path-checked command's own path-reading behavior, not a formal shell
 * parser. Seven adversarial rounds each found ONE way the guard's literal-
 * token resolution diverged from what bash/the tool would actually read
 * (tilde-user expansion, brace expansion, quote-removal, backslash-escaping,
 * flag-glued path values, bare-relative flag-value coverage) — the fix each
 * time was to FAIL CLOSED on whatever couldn't be confidently classified/
 * resolved, culminating in round 5's character whitelist (deny anything
 * outside a closed safe set), round 6's flag-value SHAPE classification
 * (deny anything `-`-prefixed that looks path-shaped), and round 7's
 * per-command flag-name WHITELIST (deny anything `-`-prefixed that isn't an
 * explicitly-modeled boolean/numeric flag for that command — see
 * `COMMAND_FLAG_POLICIES`). That posture — fail closed on ambiguity — is
 * what makes this guard SAFE, but it is NOT airtight by construction the
 * way a real parser + kernel boundary would be. The kernel sandbox (L2,
 * EBH-2/EBH-3, `docs/design-session-sandbox.md`) is the actual boundary;
 * this guard is Tier-0 defense-in-depth in front of it.
 *
 * Accepted residuals (deliberately not chased further — over-deny, not
 * under-deny, direction):
 *   - Bash special parameters (`$_`, `$0`, `$#`, `$@`, `$*`, `$-`, `$$`,
 *     `$!`, `$?`) are NOT expanded by `expandUserPath`'s `$VAR`/`${VAR}`
 *     regex (it only matches `[A-Za-z_][A-Za-z0-9_]*` identifiers) — a
 *     token containing one still has a residual `$` after expansion and is
 *     denied by `isUnresolvedShellToken`, even in the rare case a special
 *     parameter would have expanded to something harmless. Over-deny, safe
 *     direction.
 *   - CLOSED at round 7 (cortex#2359 finding 1): round 6's claim that "no
 *     known GNU coreutils/`file` flag has a path-shaped value WITHOUT `/`,
 *     `~`, or a `.`-leading `=`-value" turned out to be false — a BARE
 *     RELATIVE filename (`file -flist`, `file --files-from=list`, `wc
 *     --files0-from=list`) is exactly that case, and was a live bypass on
 *     `main` until round 7's per-command flag-name whitelist closed it. A
 *     future command added to `PATH_CHECKED_COMMANDS` with a genuinely
 *     unmodeled flag is now refused BY CONSTRUCTION (any flag not on
 *     `COMMAND_FLAG_POLICIES[cmd]` denies the whole command), not merely
 *     mitigated by a shape heuristic — but `COMMAND_FLAG_POLICIES` itself
 *     still needs a manual entry for each new command; an entry that is
 *     ITSELF wrong (a flag miscategorized as boolean when the real tool
 *     treats it as value-taking) is not caught by this guard and would need
 *     its own review, same as any allowlist.
 *   - TOCTOU (cortex#2359 finding 2, architecturally unfixable at L1): this
 *     guard authorises a path STRING — it realpath-resolves the argument
 *     and proves containment, then RETURNS. The actual tool call (Claude
 *     Code's own Bash/Read/Write execution, which happens AFTER this hook
 *     returns) then RE-OPENS that same path by name. Nothing binds the
 *     checked object to the opened object: a check-then-swap between this
 *     hook's `realpathSync` and the tool's own `open()` (e.g. replacing an
 *     in-scope path with a symlink to an out-of-scope target in the
 *     intervening window) escapes the check. This is NOT fixable at L1. The
 *     standard remedy — `openat2(dirfd, rel, RESOLVE_BENEATH|
 *     RESOLVE_NO_SYMLINKS)`, binding authorisation to a file DESCRIPTOR
 *     rather than a re-resolved path — requires controlling the open() call
 *     itself; cortex does not (Claude Code's own Read/Write/Bash tooling
 *     performs it), and `openat2` is Linux-only regardless. Only a kernel
 *     boundary around the process (L2, EBH-2/EBH-3) can bind authorisation
 *     to the actual inode instead of a path string. No L1 fix was attempted
 *     for this — see `docs/design-session-sandbox.md` for the L2 remedy.
 */

import { appendFileSync, mkdirSync, chmodSync, existsSync } from "fs";
import { join } from "path";
import { EVENT_TYPES } from "../../taps/cc-events/hooks/lib/event-taxonomy";
import { eventsDir } from "../../common/events-path";
import { resolveSurfaceEnv } from "../../taps/cc-events/hooks/lib/surface-env";
import { resolvePrincipalEnv } from "../../taps/cc-events/hooks/lib/principal-env";
import { isContainedIn, reduceTokenToRealPathOrReject } from "../../common/path-containment";
import { parsePathGuardConfig } from "./path-guard.hook";

interface HookInput {
  session_id?: string;
  tool_name: string;
  tool_input: { command?: string } | string;
}

interface AllowRule {
  pattern: string;
  repos?: string[];
}

/**
 * Read-only AWS CLI allowlist pattern.
 *
 * This is the regex halden's `bashAllowlist` uses for its `aws` rule. It is
 * exported (and unit-tested in bash-guard.hook.test.ts) so the live config
 * inherits a *proven* read-only-only pattern rather than a hand-rolled one.
 *
 * Tolerates, before the verb:
 *   - global flags `--profile <x>` / `--region <x>` / `--output <x>` and the
 *     valueless `--no-cli-pager`.
 *   (A leading env prefix — `AWS_PROFILE=… aws …` — is stripped by the hook's
 *    stripEnvPrefix() before matching, so it is not modelled in the regex.)
 *
 * Allows ONLY read-only verbs:
 *   - `sts get-caller-identity`
 *   - `<service> describe-*` / `<service> get-*` / `<service> list-*`
 *
 * MUST NOT match any write/exec verb: send-command, start-session,
 * run-instances, terminate-*, stop-*, start-*, *-create-*, delete-*, put-*,
 * modify-*, update-*, reboot-*, etc. Those never begin with describe/get/list,
 * so the verb-prefix anchor denies them by construction. When in doubt, deny.
 *
 * Note: this pattern only governs whether a single, well-formed `aws …`
 * invocation is *read-only*. The hook's metacharacter guard (rejectsChaining)
 * independently refuses any attempt to smuggle a second command via pipes,
 * substitution, backticks, redirects, background `&`, or newlines — so an
 * allow-match here can never carry a hidden destructive command.
 */
export const READONLY_AWS_PATTERN =
  // ^aws
  "^aws" +
  // optional global flags before the service. Each --profile/--region/--output
  // consumes its value via \S+ (which excludes whitespace, so a flag value can
  // never itself supply a "service verb" pair); --no-cli-pager is valueless.
  "(?:\\s+(?:--(?:profile|region|output)\\s+\\S+|--no-cli-pager))*" +
  // service + read-only verb
  "\\s+(?:" +
  // sts get-caller-identity (the one explicitly-allowed get on sts)
  "sts\\s+get-caller-identity" +
  "|" +
  // <service> describe-* / get-* / list-*. Service must start with a letter
  // so a flag token like `--profile` can never be mistaken for a service (which
  // would let `--profile describe-instances` smuggle a read verb past the flag
  // consumer).
  "[a-z][a-z0-9-]*\\s+(?:describe|get|list)-[a-z0-9-]+" +
  ")" +
  // must end here or be followed by whitespace (args) — never glued to more
  // verb characters (blocks `run-describe-hack` from matching `describe`).
  "(?:\\s|$)";

interface GuardConfig {
  rules: AllowRule[];
  repos?: string[];  // Global repo whitelist (applies to all gh commands)
}

const DEFAULT_CONFIG: GuardConfig = {
  rules: [
    // gh: READ-ONLY porcelain SUBCOMMANDS only (cortex#2335). Two vectors are
    // closed here:
    //   1. `api`/`run` are absent — `gh api` is a raw REST client; on the floor
    //      (repos: []) the repo-pin block never engages, so it could reach ANY
    //      endpoint (`-X PUT repos/<o>/<r>/pulls/<n>/merge`, `-X DELETE`, deploy
    //      keys, `gh api graphql`), and `gh run` can dispatch/cancel workflows.
    //   2. Porcelain is subcommand-restricted, NOT verb-open. A bare
    //      `^gh\s+(pr|issue|repo)\s` still allowed `gh pr merge --admin`,
    //      `gh pr review --approve`, `gh issue delete`, `gh repo delete` — so a
    //      floor agent on untrusted Discord input (prompt injection) could merge
    //      or delete, i.e. the chat floor stayed STRONGER than the deliberately
    //      narrowed code capability (stack-lib.ts pins `gh pr` to
    //      create|view|list|diff|checks, "NEVER merge", no `gh repo` at all).
    // The floor now allows only non-mutating subcommands, mirroring/under the
    // code capability. A stack needing more declares an explicit (ideally
    // repos-pinned) bashAllowlist rule — never the floor.
    { pattern: "^gh\\s+pr\\s+(view|list|diff|checks|status|comment)\\b" },
    { pattern: "^gh\\s+issue\\s+(view|list|status|comment)\\b" },
    { pattern: "^gh\\s+repo\\s+view\\b" },
    { pattern: "^git\\s+(log|diff|show|status|branch|fetch|remote|rev-parse)\\b" },
    { pattern: "^ls\\b" },
    { pattern: "^pwd$" },
    { pattern: "^echo\\b" },
    { pattern: "^cat\\b" },
    { pattern: "^head\\b" },
    { pattern: "^tail\\b" },
    { pattern: "^wc\\b" },
    { pattern: "^which\\b" },
    { pattern: "^file\\b" },
  ],
  repos: [],
};

// Narrow projection of the CORTEX_BASH_GUARD env var payload. The hook
// reads only `disabled` / `rules` / `repos`; anything else is ignored.
interface GuardConfigRaw {
  disabled?: boolean;
  rules?: AllowRule[];
  repos?: string[];
}

/**
 * Result of loading `CORTEX_BASH_GUARD`. Mirrors `path-guard.hook.ts`'s
 * `parsePathGuardConfig` posture (cortex#2343 adversarial review round 4 —
 * aligning a fail-OPEN the review flagged):
 *
 *   - `ok:true, config:GuardConfig` — a usable config (absent/empty env ⇒
 *     `DEFAULT_CONFIG`; valid JSON, not disabled ⇒ the parsed config).
 *   - `ok:true, config:null` — G-300: the principal DM explicitly disabled
 *     the guard (`{"disabled":true}`). Distinct from `ok:false` — this is
 *     an intentional, well-formed instruction, not a failure.
 *   - `ok:false, config:null` — `CORTEX_BASH_GUARD` is PRESENT but
 *     unparseable JSON, or parses to something other than an object. This
 *     used to silently fall back to `DEFAULT_CONFIG` (fail OPEN — a
 *     corrupted/tampered env var got the safe default instead of a deny).
 *     Now the caller must DENY, matching `parsePathGuardConfig`'s posture:
 *     absence/empty is a legitimate "no config" state, but a PRESENT,
 *     malformed value is a genuine failure. `disabled`/`rules`/`repos`
 *     fields with the WRONG type (e.g. `rules` not an array) are tolerated
 *     (coerced via the existing `??` fallbacks) — only a JSON parse
 *     failure or a non-object top level is treated as malformed.
 */
interface LoadConfigResult {
  ok: boolean;
  config: GuardConfig | null;
  reason: string;
}

function loadConfig(): LoadConfigResult {
  const raw = process.env.CORTEX_BASH_GUARD;
  if (!raw) return { ok: true, config: DEFAULT_CONFIG, reason: "" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      config: null,
      reason: `CORTEX_BASH_GUARD is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, config: null, reason: "CORTEX_BASH_GUARD did not parse to a JSON object" };
  }

  const guardRaw = parsed as GuardConfigRaw;
  // G-300: Principal DM disables bash guard entirely — a well-formed
  // instruction, not a failure.
  if (guardRaw.disabled) return { ok: true, config: null, reason: "" };
  return {
    ok: true,
    config: {
      rules: guardRaw.rules ?? DEFAULT_CONFIG.rules,
      repos: guardRaw.repos ?? [],
    },
    reason: "",
  };
}

/**
 * Extract repo from a gh CLI command. Matches BOTH the whitespace form
 * (`--repo owner/name`, `-R owner/name`) AND the `=` form (`--repo=owner/name`,
 * `-R=owner/name`) — gh accepts either, and matching only whitespace left the
 * `=` form as a repo-pin bypass (cortex#2331 7a review F1). Also handles the
 * `gh api repos/owner/name/...` path form.
 *
 * Returns null when no repo can be determined from the command. Callers that
 * carry a `repos` restriction treat null as FAIL-CLOSED (deny) — a pin you can
 * silently skip is not a pin.
 */
function extractGhRepo(command: string): string | null {
  // `(?:\s+|=)` accepts the space form and the `=` form for both flag spellings.
  const repoFlag = /(?:--repo|-R)(?:\s+|=)([^\s]+)/.exec(command);
  if (repoFlag) return repoFlag[1] ?? null;

  const apiPath = /gh\s+api\s+repos\/([^/]+\/[^/\s]+)/.exec(command);
  if (apiPath) return apiPath[1] ?? null;

  return null;
}

/**
 * Strip leading env var assignments to prevent bypass.
 * e.g., LANG=C gh pr view ... → gh pr view ...
 */
function stripEnvPrefix(command: string): string {
  return command.replace(
    /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+)*/,
    "",
  );
}

/**
 * No-bypass guard: detect shell metacharacters that could smuggle a SECOND
 * command past an allow-prefix.
 *
 * The allowlist matcher below splits on `&& || ;` and validates each segment,
 * so a chain of *allowed* commands (`ls && pwd`) is fine. But the following
 * constructs can carry a command that the segment-matcher never inspects, so
 * any command containing them is denied outright — regardless of which allow
 * pattern the head matches. This protects EVERY pattern (gh / git / aws / …),
 * not just the read-only aws rule.
 *
 *   |          pipe — RHS command never validated
 *   $(  )      command substitution
 *   `  `       backtick command substitution
 *   &          background / job-control (a lone `&`, not part of `&&`)
 *   <  >       redirection (can clobber files / read secrets)
 *   newline    a second command on the next line
 *
 * Returns true when the command must be rejected.
 *
 * Note: this is intentionally conservative. It does not attempt to parse
 * quoting — a `|` inside a quoted argument is rare in the read-only command
 * surface this guard governs, and denying it (false positive) is the safe
 * direction. When in doubt, deny.
 */
function rejectsChaining(command: string): boolean {
  // Newline (any flavour) → a second command line.
  if (/[\r\n]/.test(command)) return true;
  // Command substitution `$(` (covers `$(( ))` too) and backticks.
  if (command.includes("$(")) return true;
  if (command.includes("`")) return true;
  // Redirection — can clobber files or read secrets.
  if (/[<>]/.test(command)) return true;
  // A single pipe `|` that is NOT one half of the `||` chain token. We
  // collapse every `||` to a placeholder first, then look for a remaining `|`.
  if (command.replace(/\|\|/g, "").includes("|")) return true;
  // A single `&` that is NOT part of the `&&` chain token (i.e. background
  // / job-control). Same collapse trick.
  if (command.replace(/&&/g, "").includes("&")) return true;
  return false;
}

// =============================================================================
// Path containment for read-command rules (EBH-1, cortex#2343 step 3).
//
// Command-shape allow (the DEFAULT_CONFIG rules above) is necessary but no
// longer sufficient: `^cat\b` matches `cat ~/.config/metafactory/cortex/
// system/system.yaml` with no path check. These commands additionally
// containment-check their path argument(s) against the SAME
// `CORTEX_PATH_GUARD` policy `path-guard.hook.ts` enforces for the file
// tools — one resolved policy, two enforcement points (design spec DD-1).
// =============================================================================

/** Bash read commands whose path argument(s) get containment-checked. */
const PATH_CHECKED_COMMANDS = new Set(["cat", "head", "tail", "ls", "wc", "file"]);

export interface ExtractedCommandPaths {
  /**
   * null = the WHOLE COMMAND must be denied — a candidate path token still
   * carries an embedded/unbalanced quote character after the whole-token
   * strip (round 4: bash quote-removal), or a character outside the safe
   * whitelist (round 5: bash backslash-escaping and the whole unenumerated
   * class of char-based tricks). See {@link reason}.
   */
  paths: string[] | null;
  /** Populated when `paths` is null — WHY the command must be denied. */
  reason?: string;
}

/**
 * cortex#2343 adversarial review round 5 — the WHITELIST that replaces
 * blacklisting individual shell tricks. Rounds 1–4 each closed ONE
 * predicted bypass (tilde-user, brace expansion, quote-removal) only for
 * the review to find the NEXT unmodelled char trick — round 5 is backslash
 * escaping: bash removes a backslash before the char it escapes
 * (`\.` → `.`), so `cat /a/\../secret/x` reads `/a/../secret/x` while the
 * guard's literal-token resolution saw an unescaped `\` byte and either
 * mis-resolved it or (worse) let it through unchecked entirely.
 *
 * We stop predicting bash's word-evaluation rules and instead require every
 * character in a path token to come from a closed, conservative safe set:
 * letters, digits, and `/ . _ - ~ $ { } [ ] * ? @ : + % , =`. ANYTHING else
 * — backslash, quotes (already denied separately, round 4), backticks,
 * parens, `!`, `#`, `^`, whitespace, control characters, and any char-based
 * trick not yet enumerated by an adversarial review — is OUTSIDE the set
 * and DENIES the command. This is closed-by-construction against the whole
 * class, not just the instances found so far, at the cost of over-denying
 * some exotic-but-legit paths (a filename with a literal `!` or `#`, say).
 * That is the correct trade for a security guard: the kernel sandbox (L2,
 * EBH-2/EBH-3) is the real boundary behind this one, so an occasional
 * legitimate command needing a wider character has an escape hatch (widen
 * `allowedDirs`, or route through a tool other than these six bash
 * commands) that a silently-bypassed guard does not.
 *
 * The reducer (`reduceTokenToRealPathOrReject`) still does all the actual
 * `~`/`$VAR`/brace/glob interpretation — this whitelist runs BEFORE it and
 * only ever narrows what reaches it; it never widens anything.
 */
const SAFE_PATH_CHAR_RE = /^[A-Za-z0-9/._~$@:+%,={}[\]*?-]*$/;

/**
 * cortex#2343 adversarial review round 6 — True when a `-`-prefixed token
 * LOOKS like it carries a path glued to the flag, and must therefore be
 * denied rather than blanket-skipped as "just a flag":
 *
 *   - the token contains a `/` anywhere (`-f/tmp/x`, `--files-from=/tmp/x`), or
 *   - the token contains a `~` anywhere (`-f~/x`), or
 *   - the token has a `--flag=value` form whose value starts with `.`
 *     (`--files-from=.hidden`) — a relative/dotfile path with no `/`, which
 *     the first two checks alone would miss.
 *
 * A boolean/non-path flag (`-l`, `-d`, `--mime-type`, `--color=auto`) hits
 * none of these and is still skipped/allowed, unchanged. This function is
 * used ONLY to decide "deny outright", never to decide "this is safe" — it
 * has no false-negative cost in the safe direction (see the call site: a
 * `false` result still just `continue`s past the token as before; it is
 * NEVER treated as ok-to-resolve on its own).
 */
function isPathShapedFlagValue(tok: string): boolean {
  if (tok.includes("/") || tok.includes("~")) return true;
  const eqIdx = tok.indexOf("=");
  if (eqIdx !== -1 && tok.slice(eqIdx + 1).startsWith(".")) return true;
  return false;
}

/**
 * cortex#2359 (EBH-1c finding 1, round 7) — the per-command safe-flag
 * WHITELIST that closes the gap round 6's blacklist-of-shapes left open.
 *
 * Round 6 only denied a `-`-prefixed token that itself LOOKED path-shaped
 * (contained `/`/`~`, or had a `.`-leading `=`-value) — see
 * {@link isPathShapedFlagValue}. A BARE RELATIVE filename glued to a
 * value-taking flag matches none of those shapes: `file -flist`,
 * `file --files-from=list`, `wc --files0-from=list` all fell through the
 * "just a flag, skip it" branch and were never containment-checked, even
 * though `file`/`wc` are in {@link PATH_CHECKED_COMMANDS} PRECISELY because
 * they read paths — `-f`/`--files-from`/`--files0-from` read the file NAMED
 * BY THE VALUE (and `file` echoes its contents back verbatim on a parse
 * error: a live, confirmed exfil primitive, not a hypothetical).
 *
 * Blacklisting shapes is what just failed — this is the same lesson round 5
 * already learned for path CHARACTERS, now applied to path FLAGS: instead of
 * trying to enumerate every unsafe flag (an open-ended, ever-growing list),
 * enumerate the SAFE ones per command and deny the WHOLE COMMAND for
 * anything not on that list. Every entry here is a boolean or numeric-only
 * flag that does NOT read an argument as a path in the real tool — verified
 * against each tool's own `--help` / man page. A future command added to
 * PATH_CHECKED_COMMANDS with an unmodeled value-taking flag is refused by
 * construction (unrecognised ⇒ deny), never silently skipped.
 */
interface CommandFlagPolicy {
  /** Single-char flags that take NO value — safe standalone or bundled (`-la`). */
  shortBoolean: ReadonlySet<string>;
  /**
   * Single-char flags that take a value — either as a SEPARATE next token
   * (`-n 20`, unchanged from the pre-round-7 "flag value is the next
   * candidate-path token" handling below) or glued directly with a PURELY
   * NUMERIC value (`-n20`, the common GNU-getopt short form). Never safe
   * bundled with other letters (`-nl` is refused — ambiguous).
   */
  shortValue: ReadonlySet<string>;
  /** Long-flag names (without `--`) that never take a value. */
  longBoolean: ReadonlySet<string>;
  /**
   * Long-flag names that may appear as `--flag=value`. None of these
   * actually consume a PATH as their value in the real tool (that's what
   * makes them safe to whitelist) — but the value is still pushed through
   * the same candidate-path / containment pipeline as every other argument
   * (defense in depth, and what lets a bare `--flag` with no `=` pass too).
   */
  longValue: ReadonlySet<string>;
}

const COMMAND_FLAG_POLICIES: Readonly<Record<string, CommandFlagPolicy>> = {
  cat: {
    shortBoolean: new Set(["n", "b", "s", "v", "e", "t", "A", "E", "T"]),
    shortValue: new Set(),
    longBoolean: new Set(),
    longValue: new Set(),
  },
  head: {
    shortBoolean: new Set(["q", "v"]),
    shortValue: new Set(["n", "c"]),
    longBoolean: new Set(),
    longValue: new Set(["lines", "bytes"]),
  },
  tail: {
    shortBoolean: new Set(["q", "v", "f"]),
    shortValue: new Set(["n", "c"]),
    longBoolean: new Set(["follow"]),
    longValue: new Set(["lines", "bytes"]),
  },
  ls: {
    shortBoolean: new Set(["l", "a", "A", "h", "R", "t", "r", "S", "1", "d", "F", "G"]),
    shortValue: new Set(),
    longBoolean: new Set(),
    // `--color` (bare, or `--color=auto|always|never`) — no path value.
    longValue: new Set(["color"]),
  },
  wc: {
    // Deliberately NO longBoolean/longValue entries — `--files0-from` (the
    // live bypass this round closes) is NOT on this list, on purpose.
    shortBoolean: new Set(["l", "w", "c", "m", "L"]),
    shortValue: new Set(),
    longBoolean: new Set(),
    longValue: new Set(),
  },
  file: {
    shortBoolean: new Set(["b", "i", "L", "h", "z"]),
    shortValue: new Set(),
    longBoolean: new Set(["mime-type", "mime-encoding"]),
    // `-f`/`--files-from` are deliberately ABSENT — that's the bypass this
    // round closes. `color` is not a real `file` flag, but accepting it as
    // a value-flag costs nothing (it never reads a path either) and matches
    // this guard's own pre-existing test matrix for "an `=`-flag with a
    // non-path value must not be denied".
    longValue: new Set(["color"]),
  },
};

type FlagClassification =
  | { kind: "safe" }
  | { kind: "value"; value: string }
  | { kind: "deny" };

/**
 * Classify a single `-`-prefixed token against one command's
 * {@link CommandFlagPolicy}. Called ONLY after {@link isPathShapedFlagValue}
 * has already cleared the token (that check still runs first and keeps its
 * existing deny message/behaviour unchanged — this is an ADDITIONAL,
 * stricter gate, not a replacement).
 *
 * Exported for unit tests.
 */
export function classifyFlagToken(tok: string, policy: CommandFlagPolicy): FlagClassification {
  if (tok.startsWith("--")) {
    const body = tok.slice(2);
    const eqIdx = body.indexOf("=");
    const name = eqIdx === -1 ? body : body.slice(0, eqIdx);
    if (eqIdx === -1) {
      if (policy.longBoolean.has(name) || policy.longValue.has(name)) return { kind: "safe" };
      return { kind: "deny" };
    }
    if (policy.longValue.has(name)) {
      return { kind: "value", value: body.slice(eqIdx + 1) };
    }
    return { kind: "deny" };
  }

  const body = tok.slice(1); // strip the single leading "-"
  if (body.length === 0) return { kind: "safe" }; // bare "-" (stdin marker)

  if (body.length === 1) {
    if (policy.shortBoolean.has(body) || policy.shortValue.has(body)) return { kind: "safe" };
    return { kind: "deny" };
  }

  // Multi-char short-option token: either a glued numeric value ("-n20": a
  // shortValue char followed by a purely-numeric remainder), or a bundle of
  // boolean flags ("-la"). A value flag glued with non-digit chars ("-nl")
  // is ambiguous and denied — never both interpretations in the same token.
  const first = body[0] ?? "";
  const rest = body.slice(1);
  if (policy.shortValue.has(first) && /^[0-9]+$/.test(rest)) return { kind: "safe" };

  for (const ch of body) {
    if (!policy.shortBoolean.has(ch)) return { kind: "deny" };
  }
  return { kind: "safe" };
}

/**
 * Extract candidate path arguments from a single, already env-stripped,
 * already-segment-split shell command string. Deliberately NOT a full shell
 * parser: `rejectsChaining()` (above, runs BEFORE this) already refuses
 * every construct that could smuggle a hidden argument (pipes, command
 * substitution, backticks, redirects, background `&`, newlines), so this
 * only has to tokenize a single simple invocation (`cat foo.txt`,
 * `ls -la /some/dir`, `head -n 20 bar.log`).
 *
 * Tokens starting with `-` are treated as flags and skipped. A flag's VALUE
 * token (e.g. the `20` in `head -n 20 file`) is NOT itself `-`-prefixed, so
 * it falls through and is conservatively treated as a candidate path — this
 * can under-deny (a numeric flag value resolves relative to the session's
 * already-allowed cwd, so it almost always still resolves inside policy
 * scope) but never OVER-denies a real flag as an escaping path.
 *
 * A token that is wrapped ENTIRELY in one matching pair of quotes (e.g. the
 * whole `"my file.txt"` argument, used for a path containing a space) is
 * unwrapped and kept — this is the one shell-quoting form we DO replicate,
 * because it's unambiguous: the regex below only ever captures a `"…"`/`'…'`
 * span as ONE token when it starts and ends the token, so a legitimate
 * whole-token quote can only ever produce a clean strip.
 *
 * cortex#2343 adversarial review round 4 (bash quote-removal, the 4th
 * bypass in this series): real bash performs quote-REMOVAL, including the
 * `""`/`''` EMPTY-STRING-CONCATENATION form — `/a/""/../b` is read by bash
 * as `/a/../b` (the empty quoted segment vanishes, so the `..` cancels the
 * PREVIOUS segment instead of a phantom one), which silently changes which
 * directory a `..` escapes from. We do NOT attempt to replicate this or any
 * other embedded-quote form — tilde-user and brace-expansion were BOTH
 * bypassed by trying to predict one more corner of shell parsing, so the
 * line now is: don't predict, refuse. Any token that STILL contains a `"`
 * or `'` after the whole-token strip above (an embedded quote mid-token, OR
 * a dangling/unbalanced quote that the strip couldn't cleanly remove) DENIES
 * THE WHOLE COMMAND — `paths: null` — rather than resolving a string that
 * might not be the one the shell actually reads. Legitimate file reads
 * never embed a quote character mid-path; whole-token-quoted paths (for
 * spaces) are unaffected, since those are fully stripped clean above.
 *
 * cortex#2343 adversarial review round 6 (flag-value classification): a
 * `-`-prefixed token was unconditionally skipped as "just a flag" — never
 * classified as a path, so never whitelisted or reduced. `file`'s
 * `-f`/`--files-from` and `wc`'s `--files0-from` read the PATH GLUED to the
 * flag and can echo that file's contents back on error — `file
 * -f/tmp/secret/x` / `file --files-from=/tmp/secret/x` exfiltrated arbitrary
 * file content while the guard saw "just a flag" and allowed it. Fixed by
 * {@link isPathShapedFlagValue}: any `-`-prefixed token that LOOKS like it
 * carries a path (contains `/`/`~`, or a `.`-leading `=`-value) is denied
 * outright rather than being classified.
 *
 * cortex#2359 adversarial review round 7 (EBH-1c finding 1, the coverage-
 * closing round): round 6's shape-based deny left a gap — a BARE RELATIVE
 * filename glued to a value-taking flag (`file -flist`,
 * `file --files-from=list`, `wc --files0-from=list`) contains none of
 * `/`/`~`/a `.`-leading value, so it matched none of round 6's shapes and
 * fell through to the SAME "just a flag, skip it" path round 6 was supposed
 * to close. Fixed by {@link classifyFlagToken} + {@link
 * COMMAND_FLAG_POLICIES}: every `-`-prefixed token that survives round 6's
 * check must now ALSO be on the calling command's explicit safe-flag
 * whitelist (boolean/numeric flags only, verified against each tool's own
 * `--help`/man page — none of them read a path as their value) or the WHOLE
 * command is denied. This closes the class by construction — a future
 * value-taking flag this review didn't enumerate is refused (unrecognised
 * ⇒ deny), never silently skipped, unlike round 6's shape-only check.
 *
 * Exported for unit tests.
 */
export function extractCommandPaths(command: string): ExtractedCommandPaths {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const paths: string[] = [];
  // cortex#2359 round 7 — the calling command's safe-flag whitelist. Mirrors
  // the headWord extraction main() already performs to decide whether to
  // call checkCommandPaths() at all; recomputed here so this function stays
  // self-contained (its own module-doc "Exported for unit tests" contract).
  const headWord = /^([A-Za-z][A-Za-z0-9_]*)\b/.exec(command)?.[1]?.toLowerCase();
  const flagPolicy = headWord ? COMMAND_FLAG_POLICIES[headWord] : undefined;
  for (let i = 1; i < tokens.length; i++) {
    let tok = tokens[i];
    if (tok === undefined) continue;
    if (tok.startsWith("-")) {
      if (isPathShapedFlagValue(tok)) {
        return {
          paths: null,
          reason:
            `path-shaped value glued to a flag ("${tok.slice(0, 80)}") — cannot safely ` +
            `classify what this flag consumes, denying fail-closed`,
        };
      }
      // cortex#2359 round 7 — the whitelist gate. `flagPolicy` is always
      // defined here in practice (this function only ever runs for a
      // PATH_CHECKED_COMMANDS head word — see checkCommandPaths' call
      // site), but an absent policy fails CLOSED rather than silently
      // skipping the token, matching this whole module's posture.
      if (!flagPolicy) {
        return {
          paths: null,
          reason:
            `unrecognised flag ("${tok.slice(0, 80)}") on a path-reading command with no ` +
            `known flag policy — denying fail-closed`,
        };
      }
      const classified = classifyFlagToken(tok, flagPolicy);
      if (classified.kind === "deny") {
        return {
          paths: null,
          reason:
            `unrecognised flag ("${tok.slice(0, 80)}") on a path-reading command — denying ` +
            `fail-closed (cortex#2359)`,
        };
      }
      if (classified.kind === "safe") continue;
      // "value": a known-safe `--flag=value` long option. Neither of these
      // flags reads a path in the real tool, but the value is still pushed
      // through the SAME candidate-path / containment pipeline as every
      // other argument below (defense in depth, costs nothing).
      tok = classified.value;
    }
    if (
      (tok.startsWith('"') && tok.endsWith('"') && tok.length >= 2) ||
      (tok.startsWith("'") && tok.endsWith("'") && tok.length >= 2)
    ) {
      tok = tok.slice(1, -1);
    }
    if (tok.length === 0) continue;
    if (tok.includes('"') || tok.includes("'")) {
      return {
        paths: null,
        reason:
          `embedded or unbalanced quote character in path argument "${tok.slice(0, 80)}" — ` +
          `cannot safely resolve what the shell would actually run, denying fail-closed`,
      };
    }
    // Round 5 fix: character WHITELIST. Do not try to interpret whatever the
    // offending character means to bash (backslash-escape, or anything
    // else) — a token containing ANY character outside SAFE_PATH_CHAR_RE
    // denies the whole command.
    if (!SAFE_PATH_CHAR_RE.test(tok)) {
      return {
        paths: null,
        reason:
          `unsafe character in path argument "${tok.slice(0, 80)}" (outside the safe ` +
          `character whitelist) — denying fail-closed`,
      };
    }
    paths.push(tok);
  }
  return { paths };
}

/**
 * Containment-check every path argument of a path-checked command against
 * `CORTEX_PATH_GUARD`. Mirrors path-guard.hook.ts's own policy semantics
 * exactly (same parser, same "empty policy = no restriction configured"
 * contract, same fail-closed-on-malformed-config posture) — see that file's
 * module doc for the full rationale.
 *
 * cortex#2343 adversarial review round 3: every raw token reduces to zero
 * or more real paths through {@link reduceTokenToRealPathOrReject} — the
 * ONE shared reducer both this hook and path-guard.hook.ts call. This is
 * what closed the root cause of the R1 (`~user`) and bash-brace-expansion
 * bypasses: those fixes previously lived in divergent, hook-local code, so
 * a fix landing on one surface (e.g. path-guard's Glob branch) left the
 * other (bash-guard's command-path check) open. Exported for unit tests.
 */
export function checkCommandPaths(trimmedCommand: string): { allow: boolean; reason: string } {
  const configResult = parsePathGuardConfig(process.env.CORTEX_PATH_GUARD);
  if (!configResult.ok) {
    return {
      allow: false,
      reason:
        `[Cortex Bash Guard] Blocked "${trimmedCommand.slice(0, 80)}": ${configResult.reason} ` +
        `— denying to stay fail-closed.`,
    };
  }
  const { policy } = configResult;
  if (policy.allowedDirs.length === 0 && policy.readOnlyDirs.length === 0) {
    // No restriction configured for this session — matches the existing
    // security-preamble.ts contract (allDirs.length === 0 ⇒ no restriction).
    return { allow: true, reason: "" };
  }

  const extracted = extractCommandPaths(trimmedCommand);
  if (extracted.paths === null) {
    return {
      allow: false,
      reason: `[Cortex Bash Guard] Blocked "${trimmedCommand.slice(0, 80)}": ${extracted.reason}.`,
    };
  }
  const candidatePaths = extracted.paths;
  const cwd = process.cwd();

  for (const rawPath of candidatePaths) {
    const reduced = reduceTokenToRealPathOrReject(rawPath, cwd);
    if (!reduced.ok) {
      return {
        allow: false,
        reason:
          `[Cortex Bash Guard] Blocked "${trimmedCommand.slice(0, 80)}": ${reduced.reason} ` +
          `— denying to stay fail-closed.`,
      };
    }
    for (const realPath of reduced.reals) {
      const contained =
        policy.allowedDirs.some((d) => isContainedIn(d, realPath)) ||
        policy.readOnlyDirs.some((d) => isContainedIn(d, realPath));
      if (!contained) {
        return {
          allow: false,
          reason:
            `[Cortex Bash Guard] Blocked "${trimmedCommand.slice(0, 80)}": path "${realPath}" ` +
            `resolves outside every configured allowedDirs/readOnlyDirs entry (EBH-1, ` +
            `cortex#2343). Ask the principal to widen allowedDirs if this path is genuinely ` +
            `needed.`,
        };
      }
    }
  }
  return { allow: true, reason: "" };
}

// =============================================================================
// Pass / grant / deny output — Claude Code PreToolUse hook protocol.
//
// Three decisions, three meanings:
//   pass()  — pass-through ({"continue": true}). Defer to Claude Code's normal
//             permission flow. Used by the paths that are out of this guard's
//             scope (non-cortex / CLI-principal / disabled-guard / non-Bash /
//             empty command). NOT an approval: in a restricted default-mode
//             session the normal gate still applies. That is intentional for
//             these paths — they are either already-permissive or not ours.
//   grant() — auto-approve (permissionDecision:"allow"). The STRICT success
//             terminal of the allowlist (cortex#777). Emitted ONLY after a
//             command passed rejectsChaining, matched an allowlist rule for
//             every chained part, and cleared any gh repo-restriction. This is
//             what lets an allowlisted+safe command run in async `--print`
//             dispatch without a "requires approval" prompt.
//   deny()  — permissionDecision:"deny" with a reason that surfaces to the
//             agent and the Cortex→Discord relay.
// =============================================================================

/** Emit the pass-through decision (unchanged contract). Defers to CC's gate. */
function pass(): void {
  console.log(JSON.stringify({ continue: true }));
}

/**
 * Emit Claude Code's structured PreToolUse *auto-approve* decision (cortex#777).
 *
 * This is the allowlist's success terminal. The harness reads
 * `hookSpecificOutput.permissionDecision` — "allow" tells Claude Code to run
 * the tool call WITHOUT prompting, so an allowlisted command actually executes
 * in a restricted async `--print` session instead of stalling on "requires
 * approval".
 *
 * SECURITY INVARIANT: grant() is the strict success terminal. It is reachable
 * ONLY from the end of main() — after rejectsChaining passed, every chained
 * part matched an allowlist rule, and any gh repo-restriction passed. There is
 * no other call site, and every deny-worthy branch returns BEFORE this point.
 */
function grant(reason: string): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: reason,
      },
    }),
  );
}

/**
 * Emit Claude Code's structured PreToolUse *deny* decision. The
 * `permissionDecisionReason` surfaces back to the agent (and the
 * Cortex→Discord relay) — it replaces the old `process.exit(2)` +
 * stderr line, which got swallowed on the way to the principal.
 */
function deny(reason: string): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

// =============================================================================
// Telemetry — emit a `tool.bash.blocked` event into the cc-events pipeline.
// Mirrors event-logger.hook.ts: HTTP POST to the dashboard ingest endpoint as
// primary delivery, JSONL append as fallback/archive. Best-effort — a failure
// here must never affect the deny decision.
// =============================================================================

// Default targets the local dashboard ingest endpoint. Overridable via
// CORTEX_INGEST_URL so tests can point the POST at an ephemeral port instead of
// the hardcoded 8766 (which collides with sibling Bun.serve suites under the
// full test run). Production leaves the env unset → unchanged behaviour.
const INGEST_URL =
  process.env.CORTEX_INGEST_URL ?? "http://localhost:8766/api/events/ingest";
// cortex#1908: single seam for the events buffer root — honors
// CORTEX_EVENTS_DIR, else `~/.claude/events` (byte-identical when unset).
const EVENTS_DIR = eventsDir();
const RAW_DIR = join(EVENTS_DIR, "raw");

/** Shape mirrors `RawEvent` from src/taps/cc-events/hooks/lib/event-types.ts. */
function buildBlockEvent(
  sessionId: string,
  reason: string,
  command: string,
): Record<string, unknown> {
  return {
    event_id: crypto.randomUUID(),
    event_type: EVENT_TYPES.BASH_BLOCKED,
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    // G-2a (cortex#779): read CORTEX_* with a GROVE_* fallback via the shared
    // surface/principal resolvers — same chain the EventLogger hooks use. Since
    // cc-session now SETS the CORTEX_* names (not GROVE_*), reading GROVE_* only
    // would emit undefined channel/agent/network metadata on every block event.
    // GV-2 (cortex#1077): DUAL-WRITE the channel label — canonical
    // `cortex_channel` AND legacy `grove_channel` (retires at v3.0.0). The
    // GROVE_* env fallback inside resolveSurfaceEnv is the cortex#774 shim and
    // is intentionally left intact.
    cortex_channel: resolveSurfaceEnv("CHANNEL"),
    grove_channel: resolveSurfaceEnv("CHANNEL"),
    agent_id: resolveSurfaceEnv("AGENT_ID"),
    agent_name: resolveSurfaceEnv("AGENT_NAME"),
    network_id: resolveSurfaceEnv("NETWORK"),
    source: { hook: "PreToolUse", tool_name: "Bash" },
    payload: {
      reason,
      command_preview: command.slice(0, 200),
      project: resolveSurfaceEnv("PROJECT"),
      entity: resolveSurfaceEnv("ENTITY"),
      // R9 operator→principal rename: CORTEX_PRINCIPAL → GROVE_OPERATOR fallback.
      principal: resolvePrincipalEnv(""),
    },
  };
}

/**
 * Emit the block event. Never throws — telemetry is observability, not a
 * gate. Returns once both the POST attempt and the JSONL append have been
 * tried (each independently best-effort).
 */
async function emitBlockEvent(
  sessionId: string,
  reason: string,
  command: string,
): Promise<void> {
  const event = buildBlockEvent(sessionId, reason, command);

  // Primary: HTTP POST to the dashboard ingest endpoint (500ms cap).
  try {
    await fetch(INGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(500),
    });
  } catch { /* dashboard down / refused — fall through to JSONL */ }

  // Fallback/archive: JSONL append next to the EventLogger's raw events.
  try {
    if (!existsSync(RAW_DIR)) {
      mkdirSync(RAW_DIR, { recursive: true, mode: 0o700 });
    }
    const filePath = join(RAW_DIR, `${sessionId}.jsonl`);
    appendFileSync(filePath, JSON.stringify(event) + "\n");
    chmodSync(filePath, 0o600);
  } catch { /* filesystem unavailable — give up silently */ }
}

async function main(): Promise<void> {
  // Gate 1 — not a cortex session: pass through silently. cc-session sets
  // CORTEX_CHANNEL; GROVE_CHANNEL is the deprecated transition read-fallback
  // (cortex#767/#774). Reading GROVE_ only would mean a real bot session —
  // which now carries CORTEX_CHANNEL, not GROVE_CHANNEL — fails this gate and
  // every allowlisted command falls through to Claude Code's approval prompt.
  if (!resolveSurfaceEnv("CHANNEL")) {
    pass();
    return;
  }

  // Gate 2 — CLI-principal bypass (full trust), guarded so it is CLI-only.
  // cldyo-live (the CLI principal wrapper) sets the agent-id AND disables the
  // guard via CORTEX_BASH_GUARD='{"disabled":true}'. Bot sessions ALSO set the
  // agent-id, but they additionally set a NON-disabled CORTEX_BASH_GUARD
  // (runtime.bashAllowlist). Gating the bypass on the ABSENCE of CORTEX_BASH_GUARD
  // keeps bot sessions out of this short-circuit so they fall through to
  // loadConfig() + grant/deny below (cortex#401). A bare CLI session with an
  // agent-id and no guard config still bypasses, as intended.
  if (resolveSurfaceEnv("AGENT_ID") && !process.env.CORTEX_BASH_GUARD) {
    pass();
    return;
  }


  // Read stdin with timeout (same pattern as SecurityValidator)
  let input: HookInput;
  try {
    const reader = Bun.stdin.stream().getReader();
    let raw = "";
    const readLoop = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += new TextDecoder().decode(value, { stream: true });
      }
    })();
    await Promise.race([readLoop, new Promise<void>((r) => setTimeout(r, 200))]);

    if (!raw.trim()) {
      pass();
      return;
    }
    input = JSON.parse(raw) as HookInput;
  } catch {
    pass();
    return;
  }

  // Only guard Bash commands
  if (input.tool_name !== "Bash") {
    pass();
    return;
  }

  const rawCommand =
    typeof input.tool_input === "string"
      ? input.tool_input
      : input.tool_input.command ?? "";

  const command = stripEnvPrefix(rawCommand).trim();

  if (!command) {
    pass();
    return;
  }

  const sessionId =
    input.session_id ?? process.env.CLAUDE_SESSION_ID ?? "unknown";

  const configResult = loadConfig();

  // cortex#2343 adversarial review round 4 — a PRESENT but malformed
  // CORTEX_BASH_GUARD used to silently fall back to DEFAULT_CONFIG (fail
  // OPEN). Now it's a genuine failure: DENY, matching path-guard.hook.ts's
  // parsePathGuardConfig posture. Absence/empty stays "no config" (handled
  // inside loadConfig() as ok:true, config:DEFAULT_CONFIG) — only a
  // present-but-unparseable value reaches this branch.
  if (!configResult.ok) {
    const reason = `[Cortex Bash Guard] Blocked: ${configResult.reason} — denying to stay fail-closed.`;
    deny(reason);
    await emitBlockEvent(sessionId, reason, command);
    return;
  }

  const config = configResult.config;

  // G-300: Guard disabled (principal DM) — pass through, defer to the already-
  // permissive bypass session. Intentionally NOT a grant: this path is out of
  // the allowlist's scope, and broadening it to auto-approve would be a strictly
  // wider authority than the disabled-guard contract promises (cortex#777).
  if (config === null) {
    pass();
    return;
  }

  // No-bypass guard: refuse shell metacharacters that could smuggle a second
  // command past an allow-prefix (pipes, $( ), backticks, redirects, lone `&`,
  // newlines). Runs BEFORE the allowlist match so it protects every rule. The
  // segment splitter below only neutralises `&& || ;` chains of allowed
  // commands; everything else is denied here.
  //
  // CRITICAL: this checks the RAW command, not the env-stripped one. The shell
  // evaluates an env-assignment prefix value — including command substitution —
  // when building the command's environment, so `X="$(curl evil)" aws sts …`
  // RUNS `curl evil` even though the visible command is an allowed `aws` call.
  // stripEnvPrefix() would launder that `$( )` out of `command` before we look,
  // so the metacharacter scan must see the original input the shell will run.
  if (rejectsChaining(rawCommand)) {
    const reason =
      `[Cortex Bash Guard] Blocked "${rawCommand.slice(0, 80)}": ` +
      `command contains a shell metacharacter (pipe, command substitution, ` +
      `backtick, redirect, background '&', or newline) that could chain a ` +
      `second command. Split it into separate, individually-allowed commands.`;
    deny(reason);
    await emitBlockEvent(sessionId, reason, command);
    return;
  }

  // Handle chained commands: split on && ; || and check each part
  const parts = command.split(/\s*(?:&&|\|\||;)\s*/);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    let matched = false;

    for (const rule of config.rules) {
      try {
        if (new RegExp(rule.pattern, "i").test(trimmed)) {
          // Check repo restriction for gh commands
          if (trimmed.startsWith("gh ")) {
            const repos = rule.repos ?? config.repos ?? [];
            if (repos.length > 0) {
              const repo = extractGhRepo(trimmed);
              // FAIL-CLOSED (cortex#2331 7a review F1): a rule pinned to a repo
              // set but no repo could be extracted (e.g. `gh pr create` with no
              // --repo, cwd-inferred) must DENY — a pin you can silently skip by
              // omitting the flag is not a pin. Rules WITHOUT a `repos`
              // restriction are unaffected (repos.length === 0 skips this block).
              if (!repo) {
                const reason =
                  `[Cortex Bash Guard] Blocked "${trimmed.slice(0, 80)}": ` +
                  `this gh rule is pinned to repo(s) [${repos.join(", ")}] but no ` +
                  `repo could be determined from the command. Pass ` +
                  `--repo owner/name explicitly.`;
                // Write the security decision FIRST — telemetry I/O
                // (a filesystem appendFileSync) must never delay a deny.
                deny(reason);
                await emitBlockEvent(sessionId, reason, command);
                return;
              }
              if (!repos.includes(repo)) {
                const reason =
                  `[Cortex Bash Guard] Blocked "${trimmed.slice(0, 80)}": ` +
                  `repo "${repo}" is not in the allowed repo list ` +
                  `[${repos.join(", ")}].`;
                // Write the security decision FIRST — telemetry I/O
                // (a filesystem appendFileSync) must never delay a deny.
                deny(reason);
                await emitBlockEvent(sessionId, reason, command);
                return;
              }
            }
          }
          matched = true;
          break;
        }
      } catch { /* invalid regex, skip */ }
    }

    if (!matched) {
      const reason =
        `[Cortex Bash Guard] Blocked "${trimmed.slice(0, 80)}": ` +
        `command does not match any rule in the bash allowlist. ` +
        `Ask the principal to widen the allowlist if this command is needed.`;
      // Write the security decision FIRST — telemetry I/O
      // (a filesystem appendFileSync) must never delay a deny.
      deny(reason);
      await emitBlockEvent(sessionId, reason, command);
      return;
    }

    // EBH-1 (cortex#2343 step 3) — path-containment for the read-command
    // rules. Runs AFTER the shape-allowlist match (matched === true), so it
    // only tightens an already-allowed command, never widens one.
    const headWord = /^([A-Za-z][A-Za-z0-9_]*)\b/.exec(trimmed)?.[1]?.toLowerCase();
    if (headWord && PATH_CHECKED_COMMANDS.has(headWord)) {
      const pathCheck = checkCommandPaths(trimmed);
      if (!pathCheck.allow) {
        deny(pathCheck.reason);
        await emitBlockEvent(sessionId, pathCheck.reason, command);
        return;
      }
    }
  }

  // All parts matched, no chaining metacharacters, repo-restriction (if any)
  // cleared — this is the STRICT success terminal. Auto-approve so the
  // allowlisted+safe command runs in async dispatch without a "requires
  // approval" prompt (cortex#777). Every deny-worthy branch returned above.
  grant(
    "[Cortex Bash Guard] Auto-approved: command matches the bash allowlist " +
      "and contains no chaining metacharacters.",
  );
}

main().catch(() => {
  // Fail open to Claude Code's normal permission gate (pass-through), NOT to an
  // auto-approve. An unexpected error must never silently grant.
  pass();
});
