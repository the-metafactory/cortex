/**
 * EBH-2 (cortex#2344) — `SessionSandbox` choke point + the `none` backend.
 * EBH-3a (cortex#2345) — lifts the HARD HOLD for macOS: {@link resolveSandboxBackend}
 * now resolves `"macos-sbpl"` when the boot probe proves it viable. The real
 * implementation lives in `session-sandbox-macos.ts` (kept out of this file
 * so the interfaces/probe/none-backend stay the small, stable core EBH-2
 * shipped — see that module's doc comment for the profile-generation,
 * canary, and denial-observation design).
 *
 * ## What this closes
 *
 * `docs/design-session-sandbox.md` (DD-1…DD-6) and
 * `docs/design-session-sandbox-platforms.md` (DD-7…DD-12, the empirical
 * findings E1–E8) design an OS-level jail around every `claude --print`
 * child, because EBH-1's six adversarial rounds proved a **string-parsing**
 * guard can be made fail-closed but never sound (TOCTOU, coverage drift —
 * see -platforms.md §1). This module is that jail's *shape* — the
 * `SessionSandbox` interface every real backend (`macos-sbpl`, EBH-3b's
 * `linux-bwrap`/`container-delegated`) implements — plus the `none` backend
 * (EBH-2) and the resolution wiring (EBH-3a) that picks between them.
 *
 * `none` spawns byte-identically to the pre-EBH-2 code (no kernel
 * enforcement — that's what "none" means) and loudly records that fact
 * (DD-4/DD-6/DD-7) so an unsandboxed host is never silent. It exists so
 * `cc-session.ts`'s spawn call has exactly ONE shape regardless of backend,
 * and so `macos-sbpl` (this slice) and `linux-bwrap`/`container-delegated`
 * (EBH-3b) drop in without touching the choke point (`cc-session.ts`'s
 * `start()`) at all.
 *
 * ## HARD HOLD — REMAINING SCOPE (EBH-3a is macOS-only; EBH-3b is not this slice)
 *
 * `linux-bwrap` and `container-delegated` are NOT implemented here — DD-8b's
 * real-topology acceptance gate (E5: `bwrap` fails even as root inside a
 * container's default seccomp/userns policy) needs its own dedicated slice.
 * {@link resolveSandboxBackend} resolves `"macos-sbpl"` on a Darwin host
 * where the probe proved `sandbox-exec` viable (E1/E2); every Linux/container
 * probe result still resolves to `"none"`, exactly as EBH-2 shipped.
 *
 * The **`mode` default is unaffected by this change** — {@link SandboxMode}
 * still defaults to `"off"` everywhere (`CCSessionOpts.sandboxMode`), and no
 * dispatch path threads a config-resolved `"audit"`/`"enforce"` value through
 * yet. Resolving a real `macos-sbpl` `SessionSandbox` instance is not the
 * same as ENFORCING anything: with `mode: "off"` (the only value any live
 * caller sets), `MacosSbplSandbox.spawn()` is a byte-identical pass-through,
 * identical to `NoneSandbox` — see `session-sandbox-macos.ts`.
 */

import { existsSync, readFileSync } from "fs";
import type { Subprocess } from "bun";
// EBH-3a — the real macOS backend. Kept in its own module (profile
// generation, the DD-9 canary, and unified-log denial parsing are
// substantial enough to want their own file); `session-sandbox-macos.ts`
// imports ONLY types back from this module (never a runtime value), so this
// is a one-directional runtime edge, not a circular import.
import { MacosSbplSandbox } from "./session-sandbox-macos";

// -----------------------------------------------------------------------------
// SandboxProfile — DD-1's kernel-level projection of the resolved policy
// -----------------------------------------------------------------------------

/** Staged rollout posture (design-session-sandbox.md DD-5). `off` is the
 *  ONLY default this build ships — see the cortex#2344 HARD HOLD. */
export type SandboxMode = "off" | "audit" | "enforce";

