/**
 * cortex#1901 (XDG epic #1867, phase P3c gate) — the migration gate that PROVES
 * a stack fleet is DEAD before X-07 (config move) / X-11 (state move) relocate a
 * running daemon's directories. This issue delivers the REUSABLE gate; the moves
 * consume it. X-11 TRUSTS this verdict, so a gate that fail-OPENS is worse than
 * no gate — every predicate here is built around POSITIVE proof of death.
 *
 * ## Why the oracle is the SERVICE MANAGER, never a pidfile
 *
 * A filesystem/pidfile oracle is wrong on two counts:
 *   - Stack plists carry `RunAtLoad:true` AND `KeepAlive:true`, so a daemon is
 *     ALWAYS alive → an "abort if pidfile present" gate is a permanent no-op.
 *   - `cortex stop` + the singleton check UNLINK the pidfile (seven sites in
 *     `cortex.ts` — grep `unlinkSync(pidFile)`) while KeepAlive respawns inside
 *     the throttle window, so "no pidfile" NEVER means "no daemon" (a TOCTOU).
 *
 * ## The three legs of a POSITIVE death proof (adversary root-cause, PR#1929)
 *
 * "Absence inferred from a non-up / non-zero signal is ALSO produced by wrong-
 * unit, manager-unreachable, wrong-domain, and process-still-draining — only one
 * of which is safe." So a target is declared DEAD only when ALL THREE hold:
 *
 *   1. **Right service.** macOS: launchd is name-by-convention, so the label
 *      `ai.meta-factory.cortex.<slug>` IS the service (verified live by `print`).
 *      Linux: the unit name is NOT conventional (real units are `cortex-bot.
 *      service`, not `ai.meta-factory.cortex.bot.service` — see
 *      daemon-locator.ts:126-127), so we DISCOVER the real unit id by scanning
 *      `~/.config/systemd/user` for a `.service` whose `ExecStart` carries a
 *      `--config` under the cortex config dir (or the relay entrypoint). A
 *      derived name would query the WRONG unit → `is-active` "inactive" → a false
 *      clear (A-UNIT).
 *   2. **Manager-reached down verdict.** macOS: `launchctl print` returns
 *      NON-ZERO (left the domain) from a call that did not throw. Linux:
 *      `systemctl --user is-active` returns a CLEAN, definitive down word —
 *      exactly `inactive` or `failed`. A `systemctl` that runs but cannot reach
 *      its manager (no D-Bus / unset `XDG_RUNTIME_DIR`) yields non-zero + empty/
 *      `unknown` stdout — that is NOT proof, it is PRESENT (A-ISACTIVE). We key
 *      on the stdout WORD, never the exit code alone.
 *   3. **Confirmed process death.** Deregistration ≠ death: cortex shutdown
 *      drains up to ~15s (cortex.ts:443), so a booted-out daemon still holds the
 *      state dir + locks after `print`/`is-active` report it gone. We capture the
 *      job's PID BEFORE the stop, then poll `kill(pid,0)` until `ESRCH`, bounded
 *      by a drain window ≥ 15s (A-TOCTOU).
 *
 * Any leg unproven → the target is PRESENT and the gate REFUSES to clear. There
 * is NO path that returns `cleared:true` without every target passing all three.
 * An empty target set with no live pidfile is a FOOTGUN (discovery failure), not
 * a vacuous clear — it throws.
 *
 * A note on leg 3 (KillMode): cortex ships NO systemd unit with a `KillMode`
 * override, so systemd's default `KillMode=control-group` tears down the whole
 * cgroup on `stop` — tracking `MainPID` for the death poll is sufficient. If a
 * deployment hand-authors a unit with `KillMode=process`, a child forked outside
 * `MainPID` is a documented residual (the config-tree belt below still catches it
 * if it wrote a pidfile).
 *
 * ## The pidfile-liveness belt — making "DEAD" TRUE, not "service-discovered dead"
 *
 * The three legs only see daemons the SERVICE MANAGER knows about. A daemon
 * hand-started as `cortex start --config …` (how the principal runs cortex on a
 * dev checkout) has no launchd label / systemd unit — invisible to the legs, so
 * clearing would be fail-open. The belt closes this out-of-model hole with
 * INDEPENDENT positive proof of LIFE: for every EXPECTED stack (enumerated from
 * the config tree), read the pidfile it would write — via the #1900
 * {@link pidFileFor} verbatim, so the belt can't drift from the daemon — and if
 * the pid is LIVE (`kill(pid,0)`), REFUSE. It is presence→refuse (no absence-
 * TOCTOU) and catches BOTH out-of-model cases: hand-started daemons and
 * system-scope units (both write pidfiles). A target clears only when it is
 * service-down AND pid-dead AND has no live pidfile — which is what lets the
 * top-line "proves the fleet is DEAD" claim actually hold.
 *
 * ## Restore-on-failure (G-36 / A-RESTORE)
 *
 * `bootout`/`stop` leave the fleet DOWN, so a gate run that isn't paired with a
 * restore strands the fleet. {@link withMigrationGate} is the BLESSED entry
 * X-07/X-11 use: it runs the migration inside a `try/finally` that ALWAYS
 * restores the exact pre-running set (nothing down is started; nothing up is left
 * down). The raw {@link runMigrationGate} returns the same `restore()` handle for
 * tests + advanced callers, but the wrapper makes the guarantee structural.
 *
 * ## Legacy labels (G-35)
 *
 * Enumeration covers stack slugs + relay + the legacy set `scripts/preupgrade.sh`
 * boots out (`com.grove.bot`, `com.grove.relay`, `ai.meta-factory.cortex.bot`).
 * On Linux the legacy set is unioned by-name but only when the `.service` file
 * actually exists (a KeepAlive grove-v2 remnant a state move must not race).
 *
 * ## Seams
 *
 * Exec, process-liveness (`kill(pid,0)`), sleep, and clock are all injected
 * ({@link GateEnv}), plus platform + uid, so both the darwin and linux paths run
 * on a POSIX CI host with no real launchd/systemd and no real subprocesses —
 * mirroring the #763 `NatsServiceManager` ExecRunner seam. The Linux discovery
 * reuses daemon-locator's `parseUnitExecStartArgs` + `configArgValue` (DRY — that
 * IS the drift-proof matcher `network join`/`leave` already trust).
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join, resolve, sep } from "path";

import {
  configArgValue,
  parseUnitExecStartArgs,
  type DaemonLocatorIO,
} from "../../cli/cortex/commands/daemon-locator";
import { discoverStacks } from "../../cli/cortex/commands/stack-lib";
import { cortexConfigDir } from "../config/config-path";
import { expandTilde } from "../config/loader";
import { pidFileFor } from "../pidfile";

// =============================================================================
// Public types + injected seams
// =============================================================================

/** macOS (`darwin`) vs Linux — the only two platforms the fleet runs on. */
export type GatePlatform = "darwin" | "linux";

