// bun-test wrapper for scripts/__tests__/systemd-remove.sh so the systemd
// unit removal (marker-guarded delete, instance disable, daemon-reload —
// cortex#2093) is gated by CI's `bun test`, not just runnable by hand.
// Mirrors systemd-render.test.ts's pattern (spawn the shell suite, assert
// exit 0).
//
// The shell suite runs entirely in a scratch $HOME with mocked uname/
// systemctl — no live ~/.config/systemd/user or systemd session is touched,
// so this runs identically on the Linux CI runner and a macOS dev box.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SUITE = join(REPO_ROOT, "scripts", "__tests__", "systemd-remove.sh");

describe("systemd-remove shell suite (cortex#2093)", () => {
  test("marker-guarded delete/instance-disable-ordering/no-ops pass (exit 0)", () => {
    const res = spawnSync("bash", [SUITE], { cwd: REPO_ROOT, encoding: "utf8" });
    const out = `${res.stdout}${res.stderr}`;
    // Surface the shell suite's own trace when it fails so the failing case is
    // visible in the bun-test output.
    if (res.status !== 0) throw new Error(`shell suite failed (exit ${res.status}):\n${out}`);
    expect(res.status).toBe(0);
    expect(out).toContain("0 failed");
  });
});
