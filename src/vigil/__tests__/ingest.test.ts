// glossary-ignore: run
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../surface/mc/db/init";
import { TABLE_NAMES } from "../../surface/mc/db/schema";
import { getVigilSubject, listVigilEvents } from "../db";
import { runHealthKey, stackOfEnvelope } from "../ingest";
import { ingestLedgerEnvelope, DELIVERY_DEFAULTS, ENDED_AT, KEY, ledgerEnvelope } from "./fixtures";

describe("Vigil run-health ingest", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => db.close());

  test("first unhealthy observation writes subject and worse transition", () => {
    const envelope = ledgerEnvelope({ serves: { goal: "M0" } });
    ingestLedgerEnvelope(db, envelope, 100);
    expect(getVigilSubject(db, KEY)).toEqual({
      subject_key: KEY, subject_kind: "run", vocab: null, ref: "daily-sweep",
      value: "failed", healthy: 0, goal_id: "M0", producer: "pulse", stack: "default", run_kind: "flow",
      last_run_id: String(envelope.payload.run_id), last_ended_at: ENDED_AT,
      last_seen_at: 100, updated_at: 100, cadence_ms: 93600000,
    });
    expect(listVigilEvents(db, KEY)).toEqual([{
      ...DELIVERY_DEFAULTS,
      id: expect.any(String), subject_key: KEY, event_kind: "transition",
      severity: "high", attention_id: `att:vigil:${KEY}`,
      route: "text", delivery: "pending",
      from_value: null, to_value: "failed", direction: "worse",
      run_id: String(envelope.payload.run_id), occurred_at: ENDED_AT, created_at: 100,
    }]);
    expect(TABLE_NAMES).toContain("vigil_subjects");
    expect(TABLE_NAMES).toContain("vigil_events");
  });

  test("first healthy observation is a ledger line only", () => {
    ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded" }), 100);
    expect(getVigilSubject(db, KEY)).toMatchObject({ value: "succeeded", healthy: 1, goal_id: null });
    expect(listVigilEvents(db, KEY)).toEqual([]);
  });

  test("repeat refreshes metadata without an event; cadence survives", () => {
    ingestLedgerEnvelope(db, ledgerEnvelope(), 100);
    db.run("UPDATE vigil_subjects SET cadence_ms = 123 WHERE subject_key = ?", [KEY]);
    const repeat = ledgerEnvelope({ ended_at: "2026-10-12T10:01:00.000Z" });
    ingestLedgerEnvelope(db, repeat, 200);
    expect(getVigilSubject(db, KEY)).toMatchObject({
      value: "failed", last_run_id: repeat.payload.run_id,
      last_ended_at: ENDED_AT + 55_000, last_seen_at: 200, updated_at: 200, cadence_ms: 123,
    });
    expect(listVigilEvents(db, KEY)).toHaveLength(1);
  });

  test.each(["succeeded", "blocked", "cancelled"] as const)("failed to %s is a transition", (outcome) => {
    ingestLedgerEnvelope(db, ledgerEnvelope(), 100);
    ingestLedgerEnvelope(db, ledgerEnvelope({ outcome, ended_at: "2026-10-12T10:01:00.000Z" }), 200);
    expect(getVigilSubject(db, KEY)).toMatchObject({ value: outcome, healthy: outcome === "succeeded" ? 1 : 0 });
    expect(listVigilEvents(db, KEY)[1]).toMatchObject({
      from_value: "failed", to_value: outcome, direction: outcome === "succeeded" ? "better" : "worse",
    });
  });

  test("redelivery and older ended_at leave all rows unchanged", () => {
    const first = ledgerEnvelope();
    ingestLedgerEnvelope(db, first, 100);
    const prior = getVigilSubject(db, KEY);
    const events = listVigilEvents(db, KEY);
    ingestLedgerEnvelope(db, first, 200);
    ingestLedgerEnvelope(db, ledgerEnvelope({
      run_id: String(first.payload.run_id), outcome: "succeeded", ended_at: "2026-10-12T10:02:00.000Z",
    }), 300);
    ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", ended_at: "2026-10-12T10:00:04.000Z" }), 400);
    expect(getVigilSubject(db, KEY)).toEqual(prior);
    expect(listVigilEvents(db, KEY)).toEqual(events);
  });

  // glossary-ignore: run
  // Execution Run identifiers belong to the myelin contract, not Cortex Sessions.
  test("equal ended_at: the higher run_id wins whatever the arrival order", () => {
    const a = ledgerEnvelope({ run_id: "run-a", outcome: "failed" });
    const b = ledgerEnvelope({ run_id: "run-b", outcome: "succeeded" });
    for (const [order, directions] of [[[a, b], ["worse", "better"]], [[b, a], []]] as const) {
      db.run("DELETE FROM vigil_events"); db.run("DELETE FROM vigil_subjects");
      order.forEach((envelope, i) => ingestLedgerEnvelope(db, envelope, 100 * (i + 1)));
      expect(getVigilSubject(db, KEY)).toMatchObject({ value: "succeeded", healthy: 1, last_run_id: "run-b" });
      expect(listVigilEvents(db, KEY).map((e) => e.direction)).toEqual([...directions]);
      const prior = getVigilSubject(db, KEY);
      const events = listVigilEvents(db, KEY);
      [a, b, a, b].forEach((envelope, i) => {
        ingestLedgerEnvelope(db, envelope, 300 + 100 * i);
        expect(getVigilSubject(db, KEY)).toEqual(prior);
        expect(listVigilEvents(db, KEY)).toEqual(events);
      });
    }
  });

  test("run kind is part of subject identity", () => {
    ingestLedgerEnvelope(db, ledgerEnvelope(), 100);
    ingestLedgerEnvelope(db, ledgerEnvelope({ ran: { kind: "job", ref: "daily-sweep" } }), 100);
    expect(db.query("SELECT subject_key FROM vigil_subjects ORDER BY subject_key").all()).toEqual([
      { subject_key: KEY }, { subject_key: "run:job:default:daily-sweep" },
    ]);
  });

  test("run identity includes the received subject stack", () => {
    const fromSwitch = ledgerEnvelope({ ended_at: "2026-10-12T10:01:00.000Z" }, "switch");
    expect(stackOfEnvelope("local.example.switch.execution.run.finished")).toBe("switch");
    expect(runHealthKey(fromSwitch.payload as never, "switch")).toBe("run:flow:switch:daily-sweep");
    ingestLedgerEnvelope(db, ledgerEnvelope(), 100);
    ingestLedgerEnvelope(db, fromSwitch, 200);
    expect(db.query("SELECT subject_key, stack FROM vigil_subjects").all()).toEqual([{ subject_key: KEY, stack: "default" }, { subject_key: "run:flow:switch:daily-sweep", stack: "switch" }]);
    expect(listVigilEvents(db, KEY)).toHaveLength(1);
  });

  test("event failure rolls back subject write; retry applies the transition once", () => {
    ingestLedgerEnvelope(db, ledgerEnvelope(), 100);
    const prior = getVigilSubject(db, KEY);
    db.run("CREATE TRIGGER fail_vigil BEFORE INSERT ON vigil_events BEGIN SELECT RAISE(ABORT, 'db failure'); END");
    const recovery = ledgerEnvelope({ outcome: "succeeded", ended_at: "2026-10-12T10:01:00.000Z" });
    expect(() => ingestLedgerEnvelope(db, recovery, 200)).toThrow("db failure");
    expect(getVigilSubject(db, KEY)).toEqual(prior);
    expect(listVigilEvents(db, KEY)).toHaveLength(1);
    db.run("DROP TRIGGER fail_vigil");
    ingestLedgerEnvelope(db, recovery, 200);
    ingestLedgerEnvelope(db, recovery, 300);
    expect(listVigilEvents(db, KEY)).toHaveLength(2);
  });
});
