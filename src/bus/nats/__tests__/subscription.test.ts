/**
 * G-1100.C: nats-subscription tests.
 *
 * Drives the subscription primitive against a fake NatsLink whose `.raw`
 * is a minimal in-memory NATS-shaped fake. No real NATS server.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NatsConnection, Subscription, Status } from "nats";
import { Events } from "nats";
import { NatsSubscription } from "../subscription";
import { NatsLink } from "../connection";

/**
 * Build a fake Subscription that exposes a `push(subject, data)` test seam,
 * a `drain()` mock, and an async-iterator that yields whatever's been pushed
 * (until drained).
 */
function makeFakeSubscription() {
  type Msg = { subject: string; data: Uint8Array };
  const queue: Msg[] = [];
  let waiter: ((m: Msg | null) => void) | null = null;
  let drained = false;

  const iterator = (async function* () {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (drained) return;
      const next = await new Promise<Msg | null>((resolve) => {
        waiter = resolve;
      });
      if (next === null) return;
      yield next;
    }
  })();

  const drain = mock(async () => {
    drained = true;
    waiter?.(null);
  });

  const sub = {
    [Symbol.asyncIterator]: () => iterator,
    drain,
    closed: Promise.resolve(),
  } as unknown as Subscription;

  return {
    sub,
    push: (subject: string, data: Uint8Array) => {
      const msg = { subject, data };
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(msg);
      } else {
        queue.push(msg);
      }
    },
    drain,
  };
}

/** Fake NatsConnection that hands out fake subscriptions and a multi-consumer
 *  status stream. Each `status()` call returns a new iterator so multiple
 *  consumers (NatsLink + NatsSubscription) can both observe events — matching
 *  the real nats.js behaviour.
 */
function makeFakeConnection() {
  const subs: ReturnType<typeof makeFakeSubscription>[] = [];
  const listeners = new Set<(s: Status | null) => void>();
  let closed = false;

  const status = () =>
    (async function* () {
      // Each consumer gets its own queue so multi-consumer iteration works.
      const queue: (Status | null)[] = [];
      let waiter: ((s: Status | null) => void) | null = null;
      const listener = (s: Status | null) => {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w(s);
        } else {
          queue.push(s);
        }
      };
      listeners.add(listener);
      try {
        while (true) {
          if (queue.length > 0) {
            const next = queue.shift()!;
            if (next === null) return;
            yield next;
            continue;
          }
          if (closed) return;
          const next = await new Promise<Status | null>((r) => (waiter = r));
          if (next === null) return;
          yield next;
        }
      } finally {
        listeners.delete(listener);
      }
    })();

  const subscribe = mock((_pattern: string) => {
    const fake = makeFakeSubscription();
    subs.push(fake);
    return fake.sub;
  });

  const drain = mock(async () => {
    closed = true;
    for (const l of listeners) l(null);
  });

  const fakeNc = {
    status,
    subscribe,
    drain,
  } as unknown as NatsConnection;

  return {
    nc: fakeNc,
    subAt: (i: number) => subs[i],
    pushStatus: (s: Status) => {
      for (const l of listeners) l(s);
    },
    subscribe,
    drain,
  };
}

/** Build a NatsLink wrapping a fake connection. */
async function makeLink() {
  const fake = makeFakeConnection();
  const link = await NatsLink.connect({
    url: "nats://localhost:4222",
    name: "subscription-test",
    connectImpl: (async () => fake.nc) as never,
  });
  return { link, fake };
}

