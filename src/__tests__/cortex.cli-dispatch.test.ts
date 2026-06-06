/**
 * #752 — commander passthrough dispatcher routing.
 *
 * `cortex.ts` is the commander CLI. Before #752 it registered only
 * `start`/`stop`/`status`, so `cortex network …` / `cortex provision-stack …`
 * errored "unknown command". #752 registers both as PASSTHROUGH subcommands
 * that hand the raw remaining argv to the module dispatchers
 * (`dispatchNetwork` / `dispatchProvisionStack`) WITHOUT commander interpreting
 * the flags.
 *
 * These tests spawn the real entrypoint (`bun src/cortex.ts …`) so the
 * `import.meta.main` commander block actually runs — the only faithful way to
 * exercise the passthrough wiring + `process.exit(code)` contract. We assert:
 *   - `network` / `provision-stack` route to the right dispatcher (help banner).
 *   - The dispatcher's own arg parsing handles flags (no commander interception).
 *   - An unknown SUBCOMMAND surfaces the dispatcher's usage error, exit 2.
 *   - `start`/`stop`/`status` still parse (status against a fresh config is
 *     inert — no daemon boot).
 *   - NEITHER passthrough boots the daemon (no "cortex: starting…" banner).
 */

import { describe, test, expect } from "bun:test";
import { join } from "path";

// import.meta.dir = …/src/__tests__ ; the entrypoint is …/src/cortex.ts
const ENTRY = join(import.meta.dir, "..", "cortex.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCortex(args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // Clean env: no CORTEX_*/GROVE_* instrumentation leaking from the runner.
    env: { ...process.env, CORTEX_GATEWAY: "" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("#752 — network passthrough", () => {
  test("`cortex network --help` routes to the network dispatcher", async () => {
    const r = await runCortex(["network", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("cortex network");
    expect(r.stdout).toContain("join");
    expect(r.stdout).toContain("leave");
    expect(r.stdout).toContain("status");
    // Must NOT have booted the daemon.
    expect(r.stdout + r.stderr).not.toContain("cortex: starting");
  });

  test("`cortex network frobnicate` surfaces the dispatcher's unknown-subcommand error (exit 2)", async () => {
    const r = await runCortex(["network", "frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown subcommand "frobnicate"');
  });

  test("`cortex network status --principal …` is handled by the dispatcher (no commander flag interception)", async () => {
    // status with a unique slug → no networks joined, exit 0. Proves the
    // `--principal` / `--stack` flags reach the dispatcher untouched.
    const r = await runCortex([
      "network",
      "status",
      "--principal",
      "andreas",
      "--stack",
      `andreas/dispatch${Date.now().toString()}`,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no networks joined");
    expect(r.stdout + r.stderr).not.toContain("cortex: starting");
  });
});

describe("#752 — provision-stack passthrough", () => {
  test("`cortex provision-stack --help` routes to the provision-stack dispatcher", async () => {
    const r = await runCortex(["provision-stack", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("cortex provision-stack");
    expect(r.stdout).toContain("generate");
    expect(r.stdout).toContain("register");
    expect(r.stdout + r.stderr).not.toContain("cortex: starting");
  });

  test("`cortex provision-stack claim BADCAPS` reaches the dispatcher's principal-id grammar (exit 2)", async () => {
    const r = await runCortex(["provision-stack", "claim", "BAD_CAPS", "--seed-path", "/tmp/x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("principal-id");
  });
});

describe("#752 — start/stop/status unaffected", () => {
  test("`cortex status` against a fresh config is inert (no daemon boot)", async () => {
    // Point at a config path that doesn't exist → `cortex: not running`.
    const r = await runCortex(["status", "--config", `/tmp/nonexistent-${Date.now().toString()}.yaml`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("not running");
    expect(r.stdout + r.stderr).not.toContain("cortex: starting");
  });

  test("`cortex --help` lists network + provision-stack alongside start/stop/status", async () => {
    const r = await runCortex(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("start");
    expect(r.stdout).toContain("stop");
    expect(r.stdout).toContain("status");
    expect(r.stdout).toContain("network");
    expect(r.stdout).toContain("provision-stack");
  });
});
