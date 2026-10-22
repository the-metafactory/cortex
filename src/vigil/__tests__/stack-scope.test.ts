import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { MyelinSubscribePullOpts } from "../../bus/myelin/runtime";
import type { MyelinSubscriber } from "../../bus/myelin/subscriber";
import { deriveNatsSubject } from "../../bus/myelin/envelope-validator";
import { createFakeJetStream } from "../../bus/jetstream/__tests__/fake-jetstream";
import { LEDGER_STREAM, provisionLedgerStream } from "../../bus/jetstream/provision";
import { AgentConfigSchema } from "../../common/types/config";
import { initDatabase } from "../../surface/mc/db/init";
import { handleListVigilSubjects } from "../../surface/mc/api/vigil";
import { getAttentionItem } from "../../surface/mc/db/attention";
import { budgetDay } from "../budget";
import { channelKey, recordChannel } from "../channels";
import { getVigilSubject, getVigilTextsSpent, isVigilReplayPending, listVigilEvents, recordVigilTextReceipt, writeVigilSubject, type VigilSubjectRow } from "../db";
import { buildDigest } from "../digest";
import { flushTexts } from "../flush";
import { ingestLedgerEnvelope, ledgerEnvelopeError } from "../ingest";
import { createVigilDeliveryPorts, startVigil } from "../index";
import { createVigilRenderer } from "../render";
import { replayLedger } from "../replay";
import { renderResult, somaGoalWording } from "../result-render";
import { pendingResults } from "../results";
import { hasLegacyVigilSubjects } from "../stack-scope";
import { ENDED_AT, fakeTickScheduler, ledgerEnvelope } from "./fixtures";

const goal = (stack: string, value = "off-track") => ledgerEnvelope({
  outcome: "succeeded", serves: { goal: "G1" }, state: { subject: "G1", value },
}, stack);
const log = { info: () => {}, warn: () => {} };

const publishedAt = (envelope: ReturnType<typeof ledgerEnvelope>) =>
  Date.parse((envelope.payload as { ended_at: string }).ended_at);

async function recordedLedger(envelopes: ReturnType<typeof ledgerEnvelope>[]) {
  const fake = createFakeJetStream();
  await provisionLedgerStream({ jsm: fake.jsm, principal: "jc", log });
  for (const envelope of envelopes) fake.publish(deriveNatsSubject(envelope, "default"), publishedAt(envelope));
  const runtime = {
    jetstreamManager: async () => fake.jsm,
    subscribePull: (opts: MyelinSubscribePullOpts) => {
      if (opts.durable.includes("replay")) {
        fake.pull(LEDGER_STREAM, opts.durable);
        for (const envelope of envelopes) opts.onEnvelope(envelope, deriveNatsSubject(envelope, "default"), { working: () => undefined });
      }
      return { ready: Promise.resolve(), stop: async () => {} } as unknown as MyelinSubscriber;
    },
  };
  return { jsm: fake.jsm, runtime, principal: "jc", log, pollMs: 1 };
}

function makeLegacy(db: Database) {
  db.transaction(() => {
    for (const row of db.query<VigilSubjectRow, []>("SELECT * FROM vigil_subjects ORDER BY last_ended_at, last_run_id").all()) {
      const old = row.subject_key.replace(`:${row.stack}:`, ":");
      writeVigilSubject(db, { ...row, subject_key: old }, row.updated_at);
      db.query("UPDATE vigil_events SET subject_key = ?, attention_id = ? WHERE subject_key = ?").run(old, `att:vigil:${old}`, row.subject_key);
      db.query("UPDATE OR REPLACE attention_items SET id = ? WHERE id = ?").run(`att:vigil:${old}`, `att:vigil:${row.subject_key}`);
      db.query("DELETE FROM vigil_subjects WHERE subject_key = ?").run(row.subject_key);
    }
  })();
}

test("identical goal and run refs remain separate across source stacks and attention IDs", () => {
  using db = initDatabase(":memory:");
  const first = ledgerEnvelope({ outcome: "succeeded", state: { subject: "G1", value: "off-track" } });
  ingestLedgerEnvelope(db, first, ENDED_AT);
  const original = getVigilSubject(db, "state:goal:default:G1");
  const work = goal("work", "at-risk");
  ingestLedgerEnvelope(db, work, ENDED_AT + 1);
  expect(getVigilSubject(db, "state:goal:default:G1")).toEqual(original);
  expect(getVigilSubject(db, "state:goal:work:G1")).toMatchObject({ value: "at-risk", stack: "work" });
  expect(getVigilSubject(db, "run:flow:default:daily-sweep")?.last_run_id).toBe(String(first.payload.run_id));
  expect(getVigilSubject(db, "run:flow:work:daily-sweep")?.last_run_id).toBe(String(work.payload.run_id));
  expect(getAttentionItem(db, "att:vigil:state:goal:default:G1")?.status).toBe("open");
  expect(getAttentionItem(db, "att:vigil:state:goal:work:G1")?.status).toBe("open");
  expect(db.query("SELECT count(*) AS n FROM vigil_subjects").get()).toEqual({ n: 4 });
});

