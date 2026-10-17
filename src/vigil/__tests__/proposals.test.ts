import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { initDatabase } from "../../surface/mc/db/init";
import { TABLE_NAMES } from "../../surface/mc/db/schema";
import { getAttentionItem, listOpenAttention, setAttentionItemStatus } from "../../surface/mc/db/attention";
import { ingestLedgerEnvelope } from "../ingest";
import { REF_ATTENTION_TTL_MS, type VigilRefRow } from "../ref-attention";
import { ENDED_AT, expectNoVigilTextDelivery, ledgerEnvelope, temporaryVigilDatabaseFile } from "./fixtures";

const REF = "soma:proposals/first.md";
const id = (ref = REF) => `att:vigil:proposal:${ref}`;
const later = (ms: number) => new Date(ENDED_AT + ms).toISOString();
let db: Database;
let file: ReturnType<typeof temporaryVigilDatabaseFile>;

beforeEach(() => {
  file = temporaryVigilDatabaseFile("vigil-proposals-");
  db = initDatabase(file.path);
});
afterEach(() => { db.close(); file[Symbol.dispose](); });

function report(overrides: Parameters<typeof ledgerEnvelope>[0] = {}, opts: { replay?: boolean } = {}) {
  const envelope = ledgerEnvelope({ outcome: "succeeded", proposal_refs: [REF], ...overrides });
  const delta = ingestLedgerEnvelope(db, envelope, Date.parse(String(envelope.payload.ended_at)), opts);
  return { envelope, delta };
}

function proposal(ref = REF) {
  return db.query<VigilRefRow & { proposal_ref: string }, [string]>(
    "SELECT * FROM vigil_proposals WHERE proposal_ref = ?",
  ).get(ref)!;
}

test("two new refs open low proposal items once without notifications or budget", async () => {
  const second = "soma:proposals/second.md";
  const { envelope, delta } = report({ ran: { kind: "job", ref: "triage" }, proposal_refs: [REF, second] });
  expect(delta).toEqual({ opened: [], resolved: [] });
  ingestLedgerEnvelope(db, envelope, ENDED_AT + 1000);
  expect(listOpenAttention(db)).toHaveLength(2);
  for (const ref of [REF, second]) {
    expect(getAttentionItem(db, id(ref))).toEqual({
      id: id(ref), stackId: "default", workItemId: null, sessionId: null,
      kind: "proposal", severity: "low", status: "open", resolution: null,
    });
    expect(proposal(ref)).toMatchObject({ ran_ref: "triage", version: 1, expires_at: ENDED_AT + REF_ATTENTION_TTL_MS });
  }
  await expectNoVigilTextDelivery(db);
});

test("only newer observations update open refs and keep the original producer", () => {
  report({ ran: { kind: "job", ref: "triage" } });
  db.query("UPDATE attention_items SET updated_at = 0 WHERE id = ?").run(id());
  const { envelope } = report({ run_id: "later", ended_at: later(1000), ran: { kind: "job", ref: "append" } });
  expect(proposal()).toMatchObject({ ran_ref: "triage", version: 2, updated_at: ENDED_AT + 1000, expires_at: ENDED_AT + 1000 + REF_ATTENTION_TTL_MS });
  expect(db.query<{ updated_at: number }, [string]>("SELECT updated_at FROM attention_items WHERE id = ?").get(id())!.updated_at).toBeGreaterThan(0);
  const snapshot = proposal();
  ingestLedgerEnvelope(db, envelope, ENDED_AT + 2000);
  report({ run_id: "older", ended_at: later(500) });
  report({ run_id: "later", ended_at: later(2000) });
  expect(proposal()).toEqual(snapshot);
});

test("missing proposal refs or unsuccessful runs do not create proposal metadata", () => {
  const missing = ledgerEnvelope({ outcome: "succeeded" });
  ingestLedgerEnvelope(db, missing, ENDED_AT);
  const failed = ledgerEnvelope();
  failed.payload.proposal_refs = [REF];
  ingestLedgerEnvelope(db, failed, ENDED_AT);
  expect(db.query("SELECT * FROM vigil_proposals").all()).toEqual([]);
  expect(listOpenAttention(db).filter((item) => item.kind === "proposal")).toEqual([]);
});

test.each(["approved", "dismissed", "expired", "superseded", "read", "archived"] as const)(
  "a ref resolved as %s never changes or reopens", (resolution) => {
    report();
    setAttentionItemStatus(db, id(), "resolved", resolution);
    const snapshot = proposal();
    const attention = db.query("SELECT * FROM attention_items WHERE id = ?").get(id());
    report({ ended_at: later(1000) });
    report({ ended_at: later(2000) }, { replay: true });
    expect(getAttentionItem(db, id())).toMatchObject({ status: "resolved", resolution });
    expect(proposal()).toEqual(snapshot);
    expect(db.query("SELECT * FROM attention_items WHERE id = ?").get(id())).toEqual(attention);
  },
);

