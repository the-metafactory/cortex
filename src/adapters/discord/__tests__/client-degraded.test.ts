import { test, expect, describe, afterEach, beforeEach, mock, spyOn } from "bun:test";
import { createDiscordClient, type DiscordClientOptions } from "../client";
import type { BotConfig } from "../../../common/types/config";

// Minimal config stub — createDiscordClient only reads agent.displayName + discord[].guildId
const stubConfig = {
  agent: { displayName: "Test" },
  discord: [{ guildId: "g1" }],
} as unknown as BotConfig;

let originalError: typeof console.error;
let originalLog: typeof console.log;
let originalWarn: typeof console.warn;

beforeEach(() => {
  originalError = console.error;
  originalLog = console.log;
  originalWarn = console.warn;
  console.error = () => {};
  console.log = () => {};
  console.warn = () => {};
});

afterEach(() => {
  console.error = originalError;
  console.log = originalLog;
  console.warn = originalWarn;
});

function setupClient(options: DiscordClientOptions = {}) {
  const onDegraded = mock();
  const onRecovered = mock();
  const result = createDiscordClient(stubConfig, {
    instanceId: "discord-test",
    degradedThresholdMs: 50,
    onDegraded,
    onRecovered,
    ...options,
  });
  return { ...result, onDegraded, onRecovered };
}

