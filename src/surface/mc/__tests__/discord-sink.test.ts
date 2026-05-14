/**
 * F-11 — `discord-sink.ts` integration tests with a fake DiscordNotifier.
 *
 * Covers Decision 6 (off-by-default), Decision 7 (dedup, coalesce,
 * channel throttle), Decision 5 (degradation when operatorDiscordId is
 * unset), and the audience-split invariant from Decision 2.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
} from "bun:test";
import {
  maybeNotifyDiscord,
  __resetDiscordSinkState,
  type DiscordNotifier,
  type DiscordSinkConfig,
  type FlushScheduler,
  type MaybeNotifyDeps,
  type NotificationContext,
} from "../notifications/discord-sink";
import type { BlockReason } from "../types";

/**
 * Test-only `FlushScheduler` that records every scheduled callback and lets
 * the test fire them synchronously via `flushAll()`. Replaces the previous
 * `await new Promise(r => setTimeout(r, 3_100))` pattern (S4 in PR #23
 * review) — five tests dropped from ~3 s wall-clock each to ~0 s.
 */
class FakeScheduler implements FlushScheduler {
  private nextHandle = 1;
  private pending = new Map<number, () => void>();
  schedule(cb: () => void): unknown {
    const handle = this.nextHandle++;
    this.pending.set(handle, cb);
    return handle;
  }
  cancel(handle: unknown): void {
    if (typeof handle === "number") this.pending.delete(handle);
  }
  /** Fire every pending callback. Returns the count fired. Awaitable so
   *  tests can `await` async send paths kicked off by the flush. */
  async flushAll(): Promise<number> {
    const cbs = [...this.pending.values()];
    this.pending.clear();
    for (const cb of cbs) cb();
    // The flush callbacks call `void flushDMBuffer(key)` /
    // `void flushChannelBuffer(channelId)` which run async. Yield once so
    // the awaited send paths land before the assertion.
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => setImmediate(r));
    return cbs.length;
  }
}

class FakeNotifier implements DiscordNotifier {
  dms: { userId: string; text: string }[] = [];
  channelMessages: { channelId: string; text: string }[] = [];
  failNextDM = false;
  failNextChannel = false;

  async sendDM(userId: string, text: string): Promise<void> {
    if (this.failNextDM) {
      this.failNextDM = false;
      throw new Error("DM forbidden");
    }
    this.dms.push({ userId, text });
  }
  async sendChannelMessage(channelId: string, text: string): Promise<void> {
    if (this.failNextChannel) {
      this.failNextChannel = false;
      throw new Error("channel send forbidden");
    }
    this.channelMessages.push({ channelId, text });
  }
}

const baseConfig: DiscordSinkConfig = {
  enabled: true,
  baseUrl: "https://grove.meta-factory.ai",
  operatorDiscordId: "OP_DISCORD_ID",
  operatorRoleId: "OP_ROLE_ID",
  fallbackChannelId: "CHANNEL_FALLBACK",
};

function ctx(overrides: Partial<NotificationContext> = {}): NotificationContext {
  return {
    assignmentId: "ata-1",
    agentName: "Luna",
    taskId: "01HZ123456",
    taskRef: "T-42",
    taskTitle: "fix webhook HMAC",
    priority: 1,
    taskSourceUrl: null,
    operatorId: "op-1",
    cycle: 3,
    observedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

const blockedToolError: BlockReason = {
  kind: "tool.error",
  payload: { tool_name: "bash", error_message: "exit 1" },
};
const blockedPermHigh: BlockReason = {
  kind: "permission.request",
  payload: { requested_action: "tool.bash", risk_hint: "high" },
};

describe("maybeNotifyDiscord — Decision 6 master toggle", () => {
  beforeEach(() => __resetDiscordSinkState());

  it("is a no-op when config.enabled is false", async () => {
    const notifier = new FakeNotifier();
    const deps: MaybeNotifyDeps = {
      config: { ...baseConfig, enabled: false },
      notifier,
    };
    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "blocked",
      blockReason: blockedToolError,
      ctx: ctx(),
    });
    expect(notifier.dms).toHaveLength(0);
    expect(notifier.channelMessages).toHaveLength(0);
  });
});

