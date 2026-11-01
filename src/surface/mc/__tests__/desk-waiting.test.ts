import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { composeDesk, type ComposeDeps, type DeskOptions } from "../desk/compose";
import { writeVigilSubject } from "../../../vigil/db";

const NOW = Date.parse("2026-11-01T06:00:00Z");
const DESK: DeskOptions = { enabled: true, displayName: "Ada", topN: 5, rangerUrl: "", areas: [], sources: [] };

const source = (state: "open" | "closed", title: string, question: string | null = null) => ({
  kind: state, title, question, url: "https://github.com/example/game/issues/12",
});

describe("waiting-task source projection", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });
  function seed(ref: string, stack = "default") {
    writeVigilSubject(db, {
      subject_key: `state:escalation:${stack}:${ref}`, subject_kind: "state", vocab: "escalation", ref,
      value: "needs-principal", healthy: 0, goal_id: null, producer: "soma", stack, run_kind: null,
      last_run_id: "run-1", last_ended_at: NOW - 86400000, last_seen_at: NOW,
    }, NOW);
  }
  const compose = (deps: ComposeDeps) => composeDesk(db, DESK, { enabled: true }, { now: NOW, ...deps });

  it("shows distinct task titles and concrete questions before opening details", async () => {
    seed("example/game#12"); seed("example/game#13");
    const view = await compose({ waitingTasks: { read: async () => new Map([
      ["example/game#12", source("open", "Choose a hull", "Should the trader use the ring hull?")],
      ["example/game#13", source("open", "Choose a scanner", "Approve the longer scanner range.")],
    ]) } });
    expect(view.items.map(i => [i.title, i.why])).toEqual([
      ['"Choose a hull" needs you.', "Should the trader use the ring hull? In game."],
      ['"Choose a scanner" needs you.', "Approve the longer scanner range. In game."],
    ]);
    expect(view.items[0]?.actions.map(a => a.label)).toEqual(["Look first", "Not now"]);
    expect(view.items[0]?.detail.links[0]?.url).toBe("https://github.com/example/game/issues/12");
    expect(view.agents.waiting).toBe(2);
  });

  it("suppresses closed tasks and all duplicate alerts without mutating observations", async () => {
    const refs = ["example/film#12", "example/game#1033", "example/game#1081"];
    for (const ref of refs) { seed(ref); seed(ref, "second"); }
    const before = db.query("SELECT * FROM vigil_subjects ORDER BY subject_key").all();
    const view = await compose({ waitingTasks: { read: async () => new Map(refs.map(ref => [ref, source("closed", "Completed task")])) } });
    expect(view.items).toEqual([]);
    expect(view.agents.waiting).toBe(0);
    expect(db.query("SELECT * FROM vigil_subjects ORDER BY subject_key").all()).toEqual(before);
  });

  it("keeps open requests once and explicitly states missing questions and unavailable status", async () => {
    seed("example/game#12"); seed("example/game#12", "second"); seed("example/game#13");
    const view = await compose({ waitingTasks: { read: async () => new Map([
      ["example/game#12", source("open", "Choose a hull")],
      ["example/game#13", { kind: "unavailable", reason: "Source status could not be checked." }],
    ]) } });
    expect(view.items).toHaveLength(2);
    expect(view.items.find(i => i.title.includes("Choose a hull"))?.why).toContain("The question is unavailable. Open the source");
    expect(view.items.find(i => i.title.includes("unavailable"))?.why).toContain("Source status could not be checked.");
    expect(view.agents.waiting).toBe(2);
  });
});
