// Shared test helpers — CI safety gates for tests that need real external
// binaries (e.g. the `claude` CLI) that aren't installed in the GitHub
// Actions runner image. Tests gate themselves with `test.skipIf(!hasClaude)`
// so they still run locally where the binary exists, but don't fail CI.
//
// `Bun.which` is a global in the Bun runtime; no import needed.

function which(bin: string): boolean {
  return Bun.which(bin) !== null;
}

export const hasClaude: boolean = which("claude");
