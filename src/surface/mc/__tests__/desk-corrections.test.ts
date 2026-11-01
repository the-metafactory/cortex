import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { handleDeskCorrections, MAIL_IS_PER_MAIL } from "../api/desk-corrections";
import { composeDesk, CORRECTIONS_UNREADABLE, type DeskOptions } from "../desk/compose";
import { applyCorrections, setCorrection } from "../desk/corrections";
import { selectItems } from "../desk/present";
import type { RangerState } from "../desk/sources/ranger";
import type { DeskItem, DeskView } from "../desk/types";
import { writeVigilSubject } from "../../../vigil/db";

const NOW = Date.parse("2026-10-30T11:16:00.000Z");
const EARLIER = NOW - 3 * 3_600_000;

const DESK: DeskOptions = { enabled: true, displayName: "Ada", topN: 2, rangerUrl: "http://127.0.0.1:7311", areas: [], sources: [] };

const RANGER: RangerState = {
  current: [],
  needsYou: [{ key: "example/app#1", repo: "example/app", nodeId: "12", title: "Fix the login timeout", status: "failed", endedAt: new Date(EARLIER).toISOString(), reason: { class: "worker failed", detail: "tests failed" } }],
  maps: [{ key: "example/app#1", repo: "example/app", decisions: [{ id: "30", title: "Adopt the new date library" }], grillings: [{ id: "31", title: "Which cache should we use?" }] }],
};

const BASE = ["goal", "agent-failed", "decision", "grilling"];

const kinds = (view: DeskView): string[] => view.items.map((i) => i.kind);
const top = (view: DeskView): string[] => selectItems(view, "all", new Set()).needsYou.map((i) => i.kind);

describe("ranking corrections", () => {
  let db: Database;
  beforeEach(() => {
    db = initDatabase(":memory:");
    writeVigilSubject(db, {
      subject_key: "state:goal:default:G1", subject_kind: "state", vocab: "goal", ref: "G1", value: "off-track", healthy: 0,
      goal_id: "G1", producer: "soma", stack: "default", run_kind: null, last_run_id: "run-1", last_ended_at: EARLIER, last_seen_at: EARLIER,
    }, EARLIER);
  });
  afterEach(() => { db.close(); });

  const compose = (): Promise<DeskView> =>
    composeDesk(db, DESK, { enabled: true, resolveGoalWording: () => "Ship one release a week." }, { now: NOW, fetchImpl: async () => Response.json(RANGER) });

  const call = (method: string, query = "", body?: object): Promise<Response> => {
    const url = new URL(`http://127.0.0.1/api/desk/corrections${query}`);
    return handleDeskCorrections(new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), url, db, () => NOW);
  };

  it("ranks by the base rules when there is no correction", async () => {
    const view = await compose();
    expect(kinds(view)).toEqual(BASE);
    expect(view.corrections).toEqual([]);
  });

  it("puts items of a kind and source marked less like this below every unmarked item, and the top list changes", async () => {
    setCorrection(db, "goal", "vigil", "less", NOW);
    const view = await compose();
    expect(kinds(view)).toEqual(["agent-failed", "decision", "grilling", "goal"]);
    expect(top(view)).toEqual(["agent-failed", "decision"]);
    expect(view.items.at(-1)?.correction).toBe("less");
    expect(view.items.at(-1)?.detail.history).toContain("You asked for less like this, so it ranks below everything you have not marked.");
    expect(view.corrections).toEqual([{ kind: "goal", source: "vigil", mode: "less", label: "Goals that need a look, from vigil", createdAt: NOW }]);
  });

  it("keeps items of a kind and source marked always show this in the top list", async () => {
    setCorrection(db, "grilling", "ranger", "always", NOW);
    const view = await compose();
    expect(top(view)).toEqual(["grilling", "goal"]);
  });

  it("changes only the source it was made for, and never mail, which is corrected per mail", () => {
    const item = (kind: "goal" | "mail", n: number, source: string): DeskItem => ({
      key: `${kind}:${n}`, kind, source, area: null, urgency: "waiting", title: `Item ${n}`, why: "w", score: 50 - n, actions: [],
      detail: { summary: "s", history: [], refs: [], links: [] },
    });
    const ranked = applyCorrections([item("goal", 1, "vigil"), item("goal", 2, "other"), item("goal", 3, "vigil")], [{ kind: "goal", source: "vigil", mode: "less", label: "", createdAt: NOW }]);
    expect(ranked.map((i) => i.key)).toEqual(["goal:2", "goal:1", "goal:3"]);
    const mails = applyCorrections([item("mail", 1, "work-mail"), item("mail", 2, "home-mail")], [{ kind: "mail", source: "work-mail", mode: "less", label: "", createdAt: NOW }]);
    expect(mails.map((i) => [i.key, i.correction])).toEqual([["mail:1", undefined], ["mail:2", undefined]]);
  });

  it("refuses a new per-source correction for mail", async () => {
    const res = await call("POST", "", { kind: "mail", source: "work-mail", mode: "less" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(MAIL_IS_PER_MAIL);
  });

  it("ranks by the base rules and says so in the systems line when the store cannot be read", async () => {
    setCorrection(db, "goal", "vigil", "less", NOW);
    db.run("DROP TABLE desk_corrections");
    const view = await compose();
    expect(kinds(view)).toEqual(BASE);
    expect(view.systems).toContain(CORRECTIONS_UNREADABLE);
    expect(view.corrections).toEqual([]);
  });

  it("applies a correction through the API and undoes it back to the base ranking", async () => {
    const set = await call("POST", "", { kind: "goal", source: "vigil", mode: "less" });
    expect(set.status).toBe(200);
    expect(kinds(await compose())[0]).toBe("agent-failed");
    const flipped = await call("POST", "", { kind: "goal", source: "vigil", mode: "always" });
    expect(((await flipped.json()) as { corrections: unknown[] }).corrections).toHaveLength(1);
    const undo = await call("DELETE", "?kind=goal&source=vigil");
    expect(undo.status).toBe(200);
    expect(kinds(await compose())).toEqual(BASE);
  });

  it("refuses a correction it cannot store and an undo of nothing", async () => {
    expect((await call("POST", "", { kind: "weather", source: "vigil", mode: "less" })).status).toBe(400);
    expect((await call("POST", "", { kind: "goal", source: "vigil", mode: "never" })).status).toBe(400);
    expect((await call("POST", "", { kind: "goal", source: "../etc", mode: "less" })).status).toBe(400);
    expect((await call("DELETE", "?kind=goal&source=vigil")).status).toBe(404);
    expect((await call("PUT")).status).toBe(405);
  });
});
