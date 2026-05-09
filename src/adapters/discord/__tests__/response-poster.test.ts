import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { postToDiscord, splitMessage } from "../response-poster";

let originalWarn: typeof console.warn;
beforeEach(() => {
  originalWarn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  console.warn = originalWarn;
});

interface SendCall { content: string; files?: unknown }

function fakeChannel(opts: { failTimes: number; status?: number; code?: string }) {
  let calls = 0;
  const sends: SendCall[] = [];
  const channel = {
    id: "C1",
    send: async (payload: SendCall) => {
      calls++;
      if (calls <= opts.failTimes) {
        const e = new Error(`mock fail #${calls}`) as Error & { status?: number; code?: string };
        if (opts.status) e.status = opts.status;
        if (opts.code) e.code = opts.code;
        throw e;
      }
      sends.push(payload);
      return { id: `m-${calls}` } as any;
    },
  } as any;
  return { channel, getCalls: () => calls, getSends: () => sends };
}

describe("postToDiscord retry behavior", () => {
  test("succeeds when first attempt succeeds", async () => {
    const { channel, getCalls, getSends } = fakeChannel({ failTimes: 0 });
    await postToDiscord(channel, "hello");
    expect(getCalls()).toBe(1);
    expect(getSends()[0]?.content).toBe("hello");
  });

  test("retries on Discord 5xx and eventually succeeds", async () => {
    const { channel, getCalls } = fakeChannel({ failTimes: 2, status: 503 });
    await postToDiscord(channel, "hello", undefined, {
      sleep: async () => {},
      maxAttempts: 3,
    });
    expect(getCalls()).toBe(3);
  });

  test("retries on network ECONNRESET", async () => {
    const { channel, getCalls } = fakeChannel({ failTimes: 1, code: "ECONNRESET" });
    await postToDiscord(channel, "hello", undefined, { sleep: async () => {} });
    expect(getCalls()).toBe(2);
  });

  test("does NOT retry on 4xx (DiscordAPIError-like)", async () => {
    const { channel, getCalls } = fakeChannel({ failTimes: 1, status: 403 });
    await expect(
      postToDiscord(channel, "hello", undefined, { sleep: async () => {} }),
    ).rejects.toThrow("mock fail #1");
    expect(getCalls()).toBe(1);
  });

  test("gives up after maxAttempts on persistent 5xx", async () => {
    const { channel, getCalls } = fakeChannel({ failTimes: 5, status: 502 });
    await expect(
      postToDiscord(channel, "hello", undefined, { sleep: async () => {}, maxAttempts: 3 }),
    ).rejects.toThrow();
    expect(getCalls()).toBe(3);
  });

  test("splitMessage still respected — multiple chunks each get their own retry budget", async () => {
    // Build content that splits into 2 chunks (>2000 chars)
    const big = "a\n".repeat(1100);
    const chunks = splitMessage(big);
    expect(chunks.length).toBeGreaterThan(1);
    const { channel, getCalls } = fakeChannel({ failTimes: 0 });
    await postToDiscord(channel, big, undefined, { sleep: async () => {} });
    expect(getCalls()).toBe(chunks.length);
  });
});
