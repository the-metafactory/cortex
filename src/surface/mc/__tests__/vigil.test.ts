import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { handleListVigilSubjects, type VigilSubjectsResponse } from "../api/vigil";
import { writeVigilSubject, type VigilObservation } from "../../../vigil/db";
import { DEFAULT_CADENCE_MS } from "../../../vigil/staleness";
import type { GoalWordingResolver } from "../../../vigil/goal-wording";

const ENDED_AT = Date.parse("2026-10-12T10:00:05.000Z");

describe("handleListVigilSubjects", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  function seed(overrides: Partial<VigilObservation> = {}) {
    writeVigilSubject(db, {
      subject_key: "run:flow:daily-sweep", subject_kind: "run", vocab: null,
      ref: "daily-sweep", value: "failed", healthy: 0, goal_id: null,
      producer: "pulse", stack: "default", run_kind: "flow",
      last_run_id: "run-1", last_ended_at: ENDED_AT, last_seen_at: ENDED_AT,
      ...overrides,
    }, ENDED_AT);
  }

  async function list(resolver: GoalWordingResolver = () => "Example goal", cadence = {}) {
    const response = await handleListVigilSubjects(db, resolver, cadence);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return await response.json() as VigilSubjectsResponse;
  }

  it("lists every subject unhealthy first, then by key, with the complete public shape", async () => {
    seed({ subject_key: "state:goal:G1", subject_kind: "state", vocab: "goal", ref: "G1",
      value: "on-track", healthy: 1, goal_id: "G1", run_kind: null });
    seed({ subject_key: "state:escalation:example/project#604", subject_kind: "state", vocab: "escalation",
      ref: "example/project#604", value: "overdue", run_kind: null });
    seed();
    expect(await list()).toEqual({ subjects: [
      {
        subjectKey: "run:flow:daily-sweep", kind: "run", vocab: null, ref: "daily-sweep",
        goalId: null, goalWording: null, value: "failed", healthy: false,
        lastResultRef: null, lastRunId: "run-1", lastEndedAt: ENDED_AT, expectedBy: null,
      },
      {
        subjectKey: "state:escalation:example/project#604", kind: "state", vocab: "escalation", ref: "example/project#604",
        goalId: null, goalWording: null, value: "overdue", healthy: false,
        lastResultRef: null, lastRunId: "run-1", lastEndedAt: ENDED_AT, expectedBy: null,
      },
      {
        subjectKey: "state:goal:G1", kind: "state", vocab: "goal", ref: "G1",
        goalId: "G1", goalWording: "Example goal", value: "on-track", healthy: true,
        lastResultRef: null, lastRunId: "run-1", lastEndedAt: ENDED_AT, expectedBy: ENDED_AT + DEFAULT_CADENCE_MS,
      },
    ] });
  });

  it.each(["job", "node", "algorithm", "dispatch", "flow"])("uses effective cadence for run:%s only when eligible", async (kind) => {
    const key = `run:${kind}:harness-gate`;
    seed({ subject_key: key, run_kind: kind });
    const expectedBy = kind === "job" ? ENDED_AT + DEFAULT_CADENCE_MS : null;
    expect((await list()).subjects[0]?.expectedBy).toBe(expectedBy);
    const overridden = await list(undefined, { [key]: 3_600_000 });
    expect(overridden.subjects[0]?.expectedBy).toBe(kind === "job" ? ENDED_AT + 3_600_000 : null);
  });

  it.each(["goal", "escalation", "check", "unknown"] as const)("uses effective cadence for state:%s only when eligible", async (vocab) => {
    const key = `state:${vocab}:G1`;
    seed({ subject_key: key, subject_kind: "state", vocab, run_kind: null });
    expect((await list()).subjects[0]?.expectedBy).toBe(vocab === "goal" ? ENDED_AT + DEFAULT_CADENCE_MS : null);
    expect((await list(undefined, { [key]: 1_000 })).subjects[0]?.expectedBy).toBe(vocab === "goal" ? ENDED_AT + 1_000 : null);
  });

  it("resolves each goal once per request, fetches fresh wording, and never writes", async () => {
    seed({ goal_id: "G1" });
    seed({ subject_key: "state:goal:G1", subject_kind: "state", vocab: "goal", goal_id: "G1", run_kind: null });
    const before = db.query("SELECT total_changes() AS changes").get();
    const rowsBefore = db.query("SELECT * FROM vigil_subjects ORDER BY subject_key").all();
    let wording = "Example goal";
    const resolver = mock(async (_id: string) => wording);
    expect((await list(resolver)).subjects.map((s) => s.goalWording)).toEqual([wording, wording]);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith("G1");
    wording = "Revised goal";
    expect((await list(resolver)).subjects.map((s) => s.goalWording)).toEqual([wording, wording]);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(db.query("SELECT total_changes() AS changes").get()).toEqual(before);
    expect(db.query("SELECT * FROM vigil_subjects ORDER BY subject_key").all()).toEqual(rowsBefore);
  });

  it("keeps null and throwing resolvers available without logging private details", async () => {
    seed({ goal_id: "G1" });
    expect((await list(mock(async () => null))).subjects[0]?.goalWording).toBeNull();
    const warning = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (const resolver of [
        mock((): string => { throw new Error("private resolver details"); }),
        mock(async (): Promise<string> => { throw new Error("private resolver details"); }),
      ]) {
        expect((await list(resolver)).subjects[0]?.goalWording).toBeNull();
      }
      expect(warning).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private resolver details");
    } finally {
      warning.mockRestore();
    }
  });

  it("returns an empty list without calling the resolver", async () => {
    const resolver = mock(async () => "Example goal");
    expect(await list(resolver)).toEqual({ subjects: [] });
    expect(resolver).not.toHaveBeenCalled();
  });
});