/** Result of one launchctl/systemctl subprocess. `stdout` is load-bearing on
 *  Linux (`is-active` prints the state WORD there) — we key on it, not the code. */
export interface GateExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected process runner. May THROW synchronously on ENOENT (binary not on
 *  PATH); the gate treats a throw as "cannot prove" (fail-closed), never letting
 *  it escape. */
export type GateExec = (argv: string[]) => Promise<GateExecResult>;

/**
 * The full effect surface, injected so the gate is unit-testable with no real
 * subprocesses/processes/wall-clock:
 *   - `exec`      — launchctl/systemctl.
 *   - `procAlive` — `kill(pid,0)` liveness probe (the confirmed-death leg).
 *   - `sleep`     — the drain poll delay.
 *   - `now`       — the drain deadline clock.
 */
export interface GateEnv {
  exec: GateExec;
  procAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** How long to wait for a booted-out PID to actually exit (≥ the 15s cortex
 *  shutdown drain) and how often to re-probe. */
export interface DrainPolicy {
  drainTimeoutMs: number;
  pollIntervalMs: number;
}

/** Default drain: 20s ceiling (> the 15s cortex.ts:443 cap) polled every 250ms. */
export const DEFAULT_DRAIN: DrainPolicy = { drainTimeoutMs: 20_000, pollIntervalMs: 250 };

/** Which family a target belongs to — for logging + restore reasoning. */
export type ServiceTargetKind = "stack" | "relay" | "legacy";

/**
 * One service the gate must prove DEAD. Carries both platform identities:
 *   - `label`    — launchd label (macOS authoritative; name-by-convention).
 *   - `unit`     — systemd unit id (Linux authoritative; DISCOVERED, not derived).
 *   - `plistPath`— where `launchctl bootstrap` reloads it from on restore (macOS).
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

/** The launchd label prefix every cortex stack + the relay share (macOS). */
export const CORTEX_LABEL_PREFIX = "ai.meta-factory.cortex.";

/** The relay's launchd label (macOS). */
export const RELAY_LABEL = `${CORTEX_LABEL_PREFIX}relay`;

/**
 * The legacy label set `scripts/preupgrade.sh:80` already knows (G-35):
 *   - `com.grove.bot` / `com.grove.relay` — grove-v2 era plists that may linger.
 *   - `ai.meta-factory.cortex.bot` — the pre-cortex#251 dev-stack plist name.
 */
export const LEGACY_LABELS: readonly string[] = [
  "com.grove.bot",
  "com.grove.relay",
  `${CORTEX_LABEL_PREFIX}bot`,
];

/** systemd `is-active` states that mean the unit is (still) UP. */
const SYSTEMD_UP_STATES: ReadonlySet<string> = new Set([
  "active",
  "activating",
  "reloading",
  "deactivating",
]);

/** The ONLY `is-active` words that positively prove a reached-manager DOWN unit.
 *  Note the deliberate exclusion of `""`/`unknown` — those are the
 *  manager-unreachable signature (A-ISACTIVE), which must read as PRESENT. */
const SYSTEMD_DOWN_WORDS: ReadonlySet<string> = new Set(["inactive", "failed"]);

// =============================================================================
// Filesystem defaults + helpers
// =============================================================================

function homeDir(home?: string): string {
  return home ?? process.env.HOME ?? homedir();
}

function defaultLaunchAgentsDir(home?: string): string {
  return join(homeDir(home), "Library", "LaunchAgents");
}

/** `$XDG_CONFIG_HOME/systemd/user`, or `~/.config/systemd/user` when unset — the
 *  XDG-honest systemd user-unit dir (this IS the XDG epic; #1867 G-38). */
function defaultSystemdUserDir(home?: string): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homeDir(home), ".config");
  return join(base, "systemd", "user");
}

