import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { NotifyResult } from "../../adapters/types";
import { initDatabase } from "../../surface/mc/db/init";
import { budgetDay } from "../budget";
import { channelKey, channelValue, recordChannel } from "../channels";
import { getVigilTextsSpent, listVigilEvents, markVigilReplayStarted, rebuildVigilBudget, recordVigilTextDelivered, writeVigilTransition, type VigilEventRow } from "../db";
import { buildDigest, maybeSendDigest, sendDigest, type SendDigestOptions } from "../digest";
import { ingestLedgerEnvelope, initVigilGoalDatabase, ledgerEnvelope, temporaryVigilDatabaseFile } from "./fixtures";

const NOW = Date.parse("2026-10-12T07:00:00+02:00");
const KEY = "state:goal:default:G1";
const success: NotifyResult = { delivered: true, messageId: "digest" };
const budget = "Budget: 0 of 3 texts yesterday · DM ok · email ok";
let db: Database;

beforeEach(() => {
  db = initVigilGoalDatabase();
});
afterEach(() => db.close());

function queue(overrides: Partial<Pick<VigilEventRow, "direction" | "to_value" | "route" | "delivery" | "occurred_at">> = {}) {
  const event = writeVigilTransition(db, {
    subject_key: KEY, from_value: "on-track", to_value: overrides.to_value ?? "at-risk",
    direction: overrides.direction ?? "worse", run_id: crypto.randomUUID(), occurred_at: overrides.occurred_at ?? NOW,
  }, NOW);
  db.query("UPDATE vigil_events SET route = ?, delivery = ? WHERE id = ?")
    .run(overrides.route === undefined ? "digest" : overrides.route, overrides.delivery ?? "pending", event.id);
  return event.id;
}

const rows = () => listVigilEvents(db, KEY);
const dayRow = (day = budgetDay(NOW)) => db.query("SELECT * FROM vigil_budget WHERE budget_day = ?").get(day);
const sender = () => mock(async (_text: string): Promise<NotifyResult> => success);
const email = () => mock(async (_subject: string, _body: string) => ({ ok: true }));
const options = (overrides: Partial<SendDigestOptions> = {}): SendDigestOptions => ({ db, now: NOW, send: sender(), ...overrides });

test("builds only eligible sections in order with yesterday's budget and current wording", async () => {
  queue({ direction: "better", to_value: "on-track", route: null, occurred_at: NOW - 4000 });
  queue({ to_value: "stale", occurred_at: NOW - 3000 });
  queue({ to_value: "off-track", occurred_at: NOW - 2000 });
  queue({ route: "text", delivery: "held" });
  queue({ route: "text" });
  queue({ delivery: "sent" });
  queue({ delivery: "digested", direction: "better" });
  recordVigilTextDelivered(db, "2026-10-11");
  recordVigilTextDelivered(db, "2026-10-11");
  recordVigilTextDelivered(db, "2026-10-12");
  const resolveGoalWording = mock(async (_id: string) => "Current goal wording");
  expect(await buildDigest({ db, now: NOW, resolveGoalWording })).toBe([
    "Held back", "Vigil: goal Current goal wording — on-track → at-risk",
    "Worse", "Vigil: goal Current goal wording — on-track → off-track",
    "Stale", "Vigil: goal Current goal wording — on-track → stale",
    "Recovered", "Vigil: goal Current goal wording — on-track → on-track",
    "Budget: 2 of 3 texts yesterday · DM ok · email ok",
  ].join("\n"));
  expect(resolveGoalWording).toHaveBeenCalledTimes(4);
  expect(await buildDigest({ db, now: NOW, resolveGoalWording: () => "New wording" })).toContain("New wording");
  expect(JSON.stringify(rows())).not.toContain("wording");
  expect(dayRow()).toEqual({ budget_day: "2026-10-12", texts_spent: 1, digest_at: null });
});

