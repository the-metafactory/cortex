import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { handleListAttention } from "../../surface/mc/api/attention";
import { setAttentionItemStatus } from "../../surface/mc/db/attention";
import { initDatabase } from "../../surface/mc/db/init";
import { TABLE_NAMES } from "../../surface/mc/db/schema";
import { buildDigest, sendDigest } from "../digest";
import { writeVigilTransition } from "../db";
import { ingestLedgerEnvelope, ENDED_AT, expectNoVigilTextDelivery, ledgerEnvelope, temporaryVigilDatabaseFile } from "./fixtures";

const DAY = 86400000;
const REF = "soma:proposals/first.md";
const id = (ref = REF) => `att:vigil:proposal:${ref}`;
const success = { delivered: true as const, messageId: "digest" };
let db: Database;
let fixture: ReturnType<typeof temporaryVigilDatabaseFile>;
let home: string;

beforeEach(() => {
  fixture = temporaryVigilDatabaseFile("proposal-digest-");
  home = dirname(fixture.path);
  db = initDatabase(fixture.path);
  mkdirSync(join(home, "proposals"));
  mkdirSync(join(home, "outputs"));
  writeFileSync(join(home, "proposals", "first.md"), "---\nkind: question\n---\n# Private proposal title\nPrivate proposal body");
  writeFileSync(join(home, "outputs", "result.md"), "# Waiting result");
});
afterEach(() => { db.close(); fixture[Symbol.dispose](); });

function report(offset = 0, refs = [REF], replay = false) {
  const ended_at = new Date(ENDED_AT + offset).toISOString();
  const envelope = ledgerEnvelope({ outcome: "succeeded", proposal_refs: refs, ended_at });
  ingestLedgerEnvelope(db, envelope, ENDED_AT + offset, { replay });
}
const options = (offset = 0) => ({ db, now: ENDED_AT + offset, somaHome: home, resultBaseUrl: "https://mc.example.test/" });

test("new proposals use fresh file titles before waiting results and persist no content in MC or ledger", async () => {
  report();
  ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", result_ref: "soma:outputs/result.md" }), ENDED_AT);
  const expected = "proposals\nPrivate proposal title — https://mc.example.test/proposals/soma%3Aproposals%2Ffirst.md\nwaiting for your answer: 1 proposals, oldest 0d\nwaiting for you\nWaiting result";
  expect(await buildDigest(options())).toContain(expected);
  const response = await handleListAttention(db, options());
  expect((await response.json()).attention.find((entry: { item: { kind: string } }) => entry.item.kind === "proposal").link).toEqual({
    kind: "proposal", label: "Private proposal title", url: "https://mc.example.test/proposals/soma%3Aproposals%2Ffirst.md",
  });
  writeFileSync(join(home, "proposals", "first.md"), "# Changed private title\nChanged private body");
  expect(await buildDigest(options())).toContain("Changed private title");
  await sendDigest({ ...options(), send: async () => success });
  for (const table of TABLE_NAMES) {
    const stored = JSON.stringify(db.query(`SELECT * FROM ${table}`).all());
    for (const text of ["Private proposal title", "Private proposal body", "Changed private title", "Changed private body"]) {
      expect(stored).not.toContain(text);
    }
  }
  expect(db.query("SELECT * FROM vigil_events").all()).toEqual([]);
  expect(db.query("SELECT * FROM vigil_attention_resolutions").all()).toEqual([]);
  expect(db.query("SELECT SUM(texts_spent) AS spent FROM vigil_budget").get()).toEqual({ spent: 0 });
});

