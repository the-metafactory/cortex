// glossary-ignore: subscriber, agent
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ConsumerConfig, ConsumerMessages, JsMsg } from "nats";
import { DeliverPolicy } from "nats";
import { AgentConfigSchema } from "../../common/types/config";
import type { MyelinSubscribePullOpts } from "../../bus/myelin/runtime";
import { MyelinSubscriber } from "../../bus/myelin/subscriber";
import type { NatsLink } from "../../bus/nats/connection";
import { createFakeJetStream, type FakeJetStream } from "../../bus/jetstream/__tests__/fake-jetstream";
import { LEDGER_STREAM, provisionLedgerStream } from "../../bus/jetstream/provision";
import { initDatabase } from "../../surface/mc/db/init";
import { getVigilSubject } from "../db";
import { ingestLedgerEnvelope } from "../ingest";
import { startVigil } from "../index";
import { replayLedger } from "../replay";
import { KEY, SUBJECT, ledgerEnvelope } from "./fixtures";

const REPLAY = "cortex-vigil-replay-jc";
const LIVE = "cortex-vigil-jc";

function config() {
  return AgentConfigSchema.parse({ claude: {}, agent: { name: "ivy", displayName: "Ivy" }, vigil: { enabled: true }, mc: { enabled: true } });
}

function quietLog() {
  return { info: mock((_msg: string) => {}), warn: mock((_msg: string) => {}) };
}

/**
 * The fake JetStream stores subjects only, so the envelope bodies live in
 * `ledger`, index-aligned with stream sequence. Subscribing pulls the
 * durable's undelivered messages from the fake and feeds them through a real
 * pull subscriber; the fake's pending counts clear once all are settled.
 */
function ledgerHarness() {
  const fake = createFakeJetStream();
  const ledger: unknown[] = [];
  const added: Partial<ConsumerConfig>[] = [];
  const calls: { durable: string; liveConsumers: string[] }[] = [];
  const addConsumer = fake.jsm.consumers.add;
  fake.jsm.consumers.add = async (stream, cfg) => {
    added.push(cfg);
    return addConsumer(stream, cfg);
  };
  let consume = (durable: string): ConsumerMessages => {
    const start = ledger.length - fake.pull(LEDGER_STREAM, durable, { ack: false }).length;
    const bodies = ledger.slice(start);
    let settled = 0;
    const settle = () => { settled += 1; if (settled === bodies.length) fake.ackAll(LEDGER_STREAM, durable); };
    const deliveries = bodies.map((body) => ({
      subject: SUBJECT, data: new TextEncoder().encode(JSON.stringify(body)),
      ack: mock(settle), nak: mock(settle), term: mock(settle),
    }));
    let closed = false;
    return {
      async *[Symbol.asyncIterator]() {
        for (const delivery of deliveries) { if (closed) break; yield delivery as unknown as JsMsg; }
      },
      close: async () => { closed = true; },
    } as unknown as ConsumerMessages;
  };
  const runtime = {
    jetstreamManager: async () => fake.jsm,
    subscribePull: (opts: MyelinSubscribePullOpts) => {
      calls.push({ durable: opts.durable, liveConsumers: fake.consumerNames(LEDGER_STREAM) });
      const link = { raw: { jetstream: () => ({ consumers: { get: async () => ({ consume: async () => consume(opts.durable) }) } }) } } as unknown as NatsLink;
      return MyelinSubscriber.start(link, { ...opts, mode: "pull", pull: { stream: opts.stream, durable: opts.durable } });
    },
  };
  return {
    fake, runtime, added, calls,
    async publish(...envelopes: unknown[]) {
      await provisionLedgerStream({ jsm: fake.jsm, principal: "jc", log: quietLog() });
      for (const envelope of envelopes) { ledger.push(envelope); fake.publish(SUBJECT); }
    },
    setConsume(fn: (durable: string) => ConsumerMessages) { consume = fn; },
  };
}

function replayDeletes(fake: FakeJetStream) {
  return fake.consumerDeletes.filter((d) => d.durable === REPLAY);
}

