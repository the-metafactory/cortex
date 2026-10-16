// Test-only capability gate. Import only in suites requiring native fs.watch.
import { describe } from "bun:test";
import { mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROBE_TIMEOUT_MS = 10_000;

async function probeFsWatch(): Promise<{ usable: boolean; reason: string }> {
  const dir = mkdtempSync(join(tmpdir(), "cortex-fs-watch-probe-"));
  const started = performance.now();
  let events = 0;
  let writes = 0;
  let reportEvent!: () => void;
  const seen = new Promise<void>((resolve) => { reportEvent = resolve; });
  let watcher: ReturnType<typeof watch> | undefined;
  let writer: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let reportWriteError!: (result: { error: unknown }) => void;
  const failed = new Promise<{ error: unknown }>((resolve) => { reportWriteError = resolve; });
  try {
    // Setup and I/O errors are failures, not evidence of suppressed events.
    watcher = watch(dir, { persistent: false }, () => {
      events++;
      reportEvent();
    });
    // New names keep generating directory events even if watch registration
    // is delayed. Resolve on the event itself, never a startup grace sleep.
    const writeProbe = () => {
      writeFileSync(join(dir, `.probe-${++writes}`), "");
    };
    writeProbe();
    writer = setInterval(() => {
      try {
        writeProbe();
      } catch (err) {
        clearInterval(writer);
        reportWriteError({ error: err });
      }
    }, 50);
    const result = await Promise.race([
      seen,
      failed,
      new Promise<void>((resolve) => { deadline = setTimeout(resolve, PROBE_TIMEOUT_MS); }),
    ]);
    if (result) throw result.error;
    const elapsedMs = Math.round(performance.now() - started);
    return {
      usable: events > 0,
      reason: `native fs.watch received ${events} event(s) during ${writes} temporary-directory writes in ${elapsedMs}ms (deadline ${PROBE_TIMEOUT_MS}ms)`,
    };
  } finally {
    clearInterval(writer);
    clearTimeout(deadline);
    watcher?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// Module evaluation is shared by all importers in this test process: measure
// once, before suite collection, and reuse the result for every gated group.
export const fsWatchProbe = await probeFsWatch();
process.stderr.write(`[fs.watch probe] ${fsWatchProbe.reason}\n`);

export function describeWithFsWatch(name: string, fn: () => void): void {
  if (!fsWatchProbe.usable) {
    process.stderr.write(`[skip] "${name}": ${fsWatchProbe.reason}; native watcher coverage unavailable\n`);
  }
  describe.skipIf(!fsWatchProbe.usable)(name, fn);
}
