/**
 * `cortex quickstart` — injected-dependency seams (cortex#2094, L3).
 *
 * Mirrors the `network-doctor-ports.ts` / `network-ping-ports.ts` pattern: the
 * orchestrator (`quickstart-lib.ts` + `quickstart.ts`) is written against these
 * PORTS; the live adapters (`quickstart-adapters.ts`) wire real `PATH` lookups,
 * real subprocess spawns (`claude --version`, `loginctl`, `systemctl`, the
 * provisioning shell script), and real HTTP (`/healthz`). Tests inject fakes
 * that never touch a real PATH, spawn a real process, or open a real socket —
 * load-bearing on macOS dev machines, where `systemctl`/`loginctl` don't exist
 * at all.
 *
 * Every port method is synchronous or returns a plain awaited value (no
 * streaming) — quickstart is a short, linear, one-shot CLI run, not a
 * long-lived supervisor; there is no need for the richer `Spawn`/watchdog
 * shape `process-runner.ts` uses for detached bus-triggered jobs.
 */

// =============================================================================
// Shared result shape
// =============================================================================

/** Outcome of a synchronous subprocess run. Never throws on a non-zero exit —
 *  callers branch on `exitCode`; a thrown port method means the subprocess
 *  could not even be spawned (binary missing, EACCES, …). */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// =============================================================================
// Preflight — step 1 (all read-only)
// =============================================================================

export interface PreflightPorts {
  /** Resolve a binary on `PATH`. Returns the resolved path, or `undefined`
   *  when not found. Never throws. */
  which(bin: string): string | undefined;
  /** Spawn `claude --version` and capture the result. Only called when
   *  `which("claude")` already resolved — a missing binary is reported by
   *  `which` alone, not by attempting to spawn it. */
  claudeVersion(): CommandResult;
  /**
   * Linux-only: `loginctl show-user "<user>" -p Linger` — whether the user's
   * systemd session survives logout (REQUIRED for `systemctl --user` units to
   * keep running after an SSH session ends). `"unknown"` when the check could
   * not run (e.g. `loginctl` missing) — quickstart treats that as a soft
   * warning, not a hard preflight failure, since it can only be conclusively
   * verified on a systemd host anyway.
   */
  lingerStatus(user: string): "yes" | "no" | "unknown";
}

// =============================================================================
// Service — step 7 (systemd user units, Linux only)
// =============================================================================

/**
 * The injectable host-service seam. The orchestrator branches off
 * `process.platform`: Linux drives the systemd methods
 * (`unitFileExists`/`daemonReload`/`enableNow`/`tryRestart`/`isActive`),
 * darwin drives the launchd methods (`launchdServiceLoaded`/
 * `launchdKickstart`) — restart-only; arc owns the launchd load/unload
 * lifecycle (cortex#2283). `truncateLog` — pure fs — is shared by both
 * branches, always paired with the (re)start that follows it. This interface
 * exists so a test can inject a fake systemctl/launchctl and assert the exact
 * invocations quickstart makes, without a real systemd/launchd on the test
 * host (arc's L2 pattern, referenced in cortex#2094's acceptance criteria).
 */
