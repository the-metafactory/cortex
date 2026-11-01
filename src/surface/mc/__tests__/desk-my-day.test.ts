import { addNote, listOpenNotes } from "../desk/notes";
import { mailItems } from "../desk/rank";
import { briefing, selectItems, spokenBriefing } from "../desk/present";
import { startServer } from "../server";
import { DEFAULT_CONFIG } from "../config";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { initDatabase } from "../db/init";
import { DEFAULT_SETTINGS, findNode, selectToday, type AppState } from "../../../balance";
import { saveBalanceState, loadBalanceState } from "../desk/balance-store";
import { changeMyDay, readMyDay, movedKeys, sourceIdentity, localDay } from "../desk/my-day";
import { MyDayLane } from "../dashboard-v2/components/desk-my-day";
import { MyDayRequestSchema, type MyDayCommand } from "../desk/my-day-schema";
import { composeDesk, type DeskOptions } from "../desk/compose";
import { z } from "zod";
import { handleGetDesk } from "../api/desk";
import type { WaitingTask } from "../desk/sources/waiting";
import { handleDeskMyDay } from "../api/desk-my-day";
import { SourceCache } from "../desk/sources/command";
import { HandledLedger } from "../desk/actions";
import type { DeskItem } from "../desk/types";

const NOW = new Date(2026, 9, 31, 10).getTime();
const DATE = localDay(NOW);
const desk: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", sources: [], areas: [{ id: "work", label: "Work", color: "", repos: [], goals: [] }] };
function seed(): AppState {
  return { outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [{ id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: [
    { id: "constructor", title: "Write the outline", weight: 50, ordering: "parallel", children: [], effort: 1 },
    { id: "__proto__", title: "Review the draft", weight: 50, ordering: "parallel", children: [], effort: 1 },
    { id: "third", title: "Plan next week", weight: 50, ordering: "parallel", children: [], effort: 1 },
  ] }] }, settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null };
}
function source(kind: "mail" | "agent-blocked"): DeskItem {
  return { key: `${kind}:source`, kind, source: kind === "mail" ? "inbox" : "ranger", title: "Choose a next step", why: "A decision is waiting.", dueAt: "2026-11-04T12:00:00Z", area: "work", urgency: "today", score: 50, actions: [], detail: { summary: "A synthetic item", history: [], refs: [], links: [{ label: "Source", url: "https://example.test/item" }] } };
}
describe("My day lane and day contract", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); saveBalanceState(db, seed()); });
  afterEach(() => db.close());
  const change = (command: MyDayCommand, requestId: string = crypto.randomUUID(), extra: { now?: number; date?: string; source?: DeskItem; desk?: DeskOptions } = {}) => changeMyDay({ db, desk, now: NOW, date: DATE, requestId, command, ...extra });
  it("shows exactly the engine list with reasons, bounded alternates and proposed contract", () => {
    const view = readMyDay(db, desk, NOW);
    expect(view.items.map(i => i.task.id)).toEqual(selectToday(seed(), DATE).map(i => i.task.id));
    expect(view).toMatchObject({ cap: 5, topN: 5, configuredCaps: { cap: 5, topN: 5 }, capsOverridden: false });
    expect(view.items.every(i => i.trace.length > 0)).toBe(true);
    expect(view.alternates.length).toBeLessThanOrEqual(3);
    const html = renderToStaticMarkup(createElement(MyDayLane, { day: view, onChanged: () => {} }));
    expect(html).toContain("Start the day");
    expect(html).toContain("Why this");
    expect(html).toContain("My day cap");
  });
  it("persists just-one-thing and starts idempotently without applying deficits twice", () => {
    const first = readMyDay(db, desk, NOW).items[0];
    if (!first) throw new Error("Missing seeded task");
    change({ op: "draft", ids: [first.task.id] });
    expect(readMyDay(db, desk, NOW).items).toHaveLength(1);
    const request = crypto.randomUUID();
    change({ op: "start", ids: [first.task.id] }, request);
    const history = loadBalanceState(db)?.history;
    change({ op: "start", ids: [first.task.id] }, request);
    expect(loadBalanceState(db)?.history).toEqual(history);
    expect(() => change({ op: "start", ids: [] }, request)).toThrow("another change");
  });
  it("completes once and evening close shows wins first", () => {
    change({ op: "start", ids: ["constructor"] });
    const request = crypto.randomUUID();
    change({ op: "done", id: "constructor" }, request);
    change({ op: "done", id: "constructor" }, request);
    const view = change({ op: "close" }).view;
    expect(view.phase).toBe("closed");
    expect(view.wins).toEqual([{ taskId: "constructor", title: "Write the outline" }]);
    expect(loadBalanceState(db)?.log).toHaveLength(1);
    const html = renderToStaticMarkup(createElement(MyDayLane, { day: view, onChanged: () => {} }));
    expect(html).toContain("Wins today");
    expect(html).not.toContain("Start the day");
    expect(() => change({ op: "done", id: "third" })).toThrow("active day");
  });
  it("a recurring task with lead time records at most one win per day and reopens tomorrow", () => {
    const state = seed();
    const task = findNode(state.outline, "constructor");
    if (!task) throw new Error("Missing recurring task");
    task.repeat = { unit: "day", interval: 1 };
    task.leadDays = 1;
    saveBalanceState(db, state);
    change({ op: "start", ids: [task.id] });
    change({ op: "done", id: task.id });
    readMyDay(db, desk, NOW);
    change({ op: "done", id: task.id });
    expect(loadBalanceState(db)?.log).toHaveLength(1);
    expect(findNode(loadBalanceState(db)?.outline ?? state.outline, task.id)?.repeat?.timesDone).toBe(1);
    expect(readMyDay(db, desk, NOW).items.map(i => i.task.id)).not.toContain(task.id);
    const tomorrow = NOW + 86400000;
    const next = readMyDay(db, desk, tomorrow);
    expect(next.items.map(i => i.task.id)).toContain(task.id);
    change({ op: "start", ids: [task.id] }, crypto.randomUUID(), { now: tomorrow, date: localDay(tomorrow) });
    change({ op: "done", id: task.id }, crypto.randomUUID(), { now: tomorrow, date: localDay(tomorrow) });
    expect(loadBalanceState(db)?.log).toHaveLength(2);
    expect(findNode(loadBalanceState(db)?.outline ?? state.outline, task.id)?.repeat?.timesDone).toBe(2);
  });
  it("semantic Undo survives reload and preserves another writer's title and completion", () => {
    change({ op: "start", ids: ["constructor", "__proto__"] });
    const result = change({ op: "defer", id: "constructor" });
    expect(readMyDay(db, desk, NOW).undos).toHaveLength(1);
    const state = loadBalanceState(db);
    if (!state) throw new Error("Missing state");
    const task = findNode(state.outline, "constructor");
    if (!task) throw new Error("Missing task");
    task.title = "Changed elsewhere";
    saveBalanceState(db, state);
    change({ op: "done", id: "__proto__" });
    change({ op: "undo", receipt: result.undo ?? "" });
    expect(findNode(loadBalanceState(db)?.outline ?? seed().outline, "constructor")?.title).toBe("Changed elsewhere");
    expect(readMyDay(db, desk, NOW).items.map(i => i.task.id)).toContain("constructor");
    expect(readMyDay(db, desk, NOW).wins).toHaveLength(1);
  });
  it("refuses Undo over a newer deferral and rejects stale-day requests atomically", () => {
    readMyDay(db, desk, NOW);
    const result = change({ op: "defer", id: "constructor" });
    const state = loadBalanceState(db);
    if (!state) throw new Error("Missing state");
    const task = findNode(state.outline, "constructor");
    if (!task) throw new Error("Missing task");
    task.deferredUntil = "2026-11-20";
    saveBalanceState(db, state);
    expect(() => change({ op: "undo", receipt: result.undo ?? "" })).toThrow("newer edit");
    expect(() => change({ op: "close" }, crypto.randomUUID(), { now: NOW + 86400000 })).toThrow("date changed");
    expect(findNode(loadBalanceState(db)?.outline ?? seed().outline, "constructor")?.deferredUntil).toBe("2026-11-20");
    expect(readMyDay(db, desk, NOW + 86400000).phase).toBe("proposed");
  });
  for (const kind of ["mail", "agent-blocked"] as const) it(`moves ${kind} to intake idempotently with source and due, then files into configured area`, () => {
    const item = source(kind);
    const result = change({ op: "todo", key: item.key, fingerprint: sourceIdentity(item) }, crypto.randomUUID(), { source: item });
    change({ op: "todo", key: item.key, fingerprint: sourceIdentity(item) });
    expect(result.view.inbox).toHaveLength(1);
    const task = result.view.inbox[0];
    if (!task) throw new Error("Missing intake");
    expect(task.dueDate).toBe("2026-11-04");
    expect(result.view.sources[0]?.url).toBe("https://example.test/item");
    expect(movedKeys(db).has(sourceIdentity(item))).toBe(true);
    expect(result.view.outline.children.map(n => n.title)).toEqual(["Work"]);
    expect(() => change({ op: "file", id: task.id, parent: "unknown" })).toThrow();
    expect(readMyDay(db, desk, NOW).inbox).toHaveLength(1);
    change({ op: "file", id: task.id, parent: "area:work" });
    expect(readMyDay(db, desk, NOW).inbox).toHaveLength(0);
    expect(findNode(loadBalanceState(db)?.outline ?? seed().outline, task.id)?.dueDate).toBe(task.dueDate);
  });
  it("a Desk reminder todo carries its reported due date and preserves the source note", async () => {
    const note = addNote(db, "reminder", "An owned reminder", NOW - 60000, NOW - 120000);
    const item = (await composeDesk(db, desk, undefined, { now: NOW })).items.find(i => i.key === `reminder:${note.id}`);
    if (!item) throw new Error("Missing reminder source");
    const intake = change({ op: "todo", key: item.key, fingerprint: sourceIdentity(item) }, crypto.randomUUID(), { source: item }).view.inbox[0];
    expect(intake?.dueDate).toBe(DATE);
    expect(intake?.note).toContain(item.key);
    expect(listOpenNotes(db).some(n => n.id === note.id)).toBe(true);
    expect((await composeDesk(db, desk, undefined, { now: NOW })).items.some(i => i.key === item.key)).toBe(false);
  });
  it("does not invent a deadline or call an external source action", () => {
    const item = source("mail"); delete item.dueAt;
    const result = change({ op: "todo", key: item.key, fingerprint: sourceIdentity(item) }, crypto.randomUUID(), { source: item });
    expect(result.view.inbox[0]?.dueDate).toBeUndefined();
    expect(item.actions).toEqual([]);
  });
  it("uses visible dial overrides until reset, then reads current configuration", () => {
    change({ op: "cap", cap: 2 });
    change({ op: "topN", topN: 3 });
    const updatedDesk = { ...desk, myDay: { cap: 4 }, topN: 6 };
    expect(readMyDay(db, updatedDesk, NOW)).toMatchObject({ cap: 2, topN: 3, capsOverridden: true, configuredCaps: { cap: 4, topN: 6 } });
    const reset = change({ op: "reset-caps" }, crypto.randomUUID(), { desk: updatedDesk });
    expect(reset.view).toMatchObject({ cap: 4, topN: 6, capsOverridden: false });
  });
  it("a lower configuration cap bounds the visible proposal without losing its saved draft", () => {
    const original = readMyDay(db, desk, NOW).items.map(i => i.task.id);
    expect(readMyDay(db, { ...desk, myDay: { cap: 1 } }, NOW).items).toHaveLength(1);
    expect(readMyDay(db, desk, NOW).items.map(i => i.task.id)).toEqual(original);
  });
  it("independent cap dials preserve the other window's change", () => {
    change({ op: "topN", topN: 3 });
    change({ op: "cap", cap: 2 });
    expect(readMyDay(db, desk, NOW)).toMatchObject({ cap: 2, topN: 3 });
  });
  it("rejects lost-update edits and requires the Yes-filter for a new focus", () => {
    const before = { title: "Write the outline", weight: 50, dueDate: "" };
    change({ op: "edit", id: "constructor", title: "New title", weight: 60, dueDate: "", focus: false, yes: false, before });
    expect(() => change({ op: "edit", id: "constructor", title: "Stale title", weight: 20, dueDate: "", focus: false, yes: false, before })).toThrow("another window");
    change({ op: "add", parent: "area:work", title: "Project", kind: "project" });
    const project = loadBalanceState(db)?.outline.children[0]?.children.find(n => n.title === "Project");
    if (!project) throw new Error("Missing project");
    change({ op: "add", parent: project.id, title: "Project task", kind: "task" });
    expect(() => change({ op: "edit", id: project.id, title: project.title, weight: 50, dueDate: "", focus: true, yes: false, before: { title: project.title, weight: 50, dueDate: "" } })).toThrow("Yes-filter");
  });
  it("refuses moving a newer source episode than the one the person saw", () => {
    const seen = source("agent-blocked");
    const newer = { ...seen, title: "A new decision on the same node" };
    expect(() => change({ op: "todo", key: seen.key, fingerprint: sourceIdentity(seen) }, crypto.randomUUID(), { source: newer })).toThrow("source changed");
    expect(readMyDay(db, desk, NOW).inbox).toHaveLength(0);
  });
  it("mail classification cannot resurrect or duplicate a moved source message", () => {
    const mail = { kind: "mail" as const, id: "classification-fixture", from: { address: "person@example.test" }, subject: "A source request", firstParagraph: "The original excerpt", receivedAt: new Date(NOW).toISOString(), unread: true, sourceId: "inbox", area: null };
    const input = { now: NOW, mail: [mail], events: [], vips: new Set<string>() };
    const before = mailItems(input)[0];
    const after = mailItems({ ...input, classified: new Map([[mail.id, { category: "action" as const, reason: "A next step is waiting", summary: "A classifier-generated summary" }]]) })[0];
    if (!before || !after) throw new Error("Missing mail producer output");
    expect(after.detail.summary).not.toBe(before.detail.summary);
    change({ op: "todo", key: before.key, fingerprint: sourceIdentity(before) }, crypto.randomUUID(), { source: before });
    expect(movedKeys(db).has(sourceIdentity(after))).toBe(true);
    change({ op: "todo", key: after.key, fingerprint: sourceIdentity(after) }, crypto.randomUUID(), { source: after });
    expect(readMyDay(db, desk, NOW).inbox).toHaveLength(1);
  });
  it("does not treat an asynchronously reworded question as a new source episode", () => {
    const item = source("agent-blocked");
    const reworded = { ...item, question: { condition: "A clearer condition", reason: "A clearer explanation" } };
    expect(sourceIdentity(reworded)).toBe(sourceIdentity(item));
    const requestId = crypto.randomUUID();
    const command = { op: "todo", key: item.key, fingerprint: sourceIdentity(item) } satisfies MyDayCommand;
    change(command, requestId, { source: item });
    change(command, requestId);
    change(command, crypto.randomUUID(), { source: reworded });
    expect(readMyDay(db, desk, NOW).inbox).toHaveLength(1);
  });
  it("visible and spoken briefings end with the engine proposal and put closed-day wins first", async () => {
    const composed = await composeDesk(db, desk, undefined, { now: NOW });
    const selected = selectItems(composed, "all", new Set());
    const visible = briefing(composed, selected, null).lines.join(" ");
    const spoken = spokenBriefing(composed, selected, null);
    const titles = composed.myDay?.items.map(i => i.task.title).join("; ") ?? "";
    expect(visible).toContain(`Your proposed My day: ${titles}`);
    expect(spoken).toContain(`Your proposed My day: ${titles}`);
    expect(visible).toEndWith("Choose Start the day to confirm, Swap for an alternate, or Just one thing.");
    expect(spoken).toEndWith("Choose Start the day to confirm, Swap for an alternate, or Just one thing.");
    change({ op: "start", ids: ["constructor"] });
    change({ op: "done", id: "constructor" });
    change({ op: "close" });
    const closed = await composeDesk(db, desk, undefined, { now: NOW });
    expect(briefing(closed, selected, null).lines[0]).toBe("Wins today: Write the outline. Your day is done.");
    const evening = spokenBriefing(closed, selected, null);
    expect(evening.indexOf("Wins today")).toBeLessThan(evening.indexOf("The Desk cannot see"));
  });
  it("server rejects malformed and missing-source todo commands without creating intake", async () => {
    const runtime = { options: desk, ledger: new HandledLedger() };
    const request = (body: unknown) => new Request("http://localhost/api/desk/my-day", { method: "POST", body: JSON.stringify(body) });
    expect((await handleDeskMyDay(request({}), db, runtime, undefined, NOW)).status).toBe(400);
    const body = { date: DATE, requestId: crypto.randomUUID(), command: { op: "todo", key: "missing", fingerprint: "0".repeat(64) } };
    expect(MyDayRequestSchema.safeParse(body).success).toBe(true);
    expect((await handleDeskMyDay(request(body), db, runtime, undefined, NOW)).status).toBe(409);
    expect(readMyDay(db, desk, NOW).inbox).toHaveLength(0);
  });
  for (const kind of ["mail", "ranger"] as const) it(`API derives ${kind} todo metadata from the actual source reading`, async () => {
    const remote = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ current: [], maps: [], needsYou: [{ key: "fixture", repo: "example/app", nodeId: "12", title: "Review the next step", status: "failed", endedAt: new Date(NOW).toISOString(), dueAt: "2026-11-04T12:00:00Z", url: "https://example.test/ranger" }] }) });
    const mail = { kind: "mail", id: "fixture", from: { address: "person@example.test" }, subject: "A next step", receivedAt: new Date(NOW).toISOString(), unread: true, dueAt: "2026-11-04T12:00:00Z", url: "https://example.test/mail" };
    const options = { ...desk, rangerUrl: kind === "ranger" ? `http://127.0.0.1:${remote.port}` : "", sources: kind === "mail" ? [{ id: "fixture", command: ["fixture"], everySeconds: 300, timeoutSeconds: 5 }] : [] };
    const cache = new SourceCache(async () => JSON.stringify({ items: [mail] }));
    const runtime = { options, ledger: new HandledLedger(), sourceCache: cache };
    try {
      const key = kind === "mail" ? "mail:fixture" : "ranger:example/app#12";
      const seen = (await composeDesk(db, options, undefined, { now: NOW, sourceCache: cache })).items.find(i => i.key === key);
      if (!seen) throw new Error("Missing source reading");
      const body = { date: DATE, requestId: crypto.randomUUID(), command: { op: "todo", key, fingerprint: sourceIdentity(seen) }, title: "Forged title", dueAt: "2030-01-01" };
      const request = () => new Request("http://localhost/api/desk/my-day", { method: "POST", body: JSON.stringify(body) });
      expect((await handleDeskMyDay(request(), db, runtime, undefined, NOW)).status).toBe(200);
      expect((await handleDeskMyDay(request(), db, runtime, undefined, NOW)).status).toBe(200);
      const view = readMyDay(db, options, NOW);
      expect(view.inbox).toHaveLength(1);
      expect(view.inbox[0]?.title).not.toBe("Forged title");
      expect(view.inbox[0]?.dueDate).toBe("2026-11-04");
      expect(view.sources[0]?.url).toBe(`https://example.test/${kind}`);
      expect((await composeDesk(db, options, undefined, { now: NOW, sourceCache: cache })).items).toHaveLength(0);
    } finally { await remote.stop(true); }
  });
  it("moves the displayed waiting-task snapshot through the actual GET and POST handlers", async () => {
    const endedAt = new Date().toISOString();
    const remote = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ current: [], maps: [], needsYou: [{ key: "fixture", repo: "example/app", nodeId: "12", title: "Old Ranger title", status: "failed", endedAt, url: "https://example.test/12" }] }) });
    const waiting = new Map<string, WaitingTask>([["example/app#12", { kind: "open", title: "Current waiting-task title", question: "Which path should we take?", url: "https://example.test/12" }]]);
    const runtime = { options: { ...desk, rangerUrl: `http://127.0.0.1:${remote.port}` }, ledger: new HandledLedger(), waitingTasks: { read: async () => waiting } };
    try {
      const response = await handleGetDesk(db, runtime, undefined);
      const view = z.object({ items: z.array(z.object({ key: z.string(), title: z.string(), todoFingerprint: z.string() })) }).parse(await response.json());
      const seen = view.items.find(item => item.key === "ranger:example/app#12");
      if (!seen) throw new Error("Missing displayed waiting task");
      expect(seen.title).toContain("Current waiting-task title");
      const request = new Request("http://localhost/api/desk/my-day", { method: "POST", body: JSON.stringify({ date: localDay(Date.now()), requestId: crypto.randomUUID(), command: { op: "todo", key: seen.key, fingerprint: seen.todoFingerprint } }) });
      expect((await handleDeskMyDay(request, db, runtime)).status).toBe(200);
      expect(readMyDay(db, runtime.options, Date.now()).inbox).toHaveLength(1);
      expect(readMyDay(db, runtime.options, Date.now()).inbox[0]?.title).toBe(seen.title);
    } finally { await remote.stop(true); }
  });
  const mutationFixture = (authorized: boolean) => startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: ["allowed@example.test"], localPrincipal: authorized ? "allowed@example.test" : "other@example.test" } }, db, { desk });
  const postCap = (port: number, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}/api/desk/my-day`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, ...headers },
    body: JSON.stringify({ date: localDay(Date.now()), requestId: crypto.randomUUID(), command: { op: "cap", cap: 1 } }),
  });
  it("rejects hostile Host independently of identity", async () => {
    const ctx = mutationFixture(true);
    try {
      const response = await postCap(ctx.port, { Host: "evil.example" });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "forbidden_host" });
      expect(readMyDay(db, desk, Date.now()).capsOverridden).toBe(false);
    } finally { ctx.stop(true); }
  });
  it("rejects hostile Origin independently of identity", async () => {
    const ctx = mutationFixture(true);
    try {
      const response = await postCap(ctx.port, { Origin: "https://evil.example" });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "forbidden_origin" });
      expect(readMyDay(db, desk, Date.now()).capsOverridden).toBe(false);
    } finally { ctx.stop(true); }
  });
  it("accepts a valid authorized mutation control", async () => {
    const ctx = mutationFixture(true);
    try {
      const response = await postCap(ctx.port);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ view: { cap: 1, capsOverridden: true } });
      expect(readMyDay(db, desk, Date.now()).cap).toBe(1);
    } finally { ctx.stop(true); }
  });
  it("rejects unauthorized identity with valid Host and Origin", async () => {
    const ctx = mutationFixture(false);
    try {
      const response = await postCap(ctx.port);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "not_authorized" });
      expect(readMyDay(db, desk, Date.now()).capsOverridden).toBe(false);
    } finally { ctx.stop(true); }
  });
  it("compose omits moved Ranger items without changing Ranger's source state", async () => {
    const ranger = { current: [], maps: [], needsYou: [{ repo: "example/app", nodeId: "12", key: "source", title: "Decision", status: "failed", url: "https://example.test/12" }] };
    const opts = { ...desk, rangerUrl: "http://localhost" };
    const deps = { now: NOW, fetchImpl: async () => Response.json(ranger) };
    const item = (await composeDesk(db, opts, undefined, deps)).items[0];
    if (!item) throw new Error("Missing Ranger item");
    change({ op: "todo", key: item.key, fingerprint: sourceIdentity(item) }, crypto.randomUUID(), { source: item });
    const view = await composeDesk(db, opts, undefined, deps);
    expect(view.items.some(i => i.key === item.key)).toBe(false);
    expect(ranger.needsYou).toHaveLength(1);
    const later = await composeDesk(db, opts, undefined, { ...deps, now: NOW + 3600000 });
    expect(later.items.some(i => i.key === item.key)).toBe(false);
    ranger.needsYou[0] = { ...ranger.needsYou[0], title: "A different decision", repo: "example/app", nodeId: "12", key: "source", status: "failed", url: "https://example.test/12" };
    expect((await composeDesk(db, opts, undefined, deps)).items.some(i => i.key === item.key)).toBe(true);
    expect(readMyDay(db, desk, NOW).inbox).toHaveLength(1);
    const newItem = (await composeDesk(db, opts, undefined, deps)).items[0];
    if (!newItem) throw new Error("Missing changed Ranger item");
    change({ op: "todo", key: newItem.key, fingerprint: sourceIdentity(newItem) }, crypto.randomUUID(), { source: newItem });
    expect(readMyDay(db, desk, NOW).inbox).toHaveLength(2);
  });
  it("files intake into an empty project and makes its first task schedulable", () => {
    change({ op: "add", parent: "area:work", title: "Empty project", kind: "project" });
    const project = readMyDay(db, desk, NOW).outline.children[0]?.children.find(n => n.title === "Empty project");
    if (!project) throw new Error("Missing empty project");
    const item = source("mail");
    const intake = change({ op: "todo", key: item.key, fingerprint: sourceIdentity(item) }, crypto.randomUUID(), { source: item }).view.inbox[0];
    if (!intake) throw new Error("Missing intake");
    change({ op: "file", id: intake.id, parent: project.id });
    expect(readMyDay(db, desk, NOW).inbox).toHaveLength(0);
    const state = loadBalanceState(db);
    if (!state) throw new Error("Missing state");
    expect(findNode(state.outline, project.id)?.done).toBeUndefined();
    expect(selectToday(state, DATE).map(i => i.task.id)).toContain(intake.id);
  });
  it("uses Studio's generic Yes-filter for missing or empty configured questions", () => {
    const generic = ["Is this mine to do?", "Does it fit my capacity?", "What will I stop doing for it?"];
    expect(readMyDay(db, desk, NOW).yesFilter).toEqual(generic);
    expect(readMyDay(db, { ...desk, studio: { dir: "/unused", maxActive: 5, yesFilter: [] } }, NOW).yesFilter).toEqual(generic);
    expect(readMyDay(db, { ...desk, studio: { dir: "/unused", maxActive: 5, yesFilter: ["A configured question?"] } }, NOW).yesFilter).toEqual(["A configured question?"]);
  });
  it("refuses stale add and edit targets after their area is removed", () => {
    const removed = { ...desk, areas: [] };
    expect(() => change({ op: "add", parent: "area:work", title: "Hidden task", kind: "task" }, crypto.randomUUID(), { desk: removed })).toThrow("parent");
    expect(() => change({ op: "edit", id: "constructor", title: "Hidden", weight: 50, dueDate: "", focus: false, yes: false, before: { title: "Write the outline", weight: 50, dueDate: "" } }, crypto.randomUUID(), { desk: removed })).toThrow("no longer configured");
    expect(findNode(loadBalanceState(db)?.outline ?? seed().outline, "constructor")?.title).toBe("Write the outline");
  });
});
