import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Spec NFR contract (F-1 spec.md):
 *   - On db path unwritable: exit with clear error, non-zero exit code
 *   - On port already in use: exit with clear error naming the port
 *   - On config malformed: exit with clear error including parse error
 *
 * Library-level tests in config/server/db-init verify the throws + clarity.
 * These integration tests verify the entry point catches them and exits 1
 * with a `[mission-control] FATAL: ...` message — no raw stack to principal.
 */

const ENTRY = new URL("../index.ts", import.meta.url).pathname;

async function spawnBoot(
  env: Record<string, string>,
  timeoutMs = 8000
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", ENTRY],
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

describe("mission-control entry point — boot failure modes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `mc-entry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits 1 with FATAL message when YAML config is malformed", async () => {
    const cfgPath = join(tmpDir, "mc.yaml");
    writeFileSync(cfgPath, "port: [\ninvalid yaml\n");

    const { exitCode, stderr } = await spawnBoot({ MC_CONFIG_PATH: cfgPath });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("[mission-control] FATAL:");
    expect(stderr).toContain("Malformed YAML");
    expect(stderr).toContain("mc.yaml");
  });

  it("exits 1 with FATAL message when db path's parent is unwritable", async () => {
    const blocker = join(tmpDir, "not-a-dir");
    writeFileSync(blocker, "");
    const dbPath = join(blocker, "db.sqlite");

    const cfgPath = join(tmpDir, "mc.yaml");
    writeFileSync(
      cfgPath,
      `port: 0\ndb:\n  path: ${dbPath}\nhooks:\n  rawEventsDir: ${tmpDir}/raw\n  cursorPath: ${tmpDir}/cursor.json\n`
    );

    const { exitCode, stderr } = await spawnBoot({ MC_CONFIG_PATH: cfgPath });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("[mission-control] FATAL:");
    expect(stderr).toContain(blocker);
  });

  it("exits 1 with FATAL message when port is already in use", async () => {
    // Hold a port on 127.0.0.1 — the spawned boot (which defaults to hostname
    // 127.0.0.1) must fail to bind the same address+port.
    const blocker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("blocker"),
    });
    const port = blocker.port;

    try {
      const dbPath = join(tmpDir, "ok.db");
      const cfgPath = join(tmpDir, "mc.yaml");
      writeFileSync(
        cfgPath,
        `port: ${port}\ndb:\n  path: ${dbPath}\nhooks:\n  rawEventsDir: ${tmpDir}/raw\n  cursorPath: ${tmpDir}/cursor.json\n`
      );

      const { exitCode, stderr } = await spawnBoot({ MC_CONFIG_PATH: cfgPath });

      expect(exitCode).toBe(1);
      expect(stderr).toContain("[mission-control] FATAL:");
      expect(stderr).toContain(String(port));
    } finally {
      blocker.stop(true);
    }
  });
});
