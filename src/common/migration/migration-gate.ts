/**
 * cortex#1901 (XDG epic #1867, phase P3c gate) — the migration gate that PROVES
 * a stack fleet is stopped before X-07 (config move) / X-11 (state move) relocate
 * a running daemon's directories. This issue delivers the REUSABLE gate; the
 * moves themselves are out of scope (they consume it).
 *
 * ## Why the oracle is the SERVICE MANAGER, never a pidfile
 *
 * A filesystem/pidfile oracle is wrong on two counts, and both are load-bearing:
 *   - Stack plists carry `RunAtLoad:true` AND `KeepAlive:true`, so a daemon is
 *     ALWAYS alive → an "abort if pidfile present" gate is a permanent no-op.
 *   - `cortex stop` and the singleton check UNLINK the pidfile (seven sites in
 *     `cortex.ts` — grep `unlinkSync(pidFile)`) while KeepAlive respawns inside
 *     the throttle window, so "no pidfile" NEVER means "no daemon" (a TOCTOU).
 *
 * So the gate drives the service manager and proves absence THROUGH it:
 *   - **macOS:** `launchctl bootout gui/<uid>/<label>` — the only primitive that
 *     defeats KeepAlive — then prove absence with `launchctl print …` returning
 *     NON-ZERO. `bootout` removes the service from the domain, so the supervisor
 *     will NOT respawn until a matching `bootstrap`. The stop→verify window is
 *     race-free BY CONSTRUCTION — which is exactly why pidfile-absence is unsafe
 *     (supervisor races) but bootout-absence is safe (supervisor is out of it).
 *   - **Linux:** `systemctl --user stop <unit>` — an EXPLICIT stop, which
 *     `Restart=always` does NOT override (Restart fires on unexpected exit, not
 *     on a deliberate stop) — then prove absence with `systemctl --user is-active`
 *     returning a non-"up" state. REQUIRED + FAIL-CLOSED (G-08): the epic exists
 *     for a Linux user and CI is ubuntu, so the Linux path is a first-class
 *     implementation, not a stub.
 *
 * ## Fail-closed by construction
 *
 * A target is deemed absent ONLY on POSITIVE PROOF (`print` non-zero on macOS /
 * a definitive down-state from a clean `is-active` on Linux). If the service
 * manager binary is missing (the injected exec throws), or `print` still
 * resolves the job, or `is-active` reports an up-state, the target counts as
 * PRESENT and the gate REFUSES to clear. Absence is proven; it is never assumed.
 * There is no code path that returns `cleared:true` without every target having
 * been positively proven down.
 *
 * ## Restore-on-failure (G-36)
 *
 * `bootout` is PERSISTENT — an aborted migration would otherwise leave the fleet
 * down with KeepAlive defeated. {@link runMigrationGate} therefore returns a
 * `restore()` handle that `bootstrap`s (macOS) / `start`s (Linux) exactly the
 * targets that were UP when the gate ran, and verifies each came back. Callers
 * MUST invoke `restore()` on ANY failure path — the gate's own non-clear, or
 * their own migration throwing after a clear. Symmetry (the preupgrade/
 * postupgrade guarantee): nothing that was down is started; nothing that was up
 * is left down.
 *
 * ## Legacy labels (G-35)
 *
 * Enumeration covers not just live stack slugs + the relay, but the legacy label
 * set `scripts/preupgrade.sh` already boots out (`com.grove.bot`,
 * `com.grove.relay`, `ai.meta-factory.cortex.bot`) — a `com.grove.*` daemon left
 * from the grove-v2 era is exactly the KeepAlive process a state move must not
 * race.
 *
 * ## Seams
 *
 * Every side effect (the launchctl/systemctl exec), the `platform`, and the
 * `uid` are injected so the gate is unit-testable on a POSIX CI host with no
 * real launchd/systemd — mirroring the #763 `NatsServiceManager` ExecRunner seam.
 */

import { homedir } from "os";
import { join } from "path";

import { discoverStacks } from "../../cli/cortex/commands/stack-lib";
import { cortexConfigDir } from "../config/config-path";

// =============================================================================
// Public types + the injected exec seam
// =============================================================================

/** macOS (`darwin`) vs Linux — the only two platforms the fleet runs on. */
export type GatePlatform = "darwin" | "linux";

/** Result of one launchctl/systemctl subprocess. `stdout` is load-bearing on
 *  Linux (`is-active` prints the state word there). */
export interface GateExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected process runner — captured in tests, real `Bun.spawn` in prod. May
 *  THROW synchronously on ENOENT (binary not on PATH); the gate treats a throw
 *  as "cannot prove absence" (fail-closed), never letting it escape. */
