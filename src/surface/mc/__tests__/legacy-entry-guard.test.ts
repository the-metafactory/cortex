import { describe, it, expect } from "bun:test";
import { legacyBootAllowed, RETIRED_POINTER } from "../index";

/**
 * FS-8a (#1822): the legacy standalone Grove MC v2 entry is retired for
 * production. Run as a plain production entrypoint it MUST print a pointer to
 * the in-process MC and exit non-zero — never squat :8767 with a dead server.
 * The integration-test harness keeps working via the `--legacy` / MC_LEGACY_BOOT
 * escape hatch.
 *
 * These tests spawn the entry as a real subprocess (the production-shaped
 * invocation) to assert the guard at the boundary the principal actually hits.
 */

const ENTRY = new URL("../index.ts", import.meta.url).pathname;

/**
 * A config path that EXISTS but cannot be read as a file — this test directory
 * itself. `loadConfig` does `existsSync(path)` (true for a dir) then
 * `readFileSync(path)`, which throws `EISDIR`; loadConfig rethrows and
 * `bootLegacy` maps it to the `[mission-control] FATAL: <msg>` + exit-1 NFR
 * contract. A *nonexistent* path would instead fall through to DEFAULT_CONFIG
 * and boot a real long-lived server on :8767 — hanging the test until timeout.
 * We want the boot path REACHED and then failed fast, not a live server.
 */
const UNREADABLE_CONFIG_DIR = new URL(".", import.meta.url).pathname;

async function spawnEntry(
  argv: string[],
  env: Record<string, string>,
  timeoutMs = 8000
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", ENTRY, ...argv],
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const stderr = await new Response(proc.stderr).text();
  return { exitCode: exitCode ?? -1, stderr };
}

describe("mission-control legacy entry — production-entrypoint guard (FS-8a)", () => {
  it("prints the retirement pointer and exits non-zero when run as a prod entry", async () => {
    // No escape hatch: neither --legacy nor MC_LEGACY_BOOT. Strip any inherited
    // MC_LEGACY_BOOT so the parent env can't accidentally satisfy the hatch.
    const { exitCode, stderr } = await spawnEntry([], { MC_LEGACY_BOOT: "" });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("retired for production");
    expect(stderr).toContain("mc.enabled: true");
    expect(stderr).toContain("agent-presence registry");
    // It must NOT have tried to boot the dead server.
    expect(stderr).not.toContain("listening on http://localhost");
  });

  it("does NOT boot a server on the prod-entry path (no :8767 squat)", async () => {
    const { exitCode, stderr } = await spawnEntry([], { MC_LEGACY_BOOT: "0" });

    expect(exitCode).not.toBe(0);
    expect(stderr).not.toContain("listening on http://localhost");
    expect(stderr).not.toContain("hook poller");
  });

  it("attempts the legacy boot under the --legacy escape hatch (test-harness path unaffected)", async () => {
    // With the hatch present, the guard hands off to the real boot. We point it
    // at an unreadable config (a directory), so it hits the NFR failure contract
    // (FATAL + exit 1) rather than the retirement pointer — proving the boot
    // path was reached, not the guard's refusal, and without standing up a
    // real long-lived server on :8767.
    const { exitCode, stderr } = await spawnEntry(["--legacy"], {
      MC_CONFIG_PATH: UNREADABLE_CONFIG_DIR,
    });

    expect(stderr).not.toContain("retired for production");
    expect(stderr).toContain("[mission-control] FATAL:");
    expect(exitCode).toBe(1);
  });

  it("attempts the legacy boot under the MC_LEGACY_BOOT env escape hatch", async () => {
    const { exitCode, stderr } = await spawnEntry([], {
      MC_LEGACY_BOOT: "1",
      MC_CONFIG_PATH: UNREADABLE_CONFIG_DIR,
    });

    expect(stderr).not.toContain("retired for production");
    expect(stderr).toContain("[mission-control] FATAL:");
    expect(exitCode).toBe(1);
  });
});

describe("legacyBootAllowed — escape-hatch predicate (unit)", () => {
  it("is true for the --legacy flag", () => {
    expect(legacyBootAllowed(["--legacy"], {})).toBe(true);
  });

  it("is true for a truthy MC_LEGACY_BOOT", () => {
    expect(legacyBootAllowed([], { MC_LEGACY_BOOT: "1" })).toBe(true);
    expect(legacyBootAllowed([], { MC_LEGACY_BOOT: "true" })).toBe(true);
  });

  it("is false with no escape hatch and for falsy env sentinels", () => {
    expect(legacyBootAllowed([], {})).toBe(false);
    expect(legacyBootAllowed([], { MC_LEGACY_BOOT: "" })).toBe(false);
    expect(legacyBootAllowed([], { MC_LEGACY_BOOT: "0" })).toBe(false);
    expect(legacyBootAllowed([], { MC_LEGACY_BOOT: "false" })).toBe(false);
  });

  it("exposes a pointer that names the in-process replacement", () => {
    expect(RETIRED_POINTER).toContain("mc.enabled: true");
    expect(RETIRED_POINTER).toContain("agent-presence registry");
  });
});
