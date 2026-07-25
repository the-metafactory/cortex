/**
 * EBH-2 (cortex#2344) — `SessionSandbox` choke point + the `none` backend.
 *
 * ## What this closes
 *
 * `docs/design-session-sandbox.md` (DD-1…DD-6) and
 * `docs/design-session-sandbox-platforms.md` (DD-7…DD-12, the empirical
 * findings E1–E8) design an OS-level jail around every `claude --print`
 * child, because EBH-1's six adversarial rounds proved a **string-parsing**
 * guard can be made fail-closed but never sound (TOCTOU, coverage drift —
 * see -platforms.md §1). This module is that jail's *shape* — the
 * `SessionSandbox` interface every real backend (EBH-3: `macos-sbpl`,
 * `linux-bwrap`, `container-delegated`) will implement — plus the ONE
 * backend EBH-2 actually ships: `none`.
 *
 * `none` spawns byte-identically to the pre-EBH-2 code (no kernel
 * enforcement — that's what "none" means) and loudly records that fact
 * (DD-4/DD-6/DD-7) so an unsandboxed host is never silent. It exists so
 * `cc-session.ts`'s spawn call has exactly ONE shape regardless of backend,
 * and so `macos-sbpl`/`linux-bwrap` (EBH-3) drop in without touching the
 * choke point (`cc-session.ts`'s `start()`) at all.
 *
 * ## HARD HOLD (cortex#2344 — this is EBH-2, not EBH-3)
 *
 * `macos-sbpl` and `linux-bwrap` are NOT implemented here. The boot
 * capability probe below (DD-7) detects whether their prerequisites are
 * present and records that for EBH-3 to consume, but {@link resolveSandboxBackend}
 * ALWAYS resolves to `"none"` in this build, regardless of what the probe
 * finds — there is no enforcement backend yet to resolve to.
 */

import { existsSync, readFileSync } from "fs";
import type { Subprocess } from "bun";

// -----------------------------------------------------------------------------
// SandboxProfile — DD-1's kernel-level projection of the resolved policy
// -----------------------------------------------------------------------------

/** Staged rollout posture (design-session-sandbox.md DD-5). `off` is the
 *  ONLY default this build ships — see the cortex#2344 HARD HOLD. */
export type SandboxMode = "off" | "audit" | "enforce";

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
]);

export const SANDBOX_EGRESS_ALLOW_SEED: readonly string[] = Object.freeze([
  "api.anthropic.com",
  "github.com",
  "api.github.com",
  "codeload.github.com",
]);

// -----------------------------------------------------------------------------
// SessionSandbox — DD-2's choke point interface
// -----------------------------------------------------------------------------

/** One denied access, surfaced by a real backend's kernel/audit log (DD-6).
 *  The `none` backend's {@link SessionSandbox.denials} never yields one —
 *  it enforces nothing, so nothing can be denied — but the shape exists now
 *  so EBH-3 doesn't change the `SessionSandbox` interface to add it. */
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
 * Construct the resolved `SessionSandbox` for a spawn. EBH-2 ships exactly
 * one backend, so this is currently a thin (but real) seam: EBH-3 extends
 * the switch, not the call sites that call this function.
 */
export function createSessionSandbox(opts?: {
  onUnavailable?: (event: SandboxUnavailableEvent) => void;
}): SessionSandbox {
  // `resolveSandboxBackend` is intentionally NOT consulted here yet — every
  // resolution collapses to `"none"` until EBH-3 adds a real implementation
  // to construct. Once it does, this factory is where the switch lives.
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
 * HARD-PINNED to `"none"` (cortex#2344 HARD HOLD — see the module doc).
 * Takes the probe as a parameter (rather than reading the cache itself) so
 * it stays a pure, directly-testable function; EBH-3 is expected to grow
 * real branches here keyed on the probe's fields.
 */
export function resolveSandboxBackend(_probe: SandboxCapabilityProbe): SandboxBackendId {
  return "none";
}

let cachedProbe: Promise<SandboxCapabilityProbe> | undefined;

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
  cachedProbe ??= runSandboxCapabilityProbe();
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
}
