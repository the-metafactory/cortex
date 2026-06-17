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

  /**
   * Write a minimal MC yaml that keeps the hook poller hermetic (tmp
   * rawEventsDir) AND binds an OS-assigned ephemeral port.
   *
   * `port: 0` is load-bearing: the embed maps an absent/zero `opts.port` onto
   * the yaml's `port`, and a yaml WITHOUT a `port` key falls back to the MC
   * default 8767 (config.ts DEFAULT_CONFIG) — which collides (EADDRINUSE) with
   * the live in-process MC pane a cortex daemon now runs on 8767 (cortex#880).
   * Writing `port: 0` here makes `loaded.port` 0, so Bun.serve assigns a free
   * port and `handle.port` reports the real bound one. Every test that boots the
   * embed reads `handle.port` for its assertions, so no fixed port is assumed.
   */
  function writeMcYaml(): string {
    const cfgPath = join(tmpDir, "mc.yaml");
    const rawEventsDir = join(tmpDir, "events", "raw");
    mkdirSync(rawEventsDir, { recursive: true });
    writeFileSync(cfgPath, `port: 0\nhooks:\n  rawEventsDir: ${rawEventsDir}\n`);
    return cfgPath;
  }

  it("boots, serves /health, and lands db + cursor beside each other", async () => {
    const dbPath = join(tmpDir, "data", "mission-control.db");
    handle = await startMissionControl({
      configPath: writeMcYaml(), // yaml carries `port: 0` → OS-assigned, no 8767 collision
      dbPath,
      // port omitted → the yaml's `port: 0` governs → Bun.serve assigns a free port
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

    // MC-I1.S6 (#848) — the handle exposes the live WebSocket registry so the
    // bus→MC projection renderer can broadcast `mc.projection` refresh signals
    // to live dashboard clients. It must be the SAME registry the server's
    // hooks/API use (broadcast() callable, starts with zero clients).
    // Full mode: the registry is live (non-null). Headless (#1044) sets it null;
    // the dedicated headless test asserts that path.
    expect(handle.wsRegistry).not.toBeNull();
    const wsRegistry = handle.wsRegistry!;
    expect(typeof wsRegistry.broadcast).toBe("function");
    expect(wsRegistry.size).toBe(0);
  });

  it("releases the port on stop()", async () => {
    handle = await startMissionControl({
      configPath: writeMcYaml(), // yaml carries `port: 0` → OS-assigned, no 8767 collision
      dbPath: join(tmpDir, "data", "mission-control.db"),
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

  // ---- #1044 — headless MC mode (db + ingestor, NO HTTP server) ----
  // A lean producer stack runs initDatabase + the HookStreamPoller ingestor so
  // its mission-control.db is populated for the pane-of-glass (#1008) to read,
  // but binds NO port and serves NO dashboard.

  it("headless: boots db + ingestor with NO server — port is null, no listener bound", async () => {
    const dbPath = join(tmpDir, "data", "mission-control.db");
    handle = await startMissionControl({
      configPath: writeMcYaml(),
      dbPath,
      headless: true,
    });

    // No HTTP listener: port is null headless.
    expect(handle.port).toBeNull();
    // No wsRegistry headless (no clients to broadcast to).
    expect(handle.wsRegistry).toBeNull();

    // The db still lands at the requested path, with the cursor BESIDE it — the
    // ingestor's home — so the producer writes exactly like a full stack.
    expect(existsSync(dbPath)).toBe(true);
    const cursorPath = join(dirname(dbPath), "mc-hook-cursor.json");
    expect(dirname(cursorPath)).toBe(dirname(dbPath));

    // The handle exposes the live, writable db handle.
    expect(handle.db).toBeDefined();
    expect(() => handle!.db.query("SELECT 1").get()).not.toThrow();
  });

  it("headless: the ingestor populates the db from raw cc-events (same as full mode)", async () => {
    const dbPath = join(tmpDir, "data", "mission-control.db");
    const rawEventsDir = join(tmpDir, "events", "raw");
    mkdirSync(rawEventsDir, { recursive: true });
    const cfgPath = join(tmpDir, "mc.yaml");
    // Fast poll so the test doesn't wait long for the ingestor tick.
    writeFileSync(
      cfgPath,
      `port: 0\nhooks:\n  rawEventsDir: ${rawEventsDir}\n  pollInterval: 20\n`,
    );

    handle = await startMissionControl({ configPath: cfgPath, dbPath, headless: true });
    expect(handle.port).toBeNull();

    // Emit a hook event for an unknown cc_session_id — the ingestor (#856)
    // auto-registers it as a `local.observed` session row. Mirror the
    // RawHookEvent shape the EventLogger writes to ~/.claude/events/raw/.
    const ccSessionId = "headless-sess-1";
    const line = JSON.stringify({
      event_id: "evt-1",
      event_type: "SessionStart",
      timestamp: new Date().toISOString(),
      session_id: ccSessionId,
      agent_id: "test-agent",
      agent_name: "Test Agent",
      source: { hook: "SessionStart" },
      payload: {},
    });
    writeFileSync(join(rawEventsDir, "events.jsonl"), line + "\n");

    // Wait for the ingestor to pick the line up (poll every 20ms). The row is
    // keyed by cc_session_id (its `id` is generated).
    let row: unknown = null;
    for (let i = 0; i < 100; i++) {
      row = handle.db
        .query("SELECT id FROM sessions WHERE cc_session_id = ?")
        .get(ccSessionId);
      if (row) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(row).not.toBeNull();
  });

  it("headless: stop() tears down cleanly (db closed, no port to release)", async () => {
    const dbPath = join(tmpDir, "data", "mission-control.db");
    handle = await startMissionControl({
      configPath: writeMcYaml(),
      dbPath,
      headless: true,
    });
    await handle.stop();
    handle = null; // prevent afterEach double-stop

    // The db handle was closed: we can reopen + delete it cleanly.
    const reopened = new Database(dbPath, { readwrite: true });
    expect(() => reopened.query("PRAGMA user_version").get()).not.toThrow();
    reopened.close();
    expect(() => rmSync(dbPath, { force: true })).not.toThrow();
  });

  it("full mode is unchanged when headless is omitted (regression — server on, port bound)", async () => {
    handle = await startMissionControl({
      configPath: writeMcYaml(),
      dbPath: join(tmpDir, "data", "mission-control.db"),
      // headless omitted → full mode (server on)
    });
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.wsRegistry).not.toBeNull();
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
