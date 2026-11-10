import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_SETTINGS, findNode, rankAll, type AppState, type OutlineNode } from "../../../balance";
import { handleDeskMyDay } from "../api/desk-my-day";
import { initDatabase } from "../db/init";
import { HandledLedger } from "../desk/actions";
import { balanceDetails, type BalanceCommand } from "../desk/balance-command";
import { loadBalanceState, saveBalanceState } from "../desk/balance-store";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import { localDay, readMyDay, type MyDayView } from "../desk/my-day";
import { syncStudioBalance } from "../desk/studio-my-day";
import { SourceCache } from "../desk/sources/command";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { balanceMatches, DeskBalance, visibleNode } from "../dashboard-v2/components/desk-balance";
import { balanceDrop, balanceMovable, dropZone, positionChoices } from "../dashboard-v2/lib/balance-drop";
import { balanceItemSearch, balanceSearch, readBalanceLocation } from "../dashboard-v2/hooks/use-balance-location";
import { DeskTimeFirst } from "../dashboard-v2/components/desk-time-first";
import { balanceEntries, detailsCommand, moveCommand } from "../dashboard-v2/components/desk-task-details";
import { submitMyDay } from "../dashboard-v2/lib/desk-my-day-action";
import { STALE_OUTLINE } from "../desk/balance-outline";

const NOW = new Date(2026, 10, 1, 10).getTime();
const DATE = localDay(NOW);
const desk: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", sources: [], areas: [{ id: "work", label: "Work", color: "", repos: [], goals: [] }, { id: "personal", label: "Personal", color: "", repos: [], goals: [] }] };
const task = (id: string): OutlineNode => ({ id, title: id, weight: 50, ordering: "parallel", children: [], effort: 1 });
const seed = (): AppState => ({ outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [
  { id: "area:work", title: "Work", weight: 60, ordering: "parallel", children: [{ ...task("project"), children: [task("first"), task("second")] }, task("standalone")] },
  { id: "area:personal", title: "Personal", weight: 40, ordering: "parallel", children: [task("other")] },
] }, log: [], settings: { ...DEFAULT_SETTINGS }, dayState: null, history: { deficits: {}, lastSurfaced: {} } });
function required(view: MyDayView, id: string): OutlineNode {
  const node = findNode(view.outline, id);
  if (!node) throw new Error(`Missing fixture ${id}`);
  return node;
}