/** Real-fs {@link DaemonLocatorIO} for production Linux discovery. */
const realIO: DaemonLocatorIO = {
  listDir: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  readFile: (path) => readFileSync(path, "utf-8"),
  exists: (path) => existsSync(path),
};

// =============================================================================
// Enumeration
// =============================================================================

/** Options for {@link enumerateServiceTargets}. */
export interface EnumerateTargetsOptions {
  platform: GatePlatform;
  configDir?: string;
  /** launchd `~/Library/LaunchAgents` (macOS). */
  launchAgentsDir?: string;
  /** systemd `~/.config/systemd/user` (Linux). */
  systemdUserDir?: string;
  /** fs seam for Linux discovery + legacy existence checks. Default = real fs. */
  io?: DaemonLocatorIO;
  /** Stack-slug discovery seam (macOS label derivation). */
  discoverSlugs?: (configDir: string) => string[];
  home?: string;
}

/**
 * Enumerate every service the gate must prove dead.
 *
 * macOS — labels by convention (launchd IS name-by-convention, `print`-verified):
 * one per discovered stack slug + relay + legacy set.
 *
 * Linux — REAL unit ids DISCOVERED from `~/.config/systemd/user` (a derived name
 * would query the wrong unit; A-UNIT). A `.service` is a cortex daemon when its
 * `ExecStart` carries a `--config` under the cortex config dir (a stack) or names
 * the relay entrypoint (`relay.ts`). The legacy set is unioned by-name, but only
 * when its `.service` file actually exists.
 */
export function enumerateServiceTargets(opts: EnumerateTargetsOptions): ServiceTarget[] {
  return opts.platform === "linux" ? enumerateLinux(opts) : enumerateDarwin(opts);
}

function enumerateDarwin(opts: EnumerateTargetsOptions): ServiceTarget[] {
  const configDir = opts.configDir ?? cortexConfigDir(opts.home);
  const launchAgentsDir = opts.launchAgentsDir ?? defaultLaunchAgentsDir(opts.home);
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
      unit: `${label}.service`, // unused on darwin; kept for shape symmetry
      plistPath: join(launchAgentsDir, `${label}.plist`),
    });
  };

  for (const slug of discover(configDir)) push(slug, "stack", `${CORTEX_LABEL_PREFIX}${slug}`);
  push("relay", "relay", RELAY_LABEL);
  for (const legacy of LEGACY_LABELS) push(legacy, "legacy", legacy);

  return targets;
}