/** Yield to microtask queue several times so async iterators can advance. */
async function flushMicrotasks(times = 4) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe("NatsSubscription", () => {
  let originalConsole: typeof console.error;
  beforeEach(() => {
    originalConsole = console.error;
    console.error = mock(() => {});
  });
  afterEach(() => {
    console.error = originalConsole;
  });

  test("requires a pattern", async () => {
    const { link } = await makeLink();
    expect(() =>
      NatsSubscription.start(link, {
        pattern: "",
        onMessage: () => {},
      }),
    ).toThrow(/pattern is required/);
    await link.close();
  });

  test("subscribes to the requested pattern", async () => {
    const { link, fake } = await makeLink();
    const sub = NatsSubscription.start(link, {
      pattern: "local.acme.>",
      onMessage: () => {},
    });
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    expect(fake.subscribe.mock.calls[0]?.[0]).toBe("local.acme.>");
    await sub.stop();
    await link.close();
  });

  test("delivers messages to onMessage", async () => {
    const { link, fake } = await makeLink();
    const received: { subject: string; data: string }[] = [];
    const sub = NatsSubscription.start(link, {
      pattern: "local.acme.>",
      onMessage: (subject, data) => {
        received.push({ subject, data: new TextDecoder().decode(data) });
      },
    });
    fake.subAt(0)!.push("local.acme.test", new TextEncoder().encode("hello"));
    await flushMicrotasks(8);
    expect(received).toEqual([{ subject: "local.acme.test", data: "hello" }]);
    await sub.stop();
    await link.close();
  });

  test("handler error routes through onError, doesn't kill the loop", async () => {
    const { link, fake } = await makeLink();
    const errors: { msg: string; subject: string }[] = [];
    const handled: string[] = [];
    const sub = NatsSubscription.start(link, {
      pattern: "local.acme.>",
      onMessage: (subject, data) => {
        if (new TextDecoder().decode(data) === "boom") throw new Error("test boom");
        handled.push(subject);
      },
      onError: (err, subject) => errors.push({ msg: err.message, subject }),
    });
    fake.subAt(0)!.push("local.acme.first", new TextEncoder().encode("ok"));
    fake.subAt(0)!.push("local.acme.second", new TextEncoder().encode("boom"));
    fake.subAt(0)!.push("local.acme.third", new TextEncoder().encode("ok"));
    await flushMicrotasks(16);
    expect(handled).toEqual(["local.acme.first", "local.acme.third"]);
    expect(errors).toEqual([{ msg: "test boom", subject: "local.acme.second" }]);
    await sub.stop();
    await link.close();
  });

  test("re-subscribes on Reconnect event", async () => {
    const { link, fake } = await makeLink();
    const sub = NatsSubscription.start(link, {
      pattern: "local.acme.>",
      onMessage: () => {},
    });
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    fake.pushStatus({ type: Events.Reconnect, data: "nats://localhost:4222" } as Status);
    await flushMicrotasks(8);
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
    expect(fake.subscribe.mock.calls[1]?.[0]).toBe("local.acme.>");
    await sub.stop();
    await link.close();
  });

  test("stop() drains the subscription (idempotent)", async () => {
    const { link, fake } = await makeLink();
    const sub = NatsSubscription.start(link, {
      pattern: "local.acme.>",
      onMessage: () => {},
    });
    await sub.stop();
    await sub.stop();
    expect(fake.subAt(0)!.drain).toHaveBeenCalledTimes(1);
    await link.close();
  });

  test("after reconnect, old subscription is orphaned (no delivery)", async () => {
    const { link, fake } = await makeLink();
    const received: string[] = [];
    const sub = NatsSubscription.start(link, {
      pattern: "local.acme.>",
      onMessage: (subject) => {
        received.push(subject);
      },
    });
    fake.pushStatus({ type: Events.Reconnect, data: "nats://localhost:4222" } as Status);
    await flushMicrotasks(8);
    // Old subscription (subAt 0) — pushing into it must NOT reach the
    // active onMessage since the consume loop reading it has exited.
    fake.subAt(0)!.push("local.acme.old", new TextEncoder().encode("orphan"));
    await flushMicrotasks(8);
    expect(received).toEqual([]);
    await sub.stop();
    await link.close();
  });

  test("after reconnect, new subscription delivers messages", async () => {
    const { link, fake } = await makeLink();
    const received: string[] = [];
    const sub = NatsSubscription.start(link, {
      pattern: "local.acme.>",
      onMessage: (subject) => {
        received.push(subject);
      },
    });
    fake.pushStatus({ type: Events.Reconnect, data: "nats://localhost:4222" } as Status);
    await flushMicrotasks(8);
    // New subscription (subAt 1) — pushing into it MUST reach onMessage.
    fake.subAt(1)!.push("local.acme.new", new TextEncoder().encode("fresh"));
    await flushMicrotasks(8);
    expect(received).toEqual(["local.acme.new"]);
    await sub.stop();
    await link.close();
  });

  test("a thrown onError sink does not kill delivery", async () => {
    const { link, fake } = await makeLink();
    const handled: string[] = [];
    const sub = NatsSubscription.start(link, {
      pattern: "local.acme.>",
      onMessage: (subject, data) => {
        if (new TextDecoder().decode(data) === "boom") throw new Error("handler boom");
        handled.push(subject);
      },
      onError: () => {
        // Pathological sink that always throws.
        throw new Error("sink boom");
      },
    });
    fake.subAt(0)!.push("local.acme.before", new TextEncoder().encode("ok"));
    fake.subAt(0)!.push("local.acme.boom", new TextEncoder().encode("boom"));
    fake.subAt(0)!.push("local.acme.after", new TextEncoder().encode("ok"));
    await flushMicrotasks(16);
    // Loop must keep delivering messages despite the bad sink.
    expect(handled).toEqual(["local.acme.before", "local.acme.after"]);
    await sub.stop();
    await link.close();
  });

  test("subscribe failure on reconnect logs error, no spurious 're-subscribed'", async () => {
    const { link, fake } = await makeLink();
    // Replace subscribe with one that throws on the SECOND call (reconnect path).
    let callCount = 0;
    const realSubscribe = fake.nc.subscribe;
    (fake.nc as { subscribe: typeof realSubscribe }).subscribe = ((
      ...args: Parameters<typeof realSubscribe>
    ) => {
      callCount++;
      if (callCount === 2) throw new Error("auth revoked between disconnect and reconnect");
      return realSubscribe(...args);
    }) as typeof realSubscribe;

    const errors: string[] = [];
    const infos: string[] = [];
    const origError = console.error;
    const origInfo = console.info;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    };
    console.info = (...args: unknown[]) => {
      infos.push(args.map((a) => String(a)).join(" "));
    };

    const sub = NatsSubscription.start(link, {
      pattern: "local.acme.>",
      onMessage: () => {},
    });
    fake.pushStatus({ type: Events.Reconnect, data: "nats://localhost:4222" } as Status);
    await flushMicrotasks(8);

    console.error = origError;
    console.info = origInfo;

    // Subscribe-failed branch: expect the failure log AND no 're-subscribed' info log.
    const failureLogged = errors.some((e) => e.includes("subscribe failed"));
    const spuriousReSub = infos.some((i) => i.includes("re-subscribed after reconnect"));
    expect(failureLogged).toBe(true);
    expect(spuriousReSub).toBe(false);

    await sub.stop();
    await link.close();
  });

  test("rejects a whitespace-only pattern", async () => {
    const { link } = await makeLink();
    expect(() =>
      NatsSubscription.start(link, {
        pattern: "   ",
        onMessage: () => {},
      }),
    ).toThrow(/non-empty/);
    await link.close();
  });
});