export interface ServicePort {
  /** Absolute path a systemd user unit named `unit` would be rendered at —
   *  used to confirm L1 (cortex#2071) already rendered `nats@.service` /
   *  `cortex@.service` before quickstart tries to enable an instance of them.
   *  Read-only existence probe; never renders a unit itself (out of scope —
   *  see cortex#2094 "explicitly out of scope"). */
  unitFileExists(unitTemplate: string): boolean;
  /** `systemctl --user daemon-reload`. */
  daemonReload(): CommandResult;
  /**
   * cortex#2264 / cortex#2283 — truncate ONE append-mode daemon log file to
   * EMPTY, immediately before the (re)start below, so step 8's gate only ever
   * reads CURRENT-boot content. Called once per log file — step 7
   * pair-truncates BOTH the `.error.log` (a stale prior-boot failure line
   * would make the gate fast-fail before the fresh boot connects,
   * cortex#2264) AND the main `.log` (stale prior-boot HEALTHY lines would
   * otherwise satisfy the gate's positive signal even when the relaunched
   * daemon dies on a still-broken config — a sub-second false-GREEN over a
   * dead daemon; cortex#2283 adversarial review F1). Both systemd (`append:`)
   * and launchd (`Std{Out,Error}Path`, cortex#2282-unified) append and never
   * truncate on their own. Called ONLY in branches that actually (re)start
   * the daemon — a truncate is only safe paired with a restart
   * (truncate → restart → gate), else it destroys current-boot evidence; the
   * darwin branch calls it immediately before its `launchctl kickstart -k`,
   * and ONLY when the service is loaded (i.e. only when a restart follows).
   * Best-effort: never throws — a failure here degrades the gate to its honest
   * timeout path, never a false-fail. `logPath` is an exact path computed by
   * `daemonLogPath()` / `daemonErrorLogPath()`.
   */
  truncateLog(logPath: string): void;
  /** `systemctl --user enable --now <units...>` — enables (idempotent) and
   *  STARTS any stopped unit (`--now` = `start`); a silent no-op only for
   *  units already active. */
  enableNow(units: string[]): CommandResult;
  /**
   * cortex#2283 — `systemctl --user try-restart <units...>`: restart the
   * given units (restart-if-running; stopped units are untouched). Issued for
   * exactly the units the `isActive` pre-probe found RUNNING — those are the
   * ones `enableNow` silently no-ops on, so this is what re-applies fixed
   * configs on a recovery re-run. NEVER issued for units the probe found
   * stopped: `enable --now` just STARTED those, and a blanket try-restart
   * would kill the fresh instance mid-bus-connect, landing its one-shot
   * `failed to connect` marker in the just-truncated `.error.log` and
   * fast-failing the gate on a healthy system (cortex#2283 adversarial
   * review F2 — the unconditional sequence in the original issue spec was
   * wrong). Restart of RUNNING units remains unconditional — this is
   * run-state selection, not the out-of-scope config-changed detection.
   */
  tryRestart(units: string[]): CommandResult;
  /**
   * cortex#2283 — `systemctl --user is-active --quiet <unit>` (exit 0 →
   * active). READ-ONLY pre-start probe with two consumers: it selects which
   * units get `tryRestart` (probed-active only — see tryRestart above), and
   * it names the per-unit action taken in step 7's output ("restarted
   * (config re-applied)" vs "started (first boot)"). It never gates WHETHER
   * a running unit is restarted — that stays unconditional.
   */
  isActive(unit: string): boolean;
  /**
   * cortex#2283 — darwin guard: `launchctl print gui/$UID/<label>` exit 0 ⇔
   * the service is loaded in the user's GUI domain. Quickstart restarts ONLY
   * a loaded service; load/unload stays arc-owned (out of scope).
   */
  launchdServiceLoaded(label: string): boolean;
  /**
   * cortex#2283 — `launchctl kickstart -k gui/$UID/<label>`: kill + restart
   * the loaded service, so a re-run picks up patched configs on macOS. The
   * `gui/$UID/` domain target is built inside the live adapter (real UID);
   * callers pass the bare plist Label (`launchdStackLabel()`).
   */
  launchdKickstart(label: string): CommandResult;
  /**
   * cortex#2322 — darwin FRESH-HOST backstop probe: is a `cortex start`
   * daemon for this pointer config already running? Reads the pointer's
   * pidfile (`pidFileFor()`, the SAME derivation `cortex start` writes) and
   * liveness-probes the pid (`process.kill(pid, 0)`; EPERM counts as alive).
   *
   * This is the idempotency guard for the not-loaded path: arc owns the
   * launchd load/unload lifecycle, so on a fresh Mac the stack service is
   * never loaded — {@link launchdServiceLoaded} is false and the pre-#2322
   * code just SKIPPED, leaving the daemon down and Step 8's gate to time out.
   * Now the not-loaded path starts the daemon directly via
   * {@link startDaemonBackstop}; this probe lets a RE-RUN see the already-
   * running backstop daemon and skip cleanly instead of double-starting.
   */
  daemonBackstopRunning(pointerConfigPath: string): boolean;
  /**
   * cortex#2322 — darwin FRESH-HOST backstop start: launch the stack daemon
   * DETACHED via `cortex start --config <pointerConfigPath>`, redirecting the
   * child's stdout → `logPath` and stderr → `errorLogPath` (the SAME two files
   * the launchd plist's `Std{Out,Error}Path` target and Step 8's gate greps —
   * `daemonLogPath()` / `daemonErrorLogPath()`), so the gate reads this boot's
   * output on darwin exactly as it does under launchd (cortex#2282).
   *
   * Detached + `unref`'d: the daemon runs on past quickstart's own exit (it is
   * a long-lived process, quickstart is a one-shot CLI). Returns a
   * `CommandResult` whose `exitCode === 0` ⇔ the spawn LAUNCHED (the daemon's
   * own health is then confirmed by Step 8's gate, not by this call). It does
   * NOT touch the launchd load/unload lifecycle — that stays arc-owned; this
   * is the exact `cortex start --config <pointer>` backstop the luna-stack
   * bundle + runbook §F2 document, lifted into quickstart so every consumer
   * benefits (cortex#2322). Paired with a preceding both-logs truncate
   * (truncate → start → gate), same ordering contract as the loaded path.
   */
  startDaemonBackstop(opts: {
    pointerConfigPath: string;
    logPath: string;
    errorLogPath: string;
  }): CommandResult;
}

// =============================================================================
// Provision — step 6 (stack signing identity)
// =============================================================================

/**
 * The SAME entry point `postupgrade.sh` uses (`provision_stack_identity`,
 * `scripts/lib/stack-identity-provision.sh`) — quickstart does not
 * reimplement seed generation or the G3 nkey_pub write-back, it invokes the
 * one existing, already-idempotent shell helper. `stdout`/`stderr` here are
 * the helper's own human-readable progress log (never a secret — the seed
 * itself is never printed by that script).
 */
export interface ProvisionPort {
  provisionSeed(stackConfigPath: string, nkeyBasename: string): CommandResult;
}

// =============================================================================
// Gate — step 8 (bounded healthy-boot wait)
// =============================================================================

export interface GatePort {
  /** Read the daemon log file. `undefined` when it doesn't exist yet (the
   *  daemon hasn't written anything, or hasn't started). Never throws. */
  readLog(logPath: string): string | undefined;
  /** GET `<url>/healthz` with a bounded timeout. `true` only on a 2xx
   *  response; any failure (unreachable, timeout, non-2xx) is `false`. */
  fetchHealthz(url: string, timeoutMs: number): Promise<boolean>;
  /** Injectable sleep — tests pass a no-op/near-instant version so the
   *  bounded-wait poll loop doesn't actually block for real wall-clock time. */
  sleep(ms: number): Promise<void>;
  /** Injectable clock — `Date.now` in production, a controllable counter in
   *  tests, so the poll loop's deadline arithmetic is deterministic. */
  now(): number;
}

// =============================================================================
// The ports bundle
// =============================================================================

export interface QuickstartPorts {
  preflight: PreflightPorts;
  service: ServicePort;
  provision: ProvisionPort;
  gate: GatePort;
}
