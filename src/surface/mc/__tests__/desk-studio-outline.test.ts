import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { DEFAULT_SETTINGS, findNode, selectToday, type AppState } from "../../../balance";
import { initDatabase } from "../db/init";
import { saveBalanceState, loadBalanceState } from "../desk/balance-store";
import { changeMyDay, localDay, readMyDay } from "../desk/my-day";
import { MyDayMetaSchema } from "../desk/my-day-schema";
import { projectStudio, type StudioProjection } from "../desk/studio-outline";
import { readStudioMyDay } from "../desk/studio-my-day";
import { parseThreadFile, type StudioThread } from "../desk/studio/format";
import { acquireStudioLock } from "../desk/studio/write-lock";
import { StudioWriteLock, runStudioAct } from "../desk/studio/writer";
import { handleDeskStudioAct } from "../api/desk-studio-act";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { MyDayLane } from "../dashboard-v2/components/desk-my-day";
import { HandledLedger } from "../desk/actions";

const now = Date.parse("2026-11-01T10:00:00Z");
const noteAt = "2026-11-01T09:00:00Z";
const responseAt = "2026-11-01T10:00:00Z";
const note = (at = noteAt) => ({ at, trigger: "A synthetic design question", model: "local", kind: "note" as const, status: "open" as const, sample: false, text: "Try a small sketch." });
const thread = (): StudioThread => ({ slug: "design", path: "threads/design.md", type: "question", areas: ["lab", "other"], state: "active", opened: "2026-11-01", thinkTonight: false, question: "Which sketch?", stand: "", notes: [note()], responses: [], material: [], log: [], outcomeText: "" });
const desk: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", sources: [], areas: [{ id: "lab", label: "Lab", color: "", repos: [], goals: [] }, { id: "other", label: "Other", color: "", repos: [], goals: [] }] };
const state = (): AppState => ({ outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: desk.areas.map(a => ({ id: `area:${a.id}`, title: a.label, weight: 50, ordering: "parallel", children: [] })) }, log: [], settings: { ...DEFAULT_SETTINGS }, history: { deficits: {}, lastSurfaced: {} }, dayState: null });
function fixture() {
  const model = state();
  const meta = MyDayMetaSchema.parse({});
  const source: StudioProjection = { namespace: "directory-one", threads: [thread()] };
  const sync = () => projectStudio(model, meta, source);
  return { model, meta, source, sync };
}
function first<T>(items: T[]): T {
  const item = items[0];
  if (!item) throw new Error("Missing test fixture");
  return item;
}

