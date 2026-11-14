import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { DEFAULT_SETTINGS, findNode, type AppState } from "../../../balance";
import { createDispatchTaskAbortedEvent, createDispatchTaskCompletedEvent, createDispatchTaskFailedEvent, createDispatchTaskStartedEvent } from "../../../bus/dispatch-events";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import { CortexConfigSchema } from "../../../common/types/cortex-config";
import { handleDeskTaskHandoff } from "../api/desk-task-handoff";
import { initDatabase } from "../db/init";
import { HandledLedger } from "../desk/actions";
import { loadBalanceState, saveBalanceState } from "../desk/balance-store";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import { changeMyDay, localDay } from "../desk/my-day";
import { NOT_SET_UP, STALE_PREVIEW, TASK_GONE, type TaskDispatchBus } from "../desk/task-handoff";
import { readTaskHandoff, type DispatchOptions } from "../desk/task-handoff-store";
import type { DeskView } from "../desk/types";
import { project } from "../projection/dispatch-lifecycle-renderer";

const NOW = Date.parse("2026-11-14T09:00:00.000Z");
const SOURCE = { principal: "ada", agent: "cortex", instance: "local" };
const DISPATCH: DispatchOptions = {
  agents: [{ id: "luna", label: "Luna", policy: "cloud" }, { id: "scout", label: "Scout", policy: "local" }],
  startTimeoutSeconds: 120,
  runTimeoutMinutes: 60,
};
const leaf = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, weight: 50, ordering: "parallel" as const, children: [], effort: 1 as const, ...extra });
const seed = (): AppState => ({
  outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [
    { id: "area:lab", title: "Lab", weight: 50, ordering: "parallel", children: [
      leaf("t1", "Draft the engine notes", { note: "Use the Friday numbers.", dueDate: "2026-11-20" }),
      { id: "proj", title: "Engines", weight: 50, ordering: "parallel", children: [leaf("t3", "Order parts")] },
    ] },
    { id: "area:private", title: "Private", weight: 50, ordering: "parallel", children: [leaf("p1", "Book the dentist")] },
  ] },
  settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null,
});

