import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("ConfigWatcher reloads when the readiness write and config write share one notification", () => {
  // Isolate the fs mock so the native watcher suites keep their real backend.
  const script = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    let notify;
    let notifications = 0;
    mock.module("node:fs", () => ({
      ...fs,
      watch: (_path, _options, listener) => {
        notify = listener;
        return { close() {} };
      },
    }));
    const { ConfigWatcher } = await import(${JSON.stringify(fileURLToPath(new URL("../watcher.ts", import.meta.url)))});
    const { loadConfig } = await import(${JSON.stringify(fileURLToPath(new URL("../loader.ts", import.meta.url)))});
    const dir = fs.mkdtempSync(join(tmpdir(), "config-watcher-coalesced-"));
    const path = join(dir, "bot.yaml");
    const yaml = "agent:\\n  name: test\\n  displayName: Test\\nclaude:\\n  timeoutMs: 120000\\n";
    let watcher;
    let deadline;
    try {
      fs.writeFileSync(path, yaml, { mode: 0o600 });
      let report;
      const reloaded = new Promise((resolve) => { report = resolve; });
      watcher = new ConfigWatcher(path, loadConfig(path), report);
      watcher.start();
      const ready = watcher.waitForReady();
      // Model a backend that coalesces the probe and the immediately following
      // real write: there is only one notification, not one per write.
      notify("change");
      notifications++;
      await ready;
      fs.writeFileSync(path, yaml.replace("120000", "180000"));
      const event = await Promise.race([
        reloaded,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("coalesced change was lost")), 2000);
        }),
      ]);
      console.log(JSON.stringify({ notifications, applied: event.applied, timeoutMs: event.config.claude.timeoutMs }));
    } finally {
      clearTimeout(deadline);
      watcher?.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
  const lastLine = result.stdout.toString().trim().split("\n").at(-1)!;
  expect(JSON.parse(lastLine)).toEqual({ notifications: 1, applied: ["claude.timeoutMs"], timeoutMs: 180_000 });
}, 15_000);
