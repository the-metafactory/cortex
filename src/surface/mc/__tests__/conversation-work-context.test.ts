import type { StudioEvidenceInput } from "../../../conversations/tools/studio-evidence";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type AppState, type OutlineNode } from "../../../balance";
import type { ConversationHost, HostSources } from "../../../conversations/host";
import type { ToolOutcome, TurnRequest } from "../../../conversations/model";
import type { WorkRead, WorkReader } from "../../../conversations/tools/work-context";
import { toolBody } from "../../../conversations/__tests__/fixtures/tool-body";
import { answering, openHost, scratchHosts } from "../../../conversations/__tests__/fixtures/scratch";
import { SCHEMA_SQL } from "../db/schema";
import type { DeskOptions } from "../desk/compose";
import { conversationSources } from "../desk/conversation-sources";
import { loadBalanceState, saveBalanceState } from "../desk/balance-store";
import { studioThreadFile } from "./studio-conversation-rig";
import type { DeskItem } from "../desk/types";

const { dirs, hosts } = scratchHosts("work-context-");
const lane = { provider: "fixture", model: "model" };
const principal = "synthetic-principal";
const databases: Database[] = [];
const studios: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of studios.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const leaf = (id: string, title: string, extra: Partial<OutlineNode> = {}): OutlineNode => ({ id, title, weight: 50, ordering: "parallel", children: [], effort: 1, ...extra });
const outline = (lab: OutlineNode[], home: OutlineNode[]): AppState => ({
  outline: { id: "desk:outline", title: "Outline", weight: 100, ordering: "parallel", children: [
    { id: "area:lab", title: "Lab", weight: 50, ordering: "parallel", children: lab },
    { id: "area:home", title: "Home", weight: 50, ordering: "parallel", children: home },
  ] },
  settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null,
});
const item = (key: string, area: string | null, title: string): DeskItem => ({ key, kind: "agent", source: "synthetic", area, urgency: "soon", title, why: "Synthetic reason.", score: 1, actions: [], detail: { summary: "Synthetic summary.", history: [], refs: [], links: [] } }) as unknown as DeskItem;
async function rig(answer: (request: TurnRequest, call: (name: string, args: object) => Promise<Record<string, any>>) => Promise<string>, options: { studio?: boolean; items?: boolean; wrap?: (sources: HostSources) => HostSources } = {}) {
  const db = new Database(":memory:");
  databases.push(db);
  for (const sql of SCHEMA_SQL) db.run(sql);
  saveBalanceState(db, outline([leaf("task-wing", "Cut the wing", { note: "Glider LOCALWING", dueDate: "2026-12-01" }), { id: "project-glider", title: "Glider", weight: 50, ordering: "parallel", children: [leaf("task-tail", "Fold the tail")] }], [leaf("task-tea", "Buy tea")]));
  const studioDir = mkdtempSync(join(tmpdir(), "work-context-studio-"));
  studios.push(studioDir);
  for (const folder of ["threads", "inbox", "proposals"]) mkdirSync(join(studioDir, folder));
  writeFileSync(join(studioDir, "threads/wing.md"), studioThreadFile("active", "wing"));
  writeFileSync(join(studioDir, "threads/garden.md"), studioThreadFile("active", "garden").replace("areas: [lab]", "areas: [home]"));
  const desk: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", sources: [], areas: [{ id: "lab", label: "Lab", color: "", repos: [], goals: [], policy: "local" }, { id: "home", label: "Home", color: "", repos: [], goals: [], policy: "cloud" }], ...(options.studio === false ? {} : { studio: { dir: studioDir, maxActive: 5 } }) };
  const visible = [item("item-lab", "lab", "Lab item LOCALWING"), item("item-home", "home", "Home item"), item("item-none", null, "Unfiled item")];
  const host = await openHost(hosts, { dir: await dirs.make(), stack: "test", label: "test", expectedLabel: "test", lanes: { local: lane, cloud: lane }, turns: answering(async request => answer(request, async (name, args) => toolBody(await request.tools!.call(randomUUID(), name, args, request.signal)))) });
  const sources = conversationSources({ db, desk: () => desk, ...(options.items === false ? {} : { deskItems: () => Promise.resolve(visible) }) });
  await host.attachSources(options.wrap ? options.wrap(sources) : sources);
  return { host, db, desk, studioDir };
}
const run = async (host: ConversationHost, policy: "local" | "cloud", transport: "web" | "discord" = "web") => {
  const conversation = await host.create({ title: "Reader", policy, links: [], origin: { kind: "web" } }, principal);
  await host.submit(conversation.id, { inputId: randomUUID(), transport, text: "Relate my work.", mode: "queue" });
  await host.waitForIdle(conversation.id);
  return conversation.id;
};

