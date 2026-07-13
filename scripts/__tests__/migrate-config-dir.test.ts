// bun-test wrapper for scripts/__tests__/migrate-config-dir.sh so the XDG
// wave-4 (cortex#1869) config-dir move driver — the RESTART op (tree copy +
// merge policy + plist re-render + launchctl bootout/bootstrap, production stack
// spared) — is gated by CI's `bun test`, not just runnable by hand. Mirrors the
// plist-render-bin-cutover.test.ts pattern (spawn the shell suite, assert exit 0).
//
// The shell suite runs entirely in a scratch $HOME with a mocked launchctl — no
// live ~/.config, launchctl, or daemon is touched.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SUITE = join(REPO_ROOT, "scripts", "__tests__", "migrate-config-dir.sh");

describe("migrate-config-dir shell suite (cortex#1869 XDG wave 4)", () => {
  test("config-dir move: merge policy + re-render + skip-restart pass (exit 0)", () => {
    const res = spawnSync("bash", [SUITE], { cwd: REPO_ROOT, encoding: "utf8" });
    const out = `${res.stdout}${res.stderr}`;
    if (res.status !== 0) throw new Error(`shell suite failed (exit ${res.status}):\n${out}`);
    expect(res.status).toBe(0);
    expect(out).toContain("0 failed");
  });
});
