import { describe, expect, mock, test } from "bun:test";
import type { Consumer, ConsumerMessages, JsMsg, NatsConnection, Subscription } from "nats";
import { MyelinSubscriber, type EnvelopeHandler } from "../subscriber";
import { NatsLink } from "../../nats/connection";
import validEnvelope from "../vendor/__fixtures__/valid-envelope.json" with { type: "json" };

const SUBJECT = "local.acme.deploy";
const PAYLOAD = new TextEncoder().encode(JSON.stringify(validEnvelope));

function makeFakeJsMsg() {
  return {
    subject: SUBJECT,
    data: PAYLOAD,
    ack: mock(() => {}),
    nak: mock((_millis?: number) => {}),
    term: mock((_reason?: string) => {}),
    working: mock(() => {}),
  };
}
type FakeJsMsg = ReturnType<typeof makeFakeJsMsg>;

async function flush(times = 16) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function makePullLink() {
  const queue: FakeJsMsg[] = [];
  let waiter: ((m: FakeJsMsg | null) => void) | null = null;
  let closed = false;
  const messages = {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<FakeJsMsg>> {
        const queued = queue.shift();
        if (queued) return { value: queued, done: false };
        if (closed) return { value: undefined!, done: true };
        const next = await new Promise<FakeJsMsg | null>((r) => {
          waiter = r;
        });
        return next ? { value: next, done: false } : { value: undefined!, done: true };
      },
    }),
    close: mock(async () => {
      closed = true;
      waiter?.(null);
    }),
  } as unknown as ConsumerMessages;
  const consumer = { consume: mock(async () => messages) } as unknown as Consumer;
  const fakeNc = {
    status: () => (async function* () {})(),
    subscribe: mock(() => {
      throw new Error("pull mode must not call subscribe");
    }),
    drain: mock(async () => {}),
    jetstream: mock(() => ({ consumers: { get: mock(async () => consumer) } })),
  } as unknown as NatsConnection;
  const link = await NatsLink.connect({
    url: "nats://localhost:4222",
    name: "working-ctx-pull",
    connectImpl: async () => fakeNc,
  });
  return {
    link,
    deliver: (m: FakeJsMsg) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(m);
      } else queue.push(m);
    },
  };
}

function startPull(
  link: NatsLink,
  onEnvelope: EnvelopeHandler,
  maxConcurrent?: number,
) {
  return MyelinSubscriber.start(link, {
    pattern: "local.acme.>",
    mode: "pull",
    pull: { stream: "ACME_TASKS", durable: "working-ctx", maxConcurrent },
    onEnvelope,
  });
}

describe("EnvelopeHandlerContext.working()", () => {
  test("pull: each call sends one JsMsg.working() for that message", async () => {
    const { link, deliver } = await makePullLink();
    const msg = makeFakeJsMsg();
    const sub = startPull(link, (_env, _subject, ctx) => {
      ctx.working();
      ctx.working();
      ctx.working();
    });
    await sub.ready;
    deliver(msg);
    await flush();
    expect(msg.working).toHaveBeenCalledTimes(3);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    await sub.stop();
    await link.close();
  });

  test("pull: working() reaches only the message being handled", async () => {
    const { link, deliver } = await makePullLink();
    const first = makeFakeJsMsg();
    const second = makeFakeJsMsg();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const sub = startPull(
      link,
      async (_env, _subject, ctx) => {
        calls += 1;
        if (calls === 1) {
          await gate;
          return;
        }
        ctx.working();
      },
      2,
    );
    await sub.ready;
    deliver(first);
    deliver(second);
    await flush();
    expect(second.working).toHaveBeenCalledTimes(1);
    expect(first.working).not.toHaveBeenCalled();
    release();
    await flush();
    await sub.stop();
    await link.close();
  });

  test.each([
    { outcome: "returns", settled: "ack", handler: (): void => undefined },
    {
      outcome: "throws",
      settled: "nak",
      handler: (): void => {
        throw new Error("boom");
      },
    },
  ] as const)("pull: working() after the handler $outcome is a no-op", async ({ settled, handler }) => {
    const { link, deliver } = await makePullLink();
    const msg = makeFakeJsMsg();
    let captured: { working(): void } | undefined;
    const orig = console.error;
    console.error = mock(() => {});
    const sub = startPull(link, (_env, _subject, ctx) => {
      captured = ctx;
      handler();
    });
    await sub.ready;
    deliver(msg);
    await flush();
    console.error = orig;
    expect(msg[settled]).toHaveBeenCalledTimes(1);
    captured?.working();
    expect(msg.working).not.toHaveBeenCalled();
    await sub.stop();
    await link.close();
  });

  test("pull: a throwing JsMsg.working() does not fail the handler", async () => {
    const { link, deliver } = await makePullLink();
    const msg = makeFakeJsMsg();
    msg.working.mockImplementation(() => {
      throw new Error("conn closed");
    });
    const orig = console.error;
    console.error = mock(() => {});
    const sub = startPull(link, (_env, _subject, ctx) => {
      ctx.working();
    });
    await sub.ready;
    deliver(msg);
    await flush();
    console.error = orig;
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.nak).not.toHaveBeenCalled();
    await sub.stop();
    await link.close();
  });

  test("two-argument handlers behave unchanged", async () => {
    const { link, deliver } = await makePullLink();
    const msg = makeFakeJsMsg();
    const seen: string[] = [];
    const sub = startPull(link, (env, subject) => {
      seen.push(`${env.type}@${subject}`);
    });
    await sub.ready;
    deliver(msg);
    await flush();
    expect(seen).toEqual([`${validEnvelope.type}@${SUBJECT}`]);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.working).not.toHaveBeenCalled();
    await sub.stop();
    await link.close();
  });

  test("push: working() is a no-op and does not throw", async () => {
    const queue: { subject: string; data: Uint8Array }[] = [];
    let waiter: ((m: { subject: string; data: Uint8Array } | null) => void) | null = null;
    let drained = false;
    const iterator = (async function* () {
      while (true) {
        const queued = queue.shift();
        if (queued) {
          yield queued;
          continue;
        }
        if (drained) return;
        const next = await new Promise<{ subject: string; data: Uint8Array } | null>((r) => {
          waiter = r;
        });
        if (next === null) return;
        yield next;
      }
    })();
    const push = (subject: string, data: Uint8Array) => {
      const m = { subject, data };
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(m);
      } else queue.push(m);
    };
    const sub = {
      [Symbol.asyncIterator]: () => iterator,
      drain: mock(async () => {
        drained = true;
        waiter?.(null);
      }),
      closed: Promise.resolve(),
    } as unknown as Subscription;
    const fakeNc = {
      status: () => (async function* () {})(),
      subscribe: mock(() => sub),
      drain: mock(async () => {}),
    } as unknown as NatsConnection;
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      name: "working-ctx-push",
      connectImpl: async () => fakeNc,
    });
    let outcome = "not called";
    const subscriber = MyelinSubscriber.start(link, {
      pattern: "local.acme.>",
      onEnvelope: (_env, _subject, ctx) => {
        ctx.working();
        outcome = "returned";
      },
    });
    await flush();
    push(SUBJECT, PAYLOAD);
    await flush();
    expect(outcome).toBe("returned");
    await subscriber.stop();
    await link.close();
  });
});
