import { required } from "../core/required";
import { describe, expect, test } from "bun:test";
import { allocateSlots, availableTasks, effectiveShares, isSubtreeDone, rankAll, selectToday, urgencyOf, } from "../core/scheduler";
import { type AppState, type CompletionEvent, type OutlineNode, DEFAULT_SETTINGS, EMPTY_HISTORY, MAX_TODAY_CAP, } from "../core/types";
const TODAY = "2026-07-09";
function shift(iso: string, days: number): string {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
let counter = 0;
function task(title: string, extra: Partial<OutlineNode> = {}): OutlineNode {
    counter += 1;
    return {
        id: extra.id ?? `t${String(counter).padStart(3, "0")}`,
        title,
        weight: 50,
        ordering: "parallel",
        children: [],
        effort: 1,
        ...extra,
    };
}
function group(title: string, children: OutlineNode[], extra: Partial<OutlineNode> = {}): OutlineNode {
    counter += 1;
    return {
        id: extra.id ?? `g${String(counter).padStart(3, "0")}`,
        title,
        weight: 50,
        ordering: "parallel",
        children,
        ...extra,
    };
}
function root(...areas: OutlineNode[]): OutlineNode {
    return {
        id: "root",
        title: "Life",
        weight: 100,
        ordering: "parallel",
        children: areas,
    };
}
function state(outline: OutlineNode, log: CompletionEvent[] = [], settings = DEFAULT_SETTINGS): AppState {
    return { outline, log, settings, dayState: null, history: EMPTY_HISTORY };
}
function makeTasks(n: number, prefix: string): OutlineNode[] {
    return Array.from({ length: n }, (_, i) => task(`${prefix} ${i + 1}`, { id: `${prefix}-${String(i + 1).padStart(2, "0")}` }));
}
describe("availability", () => {
    test("parallel groups surface all incomplete tasks", () => {
        const tree = root(group("Area", [task("a"), task("b", { done: true }), task("c")]));
        const titles = availableTasks(tree, TODAY).map((c) => c.task.title);
        expect(titles).toEqual(["a", "c"]);
    });
    test("sequential groups surface only the first incomplete task", () => {
        const tree = root(group("Area", [
            group("Project", [task("step1", { done: true }), task("step2"), task("step3")], { ordering: "sequential" }),
        ]));
        const titles = availableTasks(tree, TODAY).map((c) => c.task.title);
        expect(titles).toEqual(["step2"]);
    });
    test("a deferred next step pauses the whole sequential chain", () => {
        const tree = root(group("Area", [
            group("Project", [task("step1", { deferredUntil: "2026-07-20" }), task("step2")], {
                ordering: "sequential",
            }),
        ]));
        expect(availableTasks(tree, TODAY)).toEqual([]);
    });
    test("deferredUntil today is available again; startDate in future is hidden", () => {
        const tree = root(group("Area", [
            task("back", { deferredUntil: TODAY }),
            task("later", { startDate: "2026-08-01" }),
        ]));
        const titles = availableTasks(tree, TODAY).map((c) => c.task.title);
        expect(titles).toEqual(["back"]);
    });
    test("zero-weight areas and groups are paused", () => {
        const tree = root(group("Off", [task("hidden")], { weight: 0 }), group("On", [task("visible"), group("Paused sub", [task("also hidden")], { weight: 0 })]));
        const titles = availableTasks(tree, TODAY).map((c) => c.task.title);
        expect(titles).toEqual(["visible"]);
    });
    test("nested sequential-within-sequential recurses into first incomplete subtree", () => {
        const tree = root(group("Area", [
            group("Outer", [
                group("Phase1", [task("p1a", { done: true }), task("p1b")], {
                    ordering: "sequential",
                }),
                group("Phase2", [task("p2a")], { ordering: "sequential" }),
            ], { ordering: "sequential" }),
        ]));
        const titles = availableTasks(tree, TODAY).map((c) => c.task.title);
        expect(titles).toEqual(["p1b"]);
    });
});
describe("effective shares and balance feedback", () => {
    test("with no history, shares follow the sliders", () => {
        const a = group("A", makeTasks(3, "a"), { id: "area-a", weight: 75 });
        const b = group("B", makeTasks(3, "b"), { id: "area-b", weight: 25 });
        const shares = effectiveShares(root(a, b), [], TODAY, DEFAULT_SETTINGS);
        expect(required(shares.get("area-a"))).toBeCloseTo(0.75, 5);
        expect(required(shares.get("area-b"))).toBeCloseTo(0.25, 5);
    });
    test("a neglected area rises above its static share (C6)", () => {
        const a = group("A", makeTasks(3, "a"), { id: "area-a", weight: 50 });
        const b = group("B", makeTasks(3, "b"), { id: "area-b", weight: 50 });
        const log: CompletionEvent[] = [
            { taskId: "a-01", areaId: "area-a", effort: 4, date: "2026-07-08", title: "a1" },
            { taskId: "a-02", areaId: "area-a", effort: 4, date: "2026-07-07", title: "a2" },
        ];
        const shares = effectiveShares(root(a, b), log, TODAY, DEFAULT_SETTINGS);
        expect(required(shares.get("area-b"))).toBeGreaterThan(0.5);
        expect(required(shares.get("area-a"))).toBeLessThan(0.5);
        expect(required(shares.get("area-a")) + required(shares.get("area-b"))).toBeCloseTo(1, 5);
    });
    test("balanceBeta 0 disables feedback entirely", () => {
        const a = group("A", makeTasks(2, "a"), { id: "area-a", weight: 50 });
        const b = group("B", makeTasks(2, "b"), { id: "area-b", weight: 50 });
        const log: CompletionEvent[] = [
            { taskId: "a-01", areaId: "area-a", effort: 4, date: "2026-07-08", title: "a1" },
        ];
        const shares = effectiveShares(root(a, b), log, TODAY, {
            ...DEFAULT_SETTINGS,
            balanceBeta: 0,
        });
        expect(required(shares.get("area-a"))).toBeCloseTo(0.5, 5);
    });
    test("old completions decay: two weeks away is not punished", () => {
        const a = group("A", makeTasks(2, "a"), { id: "area-a", weight: 50 });
        const b = group("B", makeTasks(2, "b"), { id: "area-b", weight: 50 });
        const log: CompletionEvent[] = [
            { taskId: "a-01", areaId: "area-a", effort: 4, date: "2026-05-01", title: "old" },
        ];
        const shares = effectiveShares(root(a, b), log, TODAY, DEFAULT_SETTINGS);
        expect(required(shares.get("area-b"))).toBeGreaterThan(0.49);
        expect(required(shares.get("area-b"))).toBeLessThan(0.56);
    });
    test("focus month boosts a project's share (monthly goals)", () => {
        const focusProject = group("Focus me", makeTasks(2, "f"), {
            id: "proj-focus",
            weight: 50,
            focusMonth: "2026-07",
        });
        const plain = group("Plain", makeTasks(2, "p"), { id: "proj-plain", weight: 50 });
        const area = group("Area", [focusProject, plain], { id: "area-a", weight: 100 });
        const shares = effectiveShares(root(area), [], TODAY, DEFAULT_SETTINGS);
        expect(required(shares.get("proj-focus"))).toBeGreaterThan(required(shares.get("proj-plain")));
        expect(required(shares.get("proj-focus"))).toBeCloseTo(0.6, 5);
    });
});
describe("urgency", () => {
    test("no due date means neutral urgency", () => {
        expect(urgencyOf(task("x"), TODAY)).toBe(1);
    });
    test("ramps toward due date and saturates when overdue", () => {
        const due = task("x", { dueDate: "2026-07-12", leadDays: 6 });
        expect(urgencyOf(due, TODAY)).toBeCloseTo(2, 5);
        expect(urgencyOf(task("y", { dueDate: "2026-07-01" }), TODAY)).toBe(3);
        expect(urgencyOf(task("z", { dueDate: "2026-09-01" }), TODAY)).toBe(1);
    });
});
describe("allocateSlots", () => {
    test("largest remainder, deterministic ties", () => {
        const slots = allocateSlots(new Map([
            ["a", 0.5],
            ["b", 0.3],
            ["c", 0.2],
        ]), 5);
        expect(slots.get("a")).toBe(3);
        expect(slots.get("b")).toBe(1);
        expect(slots.get("c")).toBe(1);
    });
    test("zero total weight allocates nothing", () => {
        const slots = allocateSlots(new Map([["a", 0]]), 5);
        expect(slots.get("a")).toBe(0);
    });
});
describe("selectToday", () => {
    function bigState(): AppState {
        const work = group("Work", makeTasks(10, "w"), { id: "area-work", weight: 40 });
        const health = group("Health", makeTasks(10, "h"), { id: "area-health", weight: 30 });
        const creative = group("Creative", makeTasks(10, "c"), { id: "area-creative", weight: 20 });
        const home = group("Home", makeTasks(10, "m"), { id: "area-home", weight: 10 });
        return state(root(work, health, creative, home));
    }
    test("respects the cap and spreads across areas (C5)", () => {
        const today = selectToday(bigState(), TODAY);
        expect(today.length).toBe(DEFAULT_SETTINGS.todayCap);
        const areas = new Set(today.map((i) => i.areaId));
        expect(areas.size).toBeGreaterThanOrEqual(3);
    });
    test("never exceeds the hard cap even with absurd settings (A2)", () => {
        const s = bigState();
        s.settings = { ...s.settings, todayCap: 999 };
        expect(selectToday(s, TODAY).length).toBeLessThanOrEqual(MAX_TODAY_CAP);
    });
    test("emergency mode returns exactly one task", () => {
        const s = bigState();
        s.settings = { ...s.settings, emergencyMode: true };
        expect(selectToday(s, TODAY).length).toBe(1);
    });
    test("is deterministic: same inputs, same list (A1)", () => {
        const a = selectToday(bigState(), TODAY).map((i) => i.task.id);
        const b = selectToday(bigState(), TODAY).map((i) => i.task.id);
        expect(a).toEqual(b);
    });
    test("due-soon task from a tiny area still makes the list", () => {
        const s = bigState();
        const tiny = group("Tiny", [task("urgent tax form", { id: "tiny-due", dueDate: "2026-07-10" })], { id: "area-tiny", weight: 1 });
        s.outline.children.push(tiny);
        const today = selectToday(s, TODAY);
        expect(today.map((i) => i.task.id)).toContain("tiny-due");
        expect(required(today.find((i) => i.task.id === "tiny-due")).reason).toBe("due");
    });
    test("neglect shifts selection toward the starved area (C6 end-to-end)", () => {
        const s = bigState();
        const log: CompletionEvent[] = [];
        for (let d = 1; d <= 7; d++) {
            log.push({
                taskId: `w-x${d}`,
                areaId: "area-work",
                effort: 4,
                date: `2026-07-0${d}`,
                title: `w${d}`,
            });
        }
        s.log = log;
        const today = selectToday(s, TODAY);
        const workCount = today.filter((i) => i.areaId === "area-work").length;
        const fresh = selectToday({ ...s, log: [] }, TODAY);
        const workCountFresh = fresh.filter((i) => i.areaId === "area-work").length;
        expect(workCount).toBeLessThanOrEqual(workCountFresh);
        expect(today.filter((i) => i.areaId !== "area-work").length).toBeGreaterThanOrEqual(4);
    });
    test("empty tree and all-deferred tree yield an empty list, not an error", () => {
        expect(selectToday(state(root()), TODAY)).toEqual([]);
        const deferred = root(group("Area", [task("z", { deferredUntil: "2026-08-01" })], { id: "area-a" }));
        expect(selectToday(state(deferred), TODAY)).toEqual([]);
    });
    test("single-area tree fills the whole list from that area", () => {
        const only = group("Only", makeTasks(8, "o"), { id: "area-only", weight: 50 });
        const today = selectToday(state(root(only)), TODAY);
        expect(today.length).toBe(DEFAULT_SETTINGS.todayCap);
        expect(today.every((i) => i.areaId === "area-only")).toBe(true);
    });
});
import { applyDayToHistory, creditIndex, focusContainment } from "../core/scheduler";
import { EMPTY_HISTORY as EH } from "../core/types";
describe("red-team fixes", () => {
    test("urgency: due today is 3 even with leadDays 0", () => {
        expect(urgencyOf(task("x", { dueDate: TODAY, leadDays: 0 }), TODAY)).toBe(3);
        expect(urgencyOf(task("y", { dueDate: "2026-07-15", leadDays: 0 }), TODAY)).toBe(1);
    });
    test("credit cutoff: events older than 8 half-lives vanish entirely", () => {
        const tree = root(group("A", [task("a")], { id: "area-a" }));
        const credits = creditIndex(tree, [{ taskId: "zz", areaId: "area-a", effort: 4, date: "2026-04-01", title: "ancient" }], TODAY, 7);
        expect(credits.get("area-a") ?? 0).toBe(0);
    });
    test("focus containment lifts the AREA share, even for an only-child project (red-team #7)", () => {
        const mk = (focus: boolean) => root(group("A", [group("Only proj", makeTasks(2, "f"), {
                id: "proj",
                weight: 50,
                ...(focus ? { focusMonth: "2026-07" } : {}),
            })], { id: "area-a", weight: 50 }), group("B", makeTasks(2, "b"), { id: "area-b", weight: 50 }));
        const withFocus = effectiveShares(mk(true), [], TODAY, DEFAULT_SETTINGS);
        const without = effectiveShares(mk(false), [], TODAY, DEFAULT_SETTINGS);
        expect(required(withFocus.get("area-a"))).toBeGreaterThan(required(without.get("area-a")));
    });
    test("stride deficits: a 5%-weight area surfaces within 12 simulated days (red-team #1)", () => {
        const big1 = group("Big1", makeTasks(15, "x"), { id: "area-x", weight: 40 });
        const big2 = group("Big2", makeTasks(15, "y"), { id: "area-y", weight: 35 });
        const big3 = group("Big3", makeTasks(15, "z"), { id: "area-z", weight: 20 });
        const tiny = group("Tiny", makeTasks(5, "q"), { id: "area-q", weight: 5 });
        let s = state(root(big1, big2, big3, tiny));
        s.history = EH;
        let surfaced = false;
        for (let d = 0; d < 12 && !surfaced; d++) {
            const date = `2026-08-${String(d + 1).padStart(2, "0")}`;
            const list = selectToday(s, date);
            if (list.some((i) => i.areaId === "area-q"))
                surfaced = true;
            s = { ...s, history: applyDayToHistory(s, date, list.map((i) => i.task.id)) };
        }
        expect(surfaced).toBe(true);
    });
    test("emergency mode picks the easiest of the top tasks, not the scariest (red-team #11)", () => {
        const area = group("A", [
            task("scary huge overdue", { id: "a-scary", effort: 4, dueDate: "2026-06-01" }),
            task("tiny win", { id: "a-tiny", effort: 1 }),
            task("medium", { id: "a-med", effort: 2 }),
        ], { id: "area-a" });
        const s = state(root(area));
        s.settings = { ...s.settings, emergencyMode: true };
        const list = selectToday(s, TODAY);
        expect(list.length).toBe(1);
        expect(required(list[0]).task.id).toBe("a-tiny");
    });
    test("re-entry after a quiet week caps the list at 3 (red-team #13)", () => {
        const s = state(root(group("A", makeTasks(6, "a"), { id: "area-a" }), group("B", makeTasks(6, "b"), { id: "area-b" })), [{ taskId: "old", areaId: "area-a", effort: 2, date: "2026-06-20", title: "before the gap" }]);
        expect(selectToday(s, TODAY).length).toBe(3);
    });
    test("every item carries a because-trace", () => {
        const s = state(root(group("A", makeTasks(3, "a"), { id: "area-a" })));
        for (const item of selectToday(s, TODAY)) {
            expect(item.trace.length).toBeGreaterThan(0);
        }
    });
    test("applyDayToHistory is idempotent per date and clamps deficits", () => {
        const s = state(root(group("A", makeTasks(3, "a"), { id: "area-a" })));
        const h1 = applyDayToHistory(s, TODAY, ["a-01"]);
        const h2 = applyDayToHistory({ ...s, history: h1 }, TODAY, ["a-01"]);
        expect(h2).toBe(h1);
        for (const v of Object.values(h1.deficits)) {
            expect(Math.abs(v)).toBeLessThanOrEqual(3);
        }
        expect(h1.lastSurfaced["a-01"]).toBe(TODAY);
    });
    test("focusContainment marks the chain up to the root", () => {
        const proj = group("P", [task("t")], { id: "proj", focusMonth: "2026-07" });
        const area = group("A", [proj], { id: "area-a" });
        const tree = root(area);
        const ids = focusContainment(tree, "2026-07");
        expect(ids.has("proj")).toBe(true);
        expect(ids.has("area-a")).toBe(true);
    });
});
describe("verify-pass fixes", () => {
    test("structural identity: an empty node IS a task — it surfaces instead of silently blocking", () => {
        const placeholder = group("Empty placeholder", [], { id: "seq-placeholder" });
        const tree = root(group("Area", [
            group("Project", [placeholder, task("real work", { id: "seq-real" })], {
                ordering: "sequential",
            }),
        ]));
        expect(availableTasks(tree, TODAY).map((c) => c.task.id)).toEqual(["seq-placeholder"]);
        placeholder.done = true;
        expect(availableTasks(tree, TODAY).map((c) => c.task.id)).toEqual(["seq-real"]);
    });
    test("a paused (weight-0) group mid-sequence is skipped, not blocking", () => {
        const tree = root(group("Area", [
            group("Project", [
                task("step1", { done: true }),
                group("Paused sub", [task("hidden")], { weight: 0 }),
                task("step3", { id: "seq-step3" }),
            ], { ordering: "sequential" }),
        ]));
        expect(availableTasks(tree, TODAY).map((c) => c.task.id)).toEqual(["seq-step3"]);
    });
    test("deficits of areas with nothing available today are carried, not erased", () => {
        const a = group("A", makeTasks(2, "a"), { id: "area-a", weight: 50 });
        const b = group("B", [task("b only", { id: "b-1", deferredUntil: "2026-07-20" })], {
            id: "area-b",
            weight: 50,
        });
        const s = state(root(a, b));
        s.history = { deficits: { "area-b": 2.5 }, lastSurfaced: {}, startDate: "2026-07-01" };
        const next = applyDayToHistory(s, TODAY, ["a-01"]);
        expect(next.deficits["area-b"]).toBe(2.5);
    });
    test("deficits of deleted areas are pruned", () => {
        const s = state(root(group("A", makeTasks(2, "a"), { id: "area-a" })));
        s.history = { deficits: { "area-gone": 1.5 }, lastSurfaced: {} };
        const next = applyDayToHistory(s, TODAY, ["a-01"]);
        expect("area-gone" in next.deficits).toBe(false);
    });
    test("emergency-mode day does not inflate deficits toward the clamp", () => {
        const areas = ["w", "h", "c", "m"].map((p, i) => group(p.toUpperCase(), makeTasks(4, p), { id: `area-${p}`, weight: 25 + i }));
        const s = state(root(...areas));
        s.settings = { ...s.settings, emergencyMode: true };
        const list = selectToday(s, TODAY);
        expect(list.length).toBe(1);
        const next = applyDayToHistory(s, TODAY, list.map((i) => i.task.id));
        const totalDeficit = Object.values(next.deficits).reduce((x, y) => x + y, 0);
        expect(Math.abs(totalDeficit)).toBeLessThan(0.001);
    });
    test("bench mode ignores re-entry and emergency clamps", () => {
        const s = state(root(group("A", makeTasks(6, "a"), { id: "area-a" }), group("B", makeTasks(6, "b"), { id: "area-b" })), [{ taskId: "old", areaId: "area-a", effort: 2, date: "2026-06-20", title: "gap" }]);
        s.settings = { ...s.settings, emergencyMode: true };
        expect(selectToday(s, TODAY).length).toBe(1);
        expect(selectToday(s, TODAY, { benchMode: true }).length).toBeGreaterThan(3);
    });
    test("re-entry triggers at exactly 7 quiet days", () => {
        const mk = (lastDate: string) => state(root(group("A", makeTasks(6, "a"), { id: "area-a" })), [
            { taskId: "x", areaId: "area-a", effort: 1, date: lastDate, title: "last" },
        ]);
        expect(selectToday(mk("2026-07-02"), TODAY).length).toBe(3);
        expect(selectToday(mk("2026-07-03"), TODAY).length).toBe(5);
    });
});
describe("structural identity", () => {
    test("done bubbles up: completing the last open leaf makes every ancestor done", () => {
        const leaf1 = task("a", { id: "si-a", done: true });
        const leaf2 = task("b", { id: "si-b" });
        const project = group("Project", [leaf1, leaf2], { id: "si-proj" });
        const area = group("Area", [project], { id: "si-area" });
        const tree = root(area);
        expect(isSubtreeDone(project)).toBe(false);
        expect(isSubtreeDone(area)).toBe(false);
        leaf2.done = true;
        expect(isSubtreeDone(project)).toBe(true);
        expect(isSubtreeDone(area)).toBe(true);
        expect(isSubtreeDone(tree)).toBe(true);
    });
    test("a node with children never surfaces itself; its leaves do", () => {
        const sub = task("subtask", { id: "si-sub" });
        const parentTask = group("Former task, now project", [sub], { id: "si-parent" });
        const tree = root(group("Area", [parentTask], { id: "si-area2" }));
        const ids = availableTasks(tree, TODAY).map((c) => c.task.id);
        expect(ids).toEqual(["si-sub"]);
        expect(ids).not.toContain("si-parent");
    });
    test("an explicitly closed branch hides its open leaves (shelved)", () => {
        const open = task("still open", { id: "si-open" });
        const shelved = group("Shelved project", [open], { id: "si-shelved", done: true });
        const other = task("visible", { id: "si-visible" });
        const tree = root(group("Area", [shelved, other], { id: "si-area3" }));
        expect(availableTasks(tree, TODAY).map((c) => c.task.id)).toEqual(["si-visible"]);
        expect(isSubtreeDone(shelved)).toBe(true);
    });
    test("deferring a node with children defers its whole subtree", () => {
        const sub = task("inside", { id: "si-in" });
        const proj = group("Deferred project", [sub], {
            id: "si-defproj",
            deferredUntil: "2026-08-01",
        });
        const tree = root(group("Area", [proj], { id: "si-area4" }));
        expect(availableTasks(tree, TODAY)).toEqual([]);
    });
});
describe("sage review fixes", () => {
    test("a wall of overdue tasks leaves one balanced slot (due cap = cap-1)", () => {
        const overdue = Array.from({ length: 10 }, (_, i) => task(`late ${i}`, { id: `late-${String(i).padStart(2, "0")}`, dueDate: "2026-06-01" }));
        const s = state(root(group("Deadlines", overdue, { id: "area-dead", weight: 20 }), group("Health", makeTasks(4, "hh"), { id: "area-hh", weight: 80 })));
        const today = selectToday(s, TODAY);
        expect(today.length).toBe(DEFAULT_SETTINGS.todayCap);
        expect(today.some((i) => i.areaId === "area-hh")).toBe(true);
    });
    test("with only due tasks available, they may fill the whole cap", () => {
        const overdue = Array.from({ length: 8 }, (_, i) => task(`late ${i}`, { id: `only-${String(i).padStart(2, "0")}`, dueDate: "2026-06-01" }));
        const s = state(root(group("Deadlines", overdue, { id: "area-only" })));
        expect(selectToday(s, TODAY).length).toBe(DEFAULT_SETTINGS.todayCap);
    });
});
describe("blank-install edge", () => {
    test("a childless area never offers itself as a task", () => {
        const empty = group("Inbox", [], { id: "area-inbox" });
        const s = state(root(empty));
        expect(selectToday(s, TODAY)).toEqual([]);
        expect(availableTasks(s.outline, TODAY)).toEqual([]);
    });
});
describe("rankAll — the browsable full list", () => {
    function neglectedInbox(): AppState {
        const inbox = group("Inbox", Array.from({ length: 10 }, (_, i) => task(`import ${i}`, { id: `ext-tana-${String(i).padStart(2, "0")}` })), { id: "area-inbox", weight: 15 });
        const health = group("Health", [task("walk", { id: "h1" }), task("stretch", { id: "h2" })], {
            id: "area-health",
            weight: 50,
        });
        const work = group("Work", [task("report", { id: "w1" }), task("triage", { id: "w2" })], {
            id: "area-work",
            weight: 50,
        });
        const log: CompletionEvent[] = [];
        for (let d = 1; d <= 8; d += 1) {
            log.push({ taskId: "h1", areaId: "area-health", effort: 2, date: shift(TODAY, -d), title: "walk" });
            log.push({ taskId: "w1", areaId: "area-work", effort: 2, date: shift(TODAY, -d), title: "report" });
        }
        const s = state(root(inbox, health, work), log);
        s.history = {
            startDate: "2026-01-01",
            deficits: {},
            lastSurfaced: { h1: "2026-07-08", h2: "2026-07-08", w1: "2026-07-08", w2: "2026-07-08" },
        };
        return s;
    }
    test("a long-neglected Inbox pile does not monopolise the top of the list", () => {
        const ranked = rankAll(neglectedInbox(), TODAY);
        const topFour = ranked.slice(0, 4);
        expect(topFour.every((i) => i.areaId === "area-inbox")).toBe(false);
        expect(new Set(topFour.map((i) => i.areaId)).size).toBeGreaterThan(1);
    });
    test("every available task still appears — clamping reorders, never drops", () => {
        expect(rankAll(neglectedInbox(), TODAY).length).toBe(14);
    });
    test("the clamp does not reach selectToday — its picks are pinned", () => {
        expect(selectToday(neglectedInbox(), TODAY).map((i) => i.task.id)).toEqual([
            "ext-tana-00",
            "h2",
            "w2",
            "h1",
            "w1",
        ]);
    });
    test("refill selects through rankAll, so the clamp does reach it", () => {
        const s = neglectedInbox();
        const contract = new Set(selectToday(s, TODAY).map((i) => i.task.id));
        const next = rankAll(s, TODAY).find((i) => !contract.has(i.task.id) && !i.task.done);
        expect(next?.task.id).toBe("ext-tana-01");
    });
    test("neglect still discriminates strictly below the ceiling", () => {
        const s = neglectedInbox();
        s.history.lastSurfaced = {
            ...s.history.lastSurfaced,
            "ext-tana-00": TODAY,
            "ext-tana-01": shift(TODAY, -14),
        };
        const ids = rankAll(s, TODAY).map((i) => i.task.id);
        expect(ids.indexOf("ext-tana-01")).toBeLessThan(ids.indexOf("ext-tana-00"));
    });
});
