/**
 * G-1100.E: MyelinRuntime tests.
 *
 * Tests focus on the opt-in / no-op surface — when nats config is
 * absent, runtime is a no-op (the bot stays installable). When
 * configured, it logs and connects. Direct integration with a real NATS
 * server is deferred to manual smoke (per design §8 / iteration plan).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NatsConnection, Subscription, Status } from "nats";
import type { AgentConfig } from "../../../common/types/config";
import { startMyelinRuntime } from "../runtime";

function makeConfig(natsBlock: AgentConfig["nats"]): AgentConfig {
  return {
    agent: {
      name: "luna",
      displayName: "Luna",
      operatorId: "andreas",
      operatorName: "Andreas",
    },
    nats: natsBlock,
  } as unknown as AgentConfig;
}

function makeFakeNatsConnection() {
  const statusListeners = new Set<(s: Status | null) => void>();
  const subscribePatterns: string[] = [];
  const publishes: { subject: string; payload: string | Uint8Array }[] = [];

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
      statusListeners.add(listener);
      try {
        while (true) {
          if (queue.length > 0) {
            const next = queue.shift()!;
            if (next === null) return;
            yield next;
            continue;
          }
          const next = await new Promise<Status | null>((r) => (waiter = r));
          if (next === null) return;
          yield next;
        }
      } finally {
        statusListeners.delete(listener);
      }
    })();

  const subscribe = mock((pattern: string) => {
    subscribePatterns.push(pattern);
    let iteratorResolve: (() => void) | null = null;
    const iteratorDone = new Promise<void>((r) => {
      iteratorResolve = r;
    });
    // No `yield` — closes immediately when iteratorDone resolves. The
    // myelin runtime's subscriber loop only checks the `done` flag, so a
    // generator that returns without yielding satisfies the contract.
    // eslint-disable-next-line require-yield
    const iterator = (async function* () {
      await iteratorDone;
    })();
    return {
      [Symbol.asyncIterator]: () => iterator,
      drain: mock(async () => {
        iteratorResolve?.();
      }),
      closed: Promise.resolve(),
    } as unknown as Subscription;
  });

  const drain = mock(async () => {
    for (const l of statusListeners) l(null);
  });

  const publish = mock((subject: string, payload: string | Uint8Array) => {
    publishes.push({ subject, payload });
  });

  const nc = { status, subscribe, drain, publish } as unknown as NatsConnection;
  return { nc, subscribe, subscribePatterns, publishes, publish };
}

describe("MyelinRuntime", () => {
  let logs: { kind: "log" | "info" | "warn" | "error"; msg: string }[];
  let restore: () => void;

  beforeEach(() => {
    logs = [];
    const origLog = console.log;
    const origInfo = console.info;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...args: unknown[]) => {
      logs.push({ kind: "log", msg: args.map(String).join(" ") });
    };
    console.info = (...args: unknown[]) => {
      logs.push({ kind: "info", msg: args.map(String).join(" ") });
    };
    console.warn = (...args: unknown[]) => {
      logs.push({ kind: "warn", msg: args.map(String).join(" ") });
    };
    console.error = (...args: unknown[]) => {
      logs.push({ kind: "error", msg: args.map(String).join(" ") });
    };
    restore = () => {
      console.log = origLog;
      console.info = origInfo;
      console.warn = origWarn;
      console.error = origError;
    };
  });
  afterEach(() => restore());

  test("returns disabled runtime when nats config absent", async () => {
    const config = makeConfig(undefined);
    const runtime = await startMyelinRuntime(config);
    expect(runtime.enabled).toBe(false);
    expect(logs.filter((l) => l.msg.includes("myelin"))).toEqual([]);
    await runtime.stop();
  });

  test("disabled runtime exposes onEnvelope (handlers register but never fire)", async () => {
    const runtime = await startMyelinRuntime(makeConfig(undefined));
    expect(runtime.enabled).toBe(false);
    let called = 0;
    const reg = runtime.onEnvelope(() => {
      called++;
    });
    expect(typeof reg.unregister).toBe("function");
    reg.unregister();
    expect(called).toBe(0);
    await runtime.stop();
  });

  test("enabled runtime registers + unregisters handlers without throwing", async () => {
    const fake = makeFakeNatsConnection();
    const runtime = await startMyelinRuntime(
      makeConfig({
        url: "nats://localhost:4222",
        name: "cortex",
        subjects: ["local.test.>"],
      }),
      { connectImpl: async () => fake.nc },
    );
    expect(runtime.enabled).toBe(true);
    const reg = runtime.onEnvelope(() => {});
    expect(typeof reg.unregister).toBe("function");
    reg.unregister();
    // Re-registering after unregister also fine.
    const reg2 = runtime.onEnvelope(() => {});
    reg2.unregister();
    await runtime.stop();
  });

  test("cortex#337 — connects + enables runtime when nats.url set even if subjects empty (pull-only mode)", async () => {
    // Pre-#337 cortex.yaml's default `nats.subjects: []` returned a
    // fully-disabled runtime, including a no-op `subscribePull` — so the
    // bus dispatch path was structurally non-functional even on installs
    // that DID configure NATS. With #337 the runtime treats empty
    // `subjects` as "pull-only / publish-only mode": open the link, skip
    // push-mode subscribers, expose a live `subscribePull` and `publish`.
    const fake = makeFakeNatsConnection();
    const config = makeConfig({
      url: "nats://localhost:4222",
      name: "cortex",
      subjects: [],
    });
    const runtime = await startMyelinRuntime(config, {
      connectImpl: async () => fake.nc,
    });
    // Runtime is now ENABLED (the inverted invariant of the pre-#337
    // test). Callers gated on `runtime.enabled` to skip publish should
    // now see publish flow through.
    expect(runtime.enabled).toBe(true);
    // No push-mode subscribers started — the empty subjects list means
    // nothing to subscribe to broadly.
    expect(fake.subscribePatterns).toEqual([]);
    // The info log shape is preserved for log shippers that already
    // grep on the "no push subscribers" signal, but the wording is
    // updated to say "pull-only mode" so operators no longer read it
    // as "everything is disabled".
    const informed = logs.some(
      (l) => l.kind === "info" && l.msg.includes("pull-only mode"),
    );
    expect(informed).toBe(true);
    const warned = logs.some(
      (l) => l.kind === "warn" && l.msg.includes("subjects"),
    );
    expect(warned).toBe(false);

    // Anti-criterion: subscribePull MUST be a real wired helper now
    // (not the subscribePullDisabled no-op). The exact return value is
    // a MyelinSubscriber stub when the fake NATS connection accepts
    // the pull bind; the shape contract is "non-null helper present".
    expect(typeof runtime.subscribePull).toBe("function");

    await runtime.stop();
  });

  test("returns disabled when NATS connect fails (logs error, doesn't throw)", async () => {
    const config = makeConfig({
      url: "nats://localhost:9999",
      name: "cortex",
      subjects: ["local.test.>"],
    });
    const runtime = await startMyelinRuntime(config, {
      connectImpl: async () => {
        throw new Error("connection refused");
      },
    });
    expect(runtime.enabled).toBe(false);
    const errored = logs.some(
      (l) => l.kind === "error" && l.msg.includes("failed to connect"),
    );
    expect(errored).toBe(true);
  });

  test("subjects placeholder {principal} is substituted from agent.operatorId", async () => {
    const fake = makeFakeNatsConnection();
    const config = makeConfig({
      url: "nats://localhost:4222",
      name: "cortex",
      subjects: ["local.{principal}.attention.>"],
    });
    const runtime = await startMyelinRuntime(config, {
      connectImpl: async () => fake.nc,
    });
    expect(runtime.enabled).toBe(true);
    expect(fake.subscribePatterns[0]).toBe("local.andreas.attention.>");
    await runtime.stop();
  });

  // R4 (vocabulary migration 2026-05, myelin#185 + cortex#453) — the
  // `{org}` back-compat substitution arm retired when myelin#185 landed.
  // `migrate-config` rewrites pre-migration `{org}` tokens to `{principal}`
  // before they reach runtime, so the substituter only needs to handle
  // the canonical token.

  // cortex#269 — `{stack}.` token substitution. Principal-written narrow
  // subscribe patterns can now reference the principal's stack identity
  // alongside `{principal}` and have it expanded at boot. The `.` is part of
  // the placeholder so stack-less deployments collapse cleanly to the
  // legacy 5-segment shape.
  test("subjects placeholder {stack}. is substituted from options.stack", async () => {
    const fake = makeFakeNatsConnection();
    const config = makeConfig({
      url: "nats://localhost:4222",
      name: "cortex",
      subjects: ["local.{principal}.{stack}.attention.>"],
    });
    const runtime = await startMyelinRuntime(config, {
      connectImpl: async () => fake.nc,
      stack: "research",
    });
    expect(runtime.enabled).toBe(true);
    expect(fake.subscribePatterns[0]).toBe(
      "local.andreas.research.attention.>",
    );
    await runtime.stop();
  });

  test("subjects placeholder {stack}. collapses to empty when options.stack is omitted (legacy compat)", async () => {
    const fake = makeFakeNatsConnection();
    const config = makeConfig({
      url: "nats://localhost:4222",
      name: "cortex",
      subjects: ["local.{principal}.{stack}.attention.>"],
    });
    const runtime = await startMyelinRuntime(config, {
      connectImpl: async () => fake.nc,
      // no stack supplied
    });
    expect(runtime.enabled).toBe(true);
    // `{stack}.` collapses; resulting pattern matches legacy 5-segment
    // shape so pre-A.5 publishers stay observable.
    expect(fake.subscribePatterns[0]).toBe("local.andreas.attention.>");
    await runtime.stop();
  });

  test("subjects without {stack} placeholder are unchanged regardless of options.stack", async () => {
    // Default `["local.{principal}.>"]` pattern uses multi-segment wildcard
    // — already matches both 5-seg and 6-seg emissions. No substitution
    // needed; the runtime must NOT corrupt this pattern when stack is
    // supplied (`local.{principal}.>` → `local.andreas.>`, not `local.andreas.research.>`).
    const fake = makeFakeNatsConnection();
    const config = makeConfig({
      url: "nats://localhost:4222",
      name: "cortex",
      subjects: ["local.{principal}.>"],
    });
    const runtime = await startMyelinRuntime(config, {
      connectImpl: async () => fake.nc,
      stack: "research",
    });
    expect(fake.subscribePatterns[0]).toBe("local.andreas.>");
    await runtime.stop();
  });

  test("redacts token-form credentials from NATS URL in log output", async () => {
    const fake = makeFakeNatsConnection();
    const config = makeConfig({
      url: "nats://secret-token@localhost:4222",
      name: "cortex",
      subjects: ["local.test.>"],
    });
    const runtime = await startMyelinRuntime(config, {
      connectImpl: async () => fake.nc,
    });
    expect(runtime.enabled).toBe(true);
    const connectLog = logs.find(
      (l) => l.kind === "log" && l.msg.includes("myelin-runtime: connected"),
    );
    expect(connectLog).toBeDefined();
    expect(connectLog!.msg).not.toContain("secret-token");
    expect(connectLog!.msg).toContain("***@");
    await runtime.stop();
  });

  test("redacts user:pass-form credentials from NATS URL", async () => {
    const fake = makeFakeNatsConnection();
    const config = makeConfig({
      url: "nats://alice:hunter2@localhost:4222",
      name: "cortex",
      subjects: ["local.test.>"],
    });
    const runtime = await startMyelinRuntime(config, {
      connectImpl: async () => fake.nc,
    });
    expect(runtime.enabled).toBe(true);
    const connectLog = logs.find(
      (l) => l.kind === "log" && l.msg.includes("myelin-runtime: connected"),
    );
    expect(connectLog).toBeDefined();
    // Both user and password redacted.
    expect(connectLog!.msg).not.toContain("alice");
    expect(connectLog!.msg).not.toContain("hunter2");
    expect(connectLog!.msg).toContain("***@");
    await runtime.stop();
  });

  test("stop() on enabled runtime drains subscribers and closes link, idempotent", async () => {
    const fake = makeFakeNatsConnection();
    const config = makeConfig({
      url: "nats://localhost:4222",
      name: "cortex",
      subjects: ["local.test.>"],
    });
    const runtime = await startMyelinRuntime(config, {
      connectImpl: async () => fake.nc,
    });
    expect(runtime.enabled).toBe(true);
    await runtime.stop();
    await runtime.stop(); // second call must not redo work
    // The "stopped" log line must appear exactly once across both
    // invocations, not twice — proves the `stopped` flag in the
    // closure actually short-circuits.
    const stoppedLines = logs.filter(
      (l) => l.kind === "log" && l.msg.includes("myelin-runtime: stopped"),
    );
    expect(stoppedLines.length).toBe(1);
  });

  describe("publish()", () => {
    function makeEnvelope(overrides: Partial<{ id: string; type: string }> = {}) {
      return {
        id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
        source: "metafactory.grove.local",
        type: overrides.type ?? "system.adapter.degraded",
        timestamp: "2026-05-09T12:00:00.000Z",
        sovereignty: {
          classification: "local" as const,
          data_residency: "NZ",
          max_hop: 0,
          frontier_ok: true,
          model_class: "any" as const,
        },
        payload: { adapter_id: "discord-luna" },
      };
    }

    test("disabled runtime: publish is a no-op (resolves, no NATS calls)", async () => {
      const runtime = await startMyelinRuntime(makeConfig(undefined));
      expect(runtime.enabled).toBe(false);
      // Must not throw and must not log a publish line — there's no
      // connection to log against.
      await runtime.publish(makeEnvelope());
      const errLines = logs.filter((l) => l.kind === "error");
      expect(errLines).toEqual([]);
      await runtime.stop();
    });

    test("enabled runtime: publish forwards to NATS with subject local.{principal}.{type}", async () => {
      const fake = makeFakeNatsConnection();
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "cortex",
          subjects: ["local.{principal}.system.>"],
        }),
        { connectImpl: async () => fake.nc },
      );
      expect(runtime.enabled).toBe(true);
      const env = makeEnvelope({ type: "system.adapter.degraded" });
      await runtime.publish(env);
      expect(fake.publish).toHaveBeenCalledTimes(1);
      // IAW Phase A.3: subject `{principal}` comes from `envelope.source`'s first
      // segment ("metafactory" here), NOT from `agent.operatorId`. Subject
      // prefix mirrors `envelope.sovereignty.classification` ("local" here),
      // satisfying `validateSubjectEnvelopeAlignment`. Emit-site helpers
      // populate `envelope.source` with the operator-side `agent.operatorId`,
      // so the two values agree at runtime — the test fixture exercises the
      // derive-from-envelope path directly.
      expect(fake.publishes[0]?.subject).toBe(
        "local.metafactory.system.adapter.degraded",
      );
      // Payload is the JSON-serialised envelope; round-trip restores it intact.
      const payload = fake.publishes[0]?.payload as string;
      expect(typeof payload).toBe("string");
      expect(JSON.parse(payload)).toEqual(env);
      await runtime.stop();
    });

    test("enabled runtime: publish derives federated.{principal}.{type} subject", async () => {
      // IAW Phase A.3 — federation unblock. When an emit site opts into
      // `classification: "federated"`, the envelope's sovereignty AND the
      // runtime-derived subject move in lockstep onto the `federated.*`
      // namespace. This is what makes cortex able to emit federated
      // envelopes for the first time.
      const fake = makeFakeNatsConnection();
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "cortex",
          subjects: ["local.{principal}.>"],
        }),
        { connectImpl: async () => fake.nc },
      );
      const baseEnv = makeEnvelope();
      const env = {
        ...baseEnv,
        sovereignty: { ...baseEnv.sovereignty, classification: "federated" as const },
      };
      await runtime.publish(env);
      expect(fake.publish).toHaveBeenCalledTimes(1);
      expect(fake.publishes[0]?.subject).toBe(
        "federated.metafactory.system.adapter.degraded",
      );
      await runtime.stop();
    });

    test("enabled runtime: publish derives public.{type} subject (no org segment)", async () => {
      // IAW Phase A.3 — public-tier envelopes drop the `{principal}` segment per
      // myelin's grammar (public is global). The runtime applies this
      // automatically via `deriveNatsSubject`.
      const fake = makeFakeNatsConnection();
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "cortex",
          subjects: ["local.{principal}.>"],
        }),
        { connectImpl: async () => fake.nc },
      );
      const baseEnv = makeEnvelope();
      const env = {
        ...baseEnv,
        sovereignty: { ...baseEnv.sovereignty, classification: "public" as const },
      };
      await runtime.publish(env);
      expect(fake.publish).toHaveBeenCalledTimes(1);
      expect(fake.publishes[0]?.subject).toBe(
        "public.system.adapter.degraded",
      );
      await runtime.stop();
    });

    test("IAW Phase A.5 (cortex#262): tasks.* envelopes land in sage's 6-segment subscribe wildcard", async () => {
      // Literal cortex#262 AC#3 — `Published subjects are 6-segment on
      // tasks.* domain`. This is the wire shape pilot's `request-review`
      // publish + sage's bridge subscribe both depend on; the test pins
      // the exact subject so a future regression in either side surfaces
      // here before the cross-repo loop breaks silently.
      const fake = makeFakeNatsConnection();
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "cortex",
          subjects: ["local.{principal}.>"],
        }),
        { connectImpl: async () => fake.nc, stack: "default" },
      );
      await runtime.publish(makeEnvelope({ type: "tasks.review.requested" }));
      expect(fake.publishes[0]?.subject).toBe(
        "local.metafactory.default.tasks.review.requested",
      );
      await runtime.stop();
    });

    test("IAW Phase A.5 (cortex#262): publish derives 6-segment local.{principal}.{stack}.{type} when stack option is set", async () => {
      // Stack-aware emit — principal config carries `stack: { id: andreas/research }`
      // and the entrypoint passes `stack: "research"` through to the runtime.
      // The resulting subject lands inside sage's `local.{principal}.{stack}.>`
      // subscription wildcard, closing the Offer loop end-to-end.
      const fake = makeFakeNatsConnection();
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "cortex",
          subjects: ["local.{principal}.>"],
        }),
        { connectImpl: async () => fake.nc, stack: "research" },
      );
      await runtime.publish(makeEnvelope({ type: "system.adapter.degraded" }));
      expect(fake.publish).toHaveBeenCalledTimes(1);
      expect(fake.publishes[0]?.subject).toBe(
        "local.metafactory.research.system.adapter.degraded",
      );
      await runtime.stop();
    });

    test("IAW Phase A.5 (cortex#262): publish falls through to legacy 5-segment when stack option is omitted", async () => {
      // Backward compat — deployments that haven't wired stack identity
      // continue to emit the legacy 5-segment shape. The runtime relays
      // `stack: undefined` to `deriveNatsSubject` which short-circuits
      // back to the pre-A.5 grammar. No behavior change for these callers.
      const fake = makeFakeNatsConnection();
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "cortex",
          subjects: ["local.{principal}.>"],
        }),
        { connectImpl: async () => fake.nc },
      );
      await runtime.publish(makeEnvelope({ type: "system.adapter.degraded" }));
      expect(fake.publishes[0]?.subject).toBe(
        "local.metafactory.system.adapter.degraded",
      );
      await runtime.stop();
    });

    test("publish swallows underlying NATS errors (logs, never throws)", async () => {
      const fake = makeFakeNatsConnection();
      // Force the underlying nc.publish to throw — simulates connection-closed
      // or oversized-payload errors.
      (fake.nc as { publish: (s: string, p: unknown) => void }).publish = () => {
        throw new Error("connection closed");
      };
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "cortex",
          subjects: ["local.{principal}.system.>"],
        }),
        { connectImpl: async () => fake.nc },
      );
      // Must NOT throw — publish failure is non-fatal by design.
      await expect(runtime.publish(makeEnvelope())).resolves.toBeUndefined();
      const errored = logs.some(
        (l) => l.kind === "error" && l.msg.includes("publish failed"),
      );
      expect(errored).toBe(true);
      await runtime.stop();
    });

    test("cortex#420 major-3 — publishOnSubject PROPAGATES underlying NATS errors (does NOT swallow)", async () => {
      // Inverse of the legacy `publish()` contract above: the
      // cortex#409 explicit-subject path is used by callers that
      // need to know whether the envelope actually hit the wire
      // (`publishInboundDispatchEnvelope` falls through to the
      // legacy in-process dispatch path on rejection). If
      // `link.publish` errors were swallowed inside
      // `signAndPublishOnSubject`, the dispatch-handler's catch
      // would never fire and inbound chat dispatches would be
      // SILENTLY DROPPED when the bus is unreachable.
      const fake = makeFakeNatsConnection();
      (fake.nc as { publish: (s: string, p: unknown) => void }).publish = () => {
        throw new Error("connection closed");
      };
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "cortex",
          subjects: ["local.{principal}.tasks.>"],
        }),
        { connectImpl: async () => fake.nc },
      );
      expect(typeof runtime.publishOnSubject).toBe("function");
      await expect(
        runtime.publishOnSubject!(
          makeEnvelope({ type: "tasks.chat" }),
          "local.metafactory.research.tasks.@did-mf-cortex.chat",
        ),
      ).rejects.toThrow("connection closed");
      await runtime.stop();
    });

    test("IAW B.3 — publish signs outbound when signer option is set", async () => {
      // Round-trip: start the runtime with a signer; publish an
      // unsigned envelope; assert the published JSON carries a fresh
      // `signed_by[]` array with one ed25519 stamp whose principal +
      // signature shape match the signer config. The actual bytes
      // verify is exercised indirectly via the `signEnvelope` →
      // `verifyEnvelopeIdentity` round-trip already covered in
      // `verify-signed-by-chain.test.ts`'s cryptoVerify happy-path.
      const { createUser } = await import("@nats-io/nkeys");
      const kp = createUser();
      const rawSeedBytes = (
        kp as unknown as { getRawSeed(): Uint8Array }
      ).getRawSeed();

      const fake = makeFakeNatsConnection();
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "cortex",
          subjects: ["local.{principal}.system.>"],
        }),
        {
          connectImpl: async () => fake.nc,
          signer: {
            rawSeedBytes,
            principal: "did:mf:test-stack",
          },
        },
      );
      expect(runtime.enabled).toBe(true);

      const env = makeEnvelope();
      await runtime.publish(env);

      // Exactly one publish forwarded.
      expect(fake.publish).toHaveBeenCalledTimes(1);
      const payload = fake.publishes[0]?.payload as string;
      const published = JSON.parse(payload) as {
        signed_by?: { method: string; identity?: string; principal?: string; signature: string; at: string }[];
        id: string;
      };

      // Original envelope was unsigned; published envelope carries a
      // fresh chain with one ed25519 stamp matching the signer config.
      expect(published.id).toBe(env.id);
      expect(Array.isArray(published.signed_by)).toBe(true);
      expect(published.signed_by).toHaveLength(1);
      const stamp = published.signed_by?.[0];
      expect(stamp?.method).toBe("ed25519");
      // R11 (vocabulary migration 2026-05, post-myelin#184) — stamps
      // emit `identity` only; the deprecated `principal` key has been
      // retired from the wire schema.
      expect(stamp?.identity).toBe("did:mf:test-stack");
      // Signature shape: base64 of 64 raw bytes ≈ 88 chars.
      expect(stamp?.signature.length).toBeGreaterThanOrEqual(86);

      await runtime.stop();
    });

    test("IAW B.3 — publish appends to existing signed_by chain (multi-hop)", async () => {
      // Forwarding scenario: an envelope arrives already signed by
      // peer X; we forward it via this runtime; the publish must
      // APPEND our stamp rather than replace the prior chain. This is
      // the chain-of-stamps property that makes cross-stack
      // verification possible.
      const { createUser } = await import("@nats-io/nkeys");
      const priorSigner = createUser();
      const ourSigner = createUser();
      const ourRawSeed = (
        ourSigner as unknown as { getRawSeed(): Uint8Array }
      ).getRawSeed();

      // Sign a "prior" stamp directly via myelin to seed the chain.
      const { signEnvelope } = await import("@the-metafactory/myelin/identity");
      const priorRawSeed = (
        priorSigner as unknown as { getRawSeed(): Uint8Array }
      ).getRawSeed();
      const priorSeedBase64 = Buffer.from(priorRawSeed).toString("base64");
      const incoming = await signEnvelope(
        makeEnvelope(),
        priorSeedBase64,
        "did:mf:peer-x",
      );

      const fake = makeFakeNatsConnection();
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "cortex",
          subjects: ["local.{principal}.system.>"],
        }),
        {
          connectImpl: async () => fake.nc,
          signer: {
            rawSeedBytes: ourRawSeed,
            principal: "did:mf:our-stack",
          },
        },
      );
      expect(runtime.enabled).toBe(true);

      await runtime.publish(incoming);

      const payload = fake.publishes[0]?.payload as string;
      const published = JSON.parse(payload) as {
        signed_by: { identity: string }[];
      };

      // R11 (vocabulary migration 2026-05, post-myelin#184) — stamps
      // emit `identity` only; the deprecated `principal` key was
      // retired from the wire schema in myelin#184.
      expect(published.signed_by).toHaveLength(2);
      expect(published.signed_by[0]?.identity).toBe("did:mf:peer-x");
      expect(published.signed_by[1]?.identity).toBe("did:mf:our-stack");

      await runtime.stop();
    });

    test("IAW B.3 — sign failure falls back to publishing unsigned (logs, doesn't throw)", async () => {
      // Defensive: a malformed signer (bad seed shape) shouldn't
      // crash the publish path. The runtime logs and publishes the
      // original envelope unchanged so observability stays intact.
      const fake = makeFakeNatsConnection();
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "cortex",
          subjects: ["local.{principal}.system.>"],
        }),
        {
          connectImpl: async () => fake.nc,
          signer: {
            // Wrong length — myelin's signEnvelope expects 32 bytes.
            rawSeedBytes: new Uint8Array(16),
            principal: "did:mf:test-stack",
          },
        },
      );

      const env = makeEnvelope();
      // Must not throw.
      await runtime.publish(env);

      // Publish still happened — unsigned fallback.
      expect(fake.publish).toHaveBeenCalledTimes(1);
      const payload = fake.publishes[0]?.payload as string;
      const published = JSON.parse(payload) as { signed_by?: unknown };
      expect(published.signed_by).toBeUndefined();

      // Error was logged for visibility.
      const errLines = logs.filter((l) => l.kind === "error");
      expect(errLines.some((l) => l.msg.includes("sign failed"))).toBe(true);
      expect(
        errLines.some((l) => l.msg.includes("signFailureMode=fallback")),
      ).toBe(true);

      await runtime.stop();
    });

    test("IAW B.3 — signFailureMode: 'drop' skips publish on sign failure", async () => {
      // Echo cortex#209 round 1 — explicit fail-closed mode for the
      // window after subscribe-side verification becomes enforcing.
      const fake = makeFakeNatsConnection();
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "cortex",
          subjects: ["local.{principal}.system.>"],
        }),
        {
          connectImpl: async () => fake.nc,
          signer: {
            rawSeedBytes: new Uint8Array(16),
            principal: "did:mf:test-stack",
          },
          signFailureMode: "drop",
        },
      );

      await runtime.publish(makeEnvelope());

      // Publish was DROPPED — never reaches the wire.
      expect(fake.publish).not.toHaveBeenCalled();

      // Drop is logged with the explicit mode.
      const errLines = logs.filter((l) => l.kind === "error");
      expect(errLines.some((l) => l.msg.includes("DROPPING"))).toBe(true);
      expect(errLines.some((l) => l.msg.includes("signFailureMode=drop"))).toBe(
        true,
      );

      await runtime.stop();
    });

    test("publish after stop() is a no-op (no late publishes after drain)", async () => {
      // Pins the post-stop semantic documented on `publishEnabled` in
      // runtime.ts: once `stop()` returns, calls to `runtime.publish(...)`
      // must short-circuit before reaching `link.publish`. The underlying
      // nats client is drain-safe, but the runtime contract is explicit:
      // post-stop publish is a no-op the caller can rely on.
      const fake = makeFakeNatsConnection();
      const runtime = await startMyelinRuntime(
        makeConfig({
          url: "nats://localhost:4222",
          name: "cortex",
          subjects: ["local.{principal}.system.>"],
        }),
        { connectImpl: async () => fake.nc },
      );
      expect(runtime.enabled).toBe(true);
      await runtime.stop();
      await runtime.publish(makeEnvelope());
      // The fake's publish was never called — runtime short-circuited.
      expect(fake.publish).not.toHaveBeenCalled();
    });
  });
});