describe("maybeNotifyDiscord — Decision 1 silent transitions", () => {
  beforeEach(() => __resetDiscordSinkState());

  it("queued → dispatched produces no Discord traffic (loop double-fire absorbed)", async () => {
    const notifier = new FakeNotifier();
    const deps: MaybeNotifyDeps = { config: baseConfig, notifier };
    await maybeNotifyDiscord(deps, {
      from: "queued",
      to: "dispatched",
      blockReason: null,
      ctx: ctx(),
    });
    await maybeNotifyDiscord(deps, {
      from: "dispatched",
      to: "running",
      blockReason: null,
      ctx: ctx(),
    });
    expect(notifier.dms).toHaveLength(0);
    expect(notifier.channelMessages).toHaveLength(0);
  });
});

describe("maybeNotifyDiscord — Decision 2 audience split", () => {
  beforeEach(() => __resetDiscordSinkState());

  it("P1 tool.error → DM only (after coalesce flush)", async () => {
    const notifier = new FakeNotifier();
    const scheduler = new FakeScheduler();
    const deps: MaybeNotifyDeps = { config: baseConfig, notifier, scheduler };
    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "blocked",
      blockReason: blockedToolError,
      ctx: ctx(),
    });
    // Coalesce + channel-throttle windows fire via the injected scheduler.
    await scheduler.flushAll();
    expect(notifier.dms.length).toBe(1);
    expect(notifier.dms[0]!.userId).toBe("OP_DISCORD_ID");
    expect(notifier.dms[0]!.text).toContain("[P1-ERR] Luna blocked on T-42");
    expect(notifier.channelMessages).toHaveLength(0);
  });

  it("P0 + risk=high blocks → DM AND channel (with role ping)", async () => {
    const notifier = new FakeNotifier();
    const scheduler = new FakeScheduler();
    const deps: MaybeNotifyDeps = { config: baseConfig, notifier, scheduler };
    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "blocked",
      blockReason: blockedPermHigh,
      ctx: ctx({ priority: 0 }),
    });
    // Both DM and channel buffers are armed but not yet flushed (post-W1
    // fix: channel posts go through a coalesce buffer too).
    expect(notifier.channelMessages).toHaveLength(0);
    expect(notifier.dms).toHaveLength(0);

    await scheduler.flushAll();
    // Now both surfaces have fired exactly once.
    expect(notifier.channelMessages).toHaveLength(1);
    expect(notifier.channelMessages[0]!.text.startsWith("<@&OP_ROLE_ID>")).toBe(true);
    expect(notifier.channelMessages[0]!.text).toContain("[P0-HIGH]");
    expect(notifier.dms).toHaveLength(1);
    expect(notifier.dms[0]!.text).toContain("[P0-HIGH]");
  });
});

