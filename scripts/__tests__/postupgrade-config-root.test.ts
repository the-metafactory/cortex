// bun-test wrapper for scripts/__tests__/postupgrade-config-root.sh so the
// cortex#2044 postupgrade regressions (config-root state `logs/`, bin-bridge
// materializing ~/bin, unconditional signing-identity header) are gated by
// CI's `bun test`, not just runnable by hand. Mirrors the
// postinstall-state-bootstrap.test.ts pattern (spawn the shell suite, assert
// exit 0 + "0 failed").
//
// The shell suite runs entirely in a scratch $HOME with launchctl/systemctl
// mocked — no live ~/.config, ~/.local, ~/bin, or daemon is touched.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SUITE = join(REPO_ROOT, "scripts", "__tests__", "postupgrade-config-root.sh");

describe("postupgrade-config-root shell suite (cortex#2044)", () => {
  test("postupgrade scaffolds no config-root logs; bridge/header behave (exit 0)", () => {
    const res = spawnSync("bash", [SUITE], { cwd: REPO_ROOT, encoding: "utf8" });
    const out = `${res.stdout}${res.stderr}`;
    if (res.status !== 0) throw new Error(`shell suite failed (exit ${res.status}):\n${out}`);
    expect(res.status).toBe(0);
    expect(out).toContain("0 failed");
  });
});
