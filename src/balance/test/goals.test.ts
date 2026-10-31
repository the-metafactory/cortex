import { required } from "../core/required";
import { describe, expect, test } from "bun:test";
import { monthReview, streakInfo, validateFocusChange } from "../core/goals";
import { type AppState, type CompletionEvent, type OutlineNode, DEFAULT_SETTINGS, } from "../core/types";
const TODAY = "2026-07-09";
function ev(date: string, areaId = "area-a", effort = 1): CompletionEvent {
    return { taskId: `t-${date}-${areaId}`, areaId, effort, date, title: `task ${date}` };
}
describe("streaks are non-punishing", () => {
    test("today without a completion yet does not break the streak", () => {
        const log = [ev("2026-07-07"), ev("2026-07-08")];
        const info = streakInfo(log, TODAY);
        expect(info.current).toBe(2);
    });
    test("a completion today extends the streak", () => {
        const log = [ev("2026-07-08"), ev("2026-07-09")];
        expect(streakInfo(log, TODAY).current).toBe(2);
    });
    test("showedUpLast7 counts days, quota-free", () => {
        const log = [ev("2026-07-03"), ev("2026-07-03"), ev("2026-07-06"), ev("2026-07-09")];
        const info = streakInfo(log, TODAY);
        expect(info.showedUpLast7).toBe(3);
        expect(info.week).toHaveLength(7);
        expect(info.week[6]).toEqual({ date: TODAY, showedUp: true });
    });
    test("empty log: zero streak, zero showed-up, no crash", () => {
        const info = streakInfo([], TODAY);
        expect(info.current).toBe(0);
        expect(info.showedUpLast7).toBe(0);
    });
});
describe("monthly focus", () => {
    function tree(): OutlineNode {
        const proj = (id: string, focusMonth?: string): OutlineNode => ({
            id,
            title: id,
            weight: 50,
            ordering: "parallel",
            children: [],
            focusMonth,
        });
        return {
            id: "root",
            title: "Life",
            weight: 100,
            ordering: "parallel",
            children: [
                {
                    id: "area-a",
                    title: "A",
                    weight: 100,
                    ordering: "parallel",
                    children: [
                        proj("p1", "2026-07"),
                        proj("p2", "2026-07"),
                        proj("p3", "2026-07"),
                        proj("p4"),
                    ],
                },
            ],
        };
    }
    test("a fourth focus project is refused — the cap is the feature", () => {
        const err = validateFocusChange(tree(), "p4", "2026-07", true);
        expect(err).not.toBeNull();
    });
    test("re-enabling an existing focus or disabling is always fine", () => {
        expect(validateFocusChange(tree(), "p1", "2026-07", true)).toBeNull();
        expect(validateFocusChange(tree(), "p4", "2026-07", false)).toBeNull();
    });
});
describe("month review", () => {
    test("wins first, effort share vs target, focus progress", () => {
        const outline: OutlineNode = {
            id: "root",
            title: "Life",
            weight: 100,
            ordering: "parallel",
            children: [
                {
                    id: "area-a",
                    title: "Work",
                    weight: 60,
                    ordering: "parallel",
                    children: [
                        {
                            id: "t1",
                            title: "done thing",
                            weight: 50,
                            ordering: "parallel",
                            children: [],
                            done: true,
                        },
                    ],
                },
                {
                    id: "area-b",
                    title: "Health",
                    weight: 40,
                    ordering: "parallel",
                    children: [],
                },
            ],
        };
        const state: AppState = {
            outline,
            log: [
                { taskId: "t1", areaId: "area-a", effort: 2, date: "2026-07-03", title: "done thing" },
                { taskId: "gone", areaId: "area-b", effort: 2, date: "2026-07-05", title: "walk" },
                { taskId: "old", areaId: "area-a", effort: 4, date: "2026-06-20", title: "last month" },
            ],
            settings: DEFAULT_SETTINGS,
            dayState: null,
            history: { deficits: {}, lastSurfaced: {} },
        };
        const review = monthReview(state, "2026-07");
        expect(review.totalCompletions).toBe(2);
        expect(required(review.wins[0]).title).toBe("walk");
        const work = required(review.areas.find((a) => a.areaId === "area-a"));
        expect(work.targetShare).toBeCloseTo(0.6, 5);
        expect(work.actualShare).toBeCloseTo(0.5, 5);
    });
});
