// glossary-ignore: subscriber, agent, data
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ConsumerConfig, ConsumerMessages, JsMsg } from "nats";
import { DeliverPolicy } from "nats";
import { AgentConfigSchema } from "../../common/types/config";
import type { MyelinSubscribePullOpts } from "../../bus/myelin/runtime";
import { deriveNatsSubject, type Envelope } from "../../bus/myelin/envelope-validator";
import { MyelinSubscriber } from "../../bus/myelin/subscriber";
import type { NatsLink } from "../../bus/nats/connection";
import { createFakeJetStream, type FakeJetStream } from "../../bus/jetstream/__tests__/fake-jetstream";
import { LEDGER_STREAM, provisionLedgerStream } from "../../bus/jetstream/provision";
import { initDatabase } from "../../surface/mc/db/init";
import { getVigilSubject, getVigilTextsSpent, isVigilReplayPending, listVigilEvents, recordVigilTextDelivered, recordVigilTextReceipt, writeVigilTransition } from "../db";
import { flushTexts } from "../flush";
import { ingestLedgerEnvelope } from "../ingest";
import { startVigil } from "../index";
import { replayLedger } from "../replay";
import { vigilSystemPattern } from "../delivery-receipt";
import { KEY, ledgerEnvelope } from "./fixtures";

const REPLAY = "cortex-vigil-replay-jc";
const LIVE = "cortex-vigil-jc";
const OTHER_KEY = "run:flow:nightly-backup";

function receiptEnvelope(eventId: string, day = "2026-10-16") {
  return { ...ledgerEnvelope(), type: "system.vigil.text-sent", payload: {
    event_id: eventId, subject_key: "state:goal:G1", budget_day: day,
  } };
}

function config() {
  return AgentConfigSchema.parse({ claude: {}, agent: { name: "ivy", displayName: "Ivy" }, vigil: { enabled: true }, mc: { enabled: true } });
}

function quietLog() {
  return { info: mock((_msg: string) => {}), warn: mock((_msg: string) => {}) };
}

/**
 * The fake JetStream stores subjects only, so the envelopes live in
 * `ledger`, index-aligned with stream sequence. Subscribing pulls the
 * durable's undelivered messages from the fake and feeds them through a real
 * pull subscriber; the fake's pending counts clear once all are settled.
 */
