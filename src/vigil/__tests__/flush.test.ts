import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { MockAdapter } from "../../adapters/mock";
import { notifyWithResult } from "../../adapters/notify-result";
import type { NotifyResult } from "../../adapters/types";
import { initDatabase } from "../../surface/mc/db/init";
import { budgetDay } from "../budget";
import { getVigilTextsSpent, listVigilEvents, recordVigilTextDelivered, writeVigilTransition } from "../db";
import { flushTexts, TRANSIENT_FALLBACK_THRESHOLD, type FlushTextsOptions } from "../flush";
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

function emailSender() {
  return mock(async (_subject: string, _body: string) => ({ ok: true }));
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
  const fallback = emailSender();
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
  const fallback = emailSender();
  for (let attempts = 1; attempts < TRANSIENT_FALLBACK_THRESHOLD; attempts++) {
    await flush({ send, fallback, readChannelHealth: () => "ok" });
    expect(rows()[0]).toMatchObject({ delivery: "pending", attempts, transient_failures: attempts, last_error: "network", sent_at: null, via: null });
    expect(spent()).toBe(0);
    expect(fallback).not.toHaveBeenCalled();
  }
  await flush({ send, fallback });
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(rows()[0]).toMatchObject({ delivery: "sent", attempts: TRANSIENT_FALLBACK_THRESHOLD, transient_failures: 0, last_error: null, via: "email" });
  await flush({ send, fallback });
  expect(send).toHaveBeenCalledTimes(TRANSIENT_FALLBACK_THRESHOLD);
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(spent()).toBe(1);
});

test("permanent failures reset the consecutive transient streak", async () => {
  queue();
  for (const result of [transient, transient, permanent, transient, transient]) await flush({ send: sender(result) });
  expect(rows()[0]).toMatchObject({ attempts: 5, transient_failures: 2 });
  expect(spent()).toBe(0);
});

test("permanent failures form one ordered fallback batch; unavailable fallback preserves pending events", async () => {
  queue("later", NOW + 1);
  queue("earlier", NOW);
  await flush({ send: sender(permanent) });
  expect(rows().every((row) => row.delivery === "pending" && row.last_error === "no-fallback" && row.attempts === 1)).toBe(true);
  expect(spent()).toBe(0);
  const fallback = emailSender();
  await flush({ send: sender(permanent), fallback, render: async (event) => String(event.occurred_at) });
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(fallback.mock.calls[0]).toEqual(["[Vigil] 2 text(s)", `${NOW}\n${NOW + 1}`]);
  await flush({ send: sender(permanent) });
  expect(rows().every((row) => row.delivery === "sent" && row.via === "email" && row.attempts === 2)).toBe(true);
  expect(spent()).toBe(2);
});

test("no adapter is a counted permanent no-adapter failure for every pending text", async () => {
  queue("first");
  queue("second");
  await flush({ send: null });
  expect(rows().every((row) => row.delivery === "pending" && row.last_error === "no-fallback" && row.attempts === 1)).toBe(true);
  expect(spent()).toBe(0);
  const fallback = emailSender();
  await flush({ send: null, fallback });
  expect(fallback.mock.calls[0]?.[0]).toBe("[Vigil] 2 text(s)");
  expect(rows().every((row) => row.attempts === 2)).toBe(true);
  expect(rows().every((row) => row.delivery === "sent" && row.via === "email")).toBe(true);
  expect(spent()).toBe(2);
});

