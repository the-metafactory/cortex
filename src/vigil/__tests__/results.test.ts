import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../../surface/mc/db/init";
import { TABLE_NAMES } from "../../surface/mc/db/schema";
import { getAttentionItem, listOpenAttention, setAttentionItemStatus } from "../../surface/mc/db/attention";
import { handleAttentionLifecycle, handleListAttention } from "../../surface/mc/api/attention";
import { handleListVigilSubjects } from "../../surface/mc/api/vigil";
import { buildDigest, sendDigest } from "../digest";
import { ingestLedgerEnvelope } from "../ingest";
import { renderResult, somaGoalWording } from "../result-render";
import { expireResults, pendingResults, RESULT_TTL_MS, type VigilResultRow } from "../results";
import { ENDED_AT, expectNoVigilTextDelivery, ledgerEnvelope } from "./fixtures";

const REF = "soma:outputs/weekly.md";
const id = (ref = REF) => `att:vigil:result:${ref}`;
let db: Database;
let home: string;
beforeEach(() => {
  db = initDatabase(":memory:");
  home = mkdtempSync(join(tmpdir(), "vigil-results-"));
  mkdirSync(join(home, "outputs"));
  mkdirSync(join(home, "profile", "goals"), { recursive: true });
  writeFileSync(join(home, "outputs", "weekly.md"), "# Private file title\nPrivate body contents");
  writeFileSync(join(home, "profile", "goals", "G1.md"), "---\nid: G1\nstatus: active\n---\nPrivate goal wording\nPrivate goal body");
});
afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

function report(overrides: Parameters<typeof ledgerEnvelope>[0] = {}, options: { replay?: boolean } = {}) {
  const payload = { outcome: "succeeded" as const, result_ref: REF as string | undefined, ...overrides };
  if (payload.result_ref === undefined) delete payload.result_ref;
  const envelope = ledgerEnvelope(payload);
  const delta = ingestLedgerEnvelope(db, envelope, Date.parse(String(envelope.payload.ended_at)), options);
  return { envelope, delta };
}
const result = (ref = REF) => db.query<VigilResultRow, [string]>("SELECT * FROM vigil_results WHERE result_ref = ?").get(ref)!;
const later = (ms: number) => new Date(ENDED_AT + ms).toISOString();
const options = () => ({ db, now: ENDED_AT, somaHome: home });
const sender = () => mock(async (_text: string) => ({ delivered: true as const, messageId: "digest" }));

test("arrival without a goal opens one low result, records creator, dedupes and spends nothing", async () => {
  const { envelope, delta } = report();
  expect(delta).toEqual({ opened: [], resolved: [] });
  expect(getAttentionItem(db, id())).toMatchObject({ kind: "result", severity: "low", status: "open" });
  expect(result()).toMatchObject({ ran_ref: "daily-sweep", goal_id: null, version: 1, expires_at: ENDED_AT + RESULT_TTL_MS });
  ingestLedgerEnvelope(db, envelope, ENDED_AT + 1000);
  expect(listOpenAttention(db)).toHaveLength(1);
  expect(result().version).toBe(1);
  await expectNoVigilTextDelivery(db);
});

test("failed or missing result references do not open waiting items", () => {
  report({ result_ref: undefined });
  report({ outcome: "failed", result_ref: undefined, ended_at: later(1000) });
  expect(db.query("SELECT * FROM vigil_results").all()).toEqual([]);
});

test("same ref updates once, preserves creator across jobs and restarts expiry", async () => {
  report({ serves: { goal: "G1" } });
  await sendDigest({ ...options(), send: sender() });
  const { envelope } = report({ ran: { kind: "job", ref: "append-drafts" }, serves: { goal: "G1" }, ended_at: later(1000) });
  ingestLedgerEnvelope(db, envelope, ENDED_AT + 2000);
  expect(result()).toMatchObject({ ran_ref: "daily-sweep", version: 2, digested_version: 1, expires_at: ENDED_AT + 1000 + RESULT_TTL_MS });
  expect(await buildDigest(options())).toContain("Private goal wording — updated: Private file title");
  expireResults(db, ENDED_AT + RESULT_TTL_MS);
  expect(getAttentionItem(db, id())?.status).toBe("open");
  expireResults(db, ENDED_AT + RESULT_TTL_MS + 1000);
  expect(getAttentionItem(db, id())).toMatchObject({ status: "resolved", resolution: "expired" });
  expect(await buildDigest(options())).toBeNull();
});