describe("maybeNotifyDiscord — Decision 7 per-assignment dedup (5 s window)", () => {
  beforeEach(() => __resetDiscordSinkState());

  it("same-assignment back-to-back blocks (same toState + kind) suppress the second", async () => {
    const notifier = new FakeNotifier();
    const scheduler = new FakeScheduler();
    let nowMs = 1_700_000_000_000;
    const deps: MaybeNotifyDeps = {
      config: baseConfig,
      notifier,
      now: () => nowMs,
      scheduler,
    };
    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "blocked",
      blockReason: blockedToolError,
      ctx: ctx(),
    });
    nowMs += 1_000;
    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "blocked",
      blockReason: blockedToolError,
      ctx: ctx(),
    });
    await scheduler.flushAll();
    // Only one DM landed because the second was deduped within the 5 s
    // window (same assignment, same toState, same block-reason kind).
    expect(notifier.dms.length).toBe(1);
  });

  // Regression for S2 (PR #23 review): the dedup key narrowed from
  // assignmentId alone to (assignmentId, toState, blockReason.kind), so a
  // `blocked` followed by a real `failed` for the same assignment within
  // the 5 s window must NOT be silenced. We probe the DM surface (which
  // has its own per-operator coalesce buffer) because the channel-side
  // coalesce buffer would collapse the two events into one summary by
  // design — the dedup-key narrowing is what lets the *failed* event
  // reach the buffer at all.
  it("same-assignment blocked → failed within 5 s does NOT suppress the failed (DM surface)", async () => {
    const notifier = new FakeNotifier();
    const scheduler = new FakeScheduler();
    let nowMs = 1_700_000_000_000;
    const deps: MaybeNotifyDeps = {
      config: baseConfig,
      notifier,
      now: () => nowMs,
      scheduler,
    };
    // First: P0 + tool.error blocked → DM + channel audiences. DM only
    // (no fan-out) for clarity below — use a P1 perm-request instead so
    // the DM buffer gets exactly one entry from the blocked event.
    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "blocked",
      blockReason: { kind: "permission.request", payload: { requested_action: "tool.bash" } },
      ctx: ctx({ priority: 1 }),
    });
    nowMs += 3_000; // still inside the 5 s dedup window
    // Second: P1 failed → channel audience only (no DM). Different
    // toState → different dedup key → must reach the channel buffer.
    await maybeNotifyDiscord(deps, {
      from: "blocked",
      to: "failed",
      blockReason: null,
      ctx: ctx({ priority: 1 }),
    });
    await scheduler.flushAll();
    // The blocked event flushed as a single-event DM (its dedup key is
    // distinct from the failed event's, so neither was silenced).
    expect(notifier.dms.length).toBe(1);
    expect(notifier.dms[0]!.text).toContain("[P1] Luna blocked on T-42");
    // The failed event reached the channel buffer (the bug being
    // regressed: under the old assignmentId-only key it would have been
    // dedup-silenced because the blocked event had already touched the
    // dedup map with the same assignmentId).
    expect(notifier.channelMessages.length).toBe(1);
    expect(notifier.channelMessages[0]!.text).toContain("failed");
  });

  // Regression for S2: same toState repeated within the window with the
  // SAME block-reason kind is still deduped (the original behaviour).
  it("same-assignment blocked (same kind) twice within 5 s suppresses the second", async () => {
    const notifier = new FakeNotifier();
    const scheduler = new FakeScheduler();
    let nowMs = 1_700_000_000_000;
    const deps: MaybeNotifyDeps = {
      config: baseConfig,
      notifier,
      now: () => nowMs,
      scheduler,
    };
    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "blocked",
      blockReason: blockedToolError,
      ctx: ctx(),
    });
    nowMs += 1_000;
    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "blocked",
      blockReason: blockedToolError,
      ctx: ctx(),
    });
    await scheduler.flushAll();
    expect(notifier.dms.length).toBe(1);
  });
});

describe("maybeNotifyDiscord — Decision 7 per-operator coalescing (3 s window)", () => {
  beforeEach(() => __resetDiscordSinkState());

  it("two distinct assignments for the same operator collapse into one summary DM", async () => {
    const notifier = new FakeNotifier();
    const scheduler = new FakeScheduler();
    const deps: MaybeNotifyDeps = { config: baseConfig, notifier, scheduler };

    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "blocked",
      blockReason: blockedToolError,
      ctx: ctx({ assignmentId: "ata-A", taskRef: "T-42" }),
    });
    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "blocked",
      blockReason: blockedToolError,
      ctx: ctx({ assignmentId: "ata-B", taskRef: "T-43" }),
    });

    await scheduler.flushAll();
    expect(notifier.dms.length).toBe(1);
    const text = notifier.dms[0]!.text;
    expect(text).toContain("2 agents blocked");
    expect(text).toContain("T-42");
    expect(text).toContain("T-43");
  });

  it("a single event flushes as the original DM body, not a coalesced summary", async () => {
    const notifier = new FakeNotifier();
    const scheduler = new FakeScheduler();
    const deps: MaybeNotifyDeps = { config: baseConfig, notifier, scheduler };
    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "blocked",
      blockReason: blockedToolError,
      ctx: ctx(),
    });
    await scheduler.flushAll();
    expect(notifier.dms.length).toBe(1);
    // Single-event payload has the cycle line; the coalesced summary does not.
    expect(notifier.dms[0]!.text).toContain("Cycle 3");
    expect(notifier.dms[0]!.text).not.toContain("agents blocked");
  });
});

