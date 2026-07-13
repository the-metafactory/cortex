/**
 * Tests for the principal-DM buffer in DiscordAdapter.
 *
 * Covers:
 *   - notifyPrincipal buffers when disconnected at check time
 *   - notifyPrincipal does NOT buffer permanently-undeliverable errors
 *     (DiscordAPIError 50007 "cannot DM this user", 4xx, etc.)
 *   - notifyPrincipal buffers transient errors that surface after a TOCTOU
 *     disconnect mid-call
 *   - bufferPrincipalDM evicts expired entries at write time (TTL parity
 *     with cleanExpiredPending for pendingResults)
 *   - bufferPrincipalDM caps at PENDING_PRINCIPAL_MAX (drops oldest)
 *   - drainPendingPrincipalDMs delivers fresh entries and drops expired ones
 *   - drainPendingPrincipalDMs surfaces a users.fetch failure without losing
 *     the buffer entries (they remain dropped — fetch failure is permanent
 *     enough that we don't replay; this matches existing behaviour)
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { DiscordAdapter, type DiscordAdapterInfra, type AdapterAgentIdentity } from "../index";
import type { DiscordPresence } from "../schema";
import type { ConnectionHealth } from "../client";
import { NO_POLICY_PORT, fallbackFormatEnvelope } from "../plugin";

let originalWarn: typeof console.warn;
let originalLog: typeof console.log;
let originalError: typeof console.error;

beforeEach(() => {
  originalWarn = console.warn;
  originalLog = console.log;
  originalError = console.error;
  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.warn = originalWarn;
  console.log = originalLog;
  console.error = originalError;
});

interface FakeUser {
  send: (text: string) => Promise<unknown>;
}
interface FakeUsers {
  fetch: (id: string) => Promise<FakeUser>;
}
interface FakeClient {
  users: FakeUsers;
}

function makeAdapter(opts: {
  fetchUser?: (id: string) => Promise<FakeUser>;
  connected?: boolean;
} = {}) {
  // MIG-7.2c-discord-flip: constructor now takes (agent, presence, infra).
  const presence: DiscordPresence = {
    enabled: true,
    token: "test-token",
    guildId: "g1",
    agentChannelId: "c1",
    logChannelId: "c2",
    contextDepth: 0,
    enableAgentLog: false,
    trustedBotIds: [],
    dmOwner: true,
    surfaceSubjects: [],
  };
  const agent: AdapterAgentIdentity = {
    id: "test",
    displayName: "Test",
    presence: { discord: presence },
  };
  const infra: DiscordAdapterInfra = {
    instanceId: "discord-test",
    principal: { discordId: "principal-123" },
    policy: NO_POLICY_PORT,
    formatEnvelope: fallbackFormatEnvelope,
  };
  const adapter = new DiscordAdapter(agent, presence, infra);

  const sends: string[] = [];
  const defaultUser: FakeUser = {
    send: async (text: string) => { sends.push(text); return { id: "m1" }; },
  };
  const client: FakeClient = {
    users: {
      fetch: opts.fetchUser ?? (async () => defaultUser),
    },
  };
  // Inject private state via cast — this matches how the discord-client tests
  // reach into the EventEmitter via (client as any).emit().
  (adapter as unknown as { client: FakeClient }).client = client;
  const health: ConnectionHealth = {
    reconnectCount: 0,
    lastConnectedAt: new Date(),
    lastDisconnectedAt: null,
    currentlyConnected: opts.connected ?? true,
    degraded: false,
    degradedSince: null,
  };
  (adapter as unknown as { connectionHealth: ConnectionHealth }).connectionHealth = health;

  return { adapter, sends, health, client };
}

function getBuffer(adapter: DiscordAdapter): { text: string; createdAt: number }[] {
  return (adapter as unknown as { pendingPrincipalDMs: { text: string; createdAt: number }[] }).pendingPrincipalDMs;
}
function setBuffer(adapter: DiscordAdapter, items: { text: string; createdAt: number }[]): void {
  (adapter as unknown as { pendingPrincipalDMs: { text: string; createdAt: number }[] }).pendingPrincipalDMs = items;
}
async function callDrain(adapter: DiscordAdapter): Promise<void> {
  await (adapter as unknown as { drainPendingPrincipalDMs: () => Promise<void> }).drainPendingPrincipalDMs();
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_PRINCIPAL_MAX = 50;

describe("notifyPrincipal + buffer write semantics", () => {
  test("buffers when connectionHealth is disconnected at check time", async () => {
    const { adapter, sends } = makeAdapter({ connected: false });
    await adapter.notifyPrincipal("hello");
    expect(sends).toEqual([]);
    expect(getBuffer(adapter).length).toBe(1);
    expect(getBuffer(adapter)[0]?.text).toBe("hello");
  });

  test("delivers immediately when connected", async () => {
    const { adapter, sends } = makeAdapter({ connected: true });
    await adapter.notifyPrincipal("hi");
    expect(sends).toEqual(["hi"]);
    expect(getBuffer(adapter).length).toBe(0);
  });

  test("does NOT buffer DiscordAPIError 50007 (cannot DM) — drops permanently", async () => {
    const fetchUser = async (): Promise<FakeUser> => ({
      send: async () => {
        // Shape mimicking discord.js DiscordAPIError: name with code, status 403
        const err = new Error("Cannot send messages to this user") as Error & {
          name: string;
          status: number;
          code: number;
        };
        err.name = "DiscordAPIError[50007]";
        err.status = 403;
        err.code = 50007;
        throw err;
      },
    });
    const { adapter, sends } = makeAdapter({ connected: true, fetchUser });
    await adapter.notifyPrincipal("you have a new task");
    expect(sends).toEqual([]);
    // Critical: nothing should have been buffered. Buffering this would leak
    // a forever-failing entry that crowds out genuine principal messages.
    expect(getBuffer(adapter).length).toBe(0);
  });

  test("does NOT buffer generic 4xx — drops permanently", async () => {
    const fetchUser = async (): Promise<FakeUser> => ({
      send: async () => {
        const err = new Error("Bad Request") as Error & { status: number };
        err.status = 400;
        throw err;
      },
    });
    const { adapter } = makeAdapter({ connected: true, fetchUser });
    await adapter.notifyPrincipal("oops");
    expect(getBuffer(adapter).length).toBe(0);
  });

  test("buffers transient 5xx surfaced after TOCTOU disconnect mid-call", async () => {
    // Simulate the race: connectionHealth is true at the start of the call,
    // but the underlying `users.fetch` throws a transient error, and by the
    // time the catch runs, connectionHealth has flipped to false.
    // Declared with `let` so the closure can capture-then-bind it after
    // `makeAdapter` returns the health object. ESLint's prefer-const sees
    // a single assignment; the definite-assignment guard is intentional.
    // eslint-disable-next-line prefer-const
    let healthRef!: ConnectionHealth;
    const fetchUser = async (): Promise<FakeUser> => {
      // Flip health right before the throw
      healthRef.currentlyConnected = false;
      const err = new Error("ECONNRESET") as Error & { code: string };
      err.code = "ECONNRESET";
      throw err;
    };
    const ctx = makeAdapter({ connected: true, fetchUser });
    healthRef = ctx.health;
    await ctx.adapter.notifyPrincipal("retry me later");
    expect(getBuffer(ctx.adapter).length).toBe(1);
    expect(getBuffer(ctx.adapter)[0]?.text).toBe("retry me later");
  });

  test("does NOT buffer transient errors when connection is still healthy (probable server fault)", async () => {
    // Health stays true the whole way through; throw a transient code anyway.
    const fetchUser = async (): Promise<FakeUser> => {
      const err = new Error("ETIMEDOUT") as Error & { code: string };
      err.code = "ETIMEDOUT";
      throw err;
    };
    const { adapter } = makeAdapter({ connected: true, fetchUser });
    await adapter.notifyPrincipal("flaky");
    // Connection is healthy — we log+drop rather than buffer, otherwise a
    // genuinely-flaky-but-online discord would fill the buffer indefinitely.
    expect(getBuffer(adapter).length).toBe(0);
  });
});

describe("buffer overflow + TTL eviction at write time", () => {
  test("buffer overflow: shifts oldest at PENDING_PRINCIPAL_MAX", async () => {
    const { adapter } = makeAdapter({ connected: false });
    for (let i = 0; i < PENDING_PRINCIPAL_MAX + 5; i++) {
      await adapter.notifyPrincipal(`msg-${i}`);
    }
    const buf = getBuffer(adapter);
    expect(buf.length).toBe(PENDING_PRINCIPAL_MAX);
    // Oldest dropped — first kept entry is msg-5.
    expect(buf[0]?.text).toBe("msg-5");
    expect(buf[buf.length - 1]?.text).toBe(`msg-${PENDING_PRINCIPAL_MAX + 4}`);
  });

  test("TTL: bufferPrincipalDM evicts expired entries at write time (TTL parity with pendingResults)", async () => {
    const { adapter } = makeAdapter({ connected: false });
    // Pre-populate with one expired and one fresh entry, then trigger a write.
    const now = Date.now();
    setBuffer(adapter, [
      { text: "stale", createdAt: now - PENDING_TTL_MS - 1_000 },
      { text: "fresh", createdAt: now - 5_000 },
    ]);
    await adapter.notifyPrincipal("new");
    const buf = getBuffer(adapter);
    expect(buf.map((e) => e.text)).toEqual(["fresh", "new"]);
  });
});

describe("drainPendingPrincipalDMs", () => {
  test("delivers fresh entries to the principal", async () => {
    const { adapter, sends } = makeAdapter({ connected: true });
    setBuffer(adapter, [
      { text: "first", createdAt: Date.now() - 1_000 },
      { text: "second", createdAt: Date.now() - 500 },
    ]);
    await callDrain(adapter);
    expect(sends).toEqual(["first", "second"]);
    expect(getBuffer(adapter).length).toBe(0);
  });

  test("drops expired entries on drain (cleanExpiredPrincipalDMs is reused)", async () => {
    const { adapter, sends } = makeAdapter({ connected: true });
    const now = Date.now();
    setBuffer(adapter, [
      { text: "stale", createdAt: now - PENDING_TTL_MS - 60_000 },
      { text: "fresh", createdAt: now - 100 },
    ]);
    await callDrain(adapter);
    // Only the fresh entry was sent.
    expect(sends).toEqual(["fresh"]);
    expect(getBuffer(adapter).length).toBe(0);
  });

  test("propagates users.fetch failure: drains nothing, surfaces the error via console", async () => {
    const errorMessages: string[] = [];
    console.error = (...args: unknown[]) => { errorMessages.push(args.join(" ")); };
    const fetchUser = async (): Promise<FakeUser> => {
      throw new Error("principal-fetch-failed");
    };
    const { adapter, sends } = makeAdapter({ connected: true, fetchUser });
    setBuffer(adapter, [{ text: "queued", createdAt: Date.now() }]);
    await callDrain(adapter);
    expect(sends).toEqual([]);
    // The failure must be reported via console.error so it shows up in logs.
    expect(errorMessages.some((m) => m.includes("principal-fetch-failed"))).toBe(true);
    // Buffer was already cleared at the start of drain (entries are taken into
    // a local list); fetch failure does not preserve them. Document the choice.
    expect(getBuffer(adapter).length).toBe(0);
  });

  test("per-message send failure: keeps draining remaining messages", async () => {
    const sends: string[] = [];
    const errorMessages: string[] = [];
    console.error = (...args: unknown[]) => { errorMessages.push(args.join(" ")); };
    let calls = 0;
    const fetchUser = async (): Promise<FakeUser> => ({
      send: async (text: string) => {
        calls++;
        if (calls === 2) throw new Error("transient-send-fail");
        sends.push(text);
        return { id: `m${calls}` };
      },
    });
    const { adapter } = makeAdapter({ connected: true, fetchUser });
    setBuffer(adapter, [
      { text: "a", createdAt: Date.now() },
      { text: "b", createdAt: Date.now() },
      { text: "c", createdAt: Date.now() },
    ]);
    await callDrain(adapter);
    expect(sends).toEqual(["a", "c"]);
    expect(errorMessages.some((m) => m.includes("transient-send-fail"))).toBe(true);
  });

  test("no client + non-empty buffer: clears buffer rather than spinning", async () => {
    const { adapter } = makeAdapter({ connected: true });
    setBuffer(adapter, [{ text: "lost", createdAt: Date.now() }]);
    // Strip the client.
    (adapter as unknown as { client: null }).client = null;
    await callDrain(adapter);
    expect(getBuffer(adapter).length).toBe(0);
  });
});
