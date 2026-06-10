/**
 * ML.5 — schedulable cockpit-refresh loop.
 *
 * The bot (cortex.ts) runs `refreshCockpit` on an interval so the cockpit stays
 * live: real data ingested + reconciled + attention notifications published.
 * This is the testable schedule wrapper — the scheduler is injectable so the
 * timing logic is unit-tested without real timers, and production passes
 * setInterval/clearInterval. Best-effort: a failed run never throws out of the
 * tick (it routes to `onError`), so one bad refresh can't kill the loop.
 */
export interface CockpitRefreshLoopOptions {
  /** One refresh pass (e.g. () => refreshCockpit(db, opts)). */
  run: () => Promise<unknown>;
  /** Interval between refreshes (ms). */
  intervalMs: number;
  /** Called with any error a run throws/rejects. Defaults to a stderr line. */
  onError?: (err: unknown) => void;
  /** Run once immediately on start (default true) so the first refresh isn't a full interval away. */
  runOnStart?: boolean;
  /**
   * Injectable scheduler — returns a canceller. Defaults to
   * setInterval/clearInterval. Tests pass a fake to drive ticks deterministically.
   */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface CockpitRefreshLoop {
  /**
   * Stop the loop (idempotent). Clears the schedule, then awaits any in-flight
   * tick so a parked `run()` settles before callers tear down shared resources
   * the run touches (e.g. closing the bun:sqlite handle in cortex.ts's drain).
   * A tick that rejects still releases the await (error isolation preserved).
   */
  stop: () => Promise<void>;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const id = setInterval(fn, ms);
  return () => {
    clearInterval(id);
  };
};

export function startCockpitRefreshLoop(opts: CockpitRefreshLoopOptions): CockpitRefreshLoop {
  const schedule = opts.schedule ?? defaultSchedule;
  const onError =
    opts.onError ??
    ((err: unknown) =>
      process.stderr.write(
        `[cockpit-refresh-loop] refresh failed: ${err instanceof Error ? err.message : String(err)}\n`
      ));

  // The currently-running tick, tracked so `stop()` can await an in-flight run
  // before shared resources (the bun:sqlite handle) are torn down. `null`
  // between ticks. The tracked promise is the error-isolated one, so awaiting it
  // in stop() never rejects.
  let inFlight: Promise<void> | null = null;

  // Each tick is self-isolating: a rejected run routes to onError, never
  // escaping. The isolated promise is recorded so stop() can join it, and
  // cleared on settle so we never await a stale run.
  const tick = (): void => {
    const run = Promise.resolve()
      .then(() => opts.run())
      .then(
        () => undefined,
        (err: unknown) => { onError(err); },
      )
      .finally(() => {
        if (inFlight === run) inFlight = null;
      });
    inFlight = run;
  };

  if (opts.runOnStart !== false) tick();
  const cancel = schedule(tick, opts.intervalMs);

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      cancel();
      // Await the in-flight tick (if any) so a parked run settles before the
      // caller closes resources it touches. The tracked promise is already
      // error-isolated — it resolves on both success and failure.
      if (inFlight) await inFlight;
    },
  };
}
