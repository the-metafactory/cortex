import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("native suite gate reports a measured churn loss after first-event delivery succeeds", () => {
  const script = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    let notify;
    const { writeFileSync } = fs;
    mock.module("node:fs", () => ({
      ...fs,
      watch: (_dir, _options, listener) => {
        notify = listener;
        return { close() {} };
      },
      writeFileSync: (...args) => {
        writeFileSync(...args);
        queueMicrotask(() => notify("rename", "probe"));
      },
    }));
    mock.module(${JSON.stringify(fileURLToPath(new URL("../../scripts/probe-fs-watch-churn.ts", import.meta.url)))}, () => ({
      probeFsWatchChurn: async () => ({
        usable: false,
        reason: "control 1/1; 0/1 churn writes; https://github.com/oven-sh/bun/issues/44385",
      }),
    }));
    const { fsWatchProbe } = await import(${JSON.stringify(fileURLToPath(new URL("./test-fs-watch.ts", import.meta.url)))});
    console.log(JSON.stringify(fsWatchProbe));
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString()).usable).toBe(false);
  expect(result.stderr.toString()).toContain("control 1/1; 0/1 churn writes");
  expect(result.stderr.toString()).toContain("https://github.com/oven-sh/bun/issues/44385");
});

test("native watch probe cleans up and rejects an interval write error", () => {
  // Module mocking stays in a child so other test files keep their real fs.
  const script = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    const { mkdtempSync, writeFileSync, existsSync } = fs;
    let dir;
    let writes = 0;
    let closed = false;
    mock.module("node:fs", () => ({
      ...fs,
      mkdtempSync: (...args) => { dir = mkdtempSync(...args); return dir; },
      watch: () => ({ close: () => { closed = true; } }),
      writeFileSync: (...args) => {
        if (++writes === 2) throw new Error("interval fixture write denied");
        writeFileSync(...args);
      },
    }));
    try {
      await import(${JSON.stringify(fileURLToPath(new URL("./test-fs-watch.ts", import.meta.url)))});
      throw new Error("probe unexpectedly succeeded");
    } catch (error) {
      console.log(JSON.stringify({ message: error.message, writes, closed, exists: existsSync(dir) }));
    }
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({
    message: "interval fixture write denied",
    writes: 2,
    closed: true,
    exists: false,
  });
});
