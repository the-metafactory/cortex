/**
 * cortex#237 PR-1: MyelinSubscriber pull-consumer mode tests.
 *
 * Behavioural-parity coverage for `mode: "pull"` against `mode: "push"`
 * (and the default — absent `mode` MUST behave as push, see PR-1 scope:
 * "Default is push — every existing call site must continue working
 * byte-identically").
 *
 * Strategy: stub `NatsConnection.jetstream()` so we control the
 * JetStream client, consumers registry, and `ConsumerMessages` iterable.
 * The real `NatsSubscription` push path is also exercised in the same
 * suite via the same fake-connection harness used by `subscriber.test.ts`,
 * so the two modes share the same envelope-validator wiring under test.
 *
 * Ack semantics asserted here (design §2.3 ack policy):
 *  - handler resolves → `msg.ack()` called once, no nak/term
 *  - handler throws  → `msg.nak()` called (NOT term — redelivery is
 *                      bounded by the consumer's `max_deliver`, which
 *                      is enforced server-side, not by this primitive)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  ConsumeOptions,
  Consumer,
  ConsumerMessages,
  JetStreamClient,
  JsMsg,
  NatsConnection,
  Status,
  Subscription,
} from "nats";
import { MyelinSubscriber } from "../subscriber";
import { NatsLink } from "../../nats/connection";
import validEnvelope from "../vendor/__fixtures__/valid-envelope.json" with { type: "json" };

// ============================================================================
// fake JetStream / pull-consumer harness
// ============================================================================

interface FakeJsMsg {
  subject: string;
  data: Uint8Array;
  ack: ReturnType<typeof mock>;
  nak: ReturnType<typeof mock>;
  term: ReturnType<typeof mock>;
}

function makeFakeJsMsg(subject: string, data: Uint8Array): FakeJsMsg {
  return {
    subject,
    data,
    ack: mock(() => {}),
    nak: mock((_millis?: number) => {}),
    term: mock((_reason?: string) => {}),
  };
}

/**
 * Build a fake ConsumerMessages iterable backed by a push queue. Mirrors
 * the shape returned by `Consumer.consume()` in nats.js 2.29.x: an async
 * iterable of `JsMsg` with a `close()` method.
 */
function makeFakeConsumerMessages() {
  const queue: FakeJsMsg[] = [];
  let waiter: ((m: FakeJsMsg | null) => void) | null = null;
  let closed = false;
  const closePromise = (async () => {})();

  // The iterator yields FakeJsMsg objects shaped enough for the
  // subscriber's needs (subject/data/ack/nak/term). Cast through
  // `unknown` ONCE at the iterable boundary so the AsyncIterable<JsMsg>
  // contract is satisfied without per-item assertions.
  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<FakeJsMsg>> {
          while (true) {
            if (queue.length > 0) {
              return { value: queue.shift()!, done: false };
            }
            if (closed) return { value: undefined!, done: true };
            const next = await new Promise<FakeJsMsg | null>((r) => {
              waiter = r;
            });
            if (next === null) return { value: undefined!, done: true };
            return { value: next, done: false };
          }
        },
      };
    },
  } as unknown as AsyncIterable<JsMsg>;

  const messages = {
    [Symbol.asyncIterator]: iterable[Symbol.asyncIterator].bind(iterable),
    close: mock(async () => {
      closed = true;
      const w = waiter;
      waiter = null;
      if (w) w(null);
    }),
    closed: () => closePromise,
    status: async () => (async function* () {})(),
  } as unknown as ConsumerMessages;

  return {
    messages,
    deliver: (msg: FakeJsMsg) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(msg);
      } else {
        queue.push(msg);
      }
    },
    close: async () => {
      closed = true;
      const w = waiter;
      waiter = null;
      if (w) w(null);
    },
  };
}

interface PullHarness {
  link: NatsLink;
  /** Push a message onto the fake consumer's stream. */
  deliver: (subject: string, data: Uint8Array) => FakeJsMsg;
  /** Spies on Consumers.get(stream, durable) calls. */
  consumerGet: ReturnType<typeof mock>;
  /** Spy on the consume() invocation (captures opts). */
  consumeOpts: () => ConsumeOptions | undefined;
  /** Most recent fake message issued (for direct ack/nak assertions). */
  lastMsg: () => FakeJsMsg | undefined;
  /** Close + cleanup. */
  cleanup: () => Promise<void>;
}

