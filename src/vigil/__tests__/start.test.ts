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
import { getAttentionItem } from "../../surface/mc/db/attention";
import { handleAttentionLifecycle } from "../../surface/mc/api/attention";
import { REF_ATTENTION_TTL_MS } from "../ref-attention";
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

  test("tick silently expires proposals seven days after their last update", async () => {
    const ref = "soma:proposals/triage.md";
    const id = `att:vigil:proposal:${ref}`;
    ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", proposal_refs: [ref] }), ENDED_AT);
    const updateAt = ENDED_AT + 1000;
    ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", proposal_refs: [ref], ended_at: new Date(updateAt).toISOString() }), updateAt);
    const h = pullRuntime(createFakeJetStream());
    const scheduler = fakeTickScheduler();
    const send = mock(async () => ({ delivered: true as const, messageId: "unused" }));
    const publish = mock(async (_envelope: import("../../bus/myelin/envelope-validator").Envelope) => {});
    const log = { info: mock((_msg: string) => {}), warn: mock((_msg: string) => {}) };
    let now = ENDED_AT + REF_ATTENTION_TTL_MS;
    const handle = await startVigil({
      config: config(), db, runtime: { ...h.runtime, publish }, principal: "jc", stack: "default",
      now: () => now, schedule: scheduler.schedule, send, log,
    });
    try {
      await flushTick();
      expect(getAttentionItem(db, id)?.status).toBe("open");
      now = updateAt + REF_ATTENTION_TTL_MS - 1;
      scheduler.tick(); await flushTick();
      expect(getAttentionItem(db, id)?.status).toBe("open");
      now += 1;
      scheduler.tick(); await flushTick();
      expect(getAttentionItem(db, id)).toMatchObject({ status: "resolved", resolution: "expired" });
      const snapshot = db.query("SELECT * FROM attention_items WHERE id = ?").get(id);
      now += 1000;
      scheduler.tick(); await flushTick();
      expect(db.query("SELECT * FROM attention_items WHERE id = ?").get(id)).toEqual(snapshot);
      expect(send).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
      expect(db.query("SELECT SUM(texts_spent) AS spent FROM vigil_budget").get()).toEqual({ spent: 0 });
    } finally { await handle!.stop(); }
  });

  test("live and tick transitions publish MC deltas with the failed-dispatch notify source", async () => {
    const first = ledgerEnvelope();
    const recovery = ledgerEnvelope({ outcome: "succeeded", ended_at: "2026-10-12T10:01:05Z" });
    const h = pullRuntime(createFakeJetStream(), [first, first, recovery]);
    const publish = mock(async (_envelope: import("../../bus/myelin/envelope-validator").Envelope) => {});
    const scheduler = fakeTickScheduler();
    const handle = await startVigil({ config: config(), db, runtime: { ...h.runtime, publish }, principal: "jc", stack: "default", now: () => ENDED_AT, schedule: scheduler.schedule });
    try {
      await h.delivered;
      await flushTick();
      expect(publish.mock.calls.map(([envelope]) => envelope.type)).toEqual(["system.attention.opened", "system.attention.resolved"]);
      expect(publish.mock.calls[0]?.[0]).toMatchObject({ source: "jc.cortex.local", payload: { attention: { id: `att:vigil:${KEY}`, kind: "state_change", severity: "normal", stack_id: "default", session_id: null, work_item_id: null }, deep_link_url: null } });
      ingestLedgerEnvelope(db, ledgerEnvelope({ ran: { kind: "job", ref: "old-job" }, outcome: "succeeded", started_at: "2026-10-09T10:00:00Z", ended_at: "2026-10-09T10:00:05Z" }), ENDED_AT);
      scheduler.tick();
      await flushTick();
      expect(publish.mock.calls[2]?.[0]).toMatchObject({ type: "system.attention.opened", payload: { attention: { id: "att:vigil:run:job:old-job", severity: "normal" } } });
      scheduler.tick();
      await flushTick();
      expect(publish).toHaveBeenCalledTimes(3);
    } finally { await handle!.stop(); }
  });

  test("slow notifications preserve order without delaying acknowledgment and drain on stop", async () => {
    const h = pullRuntime(createFakeJetStream(), [ledgerEnvelope(), ledgerEnvelope({ outcome: "succeeded", ended_at: "2026-10-12T10:01:05Z" })]);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const publish = mock(async (_envelope: import("../../bus/myelin/envelope-validator").Envelope) => { await pending; });
    const scheduler = fakeTickScheduler();
    const handle = await startVigil({ config: config(), db, runtime: { ...h.runtime, publish }, principal: "jc", stack: "default", schedule: scheduler.schedule });
    try {
      await flushTick();
      expect(h.deliveries.every((delivery) => delivery.ack.mock.calls.length === 1)).toBe(true);
      expect(publish.mock.calls.map(([envelope]) => envelope.type)).toEqual(["system.attention.opened"]);
      expect(listVigilEvents(db, KEY).map((event) => event.direction)).toEqual(["worse", "better"]);
      let stopped = false;
      const stopping = handle!.stop().then(() => { stopped = true; });
      await flushTick();
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect(publish.mock.calls.map(([envelope]) => envelope.type)).toEqual(["system.attention.opened", "system.attention.resolved"]);
    } finally {
      release();
      await handle!.stop();
    }
  });

  test("notification failure is logged without undoing or redelivering a persisted transition", async () => {
    const h = pullRuntime(createFakeJetStream(), [ledgerEnvelope()]);
    const log = { info: mock((_msg: string) => {}), warn: mock((_msg: string) => {}) };
    const handle = await startVigil({ config: config(), db, runtime: { ...h.runtime, publish: async () => { throw new Error("publish unavailable"); } }, principal: "jc", stack: "default", log });
    try {
      await h.delivered;
      expect(h.deliveries[0]!.ack).toHaveBeenCalledTimes(1);
      expect(h.deliveries[0]!.nak).not.toHaveBeenCalled();
      expect(log.warn.mock.calls.map(([message]) => message)).toContain("vigil: attention notification failed: publish unavailable");
      expect(listVigilEvents(db, KEY)[0]?.attention_id).toBe(`att:vigil:${KEY}`);
    } finally { await handle!.stop(); }
  });

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

  test("adds Vigil receipt subjects to an existing LEDGER without removing its other subjects", async () => {
    const fake = createFakeJetStream();
    const { provisionLedgerStream } = await import("../../bus/jetstream/provision");
    const retained = "local.alice.lab.system.retained.>";
    await provisionLedgerStream({ jsm: fake.jsm, principal: "alice", subjects: [retained] });
    const h = pullRuntime(fake);
    const handle = await startVigil({ config: config(), db, runtime: h.runtime, principal: "alice", stack: "default" });
    try {
      expect(fake.streamSubjects(LEDGER_STREAM)).toEqual([
        "local.alice.*.execution.run.finished", "local.alice.*.vigil.attention.resolved", retained, "local.alice.default.system.vigil.>",
      ]);
      expect(fake.publish("local.alice.default.system.vigil.text-sent")).toBe(LEDGER_STREAM);
      expect(fake.publish("local.alice.lab.system.vigil.text-sent")).toBeNull();
      expect(fake.publish("local.alice.lab.execution.run.finished")).toBe(LEDGER_STREAM);
      expect(fake.publish("local.alice.default.vigil.attention.resolved")).toBe(LEDGER_STREAM);
      expect(fake.publish("local.other.default.vigil.attention.resolved")).toBeNull();
    } finally { await handle!.stop(); }
  });

  test("receipt-subject overlap rejects Vigil startup and preserves both streams", async () => {
    const fake = createFakeJetStream();
    const { provisionLedgerStream } = await import("../../bus/jetstream/provision");
    await provisionLedgerStream({ jsm: fake.jsm, principal: "alice" });
    await fake.jsm.streams.add({ name: "OTHER", subjects: ["local.alice.default.system.vigil.>"] });
    const h = pullRuntime(fake);
    await expect(startVigil({ config: config(), db, runtime: h.runtime, principal: "alice", stack: "default" })).rejects.toThrow("LEDGER required subjects not captured");
    expect(fake.streamSubjects(LEDGER_STREAM)).toEqual(["local.alice.*.execution.run.finished", "local.alice.*.vigil.attention.resolved"]);
    expect(fake.streamSubjects("OTHER")).toEqual(["local.alice.default.system.vigil.>"]);
    expect(h.calls).toEqual([]);
  });

  test("a failed resolution publish stays resolved and retries once on the next tick", async () => {
    const ref = "soma:proposals/retry.md";
    const id = `att:vigil:proposal:${ref}`;
    ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", proposal_refs: [ref] }), ENDED_AT);
    const scheduler = fakeTickScheduler();
    const h = pullRuntime(createFakeJetStream());
    const published: import("../../bus/myelin/envelope-validator").Envelope[] = [];
    const publishOnSubject = mock(async (envelope: import("../../bus/myelin/envelope-validator").Envelope) => { published.push(envelope); });
    const handle = await startVigil({ config: config(), db, runtime: { ...h.runtime, publishOnSubject }, principal: "jc", stack: "default", now: () => ENDED_AT, schedule: scheduler.schedule });
    try {
      await flushTick();
      expect(handleAttentionLifecycle(db, id, "dismiss").status).toBe(200);
      publishOnSubject.mockImplementationOnce(async (envelope) => { published.push(envelope); throw new Error("offline"); });
      scheduler.tick(); await flushTick();
      expect(getAttentionItem(db, id)).toMatchObject({ status: "dismissed", resolution: "dismissed" });
      expect(db.query("SELECT published FROM vigil_attention_resolutions").get()).toEqual({ published: 0 });
      scheduler.tick(); await flushTick();
      scheduler.tick(); await flushTick();
      expect(publishOnSubject).toHaveBeenCalledTimes(2);
      expect(published[0]).toEqual(published[1]);
      expect(db.query("SELECT published FROM vigil_attention_resolutions").get()).toEqual({ published: 1 });
    } finally { await handle!.stop(); }
  });

  test("startup sweeps with configured cadence, ticks every five minutes and cancels on stop", async () => {
    const jobKey = "run:job:harness-gate";  // glossary-ignore: run
    const otherKey = "run:job:daily-check";  // glossary-ignore: run
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
    const jobKey = "run:job:harness-gate";  // glossary-ignore: run
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

  test.each([
    { result_ref: "soma:results/daily-sweep.md" },
    { proposal_refs: ["soma:proposals/first.md", "soma:proposals/second.md"] },
    { result_ref: "soma:results/daily-sweep.md", proposal_refs: ["soma:proposals/first.md"] },
  ])("succeeded run with %j ACKs and records run state without invalid warnings", async (refs) => {
    ingestLedgerEnvelope(db, ledgerEnvelope(), 50);
    const envelope = ledgerEnvelope({ outcome: "succeeded", ended_at: "2026-10-12T10:01:05.000Z" });
    Object.assign(envelope.payload, refs);
    const h = pullRuntime(createFakeJetStream(), [envelope]);
    const log = { info: mock((_msg: string) => {}), warn: mock((_msg: string) => {}) };
    const onError = mock(() => {});
    const handle = await startVigil({ config: config(), db, runtime: h.runtime, principal: "jc", stack: "default", log, onError, now: () => 100 });
    try {
      await h.delivered;
      expect(h.deliveries[0]!.ack).toHaveBeenCalledTimes(1);
      expect(h.deliveries[0]!.nak).not.toHaveBeenCalled();
      expect(h.deliveries[0]!.term).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(getVigilSubject(db, KEY)).toMatchObject({
        value: "succeeded", healthy: 1, last_run_id: envelope.payload.run_id,
        last_ended_at: ENDED_AT + 60_000, last_seen_at: 100,
      });
      expect(listVigilEvents(db, KEY)).toHaveLength(2);
      expect(listVigilEvents(db, KEY)[1]).toMatchObject({
        from_value: "failed", to_value: "succeeded", direction: "better", run_id: envelope.payload.run_id,
      });
    } finally {
      await handle!.stop();
    }
  });

  test.each([
    { field: "result_ref", value: "soma:results/daily-sweep.md" },
    { field: "proposal_refs", value: ["soma:proposals/first.md"] },
  ])("failed run with $field logs invalid and ACKs without changing state", async ({ field, value }) => {
    ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded" }), 50);
    const prior = getVigilSubject(db, KEY);
    const envelope = ledgerEnvelope({ ended_at: "2026-10-12T10:01:05.000Z" });
    Object.assign(envelope.payload, { [field]: value });
    const h = pullRuntime(createFakeJetStream(), [envelope]);
    const log = { info: mock((_msg: string) => {}), warn: mock((_msg: string) => {}) };
    const onError = mock(() => {});
    const handle = await startVigil({ config: config(), db, runtime: h.runtime, principal: "jc", stack: "default", log, onError });
    try {
      await h.delivered;
      expect(h.deliveries[0]!.ack).toHaveBeenCalledTimes(1);
      expect(h.deliveries[0]!.nak).not.toHaveBeenCalled();
      expect(h.deliveries[0]!.term).not.toHaveBeenCalled();
      expect(log.warn.mock.calls.map(([msg]) => msg)).toEqual([
        `vigil: envelope ${envelope.id} invalid: payload.${field}: is only allowed when outcome is succeeded`,
      ]);
      expect(onError).not.toHaveBeenCalled();
      expect(getVigilSubject(db, KEY)).toEqual(prior);
      expect(listVigilEvents(db, KEY)).toEqual([]);
    } finally {
      await handle!.stop();
    }
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
