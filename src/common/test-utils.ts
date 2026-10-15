// Shared test helpers — CI safety gates for tests that need real external
// binaries (e.g. the `claude` CLI) that aren't installed in the GitHub
// Actions runner image. Tests gate themselves with `testClaude(...)` so
// they still run locally where the binary exists, but don't fail CI.
//
// `Bun.which` is a global in the Bun runtime; no import needed.

import { describe, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function which(bin: string): boolean {
  return Bun.which(bin) !== null;
}

export const hasClaude: boolean = which("claude");

/**
 * Drop-in replacement for `test(...)` that auto-skips when the `claude`
 * binary is not on $PATH (i.e. GitHub Actions runners). Use this in any
 * test that ends up calling `Bun.spawn(["claude", ...])` directly or
 * transitively (e.g. via `CCSession.start()` / `AgentTeam.triggerSynthesis`).
 *
 * Exception: `src/runner/__tests__/cc-plugin-dir-pin.integration.test.ts`
 * deliberately does NOT use this helper — it gates on the CLAUDE_BIN env var
 * instead, because issue #2151's verification contract requires it to skip
 * when CLAUDE_BIN is unset even on a machine that has `claude` on $PATH.
 */
export const testClaude = test.skipIf(!hasClaude);

/**
 * Whether `sandbox-exec` can apply a profile in this process, and why not.
 * The same `(allow default)` check the boot probe runs (`checkSandboxExec`
 * in `src/runner/session-sandbox.ts`), done synchronously so a test file
 * can gate a `describe` at collection time. Unusable off Darwin, and inside
 * an outer Seatbelt sandbox (e.g. a Codex worker's), where `sandbox_apply`
 * fails with `Operation not permitted`.
 */
export const sandboxExecProbe: { usable: boolean; reason: string } = probeSandboxExec();

function probeSandboxExec(): { usable: boolean; reason: string } {
  if (process.platform !== "darwin") {
    return { usable: false, reason: `sandbox-exec is macOS-only (platform=${process.platform})` };
  }
  if (!which("sandbox-exec")) return { usable: false, reason: "sandbox-exec not found on $PATH" };
  const proc = Bun.spawnSync(["sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true"], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (proc.exitCode === 0) return { usable: true, reason: "" };
  const stderr = proc.stderr.toString().trim();
  return {
    usable: false,
    reason: `sandbox-exec cannot apply a profile here (exit ${proc.exitCode}${stderr ? `: ${stderr}` : ""}) — nested Seatbelt sandbox?`,
  };
}

/**
 * `describe` for a block that spawns a real `sandbox-exec`: skipped, with
 * {@link sandboxExecProbe}'s reason on stderr, when the probe fails.
 */
export function describeWithSandboxExec(name: string, fn: () => void): void {
  if (!sandboxExecProbe.usable) {
    process.stderr.write(`[skip] "${name}": ${sandboxExecProbe.reason}\n`);
  }
  describe.skipIf(!sandboxExecProbe.usable)(name, fn);
}

let hermeticHome: string | undefined;

/**
 * A temp dir standing in for `$HOME` in tests that must not read the
 * machine's own (arc-installed plugin bundles and packs, sibling stack
 * configs). Created once per test process, empty apart from what callers
 * add. `os.homedir()` cannot be redirected once Bun has started, so a test
 * passes paths under this dir explicitly instead.
 */
export function hermeticHomeDir(): string {
  hermeticHome ??= mkdtempSync(join(tmpdir(), "cortex-test-home-"));
  return hermeticHome;
}

/**
 * `startCortex` options that resolve arc's package-repos dir (plugin bundles
 * and exec-brain packs) under {@link hermeticHomeDir} rather than the
 * machine's arc install. The dir is left absent, as on a machine that never
 * ran `arc install`: plugin discovery then returns no bundles without running
 * `arc list`. Spread first into a test's options so an explicit per-test
 * value still wins.
 */
export function hermeticBootPaths(): { pluginPkgRoot: string; brainPackBaseDir: string } {
  const repos = join(hermeticHomeDir(), ".local", "share", "metafactory", "arc", "repos");
  return { pluginPkgRoot: repos, brainPackBaseDir: repos };
}