export type GateExec = (argv: string[]) => Promise<GateExecResult>;

/** Which family a target belongs to — for logging + restore reasoning. */
export type ServiceTargetKind = "stack" | "relay" | "legacy";

/**
 * One service the gate must prove stopped, carrying BOTH platform identities so
 * a single enumerated target is usable on either OS:
 *   - `label` — the launchd label (`launchctl bootout/print gui/<uid>/<label>`).
 *   - `unit`  — the systemd unit id (`systemctl --user stop/is-active <unit>`),
 *      the `<label>.service` analogue of the launchd Label.
 *   - `plistPath` — where `launchctl bootstrap` reloads it from on restore.
 */
export interface ServiceTarget {
  id: string;
  kind: ServiceTargetKind;
  label: string;
  unit: string;
  plistPath: string;
}

// =============================================================================
// Label / unit conventions (kept in lockstep with preupgrade.sh)
// =============================================================================

/** The launchd label prefix every cortex stack + the relay share. */
export const CORTEX_LABEL_PREFIX = "ai.meta-factory.cortex.";

/** The relay's launchd label — enumerated alongside stack slugs (issue step 1). */
export const RELAY_LABEL = `${CORTEX_LABEL_PREFIX}relay`;

/**
 * The legacy label set `scripts/preupgrade.sh:80` already knows (G-35):
 *   - `com.grove.bot` / `com.grove.relay` — grove-v2 era plists that may linger.
 *   - `ai.meta-factory.cortex.bot` — the pre-cortex#251 dev-stack plist name.
 * A KeepAlive daemon under any of these is a process a state move must not race.
 */
export const LEGACY_LABELS: readonly string[] = [
  "com.grove.bot",
  "com.grove.relay",
  `${CORTEX_LABEL_PREFIX}bot`,
];

/** systemd `is-active` states that mean the unit is (still) UP. Everything else
 *  a clean `is-active` can print (`inactive`/`failed`/`unknown`/`""`) is DOWN. */
const SYSTEMD_UP_STATES: ReadonlySet<string> = new Set([
  "active",
  "activating",
  "reloading",
  "deactivating",
]);

// =============================================================================
// Enumeration
// =============================================================================

/** Options for {@link enumerateServiceTargets}. */
export interface EnumerateTargetsOptions {
  /** Cortex config dir to discover stack slugs under. Defaults to
   *  {@link cortexConfigDir} (honours `$CORTEX_CONFIG_DIR`). */
  configDir?: string;
  /** launchd `~/Library/LaunchAgents` (or the tmp dir a test points it at) —
   *  where each label's `<label>.plist` lives, used by restore's `bootstrap`. */
  launchAgentsDir: string;
  /** Slug discovery seam. Defaults to `discoverStacks(dir).map(slugLocator)`. */
  discoverSlugs?: (configDir: string) => string[];
  /** `$HOME` override (tests). */
  home?: string;
}

/**
 * Enumerate every service the gate must prove stopped: one per discovered stack
 * slug (`ai.meta-factory.cortex.<slug>`), the relay ({@link RELAY_LABEL}), and
 * the {@link LEGACY_LABELS}. Deduplicated by label (so a stack whose slug is
 * literally `relay`/`bot` can't double-enumerate). Pure — the only I/O is the
 * injected slug discovery.
 */
export function enumerateServiceTargets(opts: EnumerateTargetsOptions): ServiceTarget[] {
  const configDir = opts.configDir ?? cortexConfigDir(opts.home);
  const discover =
    opts.discoverSlugs ?? ((dir: string) => discoverStacks(dir).map((s) => s.slugLocator));

  const targets: ServiceTarget[] = [];
  const seen = new Set<string>();
  const push = (id: string, kind: ServiceTargetKind, label: string): void => {
    if (seen.has(label)) return;
    seen.add(label);
    targets.push({
      id,
      kind,
      label,
      unit: `${label}.service`,
      plistPath: join(opts.launchAgentsDir, `${label}.plist`),
    });
  };

  for (const slug of discover(configDir)) push(slug, "stack", `${CORTEX_LABEL_PREFIX}${slug}`);
  push("relay", "relay", RELAY_LABEL);
  for (const legacy of LEGACY_LABELS) push(legacy, "legacy", legacy);

  return targets;
}

// =============================================================================
// The gate
// =============================================================================

/** Inputs to {@link runMigrationGate}. All side effects are injected. */
export interface MigrationGateOptions {
  platform: GatePlatform;
  /** launchd `gui/<uid>` target uid (ignored on Linux). */
  uid: number;
  exec: GateExec;
  /** Enumerated by {@link enumerateServiceTargets}. */
  targets: ServiceTarget[];
}