describe("work context tools over the real Studio, Balance and Desk owner reads", () => {
  test("a local conversation relates a Studio thread and a Balance task with owner-confirmed refs and changes nothing", async () => {
    let result: Record<string, any> = {};
    const { host, db, studioDir } = await rig(async (_request, call) => {
      const found = await call("work_search", { query: "wing" });
      const thread = found.results.find((r: any) => r.kind === "studio-thread");
      const task = found.results.find((r: any) => r.kind === "balance-task");
      const threadRead = await call("work_read", { kind: "studio-thread", id: thread.id });
      const taskRead = await call("work_read", { kind: "balance-task", id: task.id });
      result = { found, threadRead, taskRead };
      return "Related.";
    });
    const before = JSON.stringify(loadBalanceState(db));
    const files = Bun.spawnSync(["sh", "-c", `cat ${studioDir}/threads/*.md`]).stdout.toString();
    const reader = await run(host, "local");
    expect(result.found.status).toBe("ok");
    expect(result.found.results.map((r: any) => `${r.kind}:${r.id}`).sort()).toEqual(["balance-task:task-wing", "desk-item:item-lab", "studio-thread:wing"]);
    expect(result.taskRead).toMatchObject({ status: "ok", object: { id: "task-wing", status: "open", area: "Lab", freshness: "fresh", url: "?desk=balance&balance-item=task-wing" } });
    expect(result.threadRead.object.url).toBe("?desk=studio&thread=wing");
    expect(result.threadRead.object.observedAt).toMatch(/^\d{4}-/);
    expect(JSON.stringify(loadBalanceState(db))).toBe(before);
    expect(Bun.spawnSync(["sh", "-c", `cat ${studioDir}/threads/*.md`]).stdout.toString()).toBe(files);
    expect((await host.meta(reader)).policy).toBe("local");
  });

  test.each([["cloud", "web"], ["local", "discord"], ["cloud", "discord"]] as const)("a %s conversation over %s never sees local-area objects", async (policy, transport) => {
    const seen: Record<string, any>[] = [];
    const { host } = await rig(async (_request, call) => {
      seen.push(await call("work_search", { query: "" , limit: 10 }));
      seen.push(await call("work_read", { kind: "balance-task", id: "task-wing" }));
      seen.push(await call("work_read", { kind: "studio-thread", id: "wing" }));
      seen.push(await call("work_read", { kind: "desk-item", id: "item-lab" }));
      seen.push(await call("work_read", { kind: "desk-item", id: "item-none" }));
      return "Checked.";
    });
    const id = await run(host, policy, transport);
    const ids = seen[0]!.results.map((r: any) => `${r.kind}:${r.id}`).sort();
    expect(ids).toEqual(["balance-task:task-tea", "desk-item:item-home", "studio-thread:garden"]);
    expect(JSON.stringify(seen[0])).not.toContain("LOCALWING");
    for (const read of seen.slice(1)) expect(read.status).toBe("unauthorized");
    expect(JSON.stringify(await host.entries(id, 100, undefined))).not.toContain("LOCALWING");
  });

  test("a cloud object read ratchets nothing, a local conversation stays local, and revoking an area withholds the earlier read", async () => {
    let first: Record<string, any> = {};
    let second: Record<string, any> = {};
    const { host, desk } = await rig(async (_request, call) => {
      if (!first.status) first = await call("work_read", { kind: "balance-task", id: "task-wing" });
      else second = await call("work_read", { kind: "balance-task", id: "task-wing" });
      return "ok";
    });
    const id = await run(host, "local");
    expect(first.status).toBe("ok");
    desk.areas = desk.areas.filter(a => a.id !== "lab");
    await expect(host.submit(id, { inputId: randomUUID(), transport: "web", text: "Again.", mode: "queue" })).rejects.toThrow(/no longer authorized/);
    expect(second.status).toBeUndefined();
  });

  test("source removed, unauthorized, empty and unsupported owner reads stay distinct", async () => {
    const seen: Record<string, any> = {};
    const { host, desk } = await rig(async (_request, call) => {
      seen.gone = await call("work_read", { kind: "balance-task", id: "task-missing" });
      seen.wrongKind = await call("work_read", { kind: "balance-project", id: "task-tea" });
      seen.empty = await call("work_search", { query: "nonexistent-needle", kinds: ["balance-task", "studio-thread"] });
      seen.noDeskReader = await call("work_search", { query: "" , kinds: ["desk-item"] });
      seen.noDeskRead = await call("work_read", { kind: "desk-item", id: "item-home" });
      seen.unconfigured = await call("work_read", { kind: "studio-thread", id: "wing" });
      return "ok";
    }, { items: false, studio: false });
    await run(host, "local");
    expect(desk.studio).toBeUndefined();
    expect(seen.gone.status).toBe("gone");
    expect(seen.wrongKind.status).toBe("gone");
    expect(seen.empty.status).toBe("empty");
    expect(seen.noDeskReader).toMatchObject({ status: "unavailable", results: [], unavailable: [{ kind: "desk-item", reason: expect.stringContaining("no read operation") }] });
    expect(seen.noDeskRead.status).toBe("unavailable");
    expect(seen.unconfigured.status).toBe("unavailable");
  });

  test("a stale owner snapshot is shown with its age and flagged", async () => {
    const seen: Record<string, any> = {};
    const hourAgo = Date.now() - 3_600_000;
    const { host } = await rig(async (_request, call) => {
      seen.read = await call("work_read", { kind: "balance-task", id: "task-wing" });
      seen.search = await call("work_search", { query: "wing", kinds: ["balance-task"] });
      return "ok";
    }, { wrap: sources => ({ ...sources, get readers() {
      const readers = sources.readers!;
      const inner = readers["balance-task"]!;
      const old = (r: WorkRead): WorkRead => r.state === "available" ? { state: "available", object: { ...r.object, observedAt: hourAgo } } : r;
      return { ...readers, "balance-task": { read: async (id: string) => old(await inner.read(id)), search: async (query: string, limit: number, offset: number) => { const page = await inner.search(query, limit, offset); return { ...page, items: page.items.map(o => ({ ...o, observedAt: hourAgo })) }; } } satisfies WorkReader };
    } }) });
    await run(host, "local");
    expect(seen.read).toMatchObject({ status: "stale", object: { freshness: "stale", observedAt: new Date(hourAgo).toISOString() } });
    expect(seen.search.results[0].freshness).toBe("stale");
  });

  test("a policy that tightens between listing and release withholds the result", async () => {
    const seen: ToolOutcome[] = [];
    let reads = 0;
    const { host } = await rig(async request => {
      seen.push(await request.tools!.call("search", "work_search", { query: "tea", kinds: ["balance-task"] }, request.signal));
      return "ok";
    }, { wrap: sources => ({ ...sources, get readers() {
      const readers = sources.readers!;
      const inner = readers["balance-task"]!;
      return { ...readers, "balance-task": { search: inner.search, read: async (id: string): Promise<WorkRead> => { const r = await inner.read(id); return ++reads > 1 && r.state === "available" ? { state: "available", object: { ...r.object, policy: "local" } } : r; } } };
    } }) });
    await run(host, "cloud");
    expect(seen[0]?.outcome).toBe("refused");
    expect(seen[0]?.text).toContain("withheld");
    expect(JSON.stringify(seen)).not.toContain("Buy tea");
  });

  test("a cloud conversation pages without repeating a result when earlier rows are hidden", async () => {
    const pages: string[][] = [];
    const { host } = await rig(async (_request, call) => {
      let offset = 0;
      for (let turn = 0; turn < 3 && offset !== null; turn++) {
        const page = await call("work_search", { query: "", kinds: ["balance-task"], limit: 1, offset });
        pages.push(page.results.map((r: any) => r.id));
        offset = page.next?.offset ?? null;
      }
      return "ok";
    });
    await run(host, "cloud");
    expect(pages.flat()).toEqual([...new Set(pages.flat())]);
    expect(pages.flat()).toContain("task-tea");
  });

  test("retained work whose owner reader is gone stops the conversation", async () => {
    const { host } = await rig(async (_request, call) => {
      await call("work_read", { kind: "desk-item", id: "item-home" });
      return "ok";
    });
    const id = await run(host, "cloud");
    const sources = conversationSources({ db: databases[0]!, desk: () => undefined });
    await host.attachSources({ ...sources, readers: {} });
    await expect(host.submit(id, { inputId: randomUUID(), transport: "web", text: "Again.", mode: "queue" })).rejects.toThrow(/no longer authorized/);
  });

  test("a project and its tasks are listed by kind with their own status", async () => {
    const seen: Record<string, any> = {};
    const { host } = await rig(async (_request, call) => {
      seen.projects = await call("work_search", { query: "glider", kinds: ["balance-project"] });
      seen.tail = await call("work_read", { kind: "balance-task", id: "task-tail" });
      return "ok";
    });
    await run(host, "local");
    expect(seen.projects.results.map((r: any) => r.id)).toEqual(["project-glider"]);
    expect(seen.tail).toMatchObject({ status: "ok", object: { id: "task-tail", area: "Lab" } });
  });
});

