import { expect, test } from "bun:test";
import { initDatabase } from "../../surface/mc/db/init";
import { getVigilSubject, isOlderObservation, unverifiedVigilSubjects, writeVigilSubject } from "../db";
import { finishStackScopedReplay } from "../stack-scope";
import { ENDED_AT, KEY, ingestFromSourceStack, ledgerEnvelope } from "./fixtures";

test("subject writes record stack provenance without caller confirmation", () => {
  using db = initDatabase(":memory:");
  ingestFromSourceStack(db, ledgerEnvelope(), ENDED_AT);
  const row = getVigilSubject(db, KEY)!;
  db.run("DELETE FROM vigil_subject_stack_sources");
  writeVigilSubject(db, row, ENDED_AT + 1);
  writeVigilSubject(db, { ...row, subject_key: "run:flow:work:daily-sweep", stack: "work" }, ENDED_AT + 1);
  expect(unverifiedVigilSubjects(db)).toEqual([]);
  expect(getVigilSubject(db, KEY)?.updated_at).toBe(ENDED_AT + 1);
});

test("provenance failure rolls back the subject write even without an outer transaction", () => {
  using db = initDatabase(":memory:");
  ingestFromSourceStack(db, ledgerEnvelope(), ENDED_AT);
  const row = getVigilSubject(db, KEY)!;
  db.run("DELETE FROM vigil_subject_stack_sources");
  db.run("CREATE TRIGGER fail_provenance BEFORE INSERT ON vigil_subject_stack_sources BEGIN SELECT RAISE(ABORT, 'provenance failure'); END");
  expect(() => writeVigilSubject(db, { ...row, value: "succeeded", healthy: 1 }, ENDED_AT + 1)).toThrow("provenance failure");
  expect(getVigilSubject(db, KEY)).toEqual(row);
  expect(unverifiedVigilSubjects(db)).toHaveLength(1);
  db.run("DROP TRIGGER fail_provenance");
  writeVigilSubject(db, { ...row, value: "succeeded", healthy: 1 }, ENDED_AT + 1);
  expect(unverifiedVigilSubjects(db)).toEqual([]);
});

test("replay matching excludes verified rows and unrelated kinds, vocabularies and references", () => {
  using db = initDatabase(":memory:");
  const state = { subject: "G1", value: "off-track" };
  ingestFromSourceStack(db, ledgerEnvelope({ state }), ENDED_AT);
  db.run("DELETE FROM vigil_subject_stack_sources");
  ingestFromSourceStack(db, ledgerEnvelope({ state }, "work"), ENDED_AT);
  ingestFromSourceStack(db, ledgerEnvelope({ ran: { kind: "job", ref: "daily-sweep" }, state: { subject: "G1", value: "regressed" } }), ENDED_AT);
  ingestFromSourceStack(db, ledgerEnvelope({ ran: { kind: "flow", ref: "other" }, state: { subject: "G2", value: "off-track" } }), ENDED_AT);
  db.query("DELETE FROM vigil_subject_stack_sources WHERE subject_key NOT LIKE ?").run("%:work:%");
  const ran = { kind: "flow", ref: "daily-sweep" };
  expect(unverifiedVigilSubjects(db, { ran, state: { vocab: "goal", ref: "G1" } })
    .map((row) => row.subject_key).sort()).toEqual([KEY, "state:goal:default:G1"]);
  expect(unverifiedVigilSubjects(db, { ran }).map((row) => row.subject_key)).toEqual([KEY]);
});

test.each([
  [ENDED_AT - 1, "z", true],
  [ENDED_AT + 1, "a", false],
  [ENDED_AT, "a", true],
  [ENDED_AT, "m", false],
  [ENDED_AT, "z", false],
] as const)("replay completeness agrees with observation ordering (%d, %s)", (endedAt, id, incomplete) => {
  using db = initDatabase(":memory:");
  ingestFromSourceStack(db, ledgerEnvelope({ run_id: id, ended_at: new Date(endedAt).toISOString() }), ENDED_AT);
  const row = getVigilSubject(db, KEY)!;
  const expected = { last_run_id: "m", last_ended_at: ENDED_AT };
  expect(isOlderObservation(row, expected)).toBe(incomplete);
  for (const legacy of [false, true]) {
    if (legacy) {
      writeVigilSubject(db, { ...row, ...expected, subject_key: "run:flow:daily-sweep" }, ENDED_AT);
      db.query("DELETE FROM vigil_subject_stack_sources WHERE subject_key = ?").run("run:flow:daily-sweep");
    }
    db.query(`INSERT INTO vigil_subject_stack_moves (old_key, new_key, expected_run_id, expected_ended_at)
      VALUES (?, ?, ?, ?)`).run("run:flow:daily-sweep", KEY, expected.last_run_id, expected.last_ended_at);
    const finish = () => finishStackScopedReplay(db, 0);
    if (incomplete) expect(finish).toThrow("complete LEDGER history");
    else expect(finish()).toEqual([]);
    db.run("DELETE FROM vigil_subject_stack_moves");
  }
});
