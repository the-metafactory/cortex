/**
 * G-1100.D: MyelinSubscriber tests.
 *
 * Drives the compose layer end-to-end against the same multi-consumer
 * fake NatsConnection used by G-1100.C, plus the actual G-1100.B
 * validator (no mocks for the validator — we want the real Ajv2020
 * compiled schema in the loop).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NatsConnection, Subscription, Status } from "nats";
import { MyelinSubscriber, type InvalidEnvelopeReason } from "../subscriber";
import { NatsLink } from "../../nats/connection";
import validEnvelope from "../vendor/__fixtures__/valid-envelope.json" with { type: "json" };

// ---- fakes (same shape as nats-subscription.test.ts; copied because tests
//      are read-side primitives and copying keeps each suite independent) ----

function makeFakeSubscription() {
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

function makeFakeConnection() {
  const subs: ReturnType<typeof makeFakeSubscription>[] = [];
  const listeners = new Set<(s: Status | null) => void>();
  let closed = false;

  const status = () =>
    (async function* () {
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

  const fakeNc = { status, subscribe, drain } as unknown as NatsConnection;
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

async function makeLink() {
  const fake = makeFakeConnection();
  const link = await NatsLink.connect({
    url: "nats://localhost:4222",
    name: "myelin-test",
    connectImpl: async () => fake.nc,
  });
  return { link, fake };
}

async function flushMicrotasks(times = 8) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function bytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

// ---- tests ----

describe("MyelinSubscriber", () => {
  let restoreConsole: () => void;
  beforeEach(() => {
    const orig = {
      warn: console.warn,
      error: console.error,
      info: console.info,
    };
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

  test("delivers valid envelopes to onEnvelope", async () => {
    const { link, fake } = await makeLink();
    const received: { type: string; subject: string }[] = [];
    const sub = MyelinSubscriber.start(link, {
      pattern: "local.acme.>",
      onEnvelope: (env, subject) => {
        received.push({ type: env.type, subject });
      },
    });
    fake.subAt(0)!.push("local.acme.deploy", bytes(validEnvelope));
    await flushMicrotasks();
    expect(received).toEqual([
      { type: "ops.deploy.completed", subject: "local.acme.deploy" },
    ]);
    await sub.stop();
    await link.close();
  });

  test("routes schema failures to onInvalidEnvelope with structured reason", async () => {
    const { link, fake } = await makeLink();
    const received: unknown[] = [];
    const drops: { reason: InvalidEnvelopeReason; subject: string }[] = [];
    const sub = MyelinSubscriber.start(link, {
      pattern: "local.acme.>",
      onEnvelope: (env, subject) => {
        received.push({ env, subject });
      },
      onInvalidEnvelope: (reason, subject) => {
        drops.push({ reason, subject });
      },
    });
    const invalid = { ...(validEnvelope as object), type: 12345 };
    fake.subAt(0)!.push("local.acme.bad", bytes(invalid));
    await flushMicrotasks();
    expect(received).toEqual([]);
    expect(drops.length).toBe(1);
    expect(drops[0]!.subject).toBe("local.acme.bad");
    expect(drops[0]!.reason.kind).toBe("schema");
    if (drops[0]!.reason.kind === "schema") {
      expect(drops[0]!.reason.errors.length).toBeGreaterThan(0);
      expect(drops[0]!.reason.firstPath).toBeDefined();
      expect(drops[0]!.reason.firstMessage).toBeDefined();
    }
    await sub.stop();
    await link.close();
  });

  test("routes JSON parse failures to onInvalidEnvelope", async () => {
    const { link, fake } = await makeLink();
    const drops: { reason: InvalidEnvelopeReason }[] = [];
    const sub = MyelinSubscriber.start(link, {
      pattern: "local.acme.>",
      onEnvelope: () => {},
      onInvalidEnvelope: (reason) => {
        drops.push({ reason });
      },
    });
    fake.subAt(0)!.push("local.acme.broken", new TextEncoder().encode("{ not json"));
    await flushMicrotasks();
    expect(drops.length).toBe(1);
    expect(drops[0]!.reason.kind).toBe("json-parse");
    if (drops[0]!.reason.kind === "json-parse") {
      expect(drops[0]!.reason.message).toBeTruthy();
    }
    await sub.stop();
    await link.close();
  });

  test("default sink logs subject and reason without raw snippet", async () => {
    const { link, fake } = await makeLink();
    const sub = MyelinSubscriber.start(link, {
      pattern: "local.acme.>",
      onEnvelope: () => {},
    });
    fake.subAt(0)!.push("local.acme.bad", bytes({ definitely: "not an envelope" }));
    await flushMicrotasks();
    expect((console.warn as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0);
    const msg = String((console.warn as ReturnType<typeof mock>).mock.calls[0]?.[0]);
    expect(msg).toContain("dropped invalid envelope");
    expect(msg).toContain("local.acme.bad");
    expect(msg).toContain("data.length=");
    expect(msg).not.toContain("payload snippet:");
    await sub.stop();
    await link.close();
  });

  test("default sink includes snippet when logRawSnippet is true", async () => {
    const { link, fake } = await makeLink();
    const sub = MyelinSubscriber.start(link, {
      pattern: "local.acme.>",
      onEnvelope: () => {},
      logRawSnippet: true,
    });
    fake.subAt(0)!.push("local.acme.bad", bytes({ definitely: "not an envelope" }));
    await flushMicrotasks();
    expect((console.warn as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0);
    const msg = String((console.warn as ReturnType<typeof mock>).mock.calls[0]?.[0]);
    expect(msg).toContain("payload snippet:");
    await sub.stop();
    await link.close();
  });

  test("default sink does not leak payload bytes when logRawSnippet is false", async () => {
    const { link, fake } = await makeLink();
    const sub = MyelinSubscriber.start(link, {
      pattern: "local.acme.>",
      onEnvelope: () => {},
      // logRawSnippet defaults to false — assert the off-path explicitly
    });
    // Embed an obviously-secret-looking string in the payload. The
    // default sink must not include it, regardless of how the schema
    // failure is rendered.
    const payloadBytes = bytes({ shape: "wrong", secret: "hunter2-bearer-XYZ" });
    fake.subAt(0)!.push("local.acme.leaky", payloadBytes);
    await flushMicrotasks();
    const msg = String((console.warn as ReturnType<typeof mock>).mock.calls[0]?.[0]);
    expect(msg).not.toContain("hunter2");
    expect(msg).not.toContain("payload snippet:");
    expect(msg).toContain("data.length=");
    await sub.stop();
    await link.close();
  });

  test("default sink strips CRLF from subject (no log injection)", async () => {
    const { link, fake } = await makeLink();
    const sub = MyelinSubscriber.start(link, {
      pattern: "local.acme.>",
      onEnvelope: () => {},
    });
    // NATS subjects shouldn't normally contain CRLF, but a malicious
    // peer could publish with a crafted subject. Default sink must
    // strip control chars before interpolation.
    fake.subAt(0)!.push(
      "local.acme.bad\n[FAKE-LOG] grove-bot: SECURITY auth-bypass-detected",
      bytes({ shape: "wrong" }),
    );
    await flushMicrotasks();
    const msg = String((console.warn as ReturnType<typeof mock>).mock.calls[0]?.[0]);
    // Newline before "[FAKE-LOG]" must be stripped.
    expect(msg).not.toMatch(/\n\[FAKE-LOG\]/);
    expect(msg).toContain("dropped invalid envelope");
    await sub.stop();
    await link.close();
  });

  test("default sink strips CRLF from Ajv instancePath echoed via crafted JSON keys", async () => {
    const { link, fake } = await makeLink();
    const sub = MyelinSubscriber.start(link, {
      pattern: "local.acme.>",
      onEnvelope: () => {},
    });
    // Ajv echoes the JSON property name into `instancePath` when an
    // unknown property is present (with `additionalProperties: false`).
    // A malicious publisher could inject a CRLF via a crafted key;
    // sanitization must apply to the assembled reason string, not just
    // to subject + snippet.
    const malicious: Record<string, unknown> = {
      ...(validEnvelope as object),
    };
    malicious["evil\n[FAKE-LOG] grove-bot: SECURITY"] = "bypass";
    fake.subAt(0)!.push("local.acme.injection", bytes(malicious));
    await flushMicrotasks();
    const msg = String((console.warn as ReturnType<typeof mock>).mock.calls[0]?.[0]);
    expect(msg).not.toMatch(/\n\[FAKE-LOG\]/);
    expect(msg).toContain("dropped invalid envelope");
    await sub.stop();
    await link.close();
  });

  test("schema arm forwards the full Ajv errors array, not just the first", async () => {
    const { link, fake } = await makeLink();
    const drops: { reason: InvalidEnvelopeReason }[] = [];
    const sub = MyelinSubscriber.start(link, {
      pattern: "local.acme.>",
      onEnvelope: () => {},
      onInvalidEnvelope: (reason) => drops.push({ reason }),
    });
    // Two independent violations: bad type AND missing id.
    const broken = { ...(validEnvelope as object), type: 12345 } as Record<string, unknown>;
    delete broken.id;
    fake.subAt(0)!.push("local.acme.multi", bytes(broken));
    await flushMicrotasks();
    expect(drops.length).toBe(1);
    expect(drops[0]!.reason.kind).toBe("schema");
    if (drops[0]!.reason.kind === "schema") {
      expect(drops[0]!.reason.errors.length).toBeGreaterThanOrEqual(2);
    }
    await sub.stop();
    await link.close();
  });

  test("a thrown onEnvelope routes through onError, doesn't kill delivery", async () => {
    const { link, fake } = await makeLink();
    const handled: string[] = [];
    const errors: { msg: string; subject: string }[] = [];
    const sub = MyelinSubscriber.start(link, {
      pattern: "local.acme.>",
      onEnvelope: (_env, subject) => {
        if (subject.endsWith(".boom")) throw new Error("handler boom");
        handled.push(subject);
      },
      onError: (err, subject) => errors.push({ msg: err.message, subject }),
    });
    fake.subAt(0)!.push("local.acme.first", bytes(validEnvelope));
    fake.subAt(0)!.push("local.acme.boom", bytes(validEnvelope));
    fake.subAt(0)!.push("local.acme.third", bytes(validEnvelope));
    await flushMicrotasks(16);
    expect(handled).toEqual(["local.acme.first", "local.acme.third"]);
    expect(errors).toEqual([{ msg: "handler boom", subject: "local.acme.boom" }]);
    await sub.stop();
    await link.close();
  });

  test("stop() drains the inner subscription (idempotent)", async () => {
    const { link, fake } = await makeLink();
    const sub = MyelinSubscriber.start(link, {
      pattern: "local.acme.>",
      onEnvelope: () => {},
    });
    await sub.stop();
    await sub.stop();
    expect(fake.subAt(0)!.drain).toHaveBeenCalledTimes(1);
    await link.close();
  });
});