test.each([["cloud", "web"], ["local", "discord"], ["cloud", "discord"]] as const)("Studio evidence respects %s policy over %s and prevents a thread argument bypassing global evidence restrictions", async (policy, transport) => {
  const results: Record<string, any>[] = [];
  const { host } = await rig(async (_request, call) => {
    results.push(await call("studio_evidence", { scope: "notes", thread: "wing" }));
    results.push(await call("studio_evidence", { scope: "overseer", thread: "garden" }));
    results.push(await call("studio_evidence", { scope: "selections", thread: "garden", run: "11111111-1111-4111-8111-111111111111" }));
    results.push(await call("studio_evidence", { scope: "history", thread: "garden" }));
    results.push(await call("studio_evidence", { scope: "notes", thread: "garden", limit: 1 }));
    return "Inspected.";
  });
  await run(host, policy, transport);
  for (const result of results.slice(0, 4)) expect(result.status).toBe("unauthorized");
  expect(["ok", "empty"]).toContain(results[4]?.status);
});

test("Studio evidence retains owner authorization and withholds a policy change before release", async () => {
  let result: Record<string, any> = {};
  const { host } = await rig(async (_request, call) => {
    result = await call("studio_evidence", { scope: "notes", thread: "garden" });
    return "Inspected.";
  });
  const id = await run(host, "cloud");
  expect(["ok", "empty"]).toContain(result.status);
  await host.attachSources(conversationSources({ db: databases.at(-1)!, desk: () => undefined }));
  await expect(host.submit(id, { inputId: randomUUID(), transport: "web", text: "Continue", mode: "queue" })).rejects.toThrow(/no longer authorized/);
});

