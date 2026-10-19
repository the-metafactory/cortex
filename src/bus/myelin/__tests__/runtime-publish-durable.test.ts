import { describe, expect, mock, test } from "bun:test";
import type { JetStreamClient, PubAck } from "@nats-io/jetstream";
import type { NatsConnection } from "nats";
import type { AgentConfig } from "../../../common/types/config";
import { makeIdleConnectionParts } from "./idle-nats-connection";
import {
  MyelinDurablePublishError,
  startMyelinRuntime,
  type MyelinDurablePublishErrorKind,
  type MyelinRuntime,
} from "../runtime";

const SYNTHETIC_DOMAIN = "synthetic-domain";
const SYNTHETIC_STREAM = "SYNTHETIC_STREAM";
const SIGNER_PRINCIPAL = "did:mf:synthetic-stack";

interface PublishCall {
  subject: string;
  payload: Uint8Array;
  options: { msgID?: string; expect?: { streamName?: string }; timeout?: number };
}

type FakeJetstream = (call: PublishCall) => Promise<Partial<PubAck>>;

function makeConfig(nats?: AgentConfig["nats"]): AgentConfig {
  return {
    agent: { name: "tester", displayName: "Tester" },
    nats,
  } as unknown as AgentConfig;
}

const ENABLED_CONFIG = makeConfig({ url: "nats://localhost:4222", name: "cortex", subjects: [] });

function makeEnvelope(id = "11111111-1111-4111-8111-111111111111") {
  return {
    id,
    source: "synthetic.agent.local",
    type: "tasks.synthetic",
    timestamp: "2026-10-19T12:00:00.000Z",
    sovereignty: {
      classification: "local" as const,
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: true,
      model_class: "any" as const,
    },
    payload: { note: "synthetic" },
  };
}

function makeFakeConn(jetstream: FakeJetstream) {
  const publishCalls: PublishCall[] = [];
  const coreCalls: unknown[][] = [];
  const jetstreamArgs: unknown[][] = [];
  const js = {
    publish: mock(
      async (subject: string, payload: Uint8Array, options: PublishCall["options"]) => {
        const call = { subject, payload, options };
        publishCalls.push(call);
        return jetstream(call);
      },
    ),
  } as unknown as JetStreamClient;

  const nc = {
    ...makeIdleConnectionParts(),
    publish: mock((...args: unknown[]) => {
      coreCalls.push(args);
    }),
    jetstream: mock((...args: unknown[]) => {
      jetstreamArgs.push(args);
      return js;
    }),
  } as unknown as NatsConnection;

  return { nc, publishCalls, coreCalls, jetstreamArgs };
}

async function makeSigner() {
  const { createUser } = await import("@nats-io/nkeys");
  const rawSeedBytes = (
    createUser() as unknown as { getRawSeed(): Uint8Array }
  ).getRawSeed();
  return { rawSeedBytes, principal: SIGNER_PRINCIPAL };
}

function ack(overrides: Partial<PubAck> = {}): Partial<PubAck> {
  return { stream: SYNTHETIC_STREAM, seq: 7, duplicate: false, ...overrides };
}

async function start(
  jetstream: FakeJetstream,
  options: {
    signer?: boolean | "bad";
    signFailureMode?: "fallback" | "drop";
    jetstreamDomain?: string;
  } = {},
) {
  const fake = makeFakeConn(jetstream);
  const signer =
    options.signer === "bad"
      ? { rawSeedBytes: new Uint8Array(16), principal: SIGNER_PRINCIPAL }
      : options.signer === false
        ? undefined
        : await makeSigner();
  const runtime = await startMyelinRuntime(ENABLED_CONFIG, {
    connectImpl: async () => fake.nc,
    ...(signer !== undefined && { signer }),
    ...(options.signFailureMode !== undefined && {
      signFailureMode: options.signFailureMode,
    }),
    ...(options.jetstreamDomain !== undefined && {
      jetstreamDomain: options.jetstreamDomain,
    }),
  });
  return { runtime, fake };
}

async function rejectionOf(promise: Promise<unknown>): Promise<MyelinDurablePublishError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(MyelinDurablePublishError);
    return err as MyelinDurablePublishError;
  }
  throw new Error("expected publishDurable to reject");
}

function durable(runtime: MyelinRuntime) {
  const publishDurable = runtime.publishDurable;
  if (publishDurable === undefined) throw new Error("publishDurable missing");
  return publishDurable;
}