function enumerateLinux(opts: EnumerateTargetsOptions): ServiceTarget[] {
  const configDir = opts.configDir ?? cortexConfigDir(opts.home);
  const systemdUserDir = opts.systemdUserDir ?? defaultSystemdUserDir(opts.home);
  const io = opts.io ?? realIO;
  const cfgRoot = resolve(expandTilde(configDir));

  const targets: ServiceTarget[] = [];
  const seen = new Set<string>();
  const push = (id: string, kind: ServiceTargetKind, unit: string): void => {
    if (seen.has(unit)) return;
    seen.add(unit);
    targets.push({ id, kind, label: unit, unit, plistPath: join(systemdUserDir, unit) });
  };

  // 1. Discover real cortex units by ExecStart (name-agnostic — A-UNIT fix).
  if (io.exists(systemdUserDir)) {
    for (const name of io.listDir(systemdUserDir).sort()) {
      if (!name.endsWith(".service")) continue;
      let text: string;
      try {
        text = io.readFile(join(systemdUserDir, name));
      } catch {
        // Unreadable unit — cannot classify; skip. (A present-but-unreadable
        // cortex unit is an install anomaly; documented residual.)
        continue;
      }
      const argv = parseUnitExecStartArgs(text);
      if (argv.length === 0) continue;
      if (argv.some(isRelayEntrypoint)) {
        push("relay", "relay", name);
        continue;
      }
      const cfg = configArgValue(argv);
      if (cfg === undefined) continue;
      const resolved = resolve(expandTilde(cfg));
      if (resolved === cfgRoot || resolved.startsWith(cfgRoot + sep)) {
        push(slugFromConfigPath(resolved), "stack", name);
      }
    }
  }

  // 2. UNION the legacy set by-name, but only when the unit file EXISTS (G-35).
  for (const legacy of LEGACY_LABELS) {
    const unit = `${legacy}.service`;
    if (io.exists(join(systemdUserDir, unit))) push(legacy, "legacy", unit);
  }

  return targets;
}

/** An ExecStart token that names the relay entrypoint (`…/relay.ts` / `cortex-relay`). */
function isRelayEntrypoint(token: string): boolean {
  return /(^|\/)relay\.ts$/.test(token) || /(^|\/)cortex-relay$/.test(token);
}

/** Derive a stack slug from a daemon `--config` path (for the target id only). */
function slugFromConfigPath(cfgPath: string): string {
  const base = cfgPath.split("/").pop() ?? cfgPath;
  const noext = base.replace(/\.ya?ml$/i, "");
  if (noext === "cortex") return "meta-factory";
  const m = /^cortex\.(.+)$/.exec(noext);
  return m?.[1] ?? noext;
}

// =============================================================================
// Pidfile-liveness belt (out-of-model positive proof of LIFE)
// =============================================================================
//
// Service discovery only sees daemons the service manager knows about. A daemon
// hand-started as `cortex start --config …` (exactly how the principal runs
// cortex on a dev checkout) has NO launchd label / systemd unit — so the 3-leg
// service proof is blind to it, and clearing would be fail-open. This belt makes
// the "fleet is DEAD" claim TRUE independently of service discovery: it reads the
// pidfile every EXPECTED stack would write (via the #1900 `pidFileFor`) and, if
// the pid is LIVE, REFUSES. It is presence→refuse (positive proof of life, no
// absence-TOCTOU), so it catches both out-of-model cases: hand-started daemons
// (which wrote a pidfile via checkSingleton) AND system-scope units (also write
// pidfiles). Run AFTER the service stop, so a unit-managed daemon we just killed
// (dead pid) is NOT a false refusal, while an un-managed live daemon still is.

/** A stack whose pidfile currently holds a LIVE pid. Presence → refuse. */
export interface LivePidfile {
  /** The daemon `--config` path this pidfile belongs to (`"(default)"` for the
   *  single-instance `cortex.pid`). */
  configPath: string;
  pidPath: string;
  pid: number;
}

/** Belt configuration — every input is seam-injected for hermetic tests. */
export interface PidfileBeltConfig {
  configDir?: string;
  home?: string;
  /** Daemon `--config` paths of EXPECTED stacks. Default: derived from
   *  discoverStacks (pointer path for split, monolith file for monolith). */
  stackConfigPaths?: string[];
  /** config path → pidfile path. Default: the #1900 {@link pidFileFor} VERBATIM,
   *  so the belt's derivation can never drift from the daemon's own. */
  pidFilePathFor?: (configPath: string | undefined) => string;
  /** pidfile path → pid (or undefined when absent/unreadable/unparseable).
   *  Default: real fs read + parse. */
  readPidFile?: (path: string) => number | undefined;
}

/**
 * The pidfile-liveness belt. Enumerate the expected stacks from the config tree,
 * resolve each daemon's pidfile via {@link pidFileFor}, and report every one
 * whose pid is LIVE (kill(pid,0) via the injected {@link GateEnv.procAlive},
 * EPERM-as-alive). The default single-instance `cortex.pid` is checked too (a
 * hand-started default daemon). No absence is ever inferred — a hit is a daemon
 * that is *provably running right now*.
 */