test("Studio evidence releases no data when a source tightens during the read", async () => {
  let result: Record<string, any> = {};
  let tightened = false;
  const { host } = await rig(async (_request, call) => {
    result = await call("studio_evidence", { scope: "notes", thread: "garden" });
    return "Inspected.";
  }, { wrap: sources => ({ ...sources, get readers() {
    const readers = sources.readers!;
    const inner = readers["studio-thread"]!;
    return { ...readers, "studio-thread": { ...inner, readMany: undefined, evidence: async (input: StudioEvidenceInput) => {
      const evidence = await inner.evidence!(input); tightened = true; return evidence;
    }, read: async (id: string) => {
      const read = await inner.read(id);
      return tightened && read.state === "available" ? { ...read, object: { ...read.object, policy: "local" as const } } : read;
    } } };
  } }) });
  await run(host, "cloud");
  expect(result.status).toBe("unauthorized");
  expect(JSON.stringify(result)).not.toContain("content");
});

test("cloud tool calls cannot release notes whose execution policy is unavailable", async () => {
  let result: Record<string, any> = {};
  const { host, studioDir } = await rig(async (_request, call) => {
    result = await call("studio_evidence", { scope: "notes", thread: "garden" });
    return "Checked.";
  });
  const path = join(studioDir, "threads/garden.md");
  const content = await Bun.file(path).text();
  writeFileSync(path, content + "\n## Ivy's notes\n### 2026-11-02T12:00:00Z\ntrigger: fixture\nmodel: fixture\nrun: 11111111-1111-4111-8111-111111111111\n\nLOCAL_JOB_PRIVATE_NOTE\n");
  const id = await run(host, "cloud");
  expect(result.status).toBe("unauthorized");
  expect(JSON.stringify(await host.entries(id, 100, undefined))).not.toContain("LOCAL_JOB_PRIVATE_NOTE");
});
