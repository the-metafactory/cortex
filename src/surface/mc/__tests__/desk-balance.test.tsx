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
import { readStudioMyDay } from "../desk/studio-my-day";
import { SourceCache } from "../desk/sources/command";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { balanceEntries, balanceMatches, DeskBalance } from "../dashboard-v2/components/desk-balance";
import { balanceItemSearch, balanceSearch, readBalanceLocation } from "../dashboard-v2/hooks/use-balance-location";

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
  const change = async (command: BalanceCommand): Promise<{ view: MyDayView; notice?: string }> => {
    const response = await post(command);
    if (response.status !== 200) throw new Error(await response.text());
    const reply = z.object({ notice: z.string().optional() }).parse(await response.json());
    return { view: view(), ...(reply.notice ? { notice: reply.notice } : {}) };
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
  test("rejects invalid estimates at the HTTP boundary without changing stored state", async () => {
    const current = view();
    const before = JSON.stringify(loadBalanceState(db));
    for (const estimateMinutes of [0, -1, 1.5, "20"]) {
      const command = { ...edit(current, "first"), details: { ...balanceDetails(required(current, "first"), DATE), estimateMinutes } };
      expect((await post(command)).status).toBe(400);
    }
    expect(JSON.stringify(loadBalanceState(db))).toBe(before);
  });
  test("adds and moves without replacing the confirmed day, and rejects cycles and unavailable parents atomically", async () => {
    expect((await post({ op: "start", ids: ["first", "standalone"] })).status).toBe(200);
    const before = loadBalanceState(db)?.dayState;
    let current = view();
    current = (await change({ op: "outline-add", revision: current.revision, parent: "first", title: "A new child" })).view;
    const child = required(current, "first").children[0];
    if (!child) throw new Error("Missing created child");
    expect(loadBalanceState(db)?.dayState).toEqual(before);
    expect(current.items.map(item => item.task.id)).toEqual(["standalone"]);
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
  test("keeps a proposed day stable while new outline items wait for an explicit proposal refresh", async () => {
    const current = view();
    const ids = current.items.map(item => item.task.id);
    const saved = await change({ op: "outline-add", revision: current.revision, parent: "area:work", title: "A later choice" });
    expect(saved.view.items.map(item => item.task.id)).toEqual(ids);
    expect(view().items.map(item => item.task.id)).toEqual(ids);
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
    expect(loadBalanceState(db)?.dayState?.confirmed).toEqual(["first", "standalone"]);
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
    const first = await readStudioMyDay(db, runtime.options, NOW);
    const project = first.outline.children[0]?.children.find(node => node.id.startsWith("studio-thread:"));
    if (!project) throw new Error("Missing Studio project");
    await writeFile(join(dir, "threads/sketch.md"), text("Which smaller sketch?"));
    expect((await post(edit(first, "first", { note: "Stale source snapshot" }))).status).toBe(409);
    const current = await readStudioMyDay(db, runtime.options, NOW);
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
});
