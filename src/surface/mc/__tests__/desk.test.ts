import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { handleGetDesk } from "../api/desk";
import { composeDesk, type DeskOptions } from "../desk/compose";
import { briefing, selectItems } from "../desk/present";
import type { RangerState } from "../desk/sources/ranger";
import type { DeskView } from "../desk/types";
import { writeVigilSubject, type VigilObservation } from "../../../vigil/db";
import { McSchema } from "../../../common/types/config";

const NOW = Date.parse("2026-10-30T11:16:00.000Z");
const EARLIER = NOW - 3 * 3_600_000;

const DESK: DeskOptions = {
  enabled: true,
  displayName: "Ada",
  topN: 2,
  rangerUrl: "http://127.0.0.1:7311",
  areas: [
    { id: "work", label: "Work", color: "#2563eb", repos: ["example/app"], goals: ["G1"] },
    { id: "home", label: "Home", color: "#059669", repos: [], goals: ["G2"] },
  ],
};

const WORDING: Record<string, string> = {
  G1: "Ship one release a week: small and steady.",
  G2: "Walk every day, by the lake.",
};
const vigil = { enabled: true, resolveGoalWording: (id: string) => WORDING[id] ?? null };

function rangerState(overrides: Partial<RangerState> = {}): RangerState {
  return {
    current: [{ repo: "example/app", nodeId: "7", title: "Add the export button", status: "running", phase: "review", startedAt: new Date(EARLIER).toISOString() }],
    needsYou: [{ key: "example/app#1", repo: "example/app", nodeId: "12", title: "Fix the login timeout", status: "failed", endedAt: new Date(EARLIER).toISOString(), reason: { class: "worker failed", detail: "tests failed" }, url: "https://example.test/12" }],
    maps: [{ key: "example/app#1", repo: "example/app", decisions: [{ id: "30", title: "Adopt the new date library" }], grillings: [{ id: "31", title: "Which cache should we use?" }] }],
    ...overrides,
  };
}

const fetchRanger = (state: RangerState | Error) => async () => {
  if (state instanceof Error) throw state;
  return Response.json(state);
};

