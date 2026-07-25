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
 *   - `~/.claude/settings.json` — WRITE only (self-modification)
 *   - `~/.claude/hooks/**` — WRITE only (self-modification; READ+EXEC stays
 *     allowed — the compatibility contract requires it)
 *   - every `readOnly` dir on the profile — WRITE only (F6)
 *   - any caller-supplied `extraDenyPaths` (read+write) — the generic escape
 *     hatch a caller (a test, or a future "other stacks" enumeration) uses to
 *     deny an out-of-scope root this module doesn't know about by name.
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

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Subprocess } from "bun";
import { resolveProspectiveRealpath } from "../common/path-containment";
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

    const generated = generateMacosSbplProfile(profile);
    if (generated.unresolved.length > 0) {
      process.stderr.write(
        `[session-sandbox-macos] ${generated.unresolved.length} sensitive-set path(s) could ` +
          `not be realpath-resolved and are NOT denied this session (fail-closed exclusion, ` +
          `not a fail-open grant): ` +
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