/**
 * cortex#2409 part 2 — DD-10's TWO filesystem postures, orthogonal to
 * {@link SandboxMode} (mode gates WHETHER the profile is enforced; posture
 * gates WHAT the profile's default rule is):
 *
 *   - `"guarded"` (DD-10 v1, EBH-3a) — `(allow default)` + an enumerated
 *     denylist of the sensitive set. Raises attacker cost; does NOT
 *     establish a boundary — the next unenumerated path is always
 *     available. THE DEFAULT, and the only posture any live caller sets.
 *   - `"strict"` (DD-10 v2, this slice) — `(deny default)` + a derived,
 *     documented, minimal explicit-allow set. F1 closed BY CONSTRUCTION for
 *     everything outside the allow set, not merely narrowed. See
 *     `session-sandbox-macos.ts`'s `generateMacosSbplStrictProfile` doc for
 *     the full allow-set derivation and its evidence trail.
 *
 * `"strict"` is additive — `"guarded"` keeps working unchanged, selected by
 * config the same way `"guarded"` always has been. HARD HOLD (cortex#2409
 * part 2, unchanged from every prior EBH slice): no caller in this build
 * sets `"strict"`; `deriveSandboxProfile` defaults every profile to
 * `"guarded"` when `CCSessionOpts.sandboxPosture` is unset.
 */
export type SandboxPosture = "guarded" | "strict";

/** Every backend `SessionSandbox` can resolve to. Only `"none"` has an
 *  implementation in this build (EBH-2); the rest are EBH-3/DD-8. */
export type SandboxBackendId =
  | "macos-sbpl"
  | "linux-bwrap"
  | "container-delegated"
  | "none";

/**
 * DD-1's kernel-level projection: the SAME resolved policy that also
 * produces the advisory preamble text and the CC `--allowedTools`/`--add-dir`
 * flags, projected into the shape a kernel backend needs. Kept as a
 * structured object (not a flattened string) so EBH-3 (real backends) and
 * EBH-4 (the egress proxy, #1192) extend it without touching call sites —
 * see design-session-sandbox.md §4.1.
 */
export interface SandboxProfile {
  /** Normalized dirs the session may read AND write. */
  readWrite: string[];
  /** Normalized dirs the session may read but never write — EBH-1b's split
   *  (F6): a dir present in both the caller's allowed and read-only sets
   *  resolves to read-only, never both. */
  readOnly: string[];
  /**
   * Binaries the session may exec. UNENFORCED by the `none` backend (and by
   * every backend until EBH-3 lands profile-generation for a real jail) —
   * seeded here from the compatibility contract (design-session-sandbox.md
   * §3, -platforms.md §5) so EBH-3 does not have to re-derive it.
   */
  execAllow: string[];
  /**
   * Hostnames the egress proxy will permit (EBH-4, #1192). UNENFORCED here —
   * same seeding rationale as {@link execAllow}.
   */
  egressAllow: string[];
  mode: SandboxMode;
  /**
   * cortex#2409 part 2 — DD-10's filesystem posture. Defaults to
   * `"guarded"` (see {@link SandboxPosture}'s doc for the HARD HOLD).
   * `generateMacosSbplProfile` (v1) ignores this field entirely — it is
   * ALWAYS `(allow default)` regardless of what's here, so an accidental
   * `"strict"` value reaching that generator can never silently upgrade
   * enforcement; only `generateMacosSbplStrictProfile` reads it (and only
   * `MacosSbplSandbox.spawn()`'s own posture branch decides which generator
   * runs — this field is data, not itself a switch).
   */
  posture: SandboxPosture;
  /**
   * cortex#2409 part 2 — session-internal read-only paths the STRICT
   * generator must allow that are neither the caller's `readWrite`/
   * `readOnly` policy dirs nor part of the static compatibility-contract
   * seed below: today, exactly the per-session isolated-settings temp dir
   * (`session-settings.ts`'s `IsolatedSettings.settingsPath`'s directory) —
   * `claude` reads its `--settings <path>` argument at startup, and under
   * `(deny default)` that random `os.tmpdir()`-rooted path needs an
   * explicit allow or every isolated session breaks. Distinct from
   * `readOnly` (F6's user-configured "read but never write" policy dirs) —
   * this is cortex's OWN plumbing, not part of the agent's granted work
   * scope, so it is kept as its own field rather than silently widening
   * `readOnly`'s meaning. `generateMacosSbplProfile` (v1) ignores this too
   * — `(allow default)` already covers it.
   */
  internalReadOnly: string[];
}

