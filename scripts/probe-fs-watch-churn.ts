import { mkdirSync, mkdtempSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FS_WATCH_CHURN_ISSUE = "https://github.com/oven-sh/bun/issues/44385";

export async function probeFsWatchChurn({
  watcherCount = 1000,
  trials = 8,
  settleMs = 1000,
  timeoutMs = 1500,
  graceMs = 2000,
} = {}): Promise<{ usable: boolean; reason: string }> {
  const root = mkdtempSync(join(tmpdir(), "cortex-watch-churn-"));
  const watchers: FSWatcher[] = [];
  const seen = new Set<string>();
  const started = performance.now();
  const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
  let extra: FSWatcher | undefined;
  let delivered = 0;
  let late = 0;
  let attempted = 0;
  const target = join(root, "target");
  const other = join(root, "other");
  const waitFor = async (name: string, duration: number) => {
    const deadline = performance.now() + duration;
    while (!seen.has(name) && performance.now() < deadline) await pause(20);
    return seen.has(name);
  };
  const reason = (measurement: string) =>
    `native fs.watch churn: ${measurement}; ${watcherCount} background watchers, ${Math.round(performance.now() - started)}ms elapsed; ${FS_WATCH_CHURN_ISSUE}`;
  try {
    mkdirSync(target);
    mkdirSync(other);
    watchers.push(watch(target, { persistent: false }, (_event, name) => {
      if (name !== null) seen.add(String(name));
    }));
    for (let i = 0; i < watcherCount; i++) {
      const dir = join(root, `idle-${i}`);
      mkdirSync(dir);
      watchers.push(watch(dir, { persistent: false }, () => undefined));
    }
    await pause(settleMs * 2);
    writeFileSync(join(target, "control"), "control");
    if (!await waitFor("control", timeoutMs + graceMs)) {
      return { usable: false, reason: reason(`0/1 control writes delivered within ${timeoutMs + graceMs}ms; churn not measured`) };
    }
    for (let i = 0; i < trials; i++) {
      const operation = i % 2 === 0 ? "open" : "close";
      if (operation === "close") extra = watch(other, { persistent: false }, () => undefined);
      await pause(settleMs);
      const name = `${operation}-${i}`;
      if (operation === "open") extra = watch(other, { persistent: false }, () => undefined);
      else extra?.close();
      attempted++;
      writeFileSync(join(target, name), "changed");
      if (await waitFor(name, timeoutMs)) delivered++;
      else if (await waitFor(name, graceMs)) late++;
      else {
        return {
          usable: false,
          reason: reason(`control 1/1; ${delivered}/${attempted} writes delivered during unrelated watcher open/close (${late} late); ${name} missing after ${timeoutMs}ms + ${graceMs}ms grace`),
        };
      }
      extra?.close();
      extra = undefined;
    }
    return { usable: true, reason: reason(`control 1/1; ${delivered}/${attempted} writes delivered during unrelated watcher open/close (${late} late)`) };
  } finally {
    extra?.close();
    for (const watcher of watchers) watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await probeFsWatchChurn();
  console.log(JSON.stringify({ bun: Bun.version, platform: process.platform, ...result }));
  process.exitCode = result.usable ? 0 : 1;
}
