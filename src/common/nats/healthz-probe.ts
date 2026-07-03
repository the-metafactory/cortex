/**
 * cortex#1495 v3 (suggestion) — the ONE nats-server `/healthz` monitor probe,
 * shared by both nats restart-safety adapters (`network-adapters.ts`
 * `buildNatsServerPort.isHealthy` for join, `network-make-live-adapters.ts`
 * `buildNatsCanaryAdapter.isHealthy` for make-live) so the fetch + timeout +
 * error-mapping body can't drift between them.
 *
 * A bounded `fetch` of `<base>/healthz`: a 200 is healthy; a non-200 or a
 * connect error is unhealthy; a TimeoutError (the monitor accepted the TCP
 * connection but never responded — a hung/deadlocked nats-server) is unhealthy
 * with a distinct, actionable reason. NEVER throws.
 */

import type { HealthProbeResult } from "./restart-with-settle";

/**
 * Probe `<base>/healthz` with a `timeoutMs` bound (`base` is the monitor URL,
 * e.g. `http://127.0.0.1:8222`; a trailing slash is tolerated). Returns
 * `{ healthy: true }` on a 200, else `{ healthy: false, reason }`.
 */
export async function probeHealthzMonitor(base: string, timeoutMs: number): Promise<HealthProbeResult> {
  const clean = base.replace(/\/+$/, "");
  try {
    const res = await fetch(`${clean}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return {
        healthy: false,
        reason: `nats-server monitor ${clean}/healthz returned HTTP ${res.status.toString()}`,
      };
    }
    return { healthy: true };
  } catch (err) {
    // A timeout/abort means the monitor accepted but did not respond in time —
    // the bus is hung, NOT healthy. A connection error means it's down or the
    // port isn't listening. Distinguish the timeout for an actionable reason.
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    return {
      healthy: false,
      reason: isTimeout
        ? `nats-server monitor ${clean}/healthz timed out after ${timeoutMs.toString()}ms (accepted the connection but never responded — bus hung)`
        : `nats-server monitor ${clean} unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
