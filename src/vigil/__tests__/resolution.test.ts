// glossary-ignore: run
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../surface/mc/db/init";
import { getAttentionItem, upsertAttentionItem } from "../../surface/mc/db/attention";
import { handleAttentionLifecycle } from "../../surface/mc/api/attention";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import { validateVigilAttentionResolved } from "@the-metafactory/myelin";
import { ingestLedgerEnvelope } from "../ingest";
import { expireRefAttention, REF_ATTENTION_TTL_MS } from "../ref-attention";
import { readResult } from "../result-read";
import { flushVigilResolutions, replayVigilResolution, resolveVigilAttention } from "../resolution";
import { ENDED_AT, KEY, ledgerEnvelope, temporaryVigilDatabaseFile } from "./fixtures";

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });
const result = "soma:outputs/result.md";
const proposal = "soma:proposals/proposal.md";
const resultId = `att:vigil:result:${result}`;
const proposalId = `att:vigil:proposal:${proposal}`;
const receipts = () => db.query("SELECT * FROM vigil_attention_resolutions ORDER BY rowid").all();

function publisher() {
  const published: Envelope[] = [];
  const publish = mock(async (envelope: Envelope, subject: string) => {
    expect(subject).toBe("local.example.default.vigil.attention.resolved");
    published.push(envelope);
  });
  return { principal: "example", stack: "default", publish, published };
}

function refs() {
  ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", result_ref: result, proposal_refs: [proposal] }), ENDED_AT);
}

test("principal actions and result reads each publish one validated metadata-only resolution", async () => {
  refs();
  const ledger = publisher();
  expect((await handleAttentionLifecycle(db, proposalId, "resolve", { proposal_token_env: "PROPOSAL_TOKEN", env: { PROPOSAL_TOKEN: "secret-value" }, run: async () => ({ ok: true, stdout: JSON.stringify({ ref: "example/repo#12", created: true }) }) })).status).toBe(200);
  expect((await handleAttentionLifecycle(db, proposalId, "dismiss")).status).toBe(404);
  await Promise.all([readResult(db, result, ledger), readResult(db, result, ledger), flushVigilResolutions(db, ledger)]);
  expect(ledger.publish).toHaveBeenCalledTimes(2);
  expect(getAttentionItem(db, proposalId)).toMatchObject({ status: "resolved", resolution: "approved" });
  for (const envelope of ledger.published) {
    const { id, source, type, timestamp, sovereignty, payload } = envelope;
    expect(validateVigilAttentionResolved({ id, source, type, timestamp, sovereignty, payload }).valid).toBe(true);
    expect(Object.keys(payload).sort()).toEqual([...(payload.filed ? ["filed"] : []), "key", "kind", "ran_ref", "resolution", "resolved_at"]);
    expect(JSON.stringify(envelope)).not.toContain("Private proposal text");
    expect(JSON.stringify(envelope)).not.toContain("Private result text");
  }
  expect(ledger.published.map((envelope) => envelope.payload.resolution)).toEqual(["approved", "read"]);
});

test.each(["result", "proposal", "state_change"] as const)("dismiss of Vigil %s uses one durable resolution", async (kind) => {
  refs();
  ingestLedgerEnvelope(db, ledgerEnvelope({ ran: { kind: "job", ref: "failed" } }), ENDED_AT);
  const id = kind === "result" ? resultId : kind === "proposal" ? proposalId : "att:vigil:run:job:failed";
  expect((await handleAttentionLifecycle(db, id, "dismiss")).status).toBe(200);
  expect((await handleAttentionLifecycle(db, id, "dismiss")).status).toBe(404);
  expect(getAttentionItem(db, id)).toMatchObject({ status: "dismissed", resolution: "dismissed" });
  const ledger = publisher();
  await flushVigilResolutions(db, ledger);
  expect(ledger.published.map((envelope) => envelope.payload)).toEqual([{
    key: kind === "result" ? result : kind === "proposal" ? proposal : "run:job:failed",
    kind, resolution: "dismissed", ran_ref: kind === "state_change" ? "failed" : "daily-sweep", resolved_at: expect.any(String),
  }]);
});

