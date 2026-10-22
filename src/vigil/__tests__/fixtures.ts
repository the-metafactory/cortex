// glossary-ignore: run
import { createEnvelope, createExecutionRunFinished, type ExecutionRunFinishedPayloadInput } from "@the-metafactory/myelin";
import { expect, mock } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../../surface/mc/db/init";
import { ingestLedgerEnvelope as ingestReceivedLedgerEnvelope } from "../ingest";
import { deriveNatsSubject, type Envelope } from "../../bus/myelin/envelope-validator";
import { createFakeJetStream } from "../../bus/jetstream/__tests__/fake-jetstream";
import { LEDGER_STREAM, provisionLedgerStream } from "../../bus/jetstream/provision";
import type { MyelinSubscribePullOpts } from "../../bus/myelin/runtime";
import type { MyelinSubscriber } from "../../bus/myelin/subscriber";
import { flushTexts } from "../flush";

export const SUBJECT = "local.jc.default.execution.run.finished";
export const KEY = "run:flow:default:daily-sweep";
export const ENDED_AT = Date.parse("2026-10-12T10:00:05.000Z");
export const DELIVERY_DEFAULTS = {
  held_reason: null, sent_at: null, digested_at: null, via: null, attempts: 0, last_error: null, transient_failures: 0,
} as const;

export async function expectNoVigilTextDelivery(db: Database) {
  const send = mock(async () => ({ delivered: true as const, messageId: "unused" }));
  const publish = mock(async () => {});
  await flushTexts({ db, now: ENDED_AT, principal: "example", send, publish });
  expect(send).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(db.query("SELECT * FROM vigil_budget").all()).toEqual([]);
}

export function initVigilGoalDatabase() {
  const db = initDatabase(":memory:");
  ingestLedgerEnvelope(db, ledgerEnvelope({ state: { subject: "G1", value: "on-track" } }), ENDED_AT, { replay: true });
  return db;
}

export function temporaryVigilDatabaseFile(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    path: join(dir, "mc.db"),
    [Symbol.dispose]() { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Captures an interval so tests can advance Vigil without wall-clock waits. */
export function fakeTickScheduler() {
  let callback: (() => void) | undefined;
  let intervalMs: number | undefined;
  let cancellations = 0;
  return {
    schedule: (fn: () => void, ms: number) => {
      callback = fn;
      intervalMs = ms;
      return () => { cancellations += 1; };
    },
    tick: () => callback?.(),
    get intervalMs() { return intervalMs; },
    get cancellations() { return cancellations; },
  };
}

export const flushTick = async () => {
  await Bun.sleep(0);
};

const SOVEREIGNTY = { classification: "local", data_residency: "CH", max_hop: 0, frontier_ok: false, model_class: "any" } as const;

export function ledgerEnvelope(overrides: Partial<ExecutionRunFinishedPayloadInput> = {}, stack = "default") {
  const event = createExecutionRunFinished({
    source: `jc.${stack}.pulse`,
    principal: "jc", stack,
    sovereignty: SOVEREIGNTY,
    payload: {
      run_id: crypto.randomUUID(), producer: "pulse",
      ran: { kind: "flow", ref: "daily-sweep" }, outcome: "failed",
      started_at: "2026-10-12T10:00:00.000Z", ended_at: "2026-10-12T10:00:05.000Z",
      ...overrides,
    },
  });
  return createEnvelope({ ...event.input, sovereignty: SOVEREIGNTY });
}

export function ingestLedgerEnvelope(
  db: Database, envelope: Envelope, now: number, opts: Parameters<typeof ingestReceivedLedgerEnvelope>[4] = {},
) {
  return ingestReceivedLedgerEnvelope(db, envelope, deriveNatsSubject(envelope, envelope.source.split(".")[1] ?? "default"), now, opts);
}

export async function recordedVigilLedger(records: { envelope: Envelope; subject: string }[]) {
  const log = { info: mock((_line: string) => {}), warn: mock((_line: string) => {}) };
  const fake = createFakeJetStream();
  await provisionLedgerStream({ jsm: fake.jsm, principal: "jc", log });
  for (const { envelope, subject } of records) fake.publish(subject, Date.parse(String(envelope.payload.ended_at)));
  const calls: MyelinSubscribePullOpts[] = [];
  const runtime = {
    jetstreamManager: async () => fake.jsm,
    subscribePull: (opts: MyelinSubscribePullOpts) => {
      calls.push(opts);
      if (opts.durable.includes("replay")) {
        fake.pull(LEDGER_STREAM, opts.durable);
        for (const { envelope, subject } of records) opts.onEnvelope(envelope, subject, { working: () => undefined });
      }
      return { ready: Promise.resolve(), stop: async () => {} } as unknown as MyelinSubscriber;
    },
  };
  return { jsm: fake.jsm, runtime, principal: "jc", log, pollMs: 1, calls };
}
