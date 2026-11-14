import { afterEach } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { checkTestHome, checkTestTmp } from "./lib/test-home";

for (const verdict of [checkTestHome(process.env, homedir()), checkTestTmp(process.env, tmpdir())]) {
  if (!verdict.ok) {
    console.error(verdict.reason);
    process.exit(2);
  }
}

// Bun keeps a non-zero process.exitCode when a test assigns undefined to restore it, so a CLI test that sets
// exitCode = 1 can make the whole run exit 1 with no failing test. Fail the test that leaks it instead.
afterEach(() => {
  const code = process.exitCode;
  if (code !== undefined && code !== 0) {
    process.exitCode = 0;
    throw new Error(`process.exitCode was left at ${String(code)}; restore it with \`process.exitCode = previous ?? 0\``);
  }
});
