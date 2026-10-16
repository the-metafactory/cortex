// glossary-ignore: subscriber, agent, data, persona, run
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ConsumerMessages, JsMsg } from "nats";
import { DeliverPolicy } from "nats";
import { AgentConfigSchema } from "../../common/types/config";
import { CortexConfigSchema } from "../../common/types/cortex-config";
import type { MyelinSubscribePullOpts } from "../../bus/myelin/runtime";
import { MyelinSubscriber } from "../../bus/myelin/subscriber";
import type { NatsLink } from "../../bus/nats/connection";
import { createFakeJetStream } from "../../bus/jetstream/__tests__/fake-jetstream";
import { LEDGER_STREAM } from "../../bus/jetstream/provision";
import { initDatabase } from "../../surface/mc/db/init";
import { getVigilSubject, listVigilEvents } from "../db";
import { ingestLedgerEnvelope } from "../ingest";
import { LEDGER_ACK_WAIT_NS, LEDGER_MAX_DELIVER, startVigil } from "../index";
import { ENDED_AT, KEY, SUBJECT, fakeTickScheduler, flushTick, ledgerEnvelope } from "./fixtures";

function config(vigil = true, mc = true) {
  return AgentConfigSchema.parse({ claude: {}, agent: { name: "ivy", displayName: "Ivy" }, vigil: { enabled: vigil }, mc: { enabled: mc } });
}

/** A real pull subscriber over a finite in-memory delivery source. */
function pullRuntime(fake: ReturnType<typeof createFakeJetStream>, envelopes: unknown[] = []) {
  const deliveries = envelopes.map((envelope) => ({
    subject: SUBJECT, data: new TextEncoder().encode(JSON.stringify(envelope)),
    ack: mock(() => {}), nak: mock(() => {}), term: mock(() => {}),
  }));
  let closed = false;
  let finished!: () => void;
  const delivered = new Promise<void>((resolve) => { finished = resolve; });
  const stream = {
    async *[Symbol.asyncIterator]() {
      try {
        for (const delivery of deliveries) { if (closed) break; yield delivery as unknown as JsMsg; }
      } finally { finished(); }
    },
    close: mock(async () => { closed = true; }),
  } as unknown as ConsumerMessages;
  const link = { raw: { jetstream: () => ({ consumers: { get: async () => ({ consume: async () => stream }) } }) } } as unknown as NatsLink;
  const calls: MyelinSubscribePullOpts[] = [];
  const runtime = {
    jetstreamManager: async () => fake.jsm,
    subscribePull: (opts: MyelinSubscribePullOpts) => {
      calls.push(opts);
      return MyelinSubscriber.start(link, {
        ...opts, mode: "pull", pull: { stream: opts.stream, durable: opts.durable },
      });
    },
  };
  return { runtime, calls, deliveries, delivered, stream };
}

