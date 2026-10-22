import { expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../surface/mc/db/init";
import { getAttentionItem } from "../../surface/mc/db/attention";
import { AgentConfigSchema } from "../../common/types/config";
import { getVigilSubject, isVigilReplayPending, listVigilEvents, recordVigilTextReceipt } from "../db";
import { buildDigest } from "../digest";
import { ingestLedgerEnvelope, ledgerEnvelopeError, sourceStackMismatchCount } from "../ingest";
import { startVigil } from "../index";
import { replayLedger } from "../replay";
import { hasLegacyVigilSubjects } from "../stack-scope";
import { sweepStale } from "../staleness";
import { ENDED_AT, SUBJECT, fakeTickScheduler, ledgerEnvelope, recordedVigilLedger, temporaryVigilDatabaseFile } from "./fixtures";

const receivedSubject = (stack: string) => SUBJECT.replace(".default.", `.${stack}.`);
const config = AgentConfigSchema.parse({ claude: {}, agent: { name: "example", displayName: "Example" },
  mc: { enabled: true }, vigil: { enabled: true } });
const goal = (sourceStack = "soma", offset = 0, value = "on-track") => ({
  ...ledgerEnvelope({ outcome: "succeeded", state: { subject: "G1", value },
    ended_at: new Date(ENDED_AT + offset).toISOString() }), source: `example.${sourceStack}.run`,
});

function oldRows(db: Database, sourceStack: string) {
  const envelope = goal(sourceStack);
  ingestLedgerEnvelope(db, envelope, receivedSubject(sourceStack), ENDED_AT);
  db.run("DELETE FROM vigil_subject_stack_sources");
  return envelope;
}

test.each(["default", "work", "soma", "ranger"])("live and replay use received %s stack despite producer source", async (stack) => {
  const envelope = goal();
  const subject = receivedSubject(stack);
  for (const replay of [false, true]) {
    using db = initDatabase(":memory:");
    if (replay) {
      const ledger = await recordedVigilLedger([{ envelope, subject }]);
      expect(await replayLedger({ ...ledger, db })).toBe(1);
    } else ingestLedgerEnvelope(db, envelope, subject, ENDED_AT);
    expect(getVigilSubject(db, `state:goal:${stack}:G1`)).toMatchObject({ stack, value: "on-track" });
    expect(getVigilSubject(db, `run:flow:${stack}:daily-sweep`)).toMatchObject({ stack });
    expect(db.query("SELECT count(*) AS n FROM vigil_subjects").get()).toEqual({ n: 2 });
  }
});

test.each(["local.example.execution.run.finished", "local.example..execution.run.finished",
  "local.example.work.execution.run.started", "local.example.work.execution.run.finished.extra",
  "federated.example.work.execution.run.finished", "local.example.*.execution.run.finished"])(
  "refuses invalid received subject %s before any write", async (subject) => {
    using db = initDatabase(":memory:");
    const envelope = goal();
    expect(ledgerEnvelopeError(envelope, subject)).toContain("subject:");
    expect(() => ingestLedgerEnvelope(db, envelope, subject, ENDED_AT)).toThrow();
    expect(db.query("SELECT * FROM vigil_subjects").all()).toEqual([]);
    const ledger = await recordedVigilLedger([{ envelope, subject }, { envelope: ledgerEnvelope(), subject: SUBJECT }]);
    expect(await replayLedger({ ...ledger, db })).toBe(1);
    expect(getVigilSubject(db, "state:goal:default:G1")).toBeNull();
    expect(ledger.log.warn).toHaveBeenCalledWith(expect.stringContaining("invalid: subject:"));
  });

test("counts every mismatch and logs only once per producer across live and replay", async () => {
  using db = initDatabase(":memory:");
  const base = goal("ranger");
  const envelope = { ...base, payload: { ...base.payload, producer: "ranger" } };
  const log = { warn: mock((_line: string) => {}), info: mock((_line: string) => {}) };
  const before = sourceStackMismatchCount("ranger");
  ingestLedgerEnvelope(db, envelope, SUBJECT, ENDED_AT, { log });
  ingestLedgerEnvelope(db, envelope, SUBJECT, ENDED_AT, { log });
  const ledger = await recordedVigilLedger([{ envelope, subject: SUBJECT }]);
  const applied = await replayLedger({ ...ledger, db, log });
  expect(applied).toBe(1);
  expect(sourceStackMismatchCount("ranger")).toBe(before + 3);
  expect(log.warn).toHaveBeenCalledTimes(before === 0 ? 1 : 0);
});

test("startup rebuilds source-keyed rows, resolves obsolete stale attention and keeps digest free of it", async () => {
  using file = temporaryVigilDatabaseFile("subject-stack-migration-");
  const db = initDatabase(file.path);
  const first = oldRows(db, "soma");
  const later = goal("soma", 60_000);
  const imported = goal("ranger", 120_000, "at-risk");
  ingestLedgerEnvelope(db, imported, receivedSubject("ranger"), ENDED_AT);
  db.run("DELETE FROM vigil_subject_stack_sources");
  sweepStale(db, ENDED_AT + 200_000_000, {});
  const stale = listVigilEvents(db, "state:goal:soma:G1")[0]!;
  recordVigilTextReceipt(db, { event_id: stale.id, subject_key: stale.subject_key, budget_day: "2026-10-12" });
  expect(getAttentionItem(db, "att:vigil:state:goal:soma:G1")?.status).toBe("open");
  const ledger = await recordedVigilLedger([{ envelope: first, subject: SUBJECT },
    { envelope: later, subject: SUBJECT }, { envelope: imported, subject: receivedSubject("work") }]);
  const opts = { ...ledger, db, config, stack: "default", now: () => ENDED_AT + 120_000,
    schedule: fakeTickScheduler().schedule };
  const handle = await startVigil(opts);
  expect(handle).not.toBeNull();
  await handle?.stop();
  expect(db.query("SELECT DISTINCT stack FROM vigil_subjects ORDER BY stack").all()).toEqual([{ stack: "default" }, { stack: "work" }]);
  expect(getVigilSubject(db, "state:goal:default:G1")).toMatchObject({ value: "on-track", last_run_id: later.payload.run_id });
  expect(getAttentionItem(db, "att:vigil:state:goal:soma:G1")).toBeNull();
  expect(getAttentionItem(db, "att:vigil:state:goal:ranger:G1")).toBeNull();
  expect(getAttentionItem(db, "att:vigil:state:goal:default:G1")?.status).toBe("resolved");
  expect(getAttentionItem(db, "att:vigil:state:goal:work:G1")?.status).toBe("open");
  expect((await buildDigest({ db, now: Date.parse("2026-10-13T05:00:00Z") })) ?? "").not.toContain("stale");
  expect(db.query("SELECT subject_key FROM vigil_text_receipts").all()).toEqual([{ subject_key: "state:goal:default:G1" }]);
  expect(db.query(`SELECT id FROM attention_items WHERE status = 'open' AND kind = 'state_change'
    AND substr(id, 11) NOT IN (SELECT subject_key FROM vigil_subjects)`).all()).toEqual([]);
  expect(hasLegacyVigilSubjects(db)).toBe(false);
  db.close();
  using restarted = initDatabase(file.path);
  const again = await startVigil({ ...opts, db: restarted });
  await again?.stop();
  expect(ledger.calls.filter((call) => call.durable.includes("replay"))).toHaveLength(1);
});

test("same-key source rows are rebuilt even when a stale tick kept their last run ID", async () => {
  using db = initDatabase(":memory:");
  const envelope = oldRows(db, "default");
  sweepStale(db, ENDED_AT + 200_000_000, {});
  const ledger = await recordedVigilLedger([{ envelope, subject: SUBJECT }]);
  expect(await replayLedger({ ...ledger, db })).toBe(1);
  expect(getVigilSubject(db, "state:goal:default:G1")?.value).toBe("on-track");
  expect(getAttentionItem(db, "att:vigil:state:goal:default:G1")?.status).toBe("resolved");
  expect(await buildDigest({ db, now: ENDED_AT })).toBeNull();
});

test("retained-window gaps keep migration pending and prevent startup until history is restored", async () => {
  using db = initDatabase(":memory:");
  const missing = oldRows(db, "ranger");
  const other = goal("soma", -1000);
  other.payload.state = { subject: "G2", value: "on-track" };
  const ledger = await recordedVigilLedger([{ envelope: other, subject: SUBJECT }]);
  const opts = { ...ledger, db, config, stack: "default", schedule: fakeTickScheduler().schedule };
  expect(await startVigil(opts)).toBeNull();
  expect(isVigilReplayPending(db)).toBe(true);
  expect(getVigilSubject(db, "state:goal:ranger:G1")).not.toBeNull();
  expect(ledger.log.warn).toHaveBeenCalledWith(expect.stringContaining("complete LEDGER history"));
  const restored = await recordedVigilLedger([{ envelope: other, subject: SUBJECT }, { envelope: missing, subject: SUBJECT }]);
  const handle = await startVigil({ ...opts, ...restored });
  expect(handle).not.toBeNull();
  await handle?.stop();
  expect(isVigilReplayPending(db)).toBe(false);
  expect(getVigilSubject(db, "state:goal:ranger:G1")).toBeNull();
});

test.each([false, true])("aged-out source-keyed rows carry to local stack with warning (empty=%s)", async (empty) => {
  using db = initDatabase(":memory:");
  oldRows(db, "ranger");
  const newer = goal("soma", 1000);
  newer.payload.state = { subject: "G2", value: "on-track" };
  const ledger = await recordedVigilLedger(empty ? [] : [{ envelope: newer, subject: SUBJECT }]);
  const applied = await replayLedger({ ...ledger, db });
  expect(applied).toBe(empty ? 0 : 1);
  expect(getVigilSubject(db, "state:goal:default:G1")).toMatchObject({ stack: "default" });
  expect(getVigilSubject(db, "state:goal:ranger:G1")).toBeNull();
  expect(ledger.log.warn).toHaveBeenCalledWith(expect.stringContaining("LEDGER history has aged out"));
});


test("live subscriber passes the received subject and refuses malformed subjects", async () => {
  using db = initDatabase(":memory:");
  const ledger = await recordedVigilLedger([]);
  const handle = await startVigil({ ...ledger, db, config, stack: "default", schedule: fakeTickScheduler().schedule });
  expect(handle).not.toBeNull();
  const live = ledger.calls.find((call) => !call.durable.includes("replay"))!;
  const envelope = goal();
  live.onEnvelope(envelope, "local.example.execution.run.finished", { working: () => undefined });
  expect(db.query("SELECT * FROM vigil_subjects").all()).toEqual([]);
  live.onEnvelope(envelope, receivedSubject("work"), { working: () => undefined });
  expect(getVigilSubject(db, "state:goal:work:G1")).toMatchObject({ stack: "work" });
  await handle?.stop();
});

test("an incomplete same-key rebuild remains pending across restarts", async () => {
  using db = initDatabase(":memory:");
  oldRows(db, "default");
  const older = goal("default", -1000);
  const ledger = await recordedVigilLedger([{ envelope: older, subject: SUBJECT }]);
  const opts = { ...ledger, db, config, stack: "default", schedule: fakeTickScheduler().schedule };
  expect(await startVigil(opts)).toBeNull();
  expect(isVigilReplayPending(db)).toBe(true);
  expect(hasLegacyVigilSubjects(db)).toBe(true);
  expect(await startVigil(opts)).toBeNull();
  expect(isVigilReplayPending(db)).toBe(true);
});
