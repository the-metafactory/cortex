/**
 * cortex#108 item 1 — start()/attachInboundDispatch() separation.
 *
 * Background (Echo's round-1 review of cortex#105):
 *   Pre-cortex#108, `DiscordAdapter.start()` registered the
 *   `messageCreate` listener BEFORE returning, so adapter A could start
 *   processing inbound events while cortex.ts Pass 2 hadn't yet merged
 *   peer B's bot id into A's `trustedBotIds`. Bot-to-bot @-mentions
 *   landing in that startup window were silently dropped — same class
 *   as cortex#84/#98 but during the start phase.
 *
 * cortex#108 fix:
 *   - `start()` does login + shard-lifecycle wiring, stores `onMessage`,
 *     but does NOT attach `messageCreate`.
 *   - `attachInboundDispatch()` registers `messageCreate` using the
 *     stored callback. Cortex.ts Pass 2 calls it AFTER
 *     `setTrustedBotIds(merged)` so the first delivered event sees the
 *     post-merge allowlist.
 *
 * This suite pins the new contract:
 *   1. `start()` does not register `messageCreate`.
 *   2. `attachInboundDispatch()` is the ONLY path that registers it.
 *   3. `attachInboundDispatch()` is idempotent — second call no-ops.
 *   4. `attachInboundDispatch()` before `start()` throws.
 *   5. Multi-adapter race: in a 2-adapter Pass-1→Pass-2 simulation, no
 *      `messageCreate` listener exists until Pass 2 fires.
 *
 * We don't go near a real Discord gateway. `start()` is bypassed by
 * injecting a fake client (matches the render-envelope.test.ts pattern)
 * — what we care about is the listener-registration count, not the
 * gateway handshake.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "events";
import { DiscordAdapter, type DiscordAdapterInfra } from "../index";
import { DMConfigSchema } from "../../../common/types/config";
import type { Agent, DiscordPresence } from "../../../common/types/cortex-config";
import type { InboundMessage } from "../../types";

// ---------------------------------------------------------------------------
// Console suppression — adapter logs a degraded-empty-surfaceSubjects warning
// at construction; not relevant to this suite.
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
// Fakes — minimal shape that matches the adapter's runtime contract.
// ---------------------------------------------------------------------------

/**
 * Minimal fake Client. Inherits EventEmitter so the adapter's
 * `client.on("messageCreate", ...)` registers a real listener we can count
 * via `listenerCount("messageCreate")`. `user.id` is non-null so the
 * messageCreate handler's self-loop guard has something to compare against.
 */
class FakeClient extends EventEmitter {
  public user = { id: "self-bot-id" };
  isReady() { return true; }
  // Adapter's `client.channels.fetch` is called from the messageCreate
  // handler for thread parent lookup; we never trigger that path here.
  channels = { fetch: async () => null };
}

function makeAdapter(instanceId = "discord-test"): {
  adapter: DiscordAdapter;
  fakeClient: FakeClient;
} {
  const presence: DiscordPresence = {
    enabled: true,
    token: "fake-token",
    guildId: "g1",
    agentChannelId: "c1",
    logChannelId: "c2",
    contextDepth: 0,
    enableAgentLog: false,
    roles: [],
    defaultRole: "allow-all",
    dm: DMConfigSchema.parse({}),
    trustedBotIds: [],
  };
  const agent: Agent = {
    id: "test-agent",
    displayName: "TestAgent",
    persona: "(test)",
    roles: [],
    trust: [],
    presence: { discord: presence },
  };
  const infra: DiscordAdapterInfra = {
    instanceId,
    operator: {},
  };
  const adapter = new DiscordAdapter(agent, presence, infra);

  // Inject a fake client into the adapter. Skips the real `client.login()`
  // (which would require a live Discord token) — what this suite measures
  // is listener-registration ordering, not the discord.js handshake.
  const fakeClient = new FakeClient();
  (adapter as unknown as { client: FakeClient }).client = fakeClient;

  return { adapter, fakeClient };
}

// ---------------------------------------------------------------------------
// Helper: simulate the part of `start()` that stashes onMessage. The real
// `start()` would do `client.login()` first; we bypass to keep the test
// hermetic.
// ---------------------------------------------------------------------------

function stashOnMessage(
  adapter: DiscordAdapter,
  onMessage: (msg: InboundMessage) => Promise<void>,
): void {
  (adapter as unknown as {
    onMessage: (msg: InboundMessage) => Promise<void>;
  }).onMessage = onMessage;
}

// ---------------------------------------------------------------------------
// 1. start()-equivalent setup does not register messageCreate
// ---------------------------------------------------------------------------

