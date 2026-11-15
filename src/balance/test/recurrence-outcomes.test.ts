import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, applyRecurrence, completeCalendarOccurrence, findNode, newRecurrence, nextOccurrence, recurrenceFinished, recurrenceProjection, scheduledAfter, validateRecurrence, type AppState, type OutlineNode, type Recurrence } from "..";
import { required } from "../core/required";
import { initDatabase } from "../../surface/mc/db/init";
import { loadBalanceState, saveBalanceState } from "../../surface/mc/desk/balance-store";
import { BalanceStateSchema } from "../../surface/mc/desk/balance-store-schema";
import { syncBalance, loadMeta } from "../../surface/mc/desk/balance-sync";
import type { DeskOptions } from "../../surface/mc/desk/compose";
import { changeMyDay, localDay } from "../../surface/mc/desk/my-day";

const desk: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", sources: [], areas: [{ id: "work", label: "Work", color: "", repos: [], goals: [] }] };
const at = (iso: string) => new Date(`${iso}T10:00:00`).getTime();
const leaf = (id: string, repeat?: Recurrence, extra: Partial<OutlineNode> = {}): OutlineNode => ({ id, title: id, weight: 50, ordering: "parallel", children: [], effort: 1, ...(repeat ? { repeat } : {}), ...extra });
const stateWith = (...leaves: OutlineNode[]): AppState => ({
  outline: { id: "desk:outline", title: "Outline", weight: 100, ordering: "parallel", children: [{ id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: leaves }] },
  log: [], settings: { ...DEFAULT_SETTINGS }, dayState: null, history: { deficits: {}, lastSurfaced: {} },
});
const mondayThursday: Recurrence = { unit: "week", interval: 2, weekdays: [1, 4], mode: "calendar", anchor: "2026-11-02" };

function complete(db: Database, id: string, day: string): void {
  const meta = loadMeta(db);
  changeMyDay({ db, desk, now: at(day), date: localDay(at(day)), requestId: crypto.randomUUID(), command: { op: "outline-complete", id, revision: meta.revision, confirm: true } });
}
function reload(db: Database, id: string): OutlineNode {
  const stored = loadBalanceState(db);
  const node = stored && findNode(stored.outline, id);
  if (!node) throw new Error(`Missing ${id}`);
  return node;
}
function seeded(...leaves: OutlineNode[]): Database {
  const db = initDatabase(":memory:");
  saveBalanceState(db, stateWith(...leaves));
  syncBalance(db, desk, at("2026-11-02"));
  return db;
}

describe("calendar schedule", () => {
  test("every two weeks on Monday and Thursday: both days in active weeks, none in inactive", () => {
    const dates: string[] = [];
    let cursor = "2026-11-01";
    for (let i = 0; i < 6; i++) { cursor = scheduledAfter(mondayThursday, cursor); dates.push(cursor); }
    expect(dates).toEqual(["2026-11-02", "2026-11-05", "2026-11-16", "2026-11-19", "2026-11-30", "2026-12-03"]);
  });
  test("a daily interval counts from the anchor", () => {
    const daily: Recurrence = { unit: "day", interval: 3, mode: "calendar", anchor: "2026-11-01" };
    expect(scheduledAfter(daily, "2026-11-01")).toBe("2026-11-04");
    expect(scheduledAfter(daily, "2026-11-05")).toBe("2026-11-07");
  });
  test("monthly clamping is anchored on the original day", () => {
    const monthly: Recurrence = { unit: "month", interval: 1, mode: "calendar", anchor: "2026-01-31" };
    expect(scheduledAfter(monthly, "2026-01-31")).toBe("2026-02-28");
    expect(scheduledAfter(monthly, "2026-02-28")).toBe("2026-03-31");
  });
});