/**
 * Compatibility-contract seed lists (design-session-sandbox.md §3 "What the
 * sandbox must not break", -platforms.md §5). Static — not derived from any
 * particular session's opts — because the underlying need (reach the model
 * API, run `git`/`gh`) is the same for every session. `deriveSandboxProfile`
 * copies these onto every profile; EBH-3/EBH-4 are expected to extend them
 * with configured MCP/model-gateway hosts, not replace the mechanism.
 */
export const SANDBOX_EXEC_ALLOW_SEED: readonly string[] = Object.freeze([
  "claude",
  "bun",
  "node",
  "git",
  "gh",
  // cortex#2409 part 2 — added while deriving the v2 `strict` allow set
  // (previously dead data: `execAllow` had NO enforcing consumer before
  // this slice — grep confirms zero non-test reads — so this addition
  // changes no prior behavior). Both are genuine compatibility-contract
  // needs, not strict-specific: cortex's own hooks carry a
  // `#!/usr/bin/env bun` shebang (verified against this repo's installed
  // `~/.claude/hooks/*.hook.ts`), so the kernel-level exec chain for EVERY
  // hook invocation is `env` → `bun` — the shebang interpreter itself must
  // be exec-allowed, not just the ultimate `bun` it launches. `sh` is what
  // Claude Code's own Bash tool execs internally (measured directly: a real
  // `claude --print` session run under a naive strict profile denied
  // `process-exec* /bin/sh` the moment the Bash tool ran). `bash` is a
  // SEPARATE finding, also measured directly on this host (macOS 26.5.1):
  // `/bin/sh` here is not the interpreter itself but a small ~100KB
  // "variant selector" stub that internally re-execs `/bin/bash` for a
  // shell invocation of the shape a Bash-tool command actually uses (`sh -c
  // "…"` with a redirect) — `sandbox-exec` reported this exactly:
  // `Failed to exec /bin/bash as variant for /bin/sh (1: Operation not
  // permitted)`. Without `bash` on the seed too, `sh` alone is necessary
  // but not sufficient for a REAL shell command to run under `strict`.
  "env",
  "sh",
  "bash",
]);