test("expiry, supersession, proposal cap and recovery all use the shared resolution outbox", async () => {
  refs();
  ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", result_ref: "soma:outputs/new.md", ended_at: "2026-10-12T10:00:06Z" }), ENDED_AT + 1000);
  ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", proposal_refs: Array.from({ length: 20 }, (_, n) => `soma:proposals/${n}.md`), ended_at: "2026-10-12T10:00:07Z" }), ENDED_AT + 2000);
  ingestLedgerEnvelope(db, ledgerEnvelope({ ran: { kind: "job", ref: "recovery" } }), ENDED_AT);
  ingestLedgerEnvelope(db, ledgerEnvelope({ ran: { kind: "job", ref: "recovery" }, outcome: "succeeded", ended_at: "2026-10-12T10:00:08Z" }), ENDED_AT + 3000);
  expireRefAttention(db, ENDED_AT + REF_ATTENTION_TTL_MS + 4000);
  expireRefAttention(db, ENDED_AT + REF_ATTENTION_TTL_MS + 5000);
  const ledger = publisher();
  await flushVigilResolutions(db, ledger);
  await flushVigilResolutions(db, ledger);
  expect(ledger.published).toHaveLength(24);
  expect(ledger.published.filter((envelope) => envelope.payload.resolution === "expired")).toHaveLength(21);
  expect(ledger.published.filter((envelope) => envelope.payload.resolution === "archived")).toHaveLength(2);
  expect(ledger.published.filter((envelope) => envelope.payload.resolution === "superseded")).toHaveLength(1);
  expect(new Set(ledger.published.map((envelope) => `${envelope.payload.key}:${envelope.payload.resolution}`)).size).toBe(24);
});

test("filed is retained for approvals and invalid metadata rolls back before resolving", async () => {
  refs();
  expect(() => resolveVigilAttention(db, proposalId, "approved", { filed: "invalid" })).toThrow();
  expect(() => resolveVigilAttention(db, proposalId, "dismissed", { filed: "example/repo#12" })).toThrow();
  expect(getAttentionItem(db, proposalId)?.status).toBe("open");
  expect(receipts()).toEqual([]);
  expect(resolveVigilAttention(db, proposalId, "approved", { filed: "example/repo#12", now: ENDED_AT })).toBe(true);
  const ledger = publisher();
  await flushVigilResolutions(db, ledger);
  expect(ledger.published[0]?.payload).toEqual({ key: proposal, kind: "proposal", resolution: "approved", ran_ref: "daily-sweep", resolved_at: new Date(ENDED_AT).toISOString(), filed: "example/repo#12" });
});