export function pidfileLivenessBelt(env: GateEnv, cfg: PidfileBeltConfig = {}): LivePidfile[] {
  const pidPathFor = cfg.pidFilePathFor ?? pidFileFor;
  const readPid = cfg.readPidFile ?? defaultReadPidFile;
  const stackConfigs =
    cfg.stackConfigPaths ?? expectedDaemonConfigPaths(cfg.configDir ?? cortexConfigDir(cfg.home));

  const live: LivePidfile[] = [];
  const seenPidPath = new Set<string>();
  // Every expected stack's daemon config, PLUS the default single-instance case.
  const candidates: (string | undefined)[] = [...stackConfigs, undefined];
  for (const configPath of candidates) {
    const pidPath = pidPathFor(configPath);
    if (seenPidPath.has(pidPath)) continue;
    seenPidPath.add(pidPath);
    const pid = readPid(pidPath);
    if (pid !== undefined && env.procAlive(pid)) {
      live.push({ configPath: configPath ?? "(default)", pidPath, pid });
    }
  }
  return live;
}

/** Daemon `--config` paths for every discovered stack (pointer for split layout,
 *  the monolith file for monolith — the path the daemon's `--config` carries). */
function expectedDaemonConfigPaths(configDir: string): string[] {
  return discoverStacks(configDir).map((s) =>
    s.layout === "split" ? join(configDir, s.slugLocator, `${s.slugLocator}.yaml`) : s.configPath,
  );
}