describe("Vigil LEDGER replay", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => db.close());

  test("rebuilds the subject row from failed, failed, succeeded and writes no event", async () => {
    const h = ledgerHarness();
    const third = ledgerEnvelope({ outcome: "succeeded", ended_at: "2026-10-12T10:02:00.000Z" });
    await h.publish(ledgerEnvelope(), ledgerEnvelope({ ended_at: "2026-10-12T10:01:00.000Z" }), third);
    const log = quietLog();
    expect(await replayLedger({ jsm: h.fake.jsm, runtime: h.runtime, db, principal: "jc", log, pollMs: 1 })).toBe(3);
    expect(getVigilSubject(db, KEY)).toMatchObject({ value: "succeeded", healthy: 1, last_run_id: third.payload.run_id });
    expect(db.query("SELECT COUNT(*) AS n FROM vigil_events").get()).toEqual({ n: 0 });
    expect(h.added).toEqual([expect.objectContaining({ durable_name: REPLAY, deliver_policy: DeliverPolicy.All })]);
    expect(h.added[0]!.filter_subject).toBeUndefined();
    expect(h.calls.map((c) => c.durable)).toEqual([REPLAY]);
    expect(h.fake.consumerNames(LEDGER_STREAM)).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("out-of-order envelopes end at the latest ended_at", async () => {
    const h = ledgerHarness();
    const latest = ledgerEnvelope({ outcome: "succeeded", ended_at: "2026-10-12T10:02:00.000Z" });
    await h.publish(latest, ledgerEnvelope({ ended_at: "2026-10-12T10:01:00.000Z" }));
    await replayLedger({ jsm: h.fake.jsm, runtime: h.runtime, db, principal: "jc", log: quietLog(), pollMs: 1 });
    expect(getVigilSubject(db, KEY)).toMatchObject({ value: "succeeded", healthy: 1, last_run_id: latest.payload.run_id });
  });

  test("an invalid envelope is skipped with one log line and replay continues", async () => {
    const h = ledgerHarness();
    const invalid = ledgerEnvelope();
    invalid.payload.outcome = "unknown";
    await h.publish(invalid, ledgerEnvelope({ outcome: "succeeded" }));
    const log = quietLog();
    expect(await replayLedger({ jsm: h.fake.jsm, runtime: h.runtime, db, principal: "jc", log, pollMs: 1 })).toBe(1);
    expect(log.warn.mock.calls.map(([msg]) => msg)).toEqual([expect.stringContaining(`${invalid.id} invalid: payload.outcome:`)]);
    expect(getVigilSubject(db, KEY)?.value).toBe("succeeded");
  });

  test("other types go to their registered replay handler and are ignored otherwise", async () => {
    const h = ledgerHarness();
    const sent = ledgerEnvelope();
    sent.type = "system.vigil.text-sent";
    const other = ledgerEnvelope();
    other.type = "system.vigil.unregistered";
    await h.publish(sent, other, ledgerEnvelope());
    const handler = mock((_db: Database, _envelope: unknown) => {});
    const log = quietLog();
    const applied = await replayLedger({
      jsm: h.fake.jsm, runtime: h.runtime, db, principal: "jc", log, pollMs: 1,
      handlers: new Map([["system.vigil.text-sent", handler]]),
    });
    expect(applied).toBe(2);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[1]).toMatchObject({ id: sent.id });
    expect(getVigilSubject(db, KEY)?.value).toBe("failed");
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("an empty stream finishes without binding a subscriber", async () => {
    const h = ledgerHarness();
    await h.publish();
    expect(await replayLedger({ jsm: h.fake.jsm, runtime: h.runtime, db, principal: "jc", log: quietLog() })).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.fake.consumerNames(LEDGER_STREAM)).toEqual([]);
  });

  test("a replay durable left by an interrupted run is recreated from sequence 1", async () => {
    const h = ledgerHarness();
    await h.publish(ledgerEnvelope(), ledgerEnvelope({ outcome: "succeeded", ended_at: "2026-10-12T10:01:00.000Z" }));
    await h.fake.jsm.consumers.add(LEDGER_STREAM, { durable_name: REPLAY, deliver_policy: DeliverPolicy.All });
    h.fake.pull(LEDGER_STREAM, REPLAY);
    expect(await replayLedger({ jsm: h.fake.jsm, runtime: h.runtime, db, principal: "jc", log: quietLog(), pollMs: 1 })).toBe(2);
    expect(getVigilSubject(db, KEY)?.value).toBe("succeeded");
  });

  test("consumer creation failure logs one line and leaves no durable", async () => {
    const h = ledgerHarness();
    await h.publish(ledgerEnvelope());
    h.fake.jsm.consumers.add = async () => { throw new Error("no permission"); };
    const log = quietLog();
    expect(await replayLedger({ jsm: h.fake.jsm, runtime: h.runtime, db, principal: "jc", log })).toBeNull();
    expect(log.warn.mock.calls.map(([msg]) => msg)).toEqual([expect.stringContaining("no permission")]);
    expect(h.fake.consumerNames(LEDGER_STREAM)).toEqual([]);
  });

  test("a stream read failure logs one line and deletes the replay durable", async () => {
    const h = ledgerHarness();
    await h.publish(ledgerEnvelope());
    h.setConsume(() => { throw new Error("stream read failed"); });
    const log = quietLog();
    expect(await replayLedger({ jsm: h.fake.jsm, runtime: h.runtime, db, principal: "jc", log })).toBeNull();
    expect(log.warn.mock.calls.map(([msg]) => msg)).toEqual([expect.stringContaining("stream read failed")]);
    expect(replayDeletes(h.fake)).toHaveLength(1);
    expect(h.fake.consumerNames(LEDGER_STREAM)).toEqual([]);
  });

  test("a stalled replay gives up, logs one line and deletes the replay durable", async () => {
    const h = ledgerHarness();
    await h.publish(ledgerEnvelope());
    h.setConsume(() => ({ async *[Symbol.asyncIterator]() {}, close: async () => {} }) as unknown as ConsumerMessages);
    const log = quietLog();
    expect(await replayLedger({ jsm: h.fake.jsm, runtime: h.runtime, db, principal: "jc", log, pollMs: 1, stallMs: 5 })).toBeNull();
    expect(log.warn.mock.calls.map(([msg]) => msg)).toEqual([expect.stringContaining("stalled with 1")]);
    expect(h.fake.consumerNames(LEDGER_STREAM)).toEqual([]);
  });
});

