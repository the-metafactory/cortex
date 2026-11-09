import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SETTINGS, findNode, rankAll, shiftDays, type AppState } from "../../../balance";
import { loadBalanceState, saveBalanceState } from "../desk/balance-store";
import { loadMeta, readMyDay } from "../desk/my-day";
import { MyDayMetaSchema, type MyDayCommand } from "../desk/my-day-schema";
import { joinToday, placeInDay } from "../desk/my-day-today";
import { DeskTimeFirst } from "../dashboard-v2/components/desk-time-first";
import { TodayControl } from "../dashboard-v2/components/desk-today-control";
import { DATE, NOW, dayDatabase, desk } from "./desk-day-fixture";

const leaf = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, weight: 50, ordering: "parallel" as const, children: [], effort: 1 as const, ...extra });
function seed(due: string[] = []): AppState {
  return { outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [{ id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: [
    leaf("first", "Write the outline", due.includes("first") ? { dueDate: DATE } : {}),
    leaf("second", "Review the draft", due.includes("second") ? { dueDate: DATE } : {}),
    leaf("third", "Plan next week"),
  ] }] }, settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null };
}

describe("placeInDay orders a new task by engine rank", () => {
  const rank = ["due", "a", "b", "c"];
  it("inserts before the first open task it outranks and keeps the others' order", () => {
    expect(placeInDay({ ids: ["b", "a"], rank, id: "due", cap: 5, locked: new Set() })).toEqual({ kind: "joined", ids: ["due", "b", "a"] });
    expect(placeInDay({ ids: ["done", "c"], rank, id: "b", cap: 5, locked: new Set() })).toEqual({ kind: "joined", ids: ["done", "b", "c"] });
  });
  it("appends a task that outranks nothing", () => {
    expect(placeInDay({ ids: ["a", "b"], rank, id: "c", cap: 5, locked: new Set() })).toEqual({ kind: "joined", ids: ["a", "b", "c"] });
  });
  it("replaces the lowest-ranked unlocked open task in a full day, in its place", () => {
    expect(placeInDay({ ids: ["c", "a"], rank, id: "due", cap: 2, locked: new Set() })).toEqual({ kind: "replaced", ids: ["due", "a"], displaced: "c" });
    expect(placeInDay({ ids: ["c", "a"], rank, id: "due", cap: 2, locked: new Set(["c"]) })).toEqual({ kind: "replaced", ids: ["c", "due"], displaced: "a" });
  });
  it("leaves a full day alone when nothing open ranks below the new task, and never displaces a done task", () => {
    expect(placeInDay({ ids: ["due", "a"], rank, id: "b", cap: 2, locked: new Set() })).toEqual({ kind: "full" });
    expect(placeInDay({ ids: ["done", "a"], rank, id: "due", cap: 2, locked: new Set(["a"]) })).toEqual({ kind: "full" });
  });
});