/** Outcome of a `restore()` call — which targets came back, and which didn't. */
export interface RestoreResult {
  restored: string[];
  failed: { id: string; reason: string }[];
}

/** The gate's verdict + the restore handle callers MUST use on any failure. */
export interface MigrationGateResult {
  /** `true` ONLY when every target was positively proven down. */
  cleared: boolean;
  /** Present when `cleared === false` — which targets refused to prove down. */
  reason?: string;
  /** Everything the gate reasoned about. */
  targets: ServiceTarget[];
  /** Targets UP at pre-check — the exact set `restore()` brings back (symmetry). */
  running: ServiceTarget[];
  /** Targets not proven down AFTER the stop — the fail-closed evidence. */
  stillPresent: ServiceTarget[];
  /** Re-`bootstrap`/`start` the `running` set and verify each returns. Callers
   *  MUST invoke this on ANY failure path — `bootout` is persistent. */
  restore: () => Promise<RestoreResult>;
}

/**
 * Prove a single target is DOWN via the service manager. Returns `true` ONLY on
 * positive proof of absence; a thrown exec (binary missing) or any up-signal
 * returns `false` (fail-closed — the caller then treats it as still present).
 */
async function proveAbsent(opts: MigrationGateOptions, t: ServiceTarget): Promise<boolean> {
  try {
    if (opts.platform === "darwin") {
      // `launchctl print` exits 0 while the job is in the domain, non-zero once
      // booted out. Non-zero is the positive proof of absence.
      const r = await opts.exec(["launchctl", "print", `gui/${opts.uid.toString()}/${t.label}`]);
      return r.code !== 0;
    }
    // Linux: `is-active` prints the state word; a non-"up" state is proof-of-down.
    const r = await opts.exec(["systemctl", "--user", "is-active", t.unit]);
    return !SYSTEMD_UP_STATES.has(r.stdout.trim());
  } catch {
    // Exec threw (e.g. systemctl/launchctl ENOENT): we CANNOT prove absence, so
    // the target is treated as present. This is the fail-closed spine.
    return false;
  }
}

/** Issue the authoritative stop for one target (defeats KeepAlive/Restart). Never
 *  throws — a stop failure surfaces later as a failed absence proof. */
async function stopTarget(opts: MigrationGateOptions, t: ServiceTarget): Promise<void> {
  try {
    if (opts.platform === "darwin") {
      await opts.exec(["launchctl", "bootout", `gui/${opts.uid.toString()}/${t.label}`]);
    } else {
      await opts.exec(["systemctl", "--user", "stop", t.unit]);
    }
  } catch {
    // Swallow — a stop that couldn't run leaves the target UP, which the verify
    // pass below will catch as `stillPresent` (fail-closed), so nothing clears.
  }
}

/**
 * Run the migration gate over `targets`:
 *   1. Pre-check which targets are UP (the restore set — symmetry anchor).
 *   2. Stop EVERY target (idempotent; also catches a target that raced up after
 *      the pre-check — it is booted out regardless).
 *   3. Prove EVERY target is now down. `cleared` iff all are proven down.
 *
 * Always returns a `restore()` handle bound to the pre-check UP set — usable
 * whether the gate cleared (caller migrates, then restores) or refused (caller
 * restores immediately).
 */
export async function runMigrationGate(
  opts: MigrationGateOptions,
): Promise<MigrationGateResult> {
  const { targets } = opts;

  // 1. Pre-check: UP == "not proven absent". A target whose proof throws (binary
  //    missing) counts as UP, so restore is attempted and the gate won't clear.
  const running: ServiceTarget[] = [];
  for (const t of targets) {
    if (!(await proveAbsent(opts, t))) running.push(t);
  }

  // 2. Authoritatively stop every enumerated target (defeat KeepAlive/Restart).
  for (const t of targets) await stopTarget(opts, t);

  // 3. Positive-proof verification. Absence must be proven for ALL to clear.
  const stillPresent: ServiceTarget[] = [];
  for (const t of targets) {
    if (!(await proveAbsent(opts, t))) stillPresent.push(t);
  }

  const cleared = stillPresent.length === 0;
  const restore = makeRestore(opts, running);

  return {
    cleared,
    ...(cleared ? {} : { reason: notClearedReason(opts.platform, stillPresent) }),
    targets,
    running,
    stillPresent,
    restore,
  };
}

