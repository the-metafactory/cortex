// glossary-ignore: run
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../surface/mc/db/init";
import { getVigilSubject, listVigilEvents } from "../db";
import { ingestLedgerEnvelope } from "../ingest";
import { STALE_VALUE, STATE_VOCABULARIES, stateDirection, stateRank, vocabularyOf } from "../state-subject";
import { DELIVERY_DEFAULTS, ENDED_AT, KEY, ledgerEnvelope } from "./fixtures";

describe("state registry", () => {
  test.each([
    ["on-track", "goal"], ["at-risk", "goal"], ["off-track", "goal"],
    ["resolved", "escalation"], ["needs-principal", "escalation"], ["overdue", "escalation"],
    ["ok", "check"], ["regressed", "check"], ["green", "unknown"], [STALE_VALUE, "unknown"],
  ] as const)("vocabularyOf(%s) is %s", (value, vocab) => {
    expect(vocabularyOf(value)).toBe(vocab);
  });

  test("the three value sets are disjoint", () => {
    const all = Object.values(STATE_VOCABULARIES).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  test("rank is the position, healthiest first; only rank 0 is healthy", () => {
    expect(stateRank("goal", "on-track")).toBe(0);
    expect(stateRank("goal", "at-risk")).toBe(1);
    expect(stateRank("goal", "off-track")).toBe(2);
    expect(stateRank("escalation", "resolved")).toBe(0);
    expect(stateRank("escalation", "overdue")).toBe(2);
    expect(stateRank("check", "ok")).toBe(0);
    expect(stateRank("check", "regressed")).toBe(1);
    expect(stateRank("unknown", "green")).toBeGreaterThan(0);
  });

  test("stale ranks worse than every goal value", () => {
    for (const value of STATE_VOCABULARIES.goal) {
      expect(stateRank("goal", STALE_VALUE)).toBeGreaterThan(stateRank("goal", value));
      expect(stateDirection("goal", STALE_VALUE, value)).toBe("better");
    }
  });

  test("direction follows rank; unknown changes are always worse", () => {
    expect(stateDirection("goal", "off-track", "at-risk")).toBe("better");
    expect(stateDirection("goal", "on-track", "at-risk")).toBe("worse");
    expect(stateDirection("escalation", "needs-principal", "overdue")).toBe("worse");
    expect(stateDirection("check", "regressed", "ok")).toBe("better");
    expect(stateDirection("unknown", "red", "green")).toBe("worse");
    expect(stateDirection("unknown", "green", "red")).toBe("worse");
  });

  test("a repeated value and a healthy first observation are not events", () => {
    expect(stateDirection("goal", "at-risk", "at-risk")).toBeNull();
    expect(stateDirection("unknown", "green", "green")).toBeNull();
    for (const value of ["on-track", "resolved", "ok"]) expect(stateDirection(vocabularyOf(value), null, value)).toBeNull();
    expect(stateDirection("goal", null, "at-risk")).toBe("worse");
    expect(stateDirection("unknown", null, "green")).toBe("worse");
  });
});

describe("Vigil state-subject ingest", () => {
  let db: Database;
  let t: number;
  beforeEach(() => { db = initDatabase(":memory:"); t = 0; });
  afterEach(() => db.close());

  /** Each call ends one minute after the previous one. */
  function report(subject: string, value: string, overrides: Parameters<typeof ledgerEnvelope>[0] = {}) {
    t += 1;
    const envelope = ledgerEnvelope({
      state: { subject, value }, ended_at: new Date(ENDED_AT + t * 60_000).toISOString(), ...overrides,
    });
    ingestLedgerEnvelope(db, envelope, 100 * t);
    return envelope;
  }

  test("unseen escalation subject: row, worse event, run-health alongside", () => {
    const envelope = report("the-metafactory/soma#781", "needs-principal", { serves: { goal: "M0" } });
    const key = "state:escalation:default:the-metafactory/soma#781";
    expect(getVigilSubject(db, key)).toEqual({
      subject_key: key, subject_kind: "state", vocab: "escalation", ref: "the-metafactory/soma#781",
      value: "needs-principal", healthy: 0, goal_id: "M0", producer: "pulse", stack: "default", run_kind: null,
      last_run_id: String(envelope.payload.run_id), last_ended_at: ENDED_AT + 60_000,
      last_seen_at: 100, updated_at: 100, cadence_ms: 93600000,
    });
    expect(listVigilEvents(db, key)).toEqual([{
      ...DELIVERY_DEFAULTS,
      id: expect.any(String), subject_key: key, event_kind: "transition",
      severity: "normal", attention_id: `att:vigil:${key}`,
      route: "digest", delivery: "pending",
      from_value: null, to_value: "needs-principal", direction: "worse",
      run_id: String(envelope.payload.run_id), occurred_at: ENDED_AT + 60_000, created_at: 100,
    }]);
    expect(getVigilSubject(db, KEY)).toMatchObject({ subject_kind: "run", value: "failed", healthy: 0 });
    expect(listVigilEvents(db, KEY)).toHaveLength(1);
  });

  test("goal_id is NULL without serves.goal", () => {
    report("G1", "at-risk");
    expect(getVigilSubject(db, "state:goal:default:G1")?.goal_id).toBeNull();
  });

  test("escalation needs-principal → overdue → resolved", () => {
    const key = "state:escalation:default:the-metafactory/soma#781";
    report("the-metafactory/soma#781", "needs-principal");
    report("the-metafactory/soma#781", "overdue");
    expect(listVigilEvents(db, key)[1]).toMatchObject({ from_value: "needs-principal", to_value: "overdue", direction: "worse" });
    expect(getVigilSubject(db, key)?.healthy).toBe(0);
    report("the-metafactory/soma#781", "resolved");
    expect(listVigilEvents(db, key)).toHaveLength(3);
    expect(listVigilEvents(db, key)[2]).toMatchObject({ from_value: "overdue", to_value: "resolved", direction: "better" });
    expect(getVigilSubject(db, key)?.healthy).toBe(1);
  });

  test("check regressed → ok is better and healthy", () => {
    const key = "state:check:default:soma:harness";
    report("soma:harness", "regressed");
    report("soma:harness", "ok");
    expect(listVigilEvents(db, key)[1]).toMatchObject({ from_value: "regressed", to_value: "ok", direction: "better" });
    expect(getVigilSubject(db, key)).toMatchObject({ value: "ok", healthy: 1 });
  });

  test("goal off-track → at-risk stays unhealthy; → on-track is healthy", () => {
    const key = "state:goal:default:G1";
    report("G1", "off-track");
    report("G1", "at-risk");
    expect(listVigilEvents(db, key)[1]).toMatchObject({ from_value: "off-track", to_value: "at-risk", direction: "better" });
    expect(getVigilSubject(db, key)?.healthy).toBe(0);
    report("G1", "on-track");
    expect(listVigilEvents(db, key)[2]).toMatchObject({ from_value: "at-risk", to_value: "on-track", direction: "better" });
    expect(getVigilSubject(db, key)?.healthy).toBe(1);
  });

  test.each([["on-track", "goal"], ["resolved", "escalation"], ["ok", "check"]])(
    "healthy first observation %s writes the row and no event",
    (value, vocab) => {
      report("s", value);
      expect(getVigilSubject(db, `state:${vocab}:default:s`)).toMatchObject({ value, vocab, healthy: 1 });
      expect(listVigilEvents(db, `state:${vocab}:default:s`)).toEqual([]);
    },
  );

  test("a repeated value changes neither value nor events; the observation refreshes", () => {
    const key = "state:goal:default:G1";
    report("G1", "at-risk");
    const prior = getVigilSubject(db, key);
    const events = listVigilEvents(db, key);
    const repeat = report("G1", "at-risk");
    expect(listVigilEvents(db, key)).toEqual(events);
    expect(getVigilSubject(db, key)).toEqual({
      ...prior!, last_run_id: String(repeat.payload.run_id), last_ended_at: ENDED_AT + 120_000,
      last_seen_at: 200, updated_at: 200,
    });
  });

  test("redelivered run_id and older ended_at leave the state row and events unchanged", () => {
    const key = "state:goal:default:G1";
    const first = report("G1", "at-risk");
    const prior = getVigilSubject(db, key);
    const events = listVigilEvents(db, key);
    ingestLedgerEnvelope(db, first, 900);
    report("G1", "on-track", { run_id: String(first.payload.run_id) });
    report("G1", "on-track", { ended_at: new Date(ENDED_AT).toISOString() });
    expect(getVigilSubject(db, key)).toEqual(prior);
    expect(listVigilEvents(db, key)).toEqual(events);
  });

  // glossary-ignore: run
  // Execution Run identifiers belong to the myelin contract, not Cortex Sessions.
  test("two executions with one ended_at converge on the higher run_id in any arrival order", () => {
    const key = "state:goal:default:G1";
    const endedAt = new Date(ENDED_AT).toISOString();
    const a = ledgerEnvelope({ run_id: "run-a", ended_at: endedAt, state: { subject: "G1", value: "at-risk" } });
    const b = ledgerEnvelope({ run_id: "run-b", ended_at: endedAt, state: { subject: "G1", value: "on-track" } });
    for (const [order, directions] of [[[a, b], ["worse", "better"]], [[b, a], []]] as const) {
      db.run("DELETE FROM vigil_events"); db.run("DELETE FROM vigil_subjects");
      order.forEach((envelope, i) => ingestLedgerEnvelope(db, envelope, 100 * (i + 1)));
      expect(getVigilSubject(db, key)).toMatchObject({ value: "on-track", healthy: 1, last_run_id: "run-b" });
      expect(listVigilEvents(db, key).map((e) => e.direction)).toEqual([...directions]);
      const prior = getVigilSubject(db, key);
      const events = listVigilEvents(db, key);
      [a, b, a, b].forEach((envelope, i) => {
        ingestLedgerEnvelope(db, envelope, 300 + 100 * i);
        expect(getVigilSubject(db, key)).toEqual(prior);
        expect(listVigilEvents(db, key)).toEqual(events);
      });
    }
  });

  test("state subject dedupes on its own timeline, not the run-health one", () => {
    report("G1", "at-risk", { ran: { kind: "job", ref: "a" } });
    report("G1", "on-track", { ran: { kind: "job", ref: "b" } });
    expect(getVigilSubject(db, "state:goal:default:G1")).toMatchObject({ value: "on-track", healthy: 1 });
  });

  test("unknown values are stored as given, unhealthy, and every change is worse", () => {
    const key = "state:unknown:default:x";
    report("x", "green");
    expect(getVigilSubject(db, key)).toMatchObject({ vocab: "unknown", value: "green", healthy: 0 });
    expect(listVigilEvents(db, key)).toEqual([expect.objectContaining({ from_value: null, to_value: "green", direction: "worse" })]);
    report("x", "blue");
    expect(listVigilEvents(db, key)[1]).toMatchObject({ from_value: "green", to_value: "blue", direction: "worse" });
  });

  test("a goal row the sweep marked stale recovers with a better event", () => {
    const key = "state:goal:default:G1";
    report("G1", "on-track");
    db.run("UPDATE vigil_subjects SET value = ?, healthy = 0 WHERE subject_key = ?", [STALE_VALUE, key]);
    report("G1", "at-risk");
    expect(listVigilEvents(db, key)).toEqual([expect.objectContaining({ from_value: STALE_VALUE, to_value: "at-risk", direction: "better" })]);
    expect(getVigilSubject(db, key)).toMatchObject({ vocab: "goal", value: "at-risk", healthy: 0 });
  });

  test("an envelope without state touches no state row", () => {
    ingestLedgerEnvelope(db, ledgerEnvelope(), 100);
    expect(db.query("SELECT subject_key FROM vigil_subjects WHERE subject_kind = 'state'").all()).toEqual([]);
  });
});
