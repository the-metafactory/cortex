/**
 * cortex#1495 v3 (nit) — shared test helpers for the settle-window / restart
 * canary tests, so `network-lib.test.ts` and `network-make-live.test.ts` don't
 * each copy the same fake clock.
 */

import type { ClockPort } from "../../../../common/nats/restart-with-settle";

/**
 * A {@link ClockPort} whose `sleep` resolves IMMEDIATELY (no real `setTimeout`),
 * so a multi-attempt settle window never actually waits in tests. Pass a `delays`
 * array to RECORD every requested delay and assert the backoff SCHEDULE without
 * paying its wall-clock cost.
 */
export function instantClock(delays: number[] = []): ClockPort {
  return {
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}