test("an outbox write failure rolls back the resolution", async () => {
  refs();
  db.run("CREATE TRIGGER fail_receipt BEFORE INSERT ON vigil_attention_resolutions BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
  await expect(handleAttentionLifecycle(db, proposalId, "dismiss")).rejects.toThrow("receipt failure");
  expect(getAttentionItem(db, proposalId)).toMatchObject({ status: "open", resolution: null });
  expect(receipts()).toEqual([]);
});

test("pending publications survive reopening the DB and concurrent retries reuse one identity", async () => {
  using file = temporaryVigilDatabaseFile("resolution-outbox-");
  const persistent = initDatabase(file.path);
  ingestLedgerEnvelope(persistent, ledgerEnvelope({ outcome: "succeeded", result_ref: result }), ENDED_AT);
  resolveVigilAttention(persistent, resultId, "read", { now: ENDED_AT });
  const ledger = publisher();
  ledger.publish.mockImplementationOnce(async (envelope) => { ledger.published.push(envelope); throw new Error("offline"); });
  await flushVigilResolutions(persistent, ledger);
  expect(getAttentionItem(persistent, resultId)?.resolution).toBe("read");
  persistent.close();
  const reopened = initDatabase(file.path);
  try {
    await Promise.all([flushVigilResolutions(reopened, ledger), flushVigilResolutions(reopened, ledger)]);
    expect(ledger.published).toHaveLength(2);
    expect(ledger.published[0]).toEqual(ledger.published[1]);
    expect(reopened.query("SELECT published FROM vigil_attention_resolutions").all()).toEqual([{ published: 1 }]);
  } finally { reopened.close(); }
});

test("reopened attention has independent pending receipts and replay deduplicates only the occurrence", async () => {
  const first = ledgerEnvelope();
  const second = ledgerEnvelope({ outcome: "cancelled", ended_at: "2026-10-12T10:00:06Z" });
  const id = `att:vigil:${KEY}`;
  for (const envelope of [first, second]) {
    ingestLedgerEnvelope(db, envelope, ENDED_AT);
    expect(resolveVigilAttention(db, id, "dismissed", { now: ENDED_AT })).toBe(true);
  }
  const ledger = publisher();
  ledger.publish.mockImplementationOnce(async (envelope) => { ledger.published.push(envelope); });
  ledger.publish.mockImplementationOnce(async (envelope) => { ledger.published.push(envelope); throw new Error("offline"); });
  await flushVigilResolutions(db, ledger);
  expect(db.query("SELECT published FROM vigil_attention_resolutions ORDER BY rowid").all())
    .toEqual([{ published: 1 }, { published: 0 }]);
  await flushVigilResolutions(db, ledger);
  const [firstResolution, secondResolution, retry] = ledger.published;
  expect(secondResolution).toEqual(retry);
  expect(firstResolution!.id).not.toBe(secondResolution!.id);
  expect(firstResolution!.payload).toEqual(secondResolution!.payload);
  const rebuilt = initDatabase(":memory:");
  try {
    ingestLedgerEnvelope(rebuilt, first, ENDED_AT, { replay: true });
    replayVigilResolution(rebuilt, firstResolution!);
    ingestLedgerEnvelope(rebuilt, second, ENDED_AT, { replay: true });
    expect(getAttentionItem(rebuilt, id)?.status).toBe("open");
    replayVigilResolution(rebuilt, firstResolution!);
    expect(getAttentionItem(rebuilt, id)?.status).toBe("open");
    replayVigilResolution(rebuilt, secondResolution!);
    replayVigilResolution(rebuilt, retry!);
    expect(getAttentionItem(rebuilt, id)).toMatchObject({ status: "dismissed", resolution: "dismissed" });
    expect(rebuilt.query("SELECT id, published FROM vigil_attention_resolutions ORDER BY rowid").all())
      .toEqual([{ id: firstResolution!.id, published: 1 }, { id: secondResolution!.id, published: 1 }]);
  } finally { rebuilt.close(); }
});

test("composite-key receipts migrate losslessly and allow another occurrence of the same resolution", async () => {
  using file = temporaryVigilDatabaseFile("resolution-cycle-migration-");
  const old = initDatabase(file.path);
  old.run("DROP TABLE vigil_attention_resolutions");
  old.run(`CREATE TABLE vigil_attention_resolutions (
    key TEXT NOT NULL, kind TEXT NOT NULL, resolution TEXT NOT NULL,
    attention_id TEXT NOT NULL, stack_id TEXT NOT NULL, id TEXT NOT NULL UNIQUE,
    ran_ref TEXT NOT NULL, resolved_at TEXT NOT NULL, filed TEXT,
    published INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key, resolution)
  )`);
  ingestLedgerEnvelope(old, ledgerEnvelope({ ran: { kind: "job", ref: "proposal-source" }, outcome: "succeeded", proposal_refs: [proposal] }), ENDED_AT);
  resolveVigilAttention(old, proposalId, "approved", { now: ENDED_AT, filed: "example/repo#12" });
  ingestLedgerEnvelope(old, ledgerEnvelope(), ENDED_AT);
  resolveVigilAttention(old, `att:vigil:${KEY}`, "dismissed", { now: ENDED_AT });
  old.query("UPDATE vigil_attention_resolutions SET published = 1 WHERE attention_id = ?").run(proposalId);
  const original = old.query("SELECT * FROM vigil_attention_resolutions ORDER BY rowid").all();
  old.close();
  for (let n = 0; n < 2; n++) {
    const migrated = initDatabase(file.path);
    try {
      expect(migrated.query("SELECT * FROM vigil_attention_resolutions ORDER BY rowid").all()).toEqual(original);
      expect(migrated.query("EXPLAIN QUERY PLAN SELECT * FROM vigil_attention_resolutions WHERE published = 0 ORDER BY rowid").all())
        .toEqual([expect.objectContaining({ detail: expect.stringContaining("idx_vigil_attention_resolutions_published") })]);
      if (n === 1) {
        ingestLedgerEnvelope(migrated, ledgerEnvelope({ outcome: "cancelled", ended_at: "2026-10-12T10:00:06Z" }), ENDED_AT);
        resolveVigilAttention(migrated, `att:vigil:${KEY}`, "dismissed", { now: ENDED_AT });
        const ledger = publisher();
        await flushVigilResolutions(migrated, ledger);
        expect(ledger.published).toHaveLength(2);
        expect(ledger.published.every((envelope) => envelope.payload.resolution === "dismissed")).toBe(true);
        expect(new Set(ledger.published.map((envelope) => envelope.id)).size).toBe(2);
      }
    } finally { migrated.close(); }
  }
});

test("legacy pending and published read receipts migrate without changing their envelope identities", () => {
  using file = temporaryVigilDatabaseFile("resolution-migration-");
  const old = initDatabase(file.path);
  for (const published of [0, 1]) old.query("INSERT INTO vigil_result_reads (result_ref, id, ran_ref, resolved_at, published) VALUES (?, ?, 'job', ?, ?)")
    .run(`soma:outputs/${published}.md`, `legacy-${published}`, new Date(ENDED_AT).toISOString(), published);
  old.run("DROP TABLE vigil_attention_resolutions");
  old.close();
  for (let n = 0; n < 2; n++) {
    const migrated = initDatabase(file.path);
    try {
      expect(migrated.query("SELECT id, published, resolution FROM vigil_attention_resolutions ORDER BY id").all()).toEqual([
        { id: "legacy-0", published: 0, resolution: "read" }, { id: "legacy-1", published: 1, resolution: "read" },
      ]);
    } finally { migrated.close(); }
  }
});

test("Mission Control retains the existing lifecycle for attention not owned by Vigil", async () => {
  upsertAttentionItem(db, { id: "att:other", kind: "state_change", stackId: "default", sessionId: null, workItemId: null, severity: "normal", status: "open" });
  expect((await handleAttentionLifecycle(db, "att:other", "resolve")).status).toBe(200);
  expect(getAttentionItem(db, "att:other")).toMatchObject({ status: "resolved", resolution: null });
  expect(receipts()).toEqual([]);
  expect(resolveVigilAttention(db, `att:vigil:${KEY}`, "read")).toBe(false);
});

test("replay rejects resolution envelopes carrying private text or unsupported kinds", async () => {
  refs();
  resolveVigilAttention(db, proposalId, "approved");
  const ledger = publisher();
  await flushVigilResolutions(db, ledger);
  const rebuilt = initDatabase(":memory:");
  try {
    const envelope = ledger.published[0]!;
    expect(replayVigilResolution(rebuilt, { ...envelope, payload: { ...envelope.payload, text: "Private proposal text" } }))
      .toEqual({ kind: "skip", reason: "attention resolution payload" });
    expect(replayVigilResolution(rebuilt, { ...envelope, payload: { ...envelope.payload, kind: "other" } }))
      .toEqual({ kind: "skip", reason: "attention resolution kind" });
    expect(rebuilt.query("SELECT * FROM attention_items").all()).toEqual([]);
    expect(rebuilt.query("SELECT * FROM vigil_attention_resolutions").all()).toEqual([]);
  } finally { rebuilt.close(); }
});
