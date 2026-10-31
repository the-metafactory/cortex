import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskGoal } from "../api/desk-goal";
import { HandledLedger } from "../desk/actions";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import { GoalChecks, GoalStatuses, parseGoalList, type GoalRunResult } from "../desk/goals";
import { asOf } from "../desk/rank";
import { startOfDay } from "../desk/time";
import { initDatabase } from "../db/init";
import { writeVigilSubject } from "../../../vigil/db";

const NOW = Date.parse("2026-10-31T09:10:00.000Z");
const LAST_NIGHT = startOfDay(NOW) - 30 * 60_000;

const DESK: DeskOptions = {
  enabled: true,
  displayName: "Ada",
  topN: 5,
  rangerUrl: "",
  areas: [],
  sources: [],
  goals: {
    somaBin: "/opt/soma/bin/soma",
    check: { G6: { command: ["/opt/reflex/bin/reflex", "fire", "g6-sensor-manual"], env: { REFLEX_CONFIG: "/home/ada/reflex.yaml" }, timeoutSeconds: 30 } },
  },
};

const vigil = { enabled: true, resolveGoalWording: (id: string) => (id === "G6" ? "Publish one Short a day." : null) };

function fakeRunner(result: GoalRunResult = { code: 0, stdout: "", stderr: "" }) {
  const calls: { argv: string[]; env: Record<string, string> }[] = [];
  return { calls, run: async (argv: string[], env: Record<string, string>) => { calls.push({ argv, env }); return result; } };
}