/** Read a pidfile → its pid, or undefined when absent/unreadable/unparseable. */
function defaultReadPidFile(path: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
  const pid = parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

// =============================================================================
// The gate
// =============================================================================

/** Inputs to {@link runMigrationGate}. All effects are injected via {@link GateEnv}. */
export interface MigrationGateOptions {
  platform: GatePlatform;
  /** launchd `gui/<uid>` target uid (ignored on Linux). */
  uid: number;
  env: GateEnv;
  targets: ServiceTarget[];
  /** Death-wait policy. Defaults to {@link DEFAULT_DRAIN}. */
  drain?: DrainPolicy;
  /** Config-tree pidfile-liveness belt. When provided, a LIVE pidfile for any
   *  expected stack refuses the gate even with NO service unit discovered for it
   *  (clearFleetForMigration / withMigrationGate always provide it). */
  belt?: PidfileBeltConfig;
}

/** Outcome of a `restore()` call — which targets came back, and which didn't. */
export interface RestoreResult {
  restored: string[];
  failed: { id: string; reason: string }[];
}

/** The gate's verdict + the restore handle callers MUST use on any failure. */
export interface MigrationGateResult {
  /** `true` ONLY when every target passed all three legs of the death proof. */
  cleared: boolean;
  /** Present when `cleared === false` — which targets refused to prove dead. */
  reason?: string;
  targets: ServiceTarget[];
  /** Targets UP at pre-check — the exact set `restore()` brings back (symmetry). */
  running: ServiceTarget[];
  /** Targets not proven dead — the service-discovery fail-closed evidence. */
  stillPresent: ServiceTarget[];
  /** Expected stacks with a LIVE pidfile — the out-of-model belt evidence (a
   *  running daemon with no service unit). Cleared requires this empty too. */
  livePidfiles: LivePidfile[];
  /** Re-`bootstrap`/`start` the pre-running set + verify each. Callers MUST call
   *  this on any failure path — `bootout`/`stop` are persistent. */
  restore: () => Promise<RestoreResult>;
}

/** Per-target probe captured BEFORE any stop (so we hold the live PID). */
interface TargetProbe {
  target: ServiceTarget;
  running: boolean;
  pid?: number;
}

/**
 * Run the migration gate over `targets`:
 *   1. PROBE every target — record up-state + the live PID (before any stop).
 *   2. STOP every target authoritatively (bootout / systemctl stop).
 *   3. PROVE-DEAD every target via all three legs. `cleared` iff every target
 *      is positively proven dead.
 *
 * Throws on an EMPTY target set (a footgun: discovery returned nothing, and a
 * vacuous "clear" would be fail-open). Always returns a `restore()` handle bound
 * to the pre-check UP set.
 */
export async function runMigrationGate(
  opts: MigrationGateOptions,
): Promise<MigrationGateResult> {
  const { targets } = opts;
  const drain = opts.drain ?? DEFAULT_DRAIN;

  // Empty target set: NOT a vacuous clear. If the belt still finds a LIVE daemon
  // (a hand-started stack with no unit), refuse and report it; otherwise throw —
  // an empty set with no belt hit is a discovery failure, never a clear.
  if (targets.length === 0) {
    const livePidfiles = opts.belt ? pidfileLivenessBelt(opts.env, opts.belt) : [];
    if (livePidfiles.length === 0) {
      throw new Error(
        "migration gate: refusing to run with an EMPTY target set and no live pidfile — " +
          "enumeration returned nothing (unreadable systemd dir / no discovered units / no fleet). " +
          "Clearing an empty set would be fail-open; this is a discovery failure, not a clear.",
      );
    }
    return {
      cleared: false,
      reason: notClearedReason(opts.platform, [], livePidfiles),
      targets,
      running: [],
      stillPresent: [],
      livePidfiles,
      restore: makeRestore(opts, []),
    };
  }

  // 1. Probe — capture up-state + PID while the daemon is still alive.
  const probes: TargetProbe[] = [];
  for (const t of targets) probes.push(await probeTarget(opts, t));

  // 2. Authoritatively stop every target (defeat KeepAlive / Restart=always).
  for (const t of targets) await stopTarget(opts, t);

  // 3. Positive death proof for every service-discovered target.
  const stillPresent: ServiceTarget[] = [];
  for (const p of probes) {
    if (!(await proveDead(opts, p, drain))) stillPresent.push(p.target);
  }

  // 4. Belt — AFTER the stop, so a unit-managed daemon we just killed (dead pid)
  //    is not a false refusal, while a live daemon with no service unit still is.
  const livePidfiles = opts.belt ? pidfileLivenessBelt(opts.env, opts.belt) : [];

  const running = probes.filter((p) => p.running).map((p) => p.target);
  const cleared = stillPresent.length === 0 && livePidfiles.length === 0;
  const restore = makeRestore(opts, running);

  return {
    cleared,
    ...(cleared ? {} : { reason: notClearedReason(opts.platform, stillPresent, livePidfiles) }),
    targets,
    running,
    stillPresent,
    livePidfiles,
    restore,
  };
}

/** Probe a target's up-state + live PID BEFORE any stop (leg-3 needs the PID). */
async function probeTarget(opts: MigrationGateOptions, t: ServiceTarget): Promise<TargetProbe> {
  if (opts.platform === "darwin") {
    let r: GateExecResult;
    try {
      r = await opts.env.exec(["launchctl", "print", `gui/${opts.uid.toString()}/${t.label}`]);
    } catch {
      // launchctl unreachable — assume UP, no PID (fail-closed downstream).
      return { target: t, running: true };
    }
    if (r.code !== 0) return { target: t, running: false };
    const pid = parseLaunchctlPid(r.stdout);
    return { target: t, running: true, ...(pid !== undefined && { pid }) };
  }
  // Linux: is-active for up-state, `show MainPID` for the PID.
  let up: boolean;
  try {
    const r = await opts.env.exec(["systemctl", "--user", "is-active", t.unit]);
    up = SYSTEMD_UP_STATES.has(r.stdout.trim());
  } catch {
    return { target: t, running: true }; // manager unreachable — assume UP, no PID
  }
  const pid = await linuxMainPid(opts, t);
  const running = up || pid !== undefined;
  return { target: t, running, ...(pid !== undefined && { pid }) };
}

/** Read a systemd unit's `MainPID` (0/absent → undefined). */
async function linuxMainPid(opts: MigrationGateOptions, t: ServiceTarget): Promise<number | undefined> {
  try {
    const r = await opts.env.exec([
      "systemctl",
      "--user",
      "show",
      t.unit,
      "--property=MainPID",
      "--value",
    ]);
    const n = parseInt(r.stdout.trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Parse `pid = <n>` out of a `launchctl print` dump. */
function parseLaunchctlPid(stdout: string): number | undefined {
  const m = /^\s*pid = (\d+)/m.exec(stdout);
  if (m?.[1] === undefined) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Issue the authoritative stop for one target. Never throws — a stop that
 *  couldn't run surfaces as a failed death proof (fail-closed). */
async function stopTarget(opts: MigrationGateOptions, t: ServiceTarget): Promise<void> {
  try {
    if (opts.platform === "darwin") {
      await opts.env.exec(["launchctl", "bootout", `gui/${opts.uid.toString()}/${t.label}`]);
    } else {
      await opts.env.exec(["systemctl", "--user", "stop", t.unit]);
    }
  } catch {
    // Swallow — a stop that couldn't run leaves the target UP, which the death
    // proof below catches as stillPresent.
  }
}

/**
 * The three-leg death proof. Returns `true` ONLY when the manager reports the
 * service down AND the pre-stop PID has exited. A target that was down at
 * pre-check with no PID passes on the manager verdict alone (nothing to bury).
 */
async function proveDead(
  opts: MigrationGateOptions,
  p: TargetProbe,
  drain: DrainPolicy,
): Promise<boolean> {
  if (!(await verifyManagerDown(opts, p.target))) return false; // leg 2
  if (p.pid === undefined) {
    // No PID to confirm. Safe ONLY if it was never up (else we can't prove death).
    return !p.running;
  }
  return waitForDeath(opts.env, p.pid, drain); // leg 3
}

/** Leg 2: a manager-REACHED down verdict. A throw or a non-definitive word (the
 *  manager-unreachable signature) is NOT proof → returns `false` (present). */
async function verifyManagerDown(opts: MigrationGateOptions, t: ServiceTarget): Promise<boolean> {
  try {
    if (opts.platform === "darwin") {
      const r = await opts.env.exec(["launchctl", "print", `gui/${opts.uid.toString()}/${t.label}`]);
      return r.code !== 0; // left the domain (from a call that did not throw)
    }
    const r = await opts.env.exec(["systemctl", "--user", "is-active", t.unit]);
    return SYSTEMD_DOWN_WORDS.has(r.stdout.trim()); // exactly inactive|failed
  } catch {
    return false; // manager unreachable → cannot prove → present
  }
}

/** Leg 3: poll `kill(pid,0)` until `ESRCH`, bounded by the drain window. */
async function waitForDeath(env: GateEnv, pid: number, drain: DrainPolicy): Promise<boolean> {
  const deadline = env.now() + drain.drainTimeoutMs;
  while (env.procAlive(pid)) {
    if (env.now() >= deadline) return false; // still draining past the window → present
    await env.sleep(drain.pollIntervalMs);
  }
  return true;
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

/** macOS restore: `bootstrap` the plist back, `kickstart`, confirm with `print`. */
async function restoreDarwin(
  opts: MigrationGateOptions,
  t: ServiceTarget,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const gui = `gui/${opts.uid.toString()}`;
  await opts.env.exec(["launchctl", "bootstrap", gui, t.plistPath]);
  await opts.env.exec(["launchctl", "kickstart", "-k", `${gui}/${t.label}`]);
  const check = await opts.env.exec(["launchctl", "print", `${gui}/${t.label}`]);
  if (check.code === 0) return { ok: true };
  return {
    ok: false,
    reason: `launchctl print ${t.label} still non-zero after bootstrap (${check.code.toString()}): ${check.stderr.trim()}`,
  };
}

/** Linux restore: `systemctl --user start`, confirm with `is-active`. */
async function restoreLinux(
  opts: MigrationGateOptions,
  t: ServiceTarget,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  await opts.env.exec(["systemctl", "--user", "start", t.unit]);
  const check = await opts.env.exec(["systemctl", "--user", "is-active", t.unit]);
  if (SYSTEMD_UP_STATES.has(check.stdout.trim())) return { ok: true };
  return {
    ok: false,
    reason: `systemctl --user is-active ${t.unit} = ${JSON.stringify(check.stdout.trim())} after start`,
  };
}

/** Human-readable fail-closed reason naming the not-proven-dead targets + any
 *  live-pidfile belt hits. */
function notClearedReason(
  platform: GatePlatform,
  stillPresent: readonly ServiceTarget[],
  livePidfiles: readonly LivePidfile[],
): string {
  const parts: string[] = [];
  if (stillPresent.length > 0) {
    const how =
      platform === "darwin"
        ? "`launchctl print` still resolves them, or the PID is still draining, or launchctl is unavailable"
        : "`systemctl --user is-active` is not a clean down word, or the PID is still draining, or systemctl is unavailable";
    const which = stillPresent.map((t) => (platform === "darwin" ? t.label : t.unit)).join(", ");
    parts.push(`${stillPresent.length.toString()} service target(s) not proven dead (${how}): ${which}`);
  }
  if (livePidfiles.length > 0) {
    const which = livePidfiles.map((l) => `${l.configPath} → pid ${l.pid.toString()}`).join(", ");
    parts.push(
      `${livePidfiles.length.toString()} stack(s) with a LIVE pidfile (running daemon, no service unit needed): ${which}`,
    );
  }
  return `migration gate REFUSED to clear (fail-closed): ${parts.join("; ")}`;
}

// =============================================================================
// Production wiring
// =============================================================================

/** A real `Bun.spawn`-backed {@link GateExec}. */
export const bunGateExec: GateExec = async (argv) => {
  const [cmd, ...rest] = argv;
  const proc = Bun.spawn([cmd ?? "", ...rest], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
};

/** The default {@link GateEnv}: real subprocess, real `kill(pid,0)`, real clock. */
export const bunGateEnv: GateEnv = {
  exec: bunGateExec,
  procAlive: (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0); // signal 0 = liveness probe, delivers nothing
      return true;
    } catch (err) {
      // ESRCH = no such process (dead). Anything else (EPERM/…) = exists but not
      // ours → assume ALIVE (fail-closed).
      return (err as { code?: string }).code !== "ESRCH";
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/** Map `process.platform` onto the supported {@link GatePlatform} set. */
export function currentGatePlatform(): GatePlatform {
  return process.platform === "darwin" ? "darwin" : "linux";
}

/** Resolve the launchd `gui/<uid>` target uid. */
export function resolveGateUid(uid?: number): number {
  return uid ?? process.getuid?.() ?? 501;
}

/** Shared options for the batteries-included entry points. */
export interface ClearFleetOptions {
  platform?: GatePlatform;
  uid?: number;
  env?: GateEnv;
  drain?: DrainPolicy;
  configDir?: string;
  launchAgentsDir?: string;
  systemdUserDir?: string;
  io?: DaemonLocatorIO;
  discoverSlugs?: (configDir: string) => string[];
  home?: string;
  /** Belt seams (tests inject stackConfigPaths / pidFilePathFor / readPidFile).
   *  `configDir` + `home` are folded in automatically. */
  belt?: PidfileBeltConfig;
}

/** Enumerate the fleet + run the gate with host-derived defaults. The belt is
 *  ALWAYS wired here, so the production path can never clear a hand-started
 *  daemon that has no service unit. */
export async function clearFleetForMigration(
  opts: ClearFleetOptions = {},
): Promise<MigrationGateResult> {
  const platform = opts.platform ?? currentGatePlatform();
  const targets = enumerateServiceTargets({
    platform,
    ...(opts.configDir !== undefined && { configDir: opts.configDir }),
    ...(opts.launchAgentsDir !== undefined && { launchAgentsDir: opts.launchAgentsDir }),
    ...(opts.systemdUserDir !== undefined && { systemdUserDir: opts.systemdUserDir }),
    ...(opts.io !== undefined && { io: opts.io }),
    ...(opts.discoverSlugs !== undefined && { discoverSlugs: opts.discoverSlugs }),
    ...(opts.home !== undefined && { home: opts.home }),
  });
  const belt: PidfileBeltConfig = {
    ...(opts.configDir !== undefined && { configDir: opts.configDir }),
    ...(opts.home !== undefined && { home: opts.home }),
    ...opts.belt,
  };
  return runMigrationGate({
    platform,
    uid: resolveGateUid(opts.uid),
    env: opts.env ?? bunGateEnv,
    targets,
    belt,
    ...(opts.drain !== undefined && { drain: opts.drain }),
  });
}

/** The result of {@link withMigrationGate}. */
export interface MigrationRunResult<T> {
  /** Whether the gate cleared (and therefore the migration ran). */
  cleared: boolean;
  gate: MigrationGateResult;
  /** The finally-guaranteed restore outcome (present whenever the fleet was
   *  brought back — i.e. every path except a migration that itself threw, where
   *  the restore still ran but the throw propagates to the caller). */
  restore: RestoreResult;
  /** The migration fn's return value (only on the cleared + no-throw path). */
  result?: T;
}

/**
 * The BLESSED entry X-07/X-11 use (A-RESTORE). Runs `migrate` ONLY after the gate
 * clears, inside a `try/finally` that ALWAYS restores the pre-running fleet — so a
 * migration that throws can never strand the fleet down (bootout/stop persist).
 * When the gate REFUSES, `migrate` is not called and the fleet is restored
 * immediately (the gate had already stopped everything to probe it).
 */
export async function withMigrationGate<T>(
  opts: ClearFleetOptions,
  migrate: (gate: MigrationGateResult) => Promise<T>,
): Promise<MigrationRunResult<T>> {
  const gate = await clearFleetForMigration(opts);
  if (!gate.cleared) {
    const restore = await gate.restore();
    return { cleared: false, gate, restore };
  }
  let result: T | undefined;
  let restore!: RestoreResult;
  try {
    result = await migrate(gate);
  } finally {
    // GUARANTEE: whether migrate returned or threw, the fleet comes back.
    restore = await gate.restore();
  }
  return { cleared: true, gate, restore, ...(result !== undefined && { result }) };
}
