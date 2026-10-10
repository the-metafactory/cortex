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
 * ## Known limitations (cortex#2343/#2359/#2365/#2370 adversarial review, 9 rounds)
 *
 * This guard inspects the command STRING, not a real shell parse tree — it
 * is a best-effort classifier against bash's word-evaluation rules and each
 * path-checked command's own path-reading behavior, not a formal shell
 * parser. Nine adversarial rounds each found ONE way the guard's literal-
 * token resolution diverged from what bash/the tool would actually read
 * (tilde-user expansion, brace expansion, quote-removal, backslash-escaping,
 * flag-glued path values, bare-relative flag-value coverage, a whole
 * PATH_CHECKED_COMMANDS coverage gap, TWICE) — the fix each time was to FAIL
 * CLOSED on whatever couldn't be confidently classified/resolved, culminating
 * in round 5's character whitelist (deny anything outside a closed safe
 * set), round 6's flag-value SHAPE classification (deny anything
 * `-`-prefixed that looks path-shaped), round 7's per-command flag-name
 * WHITELIST (deny anything `-`-prefixed that isn't an explicitly-modeled
 * boolean/numeric flag for that command — see `COMMAND_FLAG_POLICIES`),
 * round 8 (cortex#2365) adding `git` to `PATH_CHECKED_COMMANDS`/
 * `COMMAND_FLAG_POLICIES` — `git diff --no-index` is a standalone diff
 * utility that needs no repository and ignores git's own repo-boundary
 * checks, so it was a live full-content-read primitive on any two paths
 * while `git` sat outside the containment-checked command set entirely —
 * plus fixing a round-7 regression where a bare `--` (the POSIX
 * end-of-options marker) was misclassified as an unrecognised flag and
 * denied the whole command; it now correctly stops flag classification and
 * containment-checks every token after it as a literal path. Round 9
 * (cortex#2370, EBH-1e) found the SAME coverage gap a third time — `gh` was
 * permitted by the floor but absent from `PATH_CHECKED_COMMANDS`, so
 * `gh pr comment 1 --body-file <out-of-scope>` read an arbitrary file and
 * POSTED IT TO GITHUB (remote exfiltration, worse than a local read) — and
 * closed the whole CLASS rather than the one instance: `PATH_CHECKED_COMMANDS`
 * is no longer a hand-maintained opt-IN list (the root cause all three
 * rounds share) but a computed opt-OUT one — every command head word
 * `DEFAULT_CONFIG`'s floor permits is path-checked by default, with only a
 * small justified `PATH_CHECK_OPT_OUT_COMMANDS` exemption set, and a command
 * that is neither opted out nor carries a `COMMAND_FLAG_POLICIES` entry now
 * fails CLOSED (`checkCommandPaths` denies it outright) instead of silently
 * skipping the check. A regression test derives the floor's command list
 * from `DEFAULT_CONFIG.rules` itself and fails if any of them lacks a policy
 * or an opt-out — see `bash-guard.hook.test.ts`'s "round 9" describe block —
 * so widening the floor with a rule of the SUPPORTED pattern shape (see
 * `deriveFloorCommandHeadWords`) without declaring the new command's path
 * posture is a CI failure, not a silent bypass. That guarantee is scoped to
 * the supported shape: `deriveFloorCommandHeadWords` only understands an
 * anchored `^` + plain word + `\b`/`\s`/`$` boundary; a floor rule of ANY
 * other shape (alternation, a character class, a leading `\s*`, an optional
 * suffix like `s?`, …) THROWS at module load (EBH-1f, cortex#2374) rather
 * than silently deriving nothing or the wrong word — the round-9 coverage
 * test above shares the same derivation and so shares the same scope: it
 * protects supported-shape rules; unsupported shapes now hard-fail the
 * build instead of passing it silently. That two-part posture — fail
 * closed on ambiguity, on coverage gaps, AND on an unparseable floor rule
 * — is what makes this guard SAFE, but it is NOT airtight by construction
 * the way a real parser + kernel boundary would be. The kernel sandbox
 * (L2, EBH-2/EBH-3, `docs/design-session-sandbox.md`) is the actual
 * boundary; this guard is Tier-0 defense-in-depth in front of it.
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
 *   - `echo <glob>` glob-expands BEFORE the guard ever sees the exec (bash
 *     performs pathname expansion on the argument as part of building
 *     `argv`, prior to the shell invoking `echo` at all) — `echo
 *     /outside/*` enumerates out-of-scope FILENAMES (directory listing
 *     leakage), never file CONTENTS. Low-severity, accepted residual
 *     (cortex#2365 finding 3) — not chased further, same over-deny-not-
 *     under-deny direction as the rest of this list.
 *
 * ## Guard-off (G-300, principal DM) posture — EBH-1g, cortex#2377
 *
 * DECIDED (principal, 2026-07-25, option (b) of the EBH-6/F4 investigation,
 * `docs/security/ebh-6-posture-findings.md` §F4): a guard-off session
 * (`CORTEX_BASH_GUARD={"disabled":true}`) SKIPS the command-shape allowlist
 * entirely — the principal may still run ANY command, unchanged — but now
 * runs the SAME rounds 7-9 path-containment machinery (`checkCommandPaths`/
 * `extractCommandPaths` in `"lenient"` mode) before deferring to Claude
 * Code's own permission gate. Before this fix, `config === null` returned
 * `pass()` immediately: Bash had ZERO cortex-owned protection in a guard-off
 * session, even though the file tools (Read/Write/Edit/Glob/Grep/
 * NotebookEdit, via the separate `path-guard.hook.ts`) were already
 * containment-checked in the very same sessions (EBH-1). What is now
 * protected, and what is not:
 *   - PROTECTED: an out-of-scope path argument on ANY command — still
 *     denies. `cat`/`head`/`tail`/`wc`/`ls`/`file` (single, non-subcommand
 *     tools with a small, STABLE, exhaustively-modeled flag surface) keep
 *     the exact strict round 7 flag classification, so `file -flist` stays
 *     closed. `git`/`gh` are exempted from strict classification in
 *     guard-off mode (see `SUBCOMMAND_SCOPED_FLAG_POLICIES` — their
 *     `COMMAND_FLAG_POLICIES` entries only ever modeled the floor's narrow
 *     read-only subcommands, so enforcing them strictly against an
 *     arbitrary guard-off invocation denied ordinary usage like
 *     `git commit -m`/`git push -u`/`gh pr create -t`); their round 8/9
 *     findings (`git diff --no-index <path> <path>`, `gh … --body-file`)
 *     still close via `isPathShapedFlagValue` (unconditional in both
 *     modes) and the generic bareword-argument fallthrough, neither of
 *     which the exemption touches. Every other (fully uncatalogued)
 *     command uses the same lenient heuristic: a `-`-prefixed token that
 *     doesn't itself look path-shaped is trusted as a non-path flag and
 *     skipped, rather than denying the whole command for lacking a
 *     cataloged policy — denying it would defeat G-300's entire purpose.
 *   - ALLOWED, and containment-checked per segment: `|` pipes. A pipeline is
 *     just more segments — `cat f.txt | wc -l` splits into "cat f.txt" and
 *     "wc -l" the exact same way `&&`/`||`/`;` chains already did, and each
 *     segment is containment-checked independently (see the `main()`
 *     guard-off segment split, which now also splits on a bare `|`).
 *     Everyday principal-DM commands like `cat x | wc -l` or
 *     `git log --oneline | head` are unaffected. This is deliberately
 *     asymmetric with guard-ON, where a bare pipe is STILL denied by
 *     `rejectsChaining()`'s default call (no options) — there, a pipe could
 *     smuggle a command past the command-SHAPE allowlist the RHS is never
 *     matched against; in guard-off there is no shape-allowlist to smuggle
 *     past (G-300 permits any command already), so denying a pipe bought no
 *     containment once each side is independently checked. `cat
 *     <out-of-scope> | wc -l` still denies (the "cat" segment fails
 *     containment).
 *   - STILL PROTECTED (genuinely, not just for symmetry):
 *     command-substitution/backticks/redirects/background `&`/newlines —
 *     `rejectsChaining()` still runs in guard-off mode (with
 *     `allowPipes: true`) for these. Command substitution (`$(...)`,
 *     backticks) computes its argument at RUN time — this guard only ever
 *     sees the command STRING, so a substituted path can never be
 *     containment-checked ahead of execution. A redirect (`<`/`>`) reads
 *     from or writes to a target this guard never extracts as a "path
 *     argument" at all (the tokenizer only inspects the command's own
 *     argv-shaped tokens). Both genuinely defeat static path analysis, so
 *     denying them is real containment, not friction — this is the one
 *     narrow, deliberate capability reduction relative to pre-EBH-1g: a
 *     guard-off session can no longer use `` ` ``/`$()`/`<`/`>`/background
 *     `&`/newline in a single Bash call. `&&`/`||`/`;`/`|`-joined SIMPLE
 *     commands are fully unaffected.
 *   - PROTECTED: the trigger itself cannot be forged — guard-off is keyed
 *     to the platform's own authenticated sender id, resolved per-message;
 *     no traced producer (bus dispatch, GitHub webhook relay, web gateway,
 *     `async:`/`team:`) can induce it for content it didn't itself author
 *     as the mapped principal (§F4 investigation).
 *   - NOT PROTECTED (residual, matches the file-tool surface's own
 *     limitations above, applied to Bash): TOCTOU, a scripting language
 *     invoked via Bash reading a path from WITHIN its own script text
 *     (e.g. `python -c "open('/etc/passwd')"` — the guard sees a string
 *     literal, not a file open), and — the one thing this fix does NOT
 *     change — how BROAD the configured `allowedDirs` actually is for a
 *     DM session. `allowedDirs` is resolved identically for DM and
 *     non-DM sessions (`access.dirRestrictions ?? networkClaude.allowedDirs
 *     ?? config.claude.allowedDirs`, `dispatch-handler.ts`) unless the
 *     principal explicitly widens it via `session_config.dm.allowed_dirs`
 *     — containment is only as narrow as that configured value; a
 *     deployment that leaves it broad (or unset) gets correspondingly
 *     little from this fix, by design, matching the "empty policy = no
 *     restriction" contract every cortex-owned guard shares.
 *   - The L2 sandbox (EBH-2/EBH-3, `docs/design-session-sandbox.md`) is
 *     still the actual boundary that makes this moot regardless of the L1
 *     posture chosen here — see that doc for the un-bypassable remedy.
 *
 * ## EBH-1h — bare numeric short flags (cortex#2384)
 *
 * A pre-existing round-7 gap, surfaced by the EBH-1g work: `head`/`tail`
 * accept a bare numeric short flag (`head -5` == `head -n 5`) that
 * `COMMAND_FLAG_POLICIES` never modeled, so — since round 9's "unrecognised
 * flag on a path-checked command denies the whole command" posture — ordinary
 * `head -5 f.txt` / `tail -3 f.txt` were wrongly denied (over-deny, not a
 * bypass, but everyday friction). Fixed by a new, narrowly-scoped
 * `CommandFlagPolicy.bareNumericCount` flag, set ONLY on `head`'s and
 * `tail`'s policy entries: `classifyFlagToken` now recognises a token
 * matching `^-\d+$` as a safe numeric-count flag for those two commands
 * specifically (see that function and the flag's own doc comment) — never
 * captured as a candidate path, and never generalised to any other
 * path-checked command (`ls -5` / `cat -5` remain denied exactly as before).
 *
 * ## Round 10 — free-text value flags misclassified as paths (cortex#2493)
 *
 * Round 9's `gh` policy modeled `-t`/`--title`, `-b`/`--body`, `-F`/
 * `--body-file` all as ordinary `shortValue`/`longValue` (path-pipeline)
 * flags — the module doc even said so explicitly ("free text, not a path,
 * but costs nothing to route through containment"). That assumption was
 * wrong: `classifyFlagToken` only classifies the FLAG token itself as
 * "safe"; it does not consume the flag's value. For the space-separated
 * form (`--title "some text"`), the value is a SEPARATE token that the
 * classifier never sees — it falls through to the generic bareword-argument
 * handler below, which treats every non-flag token as a path CANDIDATE and
 * denies it via `reduceTokenToRealPathOrReject` when no such file exists.
 * For the `=`-glued form (`--title=some text`), the value WAS routed through
 * the same candidate-path pipeline (`classified.kind === "value"`) and hit
 * the same fate. Net effect: a guarded agent could not file or comment on a
 * GitHub issue at all — any human-readable title or body denied the whole
 * command.
 *
 * Fixed by splitting "value is consumed but is free text" from "value is a
 * path" into its own policy dimension — {@link CommandFlagPolicy.longTextValue}
 * / {@link CommandFlagPolicy.shortTextValue} — with `title`/`body` (both
 * flag forms) moved there. A text-value flag never enters the candidate-path
 * pipeline at all: for the `--flag=value` / glued-short form the value lives
 * in the SAME token, which the classifier now returns as fully "safe"
 * (skipped, not path-checked); for the space-separated form, classification
 * additionally signals the token loop in `extractCommandPaths` to skip the
 * IMMEDIATELY FOLLOWING token outright — never quote-stripped, character-
 * whitelisted, or pushed onto `paths`. `-F`/`--body-file` is deliberately
 * NOT moved — it stays on `shortValue`/`longValue` exactly as round 9 left
 * it, because it genuinely reads a local file and POSTs its contents to
 * GitHub (the live remote-exfil finding round 9 closed); weakening its path
 * containment would reopen that finding. See the round-9 tests
 * (`gh pr comment 1 --body-file <out-of-scope> ⇒ DENY`) and the new round-10
 * tests below, which assert both properties together: a prose title/body is
 * ALLOWED (in both flag forms) while an out-of-scope `--body-file` is still
 * DENIED.
 *
 * Audit for the same class elsewhere (cortex#2493's own suggestion): the
 * only OTHER path-checked command with a value-taking flag at all is `git`
 * (`-n`/`-C`/`--git-dir`/`--work-tree`, all genuinely path/ref arguments,
 * not prose) — no collateral there. `git commit -m` (the issue's suggested
 * candidate) is not reachable through this bug: `commit` is not one of
 * `DEFAULT_CONFIG`'s floor-permitted git subcommands
 * (`log|diff|show|status|branch|fetch|remote|rev-parse`), so a normal guarded
 * session never reaches `checkCommandPaths` for it — the command-shape
 * allowlist denies it first, for an unrelated reason. It IS reachable in a
 * guard-off (G-300) session, but through a DIFFERENT mechanism:
 * `SUBCOMMAND_SCOPED_FLAG_POLICIES` exempts `git`/`gh` from
 * `COMMAND_FLAG_POLICIES` entirely in lenient mode, so `-m`'s value falls
 * through to the same generic bareword handler regardless of any
 * `longTextValue`/`shortTextValue` entry on `git`'s policy (which lenient
 * mode never consults for git/gh) — fixing it requires a lenient-mode-
 * specific mechanism, not this round's one-line policy-set change, so it is
 * OUT OF SCOPE here and tracked as a follow-up rather than folded into this
 * fix.
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

// Exported (read-only in practice — see AllowRule) so tests can assert
// against the REAL floor patterns directly, e.g. the EBH-1f (cortex#2374)
// independent shape test that hard-codes an expected head word per pattern
// WITHOUT calling deriveFloorCommandHeadWords, so it cannot share that
// function's blind spot.
export const DEFAULT_CONFIG: GuardConfig = {
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
 *
 * `opts.allowPipes` (EBH-1g, cortex#2377) — used ONLY by `main()`'s guard-off
 * (G-300) branch, never by the normal/guard-on call site (which always calls
 * this with no options — behaviour there is BYTE-IDENTICAL to before EBH-1g).
 * The reasoning that makes a bare `|` dangerous in the guard-ON path is
 * specific to that path: the RHS of a pipe is a command the SHAPE-allowlist
 * matcher never inspects, so a pipe could smuggle an arbitrary command past
 * an allowed prefix (`ls | rm -rf /`). In a guard-OFF session there is no
 * shape-allowlist to smuggle past — ANY command is already permitted by
 * design (G-300) — so a pipe carries no privilege a segment-split command
 * doesn't already have. What still matters in guard-off mode is PATH
 * CONTAINMENT, and a pipeline decomposes into simple-command segments the
 * exact same way `&&`/`||`/`;` already do (see `main()`'s guard-off segment
 * split) — so `allowPipes` skips ONLY the bare-pipe check below; every other
 * check (subst, backticks, redirects, background `&`, newline) is
 * unconditional in BOTH modes. Command substitution and redirects stay
 * denied even with `allowPipes` because they genuinely defeat static path
 * analysis — a substituted path is computed at RUN time (this guard only
 * ever sees the command STRING), and a redirect can write to or read from a
 * target this guard never extracts as a "path argument" at all. Denying
 * those is real containment; denying a bare pipe bought none once segments
 * are containment-checked independently.
 */
function rejectsChaining(command: string, opts?: { allowPipes?: boolean }): boolean {
  // Newline (any flavour) → a second command line.
  if (/[\r\n]/.test(command)) return true;
  // Command substitution `$(` (covers `$(( ))` too) and backticks.
  if (command.includes("$(")) return true;
  if (command.includes("`")) return true;
  // Redirection — can clobber files or read secrets.
  if (/[<>]/.test(command)) return true;
  if (!opts?.allowPipes) {
    // A single pipe `|` that is NOT one half of the `||` chain token. We
    // collapse every `||` to a placeholder first, then look for a remaining
    // `|`.
    if (command.replace(/\|\|/g, "").includes("|")) return true;
  }
  // A single `&` that is NOT part of the `&&` chain token (i.e. background
  // / job-control). Same collapse trick. NOTE: this also still denies `|&`
  // (bash's pipe-with-stderr shorthand) even when allowPipes is set — `|&`
  // contains a lone `&` once `&&` is collapsed out, so it is caught here
  // regardless. Accepted: `|&` is rare, and denying it is the safe
  // direction, same as everywhere else in this function.
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

/**
 * cortex#2370 (EBH-1e, round 9) — INVERT the coverage model from opt-IN to
 * opt-OUT. Rounds 7 (`file`, cortex#2359), 8 (`git`, cortex#2365), and 9
 * (`gh`, this issue) each found a DIFFERENT command silently missing from
 * this set — the opt-in model itself was the standing defect: every command
 * added to `DEFAULT_CONFIG`'s floor was silently EXEMPT from path/flag
 * checking until someone remembered to add it here by hand. Three rounds of
 * the exact same mistake is a pattern in the MODEL, not a coincidence in the
 * instances.
 *
 * The new model: every command head word `DEFAULT_CONFIG`'s own floor rules
 * permit is path-checked by DEFAULT — {@link FLOOR_COMMAND_HEAD_WORDS} is
 * derived PROGRAMMATICALLY from those rules (never hand-maintained, so it
 * cannot drift from what the floor actually allows). A command is exempted
 * ONLY via the small, explicitly-justified
 * {@link PATH_CHECK_OPT_OUT_COMMANDS} set below. Anything neither opted out
 * NOR carrying a {@link COMMAND_FLAG_POLICIES} entry fails CLOSED —
 * `checkCommandPaths` denies it outright once a restriction is configured,
 * rather than silently skipping it (see the flagPolicy-presence check
 * there).
 *
 * `bash-guard.hook.test.ts`'s "round 9: floor coverage" describe block is
 * the regression test that makes a round 10 of this class impossible: it
 * derives the same command list from the SAME live `DEFAULT_CONFIG.rules`
 * this module ships and fails if any of them is neither opted out nor
 * flag-policied — so widening the floor with a rule of the shape this
 * derivation supports, without declaring the new command's path posture,
 * is a CI failure.
 *
 * That guarantee is scoped to the shape `deriveFloorCommandHeadWords` can
 * parse (EBH-1f, cortex#2374 — adversarial review of this very function):
 * derivation used to match ONLY `^plainword` and silently return NOTHING
 * for any other legal rule shape — `^(cat|less)\b`, `^[Cc]at\b`, and
 * `^\s*cat\b` each derived no word at all (both exempting their command
 * from path-checking with zero signal), and `^cats?\b` derived the WRONG
 * word ("cats") while the real runtime head word ("cat") stayed
 * unchecked. Because a word missing from `FLOOR_COMMAND_HEAD_WORDS` never
 * enters `PATH_CHECKED_COMMANDS`, and the runtime gate is `if (headWord &&
 * PATH_CHECKED_COMMANDS.has(headWord))`, that was a SILENT FULL BYPASS —
 * `checkCommandPaths` was never even called — not a fail-closed deny. The
 * round-9 coverage test could not catch it either: it derives its own
 * "ground truth" via this same function, so it shares the blind spot.
 * `deriveFloorCommandHeadWords` now parses a narrow, PRECISELY-checked
 * shape and THROWS (at module load, since `FLOOR_COMMAND_HEAD_WORDS` below
 * calls it eagerly) for any pattern it cannot confidently reduce to a
 * single head word — see the shape regex and its comment just below. An
 * independent test in `bash-guard.hook.test.ts` (the "EBH-1f: floor rule
 * shape hardening" describe block) hard-codes the expected word for every
 * `DEFAULT_CONFIG` pattern WITHOUT calling this function, so it cannot
 * share this function's blind spot and will fail if a pattern's shape
 * changes unexpectedly.
 */
const SUPPORTED_FLOOR_RULE_SHAPE = /^\^([A-Za-z][A-Za-z0-9_]*)(?:\\b|\\s|\$)/;

export function deriveFloorCommandHeadWords(rules: readonly AllowRule[]): Set<string> {
  const words = new Set<string>();
  for (const rule of rules) {
    // Every DEFAULT_CONFIG pattern is anchored `^<command>` followed by a
    // `\s`/`\b`/`$` boundary (see DEFAULT_CONFIG above) — the same shape
    // main()/extractCommandPaths already assume when reading a COMMAND
    // string's head word, applied here to a RULE PATTERN string instead.
    // This parses the pattern's SOURCE TEXT (it does not compile/execute
    // the pattern as a regex) — `SUPPORTED_FLOOR_RULE_SHAPE` requires the
    // captured identifier to be IMMEDIATELY followed by one of the three
    // literal boundary forms above; the regex engine backtracks the greedy
    // identifier match, so a shape like `^cats?\b` (where "cats" is
    // followed by "?", "cat" by "s", "ca" by "t", … — none a boundary)
    // fails to match ANY prefix rather than settling for the wrong one.
    const m = SUPPORTED_FLOOR_RULE_SHAPE.exec(rule.pattern);
    if (!m?.[1]) {
      // FAIL LOUD, not silent. A rule this parser cannot confidently
      // reduce to a single head word must never be treated as
      // contributing NO word — that is exactly how `^(cat|less)\b`,
      // `^[Cc]at\b`, and `^\s*cat\b` each silently exempted their command
      // from path-checking (EBH-1f, cortex#2374). Throwing at module load
      // turns an unparseable floor rule into a build/boot failure instead
      // of a silent exemption.
      throw new Error(
        // NOTE: the pattern is interpolated RAW (not JSON.stringify'd) so
        // its literal backslashes appear in the message exactly as they do
        // in the source rule — JSON.stringify would double-escape them
        // (`\b` → `\\b` in the JSON text), which is confusing to read and
        // awkward for a caller/test to substring-match against the pattern
        // it passed in.
        `[Cortex Bash Guard] deriveFloorCommandHeadWords: floor rule pattern ` +
          `"${rule.pattern}" does not match the supported shape ` +
          `(anchored "^" + a plain command word + one of \\b / \\s / $ as the ` +
          `next literal characters). An unparseable floor rule must not ` +
          `silently exempt its command from path-checking — rewrite the ` +
          `pattern to the supported shape, or extend this parser (and its ` +
          `independent, non-re-derived shape test in bash-guard.hook.test.ts) ` +
          `to cover the new shape before shipping it.`,
      );
    }
    words.add(m[1].toLowerCase());
  }
  return words;
}

/** The command head words `DEFAULT_CONFIG`'s floor currently permits —
 *  computed, never hand-maintained (see the module doc above this block). */
export const FLOOR_COMMAND_HEAD_WORDS = deriveFloorCommandHeadWords(DEFAULT_CONFIG.rules);

/**
 * Commands PROVEN not to take a path argument at all — the only legitimate
 * way to skip path/flag checking entirely under the opt-out model above.
 * Each entry carries a one-line justification; this set must stay SMALL —
 * every addition is a claim that has to hold for every invocation shape the
 * floor's own rule for that command permits.
 */
export const PATH_CHECK_OPT_OUT_COMMANDS = new Set<string>([
  "pwd", // POSIX pwd takes no operand at all — nothing to check.
  "echo", // Prints its argv verbatim; never opens/reads a file by path.
  "which", // Searches $PATH for a command NAME; never reads file content.
]);

/**
 * Bash read commands whose path argument(s) get containment-checked — every
 * floor command word EXCEPT the explicit opt-outs above.
 *
 * `git` was added at round 8 (cortex#2365 finding 1) — it was allowed by
 * `DEFAULT_CONFIG`'s `^git\s+(log|diff|show|status|branch|fetch|remote|
 * rev-parse)\b` shape rule but absent here, so its arguments were NEVER
 * containment-checked. `git diff --no-index` is a standalone diff utility
 * that needs no repository and is not subject to git's own repo-boundary
 * checks (unlike `git show <rev>:<path>` / `git log -- <path>`, which git
 * itself refuses with "outside repository") — it will diff ANY two
 * readable paths and print full file contents. See `COMMAND_FLAG_POLICIES.
 * git` for how its flags are modeled.
 *
 * `gh` was added at round 9 (cortex#2370) — the SAME gap, a third time. See
 * `COMMAND_FLAG_POLICIES.gh` for how its flags (including the `--body-file`
 * exfil vector) are modeled.
 */
const PATH_CHECKED_COMMANDS = new Set(
  [...FLOOR_COMMAND_HEAD_WORDS].filter((word) => !PATH_CHECK_OPT_OUT_COMMANDS.has(word)),
);

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
  /**
   * Round 10 (cortex#2493) — long-flag names whose value is CONSUMED (both
   * `--flag value` space-separated and `--flag=value` glued forms) but is
   * FREE TEXT, never a path: the value is never checked against the
   * candidate-path/containment pipeline at all. Distinct from `longValue`
   * (whose value, though also never a real path for the flags whitelisted
   * there, is STILL routed through containment as defense-in-depth). A flag
   * belongs here only when routing its value through containment would
   * itself be the bug — i.e. when the value is expected to be arbitrary
   * human prose that will almost never resolve to an existing file
   * (`gh issue create --title "…"`/`--body "…"`), so containment-checking
   * it produces a false "no such file" deny instead of any real security
   * benefit. NEVER add a flag here that reads its value from disk — for
   * those (e.g. `--body-file`), keep it on `longValue`/`shortValue` so the
   * value stays containment-checked.
   */
  longTextValue: ReadonlySet<string>;
  /**
   * Round 10 (cortex#2493) — the short-flag equivalent of `longTextValue`:
   * single-char flags (`-t`, `-b`) whose value is consumed but is free text,
   * never a path, and so never enters the candidate-path pipeline. Same
   * caveat as `longTextValue`: a flag that reads its value from disk (`-F`)
   * must stay on `shortValue`, never move here.
   */
  shortTextValue: ReadonlySet<string>;
  /**
   * EBH-1h (cortex#2384) — when true, a BARE NUMERIC short flag (a token
   * matching `^-\d+$`, e.g. `-5`, `-20`) is classified as a numeric COUNT
   * flag: safe, and — same as any other classified-safe flag — NOT captured
   * as a candidate path. Modeled ONLY for `head`/`tail` (see their policy
   * entries below): they are the two POSIX commands whose short-option
   * grammar accepts a bare count as shorthand for `-n <count>` (`head -5` ==
   * `head -n 5`). `COMMAND_FLAG_POLICIES` never modeled this shorthand, and
   * since round 9 (cortex#2370) an unrecognised flag on a path-checked
   * command denies the WHOLE command — so `head -5 f.txt` / `tail -3 f.txt`
   * were denied outright even though they're ordinary, safe, everyday usage
   * (not a security hole: fails safe, over-deny not under-deny — but
   * friction real enough to train people to widen the allowlist or turn the
   * guard off). Deliberately narrow and opt-in per command, not a global
   * `^-\d+$` carve-out: `ls`/`cat`/`wc`/`file`/`git`/`gh` have no such
   * shorthand in their own flag grammars, so a bare `-5` there stays exactly
   * as unrecognised (and denied) as it was before this fix.
   */
  bareNumericCount?: boolean;
}

export const COMMAND_FLAG_POLICIES: Readonly<Record<string, CommandFlagPolicy>> = {
  cat: {
    shortBoolean: new Set(["n", "b", "s", "v", "e", "t", "A", "E", "T"]),
    shortValue: new Set(),
    shortTextValue: new Set(),
    longBoolean: new Set(),
    longValue: new Set(),
    longTextValue: new Set(),
  },
  head: {
    shortBoolean: new Set(["q", "v"]),
    shortValue: new Set(["n", "c"]),
    shortTextValue: new Set(),
    longBoolean: new Set(),
    longValue: new Set(["lines", "bytes"]),
    longTextValue: new Set(),
    // EBH-1h (cortex#2384) — `head -5` is POSIX shorthand for `head -n 5`.
    bareNumericCount: true,
  },
  tail: {
    shortBoolean: new Set(["q", "v", "f"]),
    shortValue: new Set(["n", "c"]),
    shortTextValue: new Set(),
    longBoolean: new Set(["follow"]),
    longValue: new Set(["lines", "bytes"]),
    longTextValue: new Set(),
    // EBH-1h (cortex#2384) — `tail -3` is POSIX shorthand for `tail -n 3`.
    bareNumericCount: true,
  },
  ls: {
    shortBoolean: new Set(["l", "a", "A", "h", "R", "t", "r", "S", "1", "d", "F", "G"]),
    shortValue: new Set(),
    shortTextValue: new Set(),
    longBoolean: new Set(),
    // `--color` (bare, or `--color=auto|always|never`) — no path value.
    longValue: new Set(["color"]),
    longTextValue: new Set(),
  },
  wc: {
    // Deliberately NO longBoolean/longValue entries — `--files0-from` (the
    // live bypass this round closes) is NOT on this list, on purpose.
    shortBoolean: new Set(["l", "w", "c", "m", "L"]),
    shortValue: new Set(),
    shortTextValue: new Set(),
    longBoolean: new Set(),
    longValue: new Set(),
    longTextValue: new Set(),
  },
  file: {
    shortBoolean: new Set(["b", "i", "L", "h", "z"]),
    shortValue: new Set(),
    shortTextValue: new Set(),
    longBoolean: new Set(["mime-type", "mime-encoding"]),
    // `-f`/`--files-from` are deliberately ABSENT — that's the bypass this
    // round closes. `color` is not a real `file` flag, but accepting it as
    // a value-flag costs nothing (it never reads a path either) and matches
    // this guard's own pre-existing test matrix for "an `=`-flag with a
    // non-path value must not be denied".
    longValue: new Set(["color"]),
    longTextValue: new Set(),
  },
  // cortex#2365 (EBH-1d, round 8) — `git` joins PATH_CHECKED_COMMANDS. The
  // whitelisted subcommands (log|diff|show|status|branch|fetch|remote|
  // rev-parse — see DEFAULT_CONFIG) all take REVS/refs as positional
  // arguments (`HEAD`, `HEAD~1`, a branch name, a commit SHA) — these never
  // start with "-", so they are never classified as flags here at all; they
  // flow through the generic non-flag candidate-path fallthrough below like
  // any other bareword argument (harmless — they resolve relative to cwd,
  // which is itself inside the session's allowedDirs).
  git: {
    shortBoolean: new Set(),
    // "-n <num>" (`git log -n 5`) — separate-token numeric value; handled
    // by the same generic fallthrough as any other shortValue flag (the
    // NEXT token isn't `-`-prefixed, so it's captured as a candidate path
    // automatically — see extractCommandPaths).
    //
    // "-C <dir>" is git's OWN repo-redirect flag — it relocates git's root
    // the same way `--git-dir`/`--work-tree` below do. Modeled as
    // shortValue (NOT boolean, and NOT silently skipped) so its value
    // token is ALWAYS captured by the same generic fallthrough and
    // containment-checked like any other argument — an out-of-scope
    // `git -C /outside status` denies via containment (on top of already
    // failing DEFAULT_CONFIG's shape rule, since `-C` precedes the
    // subcommand there). A glued form (`-C/outside`) is denied outright,
    // earlier, by `isPathShapedFlagValue` (contains "/").
    shortValue: new Set(["n", "C"]),
    // Round 10 (cortex#2493) audit: no floor-permitted git subcommand
    // (log|diff|show|status|branch|fetch|remote|rev-parse) has a prose-
    // valued short flag comparable to `gh`'s `-t`/`-b` — `git commit -m` is
    // the closest analog, but `commit` isn't in the floor at all (see the
    // round-10 module-doc note above for why it's a follow-up, not a fix
    // here).
    shortTextValue: new Set(),
    // Common read-only long flags for log/diff/status output shaping. None
    // of these read a path as their value.
    longBoolean: new Set(["oneline", "stat", "name-only"]),
    // "--git-dir"/"--work-tree" relocate git's root the same way `-C`
    // does. Deliberately WHITELISTED (not silently denied by omission) so
    // the value routes through the SAME containment pipeline `-C` uses: a
    // bare `--git-dir <dir>` (no `=`) is captured by the generic non-flag
    // fallthrough and containment-checked; a `--git-dir=<dir>` glued value
    // containing "/" is caught earlier by `isPathShapedFlagValue` and
    // denied outright (this guard's universal posture for any `=`-glued
    // path-shaped flag value, same as every other path-checked command).
    // Either way, an out-of-scope target denies — it can never silently
    // relocate git's root past the containment check.
    longValue: new Set(["git-dir", "work-tree"]),
    longTextValue: new Set(),
    // "--no-index" is DELIBERATELY ABSENT from every set above — this is
    // the round-8 fix itself (cortex#2365 finding 1). `git diff --no-index`
    // is a pure read-arbitrary-files primitive: a standalone diff utility
    // that needs no repository and ignores git's own repo-boundary checks,
    // with no legitimate use for a confined agent. Omission means
    // `classifyFlagToken` denies it BY CONSTRUCTION — the same
    // "enumerate only the safe ones" discipline as every other command's
    // policy, not a special-cased blacklist entry.
  },
  // cortex#2370 (EBH-1e, round 9) — `gh` joins the checked set. Its
  // `pr comment`/`issue comment` subcommands (both allowed by
  // DEFAULT_CONFIG's floor) accept `-F`/`--body-file <path>`, which reads an
  // arbitrary local file and POSTS ITS CONTENTS TO GITHUB — a live, verified
  // REMOTE-exfiltration primitive (worse than a local read: the data leaves
  // the machine and lands somewhere persistent/potentially public). `gh` was
  // permitted by the floor (`^gh\s+pr\s+(view|list|diff|checks|status|
  // comment)\b`, `^gh\s+issue\s+(view|list|status|comment)\b`, `^gh\s+repo\s+
  // view\b`) but absent from the (then opt-in) PATH_CHECKED_COMMANDS, so its
  // arguments were NEVER containment-checked — `gh pr comment 1 --body-file
  // <out-of-scope>` verified live on `main`.
  //
  // `-F`/`--body-file` are DELIBERATELY MODELED here (as shortValue/
  // longValue, NOT boolean and NOT omitted) so the value is pushed through
  // the SAME candidate-path/containment pipeline every other value flag
  // uses — same discipline as git's `-C`/`--git-dir` at round 8. An
  // in-scope body file still works (containment-checked, not blanket-
  // denied); an out-of-scope one denies via containment, not via a
  // blanket ban on the flag itself.
  //
  // Round 10 (cortex#2493) — `-t`/`--title` and `-b`/`--body` moved OFF
  // `shortValue`/`longValue` and onto `shortTextValue`/`longTextValue`
  // below. Round 9's comment on `-b` ("free text, not a path, but costs
  // nothing to route through containment") was the bug: routing genuine
  // prose through the candidate-path pipeline means `reduceTokenToRealPathOrReject`
  // rejects it the moment the title/body text doesn't happen to name an
  // existing file — i.e. always. `-F`/`--body-file` stays exactly where
  // round 9 put it (a real local path, MUST stay containment-checked).
  gh: {
    // -w (--web) is the only common single-char BOOLEAN flag across the
    // floor's read-only subcommands; every other short flag below takes a
    // value.
    shortBoolean: new Set(["w"]),
    // -R/--repo (repo-pin value — extractGhRepo() enforces the pin
    // separately; routing it through containment too is harmless, since an
    // `owner/repo` value resolves relative to cwd), -S/--search, -L/--limit
    // (numeric), -F/--body-file (THE round-9 finding — a real local path,
    // MUST be containment-checked, never boolean-skipped, never moved to
    // shortTextValue).
    shortValue: new Set(["R", "S", "L", "F"]),
    // Round 10 (cortex#2493) — -t/--title, -b/--body: consumed as a value
    // (both flag forms), but free text, never a path — see longTextValue
    // below and the round-10 module-doc note for the full rationale.
    shortTextValue: new Set(["t", "b"]),
    // Boolean output/behaviour flags for view/list/diff/checks/comment.
    // None of these read a path as their value.
    longBoolean: new Set([
      "web",
      "comments",
      "draft",
      "patch",
      "name-only",
      "watch",
      "required",
      "edit-last",
      "create-if-none",
      "delete-last",
    ]),
    // Value flags whose value is text/identifiers, not a local path —
    // EXCEPT `body-file`, which genuinely IS a path and is deliberately
    // included here (not omitted) so its value routes through containment,
    // same discipline as git's `-C`/`--git-dir` at round 8.
    longValue: new Set([
      "repo",
      "json",
      "state",
      "search",
      "limit",
      "label",
      "assignee",
      "author",
      "base",
      "head",
      "body-file",
      "color",
      "interval",
      "template",
      "milestone",
    ]),
    // Round 10 (cortex#2493) — `title`/`body` are consumed as a value (both
    // `--title value` and `--title=value` forms) but are FREE TEXT: an
    // issue/PR title or comment body is arbitrary human prose, essentially
    // never the name of a file that exists relative to cwd, so routing it
    // through the candidate-path/containment pipeline produced a false
    // "no such file" deny on every ordinary invocation — the cortex#2493
    // regression. Neither flag reads from disk in the real `gh` CLI, so
    // skipping containment on them introduces no file-read/exfil vector;
    // `body-file` (the genuine round-9 finding) stays on `longValue` above,
    // unaffected by this change.
    longTextValue: new Set(["title", "body"]),
  },
};

/**
 * EBH-1g (cortex#2377) — commands whose {@link COMMAND_FLAG_POLICIES} entry
 * is a SUBCOMMAND-SCOPED fragment, not a whole-tool policy, and therefore
 * must NOT be strictly enforced against an arbitrary invocation in a
 * guard-off (G-300, `extractCommandPaths(cmd, "lenient")`) session.
 *
 * `git`'s and `gh`'s entries above were built to cover exactly the
 * subcommands `DEFAULT_CONFIG`'s floor allows (`log|diff|show|status|
 * branch|fetch|remote|rev-parse` for git; `pr {view,list,diff,checks,
 * status,comment}` / `issue {view,list,status,comment}` / `repo view` for
 * gh) — every flag whitelisted there was verified safe FOR THOSE
 * subcommands specifically. A guard-off session is not restricted to the
 * floor's subcommands (that restriction is exactly what G-300 lifts), so
 * `git commit -m`, `git push -u`, `git checkout -b`, `gh pr create -t`, …
 * would all hit "unrecognised flag" and deny outright under the SAME
 * strict classification every other known command gets — a crippling
 * false-positive regression for the ordinary git/gh write workflows G-300
 * exists to allow (`docs/design-dm-operator-channel.md` names "git write
 * ops" explicitly), not a real security gap being closed.
 *
 * Exempting these two from strict classification in lenient mode falls
 * back to the same generic heuristic an uncatalogued command gets: a
 * `-`-prefixed token is denied outright ONLY if `isPathShapedFlagValue`
 * flags it (still unconditional, in BOTH modes — catches `/`, `~`, and any
 * dot-leading `=`-value regardless of command), otherwise trusted as a
 * non-path flag and skipped. The round 8/9 findings this guard closed for
 * git/gh (`git diff --no-index <path> <path>`, `gh … --body-file=<path>`)
 * remain closed under this exemption too — both rely on
 * `isPathShapedFlagValue` and/or the generic bareword-argument fallthrough
 * (a SPACE-separated flag value, e.g. `--body-file <path>`, is always a
 * SEPARATE token from the flag and is containment-checked regardless of
 * flag classification), neither of which this exemption touches.
 *
 * Accepted residual (over-deny-not-under-deny direction intentionally NOT
 * taken here, in favour of usability): a SHORT flag GLUED to a BARE
 * RELATIVE value with no `/`/`~`/dot (e.g. a hypothetical `git -Cfoo` or
 * `gh -Flist`, mirroring the exact round-7 `file -flist` shape) is not
 * caught by `isPathShapedFlagValue` and, with the strict classifier
 * exempted, is skipped rather than containment-checked in a guard-off
 * session. This is narrower than round 7's `file` finding (`git`'s only
 * value-taking short flags are `-n`/`-C`, `gh`'s are `-R`/`-S`/`-L`/`-b`/
 * `-F` — none of which is `git`/`gh`'s own idiomatic form for chaining a
 * value with no space or `=`) and is judged an acceptable trade for not
 * breaking ordinary git/gh usage in the one context that most needs it to
 * keep working (G-300). `cat`/`head`/`tail`/`wc`/`ls`/`file` are NOT on
 * this list — they are single, non-subcommand tools with a small, STABLE,
 * exhaustively-modeled flag surface, so strict classification stays
 * correct (and load-bearing, per round 7) for them in every mode.
 */
export const SUBCOMMAND_SCOPED_FLAG_POLICIES = new Set(["git", "gh"]);

type FlagClassification =
  | { kind: "safe" }
  | { kind: "value"; value: string }
  | { kind: "text" }
  | { kind: "deny" };

/**
 * cortex#2384 (EBH-1h) — a token matching exactly one leading `-` followed by
 * one or more digits and nothing else (`-5`, `-20`; NOT `-5x`, NOT `--5`,
 * NOT `-5.0`). Checked against {@link CommandFlagPolicy.bareNumericCount}
 * before any other classification in {@link classifyFlagToken} below.
 */
const BARE_NUMERIC_FLAG_RE = /^-\d+$/;

/**
 * Classify a single `-`-prefixed token against one command's
 * {@link CommandFlagPolicy}. Called ONLY after {@link isPathShapedFlagValue}
 * has already cleared the token (that check still runs first and keeps its
 * existing deny message/behaviour unchanged — this is an ADDITIONAL,
 * stricter gate, not a replacement).
 *
 * Round 10 (cortex#2493) — the `"text"` classification. A flag on
 * `longTextValue`/`shortTextValue` (no `=`, i.e. the space-separated form)
 * returns `{ kind: "text" }` rather than `{ kind: "safe" }`: both mean "this
 * token itself is fine", but `"text"` ADDITIONALLY tells the caller
 * ({@link extractCommandPaths}) that the very next token is this flag's
 * value and must be skipped entirely — never quote-stripped, character-
 * whitelisted, or pushed onto the candidate-path list. A `--flag=value` /
 * glued-short text flag has no separate token to skip (the value is baked
 * into THIS token), so that case returns plain `{ kind: "safe" }` instead —
 * see the `--`/glued branches below.
 *
 * Exported for unit tests.
 */
export function classifyFlagToken(tok: string, policy: CommandFlagPolicy): FlagClassification {
  // EBH-1h (cortex#2384) — `head -5` / `tail -3`: a bare numeric short flag
  // is POSIX shorthand for `-n <count>` on these two commands only (see
  // {@link CommandFlagPolicy.bareNumericCount}). Checked first, ahead of the
  // long-flag and short-flag classification below, since `-5` would
  // otherwise fall into the single-char-body branch (`body === "5"`, which
  // is on neither command's `shortBoolean` nor `shortValue` set — every
  // digit AS A FLAG LETTER is deliberately absent from both) and deny. This
  // classifies the token as "safe" — same as any other whitelisted flag — so
  // it is skipped by the caller and never captured as a candidate path.
  if (policy.bareNumericCount && BARE_NUMERIC_FLAG_RE.test(tok)) return { kind: "safe" };

  if (tok.startsWith("--")) {
    const body = tok.slice(2);
    const eqIdx = body.indexOf("=");
    const name = eqIdx === -1 ? body : body.slice(0, eqIdx);
    if (eqIdx === -1) {
      if (policy.longBoolean.has(name) || policy.longValue.has(name)) return { kind: "safe" };
      // Round 10 (cortex#2493) — `--title`/`--body` (no `=`): the value is
      // the NEXT token, space-separated, and must be skipped as free text
      // rather than captured as a candidate path by the generic fallthrough.
      if (policy.longTextValue.has(name)) return { kind: "text" };
      return { kind: "deny" };
    }
    if (policy.longValue.has(name)) {
      return { kind: "value", value: body.slice(eqIdx + 1) };
    }
    // Round 10 (cortex#2493) — `--title=value`/`--body=value`: the value is
    // glued into THIS token via `=`. There is no separate token to skip, and
    // (unlike `longValue` above) the glued value must NOT be routed through
    // the candidate-path pipeline either — it is free text, not a path.
    // "safe" discards the whole token as-is; nothing more to do.
    if (policy.longTextValue.has(name)) return { kind: "safe" };
    return { kind: "deny" };
  }

  const body = tok.slice(1); // strip the single leading "-"
  if (body.length === 0) return { kind: "safe" }; // bare "-" (stdin marker)

  if (body.length === 1) {
    if (policy.shortBoolean.has(body) || policy.shortValue.has(body)) return { kind: "safe" };
    // Round 10 (cortex#2493) — `-t value`/`-b value`: same space-separated
    // free-text consumption as the long form above.
    if (policy.shortTextValue.has(body)) return { kind: "text" };
    return { kind: "deny" };
  }

  // Multi-char short-option token: either a glued numeric value ("-n20": a
  // shortValue char followed by a purely-numeric remainder), a glued free-
  // text value ("-tMyTitle": a shortTextValue char followed by anything —
  // round 10, cortex#2493), or a bundle of boolean flags ("-la"). A value
  // flag glued with non-digit chars ("-nl") is ambiguous and denied — never
  // both interpretations in the same token.
  const first = body[0] ?? "";
  const rest = body.slice(1);
  if (policy.shortValue.has(first) && /^[0-9]+$/.test(rest)) return { kind: "safe" };
  // Round 10: a glued shortTextValue is entirely consumed by THIS token
  // (like the `--flag=value` case above) — "safe", no separate token to
  // skip, and the glued remainder is never candidate-path-checked.
  if (policy.shortTextValue.has(first) && rest.length > 0) return { kind: "safe" };

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
 * cortex#2365 adversarial review round 8 (EBH-1d finding 2): round 7's
 * whitelist gate had an unintended side effect — `classifyFlagToken("--")`
 * treated the bare POSIX end-of-options marker as an unrecognised long
 * flag (empty body, never on any whitelist) and denied the whole command,
 * so `cat -- file.txt` / `ls --` / `file -- x` all regressed to a deny.
 * Fixed by tracking `endOfOptions`: once a bare `--` token is seen, every
 * token after it — even one that still starts with `-` — skips flag
 * classification ENTIRELY and is containment-checked as a literal
 * positional path, same as any other bareword argument. More correct AND
 * more secure than the pre-round-7 behavior of silently skipping `--`
 * tokens as flags: a dash-led literal filename after `--` (e.g. `-flist`)
 * is now actually checked, not waved through.
 *
 * EBH-1g (cortex#2377) added the `mode` parameter. `"strict"` (the default,
 * used for every normal-session allowlisted command) is unchanged from
 * round 9: a `-`-prefixed token on a command with no `COMMAND_FLAG_POLICIES`
 * entry denies the whole command. `"lenient"` is used ONLY for a guard-off
 * (G-300) session's path-containment pass (see `checkCommandPaths`'
 * `opts.lenient` and `main()`'s `config === null` branch): since G-300's
 * entire point is that the principal may run a command this guard has never
 * catalogued, a `-`-prefixed token that isn't itself path-shaped
 * (`isPathShapedFlagValue` still runs FIRST, in both modes) is trusted as a
 * boolean/non-path flag and skipped rather than denying the command. A
 * command that DOES have a `COMMAND_FLAG_POLICIES` entry is normally
 * unaffected by `mode` — its flags are still classified precisely, so the
 * round 7 finding (`file -flist`) stays closed even in a guard-off session
 * — EXCEPT `git`/`gh` (see {@link SUBCOMMAND_SCOPED_FLAG_POLICIES}), whose
 * policy entries are deliberately scoped to the floor's narrow read-only
 * subcommands, not the whole tool, and would otherwise deny ordinary
 * guard-off usage (`git commit -m`, `git push -u`, `gh pr create -t`, …).
 *
 * Exported for unit tests.
 */
export function extractCommandPaths(
  command: string,
  mode: "strict" | "lenient" = "strict",
): ExtractedCommandPaths {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const paths: string[] = [];
  // cortex#2359 round 7 — the calling command's safe-flag whitelist. Mirrors
  // the headWord extraction main() already performs to decide whether to
  // call checkCommandPaths() at all; recomputed here so this function stays
  // self-contained (its own module-doc "Exported for unit tests" contract).
  const headWord = /^([A-Za-z][A-Za-z0-9_]*)\b/.exec(command)?.[1]?.toLowerCase();
  // EBH-1g (cortex#2377): in LENIENT mode only, a command on
  // SUBCOMMAND_SCOPED_FLAG_POLICIES is treated as if it had no policy at
  // all — see that set's doc for why `git`/`gh` specifically must not be
  // strictly classified against a policy that was only ever calibrated for
  // the floor's narrow subcommand set.
  const lenientExempt = mode === "lenient" && headWord !== undefined
    && SUBCOMMAND_SCOPED_FLAG_POLICIES.has(headWord);
  const flagPolicy = headWord && !lenientExempt ? COMMAND_FLAG_POLICIES[headWord] : undefined;
  // cortex#2365 (EBH-1d, round 8 finding 2) — POSIX end-of-options marker.
  // A bare `--` stops flag parsing for every standard tool; everything
  // after it is a positional argument EVEN IF it starts with `-`. Before
  // this fix, `classifyFlagToken("--")` saw an empty long-flag body (never
  // on any policy's longBoolean/longValue) and denied the WHOLE COMMAND —
  // `cat -- file.txt`, `ls --`, `file -- x` were all denied outright, a
  // real usability regression (round 7 introduced the whitelist gate that
  // caught this as a side effect). Once `endOfOptions` flips true here, the
  // `!endOfOptions` guard below is false for every remaining token — even
  // one that still starts with `-` — so it falls straight through to the
  // SAME quote-strip/character-whitelist/containment pipeline as any other
  // literal path argument. This is not just a usability fix: it is MORE
  // secure than skipping `--`, because a token like `-flist` after `--` is
  // now containment-checked as the literal filename it is, instead of
  // either being denied on principle or (pre-round-7) silently
  // reinterpreted as a flag.
  let endOfOptions = false;
  // Round 10 (cortex#2493) — when a `longTextValue`/`shortTextValue` flag
  // classifies as `"text"` below, the IMMEDIATELY FOLLOWING token is that
  // flag's free-text value (space-separated form, e.g. `--title "…"`). It
  // must be skipped unconditionally — before the `--`/`-`-prefix checks,
  // before quote-stripping, before the character whitelist, before ever
  // being pushed onto `paths` — because it is known-consumed free text, not
  // a positional path argument at all. This is what makes `gh issue create
  // --title "A title with spaces" --body-file ./body.md` work: the title
  // text is skipped here, and `--body-file`'s own value is unaffected.
  let skipNextAsText = false;
  for (let i = 1; i < tokens.length; i++) {
    let tok = tokens[i];
    if (tok === undefined) continue;
    if (skipNextAsText) {
      skipNextAsText = false;
      continue;
    }
    if (!endOfOptions && tok === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && tok.startsWith("-")) {
      if (isPathShapedFlagValue(tok)) {
        return {
          paths: null,
          reason:
            `path-shaped value glued to a flag ("${tok.slice(0, 80)}") — cannot safely ` +
            `classify what this flag consumes, denying fail-closed`,
        };
      }
      // cortex#2359 round 7 — the whitelist gate. `flagPolicy` is always
      // defined here in STRICT mode (this function only ever runs for a
      // PATH_CHECKED_COMMANDS head word — see checkCommandPaths' call
      // site), so an absent policy fails CLOSED rather than silently
      // skipping the token, matching this whole module's posture.
      //
      // EBH-1g (cortex#2377) LENIENT mode is the one exception, used ONLY
      // for a guard-off (G-300) session: G-300's whole point is that the
      // principal may run a command this guard has never catalogued, so
      // hard-failing on "no known flag policy" would defeat it. A flag
      // token that survived `isPathShapedFlagValue` above (i.e. does not
      // itself look like it carries a path) is trusted as a boolean/
      // non-path flag and skipped, rather than denying the whole command.
      // This is a heuristic, not per-command flag knowledge — see the
      // module doc's "guard-off lenient mode" note for the accepted
      // residual this trades away.
      if (!flagPolicy) {
        if (mode === "lenient") continue;
        return {
          paths: null,
          reason:
            `unrecognised flag ("${tok.slice(0, 80)}") on a path-reading command with no ` +
            `known flag policy — denying fail-closed`,
        };
      }
      const classified = classifyFlagToken(tok, flagPolicy);
      if (classified.kind === "deny") {
        // EBH-1g: deliberately NOT relaxed by `mode === "lenient"`. A
        // COMMAND_FLAG_POLICIES entry exists precisely because one of this
        // command's flags reads a path (rounds 7-9: `file -flist`,
        // `git diff --no-index`, `gh … --body-file`) — relaxing this for
        // guard-off sessions would silently reopen those exact findings in
        // the one context that most needs the defense-in-depth (indirect
        // prompt injection into an already-trusted session, per EBH-6/F4).
        return {
          paths: null,
          reason:
            `unrecognised flag ("${tok.slice(0, 80)}") on a path-reading command — denying ` +
            `fail-closed (cortex#2359)`,
        };
      }
      if (classified.kind === "safe") continue;
      // Round 10 (cortex#2493) — "text": this flag's value is the NEXT
      // token (space-separated form), and it is free text, not a path.
      // Mark it to be skipped unconditionally on the next iteration — see
      // `skipNextAsText` above — rather than letting it fall through to the
      // generic bareword-argument candidate-path handling below.
      if (classified.kind === "text") {
        skipNextAsText = true;
        continue;
      }
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
 *
 * `opts.lenient` (EBH-1g, cortex#2377) — used ONLY by `main()`'s guard-off
 * (G-300, `CORTEX_BASH_GUARD={"disabled":true}`) branch. Normal
 * (`opts.lenient` unset/false) callers keep the round-9 posture EXACTLY:
 * a command with no `COMMAND_FLAG_POLICIES` entry denies outright. Lenient
 * callers skip that gate — G-300's whole point is that the principal may
 * run a command this guard has never catalogued — and pass `"lenient"`
 * through to {@link extractCommandPaths} instead, which does the actual
 * flag-vs-path heuristic (see that function's doc). Everything else
 * (policy load, the "no restriction configured" shortcut, path reduction +
 * containment) is IDENTICAL in both modes — lenient only changes how a
 * command's FLAGS are classified, never whether an extracted path must be
 * contained.
 */
export function checkCommandPaths(
  trimmedCommand: string,
  opts?: { lenient?: boolean },
): { allow: boolean; reason: string } {
  const lenient = opts?.lenient ?? false;
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

  // cortex#2370 (EBH-1e, round 9) — the runtime half of the opt-in→opt-out
  // inversion: a NORMAL-mode command only ever reaches this function when
  // its head word is NOT on PATH_CHECK_OPT_OUT_COMMANDS (see the call site
  // in main()), so it MUST carry an explicit COMMAND_FLAG_POLICIES entry.
  // This is checked UNCONDITIONALLY here — not just when a `-`-prefixed
  // token happens to be present — so a policy-less command with an
  // all-positional invocation (no flags at all) still fails CLOSED instead
  // of silently sailing through extractCommandPaths' generic non-flag
  // fallthrough. (extractCommandPaths still carries its own flagPolicy-
  // presence check too, for the case where it's ever called directly —
  // defense in depth, not the primary gate.)
  //
  // EBH-1g: a `lenient` (guard-off) caller SKIPS this gate — a command
  // with no cataloged policy must still be allowed to run (G-300); its
  // flags are heuristically classified by extractCommandPaths' lenient
  // mode instead. A missing/malformed head word is still a fail-closed
  // deny in EITHER mode — that is not a "no policy" case, it means the
  // command string itself could not be parsed at all.
  const headWord = /^([A-Za-z][A-Za-z0-9_]*)\b/.exec(trimmedCommand)?.[1]?.toLowerCase();
  if (!headWord) {
    return {
      allow: false,
      reason:
        `[Cortex Bash Guard] Blocked "${trimmedCommand.slice(0, 80)}": could not determine a ` +
        `command head word — denying fail-closed.`,
    };
  }
  if (!lenient && !COMMAND_FLAG_POLICIES[headWord]) {
    return {
      allow: false,
      reason:
        `[Cortex Bash Guard] Blocked "${trimmedCommand.slice(0, 80)}": no COMMAND_FLAG_POLICIES ` +
        `entry declared for this command (cortex#2370) — denying to stay fail-closed.`,
    };
  }

  const extracted = extractCommandPaths(trimmedCommand, lenient ? "lenient" : "strict");
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

  // G-300: Guard disabled (principal DM). EBH-1g (cortex#2377, principal-
  // decided option (b)): the command-SHAPE allowlist (config.rules) is
  // still SKIPPED entirely — the principal may run ANY command; that is
  // the whole point of G-300 (docs/design-dm-operator-channel.md) — but
  // the rounds 7-9 path-containment machinery now runs before deferring to
  // Claude Code's own gate. Before this fix, this branch returned pass()
  // unconditionally: Bash had ZERO cortex-owned protection in a guard-off
  // session, even though the file tools (Read/Write/Edit/Glob/Grep/
  // NotebookEdit, via the separate path-guard.hook.ts) were already
  // containment-checked in the very same sessions (EBH-1). The residual
  // this closes is INDIRECT prompt injection into an already-legitimate
  // guard-off session — the trigger itself cannot be forged (verified in
  // docs/security/ebh-6-posture-findings.md §F4); the realistic risk is
  // the principal asking the agent to read a PR/issue/URL whose fetched
  // content carries an injection, with a previously-unbounded Bash tool.
  //
  // Still intentionally NOT a grant() at the end of this branch: it stays
  // out of the allowlist's auto-approve scope, matching the pre-EBH-1g
  // contract (cortex#777) — this only ADDS a containment gate in front of
  // the same pass()-or-deny() outcomes that existed before.
  if (config === null) {
    // rejectsChaining() is NOT the command-shape allowlist this branch
    // otherwise skips — see the module doc's "No-bypass guard" section and
    // that function's own `opts.allowPipes` doc. It is what makes the
    // per-segment containment check below SOUND: command substitution and
    // redirects let a path be COMPUTED at run time, or a write/read target
    // hide outside the argument list this guard extracts — neither is
    // something a segment split can decompose, so both stay denied
    // unconditionally, in EITHER mode.
    //
    // A bare pipe `|` is different: `allowPipes: true` here (guard-off
    // ONLY — the guard-on call site below passes no options and is
    // unaffected). A pipeline is JUST MORE SEGMENTS — `cat f.txt | wc -l`
    // decomposes into "cat f.txt" and "wc -l" exactly the way
    // `cat f.txt && wc -l` already does below, and each is
    // containment-checked independently. Denying it bought no containment
    // guard-on didn't already have a reason to deny it FOR (there, a pipe
    // could smuggle a command past the shape-allowlist — a concern that
    // doesn't exist here, since G-300 has no shape-allowlist to smuggle
    // past). Confirmed: `cat <out-of-scope> | wc -l` and
    // `wc -l < <out-of-scope>` still deny — the first via the containment
    // check on the "cat" segment, the second because `<` redirection stays
    // in the unconditional deny set above.
    if (rejectsChaining(rawCommand, { allowPipes: true })) {
      const reason =
        `[Cortex Bash Guard] Blocked "${rawCommand.slice(0, 80)}" (guard-off session, EBH-1g): ` +
        `command contains a shell metacharacter (command substitution, backtick, redirect, ` +
        `background '&', or newline) that path-containment cannot safely verify across ` +
        `(pipes are fine — each command in the pipeline is containment-checked separately). ` +
        `Split it into separate commands — G-300 still allows any individual command.`;
      deny(reason);
      await emitBlockEvent(sessionId, reason, command);
      return;
    }

    // Same segment split as the allowlisted path below (&&/||/;), PLUS a
    // bare pipe `|` (guard-off only — see the allowPipes note above). Order
    // matters: `\|\|` must precede the bare `\|` alternative so a `||`
    // token is matched as ONE two-character separator, not split into two
    // single-pipe separators that would leave stray `|` characters glued to
    // the neighbouring segment. Each resulting segment is one simple
    // invocation, containment-checked independently and leniently (no
    // COMMAND_FLAG_POLICIES entry required to run).
    const guardOffParts = command.split(/\s*(?:&&|\|\||;|\|)\s*/);
    for (const part of guardOffParts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      const headWord = /^([A-Za-z][A-Za-z0-9_]*)\b/.exec(trimmed)?.[1]?.toLowerCase();
      // Commands PROVEN not to take a path argument at all (see
      // PATH_CHECK_OPT_OUT_COMMANDS above) skip containment even here —
      // `echo /etc/passwd` prints a string, it never opens the path.
      if (headWord && PATH_CHECK_OPT_OUT_COMMANDS.has(headWord)) continue;

      const pathCheck = checkCommandPaths(trimmed, { lenient: true });
      if (!pathCheck.allow) {
        deny(pathCheck.reason);
        await emitBlockEvent(sessionId, pathCheck.reason, command);
        return;
      }
    }

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