test("dismissed status is terminal too", () => {
  report();
  setAttentionItemStatus(db, id(), "dismissed", "dismissed");
  const snapshot = proposal();
  report({ ended_at: later(1000) });
  expect(proposal()).toEqual(snapshot);
  expect(getAttentionItem(db, id())).toMatchObject({ status: "dismissed", resolution: "dismissed" });
});

test("the 21st ref archives the oldest created item only for its original producing job", () => {
  for (let n = 0; n < 20; n++) {
    report({ ran: { kind: "job", ref: "triage" }, proposal_refs: [`soma:proposals/${n}.md`], ended_at: later(n * 1000) });
  }
  const oldest = "soma:proposals/0.md";
  report({ ran: { kind: "job", ref: "append" }, proposal_refs: [oldest], ended_at: later(21000) });
  report({ ran: { kind: "job", ref: "other" }, ended_at: later(22000) });
  report({ ran: { kind: "job", ref: "triage" }, result_ref: "soma:outputs/result.md", proposal_refs: ["soma:proposals/21.md"], ended_at: later(23000) });
  expect(getAttentionItem(db, id(oldest))).toMatchObject({ status: "resolved", resolution: "archived" });
  expect(getAttentionItem(db, id())?.status).toBe("open");
  expect(db.query(`SELECT p.ran_ref, COUNT(*) AS count FROM vigil_proposals p
    JOIN attention_items a ON a.id = p.attention_id WHERE a.status = 'open' GROUP BY p.ran_ref ORDER BY p.ran_ref`).all())
    .toEqual([{ ran_ref: "other", count: 1 }, { ran_ref: "triage", count: 20 }]);
  expect(listOpenAttention(db).filter((item) => item.kind === "result")).toHaveLength(1);
});

test("one envelope with more than 20 refs is capped deterministically, including on replay", () => {
  const refs = Array.from({ length: 22 }, (_, n) => `soma:proposals/${String(n).padStart(2, "0")}.md`);
  const { envelope } = report({ proposal_refs: refs }, { replay: true });
  expect(listOpenAttention(db)).toHaveLength(20);
  expect(getAttentionItem(db, id(refs[0]))).toMatchObject({ resolution: "archived" });
  expect(getAttentionItem(db, id(refs[1]))).toMatchObject({ resolution: "archived" });
  const snapshot = db.query("SELECT * FROM vigil_proposals ORDER BY proposal_ref").all();
  ingestLedgerEnvelope(db, envelope, ENDED_AT + 1000, { replay: true });
  expect(db.query("SELECT * FROM vigil_proposals ORDER BY proposal_ref").all()).toEqual(snapshot);
  expect(db.query("SELECT * FROM vigil_events").all()).toEqual([]);
});

test("terminal proposals do not count toward the cap and delayed older arrivals archive themselves", () => {
  for (let n = 1; n <= 20; n++) report({ proposal_refs: [`soma:proposals/${n}.md`], ended_at: later(n * 1000) });
  setAttentionItemStatus(db, id("soma:proposals/1.md"), "resolved", "approved");
  report({ proposal_refs: ["soma:proposals/21.md"], ended_at: later(21000) });
  expect(listOpenAttention(db)).toHaveLength(20);
  expect(getAttentionItem(db, id("soma:proposals/2.md"))?.status).toBe("open");
  report();
  expect(getAttentionItem(db, id())).toMatchObject({ status: "resolved", resolution: "archived" });
  expect(listOpenAttention(db)).toHaveLength(20);
});

test("proposal file text and title are absent from AttentionItem and every MC table", () => {
  const path = join(dirname(file.path), "proposals", "first.md");
  mkdirSync(dirname(path));
  writeFileSync(path, "# Private proposal title\nPrivate proposal body\n");
  report();
  report({ ended_at: later(1000) });
  for (const table of TABLE_NAMES) {
    const stored = JSON.stringify(db.query(`SELECT * FROM ${table}`).all());
    for (const text of ["Private proposal title", "Private proposal body"]) expect(stored).not.toContain(text);
  }
  expect(Object.keys(getAttentionItem(db, id())!).sort()).toEqual([
    "id", "kind", "resolution", "sessionId", "severity", "stackId", "status", "workItemId",
  ]);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(readFileSync(file.path).includes(Buffer.from("Private proposal"))).toBe(false);
});
