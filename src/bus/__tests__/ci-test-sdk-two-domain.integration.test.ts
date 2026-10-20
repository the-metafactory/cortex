import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createUser } from "@nats-io/nkeys";
import { getPublicKeyAsync } from "@noble/ed25519";
import { createInMemoryRegistry, verifyEnvelopeIdentity } from "@the-metafactory/myelin/identity";
import { AckPolicy, nanos, StorageType } from "nats";
import {
  getSignedByChain,
  startMyelinRuntime,
  validateEnvelope,
  type Envelope,
  type MyelinRuntime,
  type MyelinRuntimeOptions,
  type MyelinSubscribePullOpts,
} from "../index";
import { natsServerBinary, startTwoDomainBroker, waitFor } from "./two-domain-broker";

const STREAM = "SYNTHETIC_WORK";
const DURABLE = "synthetic-worker";
const SUBJECT = "local.synthetic.beta.tasks.ci-test";
const ACK_WAIT_MS = 600;
const SIGNER = "did:mf:synthetic-worker";
const suite = natsServerBinary ? describe : describe.skip;
const reason = natsServerBinary ? "" : " (SKIPPED: nats-server binary unavailable on PATH)";
if (!natsServerBinary) console.warn(`ci-test SDK two-domain integration${reason}`);

function envelope(): Envelope {
  return {
    id: crypto.randomUUID(),
    source: "synthetic.beta.worker",
    type: "tasks.ci-test",
    timestamp: new Date().toISOString(),
    sovereignty: { classification: "local", data_residency: "NZ", max_hop: 0, frontier_ok: true, model_class: "any" },
    payload: { task: "synthetic" },
  };
}

async function fixture() {
  const runtimes: MyelinRuntime[] = [];
  const seed = (createUser() as unknown as { getRawSeed(): Uint8Array }).getRawSeed();
  const registry = createInMemoryRegistry();
  registry.add({
    id: SIGNER,
    network: "synthetic",
    type: "service",
    public_key: Buffer.from(await getPublicKeyAsync(seed)).toString("base64"),
    created_at: new Date().toISOString(),
  });
  const broker = await startTwoDomainBroker();
  const start = async (options: MyelinRuntimeOptions = {}) => {
    const config = {
      agent: { name: "synthetic", displayName: "Synthetic" },
      nats: { url: broker.url, name: "synthetic-sdk", subjects: [] },
    } as unknown as Parameters<typeof startMyelinRuntime>[0];
    const runtime = await startMyelinRuntime(config, {
      jetstreamDomain: "beta",
      stack: "beta",
      signer: { rawSeedBytes: seed, principal: SIGNER },
      ...options,
    });
    runtimes.push(runtime);
    expect(runtime.enabled).toBe(true);
    return runtime;
  };
  const stop = async () => {
    try {
      for (const runtime of runtimes) await runtime.stop();
    } finally {
      await broker.stop();
      expect(existsSync(broker.root)).toBe(false);
    }
  };
  return { ...broker, registry, start, stop };
}

async function provision(f: Awaited<ReturnType<typeof fixture>>, overlap = false) {
  await f.alpha.streams.add({ name: STREAM, subjects: [overlap ? SUBJECT : "local.synthetic.alpha.tasks.>"], storage: StorageType.File });
  await f.beta.streams.add({ name: STREAM, subjects: [SUBJECT], storage: StorageType.File, no_ack: overlap });
  for (const manager of [f.alpha, f.beta]) {
    await manager.consumers.add(STREAM, {
      durable_name: DURABLE,
      ack_policy: AckPolicy.Explicit,
      ack_wait: nanos(ACK_WAIT_MS),
      max_ack_pending: 1,
    });
  }
}

function publish(runtime: MyelinRuntime, value = envelope(), expectedStream = STREAM) {
  if (!runtime.publishDurable) throw new Error("public runtime.publishDurable missing");
  return runtime.publishDurable(value, { expectedStream, timeoutMs: 2_000 });
}

async function subscribe(runtime: MyelinRuntime, onEnvelope: MyelinSubscribePullOpts["onEnvelope"]) {
  const sub = runtime.subscribePull?.({
    pattern: SUBJECT, stream: STREAM, durable: DURABLE,
    maxMessages: 1, maxConcurrent: 2, expiresMs: 1_000, onEnvelope,
    onError: (error) => { throw error; },
  });
  if (!sub) throw new Error("public runtime.subscribePull unavailable");
  await sub.ready;
  return sub;
}