describe("the Desk", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  function seed(o: Partial<VigilObservation>) {
    writeVigilSubject(db, {
      subject_key: "x", subject_kind: "state", vocab: "goal", ref: "x", value: "on-track", healthy: 1,
      goal_id: null, producer: "soma", stack: "default", run_kind: null,
      last_run_id: "run-1", last_ended_at: EARLIER, last_seen_at: EARLIER,
      ...o,
    }, EARLIER);
  }

  async function compose(ranger: RangerState | Error = rangerState()): Promise<DeskView> {
    return composeDesk(db, DESK, vigil, { now: NOW, fetchImpl: fetchRanger(ranger) });
  }

  it("ranks a broken goal check first and names it in words, not identifiers", async () => {
    seed({ subject_key: "state:goal:default:G1", ref: "G1", goal_id: "G1", value: "off-track", healthy: 0 });
    seed({ subject_key: "state:check:default:G1.sensor", vocab: "check", ref: "G1.sensor", goal_id: "G1", value: "regressed", healthy: 0 });
    const view = await compose();
    const [first, second] = view.items;
    expect(first?.kind).toBe("sensor");
    expect(first?.title).toBe('The sensor check for "Ship one release a week" stopped working.');
    expect(second?.title).toBe('"Ship one release a week" is off track.');
    for (const item of view.items) expect(`${item.title} ${item.why}`).not.toMatch(/state:|#\d|att:|\bG\d+\b/);
    expect(first?.detail.refs).toContain("state:check:default:G1.sensor");
  });

  it("names a Vigil escalation with Ranger's title and does not list it twice", async () => {
    seed({ subject_key: "state:escalation:default:example/app#30", vocab: "escalation", ref: "example/app#30", value: "needs-principal", healthy: 0 });
    seed({ subject_key: "state:escalation:default:example/app#12", vocab: "escalation", ref: "example/app#12", value: "overdue", healthy: 0 });
    const view = await compose();
    const titles = view.items.map((i) => i.title);
    expect(titles.filter((t) => t.includes("Adopt the new date library"))).toEqual(['"Adopt the new date library" waits for your go-ahead.']);
    expect(titles.filter((t) => t.includes("Fix the login timeout"))).toHaveLength(1);
  });

  it("places items in the configured areas and keeps unmatched ones out of every area", async () => {
    seed({ subject_key: "state:goal:default:G2", ref: "G2", goal_id: "G2", value: "at-risk", healthy: 0 });
    seed({ subject_key: "state:escalation:default:other/repo#4", vocab: "escalation", ref: "other/repo#4", value: "needs-principal", healthy: 0 });
    const view = await compose();
    expect(view.items.find((i) => i.kind === "goal")?.area).toBe("home");
    expect(view.items.find((i) => i.kind === "agent-failed")?.area).toBe("work");
    expect(view.items.find((i) => i.kind === "escalation")?.area).toBeNull();
    const home = selectItems(view, "home", new Set());
    expect(home.needsYou.map((i) => i.kind)).toEqual(["goal"]);
  });

  it("shows the top N, folds the rest by kind and lets snoozed items through", async () => {
    const view = await compose();
    const all = selectItems(view, "all", new Set());
    expect(all.needsYou).toHaveLength(2);
    expect(all.groups.map((g) => [g.kind, g.count])).toEqual([["grilling", 1]]);
    const after = selectItems(view, "all", new Set([all.needsYou[0]!.key]));
    expect(after.needsYou.map((i) => i.key)).toEqual([all.needsYou[1]!.key, all.rest[0]!.key]);
  });

  it("writes a briefing that greets by name and follows the area filter", async () => {
    seed({ subject_key: "state:check:default:G1.sensor", vocab: "check", ref: "G1.sensor", goal_id: "G1", value: "regressed", healthy: 0 });
    const view = await compose();
    const all = briefing(view, selectItems(view, "all", new Set()), null);
    expect(all.greeting).toMatch(/, Ada\.$/);
    expect(all.lines[0]).toBe('1 thing needs you today. First: the sensor check for "Ship one release a week" stopped working.');
    const home = briefing(view, selectItems(view, "home", new Set()), "Home");
    expect(home.lines).toEqual(["Nothing needs you in Home right now."]);
  });

  it("keeps working when Ranger is down and says so as a system line", async () => {
    seed({ subject_key: "state:goal:default:G1", ref: "G1", goal_id: "G1", value: "off-track", healthy: 0 });
    const view = await compose(new Error("connect ECONNREFUSED"));
    expect(view.items.map((i) => i.kind)).toEqual(["goal"]);
    expect(view.sources).toContainEqual({ id: "ranger", ok: false, error: "connect ECONNREFUSED" });
    expect(view.systems).toContain("The ranger source is unreachable.");
    expect(view.agents.line).toBe("Agents: not connected");
  });

  it("puts running agents and today's stops on the timeline and links the item to its stop", async () => {
    const view = await compose();
    expect(view.agents.line).toBe("1 agent working, 1 waiting on you");
    const failed = view.items.find((i) => i.kind === "agent-failed");
    expect(failed?.eventKey).toBeDefined();
    expect(view.today.map((e) => e.key)).toContain(failed!.eventKey!);
    expect(view.today.some((e) => e.title === 'An agent is working on "Add the export button"')).toBe(true);
  });

  it("keeps an escalation on a node an agent is still working on, named by Ranger", async () => {
    seed({ subject_key: "state:escalation:default:example/app#7", vocab: "escalation", ref: "example/app#7", value: "needs-principal", healthy: 0 });
    const view = await compose();
    expect(view.items.filter((i) => i.title.includes("Add the export button")).map((i) => i.title)).toEqual(['"Add the export button" needs you.']);
  });

  it("ranks an item whose stop time Ranger garbled instead of producing NaN", async () => {
    const view = await compose(rangerState({ needsYou: [{ key: "k", repo: "example/app", nodeId: "12", title: "Fix the login timeout", status: "failed", endedAt: "not a date" }] }));
    expect(view.items.every((i) => Number.isFinite(i.score))).toBe(true);
  });

  it("never shows a goal id when the goal has no wording", async () => {
    seed({ subject_key: "state:goal:default:G9", ref: "G9", goal_id: "G9", value: "off-track", healthy: 0 });
    seed({ subject_key: "state:check:default:G9.sensor", vocab: "check", ref: "G9.sensor", goal_id: "G9", value: "regressed", healthy: 0 });
    const view = await compose();
    const visible = [...view.items.map((i) => `${i.title} ${i.why}`), ...view.goals.map((g) => g.text)].join(" ");
    expect(visible).not.toMatch(/\bG\d+\b/);
    expect(view.items.find((i) => i.kind === "goal")?.detail.refs).toContain("G9");
  });

  it("drops Ranger links that are not http(s)", async () => {
    const view = await compose(rangerState({
      needsYou: [{ key: "k", repo: "example/app", nodeId: "12", title: "Fix the login timeout", status: "parked", reason: { class: "blocked" }, url: "javascript:alert(1)" }],
    }));
    const blocked = view.items.find((i) => i.kind === "agent-blocked");
    expect(blocked?.detail.links).toEqual([]);
    expect(blocked?.actions[0]).toMatchObject({ id: "open", wired: false });
    expect(blocked?.actions[0]?.url).toBeUndefined();
  });

  it("files a running agent under its repo's area", async () => {
    const view = await compose();
    expect(view.today.find((e) => e.kind === "agent" && e.key.startsWith("ranger:run:"))?.area).toBe("work");
  });

  it("says it cannot see anything when no source is connected, instead of an all-clear", async () => {
    const view = await composeDesk(db, { ...DESK, rangerUrl: "" }, { enabled: false });
    expect(view.sources).toEqual([]);
    expect(view.systems[0]).toMatch(/^No source is connected/);
    expect(briefing(view, selectItems(view, "all", new Set()), null).lines[0]).toBe("The Desk cannot see anything yet: no source is connected.");
  });

  it("answers enabled:false when the Desk is turned off", async () => {
    const res = await handleGetDesk(db, { ...DESK, enabled: false }, vigil);
    expect(await res.json()).toEqual({ enabled: false });
  });
});

describe("mc.desk config", () => {
  it("defaults to an enabled Desk with no Ranger and no areas", () => {
    expect(McSchema.parse(undefined).desk).toEqual({ enabled: true, displayName: "", topN: 5, ranger: { url: "" }, areas: [] });
  });

  it("refuses a Ranger URL that is not loopback", () => {
    const result = McSchema.safeParse({ desk: { ranger: { url: "http://192.168.1.5:7311" } } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["desk", "ranger", "url"]);
  });
});
