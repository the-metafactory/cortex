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
 * The injectable systemd seam. NEVER exercised on macOS in production
 * (quickstart's orchestrator skips the whole step off `process.platform`;
 * `truncateErrorLog` — pure fs — joins the darwin path only with A2 /
 * cortex#2283, paired with the restart it needs). This interface exists so a
 * test can inject a fake systemctl and assert the exact invocations
 * quickstart makes, without a real systemd on the test host (arc's L2
 * pattern, referenced in cortex#2094's acceptance criteria).
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
   * cortex#2264 — truncate the daemon's append-mode `.error.log` to EMPTY,
   * immediately before the (re)start below, so step 8's gate only ever reads
   * CURRENT-boot content. The `cortex@.service` unit routes `StandardError` with
   * `append:` (never truncates), so a failure line from a PRIOR boot would
   * otherwise persist and make the gate fast-fail on a stale line before the
   * fresh boot has even connected. Called ONLY in the Linux branch that
   * actually (re)starts the daemon — a truncate is only safe paired with a
   * restart (truncate → restart → gate), else it destroys current-boot
   * failure evidence. launchd's `StandardErrorPath` appends too (cortex#2282
   * unified the paths), so the darwin call arrives with A2 (cortex#2283)
   * alongside restart-on-re-run.
   * Best-effort: never throws — a failure here degrades the gate to its honest
   * timeout path, never a false-fail. `errorLogPath` is the exact path
   * `daemonErrorLogPath()` computes.
   */
  truncateErrorLog(errorLogPath: string): void;
  /** `systemctl --user enable --now <units...>`. */
  enableNow(units: string[]): CommandResult;
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
