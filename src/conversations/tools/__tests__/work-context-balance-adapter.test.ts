import { describe, expect, test } from "bun:test";
import { loadBalanceState } from "../../../surface/mc/desk/balance-store";
import { savedNode, type BalanceReadRig } from "../../domain-adapters/__tests__/fixtures/balance-read-fixtures";
import { openBalanceReadRigForTest as open } from "../../domain-adapters/__tests__/fixtures/balance-test-rig";
import { legacyTask, queryFor, sessionOf } from "../../domain-adapters/__tests__/fixtures/balance-work-fixtures";
import { balanceWorkReaders } from "../../../surface/mc/desk/balance-work-reader";
import { workContextTools, type WorkObject, type WorkOwner } from "../work-context";

interface CallResult { readonly text: string; readonly remembered: WorkObject[] }
async function call(rig: BalanceReadRig, policy: "local" | "cloud", name: "work_search" | "work_read", input: object, enabled = true, transport: "web" | "discord" = "web", queryPolicy: "local" | "cloud" = "cloud"): Promise<CallResult> {
  const remembered: WorkObject[] = [];
  const owner: WorkOwner = {
    readers: () => ({ "balance-task": legacyTask, "balance-project": legacyTask }),
    ...(enabled ? { queries: () => balanceWorkReaders(queryFor(rig, queryPolicy)) } : {}),
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
    const read = JSON.parse((await call(rig, "local", "work_read", { kind: "balance-project", id: "project-glider" })).text);
    expect(read).toMatchObject({ status: "stale", object: { id: "project-glider", title: "Glider", area: "Lab", summary: "Project in Lab", url: "?desk=balance&balance-item=project-glider" } });
  });

  test("a bounded page is partial and an empty page with a continuation is not no match", async () => {
    const rig = await open();
    const bounded = JSON.parse((await call(rig, "local", "work_search", { query: "", kinds: ["balance-task"], limit: 1, offset: 0 })).text);
    expect(bounded.status).toBe("partial");
    expect(bounded.coverage).toBe("partial");
    expect(bounded.next).not.toBeNull();
    const empty = JSON.parse((await call(rig, "cloud", "work_search", { query: "", kinds: ["balance-task"], limit: 1, offset: 0 }, true, "web", "local")).text);
    expect(empty.status).toBe("partial");
    expect(empty.results).toEqual([]);
    expect(empty.next).not.toBeNull();
  });

  test("a removed area or local-only policy returns nothing and no denied name or count", async () => {
    const rig = await open();
    const denied = JSON.parse((await call(rig, "cloud", "work_search", { query: "", kinds: ["balance-task"], limit: 1, offset: 0 }, true, "web", "local")).text);
    expect(denied.status).toBe("partial");
    expect(denied.results).toEqual([]);
    expect(denied.restricted).toBe(false);
    const local = JSON.parse((await call(rig, "cloud", "work_read", { kind: "balance-task", id: "task-wing" }, true, "web", "local")).text);
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
    const searched = JSON.parse((await call(rig, "local", "work_search", { query: "", kinds: ["balance-task"], limit: 5, offset: 0 }, false)).text);
    expect(searched.status).toBe("ok");
    expect(searched.results.map((result: { id: string }) => result.id)).toEqual(["task-legacy"]);
    expect(searched.remembered).toBeUndefined();
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
    const home = { ...queryFor(rig, "cloud"), areas: [{ id: "area-home", label: "Home" }] };
    const remembered: WorkObject[] = [];
    const owner: WorkOwner = { readers: () => ({}), queries: () => balanceWorkReaders(home), now: () => Date.now(), remember: async (_session, objects) => { remembered.push(...objects); return true; } };
    const tool = workContextTools(owner).find(candidate => candidate.name === "work_search");
    if (!tool) throw new Error("missing work_search");
    const text = await tool.run({ query: "", kinds: ["balance-task"], limit: 1, offset: 0 }, { project: null, graph: null, projects: [], session: sessionOf(rig, "local"), signal: new AbortController().signal });
    const found = JSON.parse(typeof text === "string" ? text : text.text);
    expect(found.status).toBe("denied");
    expect(found.restricted).toBe(true);
    expect(found.results).toEqual([]);
    expect(JSON.stringify(found)).not.toContain("Home");
    expect(JSON.stringify(found)).not.toContain("Water the garden");
    expect(remembered).toEqual([]);
  });
});
