import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

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