test("arrivals appear once across updates and later digests while the standing count ages daily", async () => {
  report();
  await expectNoVigilTextDelivery(db);
  const send = mock(async (_text: string) => success);
  await sendDigest({ ...options(), send });
  report(1000);
  await sendDigest({ ...options(2000), send });
  expect(send).toHaveBeenCalledTimes(1);
  await sendDigest({ ...options(DAY), send });
  expect(send.mock.calls[1]![0]).toContain("waiting for your answer: 1 proposals, oldest 1d");
  expect(send.mock.calls[1]![0]).not.toContain("Private proposal title");
  report(DAY + 1000, ["soma:proposals/new.md"]);
  const next = await buildDigest(options(2 * DAY));
  expect(next).toContain("soma:proposals/new.md — https://mc.example.test/proposals/");
  expect(next).toContain("waiting for your answer: 2 proposals, oldest 2d");
  expect(next).not.toContain("Private proposal title");
});

test("day six gets one expiry reminder, failure retries it and success suppresses repeats", async () => {
  report();
  await sendDigest({ ...options(), send: async () => success });
  expect(await buildDigest(options(6 * DAY - 1))).not.toContain("expires tomorrow:");
  const text = await buildDigest(options(6 * DAY));
  expect(text).toContain("expires tomorrow: Private proposal title");
  expect(text).toContain("waiting for your answer: 1 proposals, oldest 6d");
  expect(text).not.toContain("https://mc.example.test/proposals/");
  await sendDigest({ ...options(6 * DAY), send: async () => ({ delivered: false, kind: "permanent", code: "blocked" }) });
  expect(await buildDigest(options(6 * DAY + 1000))).toContain("expires tomorrow:");
  await sendDigest({ ...options(6 * DAY + 1000), send: async () => success });
  expect(await buildDigest(options(6 * DAY + 2000))).not.toContain("expires tomorrow:");
  expect(await buildDigest(options(7 * DAY))).not.toContain("proposals");
});

test("resolved, expired and replayed items do not create arrival repeats or empty sections", async () => {
  report(0, [REF, "soma:proposals/second.md"]);
  setAttentionItemStatus(db, id(), "resolved", "approved");
  setAttentionItemStatus(db, id("soma:proposals/second.md"), "dismissed", "dismissed");
  expect(await buildDigest(options())).toBeNull();
  report(0, ["soma:proposals/replayed.md"], true);
  expect(await buildDigest(options())).toContain("waiting for your answer: 1 proposals, oldest 0d");
  expect(await buildDigest(options())).not.toContain("https://mc.example.test");
  expect(await buildDigest(options(7 * DAY))).toBeNull();
});

test("failed arrival delivery stays pending and an arrival during delivery waits for tomorrow", async () => {
  report();
  await sendDigest({ ...options(), send: async () => ({ delivered: false, kind: "permanent", code: "blocked" }) });
  expect(await buildDigest(options())).toContain("Private proposal title —");
  await sendDigest({ ...options(), send: async () => {
    report(1000, ["soma:proposals/during-send.md"]);
    return success;
  } });
  const next = await buildDigest(options(DAY));
  expect(next).toContain("soma:proposals/during-send.md —");
  expect(next).not.toContain("Private proposal title");
});

test("proposal overflow trims whole lines without displacing higher priority sections", async () => {
  ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", state: { subject: "G1", value: "on-track" } }), ENDED_AT, { replay: true });
  const event = writeVigilTransition(db, {
    subject_key: "state:goal:default:G1", from_value: "on-track", to_value: "off-track", direction: "worse", run_id: "worse", occurred_at: ENDED_AT,
  }, ENDED_AT);
  db.query("UPDATE vigil_events SET route = 'digest' WHERE id = ?").run(event.id);
  const without = (await buildDigest(options()))!;
  report(0, Array.from({ length: 20 }, (_, n) => `soma:proposals/proposal-number-${n}-long-name.md`));
  const withProposals = (await buildDigest(options()))!;
  expect(withProposals.length).toBeLessThanOrEqual(1950);
  expect(withProposals.split("\n").slice(0, 2)).toEqual(without.split("\n").slice(0, 2));
  const arrivals = withProposals.split("\n").filter((line) => line.includes("https://mc.example.test/proposals/"));
  expect(withProposals).toContain(`… ${21 - arrivals.length} more in Mission Control`);
});