/** Build the `restore()` closure bound to the pre-check UP set. */
function makeRestore(
  opts: MigrationGateOptions,
  running: readonly ServiceTarget[],
): () => Promise<RestoreResult> {
  return async (): Promise<RestoreResult> => {
    const restored: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const t of running) {
      try {
        const back =
          opts.platform === "darwin"
            ? await restoreDarwin(opts, t)
            : await restoreLinux(opts, t);
        if (back.ok) restored.push(t.id);
        else failed.push({ id: t.id, reason: back.reason });
      } catch (err) {
        failed.push({ id: t.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { restored, failed };
  };
}

/** macOS restore: `bootstrap` the plist back into the domain, `kickstart` it,
 *  then confirm with `print` that it is loaded again. */
async function restoreDarwin(
  opts: MigrationGateOptions,
  t: ServiceTarget,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const gui = `gui/${opts.uid.toString()}`;
  await opts.exec(["launchctl", "bootstrap", gui, t.plistPath]);
  await opts.exec(["launchctl", "kickstart", "-k", `${gui}/${t.label}`]);
  const check = await opts.exec(["launchctl", "print", `${gui}/${t.label}`]);
  if (check.code === 0) return { ok: true };
  return {
    ok: false,
    reason: `launchctl print ${t.label} still non-zero after bootstrap (${check.code.toString()}): ${check.stderr.trim()}`,
  };
}

/** Linux restore: `systemctl --user start`, then confirm with `is-active`. */
async function restoreLinux(
  opts: MigrationGateOptions,
  t: ServiceTarget,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  await opts.exec(["systemctl", "--user", "start", t.unit]);
  const check = await opts.exec(["systemctl", "--user", "is-active", t.unit]);
  if (SYSTEMD_UP_STATES.has(check.stdout.trim())) return { ok: true };
  return {
    ok: false,
    reason: `systemctl --user is-active ${t.unit} = ${JSON.stringify(check.stdout.trim())} after start`,
  };
}

/** Human-readable fail-closed reason naming the not-proven-down targets. */
function notClearedReason(platform: GatePlatform, stillPresent: readonly ServiceTarget[]): string {
  const how =
    platform === "darwin"
      ? "`launchctl print` still resolves them (or launchctl is unavailable)"
      : "`systemctl --user is-active` reports an up-state (or systemctl is unavailable)";
  const which = stillPresent
    .map((t) => (platform === "darwin" ? t.label : t.unit))
    .join(", ");
  return `migration gate REFUSED to clear (fail-closed): ${stillPresent.length.toString()} target(s) not proven stopped — ${how}: ${which}`;
}

// =============================================================================
// Production wiring
// =============================================================================

/** A real `Bun.spawn`-backed {@link GateExec}. Captures stdout (Linux `is-active`
 *  needs it) + stderr + exit code. */
export const bunGateExec: GateExec = async (argv) => {
  const [cmd, ...rest] = argv;
  const proc = Bun.spawn([cmd ?? "", ...rest], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
};

/** Map `process.platform` onto the supported {@link GatePlatform} set. */
export function currentGatePlatform(): GatePlatform {
  return process.platform === "darwin" ? "darwin" : "linux";
}

/** Resolve the launchd `gui/<uid>` target: explicit override, else the process
 *  uid, else the macOS default 501. */
export function resolveGateUid(uid?: number): number {
  return uid ?? process.getuid?.() ?? 501;
}

/** `~/Library/LaunchAgents` (or under a `home` override). */
function defaultLaunchAgentsDir(home?: string): string {
  return join(home ?? process.env.HOME ?? homedir(), "Library", "LaunchAgents");
}

/**
 * The one-call production entry point X-07/X-11 use: enumerate the fleet + run
 * the gate with real `Bun.spawn` exec and host-derived platform/uid/dirs. Every
 * default is overridable for tests + non-standard installs.
 */
export async function clearFleetForMigration(opts?: {
  platform?: GatePlatform;
  uid?: number;
  exec?: GateExec;
  configDir?: string;
  launchAgentsDir?: string;
  home?: string;
}): Promise<MigrationGateResult> {
  const launchAgentsDir = opts?.launchAgentsDir ?? defaultLaunchAgentsDir(opts?.home);
  const targets = enumerateServiceTargets({
    ...(opts?.configDir !== undefined && { configDir: opts.configDir }),
    launchAgentsDir,
    ...(opts?.home !== undefined && { home: opts.home }),
  });
  return runMigrationGate({
    platform: opts?.platform ?? currentGatePlatform(),
    uid: resolveGateUid(opts?.uid),
    exec: opts?.exec ?? bunGateExec,
    targets,
  });
}
