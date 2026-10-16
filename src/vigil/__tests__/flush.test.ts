import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { MockAdapter } from "../../adapters/mock";
import { notifyWithResult } from "../../adapters/notify-result";
import type { NotifyResult } from "../../adapters/types";
import { initDatabase } from "../../surface/mc/db/init";
import { budgetDay } from "../budget";
import { getVigilTextsSpent, listVigilEvents, recordVigilTextDelivered, writeVigilTransition } from "../db";
import { flushTexts, type FlushTextsOptions, type VigilFallbackText } from "../flush";
import { ingestLedgerEnvelope } from "../ingest";
import { ENDED_AT, ledgerEnvelope } from "./fixtures";

const NOW = Date.parse("2026-10-16T10:00:00Z");
const KEY = "state:goal:G1";
const success: NotifyResult = { delivered: true, messageId: "message" };
const transient: NotifyResult = { delivered: false, kind: "transient", code: "network" };
const permanent: NotifyResult = { delivered: false, kind: "permanent", code: "50007" };
let db: Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  ingestLedgerEnvelope(db, ledgerEnvelope({ state: { subject: "G1", value: "on-track" } }), ENDED_AT, { replay: true });
});
afterEach(() => db.close());

function queue(id = "event", occurredAt = NOW) {
  return writeVigilTransition(db, {
    subject_key: KEY, from_value: "on-track", to_value: "off-track", direction: "worse",
    run_id: id, occurred_at: occurredAt,
  }, NOW);
}

function sender(result: NotifyResult = success) {
  const adapter = new MockAdapter();
  adapter.notifyPrincipalResult = result;
  return mock((text: string) => notifyWithResult(adapter, text));
}

const rows = () => listVigilEvents(db, KEY);
const spent = (now = NOW) => getVigilTextsSpent(db, budgetDay(now));
const flush = (options: Partial<Omit<FlushTextsOptions, "db">> = {}) => flushTexts({ db, now: NOW, send: sender(), ...options });

test("sends the three oldest texts, holds the fourth and leaves terminal and digest rows alone", async () => {
  for (const i of [4, 2, 1, 3]) queue(String(i), NOW - (5 - i) * 1000);
  const ignored = queue("digest");
  db.query("UPDATE vigil_events SET route = 'digest' WHERE id = ?").run(ignored.id);
  const sent = queue("already-sent");
  db.query("UPDATE vigil_events SET delivery = 'sent' WHERE id = ?").run(sent.id);
  const send = sender();
  await flush({ send, render: async (event) => String(event.occurred_at) });
  expect(send.mock.calls.map(([text]) => text)).toEqual([NOW - 4000, NOW - 3000, NOW - 2000].map(String));
  for (const row of rows().filter((row) => ["1", "2", "3"].includes(row.run_id))) {
    expect(row).toMatchObject({ delivery: "sent", sent_at: NOW, via: "dm", attempts: 1, last_error: null });
  }
  expect(rows().find((row) => row.run_id === "4")).toMatchObject({ delivery: "held", held_reason: "budget", attempts: 0 });
  expect(rows().find((row) => row.id === ignored.id)).toMatchObject({ delivery: "pending", attempts: 0 });
  expect(spent()).toBe(3);
  await flush({ send });
  expect(send).toHaveBeenCalledTimes(3);
  expect(spent()).toBe(3);
});

test.each(["2026-10-16T21:00:00Z", "2026-10-17T04:59:59Z"])("quiet hours at %s hold without rendering, attempting or spending", async (time) => {
  queue();
  const send = sender(permanent);
  const render = mock(async () => "private wording");
  const fallback = mock(async () => {});
  await flush({ now: Date.parse(time), send, render, fallback });
  expect(rows()[0]).toMatchObject({ delivery: "held", held_reason: "quiet", attempts: 0, via: null, sent_at: null });
  expect(send).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
  expect(fallback).not.toHaveBeenCalled();
  expect(spent()).toBe(0);
});

test("07:00 Zurich uses the new budget day while yesterday's held texts remain for digest", async () => {
  for (let i = 0; i < 3; i++) recordVigilTextDelivered(db, budgetDay(NOW));
  queue("yesterday");
  await flush();
  queue("today");
  const nextDay = Date.parse("2026-10-17T05:00:00Z");
  await flush({ now: nextDay });
  expect(rows().map((row) => row.delivery)).toEqual(["held", "sent"]);
  expect(spent()).toBe(3);
  expect(spent(nextDay)).toBe(1);
});

test("transient failures stay pending and the third consecutive failure joins fallback", async () => {
  queue();
  const send = sender(transient);
  const batches: (readonly VigilFallbackText[])[] = [];
  const fallback = async (batch: readonly VigilFallbackText[]) => { batches.push(batch); };
  for (let attempts = 1; attempts <= 3; attempts++) {
    await flush({ send, fallback, readChannelHealth: () => "ok" });
    expect(rows()[0]).toMatchObject({ delivery: "pending", attempts, transient_failures: attempts, last_error: "network", sent_at: null, via: null });
    expect(spent()).toBe(0);
    expect(batches).toHaveLength(attempts === 3 ? 1 : 0);
  }
  expect(batches[0]?.[0]?.event).toEqual(rows()[0]);
  expect(send).toHaveBeenCalledTimes(3);
  await flush();
  expect(rows()[0]).toMatchObject({ delivery: "sent", attempts: 4, transient_failures: 0, last_error: null, via: "dm" });
  expect(spent()).toBe(1);
});

