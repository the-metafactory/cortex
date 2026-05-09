import { describe, it, expect, afterEach } from "bun:test";
import { ProcessManager } from "../session/process-manager";
import type { ManagedProcess } from "../session/types";

function spawnCat(overrides?: Partial<ManagedProcess>): ManagedProcess {
  const proc = Bun.spawn(["cat"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    proc,
    sessionId: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    assignmentId: "ata-1",
    spawnedAt: Date.now(),
    closing: false,
    ...overrides,
  };
}

/**
 * Spawn a shell that ignores SIGTERM. Used to verify SIGKILL escalation
 * in closeAll. `trap '' TERM` disables SIGTERM; only SIGKILL ends it.
 */
function spawnSigtermIgnorer(): ManagedProcess {
  const proc = Bun.spawn(
    ["sh", "-c", "trap '' TERM; while true; do sleep 10; done"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  return {
    proc,
    sessionId: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    assignmentId: "ata-ign",
    spawnedAt: Date.now(),
    closing: false,
  };
}

describe("ProcessManager", () => {
  const pm = new ProcessManager();
  const toCleanup: ManagedProcess[] = [];

  afterEach(async () => {
    // kill any leftover processes
    for (const m of toCleanup) {
      try { m.proc.kill("SIGKILL"); } catch (_e) { /* already dead */ }
    }
    toCleanup.length = 0;
    await pm.closeAll();
  });

  it("starts empty", () => {
    expect(pm.size).toBe(0);
  });

  it("add + get returns the managed process", () => {
    const m = spawnCat();
    toCleanup.push(m);

    pm.add(m);
    expect(pm.size).toBe(1);

    const got = pm.get(m.sessionId);
    expect(got).toBeDefined();
    expect(got!.assignmentId).toBe("ata-1");
    expect(got!.proc.pid).toBeTruthy();
    expect(got!.closing).toBe(false);
  });

  it("has returns true for existing, false for missing", () => {
    const m = spawnCat();
    toCleanup.push(m);
    pm.add(m);

    expect(pm.has(m.sessionId)).toBe(true);
    expect(pm.has("nonexistent")).toBe(false);
  });

  it("remove returns and deletes the process", () => {
    const m = spawnCat();
    toCleanup.push(m);
    pm.add(m);

    const removed = pm.remove(m.sessionId);
    expect(removed).toBeDefined();
    expect(removed!.sessionId).toBe(m.sessionId);
    expect(pm.size).toBe(0);
    expect(pm.get(m.sessionId)).toBeUndefined();
  });

  it("remove returns undefined for nonexistent", () => {
    expect(pm.remove("nonexistent")).toBeUndefined();
  });

  describe("closeAll", () => {
    it("kills all processes and clears the map", async () => {
      const m1 = spawnCat();
      const m2 = spawnCat();
      pm.add(m1);
      pm.add(m2);

      expect(pm.size).toBe(2);

      const killed = await pm.closeAll();
      expect(killed).toBe(2);
      expect(pm.size).toBe(0);
      // Bun sets signalCode (not exitCode) when the process is killed by signal.
      // Either being non-null proves the process exited.
      expect(m1.proc.exitCode ?? m1.proc.signalCode).not.toBeNull();
      expect(m2.proc.exitCode ?? m2.proc.signalCode).not.toBeNull();
    });

    it("handles already-exited processes gracefully", async () => {
      const m = spawnCat();
      pm.add(m);

      // kill it before closeAll
      m.proc.kill();
      await m.proc.exited;

      const killed = await pm.closeAll();
      expect(killed).toBe(1);
      expect(pm.size).toBe(0);
    });

    it("returns 0 when no processes are managed", async () => {
      const killed = await pm.closeAll();
      expect(killed).toBe(0);
    });

    it("awaits process exit before returning (no orphans left running)", async () => {
      const m = spawnCat();
      pm.add(m);

      await pm.closeAll();

      // Process MUST have exited by the time closeAll resolves — not merely
      // signalled. Previously closeAll returned before exit was confirmed.
      expect(m.proc.exitCode ?? m.proc.signalCode).not.toBeNull();
    });

    it("escalates to SIGKILL when SIGTERM is ignored", async () => {
      const m = spawnSigtermIgnorer();
      pm.add(m);

      // Short timeout — we don't want to wait 5s in CI. 300ms is enough for
      // SIGTERM to be seen and ignored; SIGKILL then takes the process down.
      const killed = await pm.closeAll({ gracefulTimeoutMs: 300 });

      expect(killed).toBe(1);
      expect(pm.size).toBe(0);
      expect(m.proc.exitCode ?? m.proc.signalCode).not.toBeNull();
    });

    it("sets closing=true on all managed processes before killing", async () => {
      const m1 = spawnCat();
      const m2 = spawnCat();
      pm.add(m1);
      pm.add(m2);

      // Race: start closeAll, then observe that closing was flipped.
      const closePromise = pm.closeAll();
      expect(m1.closing).toBe(true);
      expect(m2.closing).toBe(true);

      await closePromise;
    });

    it("invokes onCleanup for each managed process exactly once", async () => {
      const calls: string[] = [];
      const m1 = spawnCat({ onCleanup: () => { calls.push("m1"); } });
      const m2 = spawnCat({ onCleanup: () => { calls.push("m2"); } });
      pm.add(m1);
      pm.add(m2);

      await pm.closeAll();

      expect(calls.sort()).toEqual(["m1", "m2"]);
    });

    it("continues cleanup even if one onCleanup throws", async () => {
      const calls: string[] = [];
      const m1 = spawnCat({
        onCleanup: () => { throw new Error("boom"); },
      });
      const m2 = spawnCat({
        onCleanup: () => { calls.push("m2"); },
      });
      pm.add(m1);
      pm.add(m2);

      const killed = await pm.closeAll();

      expect(killed).toBe(2);
      expect(calls).toEqual(["m2"]); // m2 still ran after m1 threw
      expect(pm.size).toBe(0);
    });
  });
});