describe("late completion of a calendar occurrence", () => {
  test("records missed dates, keeps the phase and advances beyond the completion day", () => {
    const db = seeded(leaf("t", mondayThursday));
    complete(db, "t", "2026-11-17");
    const task = reload(db, "t");
    expect(task.repeat?.occurrence).toBe("2026-11-19");
    expect(task.repeat?.anchor).toBe("2026-11-02");
    expect(loadBalanceState(db)?.outcomes).toEqual([
      { taskId: "t", planned: "2026-11-02", status: "completed", completedOn: "2026-11-17", recordedOn: "2026-11-17" },
      { taskId: "t", planned: "2026-11-05", status: "missed", recordedOn: "2026-11-17" },
      { taskId: "t", planned: "2026-11-16", status: "missed", recordedOn: "2026-11-17" },
    ]);
    expect(recurrenceProjection(task)?.returnsOn).toBe("2026-11-19");
    db.close();
  });
  test("a completion on a scheduled day moves strictly beyond that day", () => {
    const db = seeded(leaf("t", mondayThursday));
    complete(db, "t", "2026-11-05");
    expect(reload(db, "t").repeat?.occurrence).toBe("2026-11-16");
    db.close();
  });
  test("refreshing reopens the task on the planned date without new outcomes or credit", () => {
    const db = seeded(leaf("t", mondayThursday));
    complete(db, "t", "2026-11-17");
    const before = loadBalanceState(db);
    for (const day of ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-19"]) syncBalance(db, desk, at(day));
    const after = loadBalanceState(db);
    expect(after?.outcomes).toEqual(before?.outcomes);
    expect(after?.log).toEqual(before?.log);
    expect(reload(db, "t").dueDate).toBe("2026-11-19");
    expect(reload(db, "t").done).toBe(false);
    db.close();
  });
  test("planned and actual dates are recoverable after reopening the store", () => {
    const dir = mkdtempSync(join(tmpdir(), "recurrence-outcomes-"));
    const file = join(dir, "desk.sqlite");
    const first = initDatabase(file);
    saveBalanceState(first, stateWith(leaf("t", mondayThursday)));
    syncBalance(first, desk, at("2026-11-02"));
    complete(first, "t", "2026-11-17");
    first.close();
    const second = initDatabase(file);
    expect(loadBalanceState(second)?.outcomes?.[0]).toMatchObject({ planned: "2026-11-02", completedOn: "2026-11-17" });
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
  test("reopening a completion restores the planned occurrence and drops its outcomes", () => {
    const db = seeded(leaf("t", mondayThursday));
    complete(db, "t", "2026-11-17");
    changeMyDay({ db, desk, now: at("2026-11-17"), date: "2026-11-17", requestId: crypto.randomUUID(), command: { op: "outline-reopen", id: "t", revision: loadMeta(db).revision, confirm: true } });
    expect(reload(db, "t").repeat?.occurrence).toBe("2026-11-02");
    expect(loadBalanceState(db)?.outcomes).toEqual([]);
    db.close();
  });
  test("an early completion never records a miss", () => {
    const state = stateWith();
    const repeat = { ...mondayThursday };
    completeCalendarOccurrence(state, "t", repeat, "2026-11-01");
    expect(repeat.occurrence).toBe("2026-11-05");
    expect(state.outcomes?.map(o => o.status)).toEqual(["completed"]);
  });
});

describe("compatibility", () => {
  const plain: Recurrence = { unit: "day", interval: 1 };
  test("a stored repeat without a mode keeps completion counting through load and save", () => {
    const db = seeded(leaf("t", plain));
    complete(db, "t", "2026-11-10");
    syncBalance(db, desk, at("2026-11-10"));
    const task = reload(db, "t");
    expect(task.repeat).toEqual({ ...plain, timesDone: 1 });
    expect(recurrenceProjection(task)?.returnsOn).toBe("2026-11-11");
    expect(loadBalanceState(db)?.outcomes).toBeUndefined();
    db.close();
  });
  test("a completion-based daily interval counts from the completion date", () => {
    const spaced: Recurrence = { unit: "day", interval: 3, mode: "completion" };
    const db = seeded(leaf("t", spaced));
    complete(db, "t", "2026-11-10");
    expect(recurrenceProjection(reload(db, "t"))?.returnsOn).toBe(nextOccurrence("2026-11-10", spaced));
    expect(recurrenceProjection(reload(db, "t"))?.returnsOn).toBe("2026-11-13");
    db.close();
  });
  test("a new repeat defaults to planned-date counting with an explicit anchor", () => {
    expect(newRecurrence({ unit: "week", interval: 1 }, "2026-11-02")).toEqual({ unit: "week", interval: 1, mode: "calendar", anchor: "2026-11-02" });
  });
});

describe("stopping limits", () => {
  test("only actual completion increments the count, missed dates do not", () => {
    const counted: Recurrence = { ...mondayThursday, count: 2 };
    const db = seeded(leaf("t", counted));
    complete(db, "t", "2026-11-17");
    const task = reload(db, "t");
    expect(task.repeat?.timesDone).toBe(1);
    expect(recurrenceFinished(required(task.repeat), task.repeat?.occurrence ?? "")).toBe(false);
    db.close();
  });
  test("the count finishes the repeat after the last completion", () => {
    const db = seeded(leaf("t", { ...mondayThursday, count: 1 }));
    complete(db, "t", "2026-11-02");
    expect(recurrenceProjection(reload(db, "t"))).toEqual({ returnsOn: null, finished: true, reappearsOn: null });
    db.close();
  });
  test("until stops the repeat independently of the count", () => {
    const db = seeded(leaf("t", { ...mondayThursday, until: "2026-11-10" }));
    complete(db, "t", "2026-11-05");
    expect(recurrenceProjection(reload(db, "t"))?.finished).toBe(true);
    db.close();
  });
  test("a late completion records no missed outcome after the until date", () => {
    const state = stateWith();
    const repeat: Recurrence = { ...mondayThursday, until: "2026-11-10", occurrence: "2026-11-05" };
    completeCalendarOccurrence(state, "t", repeat, "2026-11-17");
    expect(state.outcomes?.map(o => o.planned)).toEqual(["2026-11-05"]);
  });
  test("applyRecurrence does not reopen a finished calendar task", () => {
    const task = leaf("t", { ...mondayThursday, count: 1, timesDone: 1, occurrence: "2026-11-05" }, { done: true, completedAt: "2026-11-02" });
    expect(applyRecurrence(task, "2026-12-01").respawned).toEqual([]);
  });
});

describe("validation", () => {
  test("rejects invalid modes, intervals and weekdays before a state write", () => {
    const db = initDatabase(":memory:");
    for (const bad of [{ ...mondayThursday, mode: "sometimes" }, { ...mondayThursday, interval: 0 }, { ...mondayThursday, interval: 1.5 }, { ...mondayThursday, weekdays: [7] }, { ...mondayThursday, anchor: undefined }]) {
      expect(() => saveBalanceState(db, stateWith(leaf("t", bad as Recurrence)))).toThrow();
      expect(loadBalanceState(db)).toBeNull();
      expect(() => validateRecurrence(bad as Recurrence)).toThrow();
    }
    expect(BalanceStateSchema.safeParse(stateWith(leaf("t", mondayThursday))).success).toBe(true);
    db.close();
  });
});