test.each(["jc", "jc.instance", "jc..instance", ".work.instance", "jc.work."])("refuses source without a valid stack: %s", (source) => {
  using db = initDatabase(":memory:");
  const envelope = { ...goal("default"), source };
  expect(ledgerEnvelopeError(envelope)).toContain("source");
  expect(() => ingestLedgerEnvelope(db, envelope, ENDED_AT)).toThrow("Invalid source");
  expect(db.query("SELECT * FROM vigil_subjects").all()).toEqual([]);
});

test("Vigil channel checks use the local stack", () => {
  using db = initDatabase(":memory:");
  recordChannel(db, "dm-channel", "regressed", ENDED_AT, "work");
  expect(getVigilSubject(db, channelKey("dm-channel", "work"))).toMatchObject({ stack: "work", value: "regressed" });
  expect(getVigilSubject(db, "state:check:work:vigil:dm-channel")).not.toBeNull();
  expect(getVigilSubject(db, channelKey("dm-channel", "default"))).toBeNull();
});

test("configured homes resolve goal wording separately in texts, digest and Watching", async () => {
  using db = initDatabase(":memory:");
  const root = mkdtempSync(join(tmpdir(), "vigil-stack-homes-"));
  try {
    const homes = { default: join(root, "personal"), work: join(root, "work") };
    for (const [stack, home] of Object.entries(homes)) {
      mkdirSync(join(home, "profile/goals"), { recursive: true });
      writeFileSync(join(home, "profile/goals/G1.md"), `# ${stack} wording\n`);
    }
    const config = AgentConfigSchema.parse({ claude: {}, agent: { name: "example", displayName: "Example" }, vigil: { soma_homes: homes } });
    const resolver = createVigilDeliveryPorts({ config: config.vigil, adapters: [] }).resolveGoalWording!;
    for (const stack of ["default", "work", "unconfigured"]) {
      ingestLedgerEnvelope(db, goal(stack, "at-risk"), ENDED_AT);
      db.query("UPDATE vigil_events SET delivery = 'held' WHERE subject_key = ?").run(`state:goal:${stack}:G1`);
      const subject = getVigilSubject(db, `state:goal:${stack}:G1`)!;
      const text = await createVigilRenderer({ resolveGoalWording: resolver })({ from_value: null, to_value: subject.value }, subject);
      expect(text).toContain(stack === "unconfigured" ? "goal G1" : `${stack} wording`);
    }
    const digest = await buildDigest({ db, now: ENDED_AT, resolveGoalWording: resolver });
    expect(digest).toContain("default wording");
    expect(digest).toContain("work wording");
    expect(digest).toContain("goal G1");
    const view = await (await handleListVigilSubjects(db, resolver)).json();
    expect(view.subjects.filter((s: { kind: string }) => s.kind === "state").map((s: { goalWording: string }) => s.goalWording).sort()).toEqual([null, "default wording", "work wording"].sort());
    expect(await somaGoalWording(homes)("G1", "missing")).toBeNull();
    expect(await somaGoalWording(homes)("G1", "toString")).toBeNull();
    expect(await somaGoalWording(homes)("../G1", "default")).toBeNull();
    expect(db.query("SELECT * FROM vigil_subjects").all().some((s) => JSON.stringify(s).includes("wording"))).toBe(false);
    const resultEnvelope = ledgerEnvelope({ outcome: "succeeded", serves: { goal: "G1" }, result_ref: "soma:outputs/report.md" }, "work");
    ingestLedgerEnvelope(db, resultEnvelope, ENDED_AT);
    expect(await renderResult(pendingResults(db)[0]!, { resolveGoalWording: resolver })).toContain("work wording");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivery receipts carry the stack-scoped subject key", async () => {
  using db = initDatabase(":memory:");
  ingestLedgerEnvelope(db, goal("work"), ENDED_AT);
  const receipts: unknown[] = [];
  await flushTexts({ db, principal: "jc", now: ENDED_AT, send: async () => ({ delivered: true, messageId: "sent" }),
    publish: async (envelope) => { receipts.push(envelope.payload); } });
  expect(receipts).toEqual([expect.objectContaining({ subject_key: "state:goal:work:G1" })]);
});

test("replay replaces collided legacy subjects, reconnects events and preserves delivered budget", async () => {
  using db = initDatabase(":memory:");
  const personal = goal("default");
  const work = ledgerEnvelope({ outcome: "succeeded", serves: { goal: "G1" }, state: { subject: "G1", value: "at-risk" },
    ended_at: new Date(ENDED_AT + 1000).toISOString() }, "work");
  ingestLedgerEnvelope(db, personal, ENDED_AT);
  ingestLedgerEnvelope(db, work, ENDED_AT + 1000);
  makeLegacy(db);
  const event = listVigilEvents(db, "state:goal:G1")[0]!;
  recordVigilTextReceipt(db, { event_id: event.id, subject_key: "state:goal:G1", budget_day: budgetDay(ENDED_AT) });
  expect(hasLegacyVigilSubjects(db)).toBe(true);
  const ledger = await recordedLedger([personal, work]);
  expect(await replayLedger({ ...ledger, db })).toBe(2);
  expect(hasLegacyVigilSubjects(db)).toBe(false);
  expect(getVigilSubject(db, "state:goal:G1")).toBeNull();
  expect(getVigilSubject(db, "state:goal:default:G1")?.value).toBe("off-track");
  expect(getVigilSubject(db, "state:goal:work:G1")?.value).toBe("at-risk");
  expect(listVigilEvents(db, "state:goal:default:G1")).toHaveLength(1);
  expect(listVigilEvents(db, "state:goal:work:G1")).toHaveLength(1);
  expect(getAttentionItem(db, "att:vigil:state:goal:G1")).toBeNull();
  expect(getAttentionItem(db, "att:vigil:state:goal:work:G1")?.status).toBe("open");
  expect(getVigilTextsSpent(db, budgetDay(ENDED_AT))).toBe(1);
  expect(db.query("SELECT subject_key FROM vigil_text_receipts").all()).toEqual([{ subject_key: "state:goal:default:G1" }]);
  expect(await replayLedger({ ...ledger, db })).toBe(2);
  expect(getVigilTextsSpent(db, budgetDay(ENDED_AT))).toBe(1);
});

test("startup replays populated legacy rows and subsequent starts skip the migration", async () => {
  using db = initDatabase(":memory:");
  const envelope = goal("default");
  ingestLedgerEnvelope(db, envelope, ENDED_AT);
  recordChannel(db, "email-channel", "regressed", ENDED_AT);
  makeLegacy(db);
  const ledger = await recordedLedger([envelope, goal("work")]);
  const config = AgentConfigSchema.parse({ claude: {}, agent: { name: "example", displayName: "Example" }, mc: { enabled: true }, vigil: { enabled: true } });
  const opts = { ...ledger, db, config, stack: "default", schedule: fakeTickScheduler().schedule, now: () => ENDED_AT };
  const handle = await startVigil(opts);
  await handle?.stop();
  expect(hasLegacyVigilSubjects(db)).toBe(false);
  expect(getVigilSubject(db, channelKey("email-channel"))?.value).toBe("regressed");
  expect(db.query("SELECT count(*) AS n FROM vigil_subjects").get()).toEqual({ n: 6 });
  const restarted = await startVigil(opts);
  await restarted?.stop();
  expect(db.query("SELECT count(*) AS n FROM vigil_subjects").get()).toEqual({ n: 6 });
});

const laterRun = (offsetMs: number) => ledgerEnvelope({
  outcome: "succeeded", serves: { goal: "G2" }, state: { subject: "G2", value: "on-track" },
  ended_at: new Date(ENDED_AT + offsetMs).toISOString(),
}, "default");

test("a legacy subject missing inside LEDGER retention refuses migration and leaves old rows for retry", async () => {
  using db = initDatabase(":memory:");
  ingestLedgerEnvelope(db, goal("work"), ENDED_AT);
  makeLegacy(db);
  const ledger = await recordedLedger([laterRun(-1000)]);
  expect(await replayLedger({ ...ledger, db })).toBeNull();
  expect(hasLegacyVigilSubjects(db)).toBe(true);
  expect(isVigilReplayPending(db)).toBe(true);
});

test("a legacy subject whose LEDGER history aged out keeps its row under its recorded stack and Vigil starts", async () => {
  using db = initDatabase(":memory:");
  ingestLedgerEnvelope(db, goal("work"), ENDED_AT);
  makeLegacy(db);
  const warnings: string[] = [];
  const ledger = await recordedLedger([laterRun(86_400_000)]);
  const config = AgentConfigSchema.parse({ claude: {}, agent: { name: "example", displayName: "Example" }, mc: { enabled: true }, vigil: { enabled: true } });
  const handle = await startVigil({
    ...ledger, db, config, stack: "default", schedule: fakeTickScheduler().schedule, now: () => ENDED_AT,
    log: { info: () => {}, warn: (line: string) => { warnings.push(line); } },
  });
  expect(handle).not.toBeNull();
  await handle?.stop();
  expect(hasLegacyVigilSubjects(db)).toBe(false);
  expect(isVigilReplayPending(db)).toBe(false);
  expect(getVigilSubject(db, "state:goal:G1")).toBeNull();
  expect(getVigilSubject(db, "state:goal:work:G1")?.value).toBe("off-track");
  expect(listVigilEvents(db, "state:goal:work:G1")).toHaveLength(1);
  expect(getAttentionItem(db, "att:vigil:state:goal:work:G1")?.status).toBe("open");
  expect(warnings).toContain("vigil: state:goal:work:G1 kept from its legacy row; its LEDGER history has aged out");
});

test("an empty LEDGER treats every legacy subject as aged out", async () => {
  using db = initDatabase(":memory:");
  ingestLedgerEnvelope(db, goal("work"), ENDED_AT);
  makeLegacy(db);
  const ledger = await recordedLedger([]);
  expect(await replayLedger({ ...ledger, db })).toBe(0);
  expect(hasLegacyVigilSubjects(db)).toBe(false);
  expect(getVigilSubject(db, "state:goal:work:G1")?.value).toBe("off-track");
});
