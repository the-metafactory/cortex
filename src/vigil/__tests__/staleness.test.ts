// glossary-ignore: run, node
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../surface/mc/db/init";
import { getVigilSubject, listVigilEvents } from "../db";
import { ingestLedgerEnvelope } from "../ingest";
import { DEFAULT_CADENCE_MS, effectiveCadenceMs, sweepStale } from "../staleness";
import { DELIVERY_DEFAULTS, ENDED_AT, ledgerEnvelope } from "./fixtures";

const JOB_KEY = "run:job:default:harness-gate";
const GOAL_KEY = "state:goal:default:G1";
const DEADLINE = ENDED_AT + 2 * DEFAULT_CADENCE_MS;
const job = () => ledgerEnvelope({ ran: { kind: "job", ref: "harness-gate" }, outcome: "succeeded" });

describe("Vigil staleness", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => db.close());

  test("default cadence is 26 hours and only strictly beyond twice it goes stale", () => {
    ingestLedgerEnvelope(db, job(), ENDED_AT);
    // Cadence comes from cortex config, never the legacy observation column.
    db.query("UPDATE vigil_subjects SET cadence_ms = 1 WHERE subject_key = ?").run(JOB_KEY);
    const before = getVigilSubject(db, JOB_KEY)!;
    expect(effectiveCadenceMs(before, {})).toBe(26 * 60 * 60 * 1000);
    sweepStale(db, DEADLINE, {});
    expect(getVigilSubject(db, JOB_KEY)).toEqual(before);
    expect(listVigilEvents(db, JOB_KEY)).toEqual([]);

    sweepStale(db, DEADLINE + 1, {});
    expect(getVigilSubject(db, JOB_KEY)).toEqual({ ...before, value: "stale", healthy: 0, updated_at: DEADLINE + 1 });
    expect(listVigilEvents(db, JOB_KEY)).toEqual([{
      ...DELIVERY_DEFAULTS,
      id: expect.any(String), subject_key: JOB_KEY, event_kind: "transition",
      severity: "normal", attention_id: `att:vigil:${JOB_KEY}`,
      route: "digest", delivery: "pending",
      from_value: "succeeded", to_value: "stale", direction: "worse",
      run_id: before.last_run_id, occurred_at: DEADLINE + 1, created_at: DEADLINE + 1,
    }]);
    sweepStale(db, DEADLINE + 2, {});
    expect(listVigilEvents(db, JOB_KEY)).toHaveLength(1);
    expect(getVigilSubject(db, JOB_KEY)?.updated_at).toBe(DEADLINE + 1);
  });

  test("goal state goes stale and a fresh envelope recovers both job and goal", () => {
    ingestLedgerEnvelope(db, ledgerEnvelope({
      ran: { kind: "job", ref: "harness-gate" }, outcome: "succeeded",
      state: { subject: "G1", value: "on-track" },
    }), ENDED_AT);
    sweepStale(db, DEADLINE, {});
    expect(getVigilSubject(db, GOAL_KEY)?.value).toBe("on-track");
    sweepStale(db, DEADLINE + 1, {});
    expect(getVigilSubject(db, GOAL_KEY)).toMatchObject({ value: "stale", healthy: 0 });
    expect(listVigilEvents(db, GOAL_KEY)).toHaveLength(1);
    expect(listVigilEvents(db, GOAL_KEY)[0]).toMatchObject({ from_value: "on-track", to_value: "stale", direction: "worse" });
    sweepStale(db, DEADLINE + 2, {});
    expect(listVigilEvents(db, GOAL_KEY)).toHaveLength(1);

    ingestLedgerEnvelope(db, ledgerEnvelope({
      ran: { kind: "job", ref: "harness-gate" }, outcome: "succeeded",
      state: { subject: "G1", value: "on-track" },
      ended_at: new Date(DEADLINE + 3).toISOString(),
    }), DEADLINE + 3);
    for (const key of [JOB_KEY, GOAL_KEY]) {
      expect(getVigilSubject(db, key)?.healthy).toBe(1);
      expect(listVigilEvents(db, key)).toHaveLength(2);
      expect(listVigilEvents(db, key)[1]).toMatchObject({ from_value: "stale", direction: "better" });
    }
    expect(listVigilEvents(db, JOB_KEY)[1]?.to_value).toBe("succeeded");
    expect(listVigilEvents(db, GOAL_KEY)[1]?.to_value).toBe("on-track");
  });

  test("per-subject overrides use milliseconds and other subjects keep the default", () => {
    ingestLedgerEnvelope(db, job(), ENDED_AT);
    ingestLedgerEnvelope(db, ledgerEnvelope({
      outcome: "succeeded", state: { subject: "G1", value: "on-track" },
    }), ENDED_AT);
    const cadence = { [JOB_KEY]: 3_600_000 };
    expect(effectiveCadenceMs(getVigilSubject(db, JOB_KEY)!, cadence)).toBe(3_600_000);
    expect(effectiveCadenceMs(getVigilSubject(db, GOAL_KEY)!, cadence)).toBe(DEFAULT_CADENCE_MS);
    sweepStale(db, ENDED_AT + 7_200_000, cadence);
    expect(getVigilSubject(db, JOB_KEY)?.value).toBe("succeeded");
    sweepStale(db, ENDED_AT + 7_200_001, cadence);
    expect(getVigilSubject(db, JOB_KEY)?.value).toBe("stale");
    expect(getVigilSubject(db, GOAL_KEY)?.value).toBe("on-track");
    sweepStale(db, DEADLINE + 1, cadence);
    expect(getVigilSubject(db, GOAL_KEY)?.value).toBe("stale");
  });

  test("goal cadence overrides are keyed by the full subject key", () => {
    ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", state: { subject: "G1", value: "on-track" } }), ENDED_AT);
    const cadence = { [GOAL_KEY]: 1 };
    sweepStale(db, ENDED_AT + 2, cadence);
    expect(getVigilSubject(db, GOAL_KEY)?.value).toBe("on-track");
    sweepStale(db, ENDED_AT + 3, cadence);
    expect(getVigilSubject(db, GOAL_KEY)?.value).toBe("stale");
  });

  test("node, algorithm, dispatch, flow and non-goal vocabularies never go stale, even with overrides", () => {
    for (const kind of ["node", "algorithm", "dispatch", "flow"] as const) {
      ingestLedgerEnvelope(db, ledgerEnvelope({ ran: { kind, ref: "test" }, outcome: "succeeded" }), ENDED_AT);
    }
    for (const value of ["resolved", "ok", "custom-value"]) {
      ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", state: { subject: "test", value } }), ENDED_AT);
    }
    const before = db.query("SELECT * FROM vigil_subjects ORDER BY subject_key").all();
    const subjects = db.query<{ subject_key: string }, []>("SELECT subject_key FROM vigil_subjects").all();
    const cadence = Object.fromEntries(subjects.map(({ subject_key }) => [subject_key, 1]));
    for (const { subject_key } of subjects) {
      expect(effectiveCadenceMs(getVigilSubject(db, subject_key)!, cadence)).toBeNull();
    }
    const events = db.query("SELECT * FROM vigil_events").all();
    sweepStale(db, ENDED_AT + 30 * 24 * 60 * 60 * 1000, cadence);
    expect(db.query("SELECT * FROM vigil_subjects ORDER BY subject_key").all()).toEqual(before);
    expect(db.query("SELECT * FROM vigil_events").all()).toEqual(events);
  });

  test("an already-failed job still writes a worse transition when it goes stale", () => {
    ingestLedgerEnvelope(db, ledgerEnvelope({ ran: { kind: "job", ref: "harness-gate" } }), ENDED_AT);
    sweepStale(db, DEADLINE + 1, {});
    expect(getVigilSubject(db, JOB_KEY)).toMatchObject({ value: "stale", healthy: 0 });
    expect(listVigilEvents(db, JOB_KEY)).toHaveLength(2);
    expect(listVigilEvents(db, JOB_KEY)[1]).toMatchObject({ from_value: "failed", to_value: "stale", direction: "worse" });
  });

  test("the envelope end time controls silence, refreshed even by a repeated healthy value", () => {
    ingestLedgerEnvelope(db, job(), DEADLINE + 1);
    // Receipt time does not grant an old envelope another two cadences.
    sweepStale(db, DEADLINE + 1, {});
    expect(getVigilSubject(db, JOB_KEY)?.value).toBe("stale");
    ingestLedgerEnvelope(db, ledgerEnvelope({
      ran: { kind: "job", ref: "harness-gate" }, outcome: "succeeded",
      ended_at: new Date(DEADLINE + 2).toISOString(),
    }), DEADLINE + 2);
    ingestLedgerEnvelope(db, ledgerEnvelope({
      ran: { kind: "job", ref: "harness-gate" }, outcome: "succeeded",
      ended_at: new Date(DEADLINE + 100).toISOString(),
    }), DEADLINE + 100);
    sweepStale(db, DEADLINE + 100 + 2 * DEFAULT_CADENCE_MS, {});
    expect(getVigilSubject(db, JOB_KEY)?.value).toBe("succeeded");
    expect(listVigilEvents(db, JOB_KEY)).toHaveLength(2);
  });

  test("a transition write failure rolls back the entire sweep", () => {
    ingestLedgerEnvelope(db, job(), ENDED_AT);
    ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", state: { subject: "G1", value: "on-track" } }), ENDED_AT);
    db.run(`CREATE TRIGGER reject_stale BEFORE INSERT ON vigil_events
      WHEN NEW.subject_key = 'state:goal:default:G1' BEGIN SELECT RAISE(ABORT, 'event failure'); END`);
    expect(() => sweepStale(db, DEADLINE + 1, {})).toThrow("event failure");
    expect(getVigilSubject(db, JOB_KEY)?.value).toBe("succeeded");
    expect(getVigilSubject(db, GOAL_KEY)?.value).toBe("on-track");
    expect(listVigilEvents(db, JOB_KEY)).toEqual([]);
    expect(listVigilEvents(db, GOAL_KEY)).toEqual([]);
  });
});