describe("Studio source projection", () => {
  test("coalesces notes, completes only with a response, credits once, then opens a new episode", () => {
    const f = fixture(); f.sync();
    const pending = first(f.meta.studio).pending;
    expect(pending).not.toBeNull();
    const initial = JSON.stringify(f.model);
    f.sync(); expect(JSON.stringify(f.model)).toBe(initial);
    first(f.source.threads).notes.push(note("2026-11-01T09:30:00Z"));
    first(f.source.threads).notes[0] = { ...note(), status: "kept" };
    first(f.source.threads).material.push({ kind: "link", label: "A new source" });
    f.sync(); expect(first(f.meta.studio).pending).toEqual(pending); expect(f.model.log).toHaveLength(0);
    first(f.source.threads).responses.push({ at: responseAt, re: "2026-11-01T09:30:00Z", text: "Use the small sketch." });
    f.sync(); f.sync();
    expect(f.model.log).toHaveLength(1);
    expect(findNode(f.model.outline, pending?.id ?? "")?.done).toBe(true);
    expect(first(f.meta.studio).pending).toBeNull();
    first(f.source.threads).notes.push(note("2026-11-01T11:00:00Z"));
    f.sync();
    expect(first(f.meta.studio).pending?.id).not.toBe(pending?.id);
    expect(f.model.log).toHaveLength(1);
  });
  test("baselines old responses and gives no retroactive credit across legacy rename or directory changes", () => {
    const f = fixture();
    first(f.source.threads).responses.push({ at: responseAt, text: "Already answered." });
    f.sync(); expect(f.model.log).toHaveLength(0); expect(first(f.meta.studio).pending).toBeNull();
    first(f.source.threads).path = "threads/renamed.md"; first(f.source.threads).slug = "renamed";
    f.sync(); expect(f.meta.studio).toHaveLength(2); expect(f.model.log).toHaveLength(0);
    f.source.namespace = "directory-two"; f.sync(); expect(f.meta.studio).toHaveLength(3); expect(f.model.log).toHaveLength(0);
  });
  test("stable UUID survives slug rename and first-area move while preserving scheduling edits and manual children", () => {
    const f = fixture(); first(f.source.threads).id = crypto.randomUUID(); f.sync();
    const entry = first(f.meta.studio);
    const project = findNode(f.model.outline, entry.projectId);
    if (!project) throw new Error("Missing project");
    project.weight = 72; project.focusMonth = "2026-11";
    project.children.push({ id: "manual", title: "My task", weight: 20, ordering: "parallel", effort: 2, children: [] });
    const task = findNode(f.model.outline, entry.pending?.id ?? "");
    if (!task) throw new Error("Missing response task");
    task.deferredUntil = "2026-11-03"; task.weight = 31;
    first(f.source.threads).slug = "renamed"; first(f.source.threads).path = "threads/renamed.md"; first(f.source.threads).areas = ["other", "lab"];
    f.sync();
    expect(f.meta.studio).toHaveLength(1);
    expect(findNode(f.model.outline, "area:other")?.children[0]?.id).toBe(entry.projectId);
    expect(project).toMatchObject({ weight: 72, focusMonth: "2026-11" });
    expect(task).toMatchObject({ weight: 31, deferredUntil: "2026-11-03" });
    expect(findNode(project, "manual")?.title).toBe("My task");
  });
  test("park, close, removal, unknown area, duplicate UUID and disabled source stop scheduling without deleting history", () => {
    for (const variant of ["parked", "closed", "removed", "unknown", "duplicate", "disabled"]) {
      const f = fixture(); const id = crypto.randomUUID(); first(f.source.threads).id = id; f.sync();
      const projectId = first(f.meta.studio).projectId;
      if (variant === "parked" || variant === "closed") first(f.source.threads).state = variant;
      if (variant === "removed" || variant === "disabled") f.source.threads = [];
      if (variant === "unknown") first(f.source.threads).areas = ["absent", "lab"];
      if (variant === "duplicate") f.source.threads.push({ ...thread(), id, slug: "duplicate", path: "threads/duplicate.md" });
      f.sync();
      expect(findNode(f.model.outline, projectId)?.done).toBe(true);
      expect(selectToday(f.model, "2026-11-01")).toHaveLength(0);
      expect(findNode(f.model.outline, projectId)).not.toBeNull();
    }
  });
  test("source-owned titles and response completion reject manual bypass while scheduling edits survive", () => {
    const db = initDatabase(":memory:");
    try {
      const input: StudioProjection = { namespace: "source", threads: [thread()] };
      const view = readMyDay(db, desk, now, input);
      const task = first(view.items).task;
      const change = (command: Parameters<typeof changeMyDay>[0]["command"]) => changeMyDay({ db, desk, now, date: localDay(now), requestId: crypto.randomUUID(), command, studio: input });
      expect(() => change({ op: "done", id: task.id })).toThrow("Respond in the Studio");
      expect(() => change({ op: "edit", id: task.id, title: "Changed title", weight: 10, dueDate: "", focus: false, yes: false, before: { title: task.title, weight: task.weight, dueDate: "" } })).toThrow("Studio thread file");
      const html = renderToStaticMarkup(createElement(MyDayLane, { day: view, onChanged: () => {} }));
      expect(html).toContain("Respond in Studio");
      expect(html).not.toContain(">Done</button>");
    } finally { db.close(); }
  });
});

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function git(dir: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());
}
async function repository() {
  const dir = await mkdtemp(join(tmpdir(), "studio-outline-")); directories.push(dir);
  await mkdir(join(dir, "threads")); await git(dir, "init"); await git(dir, "config", "user.name", "Test Author"); await git(dir, "config", "user.email", "author@example.test");
  const text = `---\ntype: question\nareas: [lab]\nstate: active\nopened: 2026-11-01\n---\n## Question\nWhich sketch?\n## Where I stand\nTry one.\n## Ivy's notes\n### ${noteAt}\ntrigger: A design check\nmodel: local\n\nTry a small sketch.\n## Log\n`;
  await writeFile(join(dir, "threads/design.md"), text); await git(dir, "add", "."); await git(dir, "commit", "-m", "Fixture");
  return { dir, text, options: { ...desk, studio: { dir, maxActive: 5 } } };
}
test("actual respond endpoint syncs before any My day read, survives retry and restart, and fails closed for malformed files", async () => {
  const repo = await repository();
  const db = initDatabase(":memory:");
  try {
    saveBalanceState(db, state());
    const runtime: DeskRuntime = { options: repo.options, ledger: new HandledLedger() };
    const payload = { act: "respond", thread: "design", text: "Use the small sketch.", requestId: "response-fixture-0001" };
    const request = () => new Request("http://localhost/api/desk/studio/act", { method: "POST", body: JSON.stringify(payload) });
    const deps = { db, now: () => new Date(responseAt) };
    expect((await handleDeskStudioAct(request(), runtime, deps)).status).toBe(200);
    expect(loadBalanceState(db)?.log).toHaveLength(1);
    expect((await handleDeskStudioAct(request(), runtime, deps)).status).toBe(200);
    await readStudioMyDay(db, repo.options, now);
    expect(loadBalanceState(db)?.log).toHaveLength(1);
    const saved = await readFile(join(repo.dir, "threads/design.md"), "utf8");
    expect(parseThreadFile("threads/design.md", saved).ok).toBe(true);
    await rename(join(repo.dir, "threads/design.md"), join(repo.dir, "threads/renamed.md"));
    await readStudioMyDay(db, repo.options, now);
    expect(loadBalanceState(db)?.log).toHaveLength(1);
    await writeFile(join(repo.dir, "threads/renamed.md"), repo.text.replace("type: question", "studioId: invalid-uuid\ntype: question"));
    const view = await readStudioMyDay(db, repo.options, now);
    expect(view.items).toHaveLength(0);
    expect(loadBalanceState(db)?.log).toHaveLength(1);
  } finally { db.close(); }
});