describe("MyelinRuntime.publishDurable", () => {
  test("publishes the signed envelope via JetStream and resolves with the PubAck", async () => {
    const { runtime, fake } = await start(async () => ack({ seq: 42 }));
    const envelope = makeEnvelope();

    const result = await durable(runtime)(envelope, { expectedStream: SYNTHETIC_STREAM });

    expect(result).toEqual({ stream: SYNTHETIC_STREAM, seq: 42, duplicate: false });
    expect(fake.publishCalls).toHaveLength(1);
    const call = fake.publishCalls[0]!;
    expect(call.options.msgID).toBe(envelope.id);
    expect(call.options.expect).toEqual({ streamName: SYNTHETIC_STREAM });
    const published = JSON.parse(new TextDecoder().decode(call.payload)) as {
      id: string;
      signed_by?: { method: string; identity?: string }[];
    };
    expect(published.id).toBe(envelope.id);
    expect(published.signed_by).toHaveLength(1);
    expect(published.signed_by?.[0]?.method).toBe("ed25519");
    expect(published.signed_by?.[0]?.identity).toBe(SIGNER_PRINCIPAL);
    expect(fake.coreCalls).toEqual([]);
    await runtime.stop();
  });

  test("surfaces the duplicate flag", async () => {
    const { runtime } = await start(async () => ack({ duplicate: true }));

    const result = await durable(runtime)(makeEnvelope(), { expectedStream: SYNTHETIC_STREAM });

    expect(result.duplicate).toBe(true);
    await runtime.stop();
  });

  test("passes the PubAck domain through when the server reports one", async () => {
    const { runtime } = await start(async () => ack({ domain: SYNTHETIC_DOMAIN }));

    const result = await durable(runtime)(makeEnvelope(), { expectedStream: SYNTHETIC_STREAM });

    expect(result.domain).toBe(SYNTHETIC_DOMAIN);
    await runtime.stop();
  });

  test("uses the runtime's jetstreamDomain", async () => {
    const { runtime, fake } = await start(async () => ack(), {
      jetstreamDomain: SYNTHETIC_DOMAIN,
    });

    await durable(runtime)(makeEnvelope(), { expectedStream: SYNTHETIC_STREAM });

    expect(fake.jetstreamArgs).toEqual([[{ domain: SYNTHETIC_DOMAIN }]]);
    await runtime.stop();
  });

  test("uses no domain argument when none is set", async () => {
    const { runtime, fake } = await start(async () => ack());

    await durable(runtime)(makeEnvelope(), { expectedStream: SYNTHETIC_STREAM });

    expect(fake.jetstreamArgs).toEqual([[]]);
    await runtime.stop();
  });

  describe("rejections", () => {
    const rejectsWith = async (
      runtime: MyelinRuntime,
      kind: MyelinDurablePublishErrorKind,
      options: { timeoutMs?: number } = {},
    ) => {
      const envelope = makeEnvelope();
      const err = await rejectionOf(
        durable(runtime)(envelope, { expectedStream: SYNTHETIC_STREAM, ...options }),
      );
      expect(err.kind).toBe(kind);
      expect(err.envelopeId).toBe(envelope.id);
      return err;
    };

    test("no signer: rejects without publishing", async () => {
      const { runtime, fake } = await start(async () => ack(), { signer: false });

      await rejectsWith(runtime, "no-signer");

      expect(fake.publishCalls).toEqual([]);
      expect(fake.coreCalls).toEqual([]);
      await runtime.stop();
    });

    test.each(["fallback", "drop"] as const)(
      "signing error with signFailureMode=%s: rejects, never publishes unsigned",
      async (signFailureMode) => {
        const { runtime, fake } = await start(async () => ack(), {
          signer: "bad",
          signFailureMode,
        });

        await rejectsWith(runtime, "sign-failed");

        expect(fake.publishCalls).toEqual([]);
        expect(fake.coreCalls).toEqual([]);
        await runtime.stop();
      },
    );

    test("disabled runtime: rejects", async () => {
      const runtime = await startMyelinRuntime(makeConfig(undefined));
      expect(runtime.enabled).toBe(false);

      await rejectsWith(runtime, "disabled");
    });

    test("stopped runtime: rejects without publishing", async () => {
      const { runtime, fake } = await start(async () => ack());
      await runtime.stop();

      await rejectsWith(runtime, "stopped");

      expect(fake.publishCalls).toEqual([]);
    });

    test("publish timeout: rejects when no PubAck arrives", async () => {
      const { runtime } = await start(() => new Promise(() => {}));

      await rejectsWith(runtime, "timeout", { timeoutMs: 20 });

      await runtime.stop();
    });

    test("a nats TimeoutError is reported as a timeout", async () => {
      const { runtime } = await start(async () => {
        const err = new Error("request timed out");
        err.name = "TimeoutError";
        throw err;
      });

      await rejectsWith(runtime, "timeout");

      await runtime.stop();
    });

    test("JetStream error: rejects with the cause attached", async () => {
      const failure = new Error("expected stream does not match");
      const { runtime } = await start(async () => {
        throw failure;
      });

      const err = await rejectsWith(runtime, "jetstream-error");

      expect(err.cause).toBe(failure);
      expect(err.message).toContain("expected stream does not match");
      await runtime.stop();
    });

    test("PubAck from a different stream: rejects", async () => {
      const { runtime } = await start(async () => ack({ stream: "OTHER_STREAM" }));

      const err = await rejectsWith(runtime, "stream-mismatch");

      expect(err.message).toContain("OTHER_STREAM");
      await runtime.stop();
    });

    test("a rejected publish never falls back to Core NATS", async () => {
      const { runtime, fake } = await start(async () => {
        throw new Error("no responders");
      });

      await rejectsWith(runtime, "jetstream-error");

      expect(fake.coreCalls).toEqual([]);
      await runtime.stop();
    });
  });

  test("publish still goes over Core NATS and does not touch JetStream", async () => {
    const { runtime, fake } = await start(async () => ack());

    await runtime.publish(makeEnvelope());

    expect(fake.coreCalls).toHaveLength(1);
    expect(fake.publishCalls).toEqual([]);
    await runtime.stop();
  });
});