describe("a task added in Balance joins Today's priorities", () => {
  const { db: database, change } = dayDatabase(() => seed());
  const revision = (): number => readMyDay(database(), desk, NOW).revision;
  const confirmed = (): string[] => readMyDay(database(), desk, NOW).work.confirmedIds;
  const addDue = (title = "Call the venue", parent = "area:work") => change({ op: "outline-add", revision: revision(), parent, title, dueDate: DATE });
  const inOutline = (id: string | undefined): boolean => Boolean(id && findNode(loadBalanceState(database())?.outline ?? seed().outline, id));

  it("re-runs the engine proposal when the only person draft belongs to a previous day", () => {
    database().query("INSERT INTO desk_my_day (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify({ draft: { date: shiftDays(DATE, -1), ids: ["first"], origin: "person" } }));
    const result = change({ op: "add", parent: "area:work", title: "Fresh today", kind: "task" });
    expect(loadMeta(database()).draft).toBeNull();
    expect(result.view.items.map(item => item.task.id)).toContain(findNode(result.view.outline, "area:work")?.children.find(node => node.title === "Fresh today")?.id ?? "missing");
  });

  it("re-runs the engine proposal on a day that has not started", () => {
    readMyDay(database(), desk, NOW);
    const result = addDue();
    expect(result.view.phase).toBe("proposed");
    expect(result.view.items[0]?.task.id).toBe(result.outlineId ?? "");
    expect(result.notice).toBe("Added Call the venue to today's proposal.");
    expect(result.undo).toBeUndefined();
  });

  it("joins a started day below its cap before the first task it outranks, and Undo keeps it in Balance", () => {
    change({ op: "start", ids: ["second", "first"] });
    const result = addDue();
    expect(result.view.work.confirmedIds).toEqual([result.outlineId ?? "", "second", "first"]);
    expect(result.notice).toBe("Added Call the venue to today's priorities.");
    expect(result.undo).toBeDefined();
    expect(result.view.dayUndo?.text).toBe("Added Call the venue to today's priorities.");
    const undone = change({ op: "undo", receipt: result.undo ?? "" });
    expect(undone.view.work.confirmedIds).toEqual(["second", "first"]);
    expect(undone.notice).toBe("Today's priorities are restored.");
    expect(undone.view.dayUndo).toBeNull();
    expect(inOutline(result.outlineId)).toBe(true);
  });

  it("replaces the lowest-ranked open task in a full day and one Undo restores the exact list", () => {
    change({ op: "cap", cap: 2 });
    change({ op: "start", ids: ["first", "second"] });
    const result = addDue();
    expect(result.view.work.confirmedIds).toEqual(["first", result.outlineId ?? ""]);
    expect(result.notice).toBe("Added Call the venue; Review the draft moved out of today.");
    expect(result.view.alternates.map(item => item.task.id)).toContain("second");
    change({ op: "undo", receipt: result.undo ?? "" });
    expect(confirmed()).toEqual(["first", "second"]);
  });

  it("never displaces the task the principal selected", () => {
    change({ op: "cap", cap: 2 });
    change({ op: "start", ids: ["first", "second"] });
    change({ op: "select", id: "second", revision: revision() });
    const result = addDue();
    expect(result.view.work.confirmedIds).toEqual([result.outlineId ?? "", "second"]);
    expect(result.notice).toBe("Added Call the venue; Write the outline moved out of today.");
  });

  it("never displaces a task the principal added to today", () => {
    change({ op: "cap", cap: 2 });
    change({ op: "start", ids: ["first"] });
    change({ op: "today-add", id: "second", replace: null, revision: revision() });
    expect(confirmed()).toEqual(["first", "second"]);
    const result = addDue();
    expect(result.view.work.confirmedIds).toEqual(["first", "second"]);
    expect(result.notice).toContain("Today's priorities are full (2 of 2)");
    expect(result.undo).toBeUndefined();
  });

  it("saves to Balance only when a full day has no open task ranked below the new task", () => {
    saveBalanceState(database(), seed(["first", "second"]));
    change({ op: "cap", cap: 2 });
    change({ op: "start", ids: ["first", "second"] });
    const result = change({ op: "outline-add", revision: revision(), parent: "area:work", title: "Someday" });
    expect(result.view.work.confirmedIds).toEqual(["first", "second"]);
    expect(result.notice).toBe("Saved to Balance. Today's priorities are full (2 of 2) and no open task ranks below this one. Use Add to today to choose a task to swap out.");
    expect(inOutline(result.outlineId)).toBe(true);
  });

  it("leaves a closed day unchanged and says so", () => {
    change({ op: "start", ids: ["first"] });
    change({ op: "close" });
    const result = addDue();
    expect(result.view.work.confirmedIds).toEqual(["first"]);
    expect(result.notice).toBe("Saved to Balance. Today is closed, so today's priorities are unchanged.");
  });

  it("never auto-adds a project or a task in a paused area", () => {
    change({ op: "start", ids: ["first"] });
    const project = change({ op: "outline-add", revision: revision(), parent: "area:work", title: "Venue", kind: "project" });
    expect(project.view.work.confirmedIds).toEqual(["first"]);
    expect(project.notice).toBeUndefined();
    const state = loadBalanceState(database());
    const area = state?.outline.children.find(child => child.id === "area:work");
    if (!state || !area) throw new Error("Missing area");
    area.weight = 0;
    saveBalanceState(database(), state);
    const paused = addDue("Book the hall");
    expect(paused.view.work.confirmedIds).toEqual(["first"]);
    expect(paused.notice).toBe("Saved to Balance. It is not actionable today, so today's priorities are unchanged.");
  });

  it("never auto-adds a Studio-owned or done task", () => {
    const state = seed();
    const area = state.outline.children[0];
    if (!area) throw new Error("Missing area");
    area.children.push(leaf("studio-response:x", "Respond in Studio"), leaf("finished", "Finished", { done: true }));
    state.dayState = { date: DATE, confirmed: ["first"], closed: false };
    const meta = MyDayMetaSchema.parse({});
    const ranked = rankAll(state, DATE);
    const template = ranked[0];
    const finished = findNode(state.outline, "finished");
    if (!template || !finished) throw new Error("Missing rank fixture");
    const rank = [...ranked, { ...template, task: finished }];
    for (const id of ["studio-response:x", "finished"]) {
      expect(rank.some(item => item.task.id === id)).toBe(true);
      expect(joinToday({ state, meta, date: DATE, rank, requestId: crypto.randomUUID() }, ["first"], id, 5).notice).toContain("not actionable today");
    }
    expect(state.dayState.confirmed).toEqual(["first"]);
    expect(joinToday({ state, meta, date: DATE, rank, requestId: crypto.randomUUID() }, ["first"], "third", 5).notice).toBe("Added Plan next week to today's priorities.");
  });

  it("rejects a stale revision without adding the task to Balance or today", () => {
    change({ op: "start", ids: ["first"] });
    const stale = revision();
    change({ op: "select", id: "first", revision: stale });
    expect(() => change({ op: "outline-add", revision: stale, parent: "area:work", title: "Late", dueDate: DATE })).toThrow("The outline changed in another window");
    expect(confirmed()).toEqual(["first"]);
    expect(JSON.stringify(loadBalanceState(database())?.outline)).not.toContain("Late");
  });

  it("replays a retried add without placing the task twice", () => {
    change({ op: "start", ids: ["first"] });
    const command: MyDayCommand = { op: "outline-add", revision: revision(), parent: "area:work", title: "Once", dueDate: DATE };
    const requestId = crypto.randomUUID();
    const first = change(command, requestId);
    const again = change(command, requestId);
    expect(again.view.work.confirmedIds).toEqual(first.view.work.confirmedIds);
    expect(again.undo).toBe(first.undo ?? "");
    expect(first.view.work.confirmedIds.filter(id => id === first.outlineId)).toHaveLength(1);
  });

  it("refuses Undo after the list changed again and keeps the newer order", () => {
    change({ op: "start", ids: ["second", "first"] });
    const result = addDue();
    change({ op: "reorder", revision: revision(), ids: ["first", "second", result.outlineId ?? ""] });
    expect(() => change({ op: "undo", receipt: result.undo ?? "" })).toThrow("Today's priorities changed since this change");
    expect(confirmed()).toEqual(["first", "second", result.outlineId ?? ""]);
  });

  it("adds and removes a task from the inspector, honouring the cap", () => {
    change({ op: "cap", cap: 2 });
    change({ op: "start", ids: ["first"] });
    const added = change({ op: "today-add", id: "third", replace: null, revision: revision() });
    expect(added.view.work.confirmedIds).toEqual(["first", "third"]);
    expect(() => change({ op: "today-add", id: "second", replace: null, revision: revision() })).toThrow("Today is full (2 of 2)");
    const swapped = change({ op: "today-add", id: "second", replace: "third", revision: revision() });
    expect(swapped.view.work.confirmedIds).toEqual(["first", "second"]);
    expect(swapped.notice).toBe("Added Review the draft; Plan next week moved out of today.");
    const removed = change({ op: "today-remove", id: "second", revision: revision() });
    expect(removed.view.work.confirmedIds).toEqual(["first"]);
    expect(removed.notice).toBe("Review the draft moved out of today. It stays in Balance.");
    expect(inOutline("second")).toBe(true);
    change({ op: "undo", receipt: removed.undo ?? "" });
    expect(confirmed()).toEqual(["first", "second"]);
    change({ op: "done", id: "first" });
    expect(() => change({ op: "today-remove", id: "first", revision: revision() })).toThrow("A completed task stays in today's wins.");
    expect(() => change({ op: "today-add", id: "third", replace: null, revision: revision() - 1 })).toThrow("Your day changed");
  });

  it("shows Add to today, the swap chooser and Remove from today in the inspector", () => {
    change({ op: "cap", cap: 1 });
    change({ op: "start", ids: ["first"] });
    const day = readMyDay(database(), desk, NOW);
    const node = (id: string) => { const found = findNode(day.outline, id); if (!found) throw new Error("Missing node"); return found; };
    const render = (id: string) => renderToStaticMarkup(createElement(TodayControl, { node: node(id), day, busy: false, change: async () => null }));
    expect(render("first")).toContain("Remove from today");
    expect(render("third")).toContain("Add to today");
    expect(render("third")).toContain('aria-expanded="false"');
  });

  it("offers Undo for the latest today change on the Day page", () => {
    change({ op: "start", ids: ["second"] });
    addDue();
    const html = renderToStaticMarkup(createElement(DeskTimeFirst, { day: readMyDay(database(), desk, NOW), now: NOW, before: null, after: null, proposal: null, preview: null, ambient: null, areas: desk.areas, onChanged: () => {}, onThread: () => {} }));
    expect(html).toContain("Added Call the venue to today&#x27;s priorities.");
    expect(html).toContain(">Undo</button>");
    expect(html).toContain("Call the venue");
  });
});