test("regressed channel still attempts DM and falls back after the first transient failure", async () => {
  queue();
  const send = sender(transient);
  const fallback = emailSender();
  await flush({ send, fallback, readChannelHealth: () => "regressed" });
  expect(send).toHaveBeenCalledTimes(1);
  expect(fallback).toHaveBeenCalledTimes(1);
  await flush({ readChannelHealth: () => "regressed", fallback });
  expect(rows()[0]).toMatchObject({ delivery: "sent", via: "email", attempts: 1 });
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
  await flush({ send: sender(permanent), fallback: async () => ({ ok: false, error: "fallback unavailable" }) });
  expect(rows()[0]).toMatchObject({ delivery: "pending", attempts: 1, last_error: "fallback unavailable" });
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

test("successful fallback settles texts once across later flushes", async () => {
  queue();
  const send = sender(permanent);
  const fallback = emailSender();
  await flush({ send, fallback });
  expect(rows()[0]).toMatchObject({ delivery: "sent", sent_at: NOW, via: "email", attempts: 1, last_error: null });
  expect(spent()).toBe(1);
  await flush({ send, fallback });
  expect(send).toHaveBeenCalledTimes(1);
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(spent()).toBe(1);
});

test("fallback batch uses only budget left after successful DMs", async () => {
  for (let i = 0; i < 5; i++) queue(String(i), NOW + i);
  const send = mock(async (): Promise<NotifyResult> => send.mock.calls.length === 3 ? success : permanent);
  const fallback = emailSender();
  await flush({ send, fallback });
  expect(fallback.mock.calls[0]?.[0]).toBe("[Vigil] 2 text(s)");
  expect(fallback.mock.calls[0]?.[1].split("\n")).toHaveLength(2);
  expect(rows().map((row) => [row.delivery, row.via])).toEqual([
    ["sent", "email"], ["sent", "email"], ["sent", "dm"], ["held", null], ["held", null],
  ]);
  expect(spent()).toBe(3);
  await flush({ send, fallback });
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(spent()).toBe(3);
});

test("a later rendering failure still delivers the accumulated fallback batch", async () => {
  queue("first", NOW);
  queue("second", NOW + 1);
  const fallback = emailSender();
  await expect(flush({
    send: sender(permanent), fallback,
    render: async (event) => {
      if (event.run_id === "second") throw new Error("wording unavailable");
      return "first text";
    },
  })).rejects.toThrow("wording unavailable");
  expect(fallback.mock.calls[0]).toEqual(["[Vigil] 1 text(s)", "first text"]);
  expect(rows().map((row) => row.delivery)).toEqual(["sent", "pending"]);
  expect(spent()).toBe(1);
});

test("rejected fallback retains eligible texts and holds overflow before sending", async () => {
  for (let i = 0; i < 4; i++) queue(String(i), NOW + i);
  const send = sender(permanent);
  await flush({ send, fallback: async () => { throw new Error("email unavailable"); } });
  expect(rows().slice(0, 3).every((row) => row.delivery === "pending" && row.attempts === 1 && row.last_error === "email unavailable")).toBe(true);
  expect(rows()[3]).toMatchObject({ delivery: "held", held_reason: "budget" });
  expect(spent()).toBe(0);
  const fallback = emailSender();
  await flush({ send, fallback });
  expect(fallback.mock.calls[0]?.[0]).toBe("[Vigil] 3 text(s)");
  expect(rows().map((row) => row.delivery)).toEqual(["sent", "sent", "sent", "held"]);
  expect(rows()[3]).toMatchObject({ held_reason: "budget", via: null });
  expect(spent()).toBe(3);
});

test("fallback is skipped when DMs consume all remaining budget", async () => {
  queue("failed", NOW);
  for (let i = 0; i < 3; i++) queue(String(i), NOW + i + 1);
  const send = mock(async (): Promise<NotifyResult> => send.mock.calls.length === 1 ? permanent : success);
  const fallback = emailSender();
  await flush({ send, fallback });
  expect(fallback).not.toHaveBeenCalled();
  expect(rows()[0]).toMatchObject({ delivery: "held", held_reason: "budget", attempts: 1 });
  expect(spent()).toBe(3);
});

test("all fallback settlements and budget increments commit atomically", async () => {
  queue("first");
  queue("second");
  db.run("CREATE TRIGGER fail_budget BEFORE UPDATE ON vigil_budget BEGIN SELECT RAISE(ABORT, 'budget unavailable'); END");
  await expect(flush({ send: sender(permanent), fallback: async () => ({ ok: true }) })).rejects.toThrow("budget unavailable");
  expect(rows().every((row) => row.delivery === "pending" && row.sent_at === null && row.via === null)).toBe(true);
  expect(spent()).toBe(0);
});

test("exhausted transient failures remain pending without fallback and recover by DM", async () => {
  queue();
  for (let i = 0; i <= TRANSIENT_FALLBACK_THRESHOLD; i++) await flush({ send: sender(transient) });
  expect(rows()[0]).toMatchObject({ delivery: "pending", attempts: 4, transient_failures: 4, last_error: "no-fallback" });
  expect(spent()).toBe(0);
  await flush();
  expect(rows()[0]).toMatchObject({ delivery: "sent", via: "dm", attempts: 5, transient_failures: 0, last_error: null });
  expect(spent()).toBe(1);
});

test("a pending text can recover by DM while channel health is regressed", async () => {
  queue();
  await flush({ send: sender(transient), readChannelHealth: () => "regressed" });
  expect(rows()[0]).toMatchObject({ delivery: "pending", attempts: 1 });
  const fallback = emailSender();
  await flush({ fallback, readChannelHealth: () => "regressed" });
  expect(fallback).not.toHaveBeenCalled();
  expect(rows()[0]).toMatchObject({ delivery: "sent", via: "dm", attempts: 2 });
  expect(spent()).toBe(1);
});

test.each([null, async () => ({ ok: false, error: "exit 7" })])("fallback failure keeps every eligible text pending for a DM-first retry: %s", async (fallback) => {
  for (let i = 0; i < 3; i++) queue(String(i), NOW + i);
  await flush({ send: sender(permanent), fallback });
  expect(rows().every((row) => row.delivery === "pending" && row.via === null && row.sent_at === null && row.last_error === (fallback ? "exit 7" : "no-fallback"))).toBe(true);
  expect(spent()).toBe(0);
  const send = sender();
  const email = emailSender();
  await flush({ send, fallback: email });
  expect(send).toHaveBeenCalledTimes(3);
  expect(email).not.toHaveBeenCalled();
  expect(rows().every((row) => row.delivery === "sent" && row.via === "dm" && row.attempts === 2)).toBe(true);
  expect(spent()).toBe(3);
});

test("a fallback with no error still records a failure reason", async () => {
  queue();
  await flush({ send: null, fallback: async () => ({ ok: false }) });
  expect(rows()[0]).toMatchObject({ delivery: "pending", last_error: "fallback-failed" });
  expect(spent()).toBe(0);
});

test("holds texts outside the remaining budget even with no fallback", async () => {
  recordVigilTextDelivered(db, budgetDay(NOW));
  for (let i = 0; i < 4; i++) queue(String(i), NOW + i);
  await flush({ send: null, fallback: null });
  expect(rows().map((row) => row.delivery)).toEqual(["pending", "pending", "held", "held"]);
  expect(rows().slice(2).every((row) => row.held_reason === "budget")).toBe(true);
  expect(spent()).toBe(1);
});

function channelNotice() {
  ingestLedgerEnvelope(db, ledgerEnvelope({ run_id: "channel-check", state: { subject: "dm-channel", value: "ok" } }), NOW, { replay: true });
  const event = writeVigilTransition(db, {
    subject_key: "state:check:dm-channel", from_value: "ok", to_value: "regressed", direction: "worse",
    run_id: "channel-regressed", occurred_at: NOW,
  }, NOW);
  return { eventId: event.id, text: "Vigil: check dm-channel — ok → regressed" };
}

test("prepends the channel notice to unchanged oldest-first DM texts and settles it outside the budget", async () => {
  queue("later", NOW + 1);
  queue("earlier", NOW);
  const notice = channelNotice();
  const fallback = emailSender();
  await flush({ send: sender(permanent), fallback, channelNotice: () => notice });
  expect(fallback.mock.calls).toEqual([["[Vigil] 2 text(s)", [notice.text,
    "Vigil: goal G1 — on-track → off-track", "Vigil: goal G1 — on-track → off-track",
  ].join("\n")]]);
  expect(db.query("SELECT delivery, via, sent_at FROM vigil_events WHERE id = ?").get(notice.eventId)).toEqual({ delivery: "sent", via: "email", sent_at: NOW });
  expect(spent()).toBe(2);
  expect(JSON.stringify(db.query("SELECT * FROM vigil_events").all())).not.toContain("Vigil:");
});

test("channel notice remains pending on email failure and is never emailed alone", async () => {
  const notice = channelNotice();
  const fallback = emailSender();
  await flush({ send: null, fallback, channelNotice: () => notice });
  expect(fallback).not.toHaveBeenCalled();
  queue();
  await flush({ send: null, fallback: async () => ({ ok: false, error: "timeout" }), channelNotice: () => notice });
  expect(db.query("SELECT delivery, via, sent_at FROM vigil_events WHERE id = ?").get(notice.eventId)).toEqual({ delivery: "pending", via: null, sent_at: null });
  expect(spent()).toBe(0);
});

test("channel notice and text settlement roll back together when persistence fails", async () => {
  queue();
  const notice = channelNotice();
  db.run("CREATE TRIGGER fail_notice BEFORE UPDATE ON vigil_events WHEN NEW.subject_key = 'state:check:dm-channel' BEGIN SELECT RAISE(ABORT, 'notice unavailable'); END");
  await expect(flush({ send: null, fallback: emailSender(), channelNotice: () => notice })).rejects.toThrow("notice unavailable");
  expect(db.query("SELECT delivery, via, sent_at FROM vigil_events WHERE id = ?").get(notice.eventId)).toEqual({ delivery: "pending", via: null, sent_at: null });
  expect(rows()[0]).toMatchObject({ delivery: "pending", via: null, sent_at: null });
  expect(spent()).toBe(0);
});
