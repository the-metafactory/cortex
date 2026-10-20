import { expect, mock } from "bun:test";
import type { JetStreamClient, PubAck } from "@nats-io/jetstream";
import type { NatsConnection } from "nats";
import type { AgentConfig } from "../../../common/types/config";
import { makeIdleConnectionParts } from "./idle-nats-connection";
import {
  MyelinDurablePublishError,
  startMyelinRuntime,
  type MyelinRuntime,
} from "../runtime";

export const SYNTHETIC_DOMAIN = "synthetic-domain";
export const SYNTHETIC_STREAM = "SYNTHETIC_STREAM";
export const SIGNER_PRINCIPAL = "did:mf:synthetic-stack";

interface PublishCall {
  subject: string;
  payload: Uint8Array;
  options: { msgID?: string; expect?: { streamName?: string }; timeout?: number };
}

type FakeJetstream = (call: PublishCall) => Promise<Partial<PubAck>>;

export function makeConfig(nats?: AgentConfig["nats"]): AgentConfig {
  return {
    agent: { name: "tester", displayName: "Tester" },
    nats,
  } as unknown as AgentConfig;
}

const ENABLED_CONFIG = makeConfig({ url: "nats://localhost:4222", name: "cortex", subjects: [] });

export function makeEnvelope(id = "11111111-1111-4111-8111-111111111111") {
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

export function ack(overrides: Partial<PubAck> = {}): PubAck {
  return { stream: SYNTHETIC_STREAM, seq: 7, duplicate: false, ...overrides };
}

export async function start(
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

export async function rejectionOf(promise: Promise<unknown>): Promise<MyelinDurablePublishError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(MyelinDurablePublishError);
    return err as MyelinDurablePublishError;
  }
  throw new Error("expected publishDurable to reject");
}

export function durable(runtime: MyelinRuntime) {
  const publishDurable = runtime.publishDurable;
  if (publishDurable === undefined) throw new Error("publishDurable missing");
  return publishDurable;
}
