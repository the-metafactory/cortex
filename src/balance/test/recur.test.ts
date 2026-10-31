import { required } from "../core/required";
import { describe, expect, test } from "bun:test";
import { addMonths, applyRecurrence, nextOccurrence, recurrenceFinished, } from "../core/recur";
import { availableTasks } from "../core/scheduler";
import type { OutlineNode, Recurrence } from "../core/types";
const TODAY = "2026-07-10";
function leaf(id: string, extra: Partial<OutlineNode> = {}): OutlineNode {
    return { id, title: id, weight: 50, ordering: "parallel", children: [], effort: 1, ...extra };
}
function tree(...leaves: OutlineNode[]): OutlineNode {
    return {
        id: "root",
        title: "Life",
        weight: 100,
        ordering: "parallel",
        children: [
            { id: "area-a", title: "A", weight: 50, ordering: "parallel", children: leaves },
        ],
    };
}
describe("nextOccurrence", () => {
    test("day interval", () => {
        expect(nextOccurrence("2026-07-10", { unit: "day", interval: 1 })).toBe("2026-07-11");
        expect(nextOccurrence("2026-07-10", { unit: "day", interval: 3 })).toBe("2026-07-13");
    });
    test("weekly on specific weekdays anchors on the calendar", () => {
        expect(nextOccurrence("2026-07-10", { unit: "week", interval: 1, weekdays: [5] })).toBe("2026-07-17");
        expect(nextOccurrence("2026-07-10", { unit: "week", interval: 1, weekdays: [1, 5] })).toBe("2026-07-13");
    });
    test("plain weekly and monthly with clamping", () => {
        expect(nextOccurrence("2026-07-10", { unit: "week", interval: 2 })).toBe("2026-07-24");
        expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
        expect(nextOccurrence("2026-08-31", { unit: "month", interval: 1 })).toBe("2026-09-30");
    });
});
describe("recurrenceFinished", () => {
    test("count and until stop respawning", () => {
        expect(recurrenceFinished({ unit: "day", interval: 1, count: 5, timesDone: 5 }, "2026-07-11")).toBe(true);
        expect(recurrenceFinished({ unit: "day", interval: 1, count: 5, timesDone: 4 }, "2026-07-11")).toBe(false);
        expect(recurrenceFinished({ unit: "day", interval: 1, until: "2026-07-10" }, "2026-07-11")).toBe(true);
        expect(recurrenceFinished({ unit: "day", interval: 1 }, "2099-01-01")).toBe(false);
    });
});
describe("applyRecurrence", () => {
    const daily: Recurrence = { unit: "day", interval: 1 };
    test("respawns a due task with dueDate = occurrence (urgency boost that day)", () => {
        const t = leaf("r1", { repeat: daily, done: true, completedAt: "2026-07-09" });
        const outline = tree(t);
        const result = applyRecurrence(outline, TODAY);
        expect(result.respawned).toEqual(["r1"]);
        expect(t.done).toBe(false);
        expect(t.dueDate).toBe("2026-07-10");
        expect(availableTasks(outline, TODAY).map((c) => c.task.id)).toEqual(["r1"]);
    });
    test("does not respawn early", () => {
        const t = leaf("r2", { repeat: { unit: "week", interval: 1 }, done: true, completedAt: "2026-07-08" });
        const outline = tree(t);
        expect(applyRecurrence(outline, TODAY).respawned).toEqual([]);
        expect(t.done).toBe(true);
    });
    test("leadDays makes it respawn early enough to ramp", () => {
        const t = leaf("r3", {
            repeat: { unit: "week", interval: 1, weekdays: [5] },
            leadDays: 2,
            done: true,
            completedAt: "2026-07-08",
        });
        const outline = tree(t);
        expect(applyRecurrence(outline, TODAY).respawned).toEqual(["r3"]);
        expect(t.dueDate).toBe("2026-07-10");
    });
    test("count-exhausted and until-expired tasks stay done", () => {
        const spent = leaf("r4", {
            repeat: { unit: "day", interval: 1, count: 3, timesDone: 3 },
            done: true,
            completedAt: "2026-07-01",
        });
        const expired = leaf("r5", {
            repeat: { unit: "day", interval: 1, until: "2026-07-05" },
            done: true,
            completedAt: "2026-07-05",
        });
        const outline = tree(spent, expired);
        expect(applyRecurrence(outline, TODAY).respawned).toEqual([]);
        expect(spent.done).toBe(true);
        expect(expired.done).toBe(true);
    });
    test("is idempotent within a day", () => {
        const t = leaf("r6", { repeat: daily, done: true, completedAt: "2026-07-09" });
        const outline = tree(t);
        applyRecurrence(outline, TODAY);
        expect(applyRecurrence(outline, TODAY).changed).toBe(false);
    });
});
describe("contexts", () => {
    test("active context hides other contexts, keeps matching and context-free", () => {
        const outline = tree(leaf("home-task", { context: "Home" }), leaf("office-task", { context: "Office" }), leaf("anywhere-task"));
        const ids = (ctx?: string | null) => availableTasks(outline, TODAY, ctx).map((c) => c.task.id);
        expect(ids(null)).toEqual(["home-task", "office-task", "anywhere-task"]);
        expect(ids("Home")).toEqual(["home-task", "anywhere-task"]);
        expect(ids("Office")).toEqual(["office-task", "anywhere-task"]);
    });
    test("context inherits from a project; leaf can override", () => {
        const project: OutlineNode = {
            id: "proj",
            title: "Office project",
            weight: 50,
            ordering: "parallel",
            context: "Office",
            children: [leaf("inherited"), leaf("overridden", { context: "Home" })],
        };
        const outline = tree(project);
        const ids = (ctx: string) => availableTasks(outline, TODAY, ctx).map((c) => c.task.id);
        expect(ids("Office")).toEqual(["inherited"]);
        expect(ids("Home")).toEqual(["overridden"]);
    });
});
import { contextAllows, contextDefMap, contextOpen, nextOpeningToday } from "../core/contexts";
import type { ContextDef } from "../core/types";
describe("context open hours", () => {
    const office: ContextDef = {
        name: "Office",
        windows: [{ days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00" }],
    };
    test("no def or no hours = always open", () => {
        expect(contextOpen(undefined, TODAY, "23:00").openNow).toBe(true);
        expect(contextOpen({ name: "X" }, TODAY, "23:00").openNow).toBe(true);
    });
    test("closed day / open now / opens later / closed rest of day", () => {
        expect(contextOpen(office, "2026-07-12", "10:00").openToday).toBe(false);
        expect(contextOpen(office, TODAY, "10:00")).toEqual({ openNow: true, opensLaterToday: false, openToday: true });
        expect(contextOpen(office, TODAY, "06:30")).toEqual({ openNow: false, opensLaterToday: true, openToday: true });
        expect(contextOpen(office, TODAY, "19:00")).toEqual({ openNow: false, opensLaterToday: false, openToday: true });
    });
    test("date-only callers treat an open day as open", () => {
        expect(contextOpen(office, TODAY).openNow).toBe(true);
    });
    test("availability: closed-rest-of-day hides, opens-later keeps, explicit selection overrides", () => {
        const outline = tree(leaf("office-task", { context: "Office" }), leaf("free-task"));
        const defs = [office];
        const ids = (active: string | null, time?: string) => availableTasks(outline, TODAY, active, defs, time).map((c) => c.task.id);
        expect(ids(null, "06:00")).toEqual(["office-task", "free-task"]);
        expect(ids(null, "12:00")).toEqual(["office-task", "free-task"]);
        expect(ids(null, "21:00")).toEqual(["free-task"]);
        expect(ids("Office", "21:00")).toEqual(["office-task", "free-task"]);
        expect(availableTasks(outline, "2026-07-12", null, defs, "12:00").map((c) => c.task.id)).toEqual(["free-task"]);
    });
    test("inherited context is what gets hour-checked", () => {
        const project: OutlineNode = {
            id: "proj",
            title: "Office project",
            weight: 50,
            ordering: "parallel",
            context: "Office",
            children: [leaf("step")],
        };
        const outline = tree(project);
        expect(availableTasks(outline, TODAY, null, [office], "21:00")).toEqual([]);
        const kept = availableTasks(outline, TODAY, null, [office], "12:00");
        expect(kept.map((c) => c.task.id)).toEqual(["step"]);
        expect(required(kept[0]).ctx).toBe("Office");
    });
    test("contextAllows helper matches the matrix", () => {
        const defs = contextDefMap([office]);
        expect(contextAllows(undefined, null, defs, TODAY, "21:00")).toBe(true);
        expect(contextAllows("Office", null, defs, TODAY, "21:00")).toBe(false);
        expect(contextAllows("Office", "Office", defs, TODAY, "21:00")).toBe(true);
        expect(contextAllows("Undefined-ctx", null, defs, TODAY, "21:00")).toBe(true);
    });
});
describe("multi-window contexts and case-insensitivity", () => {
    const home: ContextDef = {
        name: "Home",
        windows: [
            { days: [1, 2, 3, 4, 5], from: "18:00", to: "23:00" },
            { days: [0, 6], from: "00:00", to: "23:59" },
        ],
    };
    test("open-state aggregates across windows", () => {
        expect(contextOpen(home, "2026-07-10", "09:00")).toEqual({ openNow: false, opensLaterToday: true, openToday: true });
        expect(contextOpen(home, "2026-07-10", "19:30").openNow).toBe(true);
        expect(contextOpen(home, "2026-07-11", "09:00").openNow).toBe(true);
        expect(contextOpen(home, "2026-07-12", "22:00").openNow).toBe(true);
    });
    test("availability with multi-window: Friday noon hides only if nothing later", () => {
        const outline = tree(leaf("home-task", { context: "Home" }), leaf("free"));
        const ids = (day: string, time: string) => availableTasks(outline, day, null, [home], time).map((c) => c.task.id);
        expect(ids("2026-07-10", "12:00")).toEqual(["home-task", "free"]);
        expect(ids("2026-07-10", "23:30")).toEqual(["free"]);
        expect(ids("2026-07-11", "10:00")).toEqual(["home-task", "free"]);
    });
    test("context matching is case-insensitive (filter + defs)", () => {
        const outline = tree(leaf("t-home", { context: "home" }), leaf("t-free"));
        expect(availableTasks(outline, "2026-07-11", "HOME", [home], "10:00").map((c) => c.task.id))
            .toEqual(["t-home", "t-free"]);
        expect(availableTasks(outline, "2026-07-10", null, [home], "23:30").map((c) => c.task.id))
            .toEqual(["t-free"]);
    });
    test("nextOpeningToday picks the earliest window still ahead", () => {
        expect(nextOpeningToday(home, "2026-07-10", "09:00")).toBe("18:00");
        expect(nextOpeningToday(home, "2026-07-10", "22:00")).toBe(null);
    });
});
