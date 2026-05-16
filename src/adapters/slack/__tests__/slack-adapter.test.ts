/**
 * F-slack: SlackAdapter unit tests.
 *
 * Mirror of the Mattermost / Discord adapter test patterns. We inject a
 * fake `SlackClient` via the adapter's infra so no real Socket Mode
 * connection is opened and no Slack API is hit. Each test exercises one
 * adapter responsibility: translateEvent, resolveAccess, postResponse,
 * createThread, notifyOperator, surfaceConfig.render.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { SlackAdapter, type SlackAdapterInfra } from "../index";
import type { SlackClient, SlackInboundEvent, SlackBotIdentity } from "../client";
import type { Agent, SlackPresence } from "../../../common/types/cortex-config";
import type { InboundMessage } from "../../types";
import type { Envelope } from "../../../bus/myelin/envelope-validator";

// ---------------------------------------------------------------------------
// Fake SlackClient — records calls and exposes a hook to simulate inbound
// events. Tests assert against `postedMessages` / `wasStopped` and drive
// events via `emitEvent`.
// ---------------------------------------------------------------------------

interface FakeSlackClientState {
  postedMessages: { channel: string; text: string; threadTs?: string }[];
  startCount: number;
  stopCount: number;
  botUserId: string;
  /** Optional bot id (`B…`) returned alongside the user id by `getBotIdentity`. */
  botId?: string;
  /** Throw on next postMessage when set. */
  postMessageError?: Error;
  /**
   * Sequence of client-method calls in invocation order — used to
   * assert that `getBotIdentity` resolves BEFORE `start` opens the
   * socket (Echo cortex#233 self-loop TOCTOU fix).
   */
  callOrder: ("start" | "stop" | "postMessage" | "getBotUserId" | "getBotIdentity")[];
  /** When set, the next identity call rejects with this error. */
  getBotUserIdError?: Error;
}