/**
 * cortex#2412 follow-up (the `egress-proxy.ts` audit-mode fix) — a real
 * `audit`-mode run against this seed surfaced two hosts a hardened session
 * actually reaches that weren't on it. Both calls below were made
 * explicitly, not defaulted:
 *
 *   - `"mcp-proxy.anthropic.com"` — ADDED. claude.ai-connected MCP servers
 *     (task list, Drive, and the rest of that family) route through this
 *     host. Functional requirement, same tier as `"api.anthropic.com"`, not
 *     a convenience: under `enforce`, denying it silently breaks every MCP
 *     tool a session tries to use.
 *   - `"http-intake.logs.us5.datadoghq.com"` (third-party telemetry) —
 *     DELIBERATELY LEFT OUT. A hardened session has no functional need to
 *     reach it, and the entire point of a deny-by-default egress policy is
 *     that destinations without a functional need stay unreachable. It
 *     WILL be denied under `enforce` — documented here so that's discovered
 *     by reading this comment, not by a mystery failure.
 *   - `"localhost"` — ADDED. cortex's OWN hook scripts
 *     (`event-logger.hook.ts`, `path-guard.hook.ts`, `bash-guard.hook.ts`)
 *     run AS the sandboxed child (they're `claude` CC hooks, invoked BY the
 *     spawned `claude` process this proxy wraps) and POST their telemetry to
 *     `http://localhost:8766/api/events/ingest` by default
 *     (`CORTEX_INGEST_URL`, overridable). That's cortex's OWN control-plane
 *     event pipeline reaching cortex's OWN daemon on the SAME host — the
 *     opposite direction from what L3 defends against (a session
 *     exfiltrating data OUT to an attacker-controlled host). Denying it
 *     doesn't hold a security boundary; it just breaks cortex's own
 *     instrumentation for every hardened session — the exact failure that
 *     surfaced this whole bug (a real `audit` run showed this traffic being
 *     killed even in report-only mode, before the `egress-proxy.ts` fix that
 *     made `audit` non-terminating). Seeding it here means `enforce` won't
 *     newly break it either, once enforcement is ever turned on.
 *
 *     SCOPE CAVEAT: {@link isHostAllowed} (`egress-proxy.ts`) matches on
 *     HOSTNAME ONLY — `egressAllow` carries no port/path granularity. So
 *     this allows a session to reach ANY port on loopback, not just 8766;
 *     there's no mechanism today to say "8766 only." Same granularity every
 *     other seed entry already has (`"api.anthropic.com"` is really "any
 *     port on that host," every real client just happens to only use 443)
 *     — not a new category of looseness, but worth naming since loopback is
 *     more likely than a public hostname to have OTHER locally-run services
 *     behind it on the principal's machine. Port/path-scoped allowlisting
 *     would close that gap; it needs `egressAllow`/`isHostAllowed` to carry
 *     an optional port (and the proxy to check it) — a real follow-up, not
 *     something this fix does.
 */
export const SANDBOX_EGRESS_ALLOW_SEED: readonly string[] = Object.freeze([
  "api.anthropic.com",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "mcp-proxy.anthropic.com",
  "localhost",
]);

// -----------------------------------------------------------------------------
// SessionSandbox — DD-2's choke point interface
// -----------------------------------------------------------------------------

/** One denied access, surfaced by a real backend's kernel/audit log (DD-6).
 *  The `none` backend's {@link SessionSandbox.denials} never yields one —
 *  it enforces nothing, so nothing can be denied. `macos-sbpl` (EBH-3a,
 *  `session-sandbox-macos.ts`) parses macOS unified-log `Sandbox: NAME(PID)
 *  deny(N) OPERATION PATH` lines scoped to the spawned child's pid — see that
 *  module for the empirically-verified log shape. */
export interface SandboxDenial {
  path?: string;
  host?: string;
  reason: string;
  timestamp: string;
}

/**
 * The narrow slice of `Bun.spawn`'s options this module actually needs.
 * Deliberately NOT `Bun.SpawnOptions` — a backend implementation (and a
 * test double) only has to satisfy this shape, not Bun's full options
 * surface. Mirrors exactly what `cc-session.ts` passed to `Bun.spawn`
 * pre-EBH-2, so routing through a backend changes nothing about the call.
 */
export interface SandboxSpawnOpts {
  env: Record<string, string>;
  cwd?: string;
  stdout: "pipe";
  stderr: "pipe";
}

/**
 * `system.security.sandbox-unavailable` observability payload (DD-4/DD-6).
 * HYPHEN, not underscore, in the leaf — cortex#1935's regression gate
 * (`src/bus/__tests__/envelope-type-no-underscore.test.ts`) pins every
 * bus-envelope `type` literal to the vendored schema's
 * `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,4}$` pattern (hyphens only): an
 * underscored `system.*` type PUBLISHES without error and is then silently
 * DROPPED by every standard subscriber on delivery. Getting this wrong is
 * exactly the "documented but not real" failure this slice exists to avoid.
 *
 * Not yet a myelin wire envelope — a new `system.*` type is a wire/schema
 * change under `src/bus/CLAUDE.md`'s RFC governance, out of scope for this
 * structure-only slice. Emitted here as a plain, observable event so a
 * future bus publisher (EBH-3, or a follow-up) can turn it into one without
 * this module changing shape — the hyphenated name is what that publisher
 * MUST use verbatim. See `CCSession`'s `"security-event"` EventEmitter
 * emission in `cc-session.ts`.
 */