test("new ref supersedes only the creating job, never an updating job or another job", () => {
  report();
  report({ ran: { kind: "job", ref: "append-drafts" }, ended_at: later(1000) });
  report({ ran: { kind: "job", ref: "append-drafts" }, result_ref: "soma:outputs/drafts.md", ended_at: later(2000) });
  report({ ran: { kind: "job", ref: "other-job" }, result_ref: "soma:outputs/other.md", ended_at: later(3000) });
  expect(getAttentionItem(db, id())?.status).toBe("open");
  const { delta } = report({ result_ref: "soma:outputs/next.md", ended_at: later(4000) });
  expect(delta).toEqual({ opened: [], resolved: [] });
  expect(getAttentionItem(db, id())).toMatchObject({ status: "resolved", resolution: "superseded" });
  expect(listOpenAttention(db).filter((item) => item.kind === "result")).toHaveLength(3);
});

test("older or duplicate observations never revert content metadata, resurrect items or supersede newer results", () => {
  report({ run_id: "later", result_ref: "soma:outputs/new.md", ended_at: later(1000) });
  report({ run_id: "earlier" });
  expect(getAttentionItem(db, id())).toMatchObject({ status: "resolved", resolution: "superseded" });
  expect(getAttentionItem(db, id("soma:outputs/new.md"))?.status).toBe("open");
  report({ run_id: "last", ended_at: later(2000) });
  expect(getAttentionItem(db, id())?.status).toBe("resolved");
  expect(result().version).toBe(1);
});

test("read and dismiss use resolution column and remain closed when run envelopes replay", async () => {
  for (const [action, resolution] of [["resolve", "read"], ["dismiss", "dismissed"]] as const) {
    const ref = `soma:outputs/${action}.md`;
    const { envelope } = report({ result_ref: ref, ran: { kind: "job", ref: action } });
    expect((await handleAttentionLifecycle(db, id(ref), action)).status).toBe(200);
    ingestLedgerEnvelope(db, envelope, ENDED_AT + 5000, { replay: true });
    expect((await handleAttentionLifecycle(db, id(ref), "resolve")).status).toBe(404);
    expect(getAttentionItem(db, id(ref))).toMatchObject({ status: action === "resolve" ? "resolved" : "dismissed", resolution });
  }
});

test("replay rebuilds result identity and supersession quietly without digest backlog", () => {
  report({}, { replay: true });
  report({ ended_at: later(1000) }, { replay: true });
  report({ result_ref: "soma:outputs/next.md", ended_at: later(2000) }, { replay: true });
  expect(result()).toMatchObject({ ran_ref: "daily-sweep", version: 2, digested_version: 2 });
  expect(getAttentionItem(db, id())).toMatchObject({ status: "resolved", resolution: "superseded" });
  expect(pendingResults(db)).toEqual([]);
  expect(db.query("SELECT * FROM vigil_events").all()).toEqual([]);
});

test("digest reads fresh goal wording and file title only at render time, never persists private text", async () => {
  report({ serves: { goal: "G1" } });
  const text = await buildDigest({ ...options(), resultBaseUrl: "https://mc.example.test/" });
  expect(text).toContain("waiting for you\nPrivate goal wording — Private file title — https://mc.example.test/results/soma%3Aoutputs%2Fweekly.md");
  expect(text).not.toContain("Private body contents");
  const response = await handleListAttention(db, { somaHome: home, resultBaseUrl: "https://mc.example.test" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).attention[0].link).toEqual({
    kind: "result", label: "Private goal wording — Private file title",
    url: "https://mc.example.test/results/soma%3Aoutputs%2Fweekly.md",
  });
  writeFileSync(join(home, "outputs", "weekly.md"), "# Revised title\nPrivate revised body");
  writeFileSync(join(home, "profile", "goals", "G1.md"), "---\nid: G1\n---\nRevised goal wording");
  expect(await buildDigest(options())).toContain("Revised goal wording — Revised title");
  for (const table of TABLE_NAMES) {
    const stored = JSON.stringify(db.query(`SELECT * FROM ${table}`).all());
    for (const privateText of ["Private file title", "Private body contents", "Private goal wording", "Private goal body", "Revised title", "Private revised body", "Revised goal wording"]) {
      expect(stored).not.toContain(privateText);
    }
  }
  expect(await somaGoalWording(home)("../../outside")).toBeNull();
});

