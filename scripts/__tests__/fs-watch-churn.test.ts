import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

function measure(mode: "delivered" | "lost" | "close-lost" | "late" | "io-error") {
  const source = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    import { basename } from "node:path";
    const { writeFileSync, mkdtempSync, existsSync } = fs;
    const active = new Map();
    let root;
    let target;
    let disturbed = false;
    mock.module("node:fs", () => ({
      ...fs,
      mkdtempSync: (...args) => { root = mkdtempSync(...args); return root; },
      watch: (dir, _options, listener) => {
        active.set(dir, listener);
        if (basename(dir) === "target") target = dir;
        if (basename(dir) === "other") disturbed = ${JSON.stringify(mode)} !== "close-lost";
        return { close() {
          active.delete(dir);
          if (basename(dir) === "other") disturbed = true;
        } };
      },
      writeFileSync: (path, data) => {
        if (${JSON.stringify(mode)} === "io-error" && disturbed) throw new Error("fixture write denied");
        writeFileSync(path, data);
        if (["lost", "close-lost"].includes(${JSON.stringify(mode)}) && disturbed) return;
        const listener = active.get(target);
        const delay = ${JSON.stringify(mode)} === "late" && disturbed ? 40 : 0;
        setTimeout(() => listener("rename", basename(path)), delay);
      },
    }));
    const { probeFsWatchChurn } = await import(${JSON.stringify(fileURLToPath(new URL("../probe-fs-watch-churn.ts", import.meta.url)))});
    let result;
    try {
      result = await probeFsWatchChurn({ watcherCount: 2, trials: 2, settleMs: 0, timeoutMs: 20, graceMs: 80 });
    } catch (error) {
      result = { error: error.message };
    }
    console.log(JSON.stringify({ result, active: active.size, exists: existsSync(root) }));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", source], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  expect({ code: child.exitCode, stderr: child.stderr.toString() }).toEqual({ code: 0, stderr: "" });
  const measured = JSON.parse(child.stdout.toString());
  expect(measured.active).toBe(0);
  expect(measured.exists).toBe(false);
  return measured.result;
}

test("churn probe keeps coverage when unrelated watcher changes preserve delivery", () => {
  const result = measure("delivered");
  expect(result.usable).toBe(true);
  expect(result.reason).toContain("control 1/1; 2/2 writes delivered");
});

test("churn probe reports measured loss and the upstream issue", () => {
  const result = measure("lost");
  expect(result.usable).toBe(false);
  expect(result.reason).toContain("control 1/1; 0/1 writes delivered");
  expect(result.reason).toContain("open-0 missing after 20ms + 80ms grace");
  expect(result.reason).toContain("https://github.com/oven-sh/bun/issues/44385");
});

test("churn probe distinguishes late events from lost events", () => {
  const result = measure("late");
  expect(result.usable).toBe(true);
  expect(result.reason).toContain("(2 late)");
});

test("churn probe detects loss caused by closing an unrelated watcher", () => {
  const result = measure("close-lost");
  expect(result.usable).toBe(false);
  expect(result.reason).toContain("control 1/1; 1/2 writes delivered");
  expect(result.reason).toContain("close-1 missing");
});

test("churn probe propagates filesystem failures and releases every watcher", () => {
  expect(measure("io-error")).toEqual({ error: "fixture write denied" });
});