function makeFakeClient(initial: Partial<FakeSlackClientState> = {}): {
  client: SlackClient;
  state: FakeSlackClientState;
  emit: (event: SlackInboundEvent) => Promise<void>;
  /** cortex#235 r1#4 — drive the Socket Mode `connected` lifecycle callback. */
  simulateConnect: () => void;
  /** cortex#235 r1#4 — drive the Socket Mode `disconnected` lifecycle callback. */
  simulateDisconnect: (info?: { wasClean?: boolean; closeReason?: string }) => void;
} {
  const state: FakeSlackClientState = {
    postedMessages: [],
    startCount: 0,
    stopCount: 0,
    botUserId: initial.botUserId ?? "UBOT123",
    callOrder: [],
    ...(initial.botId !== undefined && { botId: initial.botId }),
    ...(initial.postMessageError !== undefined && { postMessageError: initial.postMessageError }),
    ...(initial.getBotUserIdError !== undefined && { getBotUserIdError: initial.getBotUserIdError }),
  };

  let onEvent: ((event: SlackInboundEvent) => Promise<void>) | null = null;
  let onConnected: (() => void) | null = null;
  let onDisconnected: ((info: { wasClean?: boolean; closeReason?: string }) => void) | null = null;

  const client: SlackClient = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async start(opts) {
      state.startCount++;
      state.callOrder.push("start");
      onEvent = opts.onEvent;
      onConnected = opts.onConnected ?? null;
      onDisconnected = opts.onDisconnected ?? null;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async stop() {
      state.stopCount++;
      state.callOrder.push("stop");
      onEvent = null;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async postMessage(channel, text, threadTs) {
      state.callOrder.push("postMessage");
      if (state.postMessageError) throw state.postMessageError;
      state.postedMessages.push({
        channel,
        text,
        ...(threadTs !== undefined && { threadTs }),
      });
      return { ts: "1700000000.000001" };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async getBotUserId() {
      state.callOrder.push("getBotUserId");
      if (state.getBotUserIdError) throw state.getBotUserIdError;
      return state.botUserId;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async getBotIdentity(): Promise<SlackBotIdentity> {
      state.callOrder.push("getBotIdentity");
      if (state.getBotUserIdError) throw state.getBotUserIdError;
      return {
        userId: state.botUserId,
        ...(state.botId !== undefined && { botId: state.botId }),
      };
    },
  };

  const emit = async (event: SlackInboundEvent) => {
    if (!onEvent) throw new Error("client.start() not called");
    await onEvent(event);
  };

  const simulateConnect = (): void => {
    if (!onConnected) return;
    onConnected();
  };

  const simulateDisconnect = (info: { wasClean?: boolean; closeReason?: string } = {}): void => {
    if (!onDisconnected) return;
    onDisconnected(info);
  };

  return { client, state, emit, simulateConnect, simulateDisconnect };
}

function makePresence(overrides: Partial<SlackPresence> = {}): SlackPresence {
  return {
    enabled: true,
    botToken: "xoxb-TEST-TOKEN-12345",
    appToken: "xapp-TEST-APP-12345",
    workspaceId: "T0WORKSPACE",
    channels: [{ id: "C0CHAN1", name: "cortex" }],
    allowedUserIds: [],
    trustedBotIds: [],
    roles: [],
    defaultRole: "allow-all",
    surfaceSubjects: [],
    ...overrides,
  };
}

function makeAgent(presence: SlackPresence): Agent {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "(test)",
    roles: [],
    trust: [],
    presence: { slack: presence },
  };
}

function makeAdapter(opts: {
  presence?: Partial<SlackPresence>;
  infra?: Partial<SlackAdapterInfra>;
  clientState?: Partial<FakeSlackClientState>;
} = {}) {
  const presence = makePresence(opts.presence);
  const agent = makeAgent(presence);
  const fake = makeFakeClient(opts.clientState);
  const infra: SlackAdapterInfra = {
    instanceId: "slack-test",
    operator: {},
    client: fake.client,
    ...opts.infra,
  };
  const adapter = new SlackAdapter(agent, presence, infra);
  return { adapter, ...fake };
}

// Helpers for asserting captured inbound messages from `start(onMessage)`.
function captureInbound() {
  const received: InboundMessage[] = [];
  return {
    received,
    onMessage: async (msg: InboundMessage) => {
      received.push(msg);
    },
  };
}

function makeSlackEvent(overrides: Partial<SlackInboundEvent> = {}): SlackInboundEvent {
  return {
    type: "message",
    user: "U0HUMAN",
    team: "T0WORKSPACE",
    channel: "C0CHAN1",
    text: "hello bot",
    ts: "1700000000.000123",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Console suppression for warning-emitting tests.
// ---------------------------------------------------------------------------

let originalWarn: typeof console.warn;
let originalError: typeof console.error;
const warnings: string[] = [];

beforeEach(() => {
  warnings.length = 0;
  originalWarn = console.warn;
  originalError = console.error;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  console.error = () => {};
});

afterEach(() => {
  console.warn = originalWarn;
  console.error = originalError;
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("SlackAdapter — construction", () => {
  test("platform is 'slack'", () => {
    const { adapter } = makeAdapter();
    expect(adapter.platform).toBe("slack");
  });

  test("instanceId mirrors infra.instanceId", () => {
    const { adapter } = makeAdapter({ infra: { instanceId: "luna-slack" } });
    expect(adapter.instanceId).toBe("luna-slack");
  });

  test("warns at construction when surfaceSubjects is explicitly []", () => {
    makeAdapter({ infra: { surfaceSubjects: [] } });
    expect(
      warnings.some((w) => w.includes("surfaceSubjects is empty")),
    ).toBe(true);
  });

  test("does NOT warn when surfaceSubjects is undefined", () => {
    makeAdapter();
    expect(warnings.some((w) => w.includes("surfaceSubjects is empty"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: start / stop / getPlatformUserId
// ---------------------------------------------------------------------------

describe("SlackAdapter — lifecycle", () => {
  test("start opens the client and caches bot user id", async () => {
    const { adapter, state } = makeAdapter({ clientState: { botUserId: "UBOTLUNA" } });
    const cap = captureInbound();
    await adapter.start(cap.onMessage);
    expect(state.startCount).toBe(1);
    expect(await adapter.getPlatformUserId()).toBe("UBOTLUNA");
  });

  test("stop closes the client and drops the cached id", async () => {
    const { adapter, state } = makeAdapter();
    const cap = captureInbound();
    await adapter.start(cap.onMessage);
    await adapter.stop();
    expect(state.stopCount).toBe(1);
  });

  test("stop clears the dedup ring so a re-started adapter sees fresh ts (Echo r2 N4)", async () => {
    // Echo r2 N4: without clearing the ring on stop(), a hot-restart
    // (config watcher / test fixture reuse) would carry over `ts`
    // values from the prior session, silently dropping legitimate
    // messages whose ts happened to match.
    const { adapter, emit } = makeAdapter();
    const cap = captureInbound();
    await adapter.start(cap.onMessage);
    await emit(makeSlackEvent({ ts: "1700000000.111111", text: "first" }));
    expect(cap.received).toHaveLength(1);

    await adapter.stop();
    await adapter.start(cap.onMessage);

    // Same ts replayed AFTER stop+start — must NOT be dropped by the
    // ring, because stop() cleared it.
    await emit(makeSlackEvent({ ts: "1700000000.111111", text: "first-replay" }));
    expect(cap.received).toHaveLength(2);
    expect(cap.received[1]?.content).toBe("first-replay");
  });

  test("getPlatformUserId fetches on demand when not yet cached", async () => {
    const { adapter, state } = makeAdapter({ clientState: { botUserId: "UFRESH" } });
    // Don't start — call getPlatformUserId directly.
    expect(state.startCount).toBe(0);
    const id = await adapter.getPlatformUserId();
    expect(id).toBe("UFRESH");
  });

  test("start fetches getBotIdentity BEFORE opening the socket (TOCTOU fix)", async () => {
    // Echo cortex#233 (review #2): the self-loop guard depends on
    // identity being non-null at the moment any inbound event is
    // translated. Before this fix, `client.start()` was awaited first
    // and identity second — opening a ~auth.test-round-trip window
    // where events could arrive with the cache still null. Lock in
    // the new ordering: getBotIdentity → start.
    const { adapter, state } = makeAdapter();
    const cap = captureInbound();
    await adapter.start(cap.onMessage);
    const getIdx = state.callOrder.indexOf("getBotIdentity");
    const startIdx = state.callOrder.indexOf("start");
    expect(getIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(getIdx).toBeLessThan(startIdx);
  });

  test("start aborts (fail-closed) when getBotIdentity rejects", async () => {
    // Fail-closed companion to the TOCTOU fix: if we can't resolve our
    // own bot id, opening the socket is unsafe — any self-echo would
    // dispatch as a real message. Surface the error to the caller.
    const { adapter, state } = makeAdapter({
      clientState: { getBotUserIdError: new Error("auth.test 403") },
    });
    const cap = captureInbound();
    await expect(adapter.start(cap.onMessage)).rejects.toThrow(/auth\.test/);
    expect(state.startCount).toBe(0); // socket never opened
  });
});

// ---------------------------------------------------------------------------
// translateEvent — via the start(onMessage) seam
// ---------------------------------------------------------------------------

describe("SlackAdapter — translateEvent", () => {
  test("translates a plain message into an InboundMessage", async () => {
    const { adapter, emit } = makeAdapter();
    const cap = captureInbound();
    await adapter.start(cap.onMessage);

    await emit(makeSlackEvent({ user: "U0HUMAN", text: "hello", channel: "C0CHAN1" }));

    expect(cap.received).toHaveLength(1);
    const msg = cap.received[0]!;
    expect(msg.platform).toBe("slack");
    expect(msg.authorId).toBe("U0HUMAN");
    expect(msg.content).toBe("hello");
    expect(msg.channelId).toBe("C0CHAN1");
    expect(msg.channelName).toBe("cortex");
    expect(msg.guildId).toBe("T0WORKSPACE");
    expect(msg.threadId).toBeUndefined();
  });

  test("populates threadId from thread_ts when present", async () => {
    const { adapter, emit } = makeAdapter();
    const cap = captureInbound();
    await adapter.start(cap.onMessage);

    await emit(makeSlackEvent({ thread_ts: "1700000000.000000" }));

    expect(cap.received[0]?.threadId).toBe("1700000000.000000");
  });

  test("drops self-authored messages (botUserId matches)", async () => {
    const { adapter, emit } = makeAdapter({ clientState: { botUserId: "UBOTSELF" } });
    const cap = captureInbound();
    await adapter.start(cap.onMessage);

    await emit(makeSlackEvent({ user: "UBOTSELF" }));

    expect(cap.received).toHaveLength(0);
  });

  test("drops self-echo via bot_id path (Echo r2 N1)", async () => {
    // When this bot's own `chat.postMessage` round-trips as a
    // `bot_message` subtype event, the author is `event.bot_id` (`B…`),
    // NOT `event.user`. The self-loop guard must catch that path too
    // or the bot will echo itself.
    const { adapter, emit } = makeAdapter({
      clientState: { botUserId: "UBOTSELF", botId: "BSELF" },
    });
    const cap = captureInbound();
    await adapter.start(cap.onMessage);

    await emit(makeSlackEvent({
      subtype: "bot_message",
      user: undefined,
      bot_id: "BSELF",
      text: "self echo",
    }));

    expect(cap.received).toHaveLength(0);
  });

  test("accepts a peer bot when trustedBotIds contains its B-id (Echo r2 N2)", async () => {
    // Echo r2 N2 contract: trustedBotIds is `B…` (bot ids), NOT `U…`
    // (user ids). A peer bot's bot_message event arrives with
    // `bot_id: B…` and must be matched against the B-id list.
    const { adapter, emit } = makeAdapter({
      infra: { trustedBotIds: new Set(["BPEER"]) },
      clientState: { botUserId: "UBOTSELF", botId: "BSELF" },
    });
    const cap = captureInbound();
    await adapter.start(cap.onMessage);

    await emit(makeSlackEvent({
      subtype: "bot_message",
      user: undefined,
      bot_id: "BPEER",
      text: "trusted peer",
    }));

    expect(cap.received).toHaveLength(1);
    expect(cap.received[0]?.authorId).toBe("BPEER");
  });

  test("rejects peer bot when only its U-id (not B-id) is in trustedBotIds (Echo r2 N2)", async () => {
    // Operators following the OLD doc would populate trustedBotIds with
    // a `U…` value. The runtime check against `event.bot_id` (a `B…`)
    // never matches → trust silently fails to take effect. After the
    // r2 fix, the documented contract is `B…`; populating `U…` no
    // longer matches anything in the bot_message path, by design.
    const { adapter, emit } = makeAdapter({
      infra: { trustedBotIds: new Set(["UPEER"]) }, // wrong shape per new doc
      clientState: { botUserId: "UBOTSELF", botId: "BSELF" },
    });
    const cap = captureInbound();
    await adapter.start(cap.onMessage);

    await emit(makeSlackEvent({
      subtype: "bot_message",
      user: undefined,
      bot_id: "BPEER",
      text: "would-be peer",
    }));

    expect(cap.received).toHaveLength(0);
  });

  test("drops system subtypes like channel_join", async () => {
    const { adapter, emit } = makeAdapter();
    const cap = captureInbound();
    await adapter.start(cap.onMessage);

    await emit(makeSlackEvent({ subtype: "channel_join" }));

    expect(cap.received).toHaveLength(0);
  });

  test("drops bot_message when the bot id is not in trustedBotIds", async () => {
    const { adapter, emit } = makeAdapter();
    const cap = captureInbound();
    await adapter.start(cap.onMessage);

    await emit(makeSlackEvent({
      subtype: "bot_message",
      user: undefined,
      bot_id: "BPEER",
    }));

    expect(cap.received).toHaveLength(0);
  });

  test("accepts bot_message when the bot id is in trustedBotIds", async () => {
    const { adapter, emit } = makeAdapter({
      infra: { trustedBotIds: new Set(["BPEER"]) },
    });
    const cap = captureInbound();
    await adapter.start(cap.onMessage);

    await emit(makeSlackEvent({
      subtype: "bot_message",
      user: undefined,
      bot_id: "BPEER",
      text: "from peer",
    }));

    expect(cap.received).toHaveLength(1);
    expect(cap.received[0]?.authorId).toBe("BPEER");
    expect(cap.received[0]?.content).toBe("from peer");
  });

  test("dedups when the same ts arrives twice (message + app_mention)", async () => {
    // Echo cortex#233 (review #1): Slack fires BOTH `message` and
    // `app_mention` for the same user message when the bot is a
    // channel member. The client subscribes to both for coverage; the
    // adapter must collapse them by `ts` so the dispatch pipeline only
    // sees one InboundMessage.
    const { adapter, emit } = makeAdapter();
    const cap = captureInbound();
    await adapter.start(cap.onMessage);

    const sharedTs = "1700000000.555555";
    await emit(makeSlackEvent({ type: "message", ts: sharedTs, text: "@bot hi" }));
    await emit(makeSlackEvent({ type: "app_mention", ts: sharedTs, text: "@bot hi" }));

    expect(cap.received).toHaveLength(1);
    expect(cap.received[0]?.content).toBe("@bot hi");
  });

  test("does NOT dedup distinct ts values", async () => {
    // Sanity check on the dedup gate — different messages must both
    // dispatch even when they share other fields.
    const { adapter, emit } = makeAdapter();
    const cap = captureInbound();
    await adapter.start(cap.onMessage);

    await emit(makeSlackEvent({ ts: "1700000000.111111", text: "first" }));
    await emit(makeSlackEvent({ ts: "1700000000.222222", text: "second" }));

    expect(cap.received).toHaveLength(2);
  });

  test("maps Slack files to InboundMessage attachments", async () => {
    const { adapter, emit } = makeAdapter();
    const cap = captureInbound();
    await adapter.start(cap.onMessage);

    await emit(makeSlackEvent({
      files: [
        { url_private: "https://files.slack.com/x.png", name: "x.png", mimetype: "image/png", size: 42 },
      ],
    }));

    expect(cap.received[0]?.attachments).toEqual([{
      url: "https://files.slack.com/x.png",
      filename: "x.png",
      contentType: "image/png",
      size: 42,
    }]);
  });
});

// ---------------------------------------------------------------------------
// resolveAccess
// ---------------------------------------------------------------------------

describe("SlackAdapter — resolveAccess", () => {
  function makeInbound(authorId: string): InboundMessage {
    return {
      platform: "slack",
      instanceId: "slack-test",
      authorId,
      authorName: authorId,
      content: "hi",
      channelId: "C0CHAN1",
      attachments: [],
      timestamp: new Date(0),
    };
  }

  test("allow-all role grants all features when no roles configured", () => {
    const { adapter } = makeAdapter();
    const decision = adapter.resolveAccess(makeInbound("U0HUMAN"));
    expect(decision.allowed).toBe(true);
    expect(decision.features.chat).toBe(true);
    expect(decision.features.async).toBe(true);
    expect(decision.features.team).toBe(true);
  });

  test("denies when allowedUserIds is set and user is not in it", () => {
    const { adapter } = makeAdapter({
      presence: { allowedUserIds: ["UOPERATOR"] },
    });
    const decision = adapter.resolveAccess(makeInbound("U0RANDO"));
    expect(decision.allowed).toBe(false);
    expect(decision.denyReason).toContain("specific users");
  });

  test("allows when allowedUserIds is set and user is in it", () => {
    const { adapter } = makeAdapter({
      presence: { allowedUserIds: ["UOPERATOR"] },
    });
    const decision = adapter.resolveAccess(makeInbound("UOPERATOR"));
    expect(decision.allowed).toBe(true);
  });

  test("denies a self-loop message even if the user is in allowedUserIds", async () => {
    const { adapter } = makeAdapter({
      presence: { allowedUserIds: ["UBOTSELF"] },
      clientState: { botUserId: "UBOTSELF" },
    });
    // start() to populate the cached bot user id.
    await adapter.start(captureInbound().onMessage);
    const decision = adapter.resolveAccess(makeInbound("UBOTSELF"));
    expect(decision.allowed).toBe(false);
    expect(decision.denyReason).toContain("Self-loop");
  });

  test("self-loop denial also fires for the bot_id (B-id) path (Echo r2 N1)", async () => {
    // resolveAccess sees the post-translate InboundMessage where
    // authorId may be either the U-id or the B-id depending on the
    // event subtype. Both must trigger the self-loop deny so a
    // late-stage echo can't slip through.
    const { adapter } = makeAdapter({
      clientState: { botUserId: "UBOTSELF", botId: "BSELF" },
    });
    await adapter.start(captureInbound().onMessage);
    const decision = adapter.resolveAccess(makeInbound("BSELF"));
    expect(decision.allowed).toBe(false);
    expect(decision.denyReason).toContain("Self-loop");
  });
});

// ---------------------------------------------------------------------------
// postResponse
// ---------------------------------------------------------------------------

describe("SlackAdapter — postResponse", () => {
  test("posts via the client with channel + text", async () => {
    const { adapter, state } = makeAdapter();
    await adapter.postResponse({ instanceId: "slack-test", channelId: "C0CHAN1" }, "ok");
    expect(state.postedMessages).toEqual([{ channel: "C0CHAN1", text: "ok" }]);
  });

  test("threads the response when threadId is set", async () => {
    const { adapter, state } = makeAdapter();
    await adapter.postResponse(
      { instanceId: "slack-test", channelId: "C0CHAN1", threadId: "1700000000.000000" },
      "ok",
    );
    expect(state.postedMessages[0]?.threadTs).toBe("1700000000.000000");
  });

  test("warns and drops file attachments (v1 text-only)", async () => {
    const { adapter, state } = makeAdapter();
    await adapter.postResponse(
      { instanceId: "slack-test", channelId: "C0CHAN1" },
      "see attached",
      [{ content: Buffer.from("data"), filename: "x.txt" }],
    );
    expect(warnings.some((w) => w.includes("file attachments not yet supported"))).toBe(true);
    // Text still posts.
    expect(state.postedMessages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// sendProgress / createThread / notifyOperator
// ---------------------------------------------------------------------------

describe("SlackAdapter — sendProgress + createThread + notifyOperator", () => {
  test("sendProgress posts once and skips subsequent calls", async () => {
    const { adapter, state } = makeAdapter();
    const target = { instanceId: "slack-test", channelId: "C0CHAN1", threadId: "T123" };
    await adapter.sendProgress(target, "step 1");
    await adapter.sendProgress(target, "step 2");
    expect(state.postedMessages).toHaveLength(1);
    expect(state.postedMessages[0]?.text).toBe("> step 1");
  });

  test("clearProgress allows a subsequent sendProgress to post again", async () => {
    const { adapter, state } = makeAdapter();
    const target = { instanceId: "slack-test", channelId: "C0CHAN1", threadId: "T123" };
    await adapter.sendProgress(target, "first");
    await adapter.clearProgress(target);
    await adapter.sendProgress(target, "second");
    expect(state.postedMessages).toHaveLength(2);
    expect(state.postedMessages[1]?.text).toBe("> second");
  });

  test("createThread returns threadId rooted on the source message's ts", async () => {
    const { adapter } = makeAdapter();
    const msg: InboundMessage = {
      platform: "slack",
      instanceId: "slack-test",
      authorId: "U0HUMAN",
      authorName: "U0HUMAN",
      content: "spawn a thread",
      channelId: "C0CHAN1",
      attachments: [],
      timestamp: new Date(0),
      _native: makeSlackEvent({ ts: "1700000000.999999" }),
    };
    const target = await adapter.createThread(msg, "ignored-name");
    expect(target.channelId).toBe("C0CHAN1");
    expect(target.threadId).toBe("1700000000.999999");
  });

  test("createThread returns threadId undefined when no ts is available (Echo r2)", async () => {
    // Echo cortex#233 round-2: the previous fallback chain ended in
    // `msg.channelId`, which is a `C...`/`G...` id, not a `thread_ts`
    // (`1700000000.123456`). `chat.postMessage` silently treated the
    // channel id as "no thread" — bug masked. Lock in the new
    // behaviour: if no legitimate ts source is available, return
    // `threadId: undefined` and let the caller post top-level.
    const { adapter } = makeAdapter();
    const msg: InboundMessage = {
      platform: "slack",
      instanceId: "slack-test",
      authorId: "U0HUMAN",
      authorName: "U0HUMAN",
      content: "no native event attached",
      channelId: "C0CHAN1",
      attachments: [],
      timestamp: new Date(0),
      // intentionally no _native and no threadId
    };
    const target = await adapter.createThread(msg, "ignored-name");
    expect(target.channelId).toBe("C0CHAN1");
    expect(target.threadId).toBeUndefined();
  });

  test("createThread prefers _native.thread_ts over _native.ts", async () => {
    // If we're already in a thread (`thread_ts` set), new replies stay
    // in the parent thread rather than spawning a sub-thread under our
    // own ts. Slack doesn't support nested threads anyway.
    const { adapter } = makeAdapter();
    const msg: InboundMessage = {
      platform: "slack",
      instanceId: "slack-test",
      authorId: "U0HUMAN",
      authorName: "U0HUMAN",
      content: "reply in existing thread",
      channelId: "C0CHAN1",
      attachments: [],
      timestamp: new Date(0),
      _native: makeSlackEvent({
        ts: "1700000000.222222",
        thread_ts: "1700000000.111111",
      }),
    };
    const target = await adapter.createThread(msg, "ignored");
    expect(target.threadId).toBe("1700000000.111111");
  });

  test("notifyOperator no-ops when operator.slackId is not configured", async () => {
    const { adapter, state } = makeAdapter();
    await adapter.notifyOperator("ping");
    expect(state.postedMessages).toHaveLength(0);
  });

  test("notifyOperator DMs the operator when slackId is configured", async () => {
    const { adapter, state } = makeAdapter({
      infra: { operator: { slackId: "UOPERATOR" } },
    });
    await adapter.notifyOperator("ping");
    expect(state.postedMessages).toEqual([{ channel: "UOPERATOR", text: "ping" }]);
  });

  test("notifyOperator swallows post errors (log + drop)", async () => {
    const { adapter } = makeAdapter({
      infra: { operator: { slackId: "UOPERATOR" } },
      clientState: { postMessageError: new Error("403 not_in_channel") },
    });
    // Must not throw — the operator's notification path is best-effort.
    await expect(adapter.notifyOperator("ping")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// surfaceConfig.render — bus envelope rendering
// ---------------------------------------------------------------------------

describe("SlackAdapter.surfaceConfig", () => {
  function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
    return {
      id: "00000000-0000-4000-8000-000000000099",
      source: "metafactory.pilot.local",
      type: "review.cycle.completed",
      timestamp: "2026-05-09T12:00:00Z",
      sovereignty: {
        classification: "local",
        data_residency: "NZ",
        max_hop: 0,
        frontier_ok: true,
        model_class: "any",
      },
      payload: { repo: "cortex" },
      ...overrides,
    };
  }

  test("id matches instanceId, subjects mirror surfaceSubjects", () => {
    const { adapter } = makeAdapter({
      infra: { surfaceSubjects: ["local.metafactory.review.>"] },
    });
    expect(adapter.surfaceConfig.id).toBe("slack-test");
    expect(adapter.surfaceConfig.subjects).toEqual(["local.metafactory.review.>"]);
  });

  test("renders the envelope to the fallback channel when configured", async () => {
    const { adapter, state } = makeAdapter({
      infra: { surfaceFallbackChannelId: "C0FALLBACK" },
    });
    await adapter.surfaceConfig.render(makeEnvelope());
    expect(state.postedMessages).toHaveLength(1);
    expect(state.postedMessages[0]?.channel).toBe("C0FALLBACK");
    expect(state.postedMessages[0]?.text).toContain("**review.cycle.completed**");
  });

  test("renders top-level (no threading) when posting bus envelopes", async () => {
    const { adapter, state } = makeAdapter({
      infra: { surfaceFallbackChannelId: "C0FALLBACK" },
    });
    await adapter.surfaceConfig.render(makeEnvelope());
    expect(state.postedMessages[0]?.threadTs).toBeUndefined();
  });

  test("drops + warns when no surfaceFallbackChannelId is configured", async () => {
    const { adapter, state } = makeAdapter();
    await adapter.surfaceConfig.render(makeEnvelope());
    expect(state.postedMessages).toHaveLength(0);
    expect(
      warnings.some((w) => w.includes("no surfaceFallbackChannelId configured")),
    ).toBe(true);
  });

  test("does not throw when postMessage fails (log + drop)", async () => {
    const { adapter } = makeAdapter({
      infra: { surfaceFallbackChannelId: "C0FALLBACK" },
      clientState: { postMessageError: new Error("rate limited") },
    });
    await expect(
      adapter.surfaceConfig.render(makeEnvelope()),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cortex#235 r1#4 — system.adapter.* envelope emission
// ---------------------------------------------------------------------------

describe("SlackAdapter — system.adapter.* envelopes (cortex#235 r1#4)", () => {
  interface RecordingRuntime {
    enabled: boolean;
    onEnvelope: () => { unregister: () => void };
    publish: (envelope: Envelope) => Promise<void>;
    stop: () => Promise<void>;
    publishes: Envelope[];
  }
  function makeRecordingRuntime(): RecordingRuntime {
    const publishes: Envelope[] = [];
    return {
      enabled: true,
      onEnvelope: () => ({ unregister: () => {} }),
      publish: async (envelope: Envelope) => { publishes.push(envelope); },
      stop: async () => {},
      publishes,
    };
  }

  const SOURCE = { org: "metafactory", agent: "luna", instance: "local" };

  test("initial connect after start() is silent (no envelope emitted)", async () => {
    const runtime = makeRecordingRuntime();
    const { adapter, simulateConnect } = makeAdapter({
      infra: { runtime, systemEventSource: SOURCE },
    });
    await adapter.start(async () => {});
    simulateConnect();
    expect(runtime.publishes).toHaveLength(0);
    await adapter.stop();
  });

  test("disconnect emits system.adapter.disconnected with wasClean=false on unclean drop", async () => {
    const runtime = makeRecordingRuntime();
    const { adapter, simulateDisconnect } = makeAdapter({
      infra: { runtime, systemEventSource: SOURCE },
    });
    await adapter.start(async () => {});
    simulateDisconnect({ wasClean: false, closeReason: "network drop" });
    expect(runtime.publishes).toHaveLength(1);
    const env = runtime.publishes[0]!;
    expect(env.type).toBe("system.adapter.disconnected");
    expect(env.payload.platform).toBe("slack");
    expect(env.payload.adapter_id).toBe("slack-test");
    expect(env.payload.was_clean).toBe(false);
    expect(env.payload.close_reason).toBe("network drop");
    await adapter.stop();
  });

  test("disconnect followed by reconnect emits disconnected + recovered pair", async () => {
    const runtime = makeRecordingRuntime();
    const { adapter, simulateConnect, simulateDisconnect } = makeAdapter({
      infra: { runtime, systemEventSource: SOURCE },
    });
    await adapter.start(async () => {});
    // Initial connect — silent
    simulateConnect();
    expect(runtime.publishes).toHaveLength(0);
    // Drop
    simulateDisconnect({ wasClean: false });
    expect(runtime.publishes).toHaveLength(1);
    expect(runtime.publishes[0]!.type).toBe("system.adapter.disconnected");
    // Reconnect — emits recovered
    simulateConnect();
    expect(runtime.publishes).toHaveLength(2);
    const recovered = runtime.publishes[1]!;
    expect(recovered.type).toBe("system.adapter.recovered");
    expect(recovered.payload.platform).toBe("slack");
    expect(recovered.payload.adapter_id).toBe("slack-test");
    expect(typeof recovered.payload.degraded_for_ms).toBe("number");
    expect(recovered.payload.degraded_for_ms as number).toBeGreaterThanOrEqual(0);
    await adapter.stop();
  });

  test("recovered envelope carries the original disconnect timestamp", async () => {
    const runtime = makeRecordingRuntime();
    const { adapter, simulateConnect, simulateDisconnect } = makeAdapter({
      infra: { runtime, systemEventSource: SOURCE },
    });
    await adapter.start(async () => {});
    simulateConnect();
    simulateDisconnect({ wasClean: false });
    const disconnectedAt = (runtime.publishes[0]!.payload as { disconnected_since: string })
      .disconnected_since;
    simulateConnect();
    const recovered = runtime.publishes[1]!;
    expect(recovered.payload.disconnected_since).toBe(disconnectedAt);
    await adapter.stop();
  });

  test("clean disconnect (stop() path) sets wasClean=true on envelope", async () => {
    const runtime = makeRecordingRuntime();
    const { adapter, simulateDisconnect } = makeAdapter({
      infra: { runtime, systemEventSource: SOURCE },
    });
    await adapter.start(async () => {});
    simulateDisconnect({ wasClean: true });
    const env = runtime.publishes[0]!;
    expect(env.payload.was_clean).toBe(true);
    expect(env.payload.close_reason).toBeUndefined();
    await adapter.stop();
  });

  test("no runtime configured → lifecycle silent (no crash)", async () => {
    const { adapter, simulateConnect, simulateDisconnect } = makeAdapter({
      // intentionally no runtime/systemEventSource
    });
    await adapter.start(async () => {});
    simulateConnect();
    simulateDisconnect({ wasClean: false });
    simulateConnect();
    // No throw; no publish observable from the outside.
    await adapter.stop();
  });

  test("stop() → start() resets latches; next initial connect is silent (Echo cortex#254 r1 M2)", async () => {
    const runtime = makeRecordingRuntime();
    const { adapter, simulateConnect, simulateDisconnect } = makeAdapter({
      infra: { runtime, systemEventSource: SOURCE },
    });
    // First session: initial connect (silent) → unclean disconnect →
    // recovered. Two envelopes expected.
    await adapter.start(async () => {});
    simulateConnect();
    simulateDisconnect({ wasClean: false });
    simulateConnect();
    expect(runtime.publishes).toHaveLength(2);
    await adapter.stop();
    // Second session: WITHOUT latch reset on stop(), the next initial
    // connect would be classified as a "recovery" and emit a spurious
    // `system.adapter.recovered`. Assert it stays at 2.
    await adapter.start(async () => {});
    simulateConnect();
    expect(runtime.publishes).toHaveLength(2);
    await adapter.stop();
  });

  test("runtime present but systemEventSource missing → silent + one-time warning", async () => {
    const runtime = makeRecordingRuntime();
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const { adapter, simulateConnect, simulateDisconnect } = makeAdapter({
        infra: { runtime }, // no systemEventSource
      });
      await adapter.start(async () => {});
      simulateDisconnect({ wasClean: false });
      simulateConnect();
      // First disconnect fires the warning; second wouldn't (latched).
      simulateDisconnect({ wasClean: false });
      expect(runtime.publishes).toHaveLength(0);
      expect(warnings.filter((w) => w.includes("systemEventSource is missing"))).toHaveLength(1);
      await adapter.stop();
    } finally {
      console.warn = originalWarn;
    }
  });
});