test("a committed response before projection recovery earns credit once after reopening SQLite", async () => {
  const repo = await repository();
  const directory = await mkdtemp(join(tmpdir(), "studio-projection-db-")); directories.push(directory);
  const path = join(directory, "projection.sqlite");
  const db = initDatabase(path);
  await readStudioMyDay(db, repo.options, now);
  const result = await runStudioAct({ options: repo.options.studio, areas: desk.areas, requestId: "crash-fixture-response", act: { act: "respond", thread: "design", text: "The smaller sketch." }, now: new Date(responseAt) });
  expect(result.ok).toBe(true);
  expect(loadBalanceState(db)?.log).toHaveLength(0);
  db.close();
  const reopened = initDatabase(path);
  try {
    await readStudioMyDay(reopened, repo.options, now);
    await readStudioMyDay(reopened, repo.options, now);
    expect(loadBalanceState(reopened)?.log).toHaveLength(1);
  } finally { reopened.close(); }
});

test("busy source leaves the saved projection intact and a pre-response refusal is structured", async () => {
  const repo = await repository(); const db = initDatabase(":memory:");
  try {
    await readStudioMyDay(db, repo.options, now);
    const before = loadBalanceState(db);
    const release = await acquireStudioLock(repo.dir);
    if (!release) throw new Error("Missing fixture lock");
    try {
      const view = await readStudioMyDay(db, repo.options, now);
      expect(view.studioStatus).toBe("unavailable"); expect(loadBalanceState(db)).toEqual(before);
      const response = await handleDeskStudioAct(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ act: "respond", thread: "design", text: "A response", requestId: "locked-response-fixture" }) }), { options: repo.options, ledger: new HandledLedger() }, { db });
      expect(response.status).toBe(409);
      expect(await readFile(join(repo.dir, "threads/design.md"), "utf8")).toBe(repo.text);
    } finally { await release(); }
  } finally { db.close(); }
});
test("successful file commit remains successful if post-commit projection is unavailable, then recovers once", async () => {
  const repo = await repository(); const db = initDatabase(":memory:");
  const held = join(repo.dir, ".git/studio-write.lock");
  class ContendedAfterCommit extends StudioWriteLock {
    override release(dir: string): void { super.release(dir); mkdirSync(held); }
  }
  try {
    const res = await handleDeskStudioAct(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ act: "respond", thread: "design", text: "A saved response", requestId: "post-commit-contention" }) }), { options: repo.options, ledger: new HandledLedger() }, { db, now: () => new Date(responseAt), lock: new ContendedAfterCommit() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, replayed: false });
    expect(loadBalanceState(db)?.log).toHaveLength(0);
    expect(await readFile(join(repo.dir, "threads/design.md"), "utf8")).toContain("A saved response");
    await rm(held, { recursive: true });
    await readStudioMyDay(db, repo.options, now); await readStudioMyDay(db, repo.options, now);
    expect(loadBalanceState(db)?.log).toHaveLength(1);
  } finally { db.close(); }
});
test("owned studioId validates UUIDs while unrelated legacy id metadata remains readable", async () => {
  const repo = await repository();
  expect(parseThreadFile("threads/design.md", repo.text.replace("type: question", "id: external-reference-42\ntype: question")).ok).toBe(true);
  expect(parseThreadFile("threads/design.md", repo.text.replace("type: question", "studioId: bad\ntype: question")).ok).toBe(false);
});
test("a note and response arriving between projections form one new episode without retro-credit", () => {
  const f = fixture(); first(f.source.threads).notes = []; f.sync();
  first(f.source.threads).notes = [note()]; first(f.source.threads).responses = [{ at: responseAt, text: "A fresh response" }];
  f.sync(); f.sync(); expect(f.model.log).toHaveLength(1); expect(first(f.meta.studio).pending).toBeNull();
});