test("successful digest settles once, updates wait until next day, failed delivery stays pending", async () => {
  report();
  await sendDigest({ ...options(), send: async () => ({ delivered: false, kind: "permanent", code: "blocked" }) });
  expect(result().digested_version).toBe(0);
  const send = sender();
  await sendDigest({ ...options(), send });
  expect(pendingResults(db)).toEqual([]);
  await sendDigest({ ...options(), send });
  expect(send).toHaveBeenCalledTimes(1);
  report({ ended_at: later(2000) });
  await sendDigest({ ...options(), now: ENDED_AT, send });
  expect(send).toHaveBeenCalledTimes(1);
  await sendDigest({ ...options(), now: ENDED_AT + 2 * 86400000, send });
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]![0]).toContain("updated: Private file title");
  expect(db.query("SELECT SUM(texts_spent) AS spent FROM vigil_budget").get()).toEqual({ spent: 0 });
});

test("an update during digest delivery remains pending for the next digest", async () => {
  report();
  await sendDigest({ ...options(), send: async () => {
    report({ ended_at: later(1000) });
    return { delivered: true, messageId: "snapshot" };
  } });
  expect(result()).toMatchObject({ version: 2, digested_version: 1 });
  expect(await buildDigest(options())).toContain("updated: Private file title");
});

test("rendering unavailable or escaping files falls back to references without leaking outside contents", async () => {
  report();
  writeFileSync(join(home, "outside.md"), "# Outside secret title");
  symlinkSync(join(home, "outside.md"), join(home, "outputs", "escape.md"));
  for (const ref of ["soma:outputs/escape.md", "soma:outputs/../outside.md", "soma:other.md", "soma:outputs/missing.md"]) {
    const text = await renderResult({ ...result(), result_ref: ref }, { somaHome: home });
    expect(text).toContain(ref);
    expect(text).not.toContain("Outside secret title");
  }
});

test("watching retains last result on run and state subjects after later runs without a result", async () => {
  report({ state: { subject: "G1", value: "on-track" } });
  report({ result_ref: undefined, state: { subject: "G1", value: "on-track" }, ended_at: later(1000) });
  const { subjects } = await (await handleListVigilSubjects(db)).json();
  expect(subjects).toHaveLength(2);
  expect(subjects.every((subject: { lastResultRef: string }) => subject.lastResultRef === REF)).toBe(true);
  expect(setAttentionItemStatus(db, id(), "resolved", "read")).toBe(true);
});


test("supersession compares the creating jobs even when an append run finished after the next file", () => {
  report();
  report({ ran: { kind: "job", ref: "append-drafts" }, ended_at: later(3000) });
  report({ result_ref: "soma:outputs/next.md", ended_at: later(2000) });
  expect(getAttentionItem(db, id())).toMatchObject({ status: "resolved", resolution: "superseded" });
  expect(getAttentionItem(db, id("soma:outputs/next.md"))?.status).toBe("open");
});

test("each subject keeps its result link even when another job updated that same result later", async () => {
  report({ ended_at: later(3000) });
  report({ ran: { kind: "flow", ref: "other-subject" }, ended_at: later(2000) });
  const { subjects } = await (await handleListVigilSubjects(db)).json();
  expect(subjects).toHaveLength(2);
  expect(subjects.every((subject: { lastResultRef: string }) => subject.lastResultRef === REF)).toBe(true);
  expect(result().version).toBe(1);
});
