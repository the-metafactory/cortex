/**
 * cortex#708 — Discord progress message ("Luna is working…") must be scoped
 * per SESSION, not per channel/thread.
 *
 * Background:
 *   `sendProgress`/`clearProgress` keyed the progress-message registry on
 *   `target.threadId ?? target.channelId` (channel-scoped). When a second
 *   session starts in the same DM/channel while a first is still running, both
 *   resolve to one key — the second session finds the first's placeholder and
 *   EDITS it in place rather than posting its own. Concurrent work then looks
 *   simultaneous (one message, one timestamp).
 *
 * cortex#708 fix:
 *   `ResponseTarget` carries an optional `sessionId` (the inbound correlation
 *   id threaded by `dispatch-handler.targetFromMsg`). The adapter keys the
 *   registry on `${threadId ?? channelId}:${sessionId}` so each session owns
 *   its own placeholder. `clearProgress` then deletes only the finishing
 *   session's message. When `sessionId` is absent the key falls back to
 *   channel-scope (pre-#708 behaviour, used by the envelope render path).
 *
 * This suite drives the adapter directly through `sendProgress`/`clearProgress`
 * with `ResponseTarget`s carrying fake discord.js channels via `_native`
 * (duck-typed `.send`), so no real gateway is touched. We observe sends/edits/
 * deletes by counting calls on the fakes.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { DiscordAdapter, type DiscordAdapterInfra, type AdapterAgentIdentity } from "../index";
import type { DiscordPresence } from "../schema";
import type { ResponseTarget } from "../../../surface-sdk";
import { NO_POLICY_PORT, fallbackFormatEnvelope } from "../plugin";

// ---------------------------------------------------------------------------
// Console suppression — adapter logs at construction; noise.
// ---------------------------------------------------------------------------

let originalWarn: typeof console.warn;
let originalError: typeof console.error;
let originalLog: typeof console.log;

beforeEach(() => {
  originalWarn = console.warn;
  originalError = console.error;
  originalLog = console.log;
  console.warn = () => {};
  console.error = () => {};
  console.log = () => {};
});

afterEach(() => {
  console.warn = originalWarn;
  console.error = originalError;
  console.log = originalLog;
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A fake discord.js Message returned by `channel.send`. Tracks edits + deletes. */
class FakeMessage {
  public content: string;
  public edits: string[] = [];
  public deleted = false;
  constructor(content: string) {
    this.content = content;
  }
  async edit(next: string): Promise<void> {
    this.content = next;
    this.edits.push(next);
  }
  async delete(): Promise<void> {
    this.deleted = true;
  }
}

/**
 * A fake discord.js channel. Duck-typed `.send` so `resolveChannel` uses it
 * via `target._native` without a real client. Each `send` produces a fresh
 * FakeMessage we can inspect.
 */
class FakeChannel {
  public sent: FakeMessage[] = [];
  async send(content: string): Promise<FakeMessage> {
    const msg = new FakeMessage(content);
    this.sent.push(msg);
    return msg;
  }
}

function makeAdapter(): DiscordAdapter {
  const presence: DiscordPresence = {
    enabled: true,
    token: "shared-bot-token",
    guildId: "guild-1",
    agentChannelId: "c1",
    logChannelId: "c2",
    contextDepth: 0,
    enableAgentLog: false,
    trustedBotIds: [],
    dmOwner: true,
    surfaceSubjects: [],
  };
  const agent: AdapterAgentIdentity = {
    id: "test-agent",
    displayName: "TestAgent",
    presence: { discord: presence },
  };
  const infra: DiscordAdapterInfra = {
    instanceId: "discord-test",
    principal: {},
    policy: NO_POLICY_PORT,
    formatEnvelope: fallbackFormatEnvelope,
  };
  return new DiscordAdapter(agent, presence, infra);
}

/** A target in the SAME channel (no thread — the DM/channel-collision case). */
function targetFor(channel: FakeChannel, sessionId: string): ResponseTarget {
  return {
    instanceId: "discord-test",
    channelId: "shared-channel",
    sessionId,
    _native: channel,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiscordAdapter: per-session progress (cortex#708)", () => {
  test("two concurrent sessions in the same channel each post their OWN working message", async () => {
    const adapter = makeAdapter();
    const channel = new FakeChannel();

    const a = targetFor(channel, "session-A");
    const b = targetFor(channel, "session-B");

    await adapter.sendProgress(a, "A: reading files");
    await adapter.sendProgress(b, "B: running tests");

    // Two distinct sends — one per session — NOT one send + one edit.
    expect(channel.sent.length).toBe(2);
    expect(channel.sent[0]?.content).toBe("> A: reading files");
    expect(channel.sent[1]?.content).toBe("> B: running tests");
    // Neither placeholder was edited by the other session.
    expect(channel.sent[0]?.edits.length).toBe(0);
    expect(channel.sent[1]?.edits.length).toBe(0);
  });

  test("a session's subsequent progress edits its OWN message in place", async () => {
    const adapter = makeAdapter();
    const channel = new FakeChannel();

    const a = targetFor(channel, "session-A");
    await adapter.sendProgress(a, "A: step 1");
    await adapter.sendProgress(a, "A: step 2");

    // One send for session A, then an in-place edit (not a second send).
    expect(channel.sent.length).toBe(1);
    expect(channel.sent[0]?.edits).toEqual(["> A: step 2"]);
    expect(channel.sent[0]?.content).toBe("> A: step 2");
  });

  test("clearProgress deletes only the finishing session's placeholder", async () => {
    const adapter = makeAdapter();
    const channel = new FakeChannel();

    const a = targetFor(channel, "session-A");
    const b = targetFor(channel, "session-B");

    await adapter.sendProgress(a, "A: working");
    await adapter.sendProgress(b, "B: working");

    const msgA = channel.sent[0];
    const msgB = channel.sent[1];

    // Session A finishes — only A's message is deleted; B's survives.
    await adapter.clearProgress(a);
    expect(msgA?.deleted).toBe(true);
    expect(msgB?.deleted).toBe(false);

    // Session B finishes later — now B's message is deleted too.
    await adapter.clearProgress(b);
    expect(msgB?.deleted).toBe(true);
  });

  test("absent sessionId falls back to channel-scope (pre-#708 behaviour)", async () => {
    const adapter = makeAdapter();
    const channel = new FakeChannel();

    // No sessionId — e.g. the envelope render path. Two calls to the same
    // channel scope collapse onto one message (edit-in-place), as before.
    const t1: ResponseTarget = { instanceId: "discord-test", channelId: "ch", _native: channel };
    const t2: ResponseTarget = { instanceId: "discord-test", channelId: "ch", _native: channel };

    await adapter.sendProgress(t1, "first");
    await adapter.sendProgress(t2, "second");

    expect(channel.sent.length).toBe(1);
    expect(channel.sent[0]?.edits).toEqual(["> second"]);
  });
});
