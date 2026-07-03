/**
 * cortex#1483 (join-4, epic #1479) — SHARED nats restart-safety primitives, used
 * by BOTH `cortex network join` (network-lib.ts) and `cortex network make-live`
 * (network-make-live-lib.ts) around a nats-server restart:
 *
 *   - {@link probeHealthWithSettle} — the settle-window health-probe retry/backoff.
 *   - {@link ConfigValidationOutcome} — the three-state `nats-server -t` verdict
 *     (VALID / INVALID / SKIPPED) so a "could not validate" is never silently
 *     mistaken for "valid" (cortex#1495 BLOCKER).
 *   - {@link settleFailureReason} — the ONE settle-failure message string, so the
 *     join and make-live wordings can never drift (cortex#1495 nit 5).
 *
 * ## The bug the settle window closes
 *
 * `join --apply`'s restart called the health probe EXACTLY ONCE, immediately
 * after the restart exec returned. A freshly-restarted nats-server needs a
 * moment to rebind its HTTP monitor port; a single immediate probe races that
 * startup window and reads a HEALTHY bus as DOWN — which then (a) rolled back
 * a GOOD config and (b) false-alarmed "bus may be DOWN, intervene manually" on
 * a perfectly healthy bus (the community incident, 2026-07-03, tracked as
 * #1476 gap 2). `make-live`'s restart had NO health verification at all —
 * `launchctl kickstart`/`systemctl restart` exiting 0 was trusted blindly, so a
 * restart that "succeeded" while nats-server then crashed on the new config
 * went unnoticed.
 *
 * {@link probeHealthWithSettle} polls the health probe up to `maxAttempts`
 * times with exponential backoff, succeeding as soon as ANY attempt reports
 * healthy. Only exhausting every attempt without a healthy result is a genuine
 * failure — the one signal a caller may act on (rollback).
 *
 * Pure over an injected {@link ClockPort} so tests run instantly (no real
 * `setTimeout` wait) while still asserting the backoff SCHEDULE and the exact
 * number of probe attempts.
 */

/** Injectable wall-clock wait, so tests never really sleep. */
export interface ClockPort {
  /** Wait `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
}

/** Real wall-clock — the production default. */
export const realClock: ClockPort = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * A single health-probe outcome. `inconclusive` (cortex#1495 important 3) marks
 * the #831 no-monitor case: the bus declares no monitor, so liveness cannot be
 * CONFIRMED — treated as healthy (never a false rollback) but flagged so the
 * caller's log can say "inconclusive, treated as healthy" instead of the
 * over-claimed "verified healthy".
 */
export type HealthProbeResult =
  | { healthy: true; inconclusive?: boolean }
  | { healthy: false; reason: string };

/** A single health check — e.g. `NatsServerPort.isHealthy`. Never throws by contract. */
export type HealthProbe = () => Promise<HealthProbeResult>;

/**
 * cortex#1495 BLOCKER — the THREE-state `nats-server -t` verdict. A "could not
 * validate" (binary missing / spawn failure) MUST NOT be silently treated as
 * "valid" (fail-open), which would let a BAD config reload onto a live bus on
 * any host without `nats-server` on PATH. Callers refuse on `invalid`, warn
 * loudly + proceed on `skipped`, and proceed silently on `valid`.
 */
export type ConfigValidationOutcome =
  | { status: "valid" }
  | { status: "invalid"; reason: string }
  | { status: "skipped"; reason: string };

/** Tunables for {@link probeHealthWithSettle}. Every field optional — sane defaults below. */
export interface SettleWindowOptions {
  /** Max number of health polls, including the first. Default {@link DEFAULT_SETTLE_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Delay BEFORE the 2nd attempt (ms). Default {@link DEFAULT_SETTLE_INITIAL_DELAY_MS}. */
  initialDelayMs?: number;
  /** Multiplier applied to the delay after each failed attempt. Default {@link DEFAULT_SETTLE_BACKOFF_MULTIPLIER}. */
  backoffMultiplier?: number;
  /** Cap on the per-attempt delay (ms). Default {@link DEFAULT_SETTLE_MAX_DELAY_MS}. */
  maxDelayMs?: number;
}

/**
 * 5 attempts, starting at 500ms and doubling (capped at 4000ms), is a ~7.5s
 * worst-case settle window — generous for a loopback nats-server monitor to
 * rebind after `launchctl kickstart`/`systemctl restart`, far below any
 * "the CLI is wedged" threshold.
 */
export const DEFAULT_SETTLE_MAX_ATTEMPTS = 5;
export const DEFAULT_SETTLE_INITIAL_DELAY_MS = 500;
export const DEFAULT_SETTLE_BACKOFF_MULTIPLIER = 2;
export const DEFAULT_SETTLE_MAX_DELAY_MS = 4000;

export interface SettleResult {
  healthy: boolean;
  /** How many probe attempts ran (1..maxAttempts). */
  attempts: number;
  /**
   * cortex#1495 important 3 — set when the winning (healthy) attempt was
   * INCONCLUSIVE (#831 no-monitor). Lets the caller log "inconclusive, treated
   * as healthy" rather than "verified healthy".
   */
  inconclusive?: boolean;
  /** The LAST failure reason — present iff `!healthy`. */
  reason?: string;
}

/**
 * The ONE settle-failure message (cortex#1495 nit 5) — join and make-live both
 * use it so their post-restart failure wordings can never drift.
 */
export function settleFailureReason(attempts: number, reason: string | undefined): string {
  return (
    `nats-server did not come back up after restart across ${attempts.toString()} ` +
    `health check(s) over the settle window (${reason ?? "unknown"})`
  );
}

/**
 * The ONE inconclusive-health notice (cortex#1495 v2 nit) — join and make-live
 * both log this when a restart's liveness probe was INCONCLUSIVE (no reachable
 * signal, treated as healthy so a good restart is never falsely rolled back).
 * Extracted so the four prior copies across the two orchestrators can't drift.
 */
export const INCONCLUSIVE_HEALTH_NOTICE =
  "health inconclusive — no monitor configured, treated as healthy per #831";

/**
 * Poll `probe` up to `maxAttempts` times with exponential backoff (capped at
 * `maxDelayMs`), returning as soon as ANY attempt reports healthy. Never
 * throws — {@link HealthProbe} implementations (e.g. `NatsServerPort.isHealthy`)
 * already never throw by contract; this function does not add its own guard so
 * a violation surfaces loudly rather than being silently absorbed.
 */
export async function probeHealthWithSettle(
  probe: HealthProbe,
  opts: SettleWindowOptions = {},
  clock: ClockPort = realClock,
): Promise<SettleResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_SETTLE_MAX_ATTEMPTS);
  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_SETTLE_INITIAL_DELAY_MS;
  const backoffMultiplier = opts.backoffMultiplier ?? DEFAULT_SETTLE_BACKOFF_MULTIPLIER;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_SETTLE_MAX_DELAY_MS;

  // cortex#1495 nit 1 — cap the delay ONCE per value (here at assignment), so the
  // sleep call never needs a second redundant Math.min.
  let delay = Math.min(initialDelayMs, maxDelayMs);
  let lastReason = "health probe never ran";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await probe();
    if (result.healthy) {
      return {
        healthy: true,
        attempts: attempt,
        ...(result.inconclusive === true && { inconclusive: true }),
      };
    }
    lastReason = result.reason;
    if (attempt < maxAttempts) {
      await clock.sleep(delay);
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }
  return { healthy: false, attempts: maxAttempts, reason: lastReason };
}
