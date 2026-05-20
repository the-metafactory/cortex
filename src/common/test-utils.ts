// Shared test helpers — CI safety gates for tests that need real external
// binaries (e.g. the `claude` CLI) that aren't installed in the GitHub
// Actions runner image. Tests gate themselves with `testClaude(...)` so
// they still run locally where the binary exists, but don't fail CI.
//
// `Bun.which` is a global in the Bun runtime; no import needed.

import { test } from "bun:test";

function which(bin: string): boolean {
  return Bun.which(bin) !== null;
}

export const hasClaude: boolean = which("claude");

/**
 * Drop-in replacement for `test(...)` that auto-skips when the `claude`
 * binary is not on $PATH (i.e. GitHub Actions runners). Use this in any
 * test that ends up calling `Bun.spawn(["claude", ...])` directly or
 * transitively (e.g. via `CCSession.start()` / `AgentTeam.triggerSynthesis`).
 */
export const testClaude = test.skipIf(!hasClaude);
