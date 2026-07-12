// bun-test wrapper for scripts/__tests__/plist-render-bin-cutover.sh so the
// bin-cutover T13 safety mechanisms (forward_link_legacy_bin + reload_plist)
// are gated by CI's `bun test`, not just runnable by hand. Mirrors the
// check-carveouts.test.ts pattern (spawn the shell suite, assert exit 0).
//
// The shell suite runs entirely in a scratch $HOME with a mocked launchctl —
// no live ~/bin, ~/.local/bin, or launchctl is touched.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SUITE = join(REPO_ROOT, "scripts", "__tests__", "plist-render-bin-cutover.sh");

describe("plist-render bin-cutover shell suite (cortex#1866 T13)", () => {
  test("forward_link_legacy_bin + reload_plist pass (exit 0)", () => {
    const res = spawnSync("bash", [SUITE], { cwd: REPO_ROOT, encoding: "utf8" });
    const out = `${res.stdout}${res.stderr}`;
    // Surface the shell suite's own trace when it fails so the failing case is
    // visible in the bun-test output.
    if (res.status !== 0) throw new Error(`shell suite failed (exit ${res.status}):\n${out}`);
    expect(res.status).toBe(0);
    expect(out).toContain("0 failed");
  });
});
