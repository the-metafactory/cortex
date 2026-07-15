// bun-test wrapper for scripts/__tests__/postinstall-state-bootstrap.sh so the
// XDG wave-5 (cortex#2030) postinstall fresh-install state bootstrap is gated by
// CI's `bun test`, not just runnable by hand. Mirrors the migrate-config-dir.test.ts
// pattern (spawn the shell suite, assert exit 0 + "0 failed").
//
// The shell suite runs entirely in a scratch $HOME — no live ~/.config,
// ~/.local, ~/.claude, or daemon is touched.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SUITE = join(REPO_ROOT, "scripts", "__tests__", "postinstall-state-bootstrap.sh");

describe("postinstall-state-bootstrap shell suite (cortex#2030 XDG wave 5)", () => {
  test("fresh box bootstraps canonical state; upgrade box untouched (exit 0)", () => {
    const res = spawnSync("bash", [SUITE], { cwd: REPO_ROOT, encoding: "utf8" });
    const out = `${res.stdout}${res.stderr}`;
    if (res.status !== 0) throw new Error(`shell suite failed (exit ${res.status}):\n${out}`);
    expect(res.status).toBe(0);
    expect(out).toContain("0 failed");
  });
});
