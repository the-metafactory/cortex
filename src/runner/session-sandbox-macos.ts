/**
 * EBH-3a (cortex#2345) — the `macos-sbpl` `SessionSandbox` backend.
 *
 * ## What this is
 *
 * Generates an SBPL (`.sb`) profile from a resolved {@link SandboxProfile}
 * and runs the session under it via `sandbox-exec -f <profile>` (DD-4's
 * macOS row). Posture is **DD-10 v1 `guarded`**: `(allow default)` plus
 * explicit `deny` rules for the sensitive set — NOT strict `(deny default)`.
 * E4 (`docs/design-session-sandbox-platforms.md` §2) measured that a strict
 * deny-default profile `SIGABRT`s (exit 134) without extensive dyld/mach
 * allowances the runtime doesn't have cataloged yet; denylist-first is the
 * deliberate staged choice, not an oversight. `(deny default)`/v2 `strict`
 * is future work once the compatibility contract (design doc §3/§5) is
 * empirically pinned end-to-end.
 *
 * ## The E3 discipline (THE thing that must not go wrong)
 *
 * E3 measured that a deny rule authored against an UNRESOLVED symlink alias
 * (`/tmp/x`, which is itself a symlink to `/private/tmp/x`) silently does
 * NOTHING — the read succeeds. The identical rule authored against the
 * REALPATH (`/private/tmp/x`) correctly denies. This module's own repro
 * (2026-07-25, this host) reproduced that finding exactly: a deny rule
 * written as `/tmp/<marker>` failed to deny a read via `/tmp/<marker>`,
 * while the same rule written as the resolved `/private/tmp/<marker>`
 * denied correctly — see the canary below, which exercises this EXACT shape
 * every session.
 *
 * Every path that enters {@link generateMacosSbplProfile} is resolved with
 * {@link resolveProspectiveRealpath} (`path-containment.ts`, EBH-1's
 * already-hardened realpath discipline — reused, not re-implemented) BEFORE
 * it is written into the profile text. A path that fails to resolve is
 * EXCLUDED and reported in `unresolved` — fail closed, never silently
 * dropped from tracking, never silently trusted unresolved.
 *
 * ## What v1 `guarded` denies (the "sensitive set")
 *
 * `(allow default)` means everything NOT explicitly denied stays allowed —
 * so this posture protects the enumerated set that matters most (secrets,
 * tokens, self-modification), not universal allowedDirs-only confinement.
 * That fuller boundary (deny everything outside `allowedDirs`) is v2
 * `strict`'s job (DD-10) and needs deny-default, which E4 rules out for
 * this slice. Denied here:
 *
 *   - `~/.config/metafactory/cortex/**` (config dir — CONFIG IMMUTABILITY, F1)
 *   - `~/.ssh`, `~/.aws` (arbitrary-secret read, F1)
 *   - `~/.gnupg`, `~/.docker/config.json`, `~/.config/gh/hosts.yml`,
 *     `~/.netrc`, `~/.git-credentials`, `~/.kube/config`, `~/.npmrc`,
 *     `~/.pypirc`, `~/.cargo/credentials.toml`, `~/.config/op` (cortex#2409
 *     sensitive-set extension — read+write)
 *   - `~/Library/Keychains` (cortex#2409) — WRITE only, unlike every other
 *     entry above: a real session both stats the keychain AND reads its
 *     login-credential DATA on every start (`claude` itself uses the OS
 *     keychain for auth state) — ANY read-deny here broke a real session
 *     empirically (see {@link builtinSensitiveDenyEntries} for the full,
 *     two-round story). Read stays open; this is a known, disclosed gap
 *     in the set, not an oversight.
 *   - `~/.claude/settings.json` — WRITE only (self-modification)
 *   - `~/.claude/hooks/**` — WRITE only (self-modification; READ+EXEC stays
 *     allowed — the compatibility contract requires it)
 *   - every `readOnly` dir on the profile — WRITE only (F6)
 *   - any caller-supplied `extraDenyPaths` (read+write) — the generic escape
 *     hatch a caller (a test, or a future "other stacks" enumeration) uses to
 *     deny an out-of-scope root this module doesn't know about by name.
 *
 * **cortex#2409 is cost-raising, NOT a fix.** A denylist cannot be completed
 * — the next unenumerated credential store is always available; adding
 * entries raises the attacker's cost, it never establishes a boundary. The
 * real fix is v2 `strict` (deny-default + explicit allow), where the
 * property holds by construction. See `docs/security/hardening-plan.md`
 * §"What L2 v1 does NOT close" — do not describe this set, however long it
 * gets, as closing F1.
 *
 * Deliberately NOT in the set (considered and rejected, cortex#2409):
 *
 *   - `~/.gitconfig` — read constantly by ordinary `git` usage (identity for
 *     every commit, `core.*`, aliases) that this harness itself performs
 *     routinely (CLAUDE.md's own workflow is git-commit-heavy). Denying it
 *     would break everyday sessions, not just hostile ones. It rarely holds
 *     a literal secret itself — at most a pointer to a credential helper —
 *     and the credential STORES those helpers actually use
 *     (`~/.git-credentials`, `gh`'s `hosts.yml`, and `~/Library/Keychains`
 *     for tamper via WRITE) are already denied above.
 *   - `~/.zsh_history`, `~/.bash_history` — secret-adjacent (a pasted token
 *     or password can land in history) but this module cannot verify from
 *     cortex's own source what shell mode the `claude` binary's own Bash
 *     tool invokes internally (interactive vs. non-interactive changes
 *     whether a shell reads/appends these files at all). A wrong WRITE-deny
 *     here risks the exact failure mode this issue warns against — a
 *     silent, session-breaking regression in ordinary Bash-tool use — for a
 *     class of secret exposure that requires a prior unsafe practice
 *     (typing a raw credential on a command line) rather than an at-rest
 *     store by design. Left out until that shell-mode question is measured
 *     directly against the real binary, not guessed at.
 *
 * ## Denial observability (DD-6)
 *
 * `sandbox-exec` execs the target IN PLACE (execve replaces the process
 * image; `Bun.spawn`'s returned pid IS the pid the kernel logs against —
 * verified empirically, 2026-07-25, this host). macOS's unified log records
 * every denial as `Sandbox: NAME(PID) deny(N) OPERATION PATH` (verified via
 * `log stream --style ndjson`, both `file-read-data` and `file-write-create`
 * operations). `MacosSbplSandbox.denials()` tails `log stream` scoped to the
 * spawned pid and parses that exact line shape.
 *
 * **Known observability gap (measured, not assumed):** `log stream` has
 * roughly ~1s of startup latency before it reliably delivers events (spot-
 * checked on this host: a denial triggered before the stream had been
 * running ~1s did not appear). SBPL enforcement itself is NOT delayed — a
 * denial in the first second of a session is still denied — but its LOG
 * ENTRY, and therefore the `system.security.sandbox-denial` event, may be
 * missed. Acceptable for `audit`/`enforce`'s observability purpose (session
 * lifetimes are seconds-to-minutes); flagged here rather than assumed away.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Subprocess } from "bun";
import { resolveProspectiveRealpath } from "../common/path-containment";
import { activeConfigHomeEnv } from "../common/substrates/config-home";
import { resolveArcPackReposDir } from "../common/config/arc-pack-repos-dir";
import type {
  SandboxDenial,
  SandboxProfile,
  SandboxSpawnOpts,
  SessionSandbox,
} from "./session-sandbox";

// -----------------------------------------------------------------------------
// SBPL text generation
// -----------------------------------------------------------------------------

/** Escape a resolved path for embedding in an SBPL string literal. Paths on
 *  a real deployment never legitimately contain `"`/`\`, but a profile
 *  generator that trusted that without escaping would be exactly the kind
 *  of "looks safe, isn't" gap this epic exists to close. */