const post = (body: unknown): Request =>
  new Request("http://localhost/api/desk/goal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const runtime = (desk: DeskOptions = DESK): DeskRuntime => ({ options: desk, ledger: new HandledLedger(), goalChecks: new GoalChecks(), goalStatuses: new GoalStatuses(async () => ({ code: 0, stdout: "G6\tactive\tsupports: [M0]\n", stderr: "" })) });

describe("acting on a goal from the Desk", () => {
  let db: Database;
  beforeEach(() => {
    db = initDatabase(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  const seedGoal = (endedAt: number, value = "off-track") =>
    writeVigilSubject(db, {
      subject_key: "state:goal:default:G6", subject_kind: "state", vocab: "goal", ref: "G6", value, healthy: 0,
      goal_id: "G6", producer: "soma", stack: "default", run_kind: null,
      last_run_id: `run-${endedAt}`, last_ended_at: endedAt, last_seen_at: endedAt,
    }, endedAt);

  const goalItem = async (rt: DeskRuntime, now = NOW) => {
    const view = await composeDesk(db, rt.options ?? DESK, vigil, { now, goalChecks: rt.goalChecks, goalStatuses: rt.goalStatuses });
    return view.items.find((i) => i.kind === "goal");
  };

  it("says how old the reading is and offers a check and a pause", async () => {
    seedGoal(LAST_NIGHT);
    const item = await goalItem(runtime());
    expect(item?.why).toStartWith("This reading is as of 23:30 yesterday.");
    expect(item?.actions.map((a) => [a.id, a.role])).toEqual([["goal.check", "primary"], ["goal.pause", "secondary"], ["snooze", "secondary"]]);
    expect(item?.goal).toBe("G6");
  });

  it("shows no check or pause for a goal the stack has not set up", async () => {
    seedGoal(LAST_NIGHT);
    const item = await goalItem(runtime({ ...DESK, goals: { somaBin: "", check: {} } }));
    expect(item?.actions.map((a) => a.id)).toEqual(["detail", "snooze"]);
  });

  it("runs the configured check once, marks the goal as checking, and refuses a second check until a new reading arrives", async () => {
    seedGoal(LAST_NIGHT);
    const rt = runtime();
    const runner = fakeRunner();
    const first = await handleDeskGoal(post({ action: "goal.check", goal: "G6" }), rt, { run: runner.run, now: () => NOW });
    expect(first.status).toBe(200);
    expect(runner.calls).toEqual([{ argv: ["/opt/reflex/bin/reflex", "fire", "g6-sensor-manual"], env: { REFLEX_CONFIG: "/home/ada/reflex.yaml" } }]);
    expect((await goalItem(rt, NOW + 1000))?.checking).toBe(true);

    const again = await handleDeskGoal(post({ action: "goal.check", goal: "G6" }), rt, { run: runner.run, now: () => NOW + 2000 });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("A check for this goal is still running.");
    expect(runner.calls).toHaveLength(1);

    seedGoal(NOW + 30_000);
    const fresh = await goalItem(rt, NOW + 31_000);
    expect(fresh?.checking).toBeUndefined();
    expect(fresh?.why).toContain("as of");
    expect((await handleDeskGoal(post({ action: "goal.check", goal: "G6" }), rt, { run: runner.run, now: () => NOW + 32_000 })).status).toBe(200);
  });

  it("returns a failed check as one line and lets the next press try again", async () => {
    const rt = runtime();
    const failing = fakeRunner({ code: 2, stdout: "", stderr: "loading blueprints\nno blueprint g6-sensor-manual\n" });
    const res = await handleDeskGoal(post({ action: "goal.check", goal: "G6" }), rt, { run: failing.run, now: () => NOW });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("The check failed: no blueprint g6-sensor-manual");
    expect(rt.goalChecks?.pending("G6", NOW)).toBe(false);
  });

  it("refuses a check for a goal without one, without running anything", async () => {
    const runner = fakeRunner();
    const res = await handleDeskGoal(post({ action: "goal.check", goal: "G7" }), runtime(), { run: runner.run });
    expect(res.status).toBe(409);
    expect(runner.calls).toHaveLength(0);
  });

  it("pauses the goal in Soma and takes it off the list", async () => {
    seedGoal(LAST_NIGHT);
    const rt = runtime();
    expect(await goalItem(rt)).toBeDefined();
    const runner = fakeRunner();
    const res = await handleDeskGoal(post({ action: "goal.pause", goal: "G6" }), rt, { run: runner.run });
    expect(res.status).toBe(200);
    expect(runner.calls[0]?.argv).toEqual(["/opt/soma/bin/soma", "goal", "set-status", "G6", "paused"]);
    expect(await goalItem(rt)).toBeUndefined();
  });

  it("returns a refused pause as one line and keeps the goal listed", async () => {
    seedGoal(LAST_NIGHT);
    const rt = runtime();
    const runner = fakeRunner({ code: 1, stdout: "", stderr: "soma: G6 is not a goal record\n" });
    const res = await handleDeskGoal(post({ action: "goal.pause", goal: "G6" }), rt, { run: runner.run });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Soma did not pause the goal: soma: G6 is not a goal record");
    expect(await goalItem(rt)).toBeDefined();
  });

  it("refuses to pause an id Soma does not use, and refuses when no Soma is set", async () => {
    const runner = fakeRunner();
    expect((await handleDeskGoal(post({ action: "goal.pause", goal: "--home-dir=/tmp" }), runtime(), { run: runner.run })).status).toBe(400);
    expect((await handleDeskGoal(post({ action: "goal.pause", goal: "G6" }), runtime({ ...DESK, goals: { somaBin: "", check: {} } }), { run: runner.run })).status).toBe(409);
    expect(runner.calls).toHaveLength(0);
  });
});

describe("goal readings and statuses", () => {
  it("names the reading's time in words", () => {
    expect(asOf(NOW, startOfDay(NOW) + 8 * 3_600_000)).toBe("as of 08:00 today");
    expect(asOf(NOW, LAST_NIGHT)).toBe("as of 23:30 yesterday");
    expect(asOf(NOW, NOW - 10 * 86_400_000)).toBe("as of 10 days ago");
  });

  it("reads statuses from soma goal list and keeps the last reading when a read fails", async () => {
    expect([...parseGoalList("G5\tactive\tsupports: [M0]\nG6\tpaused\tsupports: [M0]\nnoise\n")]).toEqual([["G5", "active"], ["G6", "paused"]]);
    let fail = false;
    const statuses = new GoalStatuses(async () => (fail ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "G6\tactive\tx\n", stderr: "" }));
    expect((await statuses.read("/bin/soma", 0)).get("G6")).toBe("active");
    fail = true;
    await statuses.read("/bin/soma", 120_000);
    expect((await statuses.read("/bin/soma", 120_001)).get("G6")).toBe("active");
  });

  it("does not hold the Desk for a Soma that hangs on the first read", async () => {
    const hung = new GoalStatuses(() => new Promise<GoalRunResult>(() => {}));
    const started = Date.now();
    expect((await hung.read("/bin/soma", 0)).size).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