// W1 (PR #23 review) — channel-throttle now coalesces per Decision 7's
// "collapse to one summary post" rule. Five P0 failures within 10 s = one
// summary channel post, not five posts with "(+N similar)" suffixes.
describe("maybeNotifyDiscord — Decision 7 channel-throttle coalescing (10 s window)", () => {
  beforeEach(() => __resetDiscordSinkState());

  it("five distinct P0 failures within 10 s collapse into one summary channel post", async () => {
    const notifier = new FakeNotifier();
    const scheduler = new FakeScheduler();
    const deps: MaybeNotifyDeps = { config: baseConfig, notifier, scheduler };

    for (let i = 0; i < 5; i++) {
      await maybeNotifyDiscord(deps, {
        from: "running",
        to: "failed",
        blockReason: null,
        ctx: ctx({
          assignmentId: `ata-${i}`,
          taskRef: `T-${100 + i}`,
          priority: 0,
        }),
      });
    }

    // Nothing fired yet — the channel-throttle window is armed and waiting.
    expect(notifier.channelMessages).toHaveLength(0);
    await scheduler.flushAll();
    // Exactly one summary post.
    expect(notifier.channelMessages).toHaveLength(1);
    const text = notifier.channelMessages[0]!.text;
    expect(text).toContain("5 agents blocked");
    // The summary references every distinct task.
    for (let i = 0; i < 5; i++) {
      expect(text).toContain(`T-${100 + i}`);
    }
    // The "(+N similar in last 10 s — see dashboard)" suffix is GONE —
    // we render the canonical coalesced shape now.
    expect(text).not.toContain("similar in last");
  });

  it("a single channel post within the window flushes as the original payload", async () => {
    const notifier = new FakeNotifier();
    const scheduler = new FakeScheduler();
    const deps: MaybeNotifyDeps = { config: baseConfig, notifier, scheduler };
    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "failed",
      blockReason: null,
      ctx: ctx({ priority: 0 }),
    });
    await scheduler.flushAll();
    expect(notifier.channelMessages).toHaveLength(1);
    expect(notifier.channelMessages[0]!.text).toContain("[P0-ERR]");
    expect(notifier.channelMessages[0]!.text).not.toContain("agents blocked");
  });
});

describe("maybeNotifyDiscord — Decision 5 degradation", () => {
  beforeEach(() => __resetDiscordSinkState());

  it("DM-class notification falls through to channel when operatorDiscordId is unset", async () => {
    const notifier = new FakeNotifier();
    const scheduler = new FakeScheduler();
    const deps: MaybeNotifyDeps = {
      config: { ...baseConfig, operatorDiscordId: undefined },
      notifier,
      scheduler,
    };
    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "blocked",
      blockReason: blockedToolError,
      ctx: ctx(),
    });
    await scheduler.flushAll();
    expect(notifier.dms).toHaveLength(0);
    expect(notifier.channelMessages).toHaveLength(1);
    expect(notifier.channelMessages[0]!.channelId).toBe("CHANNEL_FALLBACK");
    expect(notifier.channelMessages[0]!.text).toContain(
      "operatorDiscordId unset"
    );
  });

  it("renders a baseUrl warning when grove.baseUrl is empty", async () => {
    const notifier = new FakeNotifier();
    const scheduler = new FakeScheduler();
    const deps: MaybeNotifyDeps = {
      config: { ...baseConfig, baseUrl: "" },
      notifier,
      scheduler,
    };
    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "blocked",
      blockReason: blockedPermHigh,
      ctx: ctx({ priority: 0 }),
    });
    await scheduler.flushAll();
    expect(notifier.channelMessages).toHaveLength(1);
    expect(notifier.channelMessages[0]!.text).toContain(
      "Deep link unavailable"
    );
  });

  it("omits role ping markup when operatorRoleId is unset", async () => {
    const notifier = new FakeNotifier();
    const scheduler = new FakeScheduler();
    const deps: MaybeNotifyDeps = {
      config: { ...baseConfig, operatorRoleId: undefined },
      notifier,
      scheduler,
    };
    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "failed",
      blockReason: null,
      ctx: ctx({ priority: 0 }),
    });
    await scheduler.flushAll();
    expect(notifier.channelMessages).toHaveLength(1);
    expect(notifier.channelMessages[0]!.text.startsWith("<@&")).toBe(false);
    expect(notifier.channelMessages[0]!.text).toContain("[P0-ERR]");
  });
});

describe("maybeNotifyDiscord — Decision 9 best-effort error handling", () => {
  beforeEach(() => __resetDiscordSinkState());

  it("a Discord-API failure on channel send is caught and surfaced", async () => {
    const notifier = new FakeNotifier();
    notifier.failNextChannel = true;
    const errors: string[] = [];
    const scheduler = new FakeScheduler();
    const deps: MaybeNotifyDeps = {
      config: baseConfig,
      notifier,
      onSystemError: (msg) => errors.push(msg),
      scheduler,
    };
    // Direct channel-only path: P0 failed.
    await maybeNotifyDiscord(deps, {
      from: "running",
      to: "failed",
      blockReason: null,
      ctx: ctx({ priority: 0 }),
    });
    await scheduler.flushAll();
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("sendChannelMessage failed");
  });
});