let db: Database;
let options: DeskOptions;
let runtime: DeskRuntime;
let published: { envelope: Envelope; subject: string }[];
let busDown: string | null;
let ids: number;

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bus: TaskDispatchBus = {
  principal: "ada", stack: "home",
  publish: async (envelope, subject) => {
    if (busDown) throw new Error(busDown);
    published.push({ envelope, subject });
  },
};
const act = async (body: unknown, at = NOW): Promise<{ status: number; json: Record<string, unknown> }> => {
  const res = await handleDeskTaskHandoff(new Request("http://localhost/api/desk/task-handoff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), db, runtime, { now: () => at, newId: () => uuid(900 + ids++) });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
};
const preview = async (taskId: string, extra: Record<string, unknown> = {}) => (await act({ action: "preview", taskId, ...extra })).json.preview as { brief: string; briefHash: string; leaves: string; agent: { id: string }; agents: { id: string }[] };
const hand = async (taskId: string, requestId = uuid(1), extra: Record<string, unknown> = {}) => {
  const seen = await preview(taskId, extra);
  return act({ action: "hand", requestId, taskId, agent: seen.agent.id, briefHash: seen.briefHash, ...extra });
};
const compose = async (at = NOW): Promise<DeskView> => composeDesk(db, options, undefined, { now: at, handled: runtime.ledger });
const attemptOf = (n = published.length - 1): string => {
  const id = published[n]?.envelope.correlation_id;
  if (!id) throw new Error("no published attempt");
  return id;
};
const feed = (envelope: Envelope): void => { project(db, envelope, "local.ada.home.dispatch.task.x", undefined); };
const lifecycle = { source: SOURCE, taskId: "", agentId: "luna", startedAt: new Date(NOW) };
const started = (attempt: string) => createDispatchTaskStartedEvent({ ...lifecycle, taskId: attempt, correlationId: attempt });
const completed = (attempt: string, text: string) => createDispatchTaskCompletedEvent({ ...lifecycle, taskId: attempt, correlationId: attempt, completedAt: new Date(NOW), resultSummary: text.split("\n")[0] ?? "", chatResponse: text });

beforeEach(() => {
  db = initDatabase(":memory:");
  saveBalanceState(db, seed());
  published = [];
  busDown = null;
  ids = 0;
  options = {
    enabled: true, displayName: "Ada", topN: 5, rangerUrl: "", sources: [], dispatch: DISPATCH,
    areas: [{ id: "lab", label: "Lab", color: "", repos: [], goals: [], policy: "cloud" }, { id: "private", label: "Private", color: "", repos: [], goals: [], policy: "local" }],
  };
  runtime = { options, ledger: new HandledLedger(), dispatch: bus };
});
afterEach(() => { db.close(); });

describe("Preview a task hand-off", () => {
  it("returns the exact brief, its hash and what leaves the Desk, and writes nothing", async () => {
    const res = await act({ action: "preview", taskId: "t1", instruction: "Keep it short." });
    expect(res.status).toBe(200);
    const shown = res.json.preview as { task: unknown; agent: unknown; agents: unknown; brief: string; briefHash: string; leaves: string };
    expect(shown.task).toEqual({ id: "t1", title: "Draft the engine notes", area: "lab", dueDate: "2026-11-20" });
    expect(shown.agent).toEqual({ id: "luna", label: "Luna" });
    expect(shown.agents).toEqual(DISPATCH.agents);
    expect(shown.brief).toContain("Task: Draft the engine notes\nArea: Lab\nDue: 2026-11-20\nNotes:\nUse the Friday numbers.\nInstruction: Keep it short.");
    expect(shown.briefHash).toBe(createHash("sha256").update(shown.brief).digest("hex"));
    expect(shown.leaves).toBe("The title, area, notes, due date and your instruction go to Luna, which runs on a cloud model.");
    expect(published).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM desk_task_handoffs").get()).toEqual({ n: 0 });
  });

  it("defaults a local-policy task to a local agent and offers only local agents", async () => {
    const shown = await preview("p1");
    expect(shown.agent.id).toBe("scout");
    expect(shown.agents.map((a) => a.id)).toEqual(["scout"]);
    expect(shown.leaves).toBe("The title and area go to Scout, which runs on a local model.");
  });
});

describe("Hand a task to an agent", () => {
  it("publishes one signed direct task with the attempt id as correlation id, and a repeat answers the first receipt", async () => {
    const first = await hand("t1");
    expect(first).toEqual({ status: 200, json: { ok: true, id: uuid(1), message: "Handed to Luna. The result comes back here as a card." } });
    expect(published).toHaveLength(1);
    const sent = published[0];
    expect(sent?.subject).toBe("local.ada.home.tasks.@did-mf-luna.desk-task");
    expect(sent?.envelope.type).toBe("tasks.desk-task");
    expect(sent?.envelope.target_assistant).toBe("did:mf:luna");
    expect(sent?.envelope.source).toBe("ada.home.desk");
    expect(sent?.envelope.sovereignty).toMatchObject({ classification: "local", frontier_ok: true, model_class: "any" });
    const attempt = attemptOf();
    expect(sent?.envelope.payload.task_id).toBe(attempt);
    expect(Object.keys(sent?.envelope.payload ?? {}).sort()).toEqual(["agent_id", "agent_name", "prompt", "task_id"]);
    expect(sent?.envelope.payload.prompt).toBe(readTaskHandoff(db, uuid(1))?.brief);
    const again = await act({ action: "hand", requestId: uuid(1), taskId: "t1", agent: "luna", briefHash: "0".repeat(64) });
    expect(again.json.message).toBe("Handed to Luna. The result comes back here as a card.");
    expect(published).toHaveLength(1);
  });

  it("refuses a stale preview and publishes nothing", async () => {
    const seen = await preview("t1");
    const state = loadBalanceState(db);
    const node = state ? findNode(state.outline, "t1") : null;
    if (!state || !node) throw new Error("seed missing");
    node.note = "Use the Monday numbers.";
    saveBalanceState(db, state);
    expect(await act({ action: "hand", requestId: uuid(1), taskId: "t1", agent: "luna", briefHash: seen.briefHash })).toEqual({ status: 409, json: { ok: false, error: STALE_PREVIEW } });
    expect(published).toEqual([]);
  });

  it("labels a local agent's task local-only, and Retry re-checks the area policy before sending again", async () => {
    await hand("p1");
    expect(published[0]?.envelope.sovereignty).toMatchObject({ frontier_ok: false, model_class: "local-only" });
    busDown = "no responders";
    await hand("t1", uuid(2));
    busDown = null;
    options.areas = options.areas.map((area) => ({ ...area, policy: "local" as const }));
    expect((await act({ action: "retry", requestId: uuid(3), id: uuid(2) })).json.error).toBe("This task's area allows only a local model, and Luna runs on a cloud model.");
    expect(published).toHaveLength(1);
    expect(readTaskHandoff(db, uuid(2))?.state).toBe("failed");
  });

  it("answers each refusal with its sentence", async () => {
    expect((await act({ action: "preview", taskId: "t1", agent: "echo" })).json.error).toBe("echo does not take Desk tasks on this stack.");
    expect((await act({ action: "preview", taskId: "p1", agent: "luna" })).json.error).toBe("This task's area allows only a local model, and Luna runs on a cloud model.");
    expect((await act({ action: "preview", taskId: "gone" })).json.error).toBe(TASK_GONE);
    expect((await act({ action: "preview", taskId: "proj" })).json.error).toBe(TASK_GONE);
    await hand("t1");
    expect((await hand("t1", uuid(2))).json.error).toBe("Luna is already working on this task.");
    expect((await act({ action: "hand", taskId: "t1" })).status).toBe(400);
    runtime = { options, ledger: new HandledLedger() };
    expect(await act({ action: "preview", taskId: "t1" })).toEqual({ status: 409, json: { ok: false, error: NOT_SET_UP } });
  });

  it("keeps a task the bus refused as failed, and Retry sends a fresh attempt whose answer counts while the old one's does not", async () => {
    busDown = "no responders";
    expect(await hand("t1")).toEqual({ status: 502, json: { ok: false, error: "The task did not reach the bus: no responders. Nothing started; try again." } });
    const failed = (await compose()).items.find((i) => i.key === `handoff:${uuid(1)}`);
    expect(failed?.title).toBe("Luna could not finish “Draft the engine notes”");
    expect(failed?.actions.map((a) => a.id)).toEqual(["task.retry", "task.discard"]);
    const old = readTaskHandoff(db, uuid(1))?.attempt ?? "";
    busDown = null;
    expect((await act({ action: "hand", requestId: uuid(1), taskId: "t1", agent: "luna", briefHash: "0".repeat(64) })).status).toBe(502);
    expect(published).toEqual([]);
    expect((await act({ action: "retry", requestId: uuid(2), id: uuid(1) })).json.message).toBe("Luna tries again. The result comes back here as a card.");
    expect(published).toHaveLength(1);
    const fresh = attemptOf();
    expect(fresh).not.toBe(old);
    feed(completed(old, "A stale answer."));
    expect(readTaskHandoff(db, uuid(1))?.state).toBe("working");
    feed(completed(fresh, "Drafted the notes.\nSee the shared folder."));
    expect(readTaskHandoff(db, uuid(1))?.result).toBe("Drafted the notes.\nSee the shared folder.");
  });
});

describe("While the agent works and when it is done", () => {
  it("moves through started, completed, failed and aborted by correlation id", async () => {
    await hand("t1");
    expect((await compose()).myDay?.handoffs).toEqual({ t1: { state: "working", line: "Sent to Luna, waiting for it to start" } });
    feed(started(attemptOf()));
    const working = await compose();
    expect(working.myDay?.handoffs?.t1?.line).toMatch(/^With Luna since \d\d:\d\d$/);
    expect(working.agents.working.map((w) => w.title)).toEqual(["Draft the engine notes"]);
    feed(completed(attemptOf(), "Drafted the notes."));
    const ready = (await compose()).items.find((i) => i.key === `handoff:${uuid(1)}`);
    expect(ready?.kind).toBe("task-handoff");
    expect(ready?.excerpt).toBe("Drafted the notes.");
    expect(ready?.handoff?.brief).toContain("Task: Draft the engine notes");
    expect(ready?.actions.map((a) => a.id)).toEqual(["task.done", "task.keep", "task.discard"]);

    await hand("p1", uuid(2));
    feed(createDispatchTaskFailedEvent({ ...lifecycle, agentId: "scout", taskId: attemptOf(), correlationId: attemptOf(), failedAt: new Date(NOW), errorSummary: "The model lane is down." }));
    expect(readTaskHandoff(db, uuid(2))).toMatchObject({ state: "failed", error: "The model lane is down." });
    await act({ action: "retry", requestId: uuid(3), id: uuid(2) });
    feed(createDispatchTaskAbortedEvent({ ...lifecycle, agentId: "scout", taskId: attemptOf(), correlationId: attemptOf(), abortedAt: new Date(NOW), reason: "inactivity timeout" }));
    expect(readTaskHandoff(db, uuid(2))).toMatchObject({ state: "failed", error: "inactivity timeout" });
  });

  it("fails a hand-off nobody starts, and one that sends no result in time", async () => {
    await hand("t1");
    await compose(NOW + 119_000);
    expect(readTaskHandoff(db, uuid(1))?.state).toBe("working");
    await compose(NOW + 120_000);
    expect(readTaskHandoff(db, uuid(1))?.error).toBe("Nobody picked it up within 2 minutes. Is Luna running?");
    await act({ action: "retry", requestId: uuid(2), id: uuid(1) }, NOW + 130_000);
    project(db, started(attemptOf()), undefined, undefined);
    const startedAt = readTaskHandoff(db, uuid(1))?.startedAt ?? 0;
    await compose(startedAt + 60 * 60_000);
    expect(readTaskHandoff(db, uuid(1))?.error).toBe("No result arrived within 60 minutes.");
  });

  it("Done completes the task with an undo receipt that reopens it; Keep open leaves it open", async () => {
    await hand("t1");
    feed(completed(attemptOf(), "Drafted the notes."));
    const done = await act({ action: "accept", id: uuid(1), done: true, requestId: uuid(2) });
    expect(done.json).toEqual({ ok: true, message: "Marked “Draft the engine notes” done and closed the card.", receipt: uuid(2) });
    expect(findNode(loadBalanceState(db)?.outline ?? seed().outline, "t1")?.done).toBe(true);
    expect((await act({ action: "accept", id: uuid(1), done: true, requestId: uuid(2) })).json).toEqual(done.json);
    expect((await compose()).items.some((i) => i.kind === "task-handoff")).toBe(false);
    changeMyDay({ db, desk: options, now: NOW, date: localDay(NOW), requestId: crypto.randomUUID(), command: { op: "undo", receipt: uuid(2) } });
    expect(findNode(loadBalanceState(db)?.outline ?? seed().outline, "t1")?.done).toBeUndefined();

    await hand("p1", uuid(3));
    feed(completed(attemptOf(), "Booked for Tuesday."));
    expect((await act({ action: "accept", id: uuid(3), done: false, requestId: uuid(4) })).json).toEqual({ ok: true, message: "Closed the card. “Book the dentist” stays open." });
    expect(findNode(loadBalanceState(db)?.outline ?? seed().outline, "p1")?.done).toBeUndefined();
  });

  it("Discard while working stops waiting and drops the late answer", async () => {
    await hand("t1");
    expect((await act({ action: "discard", id: uuid(1) })).json.message).toBe("Stopped waiting. Luna may still finish; its answer is dropped.");
    feed(completed(attemptOf(), "Too late."));
    expect(readTaskHandoff(db, uuid(1))?.state).toBe("discarded");
    const view = await compose();
    expect(view.items.some((i) => i.kind === "task-handoff")).toBe(false);
    expect(view.myDay?.handoffs).toEqual({});
  });
});

describe("mc.desk.dispatch config", () => {
  const base = { principal: { id: "ada" }, agents: [{ id: "luna", displayName: "Luna", persona: "./luna.md", presence: {} }], claude: {} };
  it("accepts configured agents with defaults and rejects an id that names no agent", () => {
    const parsed = CortexConfigSchema.parse({ ...base, mc: { desk: { dispatch: { agents: [{ id: "luna", policy: "cloud" }] } } } });
    expect(parsed.mc.desk.dispatch).toEqual({ agents: [{ id: "luna", policy: "cloud" }], startTimeoutSeconds: 120, runTimeoutMinutes: 60 });
    const unknown = CortexConfigSchema.safeParse({ ...base, mc: { desk: { dispatch: { agents: [{ id: "scout", policy: "local" }] } } } });
    expect(unknown.success).toBe(false);
    expect(unknown.error?.issues.map((i) => i.path.join("."))).toContain("mc.desk.dispatch.agents.0.id");
    expect(CortexConfigSchema.safeParse({ ...base, mc: { desk: { dispatch: { agents: [{ id: "luna", policy: "cloud" }], startTimeoutSeconds: 5 } } } }).success).toBe(false);
  });
});
