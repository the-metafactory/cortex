/**
 * cortex#1483 (join-4, epic #1479) — the SHARED settle-window health-probe
 * retry/backoff core, used by BOTH `cortex network join` (network-lib.ts) and
 * `cortex network make-live` (network-make-live-lib.ts) after a nats-server
 * restart.
 *
 * ## The bug this closes
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

export type HealthProbeResult = { healthy: true } | { healthy: false; reason: string };

/** A single health check — e.g. `NatsServerPort.isHealthy`. Never throws by contract. */
export type HealthProbe = () => Promise<HealthProbeResult>;

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
  /** The LAST failure reason — present iff `!healthy`. */
  reason?: string;
}

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

  let delay = initialDelayMs;
  let lastReason = "health probe never ran";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await probe();
    if (result.healthy) {
      return { healthy: true, attempts: attempt };
    }
    lastReason = result.reason;
    if (attempt < maxAttempts) {
      await clock.sleep(Math.min(delay, maxDelayMs));
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }
  return { healthy: false, attempts: maxAttempts, reason: lastReason };
}