describe("Vigil startup and delivery", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => db.close());

  test("both config schemas default Vigil off and retain explicit opt-in", () => {
    expect(AgentConfigSchema.parse({ claude: {}, agent: { name: "ivy", displayName: "Ivy" } }).vigil.enabled).toBe(false);
    const base = { principal: { id: "jc" }, agents: [{ id: "ivy", displayName: "Ivy", persona: "./ivy.md", presence: {} }], claude: {} };
    expect(CortexConfigSchema.parse(base).vigil.enabled).toBe(false);
    expect(CortexConfigSchema.parse({ ...base, vigil: { enabled: true } }).vigil.enabled).toBe(true);
    expect(config().vigil.enabled).toBe(true);
  });

  test("disabled Vigil never resolves the manager or binds a consumer", async () => {
    const manager = mock(async () => createFakeJetStream().jsm);
    const subscribePull = mock(() => null);
    expect(await startVigil({ config: config(false), db, runtime: { jetstreamManager: manager, subscribePull }, principal: "jc", stack: "default" })).toBeNull();
    expect(manager).not.toHaveBeenCalled();
    expect(subscribePull).not.toHaveBeenCalled();
  });

  test("startup sweeps with configured cadence, ticks every five minutes and cancels on stop", async () => {
    const jobKey = "run:job:harness-gate";
    const otherKey = "run:job:daily-check";
    ingestLedgerEnvelope(db, ledgerEnvelope({ ran: { kind: "job", ref: "harness-gate" }, outcome: "succeeded" }), ENDED_AT);
    ingestLedgerEnvelope(db, ledgerEnvelope({ ran: { kind: "job", ref: "daily-check" }, outcome: "succeeded" }), ENDED_AT);
    const cfg = config();
    cfg.vigil.cadence = { [jobKey]: 3_600_000 };
    const scheduler = fakeTickScheduler();
    let now = ENDED_AT + 7_200_001;
    const h = pullRuntime(createFakeJetStream());
    const handle = await startVigil({
      config: cfg, db, runtime: h.runtime, principal: "jc", stack: "default",
      now: () => now, schedule: scheduler.schedule,
    });
    try {
      await flushTick();
      expect(scheduler.intervalMs).toBe(300_000);
      expect(getVigilSubject(db, jobKey)?.value).toBe("stale");
      expect(getVigilSubject(db, otherKey)?.value).toBe("succeeded");
      now = ENDED_AT + 52 * 60 * 60 * 1000 + 1;
      scheduler.tick(); await flushTick();
      expect(getVigilSubject(db, otherKey)?.value).toBe("stale");
      expect(listVigilEvents(db, jobKey)).toHaveLength(1);
      expect(listVigilEvents(db, otherKey)).toHaveLength(1);
    } finally { await handle!.stop(); }
    await handle!.stop();
    expect(scheduler.cancellations).toBe(1);
    expect(h.stream.close).toHaveBeenCalledTimes(1);
    scheduler.tick(); await flushTick();
    expect(listVigilEvents(db, otherKey)).toHaveLength(1);
  });

  test("a sweep failure is logged and the next scheduled sweep still runs", async () => {
    const jobKey = "run:job:harness-gate";
    ingestLedgerEnvelope(db, ledgerEnvelope({ ran: { kind: "job", ref: "harness-gate" }, outcome: "succeeded" }), ENDED_AT);
    db.run("CREATE TRIGGER fail_sweep BEFORE UPDATE ON vigil_subjects BEGIN SELECT RAISE(ABORT, 'sweep failure'); END");
    const scheduler = fakeTickScheduler();
    const log = { info: mock((_msg: string) => {}), warn: mock((_msg: string) => {}) };
    const h = pullRuntime(createFakeJetStream());
    const handle = await startVigil({
      config: config(), db, runtime: h.runtime, principal: "jc", stack: "default", log,
      now: () => ENDED_AT + 52 * 60 * 60 * 1000 + 1, schedule: scheduler.schedule,
    });
    try {
      await flushTick();
      expect(log.warn.mock.calls.map(([msg]) => msg)).toEqual([expect.stringContaining("vigil: tick failed: sweep failure")]);
      expect(getVigilSubject(db, jobKey)?.value).toBe("succeeded");
      db.run("DROP TRIGGER fail_sweep");
      scheduler.tick(); await flushTick();
      expect(getVigilSubject(db, jobKey)?.value).toBe("stale");
    } finally { await handle!.stop(); }
  });

  test.each(["mc-off", "no-db", "no-manager", "null-manager", "other-stack"])("%s skips with one log line", async (gate) => {
    const fake = createFakeJetStream();
    const h = pullRuntime(fake);
    const runtime = gate === "no-manager" ? { subscribePull: h.runtime.subscribePull }
      : gate === "null-manager" ? { ...h.runtime, jetstreamManager: async () => null } : h.runtime;
    const log = { info: mock((_msg: string) => {}), warn: mock((_msg: string) => {}) };
    expect(await startVigil({
      config: config(true, gate !== "mc-off"), db: gate === "no-db" ? null : db,
      runtime, principal: "jc", stack: gate === "other-stack" ? "switch" : "default", log,
    })).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
    if (gate === "mc-off" || gate === "no-db") expect(log.warn.mock.calls[0]?.[0]).toContain("needs Mission Control");
    expect(h.calls).toEqual([]);
    await expect(fake.jsm.streams.info(LEDGER_STREAM)).rejects.toThrow("not found");
  });

  test("binds New once, resumes the durable on restart and ingests default-account envelopes", async () => {
    const fake = createFakeJetStream();
    const h = pullRuntime(fake, [ledgerEnvelope()]);
    const handle = await startVigil({ config: config(), db, runtime: h.runtime, principal: "jc", stack: "default", now: () => 100 });
    await h.delivered;
    expect(h.calls[0]).toMatchObject({ stream: LEDGER_STREAM, durable: "cortex-vigil-jc", pattern: "local.jc.*.execution.run.finished" });
    const consumer = (await fake.jsm.consumers.info(LEDGER_STREAM, "cortex-vigil-jc")).config;
    expect(consumer).toMatchObject({ deliver_policy: DeliverPolicy.New, ack_wait: LEDGER_ACK_WAIT_NS, max_deliver: LEDGER_MAX_DELIVER });
    expect(h.deliveries[0]!.ack).toHaveBeenCalledTimes(1);
    expect(getVigilSubject(db, KEY)?.last_seen_at).toBe(100);
    expect(listVigilEvents(db, KEY)).toHaveLength(1);
    expect(fake.publish(SUBJECT)).toBe(LEDGER_STREAM);
    await handle!.stop();
    await handle!.stop();
    const h2 = pullRuntime(fake);
    const second = await startVigil({ config: config(), db, runtime: h2.runtime, principal: "jc", stack: "default" });
    expect(fake.pull(LEDGER_STREAM, "cortex-vigil-jc")).toEqual([SUBJECT]);
    expect(fake.consumerNames(LEDGER_STREAM)).toEqual(["cortex-vigil-jc"]);
    await second!.stop();
  });

  test("first New bind skips stored history", async () => {
    const fake = createFakeJetStream();
    const { provisionLedgerStream } = await import("../../bus/jetstream/provision");
    await provisionLedgerStream({ jsm: fake.jsm, principal: "jc" });
    fake.publish(SUBJECT);
    // A non-empty table skips replay (covered in replay.test.ts).
    ingestLedgerEnvelope(db, ledgerEnvelope(), 100);
    const h = pullRuntime(fake);
    const handle = await startVigil({ config: config(), db, runtime: h.runtime, principal: "jc", stack: "default" });
    expect(fake.pull(LEDGER_STREAM, "cortex-vigil-jc")).toEqual([]);
    fake.publish(SUBJECT);
    expect(fake.pull(LEDGER_STREAM, "cortex-vigil-jc")).toEqual([SUBJECT]);
    await handle!.stop();
  });

  test("invalid payload or wrong type logs envelope ID and first error then ACKs", async () => {
    const invalid = ledgerEnvelope();
    invalid.payload.outcome = "unknown";
    const wrongType = ledgerEnvelope();
    wrongType.type = "execution.run.started";
    const h = pullRuntime(createFakeJetStream(), [invalid, wrongType]);
    const log = { info: mock((_msg: string) => {}), warn: mock((_msg: string) => {}) };
    const onError = mock(() => {});
    const handle = await startVigil({ config: config(), db, runtime: h.runtime, principal: "jc", stack: "default", log, onError });
    await h.delivered;
    for (const msg of h.deliveries) {
      expect(msg.ack).toHaveBeenCalledTimes(1);
      expect(msg.nak).not.toHaveBeenCalled();
      expect(msg.term).not.toHaveBeenCalled();
    }
    expect(log.warn.mock.calls.map(([msg]) => msg)).toEqual([
      expect.stringContaining(`${invalid.id} invalid: payload.outcome:`),
      expect.stringContaining(`${wrongType.id} invalid: type:`),
    ]);
    expect(onError).not.toHaveBeenCalled();
    expect(getVigilSubject(db, KEY)).toBeNull();
    expect(listVigilEvents(db, KEY)).toEqual([]);
    await handle!.stop();
  });

  test("DB failure reaches onError and NAKs; later envelope still processes", async () => {
    db.run("CREATE TRIGGER fail_vigil BEFORE INSERT ON vigil_subjects WHEN NEW.value = 'failed' BEGIN SELECT RAISE(ABORT, 'db failure'); END");
    const h = pullRuntime(createFakeJetStream(), [ledgerEnvelope(), ledgerEnvelope({ outcome: "succeeded" })]);
    const onError = mock((_err: Error, _subject: string) => {});
    const handle = await startVigil({ config: config(), db, runtime: h.runtime, principal: "jc", stack: "default", onError });
    await h.delivered;
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].message).toContain("db failure");
    expect(onError.mock.calls[0]?.[1]).toBe(SUBJECT);
    expect(h.deliveries[0]!.nak).toHaveBeenCalledTimes(1);
    expect(h.deliveries[0]!.ack).not.toHaveBeenCalled();
    expect(h.deliveries[1]!.ack).toHaveBeenCalledTimes(1);
    expect(getVigilSubject(db, KEY)?.value).toBe("succeeded");
    expect(listVigilEvents(db, KEY)).toEqual([]);
    await handle!.stop();
  });
});
