// glossary-ignore: run
export const VIGIL_TICK_MS = 300_000;

export interface VigilTickOptions {
  /** One synchronous or asynchronous pass; both throws and rejections are isolated. */
  run: () => unknown;
  intervalMs?: number;
  onError?: (err: unknown) => void;
  /** Returns a canceller; tests drive the captured callback without real timers. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setInterval(fn, ms);
  return () => { clearInterval(timer); };
};

/** Start immediately, isolate failures, and drain before shared resources close. */
export function startVigilTick(opts: VigilTickOptions): { stop(): Promise<void> } {
  const onError = opts.onError ?? ((err: unknown) => {
    console.warn(`vigil: tick failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const tick = (): void => {
    if (stopped || inFlight) return;
    inFlight = Promise.resolve()
      .then(() => opts.run())
      .then(() => undefined, (err: unknown) => { onError(err); })
      .finally(() => { inFlight = null; });
  };
  tick();
  const cancel = (opts.schedule ?? defaultSchedule)(tick, opts.intervalMs ?? VIGIL_TICK_MS);
  return {
    stop: async () => {
      if (!stopped) {
        stopped = true;
        cancel();
      }
      // Concurrent stop calls all join the same pass.
      if (inFlight) await inFlight;
    },
  };
}