describe("createDiscordClient degraded timer", () => {
  test("stays not-degraded when shard reconnects before threshold", async () => {
    const { client, health, onDegraded } = setupClient({ degradedThresholdMs: 100 });
    (client as any).emit("shardDisconnect", { code: 1000 } as any, 0);
    expect(health.currentlyConnected).toBe(false);
    expect(health.degraded).toBe(false);
    // Reconnect before timer fires
    (client as any).emit("shardReady", 0);
    await new Promise((r) => setTimeout(r, 150));
    expect(health.degraded).toBe(false);
    expect(onDegraded).not.toHaveBeenCalled();
    client.removeAllListeners();
    client.destroy();
  });

  test("flips to degraded after threshold elapsed without reconnect", async () => {
    const { client, health, onDegraded } = setupClient({ degradedThresholdMs: 30 });
    (client as any).emit("shardDisconnect", { code: 1006 } as any, 0);
    await new Promise((r) => setTimeout(r, 60));
    expect(health.degraded).toBe(true);
    expect(health.degradedSince).toBeInstanceOf(Date);
    expect(onDegraded).toHaveBeenCalledTimes(1);
    const call = onDegraded.mock.calls[0]![0] as { instanceId: string; thresholdMs: number; since: Date };
    expect(call.instanceId).toBe("discord-test");
    expect(call.thresholdMs).toBe(30);
    client.removeAllListeners();
    client.destroy();
  });

  test("recovers cleanly: shardReady after degraded fires onRecovered, clears state", async () => {
    const { client, health, onDegraded, onRecovered } = setupClient({ degradedThresholdMs: 20 });
    (client as any).emit("shardDisconnect", { code: 1006 } as any, 0);
    await new Promise((r) => setTimeout(r, 40));
    expect(health.degraded).toBe(true);

    (client as any).emit("shardReady", 0);
    expect(health.degraded).toBe(false);
    expect(health.degradedSince).toBeNull();
    expect(health.currentlyConnected).toBe(true);
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    const call = onRecovered.mock.calls[0]![0] as { instanceId: string; degradedForMs: number };
    expect(call.instanceId).toBe("discord-test");
    expect(call.degradedForMs).toBeGreaterThanOrEqual(0);
    client.removeAllListeners();
    client.destroy();
  });

  test("rapid disconnect/reconnect cycles do not stack timers", async () => {
    const { client, health, onDegraded } = setupClient({ degradedThresholdMs: 30 });
    for (let i = 0; i < 5; i++) {
      (client as any).emit("shardDisconnect", { code: 1006 } as any, 0);
      (client as any).emit("shardReady", 0);
    }
    // Final disconnect — should fire exactly once after threshold
    (client as any).emit("shardDisconnect", { code: 1006 } as any, 0);
    await new Promise((r) => setTimeout(r, 60));
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(health.degraded).toBe(true);
    client.removeAllListeners();
    client.destroy();
  });

  test("log lines are tagged with instanceId so multi-adapter deployments are unambiguous", async () => {
    const lines: string[] = [];
    const log = console.log;
    const err = console.error;
    const warn = console.warn;
    console.log = (...args) => { lines.push(args.join(" ")); };
    console.error = (...args) => { lines.push(args.join(" ")); };
    console.warn = (...args) => { lines.push(args.join(" ")); };
    try {
      const { client, health } = setupClient({ degradedThresholdMs: 20 });
      (client as any).emit("shardDisconnect", { code: 1006 } as any, 0);
      await new Promise((r) => setTimeout(r, 40));
      (client as any).emit("shardReady", 0);
      // Every log line we emitted should carry the [discord-test] prefix
      const ours = lines.filter((l) => l.startsWith("grove-bot:"));
      expect(ours.length).toBeGreaterThan(0);
      for (const l of ours) {
        expect(l).toContain("[discord-test]");
      }
      expect(health.degraded).toBe(false);
      client.removeAllListeners();
      client.destroy();
    } finally {
      console.log = log;
      console.error = err;
      console.warn = warn;
    }
  });

  test("degradedSince is stamped at shardDisconnect time, not at threshold-fire time", async () => {
    const { client, health } = setupClient({ degradedThresholdMs: 50 });
    const before = Date.now();
    (client as any).emit("shardDisconnect", { code: 1006 } as any, 0);
    // Even though `degraded` is still false (threshold hasn't elapsed),
    // degradedSince must already point at the disconnect timestamp so a
    // later RECOVERED log measures total disconnect time, not just
    // time-since-threshold-crossed.
    expect(health.degraded).toBe(false);
    expect(health.degradedSince).toBeInstanceOf(Date);
    expect(health.degradedSince!.getTime()).toBeGreaterThanOrEqual(before);
    expect(health.degradedSince!.getTime()).toBeLessThanOrEqual(Date.now());
    // Reconnect inside threshold clears it.
    (client as any).emit("shardReady", 0);
    expect(health.degradedSince).toBeNull();
    client.removeAllListeners();
    client.destroy();
  });

  test("on RECOVERED, the routine 'shard ready' log is suppressed (no double-log)", async () => {
    const lines: string[] = [];
    const log = console.log;
    const err = console.error;
    const warn = console.warn;
    console.log = (...args) => { lines.push(args.join(" ")); };
    console.error = (...args) => { lines.push(args.join(" ")); };
    console.warn = (...args) => { lines.push(args.join(" ")); };
    try {
      const { client } = setupClient({ degradedThresholdMs: 20 });
      (client as any).emit("shardDisconnect", { code: 1006 } as any, 0);
      await new Promise((r) => setTimeout(r, 40));
      lines.length = 0; // discard pre-recovery noise
      (client as any).emit("shardReady", 0);
      const recovered = lines.filter((l) => l.includes("RECOVERED"));
      const routineReady = lines.filter((l) => /shard \d+ ready/.test(l));
      expect(recovered.length).toBe(1);
      // Routine "shard 0 ready" must NOT appear when we already emitted
      // RECOVERED; otherwise log analysis sees two "back online" markers.
      expect(routineReady.length).toBe(0);
      client.removeAllListeners();
      client.destroy();
    } finally {
      console.log = log;
      console.error = err;
      console.warn = warn;
    }
  });

  test("normal reconnect (under threshold) still logs 'shard ready'", async () => {
    const lines: string[] = [];
    const log = console.log;
    const err = console.error;
    const warn = console.warn;
    console.log = (...args) => { lines.push(args.join(" ")); };
    console.error = (...args) => { lines.push(args.join(" ")); };
    console.warn = (...args) => { lines.push(args.join(" ")); };
    try {
      const { client } = setupClient({ degradedThresholdMs: 200 });
      (client as any).emit("shardDisconnect", { code: 1006 } as any, 0);
      lines.length = 0;
      (client as any).emit("shardReady", 0);
      const routineReady = lines.filter((l) => /shard \d+ ready/.test(l));
      expect(routineReady.length).toBe(1);
      const recovered = lines.filter((l) => l.includes("RECOVERED"));
      expect(recovered.length).toBe(0);
      client.removeAllListeners();
      client.destroy();
    } finally {
      console.log = log;
      console.error = err;
      console.warn = warn;
    }
  });

  test("onDegraded callback throwing does not break event handling", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const { client, health } = createDiscordClient(stubConfig, {
      degradedThresholdMs: 20,
      onDegraded: () => { throw new Error("callback boom"); },
    });
    (client as any).emit("shardDisconnect", { code: 1006 } as any, 0);
    await new Promise((r) => setTimeout(r, 40));
    expect(health.degraded).toBe(true);
    // Subsequent shardReady still works
    (client as any).emit("shardReady", 0);
    expect(health.degraded).toBe(false);
    errSpy.mockRestore();
    client.removeAllListeners();
    client.destroy();
  });
});
