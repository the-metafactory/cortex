import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";

import { startMissionControl, type MissionControlHandle } from "../embed";

/**
 * MC-I1.S1 (ADR-0005) — in-process Mission Control embed.
 *
 * Hermetic: every path (db, cursor, hooks.rawEventsDir) is under a per-test tmp
 * dir, and the server binds an OS-assigned port (port 0). No writes to
 * ~/.config or ~/.local.
 */
describe("startMissionControl (embed)", () => {
  let tmpDir: string;
  let handle: MissionControlHandle | null;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `mc-embed-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    handle = null;
  });

  afterEach(async () => {
    if (handle) await handle.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a minimal MC yaml that keeps the hook poller hermetic (tmp rawEventsDir). */
  function writeMcYaml(): string {
    const cfgPath = join(tmpDir, "mc.yaml");
    const rawEventsDir = join(tmpDir, "events", "raw");
    mkdirSync(rawEventsDir, { recursive: true });
    writeFileSync(cfgPath, `hooks:\n  rawEventsDir: ${rawEventsDir}\n`);
    return cfgPath;
  }

  it("boots, serves /health, and lands db + cursor beside each other", async () => {
    const dbPath = join(tmpDir, "data", "mission-control.db");
    handle = await startMissionControl({
      configPath: writeMcYaml(),
      dbPath,
      port: 0, // OS-assigned free port — hermetic, no fixed-port collisions
    });

    // Bun.serve resolves port 0 to an assigned port; the handle exposes the real one.
    expect(handle.port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");

    // db lands at the requested path; the cursor lands BESIDE it (so per-stack
    // DBs never share a hook cursor) — ADR-0005 §2.
    expect(existsSync(dbPath)).toBe(true);
    const cursorPath = join(dirname(dbPath), "mc-hook-cursor.json");
    // The DB dir is the cursor's dir.
    expect(dirname(cursorPath)).toBe(dirname(dbPath));

    // The handle exposes the live db handle (the cockpit loop consumes it).
    expect(handle.db).toBeDefined();
    expect(() => handle!.db.query("SELECT 1").get()).not.toThrow();
  });

  it("releases the port on stop()", async () => {
    handle = await startMissionControl({
      configPath: writeMcYaml(),
      dbPath: join(tmpDir, "data", "mission-control.db"),
      port: 0,
    });
    const port = handle.port;

    // Confirm it's live first.
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);

    await handle.stop();
    handle = null; // prevent afterEach double-stop

    // After stop, the port is released — a connection is refused.
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it("port 0 falls back to the MC yaml's port when not overridden", async () => {
    // The MC yaml's own port (here an OS-assigned 0) governs when opts.port is 0.
    const cfgPath = join(tmpDir, "mc.yaml");
    const rawEventsDir = join(tmpDir, "events", "raw");
    mkdirSync(rawEventsDir, { recursive: true });
    writeFileSync(cfgPath, `port: 0\nhooks:\n  rawEventsDir: ${rawEventsDir}\n`);

    handle = await startMissionControl({
      configPath: cfgPath,
      dbPath: join(tmpDir, "data", "mission-control.db"),
      // port omitted → falls back to the yaml's port
    });
    expect(handle.port).toBeGreaterThan(0);
    expect((await fetch(`http://127.0.0.1:${handle.port}/health`)).ok).toBe(true);
  });

  it("rejects on a busy port AND releases the db handle (no partial-boot leak)", async () => {
    // Occupy a port on loopback so startServer's bind fails (EADDRINUSE).
    const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("blocker") });
    const busyPort = blocker.port;
    try {
      const dbPath = join(tmpDir, "data", "mission-control.db");
      await expect(
        startMissionControl({ configPath: writeMcYaml(), dbPath, port: busyPort }),
      ).rejects.toThrow();
      handle = null; // startMissionControl rejected → nothing to stop in afterEach

      // The db opened during the failed boot must have been closed: the file
      // exists (initDatabase created it) but no handle is left on it — we can
      // reopen it and delete it cleanly.
      expect(existsSync(dbPath)).toBe(true);
      const reopened = new Database(dbPath, { readwrite: true });
      expect(() => reopened.query("PRAGMA user_version").get()).not.toThrow();
      reopened.close();
      expect(() => rmSync(dbPath, { force: true })).not.toThrow();
      expect(existsSync(dbPath)).toBe(false);

      // No listener was left behind on the busy port other than the blocker —
      // it's still the blocker answering, not a leaked MC server.
      const res = await fetch(`http://127.0.0.1:${busyPort}/`);
      expect(await res.text()).toBe("blocker");
    } finally {
      blocker.stop(true);
    }
  });
});