test("budget alone is empty, irrelevant pending texts do not make a digest", async () => {
  queue({ route: "text" });
  queue({ route: null });
  queue({ delivery: "sent" });
  expect(await buildDigest({ db, now: NOW })).toBeNull();
  expect(dayRow()).toBeNull();
});

test("null or failed goal resolution uses IDs and never persists resolver errors", async () => {
  queue();
  const warn = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    for (const resolveGoalWording of [() => null, () => { throw new Error("private resolver details"); }]) {
      expect(await buildDigest({ db, now: NOW, resolveGoalWording })).toBe(`Worse\nVigil: goal G1 — on-track → at-risk\n${budget}`);
    }
    expect(warn.mock.calls).toEqual([["Vigil: goal wording resolver failed; using goal IDs for unavailable wording\n"]]);
  } finally { warn.mockRestore(); }
});

test("truncates whole item lines with an exact omitted count, no empty headings and the budget last", async () => {
  for (let i = 0; i < 60; i++) queue({ to_value: `at-risk-${i}` });
  queue({ to_value: "stale" });
  queue({ direction: "better", to_value: "on-track" });
  const text = (await buildDigest({ db, now: NOW }))!;
  expect(text.length).toBeLessThanOrEqual(1950);
  const lines = text.split("\n");
  const visible = lines.filter((line) => line.startsWith("Vigil:"));
  expect(lines.slice(-2)).toEqual([`… ${62 - visible.length} more in Mission Control`, budget]);
  expect(visible).toEqual(Array.from({ length: visible.length }, (_, i) => `Vigil: goal G1 — on-track → at-risk-${i}`));
  expect(lines).not.toContain("Stale");
  expect(lines).not.toContain("Recovered");
});

test("a single oversized goal line is omitted whole and embedded newlines stay within the item", async () => {
  queue();
  expect(await buildDigest({ db, now: NOW, resolveGoalWording: () => "x".repeat(3000) }))
    .toBe(`… 1 more in Mission Control\n${budget}`);
  expect(await buildDigest({ db, now: NOW, resolveGoalWording: () => "first\nsecond\r\nthird" }))
    .toBe(`Worse\nVigil: goal first second third — on-track → at-risk\n${budget}`);
});

test("delivery settles the snapshot including summarized items, never spends, and is once per day", async () => {
  for (let i = 0; i < 60; i++) queue({ delivery: i % 2 ? "held" : "pending" });
  const send = sender();
  const fallback = email();
  recordVigilTextDelivered(db, budgetDay(NOW));
  await sendDigest(options({ send, fallback }));
  await sendDigest(options({ send, fallback }));
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0].length).toBeLessThanOrEqual(1950);
  expect(fallback).not.toHaveBeenCalled();
  expect(rows()).toHaveLength(60);
  expect(rows().every((row) => row.delivery === "digested" && row.digested_at === NOW && row.via === "dm")).toBe(true);
  expect(dayRow()).toEqual({ budget_day: "2026-10-12", texts_spent: 1, digest_at: NOW });
  expect(db.query("SELECT COUNT(*) AS n FROM vigil_text_receipts").get()).toEqual({ n: 0 });
});

test("empty digest marks the day done and later events wait for the next day", async () => {
  const send = sender();
  const fallback = email();
  const resolveGoalWording = mock(() => "wording");
  await maybeSendDigest(options({ send, fallback, resolveGoalWording }));
  expect(dayRow()).toEqual({ budget_day: "2026-10-12", texts_spent: 0, digest_at: NOW });
  queue();
  await maybeSendDigest(options({ send, fallback, resolveGoalWording, now: NOW + 300000 }));
  expect(send).not.toHaveBeenCalled();
  expect(fallback).not.toHaveBeenCalled();
  expect(resolveGoalWording).not.toHaveBeenCalled();
  await maybeSendDigest(options({ send, now: Date.parse("2026-10-13T07:00:00+02:00") }));
  expect(send).toHaveBeenCalledTimes(1);
});