function ledgerHarness() {
  const fake = createFakeJetStream();
  const ledger: { envelope: unknown; subject: string }[] = [];
  const added: Partial<ConsumerConfig>[] = [];
  const calls: { durable: string; liveConsumers: string[] }[] = [];
  const addConsumer = fake.jsm.consumers.add;
  fake.jsm.consumers.add = async (stream, cfg) => {
    added.push(cfg);
    return addConsumer(stream, cfg);
  };
  let consume = (durable: string): ConsumerMessages => {
    const start = ledger.length - fake.pull(LEDGER_STREAM, durable, { ack: false }).length;
    const envelopes = ledger.slice(start);
    let settled = 0;
    const settle = () => { settled += 1; if (settled === envelopes.length) fake.ackAll(LEDGER_STREAM, durable); };
    const deliveries = envelopes.map(({ envelope, subject }) => ({
      subject, data: new TextEncoder().encode(JSON.stringify(envelope)),
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
  const fullConsume = consume;
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
    replay(db: Database, overrides: Partial<Parameters<typeof replayLedger>[0]> = {}) {
      return replayLedger({ jsm: fake.jsm, runtime, db, principal: "jc", log: quietLog(), pollMs: 1, ...overrides });
    },
    async publish(...envelopes: unknown[]) {
      await provisionLedgerStream({ jsm: fake.jsm, principal: "jc", subjects: [vigilSystemPattern("jc", "default")], log: quietLog() });
      for (const envelope of envelopes) {
        const subject = deriveNatsSubject(envelope as Envelope, "default");
        ledger.push({ envelope, subject });
        fake.publish(subject);
      }
    },
    setConsume(fn: (durable: string) => ConsumerMessages) { consume = fn; },
    /** Delivers only the first envelope, then stalls. */
    deliverFirstOnly() {
      consume = (durable) => {
        const all = fullConsume(durable);
        return {
          async *[Symbol.asyncIterator]() { for await (const delivery of all) { yield delivery; return; } },
          close: () => all.close(),
        } as unknown as ConsumerMessages;
      };
    },
    restoreConsume() { consume = fullConsume; },
  };
}

function replayDeletes(fake: FakeJetStream) {
  return fake.consumerDeletes.filter((d) => d.durable === REPLAY);
}

describe("Vigil LEDGER replay", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => db.close());

  test("rebuilds budgets across days, deduplicates event IDs and replaces old counts on every replay", async () => {
    const h = ledgerHarness();
    const first = receiptEnvelope("first", "2026-10-15");
    await h.publish(first, receiptEnvelope("second", "2026-10-15"), receiptEnvelope("third"), first,
      receiptEnvelope("third"), receiptEnvelope("first", "2026-10-17"), ledgerEnvelope());
    recordVigilTextDelivered(db, "2026-10-14");
    recordVigilTextDelivered(db, "2026-10-16");
    for (let i = 0; i < 2; i++) {
      expect(await h.replay(db)).toBe(7);
      expect(db.query("SELECT * FROM vigil_budget ORDER BY budget_day").all()).toEqual([
        { budget_day: "2026-10-15", texts_spent: 2, digest_at: null }, { budget_day: "2026-10-16", texts_spent: 1, digest_at: null },
      ]);
      expect(db.query("SELECT COUNT(*) AS n FROM vigil_text_receipts").get()).toEqual({ n: 3 });
      expect(db.query("SELECT COUNT(*) AS n FROM vigil_events").get()).toEqual({ n: 0 });
      expect(db.query("SELECT COUNT(*) AS n FROM attention_items").get()).toEqual({ n: 0 });
    }
  });

  test("an interrupted budget replay restarts without counting prior partial deliveries again", async () => {
    const h = ledgerHarness();
    await h.publish(receiptEnvelope("first"), receiptEnvelope("second"));
    h.deliverFirstOnly();
    expect(await h.replay(db, { stallMs: 5 })).toBeNull();
    expect(getVigilTextsSpent(db, "2026-10-16")).toBe(0);
    expect(isVigilReplayPending(db)).toBe(true);
    h.restoreConsume();
    expect(await h.replay(db)).toBe(2);
    expect(getVigilTextsSpent(db, "2026-10-16")).toBe(2);
    expect(isVigilReplayPending(db)).toBe(false);
  });

  test("failed and complete replays preserve confirmed spending missing from LEDGER", async () => {
    const h = ledgerHarness();
    const first = receiptEnvelope("first");
    recordVigilTextReceipt(db, first.payload);
    recordVigilTextReceipt(db, receiptEnvelope("second").payload);
    recordVigilTextReceipt(db, receiptEnvelope("third").payload);
    await h.publish(first, first);
    h.deliverFirstOnly();
    expect(await h.replay(db, { stallMs: 5 })).toBeNull();
    expect(getVigilTextsSpent(db, "2026-10-16")).toBe(3);
    h.restoreConsume();
    expect(await h.replay(db)).toBe(2);
    expect(getVigilTextsSpent(db, "2026-10-16")).toBe(3);
  });

  test.each(["dm", "email"] as const)("%s publication failure and empty LEDGER replay retain spending without resending", async (via) => {
    const h = ledgerHarness();
    await h.publish();
    const now = Date.parse("2026-10-16T10:00:00Z");
    const key = "state:goal:G1";
    ingestLedgerEnvelope(db, ledgerEnvelope({ state: { subject: "G1", value: "on-track" } }), now, { replay: true });
    const queue = () => writeVigilTransition(db, {
      subject_key: key, from_value: "on-track", to_value: "off-track", direction: "worse",
      run_id: crypto.randomUUID(), occurred_at: now,
    }, now);
    for (let i = 0; i < 3; i++) queue();
    const send = mock(async () => via === "dm"
      ? { delivered: true, messageId: "confirmed" } as const
      : { delivered: false, kind: "permanent", code: "50007" } as const);
    const fallback = mock(async () => ({ ok: true }));
    const publish = mock(async () => { throw new Error("bus unavailable"); });
    const flush = () => flushTexts({ db, principal: "jc", now, send, fallback, publish });
    await expect(flush()).rejects.toThrow("Vigil text-sent publication failed after delivery settlement");
    expect(getVigilTextsSpent(db, "2026-10-16")).toBe(3);
    expect(await h.replay(db)).toBe(0);
    expect(getVigilTextsSpent(db, "2026-10-16")).toBe(3);
    const held = queue();
    await flush();
    expect(listVigilEvents(db, key)).toContainEqual(expect.objectContaining({ id: held.id, delivery: "held", held_reason: "budget" }));
    expect(send).toHaveBeenCalledTimes(3);
    expect(fallback).toHaveBeenCalledTimes(via === "email" ? 1 : 0);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  test("invalid text-sent payloads are skipped without spending budget", async () => {
    const h = ledgerHarness();
    const receipt = receiptEnvelope("valid");
    await h.publish({ ...receipt, payload: { ...receipt.payload, presentation: "private wording" } },
      { ...receipt, payload: { ...receipt.payload, budget_day: "2026-02-30" } }, receipt);
    const log = quietLog();
    expect(await h.replay(db, { log })).toBe(1);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(getVigilTextsSpent(db, "2026-10-16")).toBe(1);
    expect(JSON.stringify(db.query("SELECT * FROM vigil_text_receipts").all())).not.toContain("private wording");
  });

  test("budget rebuild failure rolls back receipt merging and leaves replay pending for retry", async () => {
    const h = ledgerHarness();
    const oldReceipt = receiptEnvelope("old", "2026-10-15").payload;
    recordVigilTextReceipt(db, oldReceipt);
    await h.publish(receiptEnvelope("new"));
    db.run("CREATE TRIGGER fail_rebuild BEFORE INSERT ON vigil_budget BEGIN SELECT RAISE(ABORT, 'rebuild unavailable'); END");
    expect(await h.replay(db)).toBeNull();
    expect(isVigilReplayPending(db)).toBe(true);
    expect(getVigilTextsSpent(db, "2026-10-15")).toBe(1);
    expect(getVigilTextsSpent(db, "2026-10-16")).toBe(0);
    expect(db.query("SELECT * FROM vigil_text_receipts").all()).toEqual([oldReceipt]);
    db.run("DROP TRIGGER fail_rebuild");
    expect(await h.replay(db)).toBe(1);
    expect(getVigilTextsSpent(db, "2026-10-15")).toBe(1);
    expect(getVigilTextsSpent(db, "2026-10-16")).toBe(1);
    expect(isVigilReplayPending(db)).toBe(false);
  });

  test("rebuilds the subject row from failed, failed, succeeded and writes no event", async () => {
    const h = ledgerHarness();
    const third = ledgerEnvelope({ outcome: "succeeded", ended_at: "2026-10-12T10:02:00.000Z" });
    await h.publish(ledgerEnvelope(), ledgerEnvelope({ ended_at: "2026-10-12T10:01:00.000Z" }), third);
    const log = quietLog();
    expect(await h.replay(db, { log })).toBe(3);
    expect(getVigilSubject(db, KEY)).toMatchObject({ value: "succeeded", healthy: 1, last_run_id: third.payload.run_id });
    expect(db.query("SELECT COUNT(*) AS n FROM vigil_events").get()).toEqual({ n: 0 });
    expect(h.added).toEqual([expect.objectContaining({ durable_name: REPLAY, deliver_policy: DeliverPolicy.All })]);
    expect(h.added[0]!.filter_subject).toBeUndefined();
    expect(h.calls.map((c) => c.durable)).toEqual([REPLAY]);
    expect(h.fake.consumerNames(LEDGER_STREAM)).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
    expect(isVigilReplayPending(db)).toBe(false);
  });

  test("a replay that fails after writing rows stays pending", async () => {
    const h = ledgerHarness();
    await h.publish(ledgerEnvelope(), ledgerEnvelope({ ran: { kind: "flow", ref: "nightly-backup" } }));
    h.deliverFirstOnly();
    expect(await h.replay(db, { stallMs: 5 })).toBeNull();
    expect(getVigilSubject(db, KEY)?.value).toBe("failed");
    expect(getVigilSubject(db, OTHER_KEY)).toBeNull();
    expect(isVigilReplayPending(db)).toBe(true);
  });

  test.each([
    { vocab: "goal", values: ["off-track", "at-risk", "on-track"], healthy: 1, direction: "better" },
    { vocab: "escalation", values: ["overdue", "needs-principal", "resolved"], healthy: 1, direction: "better" },
    { vocab: "check", values: ["regressed", "ok", "regressed"], healthy: 0, direction: "worse" },
    { vocab: "unknown", values: ["green", "amber", "red"], healthy: 0, direction: "worse" },
  ])("rebuilds $vocab state without events, then records a live transition", async ({ vocab, values, healthy, direction }) => {
    const h = ledgerHarness();
    const stateKey = `state:${vocab}:watched`;
    const first = ledgerEnvelope({ state: { subject: "watched", value: values[0] } });
    const second = ledgerEnvelope({
      outcome: "succeeded", ended_at: "2026-10-12T10:01:00.000Z",
      serves: { goal: "G1" }, state: { subject: "watched", value: values[1] },
    });
    await h.publish(first, second);
    expect(await h.replay(db)).toBe(2);
    expect(getVigilSubject(db, stateKey)).toMatchObject({
      subject_kind: "state", vocab, value: values[1], goal_id: "G1", last_run_id: second.payload.run_id,
    });
    expect(getVigilSubject(db, KEY)).toMatchObject({ value: "succeeded", healthy: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM vigil_events").get()).toEqual({ n: 0 });

    const live = ledgerEnvelope({
      outcome: "succeeded", ended_at: "2026-10-12T10:02:00.000Z",
      state: { subject: "watched", value: values[2] },
    });
    ingestLedgerEnvelope(db, live, Date.parse("2026-10-12T10:03:00.000Z"));
    expect(getVigilSubject(db, stateKey)).toMatchObject({ value: values[2], healthy, last_run_id: live.payload.run_id });
    expect(listVigilEvents(db, stateKey)).toEqual([expect.objectContaining({
      from_value: values[1], to_value: values[2], direction, run_id: live.payload.run_id,
    })]);
    expect(listVigilEvents(db, KEY)).toEqual([]);
  });

  test("out-of-order envelopes end at the latest ended_at", async () => {
    const h = ledgerHarness();
    const latest = ledgerEnvelope({ outcome: "succeeded", ended_at: "2026-10-12T10:02:00.000Z" });
    await h.publish(latest, ledgerEnvelope({ ended_at: "2026-10-12T10:01:00.000Z" }));
    await h.replay(db);
    expect(getVigilSubject(db, KEY)).toMatchObject({ value: "succeeded", healthy: 1, last_run_id: latest.payload.run_id });
  });

  test("an invalid envelope is skipped with one log line and replay continues", async () => {
    const h = ledgerHarness();
    const invalid = ledgerEnvelope();
    invalid.payload.outcome = "unknown";
    await h.publish(invalid, ledgerEnvelope({ outcome: "succeeded" }));
    const log = quietLog();
    expect(await h.replay(db, { log })).toBe(1);
    expect(log.warn.mock.calls.map(([msg]) => msg)).toEqual([expect.stringContaining(`${invalid.id} invalid: payload.outcome:`)]);
    expect(getVigilSubject(db, KEY)?.value).toBe("succeeded");
  });

  test("other types go to their registered replay handler and are ignored otherwise", async () => {
    const h = ledgerHarness();
    const sent = ledgerEnvelope();
    sent.type = "system.vigil.registered";
    const other = ledgerEnvelope();
    other.type = "system.vigil.unregistered";
    await h.publish(sent, other, ledgerEnvelope());
    const handler = mock((_db: Database, _envelope: unknown) => undefined);
    const log = quietLog();
    const applied = await h.replay(db, {
      log,
      handlers: new Map([["system.vigil.registered", handler]]),
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
    expect(await h.replay(db)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.fake.consumerNames(LEDGER_STREAM)).toEqual([]);
  });

  test("a replay durable left by an interrupted replay is recreated from sequence 1", async () => {
    const h = ledgerHarness();
    await h.publish(ledgerEnvelope(), ledgerEnvelope({ outcome: "succeeded", ended_at: "2026-10-12T10:01:00.000Z" }));
    await h.fake.jsm.consumers.add(LEDGER_STREAM, { durable_name: REPLAY, deliver_policy: DeliverPolicy.All });
    h.fake.pull(LEDGER_STREAM, REPLAY);
    expect(await h.replay(db)).toBe(2);
    expect(getVigilSubject(db, KEY)?.value).toBe("succeeded");
  });

  test("consumer creation failure logs one line and leaves no durable", async () => {
    const h = ledgerHarness();
    await h.publish(ledgerEnvelope());
    h.fake.jsm.consumers.add = async () => { throw new Error("no permission"); };
    const log = quietLog();
    expect(await h.replay(db, { log })).toBeNull();
    expect(log.warn.mock.calls.map(([msg]) => msg)).toEqual([expect.stringContaining("no permission")]);
    expect(h.fake.consumerNames(LEDGER_STREAM)).toEqual([]);
  });

  test("a stream read failure logs one line and deletes the replay durable", async () => {
    const h = ledgerHarness();
    await h.publish(ledgerEnvelope());
    h.setConsume(() => { throw new Error("stream read failed"); });
    const log = quietLog();
    expect(await h.replay(db, { log })).toBeNull();
    expect(log.warn.mock.calls.map(([msg]) => msg)).toEqual([expect.stringContaining("stream read failed")]);
    expect(replayDeletes(h.fake)).toHaveLength(1);
    expect(h.fake.consumerNames(LEDGER_STREAM)).toEqual([]);
  });

  test("a stalled replay gives up, logs one line and deletes the replay durable", async () => {
    const h = ledgerHarness();
    await h.publish(ledgerEnvelope());
    h.setConsume(() => ({ async *[Symbol.asyncIterator]() {}, close: async () => {} }) as unknown as ConsumerMessages);
    const log = quietLog();
    expect(await h.replay(db, { log, stallMs: 5 })).toBeNull();
    expect(log.warn.mock.calls.map(([msg]) => msg)).toEqual([expect.stringContaining("stalled with 1")]);
    expect(h.fake.consumerNames(LEDGER_STREAM)).toEqual([]);
  });
});

describe("Vigil startup replay", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => db.close());

  test("startup reconstructs receipt budgets without publishing any notifications", async () => {
    const h = ledgerHarness();
    await h.publish(receiptEnvelope("first"), receiptEnvelope("second", "2026-10-15"), ledgerEnvelope());
    const publish = mock(async (_envelope: Envelope) => {});
    const handle = await startVigil({ config: config(), db, runtime: { ...h.runtime, publish }, principal: "jc", stack: "default", log: quietLog() });
    try {
      expect(getVigilTextsSpent(db, "2026-10-16")).toBe(1);
      expect(getVigilTextsSpent(db, "2026-10-15")).toBe(1);
      expect(publish).not.toHaveBeenCalled();
      expect(db.query("SELECT COUNT(*) AS n FROM vigil_events").get()).toEqual({ n: 0 });
    } finally { await handle!.stop(); }
  });

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

  test("a replay that failed part-way is retried on the next start, with rows present", async () => {
    const h = ledgerHarness();
    await h.publish(ledgerEnvelope(), ledgerEnvelope({ ran: { kind: "flow", ref: "nightly-backup" } }));
    h.deliverFirstOnly();
    await h.replay(db, { stallMs: 5 });
    expect(getVigilSubject(db, OTHER_KEY)).toBeNull();
    h.restoreConsume();
    const handle = await startVigil({ config: config(), db, runtime: h.runtime, principal: "jc", stack: "default", log: quietLog() });
    expect(h.calls.map((c) => c.durable)).toEqual([REPLAY, REPLAY, LIVE]);
    expect(getVigilSubject(db, KEY)?.value).toBe("failed");
    expect(getVigilSubject(db, OTHER_KEY)?.value).toBe("failed");
    expect(isVigilReplayPending(db)).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM vigil_events").get()).toEqual({ n: 0 });
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
