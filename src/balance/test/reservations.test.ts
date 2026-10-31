import { expect, test } from "bun:test";
import { DEFAULT_SETTINGS, nextOccurrence, selectToday, type AppState } from "../index";

function fixture(): AppState {
  return {
    outline: {
      id: "root", title: "Life", weight: 100, ordering: "parallel", children: [{
        id: "urgent", title: "Urgent", weight: 99, ordering: "parallel",
        children: Array.from({ length: 5 }, (_, index) => ({
          id: `overdue-${index}`, title: "Overdue", weight: 100,
          ordering: "parallel", children: [], dueDate: "2026-10-30",
        })),
      }, {
        id: "quiet", title: "Quiet", weight: 1, ordering: "parallel", children: [{
          id: "non-due", title: "Make space", weight: 100, ordering: "parallel", children: [],
        }],
      }],
    },
    log: [], settings: { ...DEFAULT_SETTINGS }, dayState: null,
    history: { deficits: {}, lastSurfaced: {} },
  };
}

test("the balanced slot follows area weights and may itself select due work", () => {
  const items = selectToday(fixture(), "2026-10-31");
  expect(items).toHaveLength(5);
  expect(items.filter(item => item.reason === "due")).toHaveLength(5);
  expect(items.some(item => item.task.id === "non-due")).toBe(false);
});

test("all-due pools still fill the cap and a single-slot cap still puts due work first", () => {
  const state = fixture();
  state.outline.children = state.outline.children.filter(area => area.id === "urgent");
  expect(selectToday(state, "2026-10-31")).toHaveLength(5);
  const single = fixture();
  single.settings.todayCap = 1;
  expect(selectToday(single, "2026-10-31").map(item => item.reason)).toEqual(["due"]);
});

test("weekday calendar pins intentionally override the recurrence interval", () => {
  expect(nextOccurrence("2026-07-10", { unit: "week", interval: 2, weekdays: [5] })).toBe("2026-07-17");
});
