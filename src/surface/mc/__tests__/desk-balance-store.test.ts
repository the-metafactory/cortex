import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDayToHistory, DEFAULT_SETTINGS, selectToday, type AppState } from "../../../balance";
import { initDatabase } from "../db/init";
import { loadBalanceState, saveBalanceState } from "../desk/balance-store";

function fixture(): AppState {
  return {
    outline: {
      id: "root", title: "Life", weight: 100, ordering: "parallel", children: [{
        id: "health", title: "Health", weight: 60, ordering: "parallel", children: [{
          id: "walk", title: "Walk '); DROP TABLE tasks; --", weight: 100,
          ordering: "parallel", children: [], effort: 2, context: "Home",
          note: "Fresh air", repeat: { unit: "day", interval: 1 },
        }],
      }, {
        id: "work", title: "Work", weight: 40, ordering: "sequential", children: [{
          id: "write", title: "Write", weight: 100, ordering: "parallel", children: [],
          focusMonth: "2026-10", external: { source: "tana", syncedAt: "2026-10-30T12:00:00Z" },
        }],
      }],
    },
    log: [{ taskId: "deleted", areaId: "work", effort: 4, date: "2026-10-30", title: "Shipped" }],
    settings: { ...DEFAULT_SETTINGS },
    dayState: null,
    history: { deficits: { health: 0.3 }, lastSurfaced: { write: "2026-10-29" } },
    contexts: [{ name: "Home", windows: [{ days: [6], from: "08:00", to: "22:00" }] }],
  };
}

describe("Mission Control balance storage", () => {
  test("prototype-named IDs and history keys survive a validated round-trip", () => {
    const db = initDatabase(":memory:");
    try {
      const state = fixture();
      const area = state.outline.children[0];
      if (!area) throw new Error("Missing area fixture");
      area.id = "__proto__";
      state.history = {
        deficits: Object.fromEntries([["__proto__", 0.3], ["constructor", -0.2]]),
        lastSurfaced: Object.fromEntries([["__proto__", "2026-10-30"], ["constructor", "2026-10-29"]]),
      };
      saveBalanceState(db, state);
      expect(loadBalanceState(db)).toEqual(state);
    } finally {
      db.close();
    }
  });

  test("full state survives close/reopen and yields the identical schedule without mutation", () => {
    const directory = mkdtempSync(join(tmpdir(), "balance-store-"));
    const path = join(directory, "mc.sqlite");
    const state = fixture();
    const before = structuredClone(state);
    const list = selectToday(state, "2026-10-31", { timeNow: "09:00" });
    expect(selectToday(structuredClone(state), "2026-10-31", { timeNow: "09:00" })).toEqual(list);
    expect(state).toEqual(before);
    const confirmed = list.map(item => item.task.id);
    state.history = applyDayToHistory(state, "2026-10-31", confirmed);
    state.dayState = { date: "2026-10-31", confirmed, closed: false };
    let db = initDatabase(path);
    try {
      expect(loadBalanceState(db)).toBeNull();
      saveBalanceState(db, state);
      db.close();
      db = initDatabase(path);
      const restored = loadBalanceState(db);
      expect(restored).toEqual(state);
      if (!restored) throw new Error("Missing saved balance state");
      expect(selectToday(restored, "2026-10-31", { timeNow: "09:00" }))
        .toEqual(selectToday(state, "2026-10-31", { timeNow: "09:00" }));
      restored.dayState = { date: "2026-10-31", confirmed, closed: true };
      restored.log.push({ taskId: "walk", areaId: "health", effort: 2, date: "2026-10-31", title: "Walk" });
      saveBalanceState(db, restored);
      expect(loadBalanceState(db)).toEqual(restored);
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'tasks'").get()).toBeTruthy();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("invalid replacement leaves all previously saved components intact", () => {
    const db = initDatabase(":memory:");
    try {
      const original = fixture();
      saveBalanceState(db, original);
      const invalid = fixture();
      invalid.log = [];
      invalid.settings.halfLifeDays = 0;
      expect(() => saveBalanceState(db, invalid)).toThrow();
      expect(loadBalanceState(db)).toEqual(original);
      const sameId = fixture();
      sameId.outline.children.push({ ...sameId.outline, children: [] });
      expect(() => saveBalanceState(db, sameId)).toThrow("Duplicate balance node id");
      expect(loadBalanceState(db)).toEqual(original);
    } finally {
      db.close();
    }
  });

  test("database failure rolls back the whole snapshot and corrupt persisted data is refused", () => {
    const db = initDatabase(":memory:");
    try {
      const original = fixture();
      saveBalanceState(db, original);
      db.run("CREATE TRIGGER refuse_balance BEFORE UPDATE ON desk_balance BEGIN SELECT RAISE(ABORT, 'probe failure'); END");
      const replacement = fixture();
      replacement.log = [];
      replacement.dayState = { date: "2026-10-31", confirmed: [], closed: true };
      expect(() => saveBalanceState(db, replacement)).toThrow("probe failure");
      expect(loadBalanceState(db)).toEqual(original);
      db.run("DROP TRIGGER refuse_balance");
      db.query("UPDATE desk_balance SET data = ? WHERE id = 1").run('{"outline":null}');
      expect(() => loadBalanceState(db)).toThrow();
    } finally {
      db.close();
    }
  });
});