test.each(["permanent", "transient", "throw", "absent"] as const)("%s DM failure immediately emails the exact same bounded digest", async (failure) => {
  queue();
  const send = mock(async (_text: string): Promise<NotifyResult> => {
    if (failure === "throw") throw new Error("private DM error");
    return { delivered: false, kind: failure === "transient" ? "transient" : "permanent", code: "unavailable" };
  });
  const fallback = email();
  const expected = await buildDigest({ db, now: NOW });
  await sendDigest(options({ send: failure === "absent" ? null : send, fallback }));
  expect(send).toHaveBeenCalledTimes(failure === "absent" ? 0 : 1);
  expect(fallback.mock.calls).toEqual([["[Vigil] digest 2026-10-12", expected!]]);
  expect(rows()[0]).toMatchObject({ delivery: "digested", via: "email", digested_at: NOW });
  expect(channelValue(db, "dm-channel")).toBe("regressed");
  expect(channelValue(db, "email-channel")).toBe("ok");
  expect(getVigilTextsSpent(db, budgetDay(NOW))).toBe(0);
});

test.each(["failed", "throw", "absent"] as const)("%s email leaves the day and original rows pending, logs once and retries", async (failure) => {
  queue({ delivery: "held" });
  const before = rows();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const fallback = failure === "absent" ? null : mock(async () => {
    if (failure === "throw") throw new Error("private email error");
    return { ok: false, error: "timeout" };
  });
  try {
    await maybeSendDigest(options({ send: null, fallback }));
    expect(rows()).toEqual(before);
    expect(dayRow()).toBeNull();
    expect(warn.mock.calls).toEqual([["Vigil: digest 2026-10-12 undelivered; retrying next tick"]]);
    const send = sender();
    await maybeSendDigest(options({ send, now: NOW + 300000 }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(rows()[0]).toMatchObject({ delivery: "digested", via: "dm", digested_at: NOW + 300000 });
    expect(channelValue(db, "dm-channel")).toBe("ok");
    expect(dayRow()).toMatchObject({ digest_at: NOW + 300000 });
  } finally { warn.mockRestore(); }
});

test("channel regressions and recoveries render in the digest with both channel states", async () => {
  recordChannel(db, "dm-channel", "regressed", NOW);
  recordChannel(db, "email-channel", "regressed", NOW);
  expect(await buildDigest({ db, now: NOW })).toBe([
    "Worse", "Vigil: check vigil:email-channel — ok → regressed",
    "Budget: 0 of 3 texts yesterday · DM regressed · email regressed",
  ].join("\n"));
  recordChannel(db, "dm-channel", "ok", NOW + 1);
  recordChannel(db, "email-channel", "ok", NOW + 1);
  const text = await buildDigest({ db, now: NOW + 1 });
  expect(text).toContain("Recovered\nVigil: check vigil:dm-channel — regressed → ok\nVigil: check vigil:email-channel — regressed → ok");
  expect(text).toEndWith(budget);
  expect(listVigilEvents(db, channelKey("email-channel"))).toHaveLength(2);
});

test("settlement only touches the build snapshot and concurrent ticks share delivery", async () => {
  queue();
  let release!: (result: NotifyResult) => void;
  const send = mock((_text: string) => new Promise<NotifyResult>((resolve) => { release = resolve; }));
  const first = maybeSendDigest(options({ send }));
  const second = maybeSendDigest(options({ send }));
  while (!release) await Promise.resolve();
  const added = queue();
  release(success);
  await Promise.all([first, second]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(rows().find((row) => row.id === added)?.delivery).toBe("pending");
});

test("day stamp and event settlement roll back together", async () => {
  queue();
  const before = rows();
  db.run("CREATE TRIGGER fail_digest BEFORE INSERT ON vigil_budget BEGIN SELECT RAISE(ABORT, 'digest unavailable'); END");
  await expect(sendDigest(options())).rejects.toThrow("digest unavailable");
  expect(rows()).toEqual(before);
  expect(dayRow()).toBeNull();
});

test.each([
  ["2026-10-12T06:55:00+02:00", false],
  ["2026-10-12T07:00:00+02:00", true],
  ["2026-10-12T10:05:00+02:00", true],
  ["2026-10-25T02:55:00+02:00", false],
  ["2026-10-25T02:05:00+01:00", false],
  ["2026-10-25T06:55:00+01:00", false],
  ["2026-10-25T07:00:00+01:00", true],
  ["2026-03-29T06:55:00+02:00", false],
  ["2026-03-29T07:00:00+02:00", true],
] as const)("Zurich tick %s eligible=%s", async (iso, eligible) => {
  queue();
  const send = sender();
  const resolveGoalWording = mock(() => "wording");
  const now = Date.parse(iso);
  await maybeSendDigest(options({ now, send, resolveGoalWording }));
  expect(send).toHaveBeenCalledTimes(eligible ? 1 : 0);
  expect(resolveGoalWording).toHaveBeenCalledTimes(eligible ? 1 : 0);
  await maybeSendDigest(options({ now: now + 60000, send, resolveGoalWording }));
  expect(send).toHaveBeenCalledTimes(eligible ? 1 : 0);
});

test("a completed prior budget day cannot suppress the new day at 07:00", async () => {
  db.query("INSERT INTO vigil_budget (budget_day, digest_at) VALUES (?, ?)").run("2026-10-11", NOW - 86400000);
  queue();
  const send = sender();
  const resolveGoalWording = mock(() => "wording");
  await maybeSendDigest(options({ now: NOW - 300000, send, resolveGoalWording }));
  expect(resolveGoalWording).not.toHaveBeenCalled();
  await maybeSendDigest(options({ send, resolveGoalWording }));
  expect(send).toHaveBeenCalledTimes(1);
});

test("timestamp migrations preserve old rows and survive repeated initialization", () => {
  using file = temporaryVigilDatabaseFile("vigil-digest-");
  let stored = initDatabase(file.path);
  try {
    ingestLedgerEnvelope(stored, ledgerEnvelope({ state: { subject: "G1", value: "at-risk" } }), NOW);
    recordVigilTextDelivered(stored, budgetDay(NOW));
    stored.run("ALTER TABLE vigil_events DROP COLUMN digested_at");
    stored.run("ALTER TABLE vigil_budget DROP COLUMN digest_at");
    const oldEvents = listVigilEvents(stored, KEY);
    stored.close();
    stored = initDatabase(file.path);
    expect(listVigilEvents(stored, KEY)).toEqual(oldEvents.map((event) => ({ ...event, digested_at: null })));
    expect(stored.query("SELECT * FROM vigil_budget").all()).toEqual([{ budget_day: "2026-10-12", texts_spent: 1, digest_at: null }]);
    stored.run("UPDATE vigil_budget SET digest_at = 42");
    const version = stored.query("PRAGMA schema_version").get();
    stored.close();
    stored = initDatabase(file.path);
    expect(stored.query("PRAGMA schema_version").get()).toEqual(version);
    expect(stored.query("SELECT digest_at FROM vigil_budget").get()).toEqual({ digest_at: 42 });
  } finally { stored.close(); }
});

test("budget replay keeps local digest stamps while rebuilding only text spending", async () => {
  await sendDigest(options());
  recordVigilTextDelivered(db, "2026-10-11");
  markVigilReplayStarted(db, NOW);
  rebuildVigilBudget(db);
  expect(dayRow()).toEqual({ budget_day: "2026-10-12", texts_spent: 0, digest_at: NOW });
  expect(dayRow("2026-10-11")).toBeNull();
  const send = sender();
  queue();
  await maybeSendDigest(options({ send }));
  expect(send).not.toHaveBeenCalled();
});