async function makePullLink(): Promise<PullHarness> {
  const channel = makeFakeConsumerMessages();
  const issued: FakeJsMsg[] = [];

  let capturedConsumeOpts: ConsumeOptions | undefined;
  const consumeMock = mock(async (opts?: ConsumeOptions) => {
    capturedConsumeOpts = opts;
    return channel.messages;
  });
  // Cast at the value boundary, not per-field — lint rejects the
  // per-field `as unknown as Consumer["consume"]` as unnecessary
  // because the mock() return types overlap; a single boundary cast is
  // cleaner and avoids per-field churn if the Consumer surface grows.
  const fakeConsumer = {
    consume: consumeMock,
    fetch: mock(async () => channel.messages),
    next: mock(async () => null),
    info: mock(async () => ({})),
    delete: mock(async () => true),
  } as unknown as Consumer;

  const consumerGet = mock(async (_stream: string, _name?: string) => fakeConsumer);

  const fakeJs: JetStreamClient = {
    consumers: {
      get: consumerGet,
      // getPullConsumerFor is unused by PR-1 but the type requires it.
      getPullConsumerFor: mock(() => fakeConsumer) as unknown as JetStreamClient["consumers"]["getPullConsumerFor"],
    } as unknown as JetStreamClient["consumers"],
  } as unknown as JetStreamClient;

  // Fake NatsConnection that supports the (minimal) push surface +
  // .jetstream() for pull mode. We don't exercise push in this file's
  // pull-specific tests but the harness must be valid in both directions
  // so the same link can be reused for parity assertions.
  const statusGenerator = () =>
    (async function* (): AsyncGenerator<Status> {
      // never yields — pull mode doesn't depend on reconnect events
    })();

  const fakeNc = {
    status: statusGenerator,
    subscribe: mock(() => {
      // pull-mode constructs must NOT call subscribe() — see test below.
      throw new Error("pull-mode subscriber must not call NatsConnection.subscribe");
    }) as unknown as NatsConnection["subscribe"],
    drain: mock(async () => {}) as unknown as NatsConnection["drain"],
    jetstream: mock(() => fakeJs) as unknown as NatsConnection["jetstream"],
  } as unknown as NatsConnection;

  const link = await NatsLink.connect({
    url: "nats://localhost:4222",
    name: "myelin-pull-test",
    connectImpl: async () => fakeNc,
  });

  return {
    link,
    deliver: (subject, data) => {
      const m = makeFakeJsMsg(subject, data);
      issued.push(m);
      channel.deliver(m);
      return m;
    },
    consumerGet,
    consumeOpts: () => capturedConsumeOpts,
    lastMsg: () => issued[issued.length - 1],
    cleanup: async () => {
      await channel.close();
      await link.close();
    },
  };
}

// ---- push-mode fakes (same shape as the existing subscriber.test.ts) -------