suite(`ci-test SDK on two connected disposable JetStream domains${reason}`, () => {
  test("disjoint subjects isolate signed durable storage and domain-bound pulls", async () => {
    const f = await fixture();
    try {
      await provision(f);
      const runtime = await f.start();
      const alphaRuntime = await f.start({ jetstreamDomain: "alpha" });
      const betaSeen: Envelope[] = [];
      const alphaSeen: Envelope[] = [];
      await subscribe(runtime, (value) => { betaSeen.push(value); });
      await subscribe(alphaRuntime, (value) => { alphaSeen.push(value); });
      const value = envelope();
      const ack = await publish(runtime, value);
      expect(ack).toMatchObject({ stream: STREAM, domain: "beta", seq: 1, duplicate: false });
      await waitFor("beta delivery acknowledged", async () => {
        const info = await f.beta.consumers.info(STREAM, DURABLE);
        return betaSeen.length === 1 && info.num_ack_pending === 0;
      });
      const stored = await f.beta.streams.getMessage(STREAM, { seq: ack.seq });
      expect(stored.subject).toBe(SUBJECT);
      const parsed = validateEnvelope(JSON.parse(new TextDecoder().decode(stored.data)));
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      expect(parsed.envelope.id).toBe(value.id);
      expect(parsed.envelope.payload).toEqual(value.payload);
      expect(betaSeen).toEqual([parsed.envelope]);
      expect(getSignedByChain(parsed.envelope)).toMatchObject([{ method: "ed25519", identity: SIGNER }]);
      expect((await verifyEnvelopeIdentity(parsed.envelope as Parameters<typeof verifyEnvelopeIdentity>[0], f.registry)).status).toBe("verified");
      expect(await publish(runtime, value)).toMatchObject({ stream: STREAM, domain: "beta", seq: ack.seq, duplicate: true });
      expect((await f.beta.streams.info(STREAM)).state.messages).toBe(1);
      expect((await f.alpha.streams.info(STREAM)).state.messages).toBe(0);
      expect((await f.alpha.consumers.info(STREAM, DURABLE)).delivered.consumer_seq).toBe(0);
      expect(alphaSeen).toEqual([]);
    } finally { await f.stop(); }
  }, 20_000);

  test("overlap is a topology violation detected by a foreign PubAck, not prevented storage", async () => {
    const f = await fixture();
    try {
      await provision(f, true);
      const runtime = await f.start();
      expect((await f.beta.streams.info(STREAM)).config.no_ack).toBe(true);
      await expect(publish(runtime)).rejects.toMatchObject({
        kind: "domain-mismatch",
        message: expect.stringContaining('acknowledged by domain "alpha", expected "beta"'),
      });
      await waitFor("both overlapping streams store despite rejection", async () =>
        (await f.alpha.streams.info(STREAM)).state.messages === 1 &&
        (await f.beta.streams.info(STREAM)).state.messages === 1,
      );
      const alpha = await f.alpha.streams.getMessage(STREAM, { seq: 1 });
      const beta = await f.beta.streams.getMessage(STREAM, { seq: 1 });
      expect(alpha.data).toEqual(beta.data);
    } finally { await f.stop(); }
  }, 20_000);

  test.each([
    { working: true, scenario: "working() extends a long handler and holds the sole pending slot" },
    { working: false, scenario: "a long handler without working() is redelivered (control)" },
  ])("$scenario", async ({ working }) => {
    const f = await fixture();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      await provision(f);
      const runtime = await f.start();
      const first = envelope();
      const second = envelope();
      const seen: string[] = [];
      await publish(runtime, first);
      await publish(runtime, second);
      let firstStartedAt = 0;
      await subscribe(runtime, async (value, _subject, ctx) => {
        seen.push(value.id);
        if (seen.length === 1) {
          firstStartedAt = performance.now();
          if (working) {
            ctx.working();
            heartbeat = setInterval(() => ctx.working(), ACK_WAIT_MS / 6);
          }
          await gate;
          if (heartbeat) clearInterval(heartbeat);
        }
      });
      await waitFor("first handler started", () => seen.length === 1);
      const config = (await f.beta.consumers.info(STREAM, DURABLE)).config;
      expect(config.max_ack_pending).toBe(1);
      expect(config.ack_wait).toBe(nanos(ACK_WAIT_MS));
      if (working) {
        const consumer = await f.nc.jetstream({ domain: "beta" }).consumers.get(STREAM, DURABLE);
        const competingPull = await consumer.fetch({ max_messages: 1, expires: ACK_WAIT_MS * 4 });
        const competing: string[] = [];
        for await (const message of competingPull) {
          competing.push(message.string());
          message.ack();
        }
        expect(performance.now() - firstStartedAt).toBeGreaterThan(ACK_WAIT_MS * 3);
        expect(competing).toEqual([]);
        expect(seen).toEqual([first.id]);
        const info = await f.beta.consumers.info(STREAM, DURABLE);
        expect(info.num_ack_pending).toBe(1);
        expect(info.num_pending).toBe(1);
        expect(info.delivered.consumer_seq).toBe(1);
        expect(info.num_redelivered).toBe(0);
      } else {
        await waitFor("same envelope redelivered while original handler remains unacknowledged", () =>
          seen.filter((id) => id === first.id).length >= 2 &&
          performance.now() - firstStartedAt >= ACK_WAIT_MS * 2,
        );
        expect(performance.now() - firstStartedAt).toBeGreaterThanOrEqual(ACK_WAIT_MS);
        expect(seen.slice(0, 2)).toEqual([first.id, first.id]);
      }
      release();
      await waitFor("second message delivered and acknowledged after first settles", async () =>
        seen.includes(second.id) && (await f.beta.consumers.info(STREAM, DURABLE)).num_ack_pending === 0,
      );
      expect(seen.filter((id) => id === first.id)).toHaveLength(working ? 1 : 2);
      expect(seen.filter((id) => id === second.id)).toHaveLength(1);
    } finally {
      release();
      if (heartbeat) clearInterval(heartbeat);
      await f.stop();
    }
  }, 20_000);

  test("wrong expectedStream, missing signer and stopped runtime reject without storing", async () => {
    const f = await fixture();
    try {
      await provision(f);
      const signed = await f.start();
      await expect(publish(signed, envelope(), "WRONG_STREAM")).rejects.toMatchObject({ kind: "jetstream-error" });
      const unsigned = await f.start({ signer: undefined });
      await expect(publish(unsigned)).rejects.toMatchObject({ kind: "no-signer" });
      await signed.stop();
      await expect(publish(signed)).rejects.toMatchObject({ kind: "stopped" });
      expect((await f.beta.streams.info(STREAM)).state.messages).toBe(0);
      expect((await f.alpha.streams.info(STREAM)).state.messages).toBe(0);
    } finally { await f.stop(); }
  }, 20_000);
});
