import { expect, test } from "bun:test";
import { allocateSlots, applyDayToHistory, DEFAULT_SETTINGS, selectToday, type AppState } from "../index";

function fixture(id: string): AppState {
  return {
    outline: {
      id: "root", title: "Root", ordering: "parallel", weight: 100, children: [{
        id, title: "Area", ordering: "parallel", weight: 100, children: [{
          id: "constructor", title: "Task", ordering: "parallel", weight: 100, children: [],
        }],
      }],
    },
    log: [], settings: { ...DEFAULT_SETTINGS }, dayState: null,
    history: { deficits: {}, lastSurfaced: {}, startDate: "2026-10-01" },
  };
}

test("prototype names never supply inherited deficit or surfacing history", () => {
  for (const id of ["constructor", "toString", "__proto__"]) {
    expect([...allocateSlots(new Map([[id, 1], ["ordinary", 1]]), 2).values()]).toEqual([1, 1]);
    const state = fixture(id === "constructor" ? "area" : id);
    const items = selectToday(state, "2026-10-31");
    expect(items).toHaveLength(1);
    expect(Number.isFinite(items[0]?.score)).toBe(true);
    const next = applyDayToHistory(state, "2026-10-31", ["constructor"]);
    expect(Object.hasOwn(next.deficits, id === "constructor" ? "area" : id)).toBe(true);
    expect(Object.entries(next.lastSurfaced).find(([key]) => key === "constructor")?.[1]).toBe("2026-10-31");
  }
});

test("prototype-named task history remains an own string value after confirmation", () => {
  const state = fixture("area");
  const task = state.outline.children[0]?.children[0];
  if (!task) throw new Error("Missing fixture task");
  task.id = "__proto__";
  state.history = applyDayToHistory(state, "2026-10-31", [task.id]);
  expect(Object.hasOwn(state.history.lastSurfaced, task.id)).toBe(true);
  expect(state.history.lastSurfaced[task.id]).toBe("2026-10-31");
  expect(Object.getPrototypeOf(state.history.lastSurfaced)).toBe(Object.prototype);
  expect(Number.isFinite(selectToday(state, "2026-11-01")[0]?.score)).toBe(true);
});
