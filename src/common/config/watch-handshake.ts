/** How long a handshake first waits for its probe's event; doubles per unanswered probe. */
const READY_PROBE_FIRST_WAIT_MS = 100;
const READY_PROBE_MAX_WAIT_MS = 1_600;
/**
 * The `waitForReady()` handshake both watchers share: call `probe`, wait for
 * an event from the watcher, and on silence probe again with a
 * doubling wait, until `seen` resolves (resolve), `isStopped` turns true
 * (resolve — a test timed out and cleaned up), or `timeoutMs` runs out
 * (reject with the labelled deadline). Hooks and timers are always cleared.
 */
export async function awaitWatchHandshake(opts: {
  setHook: (hook: (() => void) | null) => void;
  probe: () => void;
  isStopped: () => boolean;
  timeoutMs: number;
  label: string;
}): Promise<void> {
  if (opts.isStopped()) return;
  const seen = new Promise<true>((resolve) => {
    opts.setHook(() => {
      // Stop consuming events before resolving: a backend may deliver the
      // next change in the same callback batch, before promise continuations.
      opts.setHook(null);
      resolve(true);
    });
  });
  const deadline = Date.now() + opts.timeoutMs;
  let waitMs = READY_PROBE_FIRST_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (;;) {
      if (opts.isStopped()) return;
      opts.probe();
      const wait = Math.max(0, Math.min(waitMs, deadline - Date.now()));
      const reported = await Promise.race([
        seen,
        new Promise<false>((resolve) => {
          timer = setTimeout(() => { resolve(false); }, wait);
        }),
      ]);
      clearTimeout(timer);
      if (reported) return;
      if (Date.now() >= deadline) {
        throw new Error(`${opts.label} reported no event within ${opts.timeoutMs}ms`);
      }
      waitMs = Math.min(waitMs * 2, READY_PROBE_MAX_WAIT_MS);
    }
  } finally {
    clearTimeout(timer);
    opts.setHook(null);
  }
}