describe("Balance through the real My day owner", () => {
  let db: Database;
  let runtime: DeskRuntime & { options: DeskOptions };
  const directories: string[] = [];
  beforeEach(() => { db = initDatabase(":memory:"); saveBalanceState(db, seed()); runtime = { options: desk, ledger: new HandledLedger() }; });
  afterEach(async () => { db.close(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
  const view = () => readMyDay(db, runtime.options, NOW);
  const post = (command: unknown, requestId = crypto.randomUUID()) => handleDeskMyDay(new Request("http://localhost/api/desk/my-day", { method: "POST", body: JSON.stringify({ date: DATE, requestId, command }) }), db, runtime, undefined, NOW);
  const change = async (command: BalanceCommand): Promise<{ view: MyDayView; notice?: string; outlineId?: string }> => {
    const response = await post(command);
    if (response.status !== 200) throw new Error(await response.text());
    const reply = z.object({ notice: z.string().optional(), outlineId: z.string().optional() }).parse(await response.json());
    return { view: view(), ...(reply.notice ? { notice: reply.notice } : {}), ...(reply.outlineId ? { outlineId: reply.outlineId } : {}) };
  };
  const edit = (current: MyDayView, id: string, patch: Partial<ReturnType<typeof balanceDetails>> = {}, yes = false): BalanceCommand => ({ op: "outline-edit", id, revision: current.revision, details: { ...balanceDetails(required(current, id), DATE), ...patch }, yes });

  test("persists all metadata in the existing SQLite outline and exposes the same optional estimate to My day", async () => {
    const dir = await mkdtemp(join(tmpdir(), "balance-persist-")); directories.push(dir);
    db.close(); db = initDatabase(join(dir, "mc.sqlite")); saveBalanceState(db, seed());
    const current = view();
    const before = rankAll(loadBalanceState(db) ?? seed(), DATE).map(item => [item.task.id, item.score]);
    expect(required(current, "first").estimateMinutes).toBeUndefined();
    await change(edit(current, "first", { note: "A small local sketch", estimateMinutes: 23 }));
    expect(rankAll(loadBalanceState(db) ?? seed(), DATE).map(item => [item.task.id, item.score])).toEqual(before);
    db.close(); db = initDatabase(join(dir, "mc.sqlite"));
    const restored = view();
    expect(required(restored, "first")).toMatchObject({ note: "A small local sketch", estimateMinutes: 23 });
    expect(restored.items.find(item => item.task.id === "first")?.task.estimateMinutes).toBe(23);
    expect(required(restored, "second").estimateMinutes).toBeUndefined();
    await change(edit(restored, "first", { estimateMinutes: null, context: "Sketching", dueDate: "2026-11-05", effort: 4 }));
    expect(required(view(), "first")).toMatchObject({ context: "Sketching", dueDate: "2026-11-05", effort: 4 });
    expect(required(view(), "first").estimateMinutes).toBeUndefined();
  });
  test("creates full task details atomically and rejects invalid creation fields", async () => {
    const current = view();
    const before = loadBalanceState(db);
    const fields = { op: "outline-add", revision: current.revision, parent: "first", title: "Full task", weight: 73, note: "Bring the form", dueDate: "2026-11-05", context: "Office", effort: 4, estimateMinutes: 25 } as const;
    for (const patch of [{ weight: 101 }, { effort: 3 }, { estimateMinutes: 0 }, { estimateMinutes: 1.5 }]) {
      expect((await post({ ...fields, ...patch })).status).toBe(400);
      expect(loadBalanceState(db)).toEqual(before);
    }
    const added = await change(fields);
    expect(required(added.view, "first").children).toHaveLength(1);
    expect(required(added.view, added.outlineId ?? "")).toMatchObject({ title: "Full task", weight: 73, note: "Bring the form", dueDate: "2026-11-05", context: "Office", effort: 4, estimateMinutes: 25 });
    const minimal = await change({ op: "outline-add", revision: added.view.revision, parent: "first", title: "Defaults" });
    expect(required(minimal.view, minimal.outlineId ?? "")).toMatchObject({ title: "Defaults", weight: 50, effort: 1 });
    expect(required(minimal.view, minimal.outlineId ?? "").estimateMinutes).toBeUndefined();
  });
  test("rejects invalid estimates at the HTTP boundary without changing stored state", async () => {
    const current = view();
    const before = JSON.stringify(loadBalanceState(db));
    for (const estimateMinutes of [0, -1, 1.5, "20"]) {
      const command = { ...edit(current, "first"), details: { ...balanceDetails(required(current, "first"), DATE), estimateMinutes } };
      expect((await post(command)).status).toBe(400);
    }
    expect(JSON.stringify(loadBalanceState(db))).toBe(before);
  });
  test("refuses a stale Day completion after its confirmed leaf becomes a project without creating credit", async () => {
    expect((await post({ op: "start", ids: ["first", "standalone"] })).status).toBe(200);
    const current = view();
    const added = await change({ op: "outline-add", revision: current.revision, parent: "first", title: "Unfinished new child" });
    const before = loadBalanceState(db);
    const beforeMeta = db.query("SELECT data FROM desk_my_day WHERE id = 1").get();
    const response = await post({ op: "done", id: "first" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Only a task without subtasks can receive completion credit. Refresh My day to see its current state." });
    expect(loadBalanceState(db)).toEqual(before);
    expect(db.query("SELECT data FROM desk_my_day WHERE id = 1").get()).toEqual(beforeMeta);
    expect(view().items.map(item => item.task.id)).toEqual(["standalone", added.outlineId ?? ""]);
    expect(required(view(), "first").children[0]?.done).toBeUndefined();
  });
  test("adds a new task to a day with room, moves without replacing the confirmed day, and rejects cycles and unavailable parents atomically", async () => {
    expect((await post({ op: "start", ids: ["first", "standalone"] })).status).toBe(200);
    let current = view();
    current = (await change({ op: "outline-add", revision: current.revision, parent: "first", title: "A new child" })).view;
    const child = required(current, "first").children[0];
    if (!child) throw new Error("Missing created child");
    expect(loadBalanceState(db)?.dayState?.confirmed).toEqual(["first", "standalone", child.id]);
    expect(current.items.map(item => item.task.id)).toEqual(["standalone", child.id]);
    const before = loadBalanceState(db)?.dayState;
    const result = await change({ op: "outline-move", revision: current.revision, id: child.id, parent: "area:personal" });
    expect(required(result.view, "area:personal").children.some(node => node.id === child.id)).toBe(true);
    expect(loadBalanceState(db)?.dayState).toEqual(before);
    const saved = JSON.stringify(loadBalanceState(db));
    for (const parent of ["project", "second", "missing"]) {
      expect((await post({ op: "outline-move", revision: result.view.revision, id: "project", parent })).status).toBe(409);
      expect(JSON.stringify(loadBalanceState(db))).toBe(saved);
    }
    const removedArea = { ...desk, areas: desk.areas.filter(area => area.id !== "personal") };
    runtime = { ...runtime, options: removedArea };
    expect((await post({ op: "outline-move", revision: view().revision, id: "second", parent: "area:personal" })).status).toBe(409);
  });
  test("a move with a position reorders within its parent and places the item among a new parent's children", async () => {
    let current = view();
    current = (await change({ op: "outline-move", revision: current.revision, id: "second", parent: "project", index: 0 })).view;
    expect(required(current, "project").children.map(node => node.id)).toEqual(["second", "first"]);
    current = (await change({ op: "outline-move", revision: current.revision, id: "standalone", parent: "area:personal", index: 0 })).view;
    expect(required(current, "area:personal").children.map(node => node.id)).toEqual(["standalone", "other"]);
    current = (await change({ op: "outline-move", revision: current.revision, id: "first", parent: "area:personal", index: 99 })).view;
    expect(required(current, "area:personal").children.map(node => node.id)).toEqual(["standalone", "other", "first"]);
    expect((await post({ op: "outline-move", revision: current.revision, id: "second", parent: "project", index: -1 })).status).not.toBe(200);
    const atEnd = moveCommand({ id: "standalone", parent: "area:personal", index: null, revision: current.revision, date: DATE }, current.outline);
    current = (await change(atEnd)).view;
    expect(required(current, "area:personal").children.map(node => node.id)).toEqual(["other", "first", "standalone"]);
  });
  test("a drop resolves to a parent and position, and refuses areas, the item itself and its descendants", () => {
    const outline = seed().outline;
    const none = new Set<string>();
    expect(balanceDrop(outline, "standalone", "first", "before", new Set(["standalone"]))).toBeNull();
    expect([balanceMovable(outline, "area:work", none), balanceMovable(outline, "studio-response:x", none), balanceMovable(outline, "project", none)]).toEqual([false, false, true]);
    expect(balanceDrop(outline, "standalone", "first", "before", none)).toEqual({ parent: "project", index: 0 });
    expect(balanceDrop(outline, "standalone", "first", "after", none)).toEqual({ parent: "project", index: 1 });
    expect(balanceDrop(outline, "first", "second", "after", none)).toEqual({ parent: "project", index: 1 });
    expect(balanceDrop(outline, "second", "first", "before", none)).toEqual({ parent: "project", index: 0 });
    expect(balanceDrop(outline, "standalone", "other", "inside", none)).toEqual({ parent: "other" });
    expect(balanceDrop(outline, "standalone", "area:personal", "inside", none)).toEqual({ parent: "area:personal" });
    expect(balanceDrop(outline, "standalone", "area:personal", "before", none)).toBeNull();
    expect(balanceDrop(outline, "area:work", "other", "inside", none)).toBeNull();
    expect(balanceDrop(outline, "project", "first", "inside", none)).toBeNull();
    expect(balanceDrop(outline, "project", "project", "after", none)).toBeNull();
    expect([dropZone(2, 40), dropZone(20, 40), dropZone(38, 40)]).toEqual(["before", "inside", "after"]);
    expect(positionChoices(outline, "first", "project")).toEqual([{ index: 0, title: "second" }]);
  });
  test("hide completed drops done tasks and closed projects from the tree, and the page offers the toggle", async () => {
    const done = { ...task("done"), done: true };
    const closed = { ...task("closed"), done: true, children: [task("inner")] };
    expect([done, closed, task("open")].map(node => visibleNode(node, "", true))).toEqual([false, false, true]);
    expect(visibleNode(done, "", false)).toBe(true);
    const composed = await composeDesk(db, desk, undefined, { now: NOW });
    if (!composed.myDay) throw new Error("Missing My day view");
    const html = renderToStaticMarkup(createElement(DeskBalance, { day: composed.myDay, view: composed, foreground: { kind: "unavailable", reason: "Not yet measured" }, onChanged: () => undefined, onThread: () => undefined }));
    expect(html).toContain("Hide completed");
    expect(html).toContain('title="Drag to move"');
  });
  test("re-runs an engine-proposed day when a new task is added", async () => {
    const current = view();
    const saved = await change({ op: "outline-add", revision: current.revision, parent: "area:work", title: "A later choice" });
    expect(saved.view.items.map(item => item.task.id)).toContain(saved.outlineId ?? "");
    expect(view().items.map(item => item.task.id)).toEqual(saved.view.items.map(item => item.task.id));
    expect(loadBalanceState(db)?.dayState).toBeNull();
  });
  test("preserves drafts by refusing stale writes, and replays only the identical request payload", async () => {
    const stale = view();
    const command = edit(stale, "first", { note: "Saved once" });
    const requestId = crypto.randomUUID();
    expect((await post(command, requestId)).status).toBe(200);
    const before = JSON.stringify(loadBalanceState(db));
    expect((await post(edit(stale, "first", { note: "Stale draft" }))).status).toBe(409);
    expect(JSON.stringify(loadBalanceState(db))).toBe(before);
    expect((await post(command, requestId)).status).toBe(200);
    expect((await post(edit(stale, "first", { note: "Different payload" }), requestId)).status).toBe(409);
    expect(required(view(), "first").note).toBe("Saved once");
  });
  test("stable reads keep revision stable while configured-area changes invalidate an old edit and permit receipt replay", async () => {
    const first = view();
    expect(view().revision).toBe(first.revision);
    const command = edit(first, "first", { note: "Retained" });
    const requestId = crypto.randomUUID();
    expect((await post(command, requestId)).status).toBe(200);
    const previous = view();
    runtime = { ...runtime, options: { ...desk, areas: desk.areas.map(area => ({ ...area, label: `${area.label} updated` })) } };
    expect((await post(edit(previous, "first", { note: "Old view" }))).status).toBe(409);
    expect(required(readMyDay(db, desk, NOW), "first").note).toBe("Retained");
    const refreshed = view();
    expect(refreshed.revision).toBeGreaterThan(previous.revision);
    expect(view().revision).toBe(refreshed.revision);
    expect((await post(command, requestId)).status).toBe(200);
    expect(required(view(), "first").note).toBe("Retained");
  });
  test("add replay returns the same authoritative item and reconciliation notice after later changes", async () => {
    expect((await post({ op: "start", ids: ["first", "standalone"] })).status).toBe(200);
    const command = { op: "outline-add", parent: "first", title: "Owned child", revision: view().revision };
    const requestId = crypto.randomUUID();
    const receipt = z.object({ outlineId: z.uuid(), notice: z.string() });
    const first = receipt.parse(await (await post(command, requestId)).json());
    expect(first.notice).toContain("first is no longer actionable");
    await change(edit(view(), "second", { note: "Another saved change" }));
    const replay = receipt.parse(await (await post(command, requestId)).json());
    expect(replay).toEqual(first);
    expect(required(view(), "first").children.map(node => node.id)).toEqual([first.outlineId]);
    expect(loadBalanceState(db)?.dayState?.confirmed).toEqual(["first", "standalone", first.outlineId]);
    const staleDate = new Request("http://localhost/api/desk/my-day", { method: "POST", body: JSON.stringify({ date: DATE, requestId: crypto.randomUUID(), command: { op: "outline-edit", id: "second", revision: view().revision, details: balanceDetails(required(view(), "second"), DATE), yes: false } }) });
    expect((await handleDeskMyDay(staleDate, db, runtime, undefined, NOW + 86_400_000)).status).toBe(409);
  });
  test("preserves the Yes-filter and three-project focus limit and child ordering", async () => {
    const state = seed();
    const area = state.outline.children[0];
    if (!area) throw new Error("Missing area");
    area.children = Array.from({ length: 4 }, (_, index) => ({ ...task(`p${index}`), children: [task(`leaf${index}`)] }));
    saveBalanceState(db, state);
    expect((await post(edit(view(), "p0", { focus: true }))).status).toBe(409);
    for (const id of ["p0", "p1", "p2"]) await change(edit(view(), id, { focus: true, ordering: "sequential" }, true));
    expect((await post(edit(view(), "p3", { focus: true }, true))).status).toBe(409);
    expect(required(view(), "p0").ordering).toBe("sequential");
    expect(required(view(), "p3").focusMonth).toBeUndefined();
  });
  test("branch close creates no leaf credits; leaf completion and same-day reopen never duplicate credit", async () => {
    let result = await change({ op: "outline-complete", id: "project", revision: view().revision, confirm: true });
    expect(loadBalanceState(db)?.log).toHaveLength(0);
    expect(required(result.view, "first").done).toBeUndefined();
    result = await change({ op: "outline-reopen", id: "project", revision: result.view.revision, confirm: true });
    result = await change({ op: "outline-complete", id: "first", revision: result.view.revision, confirm: true });
    expect(loadBalanceState(db)?.log).toHaveLength(1);
    result = await change({ op: "outline-reopen", id: "first", revision: result.view.revision, confirm: true });
    result = await change({ op: "outline-complete", id: "first", revision: result.view.revision, confirm: true });
    expect(required(result.view, "first").done).toBe(true);
    expect(loadBalanceState(db)?.log).toHaveLength(1);
  });
  for (const operation of ["outline-move", "outline-remove"] as const) test(`${operation} preserves monthly focus by refusing to remove its project's last child`, async () => {
    const state = seed();
    const project = findNode(state.outline, "project");
    if (!project) throw new Error("Missing focus project");
    project.children = [task("only-child")];
    project.focusMonth = DATE.slice(0, 7);
    saveBalanceState(db, state);
    const before = JSON.stringify(loadBalanceState(db));
    const revision = view().revision;
    const command = operation === "outline-move" ? { op: operation, id: "only-child", parent: "area:personal", revision } : { op: operation, id: "only-child", confirm: true, revision };
    const refused = await post(command);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("monthly focus");
    expect(JSON.stringify(loadBalanceState(db))).toBe(before);
    expect((await post({ op: "outline-move", id: "only-child", parent: "project", revision })).status).toBe(200);
    await change(edit(view(), "project", { focus: false }));
    expect((await post({ ...command, revision: view().revision })).status).toBe(200);
  });
  test("keeps real source attribution through filing into a task-turned-project and moving", async () => {
    const options = { ...desk, sources: [{ id: "mail", command: ["fixture"], everySeconds: 300, timeoutSeconds: 5 }] };
    const cache = new SourceCache(() => Promise.resolve(JSON.stringify({ items: [{ kind: "mail", id: "owned", from: { address: "person@example.test" }, subject: "A source-linked task", receivedAt: new Date(NOW).toISOString(), unread: true, dueAt: "2026-11-04", url: "https://example.test/owned" }] })));
    runtime = { options, ledger: new HandledLedger(), sourceCache: cache };
    await change({ op: "outline-add", parent: "standalone", title: "Manual child", revision: view().revision });
    const item = (await composeDesk(db, options, undefined, { now: NOW, sourceCache: cache })).items[0];
    if (!item?.todoFingerprint) throw new Error("Missing source fixture");
    expect((await post({ op: "todo", key: item.key, fingerprint: item.todoFingerprint })).status).toBe(200);
    const intake = view().inbox[0];
    if (!intake) throw new Error("Missing source intake");
    expect((await post({ op: "outline-file", id: intake.id, parent: "other", revision: view().revision })).status).toBe(409);
    expect(view().inbox).toHaveLength(1);
    const file = { op: "outline-file", id: intake.id, parent: "standalone", revision: view().revision };
    const requestId = crypto.randomUUID();
    const dayIds = view().items.map(task => task.task.id);
    expect((await post({ op: "draft", ids: dayIds })).status).toBe(200);
    file.revision = view().revision;
    expect((await post(file, requestId)).status).toBe(200);
    expect((await post(file, requestId)).status).toBe(200);
    expect(view().inbox).toHaveLength(0);
    expect(view().items.map(task => task.task.id)).toEqual(dayIds);
    const originalSources = view().sources;
    await change({ op: "outline-move", id: intake.id, parent: "area:personal", revision: view().revision });
    expect(view().sources).toEqual(originalSources);
    expect(required(view(), intake.id).dueDate).toBe("2026-11-04");
    expect((await post({ op: "outline-remove", id: intake.id, revision: view().revision, confirm: true })).status).toBe(409);
  });
  test("Studio source changes advance the revision and retain source-owned titles, moves and completion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "balance-studio-")); directories.push(dir);
    await mkdir(join(dir, "threads"));
    if (await Bun.spawn(["git", "init", dir], { stdout: "ignore", stderr: "ignore" }).exited !== 0) throw new Error("Could not initialize fixture Studio");
    const text = (question: string) => `---\nstudioId: 120e1a58-09a5-4a1d-8ef2-61ef4e66a0ba\ntype: question\nareas: [work]\nstate: active\nopened: 2026-11-01\n---\n## Question\n${question}\n## Where I stand\nThinking\n## Material\n## Ivy's notes\n## Log\n`;
    await writeFile(join(dir, "threads/sketch.md"), text("Which sketch?"));
    runtime = { ...runtime, options: { ...desk, studio: { dir, maxActive: 5 } } };
    await syncStudioBalance(db, runtime.options, NOW);
    const first = readMyDay(db, runtime.options, NOW);
    const project = first.outline.children[0]?.children.find(node => node.id.startsWith("studio-thread:"));
    if (!project) throw new Error("Missing Studio project");
    await writeFile(join(dir, "threads/sketch.md"), text("Which smaller sketch?"));
    expect((await post(edit(first, "first", { note: "Stale source snapshot" }))).status).toBe(409);
    await syncStudioBalance(db, runtime.options, NOW);
    const current = readMyDay(db, runtime.options, NOW);
    expect(current.revision).toBeGreaterThan(first.revision);
    expect((await post(edit(current, project.id, { title: "Forged source title" }))).status).toBe(409);
    for (const command of [
      { op: "outline-move", parent: "area:personal" },
      { op: "outline-complete", confirm: true },
      { op: "outline-reopen", confirm: true },
    ]) expect((await post({ ...command, id: project.id, revision: current.revision })).status).toBe(409);
    expect(loadBalanceState(db)?.log).toHaveLength(0);
  });
  test("cleanup removes only explicitly confirmed empty unlinked uncredited items and replays once", async () => {
    let current = (await change({ op: "outline-add", parent: "area:work", title: "Owned probe", revision: view().revision })).view;
    const project = required(current, "area:work").children.find(node => node.title === "Owned probe");
    if (!project) throw new Error("Missing owned project");
    const requestId = crypto.randomUUID();
    const command = { op: "outline-remove", id: project.id, revision: current.revision, confirm: true } satisfies BalanceCommand;
    expect((await post({ ...command, confirm: false })).status).toBe(400);
    expect((await post(command, requestId)).status).toBe(200);
    expect((await post(command, requestId)).status).toBe(200);
    expect(findNode(view().outline, project.id)).toBeNull();
    for (const id of ["area:work", "project"]) expect((await post({ op: "outline-remove", id, revision: view().revision, confirm: true })).status).toBe(409);
    current = (await change({ op: "outline-complete", id: "first", revision: view().revision, confirm: true })).view;
    expect((await post({ op: "outline-remove", id: "first", revision: current.revision, confirm: true })).status).toBe(409);
  });
  test("the actual React page renders the persisted hierarchy and route helpers retain filters and exact item navigation", async () => {
    const composed = await composeDesk(db, desk, undefined, { now: NOW });
    const day = composed.myDay;
    if (!day) throw new Error("Missing My day view");
    const html = renderToStaticMarkup(createElement(DeskBalance, { day, view: composed, foreground: { kind: "unavailable", reason: "Not yet measured" }, onChanged: () => undefined, onThread: () => undefined }));
    expect(html).toContain("Full Balance hierarchy");
    expect(html).toContain("Selected Balance item");
    expect(html).toContain("standalone");
    expect(balanceMatches(required(day, "area:work"), "second")).toBe(true);
    expect(balanceMatches(required(day, "area:personal"), "second")).toBe(false);
    expect(balanceEntries(day.outline).find(entry => entry.node.id === "second")?.path).toEqual(["Work", "project"]);
    const location = { tab: "plan", item: "second", area: "area:work", query: "second" } as const;
    expect(readBalanceLocation(balanceSearch("?unrelated=kept", location))).toEqual(location);
    expect(readBalanceLocation("?desk=mirror").tab).toBe("review");
    expect(readBalanceLocation(balanceItemSearch("?balance-area=missing&balance-search=hidden", "second"))).toEqual({ tab: "plan", item: "second", area: "", query: "" });
  });
  test("the inspector opens a mail source in place, a web source in a new tab and never renders a hostile source as a link", async () => {
    const composed = await composeDesk(db, desk, undefined, { now: NOW });
    const day = composed.myDay;
    if (!day) throw new Error("Missing My day view");
    const selected = balanceEntries(day.outline)[0]?.node.id;
    if (!selected) throw new Error("Missing selected Balance item");
    const render = (kind: string, url: string): string => renderToStaticMarkup(createElement(DeskBalance, { day: { ...day, sources: [{ taskId: selected, key: "probe", fingerprint: "probe", kind, url }] }, view: composed, foreground: { kind: "unavailable", reason: "Not yet measured" }, onChanged: () => undefined, onThread: () => undefined }));
    const mail = render("mail", "message://%3Cprobe%40example.org%3E");
    expect(mail).toContain("<a href=\"message://%3Cprobe%40example.org%3E\">Open in Mail</a>");
    expect(mail).not.toContain("Open original source");
    expect(render("github", "https://example.org/issue/1")).toContain("<a href=\"https://example.org/issue/1\" target=\"_blank\" rel=\"noopener noreferrer\">Open original source</a>");
    const hostile = render("mail", "javascript:alert(1)");
    expect(hostile).not.toContain("javascript:");
    expect(hostile).toContain("<p>From mail</p>");
  });
  const selectFirst = async (): Promise<MyDayView> => {
    await change(edit(view(), "first", { note: "Bring the signed form", dueDate: "2026-11-05" }));
    expect((await post({ op: "start", ids: ["first", "standalone"] })).status).toBe(200);
    expect((await post({ op: "select", id: "first", revision: view().revision })).status).toBe(200);
    return view();
  };
  const between = (html: string, from: string, to: string): string => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
  test("the Day page shows compact saved Balance details with explicit editing in its main column", async () => {
    const day = { ...(await selectFirst()), sources: [{ taskId: "first", key: "mail:probe", fingerprint: "probe", kind: "mail", url: "message://%3Cprobe%40example.org%3E" }] };
    const html = renderToStaticMarkup(createElement(DeskTimeFirst, { day, now: NOW, before: null, after: null, proposal: null, preview: null, ambient: null, areas: desk.areas, onChanged: () => undefined, onThread: () => undefined, onConversation: () => undefined }));
    const main = between(html, "class=\"tf-current\"", "class=\"tf-contract\"");
    for (const part of ["<h2>first</h2>", "Work / project", "Bring the signed form", "dateTime=\"2026-11-05\"", "Saved task details", "<a href=\"message://%3Cprobe%40example.org%3E\">Open in Mail</a>", "+ Add subtask", "Move…", "Mark complete", ">Edit</button>", ">Done</button>", ">Not today</button>", ">Use recommendation</button>", ">Choose another</a>"]) expect(main).toContain(part);
    expect(main).not.toContain("aria-label=\"Balance notes\"");
    expect(main).not.toContain("Save changes");
    expect(main).not.toContain("<form");
    const side = between(html, "aria-label=\"Selected task context\"", "</section>");
    expect(side).toContain("Open task in Balance");
    expect(side).not.toContain("Bring the signed form");
    expect(side).not.toContain("<h3>");
  });
  test("a Day details save goes through the Balance writer, persists, and a stale revision is refused without overwriting", async () => {
    const day = await selectFirst();
    const node = required(day, "first");
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => handleDeskMyDay(new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost"), init), db, runtime, undefined, NOW)) as typeof fetch;
    try {
      const draft = { node, details: { ...balanceDetails(node, DATE), note: "Saved from the Day page" }, revision: day.revision, date: DATE, yes: false };
      await submitMyDay(DATE, detailsCommand(draft));
      expect(required(view(), "first").note).toBe("Saved from the Day page");
      const before = JSON.stringify(loadBalanceState(db));
      const refusal = await submitMyDay(DATE, detailsCommand({ ...draft, details: { ...draft.details, note: "Stale Day draft" } })).then(() => null, (error: unknown) => error);
      expect(refusal).toMatchObject({ info: { status: 409, message: STALE_OUTLINE } });
      expect(JSON.stringify(loadBalanceState(db))).toBe(before);
      expect(required(view(), "first").note).toBe("Saved from the Day page");
    } finally { globalThis.fetch = original; }
  });
});