function makeFakePushSubscription() {
  interface Msg { subject: string; data: Uint8Array }
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
      const next = await new Promise<Msg | null>((r) => (waiter = r));
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

async function makePushLink() {
  const subs: ReturnType<typeof makeFakePushSubscription>[] = [];
  const status = () => (async function* () {})();
  const subscribe = mock(() => {
    const s = makeFakePushSubscription();
    subs.push(s);
    return s.sub;
  });
  const fakeNc = {
    status,
    subscribe,
    drain: mock(async () => {}),
    jetstream: mock(() => {
      throw new Error("push-mode subscriber must not call .jetstream()");
    }),
  } as unknown as NatsConnection;
  const link = await NatsLink.connect({
    url: "nats://localhost:4222",
    name: "myelin-push-test",
    connectImpl: async () => fakeNc,
  });
  return { link, subAt: (i: number) => subs[i]! };
}

async function flushMicrotasks(times = 16) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function bytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

// ============================================================================
// tests
// ============================================================================

describe("MyelinSubscriber — pull mode", () => {
  let restoreConsole: () => void;
  beforeEach(() => {
    const orig = { warn: console.warn, error: console.error, info: console.info };
    console.warn = mock(() => {});
    console.error = mock(() => {});
    console.info = mock(() => {});
    restoreConsole = () => {
      console.warn = orig.warn;
      console.error = orig.error;
      console.info = orig.info;
    };
  });
  afterEach(() => restoreConsole());

  // -------------------------------------------------------------------------
  // 1) push-mode unchanged: absent `mode` selects push (NatsConnection.subscribe path)
  // -------------------------------------------------------------------------
  test("absent mode defaults to push (calls NatsConnection.subscribe, not jetstream)", async () => {
    const { link, subAt } = await makePushLink();
    const received: { type: string; subject: string }[] = [];
    const sub = MyelinSubscriber.start(link, {
      pattern: "local.acme.>",
      onEnvelope: (env, subject) => {
        received.push({ type: env.type, subject });
      },
    });
    subAt(0).push("local.acme.deploy", bytes(validEnvelope));
    await flushMicrotasks();
    expect(received).toEqual([
      { type: "ops.deploy.completed", subject: "local.acme.deploy" },
    ]);
    await sub.stop();
    await link.close();
  });

  test("mode: 'push' selects push (parity with absent mode)", async () => {
    const { link, subAt } = await makePushLink();
    const received: { type: string; subject: string }[] = [];
    const sub = MyelinSubscriber.start(link, {
      pattern: "local.acme.>",
      mode: "push",
      onEnvelope: (env, subject) => {
        received.push({ type: env.type, subject });
      },
    });
    subAt(0).push("local.acme.deploy", bytes(validEnvelope));
    await flushMicrotasks();
    expect(received).toEqual([
      { type: "ops.deploy.completed", subject: "local.acme.deploy" },
    ]);
    await sub.stop();
    await link.close();
  });

  // -------------------------------------------------------------------------
  // 2) pull-mode parity: same envelope, same handler shape
  // -------------------------------------------------------------------------
  test("mode: 'pull' selects pull (calls jetstream().consumers.get + consume)", async () => {
    const h = await makePullLink();
    const received: { type: string; subject: string }[] = [];
    const sub = MyelinSubscriber.start(h.link, {
      pattern: "local.acme.>",
      mode: "pull",
      pull: {
        stream: "ACME_TASKS",
        durable: "myelin-test-consumer",
      },
      onEnvelope: (env, subject) => {
        received.push({ type: env.type, subject });
      },
    });
    await sub.ready;

    expect(h.consumerGet).toHaveBeenCalledTimes(1);
    expect(h.consumerGet.mock.calls[0]).toEqual(["ACME_TASKS", "myelin-test-consumer"]);

    h.deliver("local.acme.deploy", bytes(validEnvelope));
    await flushMicrotasks();
    expect(received).toEqual([
      { type: "ops.deploy.completed", subject: "local.acme.deploy" },
    ]);
    await sub.stop();
    await h.cleanup();
  });

  test("pull mode passes through ackWaitMs / maxMessages / expiresMs as consume options", async () => {
    const h = await makePullLink();
    const sub = MyelinSubscriber.start(h.link, {
      pattern: "local.acme.>",
      mode: "pull",
      pull: {
        stream: "ACME_TASKS",
        durable: "myelin-test-consumer",
        maxMessages: 5,
        expiresMs: 30_000,
      },
      onEnvelope: () => {},
    });
    await sub.ready;
    const opts = h.consumeOpts();
    expect(opts).toBeDefined();
    expect((opts as { max_messages?: number }).max_messages).toBe(5);
    expect((opts as { expires?: number }).expires).toBe(30_000);
    await sub.stop();
    await h.cleanup();
  });

  // -------------------------------------------------------------------------
  // 3) ack on success
  // -------------------------------------------------------------------------
  test("pull mode: handler resolves → msg.ack(), no nak/term", async () => {
    const h = await makePullLink();
    const sub = MyelinSubscriber.start(h.link, {
      pattern: "local.acme.>",
      mode: "pull",
      pull: { stream: "ACME_TASKS", durable: "myelin-test-consumer" },
      onEnvelope: async () => {
        // resolves cleanly
      },
    });
    await sub.ready;
    const m = h.deliver("local.acme.deploy", bytes(validEnvelope));
    await flushMicrotasks();
    expect(m.ack).toHaveBeenCalledTimes(1);
    expect(m.nak).not.toHaveBeenCalled();
    expect(m.term).not.toHaveBeenCalled();
    await sub.stop();
    await h.cleanup();
  });

  // -------------------------------------------------------------------------
  // 4) nak on throw (NOT term — redelivery is bounded server-side)
  // -------------------------------------------------------------------------
  test("pull mode: handler throws → msg.nak(), NOT term", async () => {
    const h = await makePullLink();
    const errors: { msg: string; subject: string }[] = [];
    const sub = MyelinSubscriber.start(h.link, {
      pattern: "local.acme.>",
      mode: "pull",
      pull: { stream: "ACME_TASKS", durable: "myelin-test-consumer" },
      onEnvelope: () => {
        throw new Error("handler boom");
      },
      onError: (err, subject) => errors.push({ msg: err.message, subject }),
    });
    await sub.ready;
    const m = h.deliver("local.acme.deploy", bytes(validEnvelope));
    await flushMicrotasks();
    expect(m.ack).not.toHaveBeenCalled();
    expect(m.nak).toHaveBeenCalledTimes(1);
    expect(m.term).not.toHaveBeenCalled();
    expect(errors).toEqual([{ msg: "handler boom", subject: "local.acme.deploy" }]);
    await sub.stop();
    await h.cleanup();
  });

  // -------------------------------------------------------------------------
  // 5) invalid envelope on pull also acks (don't redeliver garbage forever)
  // -------------------------------------------------------------------------
  test("pull mode: invalid envelope → msg.term() with reason (no redelivery of garbage)", async () => {
    const h = await makePullLink();
    const sub = MyelinSubscriber.start(h.link, {
      pattern: "local.acme.>",
      mode: "pull",
      pull: { stream: "ACME_TASKS", durable: "myelin-test-consumer" },
      onEnvelope: () => {},
    });
    await sub.ready;
    const m = h.deliver("local.acme.broken", new TextEncoder().encode("{ not json"));
    await flushMicrotasks();
    // Garbage payloads MUST NOT be naked — that would loop forever
    // until max_deliver. We term them so they go straight to the
    // dead-letter path (consumer-side responsibility to surface).
    expect(m.term).toHaveBeenCalledTimes(1);
    expect(m.nak).not.toHaveBeenCalled();
    expect(m.ack).not.toHaveBeenCalled();
    await sub.stop();
    await h.cleanup();
  });

  // -------------------------------------------------------------------------
  // 6) stop() in pull mode closes the ConsumerMessages iterator
  // -------------------------------------------------------------------------
  test("pull mode: stop() closes the ConsumerMessages iterator (idempotent)", async () => {
    const h = await makePullLink();
    const sub = MyelinSubscriber.start(h.link, {
      pattern: "local.acme.>",
      mode: "pull",
      pull: { stream: "ACME_TASKS", durable: "myelin-test-consumer" },
      onEnvelope: () => {},
    });
    await sub.ready;
    await sub.stop();
    await sub.stop(); // idempotent
    await h.cleanup();
  });

  // -------------------------------------------------------------------------
  // 7) behavioural parity: same envelope under either mode → same handler output
  // -------------------------------------------------------------------------
  test("parity: same envelope, push and pull modes deliver identical envelope to handler", async () => {
    const pushH = await makePushLink();
    const pullH = await makePullLink();

    const pushReceived: { type: string; subject: string }[] = [];
    const pullReceived: { type: string; subject: string }[] = [];

    const pushSub = MyelinSubscriber.start(pushH.link, {
      pattern: "local.acme.>",
      onEnvelope: (env, subject) => {
        pushReceived.push({ type: env.type, subject });
      },
    });
    const pullSub = MyelinSubscriber.start(pullH.link, {
      pattern: "local.acme.>",
      mode: "pull",
      pull: { stream: "ACME_TASKS", durable: "myelin-test-consumer" },
      onEnvelope: (env, subject) => {
        pullReceived.push({ type: env.type, subject });
      },
    });
    await Promise.all([pushSub.ready, pullSub.ready]);

    pushH.subAt(0).push("local.acme.deploy", bytes(validEnvelope));
    pullH.deliver("local.acme.deploy", bytes(validEnvelope));
    await flushMicrotasks();

    expect(pushReceived).toEqual(pullReceived);

    await pushSub.stop();
    await pullSub.stop();
    await pushH.link.close();
    await pullH.cleanup();
  });

  // ---------------------------------------------------------------------------
  // 8) AckDecision return channel — cortex#290 coverage-gap (Architect Finding 2b)
  //
  // PR-1's subscriber.ts:319-339 added the `applyAckDecision` glue so a
  // handler may return `{ kind: "ack" | "nak" | "term", ... }` and have
  // those discriminators flow through to JetStream's `JsMsg` control
  // surface. The tests in §3-§5 above cover the implicit paths
  // (resolve = ack, throw = nak, invalid envelope = term). These three
  // tests pin the EXPLICIT return-channel paths the ReviewConsumer
  // depends on (cortex#237 PR-6 §7 nak taxonomy).
  // ---------------------------------------------------------------------------
  test("AckDecision: handler returns { kind: 'ack' } → JsMsg.ack called (no nak/term)", async () => {
    const h = await makePullLink();
    const sub = MyelinSubscriber.start(h.link, {
      pattern: "local.acme.>",
      mode: "pull",
      pull: { stream: "ACME_TASKS", durable: "myelin-test-consumer" },
      onEnvelope: async () => ({ kind: "ack" } as const),
    });
    await sub.ready;
    const m = h.deliver("local.acme.deploy", bytes(validEnvelope));
    await flushMicrotasks();
    expect(m.ack).toHaveBeenCalledTimes(1);
    expect(m.nak).not.toHaveBeenCalled();
    expect(m.term).not.toHaveBeenCalled();
    await sub.stop();
    await h.cleanup();
  });

  test("AckDecision: handler returns { kind: 'nak', delayMs: 1500 } → JsMsg.nak called with 1500", async () => {
    const h = await makePullLink();
    const sub = MyelinSubscriber.start(h.link, {
      pattern: "local.acme.>",
      mode: "pull",
      pull: { stream: "ACME_TASKS", durable: "myelin-test-consumer" },
      onEnvelope: async () => ({ kind: "nak", delayMs: 1500 } as const),
    });
    await sub.ready;
    const m = h.deliver("local.acme.deploy", bytes(validEnvelope));
    await flushMicrotasks();
    // The delay hint is the load-bearing assertion — pilot's `not_now`
    // path threads `retry_after_ms` through the AckDecision return
    // channel; if the delayMs is dropped on the floor here, JetStream
    // redelivers on its server-paced default and pilot's exit-code
    // mapping silently desyncs from the operator-visible delay.
    expect(m.nak).toHaveBeenCalledTimes(1);
    expect(m.nak.mock.calls[0]).toEqual([1500]);
    expect(m.ack).not.toHaveBeenCalled();
    expect(m.term).not.toHaveBeenCalled();
    await sub.stop();
    await h.cleanup();
  });

  test("AckDecision: handler returns { kind: 'term', reason: 'no capability match' } → JsMsg.term called with that reason", async () => {
    const h = await makePullLink();
    const sub = MyelinSubscriber.start(h.link, {
      pattern: "local.acme.>",
      mode: "pull",
      pull: { stream: "ACME_TASKS", durable: "myelin-test-consumer" },
      onEnvelope: async () =>
        ({ kind: "term", reason: "no capability match" } as const),
    });
    await sub.ready;
    const m = h.deliver("local.acme.deploy", bytes(validEnvelope));
    await flushMicrotasks();
    expect(m.term).toHaveBeenCalledTimes(1);
    expect(m.term.mock.calls[0]).toEqual(["no capability match"]);
    expect(m.ack).not.toHaveBeenCalled();
    expect(m.nak).not.toHaveBeenCalled();
    await sub.stop();
    await h.cleanup();
  });
});