function sbplQuote(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** One `(deny …)` clause's inputs — kept structured (not pre-stringified)
 *  so {@link generateMacosSbplProfile} can report exactly which INPUT path
 *  produced which resolved deny, for `unresolved` reporting. */
interface DenyEntry {
  input: string;
  op: "file-read*" | "file-write*";
}

export interface MacosSbplProfileOpts {
  /**
   * Additional roots to deny read+write, beyond the built-in sensitive set.
   * The generic escape hatch for "out-of-scope" roots this module doesn't
   * know by name (another stack's repo, a test fixture proving the
   * mechanism generalizes past the three hardcoded categories). Real
   * "enumerate every other stack" wiring is follow-up work — deriving that
   * list needs a stacks registry `deriveSandboxProfile`/this module doesn't
   * have access to today; this parameter is the seam that wiring lands in.
   */
  extraDenyPaths?: string[];
  /** Override `$HOME` (tests). Defaults to `os.homedir()`. */
  homeDir?: string;
}

export interface MacosSbplProfile {
  /** The compiled SBPL text — write verbatim to a `.sb` file. */
  text: string;
  /** Every input path that failed to realpath-resolve, and why. FAIL CLOSED:
   *  none of these made it into `text` — an unresolvable sensitive-set path
   *  is not silently trusted, but it's also not fatal (e.g. `~/.aws` simply
   *  doesn't exist on a host with no AWS credentials configured — nothing to
   *  protect there either). Surfaced so a caller can decide whether to log. */
  unresolved: { input: string; reason: string }[];
  /** The resolved (realpath'd) roots actually denied — for tests/logging. */
  resolvedDenyPaths: string[];
}

/**
 * Build the built-in sensitive-set deny entries (design-session-sandbox.md
 * §3, -platforms.md §5, DD-10 v1). Split out so tests can assert on the
 * SET independent of SBPL string formatting.
 */
function builtinSensitiveDenyEntries(profile: SandboxProfile, homeDir: string): DenyEntry[] {
  const entries: DenyEntry[] = [
    // CONFIG IMMUTABILITY (F1) — the whole tree, read AND write. Simpler and
    // STRONGER than trying to enumerate "other stacks" individually: this
    // session's OWN stack config is denied too (least privilege — a session
    // has no legitimate need to read its own stack's tokens off disk).
    { input: join(homeDir, ".config", "metafactory", "cortex"), op: "file-read*" },
    { input: join(homeDir, ".config", "metafactory", "cortex"), op: "file-write*" },
    // Arbitrary-secret read (F1).
    { input: join(homeDir, ".ssh"), op: "file-read*" },
    { input: join(homeDir, ".ssh"), op: "file-write*" },
    { input: join(homeDir, ".aws"), op: "file-read*" },
    { input: join(homeDir, ".aws"), op: "file-write*" },

    // ---------------------------------------------------------------------
    // cortex#2409 sensitive-set extension. Probing a generated profile on a
    // real host found 11 credential/state stores readable straight through
    // the original set above. Every entry below is a CREDENTIAL STORE the
    // harness itself never needs to read to function (unlike hooks/ below,
    // there is no compat-contract reason to leave read open), so each
    // follows the ~/.ssh / ~/.aws precedent: deny BOTH read (secret
    // exposure) and write (tamper — e.g. a planted malicious docker
    // credential helper, a kube config repointed at an attacker-controlled
    // API server, an injected GPG key). THIS IS STILL AN ENUMERATED
    // DENYLIST (module doc) — it raises the attacker's cost, it does not
    // close F1; the next unenumerated store is always available. See the
    // module doc's "Deliberately NOT in the set" for the two candidates
    // (`~/.gitconfig`, shell histories) considered and rejected.
    // ---------------------------------------------------------------------

    // GPG secret keyring + trustdb — private keys and signing material.
    { input: join(homeDir, ".gnupg"), op: "file-read*" },
    { input: join(homeDir, ".gnupg"), op: "file-write*" },
    // Docker registry auth (base64-encoded or a credsStore pointer).
    { input: join(homeDir, ".docker", "config.json"), op: "file-read*" },
    { input: join(homeDir, ".docker", "config.json"), op: "file-write*" },
    // gh CLI's stored OAuth token.
    { input: join(homeDir, ".config", "gh", "hosts.yml"), op: "file-read*" },
    { input: join(homeDir, ".config", "gh", "hosts.yml"), op: "file-write*" },
    // Plaintext machine/login/password entries (curl, ftp, and others).
    { input: join(homeDir, ".netrc"), op: "file-read*" },
    { input: join(homeDir, ".netrc"), op: "file-write*" },
    // git's plaintext credential-store helper output.
    { input: join(homeDir, ".git-credentials"), op: "file-read*" },
    { input: join(homeDir, ".git-credentials"), op: "file-write*" },
    // macOS keychain databases — WRITE only, unlike every other entry in
    // this set. TWO ROUNDS of empirical correction (cortex#2409, this
    // host), both caught by the real end-to-end acceptance test
    // (`cc-session-macos-sandbox-e2e.test.ts`), NOT reasoned out in
    // advance:
    //   1. The original `file-read*` version broke a real session with
    //      spurious denials — a real `claude --print` session performs a
    //      `file-read-metadata` (stat/access) against the keychain on
    //      every start.
    //   2. Narrowing to `file-read-data` (deny content reads, allow
    //      metadata) was STILL wrong: the real session then failed
    //      authentication outright ("Not logged in · Please run /login",
    //      `success: false`) — `claude`'s own login-state check reads the
    //      keychain's actual DATA, not just its metadata. This module's
    //      earlier assumption (that keychain access is exclusively
    //      securityd/XPC-mediated and therefore untouched by ANY read-deny
    //      here) was wrong on both counts.
    // So read access — data AND metadata — must stay allowed, same
    // compatibility-contract reasoning as `.claude/hooks` below (self-
    // modification is denied via write; the mechanism the harness itself
    // depends on stays open). This still closes the WRITE/tamper vector
    // (a planted or corrupted keychain entry); it does NOT close the
    // offline-copy read vector for Keychains specifically — a real, known
    // gap in this enumerated set, consistent with the module doc's "cannot
    // be completed by adding entries" framing.
    { input: join(homeDir, "Library", "Keychains"), op: "file-write*" },
    // kubectl cluster/user credentials (tokens, client certs).
    { input: join(homeDir, ".kube", "config"), op: "file-read*" },
    { input: join(homeDir, ".kube", "config"), op: "file-write*" },
    // May embed a registry `_authToken`. Same accepted trade-off as ~/.aws
    // above: a session that legitimately needs an authenticated npm install
    // loses that ability, same as one that legitimately needs AWS already
    // does — least privilege over convenience for an untrusted-content-
    // driven session.
    { input: join(homeDir, ".npmrc"), op: "file-read*" },
    { input: join(homeDir, ".npmrc"), op: "file-write*" },
    // PyPI upload (twine) credentials.
    { input: join(homeDir, ".pypirc"), op: "file-read*" },
    { input: join(homeDir, ".pypirc"), op: "file-write*" },
    // crates.io publish token. Not needed for ordinary `cargo build`/`test`.
    { input: join(homeDir, ".cargo", "credentials.toml"), op: "file-read*" },
    { input: join(homeDir, ".cargo", "credentials.toml"), op: "file-write*" },
    // 1Password CLI session/cache state.
    { input: join(homeDir, ".config", "op"), op: "file-read*" },
    { input: join(homeDir, ".config", "op"), op: "file-write*" },

    // Self-modification — WRITE only. Read+exec of hooks is a compatibility-
    // contract REQUIREMENT (design doc §3), so hooks are not read-denied.
    { input: join(homeDir, ".claude", "settings.json"), op: "file-write*" },
    { input: join(homeDir, ".claude", "hooks"), op: "file-write*" },
  ];
  // F6 — a readOnlyDir is read-only at the kernel layer too, not just L1's
  // path guard. Write-deny only; read stays allowed via (allow default).
  for (const dir of profile.readOnly) {
    entries.push({ input: dir, op: "file-write*" });
  }
  return entries;
}

/**
 * EBH-3a — generate the DD-10 v1 `guarded` SBPL profile for `profile`.
 * Every deny root is realpath-resolved via {@link resolveProspectiveRealpath}
 * BEFORE being written into the profile text — the E3 discipline (module
 * doc). `readWrite`/`execAllow`/`egressAllow` are NOT projected into the
 * profile: under `(allow default)` they are already permitted (nothing to
 * allow-list explicitly); they're carried on `SandboxProfile` for v2
 * `strict`'s eventual deny-default + explicit-allow posture, unused here.
 */
export function generateMacosSbplProfile(
  profile: SandboxProfile,
  opts: MacosSbplProfileOpts = {},
): MacosSbplProfile {
  const homeDir = opts.homeDir ?? homedir();
  const entries: DenyEntry[] = [
    ...builtinSensitiveDenyEntries(profile, homeDir),
    ...(opts.extraDenyPaths ?? []).flatMap(
      (p): DenyEntry[] => [
        { input: p, op: "file-read*" },
        { input: p, op: "file-write*" },
      ],
    ),
  ];

  const unresolved: { input: string; reason: string }[] = [];
  const resolvedDenyPaths = new Set<string>();
  const lines: string[] = ["(version 1)", "(allow default)"];

  for (const entry of entries) {
    const resolution = resolveProspectiveRealpath(entry.input);
    if (!resolution.ok) {
      unresolved.push({ input: entry.input, reason: resolution.reason });
      continue;
    }
    resolvedDenyPaths.add(resolution.real);
    lines.push(`(deny ${entry.op} (subpath "${sbplQuote(resolution.real)}"))`);
  }

  return {
    text: lines.join("\n") + "\n",
    unresolved,
    resolvedDenyPaths: [...resolvedDenyPaths],
  };
}

// -----------------------------------------------------------------------------
// v2 `strict` SBPL text generation (cortex#2409 part 2) — DD-10's deny-
// default posture: `(deny default)` + a DERIVED, documented, minimal
// explicit-allow set. This is the boundary that holds "by construction" —
// everything NOT on the allow set below is denied, full stop, no enumeration
// to complete.
//
// ## How this allow set was derived (the evidence trail the issue asked for)
//
// Every entry below was found by the SAME loop, run against this real host
// (macOS 26.5.1, arm64, `sandbox-exec` present):
//
//   1. write a candidate `(deny default)` profile;
//   2. spawn a REAL `claude --print` session under it (via `sandbox-exec -f`);
//   3. read what the kernel denied from the macOS unified log (the SAME
//      `Sandbox: NAME(PID) deny(N) OPERATION PATH` shape `session-sandbox-
//      macos.ts`'s own `denials()`/`parseSandboxDenialLogLine` already parses
//      — no `fs_usage`/`dtruss`, no root, exactly the EBH-3a-established
//      observation mechanism);
//   4. add the MINIMUM allow that resolves that denial;
//   5. repeat until a full fresh-session + `--resume` round-trip completed
//      with ZERO denials (the same bar EBH-3a's own e2e test holds `guarded`
//      to).
//
// Round-by-round findings (each is what iteration on step 3 actually showed —
// not reasoned out in advance):
//
//   - **Round 1 (E4's SIGABRT, exit 134).** A naive `(deny default)` with
//     only a `process-exec` allow for the target binary SIGABRTs before any
//     denial is even logged — the unified log shows NOTHING for the crash
//     (verified: `log show` around the crash window is empty). The macOS
//     crash reporter (`~/Library/Logs/DiagnosticReports/*.ips`) tells the
//     real story: the fault is in `dyld4::CacheFinder::CacheFinder` →
//     `ProcessConfig::DyldCache` → `ignition_halt`/`abort_with_reason` —
//     dyld's OWN bootstrap (locating/validating the shared cache, resolving
//     cryptex graft points) aborts when it can't complete a handful of
//     specific syscalls/reads `(deny default)` blocks silently (no Seatbelt
//     denial line is logged for whatever dyld's `ignition`/`libignition`
//     layer hits — it aborts before the normal per-operation denial
//     mechanism even applies). FIX: `(import "dyld-support.sb")` — Apple's
//     OWN shipped profile fragment for exactly this
//     (`/System/Library/Sandbox/Profiles/dyld-support.sb`, "Rules required to
//     bootstrap a process with dyld"), used verbatim by Apple's real daemon
//     profiles (`bsd.sb` imports `system.sb`, which imports this). Verified:
//     `(deny default)(import "dyld-support.sb")(allow process-exec …)` runs
//     `/usr/bin/true` to a clean exit 0, no crash, no denial.
//   - **Round 2.** Importing the WIDER `system.sb` (which itself imports
//     `dyld-support.sb`, plus grants `file-read-metadata`, `sysctl-read`,
//     the standard `mach-lookup` set for cfprefsd/notification_center/
//     opendirectoryd/trustd/logd, and the base `/System`, `/usr/lib`,
//     `/usr/share` reads) took a real `claude --version` invocation from
//     SIGABRT to a clean run with ZERO denials, once the target binary + its
//     cwd were allow-listed. `system.sb` is the SAME base every real Apple
//     daemon profile in `/System/Library/Sandbox/Profiles/` builds on
//     (`bsd.sb`'s `(import "system.sb")` — inspected directly on this host);
//     reusing it is "don't hand-roll dyld/mach bootstrap", the same
//     philosophy as reusing `loader.ts`'s path-containment code elsewhere in
//     this repo.
//   - **Round 3 (a real `claude --print` prompt, not just `--version`).**
//     Denials observed: `process-fork` + `posix_spawn 'security'` — `claude`
//     shells out to macOS's `/usr/bin/security` CLI to query keychain state
//     at startup. Then, once `security` could exec: `mach-lookup
//     com.apple.securityd.xpc`, `mach-lookup com.apple.SecurityServer`,
//     `user-preference-read kcfpreferencesanyapplication`/`com.apple.security`
//     — `security`'s own keychain-query path. FIX: allow `process-fork`
//     (matches Apple's own `application.sb` baseline for ordinary sandboxed
//     apps — inspected directly), explicit exec+read allow for the resolved
//     `security` binary, the two `mach-lookup` names, and a broad
//     `user-preference-read` (matches `application.sb`'s own posture —
//     preference reads are stat-adjacent metadata, not secret content).
//   - **Round 4.** `process-exec* /bin/sh` denied — Claude Code's OWN Bash
//     tool execs `/bin/sh` internally (measured directly: this denial fires
//     the moment the Bash tool runs, with no cortex-side shell invocation of
//     our own in the repro). FIX: added `"sh"` to the shared
//     `SANDBOX_EXEC_ALLOW_SEED` (session-sandbox.ts) — a genuine
//     compatibility-contract requirement, not strict-specific (the guarded
//     posture never enforced `execAllow` at all, so this addition is
//     previously-dead data becoming used, not a behavior change for
//     `guarded`).
//   - **Round 5.** Cortex's OWN hooks (`~/.claude/hooks/*.hook.ts`, or the
//     equivalent under a relocated config home) carry a `#!/usr/bin/env bun`
//     shebang (verified: `head -1` on this repo's installed hooks). The
//     kernel-level exec chain for EVERY hook invocation is therefore `env` →
//     `bun`, not just `bun` — `/usr/bin/env` itself needs `process-exec`.
//     FIX: added `"env"` to the same seed.
//   - **Round 6.** `file-read-data` denied on the bare `$HOME` and `/Users`
//     directories (not their contents — the literal directory entries
//     themselves; something in `claude`'s startup enumerates its own home's
//     top level). FIX: a narrow, NON-recursive `(literal …)` allow (not
//     `subpath`) for exactly those two paths — lists directory NAMES one
//     level deep, not file contents; the lowest-risk grant that resolved the
//     denial.
//   - **Round 7.** `/private/etc/ssl/cert.pem` (TLS root bundle) and
//     `/Library/Preferences/com.apple.networkd.plist` denied once the
//     session reached actual network I/O. FIX: explicit reads for both —
//     baseline OS/TLS plumbing every networked process needs, not session-
//     specific.
//   - **Git/gh.** The compatibility contract (design-session-sandbox.md §3,
//     -platforms.md §5) explicitly requires `git`/`gh` to keep working.
//     `execAllow`'s entries are resolved via `Bun.which` (the SAME `$PATH`
//     the spawned child inherits — `session-settings.ts` preserves `PATH`
//     unchanged for isolated sessions, so parent-side resolution and child-
//     side resolution agree) then realpath'd. On THIS host both are Homebrew
//     installs (`/opt/homebrew/bin/{git,gh}` → `Cellar/{git,gh}/<ver>/bin/…`)
//     — resolved binaries under a `/Cellar/<pkg>/<ver>/` tree get that whole
//     package root allow-listed too (read + map-executable), since Homebrew
//     binaries commonly dlopen/reference sibling files (share/templates,
//     libexec) within their OWN package tree. This is a DERIVED, HOST-
//     SPECIFIC finding, not a general guarantee — a non-Homebrew git install
//     (e.g. Xcode CLT's `/usr/bin/git`, or a bare-metal Linux-shaped install)
//     is NOT covered by the Cellar heuristic and gets only its literal binary
//     allow-listed; this is a disclosed residual (see the function doc)
//     pending measurement on a non-Homebrew host.
//
// ## THE keychain constraint (do not "fix" this away)
//
// `~/Library/Keychains` READ is unconditionally allowed (`file-read*`, both
// data and metadata) — `claude` authenticates via the OS keychain, and E-KC
// (measured on a real host, this epic) found that denying keychain reads —
// even narrowed to `file-read-data` alone — breaks login outright ("Not
// logged in · Please run /login"). This is the IDENTICAL empirical finding
// `builtinSensitiveDenyEntries` (v1 `guarded`) already documents for its own
// WRITE-only keychain carve-out; `strict` inherits the SAME constraint in
// allow-set form: keychain read is unconditionally on the allow list, write
// is NOT (omitted from every allow rule ⇒ denied by `(deny default)`,
// exactly like every other unlisted operation). **`strict` therefore cannot
// protect keychain CONTENTS from a compromised session** — an injected
// prompt that gets the agent to read+exfiltrate its own keychain data still
// succeeds at the FS layer (the egress-proxy/L3 layer is the only thing that
// could then contain exfiltration, and only for cooperating-client traffic).
// This is a disclosed, permanent residual, not a bug to chase — see the
// design doc's own residual list (§5) for the parallel `gh`/git-credential
// finding this generalizes.
//
// ## Network — NOT this layer's job
//
// `(allow network*)` is unconditional here. `strict`'s whole point is
// FILESYSTEM confinement (F1); per-host network filtering is Layer 3's job
// (`egress-proxy.ts`'s cooperating-client HTTP CONNECT proxy) — SBPL's own
// host-based network primitives are coarse/unreliable (design doc §4.3), and
// `strict` does not attempt to duplicate that boundary at the kernel level.
// This is the SAME scope split `guarded` (v1) already has (it also allows
// all network via `(allow default)`) — `strict` is not a regression here,
// only an improvement on the FS dimension.
// -----------------------------------------------------------------------------

export interface MacosSbplStrictProfileOpts {
  /** Override `$HOME` (tests). Defaults to `os.homedir()`. */
  homeDir?: string;
  /**
   * Override the resolved claude-code config home (hooks/settings/session-
   * state/events dir). Defaults to the SAME resolution `cc-session.ts` uses
   * for `skillSourceDir` — `activeConfigHomeEnv("claude-code")?.value ??
   * join(homeDir, ".claude")` — so a deployment that relocated its config
   * home (the `substrates:` block) gets the SAME directory allow-listed
   * here that the session actually reads/writes. Tests override this
   * directly rather than mutating the process-wide `activeConfigHomeEnv`
   * singleton.
   */
  configHomeDir?: string;
  /**
   * Additional session-internal read-only paths (cortex#2409 part 2 — see
   * `SandboxProfile.internalReadOnly`'s doc: today, the per-session
   * isolated-settings temp dir). Named to mirror v1's `extraDenyPaths` —
   * the generic escape hatch for "another path this generator doesn't know
   * about by name".
   */
  internalReadOnlyPaths?: string[];
}

export interface MacosSbplStrictProfile {
  /** The compiled SBPL text — write verbatim to a `.sb` file. */
  text: string;
  /** Every input path that failed to realpath-resolve, and why — FAIL
   *  CLOSED: an unresolvable ALLOW input is excluded from `text` (never
   *  silently trusted unresolved), exactly like v1's `unresolved` handling,
   *  just mirrored for the opposite (allow, not deny) direction. */
  unresolved: { input: string; reason: string }[];
  /** Every resolved (realpath'd) root actually allowed — for tests/logging. */
  resolvedAllowPaths: string[];
}

/** `.../Cellar/<pkg>/<version>/...` → `.../Cellar/<pkg>/<version>` — the
 *  Homebrew package-root heuristic from Round "Git/gh" above. `undefined`
 *  when `resolvedPath` isn't under a `/Cellar/` tree (a non-Homebrew
 *  install) — the caller then allow-lists only the literal binary, a
 *  disclosed residual for non-Homebrew hosts. Exported for unit tests. */
export function homebrewPackageRoot(resolvedPath: string): string | undefined {
  const marker = "/Cellar/";
  const idx = resolvedPath.indexOf(marker);
  if (idx === -1) return undefined;
  const afterCellar = resolvedPath.slice(idx + marker.length);
  const segments = afterCellar.split("/");
  const pkg = segments[0];
  const version = segments[1];
  if (!pkg || !version) return undefined;
  return resolvedPath.slice(0, idx + marker.length) + pkg + "/" + version;
}

/**
 * Classify a hook file's realpath against arc's package-repos root
 * (`resolveArcPackReposDir` — the SAME resolver `cortex.ts`'s exec-brain pack
 * loader uses, reused rather than re-derived) — Round 5's discovery that
 * cortex's own hooks are commonly symlinks INTO an arc-managed repo checkout
 * (`~/.local/share/metafactory/arc/repos/<repo>/…`, verified on this host:
 * `~/.claude/hooks/CortexBashGuard.hook.ts` → `…/arc/repos/cortex/src/runner/
 * hooks/bash-guard.hook.ts`). A hook run via `bun <file>` needs its sibling
 * source files too (bun resolves `import`s at the FILE level), so a symlink
 * target under the arc root gets its WHOLE repo checkout allow-listed
 * (read + map-executable, never write — self-modification of arc-managed
 * source stays denied); a target that resolves OUTSIDE the arc root (a
 * custom, non-arc-managed hook) gets only its own literal file allow-listed
 * — least-privilege for the case this function can't generalize about.
 * Exported for unit tests.
 */
export function classifyHookTarget(
  resolvedTarget: string,
  homeDir: string,
): { subpath: string } | { literal: string } {
  const arcRoot = resolveArcPackReposDir({ home: homeDir });
  const arcRootWithSep = arcRoot.endsWith("/") ? arcRoot : arcRoot + "/";
  if (resolvedTarget.startsWith(arcRootWithSep)) {
    const rest = resolvedTarget.slice(arcRootWithSep.length);
    const repo = rest.split("/")[0];
    if (repo) return { subpath: join(arcRoot, repo) };
  }
  return { literal: resolvedTarget };
}

/** One allow rule's inputs, kept structured (like v1's `DenyEntry`) so
 *  `generateMacosSbplStrictProfile` can report exactly which INPUT produced
 *  which resolved allow, for `unresolved` reporting. `"regex-in-dir"` is
 *  Round 8's addition: `input` is realpath-resolved as a DIRECTORY (the
 *  SAME E3 discipline as `subpath`/`literal`), then `regexSuffix` is
 *  appended after the escaped, resolved dir to match a whole FAMILY of
 *  sibling files whose exact names aren't individually predictable (atomic-
 *  write lockfile/tempfile siblings — see the `.claude.json` allow below). */
interface AllowEntry {
  input: string;
  kind: "subpath" | "literal" | "regex-in-dir";
  ops: readonly string[];
  regexSuffix?: string;
}

function pushAllow(
  entries: AllowEntry[],
  input: string,
  kind: "subpath" | "literal",
  ops: readonly string[],
): void {
  entries.push({ input, kind, ops });
}

function pushRegexInDirAllow(
  entries: AllowEntry[],
  dir: string,
  regexSuffix: string,
  ops: readonly string[],
): void {
  entries.push({ input: dir, kind: "regex-in-dir", ops, regexSuffix });
}

/** Escape ERE metacharacters in a literal path so it can be embedded in an
 *  SBPL `(regex #"…")` pattern as a LITERAL prefix (not reinterpreted as
 *  regex syntax) — the path-side half of Round 8's `.claude.json` family
 *  match. Applied BEFORE {@link sbplQuoteRegexLiteral} (the separate SBPL-
 *  string-literal escaping for the resulting pattern text). */
function regexEscapePathForSbpl(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Escape a completed REGEX PATTERN string for embedding in an SBPL
 * `(regex #"…")` literal. Deliberately NOT {@link sbplQuote}: measured
 * directly on this host (`sandbox-exec`, two minimal profiles differing
 * only in this) that SBPL's `#"…"` string literal does NOT process `\\` as
 * a backslash-escape the way `sbplQuote` assumes for `subpath`/`literal`
 * paths — doubling a pattern's regex backslashes (`\.` → `\\.`) makes the
 * SBPL parser treat them as two LITERAL characters (`\` then `.`, i.e. an
 * escaped backslash followed by a wildcard-any-char `.`), which no longer
 * matches the intended literal dot and silently stops matching the target
 * file at all — confirmed: a `(regex #"…a\\.txt$")` profile denied a read
 * `(regex #"…a\.txt$")` correctly allowed, same file, same profile
 * otherwise. Only `"` needs escaping here — a regex pattern built by THIS
 * module never legitimately contains one (paths don't), but the discipline
 * (never trust a segment to not need it) matches `sbplQuote`'s own stance
 * on `"`. */
function sbplQuoteRegexLiteral(pattern: string): string {
  return pattern.replace(/"/g, '\\"');
}

/**
 * EBH-3a follow-on, cortex#2409 part 2 — generate the DD-10 v2 `strict`
 * SBPL profile: `(deny default)` + the derived explicit-allow set documented
 * in this module's section doc above. Every allow root is realpath-resolved
 * via {@link resolveProspectiveRealpath} BEFORE being written into the
 * profile text — the SAME E3 discipline v1's generator applies to its DENY
 * rules, mirrored here for ALLOW rules: under `(deny default)`, an allow
 * authored against an unresolved symlink alias would silently fail to
 * match — the analogous failure to E3, just inverted (a control that looks
 * granted and isn't, instead of denied and isn't).
 */
export function generateMacosSbplStrictProfile(
  profile: SandboxProfile,
  opts: MacosSbplStrictProfileOpts = {},
): MacosSbplStrictProfile {
  const homeDir = opts.homeDir ?? homedir();
  const defaultConfigHomeDir = join(homeDir, ".claude");
  const configHomeDir = opts.configHomeDir ?? activeConfigHomeEnv("claude-code")?.value ?? defaultConfigHomeDir;

  const entries: AllowEntry[] = [];

  // --- claude-code top-level JSON state file (Round 8 — measured directly
  //     on a real host): `claude` reads/writes a `.claude.json` (auth/
  //     project-history bookkeeping) that is NOT a child of the config-home
  //     DIRECTORY in the default case — it sits at `<homeDir>/.claude.json`,
  //     a SIBLING of `<homeDir>/.claude/` (verified: file mtime updated by a
  //     real session run against the default config home). When the config
  //     home is RELOCATED (`CLAUDE_CONFIG_DIR`/`activeConfigHomeEnv`), the
  //     json file moves WITH it, nested INSIDE the relocated dir instead
  //     (verified the same way against a relocated config home on this
  //     host: `<relocated-dir>/.claude.json`). Neither shape is a `subpath`
  //     of `configHomeDir` in the default case, so this needs its own
  //     explicit allow rather than falling out of the broad configHomeDir
  //     grant below. `claude` ALSO writes this file via the standard
  //     atomic-write idiom — a `.claude.json.lock` lockfile plus
  //     `.claude.json.tmp.<pid>.<hash>` scratch files with unpredictable
  //     names (both measured directly: denied on a real run) — so a single
  //     `literal` allow for `.claude.json` itself is not enough; the whole
  //     sibling FAMILY needs an allow, hence `regex-in-dir` rather than
  //     `literal`.
  const claudeJsonDir = configHomeDir === defaultConfigHomeDir ? homeDir : configHomeDir;
  pushRegexInDirAllow(entries, claudeJsonDir, "/\\.claude\\.json(\\..*)?$", [
    "file-read*",
    "file-write*",
  ]);

  // --- per-project tool/MCP cache dir (Round 8) — `claude` creates
  //     `~/Library/Caches/claude-cli-nodejs/<escaped-cwd>/` keyed by the
  //     session's escaped absolute cwd; the exact per-project leaf name
  //     isn't predictable without re-implementing claude's own escaping, so
  //     the stable PARENT is allow-listed (cache data, not credentials —
  //     same low-sensitivity class as `file-read-metadata`/network prefs
  //     above).
  pushAllow(
    entries,
    join(homeDir, "Library", "Caches", "claude-cli-nodejs"),
    "subpath",
    ["file-read*", "file-write*"],
  );

  // --- claude CLI's own version-lock dir (Round 8) — `~/.local/state/
  //     claude/locks/<version>.lock`, written via the same atomic-write
  //     idiom as `.claude.json` (an unpredictable `.lock.tmp.<hash>`
  //     scratch file first — measured directly: denied on a real run).
  //     Unlike `.claude.json` (a file with SIBLINGS in a shared directory
  //     that must not be broadly opened up), this whole dir is claude's OWN
  //     dedicated lock-file directory — a plain `subpath` allow is simpler
  //     and just as correctly scoped.
  pushAllow(
    entries,
    join(homeDir, ".local", "state", "claude", "locks"),
    "subpath",
    ["file-read*", "file-write*"],
  );

  // --- workspace: readWrite / readOnly / internalReadOnly (session policy) ---
  for (const dir of profile.readWrite) {
    pushAllow(entries, dir, "subpath", ["file-read*", "file-write*"]);
  }
  for (const dir of profile.readOnly) {
    // F6, same construction as v1: read-only means read-only, no write allow.
    pushAllow(entries, dir, "subpath", ["file-read*"]);
  }
  for (const dir of [...profile.internalReadOnly, ...(opts.internalReadOnlyPaths ?? [])]) {
    pushAllow(entries, dir, "subpath", ["file-read*"]);
  }

  // --- claude-code config home: hooks / settings / session+resume state / events ---
  pushAllow(entries, configHomeDir, "subpath", ["file-read*", "file-write*"]);

  // --- execAllow: resolve each compat-contract binary via $PATH, then realpath ---
  const execResolutions: { name: string; real: string }[] = [];
  const unresolvedInputs: { input: string; reason: string }[] = [];
  for (const name of profile.execAllow) {
    const which = Bun.which(name);
    if (which === null) {
      unresolvedInputs.push({ input: name, reason: `"${name}" not found on $PATH` });
      continue;
    }
    const resolved = resolveProspectiveRealpath(which);
    if (!resolved.ok) {
      unresolvedInputs.push({ input: which, reason: resolved.reason });
      continue;
    }
    execResolutions.push({ name, real: resolved.real });
    pushAllow(entries, resolved.real, "literal", ["process-exec", "file-read*", "file-map-executable"]);
    const pkgRoot = homebrewPackageRoot(resolved.real);
    if (pkgRoot) {
      pushAllow(entries, pkgRoot, "subpath", ["file-read*", "file-map-executable"]);
    }
  }

  // --- security CLI (keychain access helper `claude` shells out to, Round 3) ---
  const securityWhich = Bun.which("security") ?? "/usr/bin/security";
  const securityResolved = resolveProspectiveRealpath(securityWhich);
  if (securityResolved.ok) {
    pushAllow(entries, securityResolved.real, "literal", ["process-exec", "file-read*"]);
  } else {
    unresolvedInputs.push({ input: securityWhich, reason: securityResolved.reason });
  }

  // --- hooks: symlinked targets outside configHomeDir (Round 5) ---
  const hooksDir = join(configHomeDir, "hooks");
  let hookEntries: string[] = [];
  try {
    hookEntries = readdirSync(hooksDir);
  } catch {
    // No hooks dir (yet) — nothing to enumerate. Not a resolution failure;
    // the broad configHomeDir allow above already covers hooksDir once it
    // exists (a non-symlinked hook file is read straight from there).
  }
  const seenHookAllows = new Set<string>();
  for (const name of hookEntries) {
    const hookPath = join(hooksDir, name);
    const resolved = resolveProspectiveRealpath(hookPath);
    if (!resolved.ok) {
      unresolvedInputs.push({ input: hookPath, reason: resolved.reason });
      continue;
    }
    // Only symlink TARGETS that land OUTSIDE configHomeDir need a separate
    // allow — a hook whose realpath is still under configHomeDir (a plain,
    // non-symlinked file, or a symlink within the same tree) is already
    // covered by the broad configHomeDir allow above.
    const configHomeWithSep = configHomeDir.endsWith("/") ? configHomeDir : configHomeDir + "/";
    if (resolved.real === configHomeDir || resolved.real.startsWith(configHomeWithSep)) continue;
    const classified = classifyHookTarget(resolved.real, homeDir);
    const key = "subpath" in classified ? classified.subpath : classified.literal;
    if (seenHookAllows.has(key)) continue;
    seenHookAllows.add(key);
    if ("subpath" in classified) {
      pushAllow(entries, classified.subpath, "subpath", ["file-read*", "file-map-executable"]);
    } else {
      pushAllow(entries, classified.literal, "literal", ["file-read*", "file-map-executable"]);
    }
  }

  // --- keychain: READ only (THE keychain constraint — see section doc) ---
  pushAllow(entries, join(homeDir, "Library", "Keychains"), "subpath", ["file-read*"]);

  // --- realpath-resolve + emit every collected allow entry ---
  const unresolved: { input: string; reason: string }[] = [...unresolvedInputs];
  const resolvedAllowPaths = new Set<string>();
  const bodyLines: string[] = [];
  for (const entry of entries) {
    const resolution = resolveProspectiveRealpath(entry.input);
    if (!resolution.ok) {
      unresolved.push({ input: entry.input, reason: resolution.reason });
      continue;
    }
    resolvedAllowPaths.add(resolution.real);
    if (entry.kind === "regex-in-dir") {
      const pattern =
        "^" + regexEscapePathForSbpl(resolution.real) + (entry.regexSuffix ?? "");
      bodyLines.push(`(allow ${entry.ops.join(" ")} (regex #"${sbplQuoteRegexLiteral(pattern)}"))`);
      continue;
    }
    const matcher = entry.kind === "subpath" ? "subpath" : "literal";
    bodyLines.push(
      `(allow ${entry.ops.join(" ")} (${matcher} "${sbplQuote(resolution.real)}"))`,
    );
  }

  // --- self-modification carve-out WITHIN the allowed config home (parity
  //     with v1's F6/self-mod deny — a narrower deny still wins over a
  //     broader allow that precedes it in SBPL's rule evaluation, the same
  //     mechanism v1 relies on for its readOnly-dir write-denies) ---
  const configHomeReal = resolveProspectiveRealpath(configHomeDir);
  const selfModDenyLines: string[] = [];
  if (configHomeReal.ok) {
    selfModDenyLines.push(
      `(deny file-write* (subpath "${sbplQuote(join(configHomeReal.real, "hooks"))}"))`,
      `(deny file-write* (literal "${sbplQuote(join(configHomeReal.real, "settings.json"))}"))`,
    );
  }

  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")', // Round 1/2 — fixes E4's SIGABRT; dyld/mach/sysctl bootstrap base.
    "(allow file-read-metadata)", // matches application.sb/bsd.sb baseline — stat-only, not content.
    "(allow process-fork)", // matches application.sb baseline — needed for security/git/env/bun.
    "(allow network*)", // NOT this layer's job — see section doc "Network".
    "(allow user-preference-read)", // Round 3 — security's keychain-query preference reads.
    '(allow mach-lookup (global-name "com.apple.securityd.xpc") (global-name "com.apple.SecurityServer"))', // Round 3
    `(allow file-read-data (literal "${sbplQuote(homeDir)}") (literal "/Users"))`, // Round 6 — bare-dir listing only, non-recursive.
    '(allow file-read* (subpath "/private/etc/ssl"))', // Round 7 — TLS root bundle.
    '(allow file-read* (literal "/Library/Preferences/com.apple.networkd.plist"))', // Round 7
    '(allow file-read* (literal "/private/etc/hosts"))',
    '(allow file-read* (literal "/private/etc/resolv.conf"))',
    '(allow file-ioctl (literal "/dev/null"))', // Round 8 — a tty-check-shaped ioctl on /dev/null, denied on a real run.
    '(allow process-exec file-read* (literal "/bin/ps"))', // Round 8 — claude's own process-tree probing at startup.
    // Round 9 — `/bin/sh` on this macOS (26.5.1) is a small ~100KB "variant
    // selector" stub that internally re-execs a FIXED system path
    // (`/bin/bash`) for a shell invocation shape a real Bash-tool command
    // uses — NOT whatever `bash` resolves to on $PATH (measured directly:
    // this dev host's $PATH resolves `bash` to a Homebrew install via
    // `execAllow`'s normal Bun.which resolution, which does NOT satisfy the
    // OS's internal fixed-path re-exec — `sandbox-exec` reported "Failed to
    // exec /bin/bash as variant for /bin/sh" even with Homebrew's bash
    // allow-listed). So the SYSTEM `/bin/sh` and `/bin/bash` are allow-
    // listed here as fixed literals, unconditionally — independent of
    // whatever `execAllow`'s "sh"/"bash" entries resolve to via $PATH.
    '(allow process-exec file-read* (literal "/bin/sh"))',
    '(allow process-exec file-read* (literal "/bin/bash"))',
    ...bodyLines,
    ...selfModDenyLines,
  ];

  return {
    text: lines.join("\n") + "\n",
    unresolved,
    resolvedAllowPaths: [...resolvedAllowPaths],
  };
}

// -----------------------------------------------------------------------------
// DD-9 canary self-test — proves the E3 failure specifically, every session
// -----------------------------------------------------------------------------

export interface CanaryResult {
  passed: boolean;
  detail: string;
}

/**
 * The child script run UNDER the canary's sandbox-exec wrapper. Reads the
 * canary file via `fs.readFileSync` and prints a machine-parseable line —
 * deliberately NOT shelling out to `cat` and parsing its stderr text (E2
 * already proved bun's own `readFileSync` surfaces `EPERM` directly; using
 * the SAME runtime the real session uses is also more representative than a
 * coreutils proxy).
 */
const CANARY_READ_SCRIPT =
  'try { require("fs").readFileSync(process.argv[1]); console.log("READ_OK"); } ' +
  'catch (e) { console.log("ERR:" + (e && e.code ? e.code : "UNKNOWN")); }';

interface CanaryFixture {
  unresolvedFile: string;
  resolvedReal: string;
  isRealShape: boolean;
  profilePath: string;
  cleanup: () => void;
}

type CanaryFixtureResult = { ok: true; fixture: CanaryFixture } | { ok: false; result: CanaryResult };

/**
 * Shared setup for {@link runMacosCanarySelfTest} (async) and its
 * synchronous sibling used at `spawn()`'s synchronous call site — creates
 * the `/tmp`-aliased fixture file, resolves its realpath, and writes the
 * deny-by-realpath `.sb` profile. Kept as ONE function so the fixture
 * shape, the `/tmp` choice (§ module doc), and the realpath discipline can
 * never drift between the two call sites — only "how do we wait for the
 * subprocess" (sync vs async) differs at the two call sites.
 */
function prepareCanaryFixture(): CanaryFixtureResult {
  const marker = `cortex-sbpl-canary-${randomUUID()}`;
  // `/tmp` is used deliberately (not `os.tmpdir()`, which on macOS is
  // typically a per-user `/var/folders/.../T/` path with NO symlink
  // indirection) — `/tmp` IS the well-known symlink to `/private/tmp` that
  // E3 measured failing, so this is the real E3 shape, not a proxy for it.
  const unresolvedDir = join("/tmp", marker);
  const unresolvedFile = join(unresolvedDir, "canary.txt");
  let profileDir: string | undefined;

  const cleanupAll = (): void => {
    try {
      rmSync(unresolvedDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — a leftover canary temp dir is not a
      // correctness issue, only tidiness, and must never mask the result.
    }
    if (profileDir) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        // Same rationale.
      }
    }
  };

  try {
    mkdirSync(unresolvedDir, { recursive: true });
    writeFileSync(unresolvedFile, "canary-do-not-read");

    const resolution = resolveProspectiveRealpath(unresolvedDir);
    if (!resolution.ok) {
      cleanupAll();
      return {
        ok: false,
        result: {
          passed: false,
          detail: `canary setup could not realpath-resolve its own fixture dir: ${resolution.reason}`,
        },
      };
    }
    // Sanity: the whole point of this canary is that resolvedDir DIFFERS
    // from unresolvedDir (that's the E3 shape). On a host where /tmp is NOT
    // a symlink (not macOS, or a future macOS that changes this), the two
    // would be equal and the canary degrades to a same-path check — still a
    // meaningful (if less pointed) proof, so it isn't refused, but is noted.
    const isRealShape = resolution.real !== unresolvedDir;

    profileDir = mkdtempSync(join(tmpdir(), "cortex-sbpl-canary-profile-"));
    const profilePath = join(profileDir, "canary.sb");
    writeFileSync(
      profilePath,
      "(version 1)\n(allow default)\n" +
        `(deny file-read* (subpath "${sbplQuote(resolution.real)}"))\n`,
    );

    return {
      ok: true,
      fixture: {
        unresolvedFile,
        resolvedReal: resolution.real,
        isRealShape,
        profilePath,
        cleanup: cleanupAll,
      },
    };
  } catch (err) {
    cleanupAll();
    return {
      ok: false,
      result: {
        passed: false,
        detail: `canary self-test threw during setup: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * Shared interpretation of the canary child's stdout — the DD-9 pass/fail
 * logic (§4 "require an EXPLICIT EPERM… not sufficient evidence" — see
 * {@link runMacosCanarySelfTest}'s doc for the full rationale). Both call
 * sites (sync and async) feed this the SAME classification, so a change to
 * what counts as "passed" can't drift between them.
 */
function interpretCanaryOutput(trimmed: string, fixture: CanaryFixture): CanaryResult {
  if (trimmed === "ERR:EPERM") {
    return {
      passed: true,
      detail:
        `canary correctly denied (EPERM) reading the unresolved alias "${fixture.unresolvedFile}" ` +
        `under a deny rule authored against the resolved "${fixture.resolvedReal}"` +
        (fixture.isRealShape
          ? ""
          : " (NOTE: host's /tmp is not a symlink — degraded, same-path proof)"),
    };
  }
  if (trimmed === "READ_OK") {
    return {
      passed: false,
      detail:
        "CRITICAL (E3): the canary read via the UNRESOLVED alias SUCCEEDED even though the " +
        `deny rule targets its resolved realpath ("${fixture.resolvedReal}") — the sandbox is ` +
        "silently inert for symlink-aliased paths on this host/build.",
    };
  }
  return {
    passed: false,
    detail: `canary produced an unexpected result (not READ_OK or ERR:EPERM): "${trimmed}"`,
  };
}

/**
 * DD-9 — run the canary self-test that proves symlink-aware deny matching
 * held for THIS host, THIS session (design-session-sandbox-platforms.md
 * §4 DD-9, and this repo's own -platforms.md doc's "must exercise the
 * symlink-alias failure, not a proxy for it"). Exact required shape:
 *
 *   1. author the deny rule against the RESOLVED path (`/private/tmp/<marker>`)
 *   2. attempt the read via the UNRESOLVED alias (`/tmp/<marker>`)
 *   3. require an EXPLICIT `EPERM` — "the read did not succeed" alone is not
 *      sufficient evidence (a missing file also fails that way).
 *
 * ASYNC entry point — used by tests and any future async caller. `spawn()`
 * itself (synchronous, per the `SessionSandbox` interface) calls
 * {@link runMacosCanarySelfTestSync} instead; both share
 * {@link prepareCanaryFixture}/{@link interpretCanaryOutput} so the fixture
 * shape and pass/fail logic cannot drift between them.
 */
export async function runMacosCanarySelfTest(): Promise<CanaryResult> {
  const prepared = prepareCanaryFixture();
  if (!prepared.ok) return prepared.result;
  const { fixture } = prepared;
  try {
    const proc = Bun.spawn(
      ["sandbox-exec", "-f", fixture.profilePath, "bun", "-e", CANARY_READ_SCRIPT, fixture.unresolvedFile],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return interpretCanaryOutput(stdout.trim(), fixture);
  } catch (err) {
    return {
      passed: false,
      detail: `canary self-test threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    fixture.cleanup();
  }
}

/**
 * Synchronous sibling of {@link runMacosCanarySelfTest} for `spawn()`'s
 * synchronous call site — `Bun.spawnSync` gives a blocking subprocess
 * primitive. Shares the SAME fixture setup and result interpretation as the
 * async version (see those functions); only the "wait for the subprocess"
 * step differs.
 */
function runMacosCanarySelfTestSync(): CanaryResult {
  const prepared = prepareCanaryFixture();
  if (!prepared.ok) return prepared.result;
  const { fixture } = prepared;
  try {
    const result = Bun.spawnSync(
      ["sandbox-exec", "-f", fixture.profilePath, "bun", "-e", CANARY_READ_SCRIPT, fixture.unresolvedFile],
      { stdout: "pipe", stderr: "pipe" },
    );
    return interpretCanaryOutput(result.stdout.toString().trim(), fixture);
  } catch (err) {
    return {
      passed: false,
      detail: `canary self-test threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    fixture.cleanup();
  }
}

// -----------------------------------------------------------------------------
// Denial observation — tail the unified log for THIS session's pid
// -----------------------------------------------------------------------------

/** `Sandbox: NAME(PID) deny(N) OPERATION RESOURCE` — verified against this
 *  host's actual `log stream --style ndjson` output (both `file-read-data`
 *  and `file-write-create` operations), 2026-07-25. `RESOURCE` is a path for
 *  file operations; kept as a generic capture group since a future operation
 *  class (e.g. `mach-lookup`) reads the same shape with a service name
 *  instead of a path. */
const SANDBOX_DENIAL_RE = /^Sandbox: (\S+)\((\d+)\) deny\((\d+)\) (\S+) (.*)$/;

interface LogStreamEventMessage {
  eventMessage?: string;
  timestamp?: string;
}

/**
 * Parse one `log stream --style ndjson` line into a {@link SandboxDenial},
 * or `undefined` if the line isn't a denial for `pid` (noise, a different
 * process's denial, or a malformed/non-JSON line — `log stream` occasionally
 * emits a non-JSON preamble line ("Filtering the log data using…") which
 * must not throw). Exported for unit tests — this is the part that doesn't
 * need a real `log stream` subprocess to verify.
 */
export function parseSandboxDenialLogLine(line: string, pid: number): SandboxDenial | undefined {
  let parsed: LogStreamEventMessage;
  try {
    parsed = JSON.parse(line) as LogStreamEventMessage;
  } catch {
    return undefined;
  }
  const message = parsed.eventMessage;
  if (typeof message !== "string") return undefined;

  const match = SANDBOX_DENIAL_RE.exec(message);
  if (!match) return undefined;
  const [, , pidStr, , op, resource] = match;
  if (Number(pidStr) !== pid) return undefined;

  return {
    path: resource,
    reason: `${op} denied`,
    timestamp: parsed.timestamp ?? new Date().toISOString(),
  };
}

/**
 * Tail `log stream` for denials attributed to `pid`, yielding a
 * {@link SandboxDenial} per matching line. The predicate is scoped to the
 * pid at the log-query layer (`eventMessage CONTAINS "(<pid>) deny"`) so we
 * only pay JSON-parse cost for lines that are at least plausibly ours — a
 * pid is a cortex-controlled integer here (from `Bun.spawn`), never
 * attacker-influenced, so string-interpolating it into the predicate is
 * safe. See the module doc's "Known observability gap" for the ~1s
 * startup-latency caveat this was empirically measured against.
 */
async function* tailSandboxDenials(pid: number, signal: AbortSignal): AsyncIterable<SandboxDenial> {
  const proc = Bun.spawn(
    [
      "log",
      "stream",
      "--style",
      "ndjson",
      "--predicate",
      `eventMessage CONTAINS "(${pid}) deny"`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );

  const onAbort = (): void => {
    try {
      proc.kill();
    } catch {
      // Already exited — nothing to clean up.
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    // `stdout: "pipe"` above statically narrows `proc.stdout` to a
    // `ReadableStream` (never the `number`/fd-passthrough arm) — no runtime
    // check needed, unlike a caller that accepts caller-supplied spawn opts
    // (e.g. `cc-session.ts`'s `pipeStdout`, which does need the check).
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const denial = parseSandboxDenialLogLine(line, pid);
          if (denial) yield denial;
        }
      }
    } catch (_err) {
      // Stream closed (process killed on abort, or `log stream` itself
      // exited) — expected, not an error to surface.
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      proc.kill();
    } catch {
      // Already exited.
    }
  }
}

// -----------------------------------------------------------------------------
// MacosSbplSandbox — the SessionSandbox implementation
// -----------------------------------------------------------------------------

/**
 * EBH-3a's real macOS backend. `mode`-gated (design doc DD-5):
 *
 *   - `"off"`   — byte-identical `Bun.spawn(argv, opts)` pass-through. No
 *     `.sb` profile is generated, no canary runs, no `log stream` starts.
 *     This is what makes resolving a REAL backend here safe even though
 *     `SandboxProfile.mode` defaults to `"off"` on every live dispatch path
 *     today — resolving `macos-sbpl` is not the same as enforcing anything.
 *   - `"audit"` — the v1 `guarded` profile IS applied for real (SBPL has no
 *     genuine report-only primitive — see the module doc's posture
 *     rationale). The DD-9 canary runs; on failure this is LOGGED (a
 *     possibly-inert profile this run) but the session still launches — no
 *     worse than `"off"`. Denials are observed and reported via `denials()`.
 *   - `"enforce"` — same as `"audit"`, EXCEPT a failed canary REFUSES to
 *     launch (throws) — DD-9's fail-closed requirement. Built and tested per
 *     the cortex#2345 HARD HOLD ("wire the mechanism… do not enable it") —
 *     no live caller ever sets `mode: "enforce"` in this build.
 */
export class MacosSbplSandbox implements SessionSandbox {
  readonly backend = "macos-sbpl" as const;

  private denialAbort: AbortController | undefined;
  /** Set once `spawn()` decides to apply a profile, so `denials()` (called
   *  separately, per the `SessionSandbox` interface) knows whether there is
   *  anything to observe. `undefined` (never spawned, or spawned in `"off"`
   *  mode) → `denials()` yields nothing, matching `NoneSandbox`. */
  private denialSource: AsyncIterable<SandboxDenial> | undefined;
  /** The most recent DD-9 canary result — `undefined` until `spawn()` has
   *  run one (i.e. before any `"audit"`/`"enforce"` spawn). */
  private lastCanary: CanaryResult | undefined;

  /** The most recent canary result, exposed for callers (tests, future
   *  status surfaces) that want to know whether THIS session's profile was
   *  proven non-inert. `undefined` before any `"audit"`/`"enforce"` spawn. */
  get canaryResult(): CanaryResult | undefined {
    return this.lastCanary;
  }

  spawn(argv: string[], profile: SandboxProfile, opts: SandboxSpawnOpts): Subprocess {
    if (profile.mode === "off") {
      // Byte-identical pass-through — see the class doc. No profile, no
      // canary, no log-stream watcher: a resolved-but-off backend must cost
      // nothing and change nothing, exactly like NoneSandbox.
      return Bun.spawn(argv, opts);
    }

    // Synchronous canary gate. DD-9 requires the canary to run "every
    // session" before that session's profile is trusted — spawn() is
    // synchronous (the whole `SessionSandbox` interface is), so this uses
    // Bun's synchronous spawn-and-wait primitive rather than restructuring
    // the choke point to be async. `Bun.spawnSync` mirrors `Bun.spawn`'s
    // exec semantics; the canary's own implementation is exercised
    // end-to-end (including its async path) by the dedicated canary tests —
    // this call site only needs pass/fail, synchronously.
    const canary = runMacosCanarySelfTestSync();
    this.lastCanary = canary;

    if (!canary.passed) {
      if (profile.mode === "enforce") {
        // DD-9 fail-closed — HELD (cortex#2345): no live caller sets
        // `mode: "enforce"`, but the mechanism must exist and be correct
        // for the day EBH-3's rollout (design doc §6 step 3) flips it.
        throw new Error(
          `[session-sandbox-macos] refusing to launch under enforce: DD-9 canary self-test ` +
            `failed — ${canary.detail}`,
        );
      }
      // audit — log loudly, but do not block. A possibly-inert profile in
      // audit mode is no worse than "off"; refusing to launch here would
      // make audit strictly more disruptive than the mode it exists to
      // de-risk (design doc §6).
      process.stderr.write(
        `[session-sandbox-macos] WARNING: DD-9 canary self-test failed in audit mode — this ` +
          `session's sandbox profile may be silently inert. ${canary.detail}\n`,
      );
    }

    // cortex#2409 part 2 — DD-10's TWO postures. `profile.posture` defaults
    // to `"guarded"` (deriveSandboxProfile's HARD HOLD) — only a caller that
    // EXPLICITLY sets `sandboxPosture: "strict"` reaches the new generator.
    const generated =
      profile.posture === "strict"
        ? generateMacosSbplStrictProfile(profile)
        : generateMacosSbplProfile(profile);
    if (generated.unresolved.length > 0) {
      const label = profile.posture === "strict" ? "allow-set" : "sensitive-set";
      const consequence =
        profile.posture === "strict"
          ? "NOT allowed this session (fail-closed exclusion — an unresolvable ALLOW input is " +
            "dropped, never silently trusted; the corresponding access is denied by (deny default))"
          : "NOT denied this session (fail-closed exclusion, not a fail-open grant)";
      process.stderr.write(
        `[session-sandbox-macos] ${generated.unresolved.length} ${label} path(s) could not be ` +
          `realpath-resolved and are ${consequence}: ` +
          generated.unresolved.map((u) => `"${u.input}" (${u.reason})`).join("; ") +
          "\n",
      );
    }

    const profileDir = mkdtempSync(join(tmpdir(), "cortex-sbpl-"));
    const profilePath = join(profileDir, "session.sb");
    writeFileSync(profilePath, generated.text);

    const proc = Bun.spawn(["sandbox-exec", "-f", profilePath, ...argv], opts);

    // Profile file cleanup — needed only until sandbox-exec has read it
    // (it's read once, at exec time), but kept alive until process exit for
    // debuggability (a principal inspecting a hung/misbehaving session can
    // read the exact profile it launched under).
    void proc.exited.finally(() => {
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        // Best-effort — a leftover temp profile is tidiness, not correctness.
      }
      this.denialAbort?.abort();
    });

    this.denialAbort = new AbortController();
    this.denialSource = tailSandboxDenials(proc.pid, this.denialAbort.signal);

    return proc;
  }

  async *denials(): AsyncIterable<SandboxDenial> {
    if (!this.denialSource) return; // "off" mode, or spawn() never called
    for await (const denial of this.denialSource) {
      yield denial;
    }
  }
}

// Re-exported so a future status surface (`cortex stack list`, per
// -platforms.md §6.5) can check "does this file even exist / is /tmp a
// symlink on this host" without re-deriving the check. Not currently
// consumed outside this module + its tests.
export function isPathLikelyResolvable(path: string): boolean {
  return existsSync(path);
}