export interface SandboxUnavailableEvent {
  type: "system.security.sandbox-unavailable";
  backend: "none";
  mode: SandboxMode;
  timestamp: string;
}

/**
 * `system.security.sandbox-denial` observability payload (DD-6, EBH-3a) —
 * the bus-event projection of a {@link SandboxDenial} a real backend
 * observed. Same hyphenated-leaf discipline as {@link SandboxUnavailableEvent}
 * (cortex#1935's regression gate) and the same "not yet a myelin wire
 * envelope, plain EventEmitter payload for now" scoping: see that type's doc
 * comment — it applies here verbatim. Emitted by `CCSession` (`cc-session.ts`)
 * as it drains `SessionSandbox.denials()`, one event per observed denial.
 */
export interface SandboxDenialEvent {
  type: "system.security.sandbox-denial";
  backend: SandboxBackendId;
  mode: SandboxMode;
  path?: string;
  host?: string;
  reason: string;
  timestamp: string;
}

/**
 * DD-2 — the ONE choke point every `claude --print` spawn funnels through
 * (`cc-session.ts`'s `start()`). A boundary here holds regardless of which
 * dispatch path reached it — #1758 is exactly the proof that a boundary
 * higher up (DispatchHandler) is bypassable by an alternate path; the spawn
 * itself is not.
 */
export interface SessionSandbox {
  readonly backend: SandboxBackendId;
  /**
   * Spawn `argv[0]` (+ its args) under this backend's confinement. The
   * `none` backend spawns exactly as `Bun.spawn(argv, opts)` would have —
   * zero behaviour change is this slice's whole point.
   */
  spawn(argv: string[], profile: SandboxProfile, opts: SandboxSpawnOpts): Subprocess;
  /** Async stream of denials this backend has observed. `none` never yields
   *  (see the field doc on {@link SandboxDenial}). */
  denials(): AsyncIterable<SandboxDenial>;
}

/**
 * The pass-through backend (DD-4's third row). Spawns byte-identically to
 * the pre-EBH-2 code and, on the FIRST spawn only, fires
 * `onUnavailable` — so an un-jailed host is never silent (DD-4) without
 * spamming an event per tool call.
 *
 * "Once per session" (cortex#2344's acceptance criterion) means once per
 * `NoneSandbox` INSTANCE — and `cc-session.ts` constructs a fresh backend
 * per `CCSession.start()`, so that is exactly once per spawned session.
 */
export class NoneSandbox implements SessionSandbox {
  readonly backend: SandboxBackendId = "none";
  private announced = false;

  constructor(private readonly onUnavailable?: (event: SandboxUnavailableEvent) => void) {}