describe("Vigil startup replay", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => db.close());

  test("an empty table replays before the live consumer is bound", async () => {
    const h = ledgerHarness();
    await h.publish(ledgerEnvelope(), ledgerEnvelope({ outcome: "succeeded", ended_at: "2026-10-12T10:01:00.000Z" }));
    const handle = await startVigil({ config: config(), db, runtime: h.runtime, principal: "jc", stack: "default", log: quietLog() });
    expect(h.calls).toEqual([
      { durable: REPLAY, liveConsumers: [LIVE, REPLAY] },
      { durable: LIVE, liveConsumers: [LIVE] },
    ]);
    expect(getVigilSubject(db, KEY)?.value).toBe("succeeded");
    expect(db.query("SELECT COUNT(*) AS n FROM vigil_events").get()).toEqual({ n: 0 });
    await handle!.stop();
  });

  test("a non-empty table runs no replay", async () => {
    const h = ledgerHarness();
    await h.publish(ledgerEnvelope());
    ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded" }), 100);
    const handle = await startVigil({ config: config(), db, runtime: h.runtime, principal: "jc", stack: "default", log: quietLog() });
    expect(h.calls.map((c) => c.durable)).toEqual([LIVE]);
    expect(h.added.map((cfg) => cfg.durable_name)).toEqual([LIVE]);
    await handle!.stop();
  });

  test("a failed replay does not block boot: the live consumer binds on an empty table", async () => {
    const h = ledgerHarness();
    await h.publish(ledgerEnvelope());
    const add = h.fake.jsm.consumers.add;
    h.fake.jsm.consumers.add = async (stream, cfg) => {
      if (cfg.durable_name === REPLAY) throw new Error("no permission");
      return add(stream, cfg);
    };
    const log = quietLog();
    const handle = await startVigil({ config: config(), db, runtime: h.runtime, principal: "jc", stack: "default", log });
    expect(handle).not.toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(h.calls.map((c) => c.durable)).toEqual([LIVE]);
    expect(getVigilSubject(db, KEY)).toBeNull();
    await handle!.stop();
  });
});
