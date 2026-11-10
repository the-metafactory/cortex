import { describe, expect, test } from "bun:test";
import { loadBalanceState } from "../../../surface/mc/desk/balance-store";
import { leaf, savedNode, type BalanceReadRig } from "../../domain-adapters/__tests__/fixtures/balance-read-fixtures";
import { openBalanceReadRigForTest as open } from "../../domain-adapters/__tests__/fixtures/balance-test-rig";
import { legacyTask, queryFor, sessionOf } from "../../domain-adapters/__tests__/fixtures/balance-work-fixtures";
import { balanceWorkReaders, type BalanceWorkArea } from "../../../surface/mc/desk/balance-work-reader";
import { workContextTools, type WorkObject, type WorkOwner } from "../work-context";

interface CallResult { readonly text: string; readonly remembered: WorkObject[] }
interface CallOptions { readonly enabled?: boolean; readonly transport?: "web" | "discord"; readonly queryPolicy?: "local" | "cloud"; readonly areas?: readonly BalanceWorkArea[] }
async function call(rig: BalanceReadRig, policy: "local" | "cloud", name: "work_search" | "work_read", input: object, options: CallOptions = {}): Promise<CallResult> {
  const { enabled = true, transport = "web", queryPolicy = "cloud", areas } = options;
  const remembered: WorkObject[] = [];
  const query = queryFor(rig, queryPolicy);
  const owner: WorkOwner = {
    readers: () => ({ "balance-task": legacyTask, "balance-project": legacyTask }),
    ...(enabled ? { queries: () => balanceWorkReaders(areas ? { ...query, areas } : query) } : {}),
    now: () => Date.now(),
    remember: async (_session, objects) => { remembered.push(...objects); return true; },
  };
  const tool = workContextTools(owner).find(candidate => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  const text = await tool.run(input, { project: null, graph: null, projects: [], session: sessionOf(rig, policy, transport), signal: new AbortController().signal });
  return { text: typeof text === "string" ? text : text.text, remembered };
}

describe("the Balance work adapter behind work_search and work_read", () => {
  test("an enabled connection answers from the runner and records the same source obligations", async () => {
    const rig = await open();
    const sends = rig.rig.calls.sends.length;
    const searched = await call(rig, "local", "work_search", { query: "wing", kinds: ["balance-task"], limit: 5, offset: 0 });
    const found = JSON.parse(searched.text);
    expect(found.status).toBe("ok");
    expect(found.coverage).toBe("exhausted");
    expect(found.results.map((result: { id: string }) => result.id)).toEqual(["task-wing"]);
    expect(searched.remembered.map(object => `${object.kind}:${object.id}`)).toEqual(["balance-task:task-wing"]);
    expect(searched.remembered[0]?.policy).toBe("cloud");
    const read = await call(rig, "local", "work_read", { kind: "balance-task", id: "task-wing" });
    const object = JSON.parse(read.text);
    expect(object).toMatchObject({ status: "stale", object: { id: "task-wing", title: "Cut the wing", status: "open", area: "Lab", freshness: "stale", url: "?desk=balance&balance-item=task-wing" } });
    expect(read.remembered.map(remembered => remembered.id)).toEqual(["task-wing"]);
    expect(rig.rig.calls.sends.length).toBeGreaterThan(sends);
  });

  test("projects answer through the same runner as tasks", async () => {
    const rig = await open();
    const searched = await call(rig, "local", "work_search", { query: "glider", kinds: ["balance-project"], limit: 5, offset: 0 });
    const found = JSON.parse(searched.text);
    expect(found.status).toBe("ok");
    expect(found.results.map((result: { id: string }) => result.id)).toEqual(["project-glider"]);
    expect(searched.remembered.map(object => `${object.kind}:${object.id}`)).toEqual(["balance-project:project-glider"]);
    const read = await call(rig, "local", "work_read", { kind: "balance-project", id: "project-glider" });
    expect(JSON.parse(read.text)).toMatchObject({ status: "stale", object: { id: "project-glider", title: "Glider", area: "Lab", summary: "Project in Lab", url: "?desk=balance&balance-item=project-glider" } });
    expect(read.remembered.map(remembered => `${remembered.kind}:${remembered.id}`)).toEqual(["balance-project:project-glider"]);
  });

  test("a second configured area is searched, read and scoped without denying the page", async () => {
    const rig = await open();
    await rig.allowHome();
    const searched = JSON.parse((await call(rig, "local", "work_search", { query: "garden", kinds: ["balance-task"], limit: 5, offset: 0 })).text);
    expect(searched.status).toBe("ok");
    expect(searched.results.map((result: { id: string }) => result.id)).toEqual(["task-garden"]);
    const read = await call(rig, "local", "work_read", { kind: "balance-task", id: "task-garden" });
    expect(JSON.parse(read.text)).toMatchObject({ status: "stale", object: { id: "task-garden", area: "Home" } });
    expect(read.remembered.map(object => object.id)).toEqual(["task-garden"]);
    const projects = JSON.parse((await call(rig, "local", "work_search", { query: "", kinds: ["balance-project"], limit: 5, offset: 0 })).text);
    expect(projects.status).toBe("ok");
    expect(projects.results.map((result: { id: string }) => result.id).sort()).toEqual(["project-empty", "project-glider"]);
  });

  test("a bounded page is partial and an empty page with a continuation is not no match", async () => {
    const rig = await open();
    const bounded = JSON.parse((await call(rig, "local", "work_search", { query: "", kinds: ["balance-task"], limit: 1, offset: 0 })).text);
    expect(bounded.status).toBe("partial");
    expect(bounded.coverage).toBe("partial");
    expect(bounded.next).not.toBeNull();
    const empty = JSON.parse((await call(rig, "cloud", "work_search", { query: "", kinds: ["balance-task"], limit: 1, offset: 0 }, { queryPolicy: "local" })).text);
    expect(empty.status).toBe("partial");
    expect(empty.results).toEqual([]);
    expect(empty.next).not.toBeNull();
  });

  test("a removed area or local-only policy returns nothing and no denied name or count", async () => {
    const rig = await open();
    const denied = JSON.parse((await call(rig, "cloud", "work_search", { query: "", kinds: ["balance-task"], limit: 1, offset: 0 }, { queryPolicy: "local" })).text);
    expect(denied.status).toBe("partial");
    expect(denied.results).toEqual([]);
    expect(denied.restricted).toBe(false);
    const local = JSON.parse((await call(rig, "cloud", "work_read", { kind: "balance-task", id: "task-wing" }, { queryPolicy: "local" })).text);
    expect(local.status).toBe("unauthorized");
    expect(local).not.toHaveProperty("object");
    expect(local).not.toHaveProperty("title");
  });

  test("a deleted task reads as gone", async () => {
    const rig = await open();
    rig.removeTask("task-wing");
    const read = JSON.parse((await call(rig, "local", "work_read", { kind: "balance-task", id: "task-wing" })).text);
    expect(read.status).toBe("gone");
    expect(read).not.toHaveProperty("object");
    expect(read.message).not.toContain("Cut the wing");
  });

  test("the legacy WorkReader still answers when the connection is off", async () => {
    const rig = await open();
    const legacy = await call(rig, "local", "work_search", { query: "", kinds: ["balance-task"], limit: 5, offset: 0 }, { enabled: false });
    const searched = JSON.parse(legacy.text);
    expect(searched.status).toBe("ok");
    expect(searched.results.map((result: { id: string }) => result.id)).toEqual(["task-legacy"]);
    expect(legacy.remembered.map(object => `${object.kind}:${object.id}`)).toEqual(["balance-task:task-legacy"]);
  });

  test("the probe comparison keeps tool output aligned with the saved outline", async () => {
    const rig = await open();
    const state = loadBalanceState(rig.db);
    if (!state) throw new Error("balance fixture state missing");
    const read = JSON.parse((await call(rig, "local", "work_read", { kind: "balance-task", id: "task-wing" })).text);
    const saved = savedNode(state, "task-wing");
    expect(read.object.title).toBe(saved.title);
    expect(read.object.status).toBe(saved.done === true ? "done" : "open");
  });

  test("the home destination remains denied without leaking its task", async () => {
    const rig = await open();
    const home = await call(rig, "local", "work_search", { query: "", kinds: ["balance-task"], limit: 1, offset: 0 }, { areas: [{ id: "area-home", label: "Home" }] });
    const found = JSON.parse(home.text);
    expect(found.status).toBe("denied");
    expect(found.restricted).toBe(true);
    expect(found.results).toEqual([]);
    expect(JSON.stringify(found)).not.toContain("Home");
    expect(JSON.stringify(found)).not.toContain("Water the garden");
    expect(home.remembered).toEqual([]);
  });

  test("later pages reach the tasks of every configured area", async () => {
    const rig = await open();
    await rig.allowHome();
    const seen: string[] = [];
    let continuation: { offset: number } | null = { offset: 0 };
    while (continuation) {
      const page = JSON.parse((await call(rig, "local", "work_search", { query: "", kinds: ["balance-task"], limit: 2, offset: continuation.offset })).text);
      expect(page.status).not.toBe("empty");
      seen.push(...page.results.map((result: { id: string }) => result.id));
      continuation = page.next;
    }
    expect([...seen].sort()).toEqual(["task-done", "task-garden", "task-glue", "task-wing"]);
  });

  test("a long area is walked across sub-pages without duplicates", async () => {
    const rig = await open();
    const bulk = Array.from({ length: 25 }, (_unused, index) => `task-bulk-${index + 1}`);
    for (const id of bulk) rig.addTask("area:area-example", leaf(id, `Bulk ${id}`));
    const seen: string[] = [];
    let continuation: { offset: number } | null = { offset: 0 };
    while (continuation) {
      const page = JSON.parse((await call(rig, "local", "work_search", { query: "", kinds: ["balance-task"], limit: 10, offset: continuation.offset })).text);
      seen.push(...page.results.map((result: { id: string }) => result.id));
      continuation = page.next;
    }
    expect(seen.length).toBe(bulk.length + 3);
    expect(new Set(seen).size).toBe(bulk.length + 3);
    expect([...seen].sort()).toEqual(["task-done", "task-glue", "task-wing", ...bulk].sort());
  });
});