  spawn(argv: string[], profile: SandboxProfile, opts: SandboxSpawnOpts): Subprocess {
    if (!this.announced) {
      this.announced = true;
      this.onUnavailable?.({
        type: "system.security.sandbox-unavailable",
        backend: "none",
        mode: profile.mode,
        timestamp: new Date().toISOString(),
      });
    }
    // The pass-through: identical to the pre-EBH-2 `Bun.spawn(["claude",
    // ...args], {...})` call this replaces in cc-session.ts. No path,
    // env, or arg transformation happens here.
    return Bun.spawn(argv, opts);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface
  // contract (AsyncIterable); a pass-through backend enforces nothing and so
  // can never observe a denial. Kept async-shaped so a real backend's
  // implementation (which DOES await an audit-log tail) is a drop-in swap.
  async *denials(): AsyncIterable<SandboxDenial> {
    // Deliberately empty — see the field doc on `denials()`.
  }
}

/**
 * Construct the resolved `SessionSandbox` for a spawn.
 *
 * EBH-3a (cortex#2345) — now a REAL switch: when the boot probe has been
 * warmed (see {@link getCachedSandboxCapabilityProbeSync}) and resolves to
 * `"macos-sbpl"`, this constructs the real backend (`session-sandbox-macos.ts`).
 * Every other case — probe not yet warmed, resolves to `"none"`, or any
 * EBH-3b backend not yet implemented — falls back to `NoneSandbox`, BYTE-
 * IDENTICAL to EBH-2. This is a synchronous function (called from
 * `CCSession.start()`, itself synchronous) so it can only ever consult the
 * SYNC snapshot, never the async probe directly — see that getter's doc for
 * why an un-warmed probe is a safe, deliberate no-op fallback rather than a
 * blocking wait.
 */
export function createSessionSandbox(opts?: {
  onUnavailable?: (event: SandboxUnavailableEvent) => void;
}): SessionSandbox {
  const probe = getCachedSandboxCapabilityProbeSync();
  const backend = probe ? resolveSandboxBackend(probe) : "none";
  if (backend === "macos-sbpl") {
    return new MacosSbplSandbox();
  }
  return new NoneSandbox(opts?.onUnavailable);
}

// -----------------------------------------------------------------------------
// deriveSandboxProfile lives in cc-session.ts, beside resolvePathGuardEnv
// -----------------------------------------------------------------------------
//
// DD-1: one resolved policy, N projections. `resolvePathGuardEnv` already
// computes `allowedDirs MINUS readOnlyDirs` from the SAME `CCSessionOpts`
// fields this profile needs (EBH-1b, cortex#2352). Sitting the sandbox
// projection next to it — reusing its `splitGuardDirs` helper rather than
// re-deriving the subtraction — is what keeps the three projections
// (preamble / CC flags / kernel profile) from drifting apart. See
// `cc-session.ts`'s `deriveSandboxProfile`.

// -----------------------------------------------------------------------------
// Boot capability probe (DD-7) — detect, never assume; cache, never re-probe
// -----------------------------------------------------------------------------

/**
 * What the boot probe found, plus what it resolves to given ONLY the
 * backends actually implemented in this build. Exposed for a future
 * `cortex stack list`/status surface (-platforms.md §6.5) to read without
 * re-running any of the underlying checks.
 */
export interface SandboxCapabilityProbe {
  platform: NodeJS.Platform;
  /** `sandbox-exec` present on $PATH AND able to exec a trivial process
   *  under an `(allow default)` profile (macOS E1/E2). Always `false` off
   *  Darwin. */
  sandboxExecAvailable: boolean;
  /** `bwrap` present on $PATH. Always `false` off Linux. */
  bwrapAvailable: boolean;
  /** `bwrap` present AND its `--unshare-all` actually succeeds — E5 found
   *  this fails even as root inside a container's default seccomp/userns
   *  policy, so presence alone is not viability. Always `false` when
   *  `bwrapAvailable` is `false`. */
  bwrapUnshareWorks: boolean;
  /** Best-effort `/sys/kernel/security/lsm` read for `"landlock"`. `false`
   *  (not "unknown") when the file is unreadable — -platforms.md §2.1 notes
   *  this is genuinely unconfirmed inside a container; the probe never
   *  throws on it. */
  landlockAvailable: boolean;
  /** `/.dockerenv`, `/run/.containerenv`, or a docker/kubepods/containerd/
   *  libpod cgroup line for PID 1 — best-effort, never throws. */
  inContainer: boolean;
  /**
   * What `SessionSandbox` backend this build will actually construct.
   * HARD-PINNED to `"none"` in EBH-2 (see the module doc's HARD HOLD) —
   * independent of every field above. EBH-3 is what makes this field's
   * value depend on the capability booleans.
   */
  resolvedBackend: SandboxBackendId;
  probedAt: string;
}

async function checkSandboxExec(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  if (Bun.which("sandbox-exec") === null) return false;
  try {
    // E1's own repro shape: an `(allow default)` profile exec'ing a trivial
    // process. This proves sandbox-exec can actually launch something, not
    // merely that the binary exists on disk.
    const proc = Bun.spawn(
      ["sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true"],
      { stdout: "ignore", stderr: "ignore" },
    );
    return (await proc.exited) === 0;
  } catch {
    // A spawn-time failure (e.g. ENOENT racing the `which` check) means
    // "not available" — never throw out of a boot probe.
    return false;
  }
}

async function checkBwrap(): Promise<{ available: boolean; unshareWorks: boolean }> {
  if (process.platform !== "linux") return { available: false, unshareWorks: false };
  if (Bun.which("bwrap") === null) return { available: false, unshareWorks: false };
  try {
    // E5/E6's repro shape: bind the host root read-only (so the test binary
    // is visible inside the new mount namespace) and unshare everything.
    // E5 — this fails even as root when unprivileged userns creation is
    // blocked (the common container default), which is exactly the signal
    // DD-8 (container-delegated) needs.
    const proc = Bun.spawn(
      ["bwrap", "--ro-bind", "/", "/", "--unshare-all", "--die-with-parent", "--", "/bin/true"],
      { stdout: "ignore", stderr: "ignore" },
    );
    return { available: true, unshareWorks: (await proc.exited) === 0 };
  } catch {
    return { available: false, unshareWorks: false };
  }
}

function checkLandlock(): boolean {
  if (process.platform !== "linux") return false;
  try {
    if (!existsSync("/sys/kernel/security/lsm")) return false;
    return readFileSync("/sys/kernel/security/lsm", "utf-8").includes("landlock");
  } catch {
    return false;
  }
}

function checkInContainer(): boolean {
  try {
    if (existsSync("/.dockerenv")) return true;
    if (existsSync("/run/.containerenv")) return true;
    if (process.platform === "linux" && existsSync("/proc/1/cgroup")) {
      const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
      if (/docker|kubepods|containerd|libpod/.test(cgroup)) return true;
    }
  } catch {
    // Best-effort — an unreadable /proc means "not detected", never a throw.
  }
  return false;
}

/**
 * Resolve the backend this build will construct, given a capability probe.
 * Takes the probe as a parameter (rather than reading the cache itself) so
 * it stays a pure, directly-testable function.
 *
 * EBH-3a (cortex#2345) lifts the EBH-2 HARD HOLD for macOS ONLY: a Darwin
 * probe that proved `sandbox-exec` viable (E1/E2 — {@link
 * SandboxCapabilityProbe.sandboxExecAvailable}) resolves to `"macos-sbpl"`.
 * Every other case — non-Darwin, or Darwin without a viable `sandbox-exec` —
 * still resolves to `"none"`, exactly as EBH-2 shipped. `linux-bwrap` and
 * `container-delegated` remain UNRESOLVABLE (never returned) until EBH-3b
 * lands DD-8b's real-topology acceptance gate — that HARD HOLD is unchanged
 * by this slice.
 *
 * Resolving `"macos-sbpl"` here is NOT the same as enforcing anything: the
 * constructed `MacosSbplSandbox`'s behaviour is gated on `SandboxProfile.mode`
 * (still defaulted to `"off"` everywhere a real dispatch path sets it) — see
 * `session-sandbox-macos.ts`.
 */
export function resolveSandboxBackend(probe: SandboxCapabilityProbe): SandboxBackendId {
  if (probe.platform === "darwin" && probe.sandboxExecAvailable) return "macos-sbpl";
  return "none";
}

let cachedProbe: Promise<SandboxCapabilityProbe> | undefined;

/**
 * A SYNCHRONOUS snapshot of the boot probe, set the instant {@link
 * runSandboxCapabilityProbe}'s promise settles (EBH-3a). Exists ONLY so
 * {@link createSessionSandbox} — called from `CCSession.start()`, a
 * synchronous method — can pick a real backend without awaiting anything.
 *
 * `undefined` until the FIRST `getSandboxCapabilityProbe()` call resolves —
 * `createSessionSandbox` treats that as "not yet warmed" and falls back to
 * `none`, so a session spawned before boot has warmed the probe (or in any
 * test that never calls `getSandboxCapabilityProbe`) behaves EXACTLY as
 * EBH-2 shipped. This is what keeps `cc-session-isolation.test.ts`'s exact
 * `Bun.spawn` call-count assertions green: those tests construct `CCSession`
 * directly and never warm the probe, so `createSessionSandbox` always
 * resolves `NoneSandbox` for them, on every platform, in CI and locally.
 */
let syncProbeCache: SandboxCapabilityProbe | undefined;

/**
 * Synchronous read of the memoized probe, or `undefined` if it hasn't been
 * warmed (or has been reset — see {@link resetSandboxCapabilityProbeForTests}).
 * Exported for `createSessionSandbox` and for tests that want to assert on
 * the sync-cache boundary directly without racing the async probe.
 */
export function getCachedSandboxCapabilityProbeSync(): SandboxCapabilityProbe | undefined {
  return syncProbeCache;
}

async function runSandboxCapabilityProbe(): Promise<SandboxCapabilityProbe> {
  const sandboxExecAvailable = await checkSandboxExec();
  const { available: bwrapAvailable, unshareWorks: bwrapUnshareWorks } = await checkBwrap();
  const landlockAvailable = checkLandlock();
  const inContainer = checkInContainer();

  const probeWithoutResolution: Omit<SandboxCapabilityProbe, "resolvedBackend"> = {
    platform: process.platform,
    sandboxExecAvailable,
    bwrapAvailable,
    bwrapUnshareWorks,
    landlockAvailable,
    inContainer,
    probedAt: new Date().toISOString(),
  };
  // `resolveSandboxBackend` needs the full record only for its (currently
  // constant) signature — pass a placeholder resolvedBackend through since
  // nothing reads it before the real value is computed below.
  const resolvedBackend = resolveSandboxBackend({
    ...probeWithoutResolution,
    resolvedBackend: "none",
  });

  const probe: SandboxCapabilityProbe = { ...probeWithoutResolution, resolvedBackend };

  // DD-7 — "the resolved backend is logged". Direct stderr (not the event
  // pipeline): this runs at most once per daemon lifetime, before any
  // session-scoped plumbing exists to route it through.
  process.stderr.write(
    `[session-sandbox] capability probe: platform=${probe.platform} ` +
      `sandboxExec=${probe.sandboxExecAvailable} ` +
      `bwrap=${probe.bwrapAvailable}(unshare=${probe.bwrapUnshareWorks}) ` +
      `landlock=${probe.landlockAvailable} container=${probe.inContainer} ` +
      `→ resolvedBackend=${probe.resolvedBackend}\n`,
  );

  return probe;
}

/**
 * Get the boot capability probe, running it at most ONCE per daemon
 * lifetime — every subsequent call (from any session, any caller) returns
 * the SAME memoized promise (cortex#2344 acceptance: "cache it, do not
 * probe per session"). Safe to call from many places concurrently; the
 * memoization is on the in-flight promise, not just the settled value, so
 * concurrent first-callers still only trigger one probe.
 */
export function getSandboxCapabilityProbe(): Promise<SandboxCapabilityProbe> {
  cachedProbe ??= runSandboxCapabilityProbe().then((probe) => {
    // EBH-3a — populate the sync snapshot the instant the async probe
    // settles, so `createSessionSandbox` (a synchronous call from
    // `CCSession.start()`) can read a resolved backend without awaiting.
    syncProbeCache = probe;
    return probe;
  });
  return cachedProbe;
}

/**
 * Test-only — clears the memoized probe so a test can re-probe against a
 * mocked environment. Never called from production code (no production
 * caller has a reason to want a stale probe invalidated mid-run — a
 * platform's sandbox-exec/bwrap availability does not change while the
 * daemon is up).
 */
export function resetSandboxCapabilityProbeForTests(): void {
  cachedProbe = undefined;
  syncProbeCache = undefined;
}