test("duplicate owned source UUIDs refuse actual response writes without credit", async () => {
  const repo = await repository(); const db = initDatabase(":memory:");
  try {
    const id = crypto.randomUUID(); const text = repo.text.replace("type: question", `studioId: ${id}\ntype: question`);
    await writeFile(join(repo.dir, "threads/design.md"), text); await writeFile(join(repo.dir, "threads/duplicate.md"), text);
    await git(repo.dir, "add", "."); await git(repo.dir, "commit", "-m", "Duplicate fixture");
    const res = await handleDeskStudioAct(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ act: "respond", thread: "design", text: "Must not save", requestId: "duplicate-id-response" }) }), { options: repo.options, ledger: new HandledLedger() }, { db });
    expect(res.status).toBe(409);
    expect(await readFile(join(repo.dir, "threads/design.md"), "utf8")).toBe(text);
    expect(loadBalanceState(db)?.log ?? []).toHaveLength(0);
  } finally { db.close(); }
});

test("a successful source projection seeds an empty proposed draft after an unavailable first read", () => {
  const db = initDatabase(":memory:");
  try {
    expect(readMyDay(db, desk, now).items).toHaveLength(0);
    const input: StudioProjection = { namespace: "source", threads: [thread()] };
    expect(readMyDay(db, desk, now, input).items).toHaveLength(1);
    const started = changeMyDay({ db, desk, now, date: localDay(now), requestId: crypto.randomUUID(), command: { op: "start", ids: [] }, studio: input });
    expect(started.view.items).toHaveLength(0);
    expect(readMyDay(db, desk, now, input).items).toHaveLength(0);
  } finally { db.close(); }
});

test("actual unavailable-to-available source fills only an empty proposal and respects deferral", async () => {
  const repo = await repository(); const db = initDatabase(":memory:");
  try {
    const release = await acquireStudioLock(repo.dir);
    if (!release) throw new Error("Missing fixture lock");
    try { const unavailable = await readStudioMyDay(db, repo.options, now); expect(unavailable.studioStatus).toBe("unavailable"); expect(unavailable.items).toHaveLength(0); }
    finally { await release(); }
    const available = await readStudioMyDay(db, repo.options, now);
    expect(available.studioStatus).toBe("synced"); expect(available.items).toHaveLength(1);
    const id = first(available.items).task.id;
    changeMyDay({ db, desk: repo.options, now, date: localDay(now), requestId: crypto.randomUUID(), command: { op: "defer", id } });
    changeMyDay({ db, desk: repo.options, now, date: localDay(now), requestId: crypto.randomUUID(), command: { op: "draft", ids: [] } });
    expect((await readStudioMyDay(db, repo.options, now)).items).toHaveLength(0);
  } finally { db.close(); }
});
test("source arrival preserves a nonempty proposed day", () => {
  const db = initDatabase(":memory:");
  try {
    const seeded = state();
    first(seeded.outline.children).children.push({ id: "chosen", title: "My chosen task", weight: 50, ordering: "parallel", children: [], effort: 1 });
    saveBalanceState(db, seeded);
    expect(readMyDay(db, desk, now).items.map(i => i.task.id)).toEqual(["chosen"]);
    const input: StudioProjection = { namespace: "source", threads: [thread()] };
    expect(readMyDay(db, desk, now, input).items.map(i => i.task.id)).toEqual(["chosen"]);
  } finally { db.close(); }
});

test("an unreadable different source does not block parking a healthy thread", async () => {
  const repo = await repository(); const db = initDatabase(":memory:");
  try {
    await writeFile(join(repo.dir, "threads/broken.md"), "A malformed unrelated source.");
    await git(repo.dir, "add", "."); await git(repo.dir, "commit", "-m", "Malformed fixture");
    const prior = await runStudioAct({ options: repo.options.studio, areas: desk.areas, requestId: "direct-prior-healthy-park", act: { act: "park", thread: "design" } });
    expect(prior.ok).toBe(true);
    const reset = await runStudioAct({ options: repo.options.studio, areas: desk.areas, requestId: "direct-healthy-unpark", act: { act: "unpark", thread: "design" } });
    expect(reset.ok).toBe(true);
    const response = await handleDeskStudioAct(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ act: "park", thread: "design", requestId: "healthy-park-fixture" }) }), { options: repo.options, ledger: new HandledLedger() }, { db });
    expect(response.status).toBe(200);
    const parsed = parseThreadFile("threads/design.md", await readFile(join(repo.dir, "threads/design.md"), "utf8"));
    expect(parsed.ok && parsed.value.state).toBe("parked");
    expect((await readStudioMyDay(db, repo.options, now)).studioStatus).toBe("unavailable");
    expect(loadBalanceState(db)?.log ?? []).toHaveLength(0);
  } finally { db.close(); }
});
