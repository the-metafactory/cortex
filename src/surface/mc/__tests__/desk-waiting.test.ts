import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { composeDesk, type ComposeDeps, type DeskOptions } from "../desk/compose";
import { WaitingTasks, questionSummary, readWaitingTask, type WaitingTask } from "../desk/sources/waiting";
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
    const view = await compose({ waitingTasks: { read: async () => new Map<string, WaitingTask>([
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

  it("keeps source uncertainty and questions visible when Ranger also reports the task", async () => {
    seed("github:github.com/example/game#12");
    const desk = { ...DESK, rangerUrl: "http://127.0.0.1:7311" };
    const fetchImpl = async () => Response.json({ current: [], maps: [], needsYou: [{ key: "example/game#1", repo: "example/game", nodeId: "12", title: "Choose a hull", status: "blocked", reason: { class: "blocked", detail: "Approve a hull." } }] });
    const waitingTasks = { read: async () => new Map<string, WaitingTask>([["example/game#12", { kind: "unavailable", reason: "Source status could not be checked." }]]) };
    const view = await composeDesk(db, desk, { enabled: true }, { now: NOW, fetchImpl, waitingTasks });
    expect(view.items).toHaveLength(1);
    expect(view.items[0]?.why).toContain("Source status could not be checked.");
    expect(view.agents.waiting).toBe(1);
    const open = await composeDesk(db, desk, { enabled: true }, { now: NOW, fetchImpl, waitingTasks: { read: async () => new Map([["example/game#12", source("open", "Actual source title", "Approve the ring hull?")]]) } });
    expect(open.items).toHaveLength(1);
    expect(open.items[0]?.why).toBe("Approve the ring hull? In game.");
    expect(open.items[0]?.title).toBe('"Actual source title" needs you.');
    const noReport = async () => Response.json({ current: [], maps: [], needsYou: [{ key: "example/game#1", repo: "example/game", nodeId: "12", title: "Old title", status: "blocked", reason: { class: "blocked" } }] });
    const missing = await composeDesk(db, desk, { enabled: true }, { now: NOW, fetchImpl: noReport, waitingTasks: { read: async () => new Map([["example/game#12", source("open", "Actual source title")]]) } });
    expect(missing.items[0]?.why).toContain("The question is unavailable. Open the source");
    const closed = await composeDesk(db, desk, { enabled: true }, { now: NOW, fetchImpl, waitingTasks: { read: async () => new Map([["example/game#12", source("closed", "Choose a hull")]]) } });
    expect(closed.items).toHaveLength(0);
    expect(closed.agents.waiting).toBe(0);
  });

  it("keeps open requests once and explicitly states missing questions and unavailable status", async () => {
    seed("example/game#12"); seed("github:github.com/example/game#12", "second"); seed("example/game#13");
    const view = await compose({ waitingTasks: { read: async () => new Map<string, WaitingTask>([
      ["example/game#12", source("open", "Choose a hull")],
      ["example/game#13", { kind: "unavailable", reason: "Source status could not be checked." }],
    ]) } });
    expect(view.items).toHaveLength(2);
    expect(view.items.find(i => i.title.includes("Choose a hull"))?.why).toContain("The question is unavailable. Open the source");
    expect(view.items.find(i => i.title.includes("unavailable"))?.why).toContain("Source status could not be checked.");
    expect(view.agents.waiting).toBe(2);
  });
});

describe("waiting source reads", () => {
  it("extracts only explicit source questions and bounds the summary", () => {
    expect(questionSummary("## Question\n\nShould we use the ring hull?\n\nUnrelated background\n\n## Notes\nOther text")).toBe("Should we use the ring hull?");
    expect(questionSummary("## Blocking condition\n\nApprove the smaller hull export.")).toBe("Approve the smaller hull export.");
    expect(questionSummary("## Deliverable\n\nBuild a scanner.")).toBeNull();
    expect(questionSummary(null)).toBeNull();
    expect(questionSummary("Should the trader use a ring hull?")).toBe("Should the trader use a ring hull?");
    expect(questionSummary("## Question\n\nShould I approve [the export](https://example.test/export)?")).toBe("Should I approve the export?");
    expect(questionSummary("## Question\n\nShould https://example.test/export be approved?")).toBe("Should https://example.test/export be approved?");
    expect(questionSummary("## Question\n\nKeep HULL_LUMA_CALIBRATION unchanged?")).toBe("Keep HULL_LUMA_CALIBRATION unchanged?");
    expect(questionSummary(`## Decision needed\n\n${"Word ".repeat(100)}`)?.length).toBeLessThanOrEqual(300);
  });

  it("reads authoritative status with validated refs and preserves failures as uncertainty", async () => {
    const calls: unknown[] = [];
    const read: Parameters<typeof readWaitingTask>[1] = async ref => {
      calls.push(ref);
      return { type: "issue", state: "open", title: "Choose a hull", labels: [], body: "## Question\n\nShould we use the ring?", html_url: "https://github.com/example/game/issues/12" };
    };
    expect(await readWaitingTask("example/game#12", read)).toEqual(source("open", "Choose a hull", "Should we use the ring?"));
    for (const ref of ["bad/repo/extra#12", "example/game#-1", "example/game#12;touch /tmp/no", "example/game#9007199254740993"]) {
      expect((await readWaitingTask(ref, read)).kind).toBe("unavailable");
    }
    expect(calls).toEqual([{ owner: "example", repo: "game", number: 12 }]);
    expect((await readWaitingTask("example/game#12", async () => ({ kind: "not_found", message: "Missing" }))).kind).toBe("unavailable");
    expect((await readWaitingTask("example/game#12", async () => ({ type: "issue", state: "unknown", title: "x", labels: [], body: null, html_url: "https://example.test" }))).kind).toBe("unavailable");
  });

  it("deduplicates concurrent reads, refreshes status and does not retain closure after a failed refresh", async () => {
    let now = 0;
    let calls = 0;
    let task: WaitingTask = source("open", "Choose a hull");
    const reader = new WaitingTasks(async () => { calls++; return task; }, () => now);
    await Promise.all([reader.read(["example/game#12", "example/game#12"]), reader.read(["example/game#12"])]);
    expect(calls).toBe(1);
    task = source("closed", "Choose a hull"); now = 60_001;
    expect((await reader.read(["example/game#12"])).get("example/game#12")?.kind).toBe("closed");
    task = { kind: "unavailable", reason: "Source status could not be checked." }; now += 60_001;
    expect((await reader.read(["example/game#12"])).get("example/game#12")?.kind).toBe("unavailable");
    const broken = new WaitingTasks(async () => { throw new Error("offline"); });
    expect((await broken.read(["example/game#12"])).get("example/game#12")?.kind).toBe("unavailable");
  });
});