test("permanent failures reset the consecutive transient streak", async () => {
  queue();
  const fallback = mock(async () => {});
  for (const result of [transient, transient, permanent, transient, transient]) await flush({ send: sender(result), fallback });
  expect(rows()[0]).toMatchObject({ attempts: 5, transient_failures: 2 });
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(spent()).toBe(0);
});

test("permanent failures form one ordered fallback batch; unavailable fallback preserves pending events", async () => {
  queue("later", NOW + 1);
  queue("earlier", NOW);
  const fallback = mock(async (_batch: readonly VigilFallbackText[]) => {});
  await flush({ send: sender(permanent), fallback, render: async (event) => String(event.occurred_at) });
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(fallback.mock.calls[0]?.[0].map((item) => item.event.run_id)).toEqual(["earlier", "later"]);
  expect(fallback.mock.calls[0]?.[0].map((item) => item.text)).toEqual([String(NOW), String(NOW + 1)]);
  await flush({ send: sender(permanent) });
  expect(rows().every((row) => row.delivery === "pending" && row.last_error === "50007" && row.attempts === 2)).toBe(true);
  expect(spent()).toBe(0);
});

test("no adapter is a counted permanent no-adapter failure for every pending text", async () => {
  queue("first");
  queue("second");
  const fallback = mock(async (_batch: readonly VigilFallbackText[]) => {});
  await flush({ send: null, fallback });
  expect(rows().every((row) => row.delivery === "pending" && row.last_error === "no-adapter" && row.attempts === 1)).toBe(true);
  expect(fallback.mock.calls[0]?.[0]).toHaveLength(2);
  expect(spent()).toBe(0);
});

test("regressed channel still attempts DM and falls back after the first transient failure", async () => {
  queue();
  const send = sender(transient);
  const fallback = mock(async () => {});
  await flush({ send, fallback, readChannelHealth: () => "regressed" });
  expect(send).toHaveBeenCalledTimes(1);
  expect(fallback).toHaveBeenCalledTimes(1);
  await flush({ readChannelHealth: () => "regressed", fallback });
  expect(rows()[0]).toMatchObject({ delivery: "sent", via: "dm", attempts: 2 });
  expect(fallback).toHaveBeenCalledTimes(1);
});

test("never-settling and throwing adapters become retryable timeout and exception outcomes", async () => {
  queue();
  const adapter = new MockAdapter();
  adapter.notifyPrincipal = () => new Promise<NotifyResult>(() => {});
  await flush({ send: (text) => notifyWithResult(adapter, text, { timeoutMs: 5 }) });
  expect(rows()[0]).toMatchObject({ delivery: "pending", attempts: 1, last_error: "timeout" });
  adapter.notifyPrincipal = () => { throw new Error("delivery unavailable"); };
  await flush({ send: (text) => notifyWithResult(adapter, text) });
  expect(rows()[0]).toMatchObject({ delivery: "pending", attempts: 2, last_error: "exception" });
  expect(spent()).toBe(0);
});

test("resolves wording at send time without storing it or emitting delivery receipts", async () => {
  queue();
  const send = sender();
  const publish = mock(async () => {});
  await flush({ send, publish, resolveGoalWording: async () => "Example private goal" });
  expect(send.mock.calls[0]?.[0]).toBe("Vigil: goal Example private goal — on-track → off-track");
  expect(JSON.stringify(db.query("SELECT * FROM vigil_events").all())).not.toContain("Example private goal");
  expect(JSON.stringify(db.query("SELECT * FROM vigil_subjects").all())).not.toContain("Example private goal");
  expect(publish).not.toHaveBeenCalled();
});

test("overlapping flushes share one delivery attempt and spend one budget unit", async () => {
  queue();
  const resolvers = Promise.withResolvers<NotifyResult>();
  const send = mock(() => resolvers.promise);
  const first = flush({ send });
  const second = flush({ send });
  resolvers.resolve(success);
  await Promise.all([first, second]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(rows()[0]).toMatchObject({ delivery: "sent", attempts: 1 });
  expect(spent()).toBe(1);
});

test("failed fallback leaves errors and attempts durable and can be retried", async () => {
  queue();
  await expect(flush({ send: sender(permanent), fallback: async () => { throw new Error("fallback unavailable"); } })).rejects.toThrow("fallback unavailable");
  expect(rows()[0]).toMatchObject({ delivery: "pending", attempts: 1, last_error: "50007" });
  expect(spent()).toBe(0);
  await flush();
  expect(rows()[0]).toMatchObject({ delivery: "sent", attempts: 2 });
});

test("sent state and budget commit atomically", async () => {
  queue();
  db.run("CREATE TRIGGER fail_budget BEFORE INSERT ON vigil_budget BEGIN SELECT RAISE(ABORT, 'budget unavailable'); END");
  await expect(flush()).rejects.toThrow("budget unavailable");
  expect(rows()[0]).toMatchObject({ delivery: "pending", attempts: 1, sent_at: null, via: null });
  expect(spent()).toBe(0);
});