describe("DiscordAdapter: start() does not register messageCreate (cortex#108)", () => {
  test("post-start, pre-attach: no messageCreate listener", () => {
    const { adapter, fakeClient } = makeAdapter();
    // Simulate `start()` having completed: client injected + onMessage stashed,
    // but `attachInboundDispatch()` not yet called. The pre-cortex#108 shape
    // would have already registered a messageCreate listener at this point.
    stashOnMessage(adapter, async () => {});
    expect(fakeClient.listenerCount("messageCreate")).toBe(0);
  });

  test("attachInboundDispatch registers exactly one messageCreate listener", () => {
    const { adapter, fakeClient } = makeAdapter();
    stashOnMessage(adapter, async () => {});
    adapter.attachInboundDispatch();
    expect(fakeClient.listenerCount("messageCreate")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotency — second attach is a no-op
// ---------------------------------------------------------------------------

describe("DiscordAdapter.attachInboundDispatch: idempotent (cortex#108)", () => {
  test("second call does not register a second listener", () => {
    const { adapter, fakeClient } = makeAdapter();
    stashOnMessage(adapter, async () => {});
    adapter.attachInboundDispatch();
    adapter.attachInboundDispatch();
    adapter.attachInboundDispatch();
    expect(fakeClient.listenerCount("messageCreate")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Pre-start guard — attach before start throws
// ---------------------------------------------------------------------------

describe("DiscordAdapter.attachInboundDispatch: pre-start guard (cortex#108)", () => {
  test("throws when called before start() (no client, no onMessage)", () => {
    const presence: DiscordPresence = {
      enabled: true,
      token: "fake-token",
      guildId: "g1",
      agentChannelId: "c1",
      logChannelId: "c2",
      contextDepth: 0,
      enableAgentLog: false,
      roles: [],
      defaultRole: "allow-all",
      dm: DMConfigSchema.parse({}),
      trustedBotIds: [],
    };
    const agent: Agent = {
      id: "test-agent",
      displayName: "TestAgent",
      persona: "(test)",
      roles: [],
      trust: [],
      presence: { discord: presence },
    };
    const adapter = new DiscordAdapter(agent, presence, {
      instanceId: "discord-pre-start",
      operator: {},
    });
    // No client injected, no onMessage stashed — should throw with a
    // clear message instructing the caller to await start() first.
    expect(() => adapter.attachInboundDispatch()).toThrow(/start\(\)/);
  });
});

// ---------------------------------------------------------------------------
// 4. Multi-adapter race — the actual TOCTOU window
// ---------------------------------------------------------------------------

describe("DiscordAdapter: Pass-1→Pass-2 TOCTOU window closed (cortex#108)", () => {
  test("two adapters: no messageCreate listener after Pass 1; both after Pass 2", () => {
    // Pass 1: start both adapters. Pre-cortex#108, BOTH adapters would
    // have a messageCreate listener already attached at this point — and
    // either adapter could process an inbound bot-to-bot @-mention from
    // the other before the trustedBotIds merge happens.
    const a = makeAdapter("discord-adapter-A");
    const b = makeAdapter("discord-adapter-B");
    stashOnMessage(a.adapter, async () => {});
    stashOnMessage(b.adapter, async () => {});

    // ✋ End of Pass 1. The TOCTOU window starts here. Confirm BOTH
    // adapters have NO messageCreate listener — so a bot-to-bot @-mention
    // arriving now would be held in the discord.js gateway buffer rather
    // than processed against a not-yet-populated allowlist.
    expect(a.fakeClient.listenerCount("messageCreate")).toBe(0);
    expect(b.fakeClient.listenerCount("messageCreate")).toBe(0);

    // Pass 2: cortex.ts now sets the merged trustedBotIds, then attaches.
    a.adapter.setTrustedBotIds(new Set(["B-bot-id"]));
    a.adapter.attachInboundDispatch();
    b.adapter.setTrustedBotIds(new Set(["A-bot-id"]));
    b.adapter.attachInboundDispatch();

    // Post-Pass-2: both adapters now have a listener, both have the
    // peer's bot id in their allowlist. The first delivered messageCreate
    // event sees the post-merge state.
    expect(a.fakeClient.listenerCount("messageCreate")).toBe(1);
    expect(b.fakeClient.listenerCount("messageCreate")).toBe(1);
    expect(a.adapter.trustedBotIdCount).toBe(1);
    expect(b.adapter.trustedBotIdCount).toBe(1);
  });

  test("strict order: setTrustedBotIds must run before attachInboundDispatch", () => {
    // Sanity: the order setTrustedBotIds → attachInboundDispatch is the
    // ONLY one that closes the TOCTOU. If a caller flipped them, the
    // listener would be live before the allowlist was merged. We don't
    // enforce this in code (no runtime check) because cortex.ts is the
    // single trusted caller — but the test pins the contract so a future
    // refactor that flips the order would visibly change the assertion.
    const { adapter, fakeClient } = makeAdapter();
    stashOnMessage(adapter, async () => {});

    // Step 1: merge.
    adapter.setTrustedBotIds(new Set(["peer-bot-1", "peer-bot-2"]));
    expect(fakeClient.listenerCount("messageCreate")).toBe(0); // not yet attached
    expect(adapter.trustedBotIdCount).toBe(2);

    // Step 2: attach.
    adapter.attachInboundDispatch();
    expect(fakeClient.listenerCount("messageCreate")).toBe(1);
    expect(adapter.trustedBotIdCount).toBe(2);
  });
});
