import type { TurnRequest } from "./model";

const INTERVAL_MS = 100;

export function createTextBatcher(publish: TurnRequest["text"], halt: (reason: string) => void) {
  let pending = "";
  let lastAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  let failure: Error | null = null;
  let disposed = false;
  const clearTimer = (): void => { clearTimeout(timer); timer = undefined; };
  const check = (): void => { if (failure) throw failure; };
  const schedule = (): void => {
    if (disposed || failure || timer !== undefined || inFlight || !pending) return;
    timer = setTimeout(() => { void start(); }, Math.max(0, INTERVAL_MS - (Date.now() - lastAt)));
  };
  const start = (): Promise<void> => {
    clearTimer();
    if (inFlight) return inFlight;
    if (!pending || disposed || failure) return Promise.resolve();
    const text = pending;
    pending = "";
    lastAt = Date.now();
    inFlight = Promise.resolve().then(async () => { await publish?.(text); })
      .catch((error: unknown) => { failure = error instanceof Error ? error : new Error(String(error)); halt(failure.message); })
      .finally(() => { inFlight = null; schedule(); });
    return inFlight;
  };
  return {
    push(delta: string): void {
      check();
      if (disposed) throw new Error("The text batcher is closed.");
      pending += delta;
      schedule();
    },
    async flush(): Promise<void> {
      clearTimer();
      check();
      while (inFlight || pending) { await start(); clearTimer(); check(); }
    },
    async reset(): Promise<void> {
      clearTimer();
      pending = "";
      await inFlight;
      check();
      lastAt = 0;
      await publish?.("", true);
    },
    async dispose(): Promise<void> {
      disposed = true;
      clearTimer();
      pending = "";
      await inFlight;
      check();
    },
  };
}
