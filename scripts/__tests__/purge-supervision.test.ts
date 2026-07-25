// bun-test wrapper for scripts/__tests__/purge-supervision.sh so the
// `scripts.purge` supervisor sweep (systemd unit-glob disable, launchd
// LaunchAgents filename-glob bootout+remove — cortex#2338) is gated by
// `bun test`, not just runnable by hand. Mirrors systemd-remove.test.ts's
// pattern (spawn the shell suite, assert exit 0).
//
// The shell suite runs entirely in a scratch $HOME with mocked uname/
// systemctl/launchctl — no live ~/Library/LaunchAgents or
// ~/.config/systemd/user is touched, so this runs identically on the Linux
// CI runner and a macOS dev box.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SUITE = join(REPO_ROOT, "scripts", "__tests__", "purge-supervision.sh");

describe("purge-supervision shell suite (cortex#2338)", () => {
  test("systemd unit-glob disable + launchd filename-glob bootout/remove + platform no-ops pass (exit 0)", () => {
    const res = spawnSync("bash", [SUITE], { cwd: REPO_ROOT, encoding: "utf8" });
    const out = `${res.stdout}${res.stderr}`;
    // Surface the shell suite's own trace when it fails so the failing case is
    // visible in the bun-test output.
    if (res.status !== 0) throw new Error(`shell suite failed (exit ${res.status}):\n${out}`);
    expect(res.status).toBe(0);
    expect(out).toContain("0 failed");
  });
});
