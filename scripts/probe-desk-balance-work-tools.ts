import { strict as assert } from "node:assert";
import { withTempHome } from "./probe-temp-home";
import { loadBalanceState } from "../src/surface/mc/desk/balance-store";
import { openBalanceReadRig } from "../src/conversations/domain-adapters/__tests__/fixtures/balance-read-fixtures";
import { legacyTask, queryFor, sessionOf } from "../src/conversations/domain-adapters/__tests__/fixtures/balance-work-fixtures";
import { balanceWorkReaders } from "../src/surface/mc/desk/balance-work-reader";
import { workContextTools, type WorkOwner } from "../src/conversations/tools/work-context";

await withTempHome(async () => {
  const rig = await openBalanceReadRig();
  try {
    const query = queryFor(rig);
    const session = sessionOf(rig, "local");
    const remembered: string[] = [];
    const owner = (active: boolean): WorkOwner => ({
      readers: () => ({ "balance-task": legacyTask }),
      ...(active ? { queries: () => balanceWorkReaders(query) } : {}),
      now: () => Date.now(),
      remember: async (_session, objects) => { remembered.push(...objects.map(object => `${object.kind}:${object.id}:${object.policy}`)); return true; },
    });
    const run = async (active: boolean, name: "work_search" | "work_read", input: object): Promise<Record<string, any>> => {
      const tool = workContextTools(owner(active)).find(candidate => candidate.name === name);
      if (!tool) throw new Error(`missing tool ${name}`);
      const text = await tool.run(input, { project: null, graph: null, projects: [], session, signal: new AbortController().signal });
      return JSON.parse(typeof text === "string" ? text : text.text);
    };
    const state = loadBalanceState(rig.db);
    assert.ok(state);
    const search = await run(true, "work_search", { query: "wing", kinds: ["balance-task"], limit: 5, offset: 0 });
    assert.equal(search.status, "ok");
    const saved = state.outline.children.flatMap(area => area.children).flatMap(child => child.children).find(node => node.id === "task-wing");
    assert.ok(saved);
    assert.equal(search.results[0]?.id, saved.id);
    assert.equal(search.results[0]?.title, saved.title);
    assert.equal(search.results[0]?.status, saved.done === true ? "done" : "open");
    assert.deepEqual(remembered, ["balance-task:task-wing:cloud"]);
    console.log("work_search: runner objects match loadBalanceState and record the owner source obligation");

    const read = await run(true, "work_read", { kind: "balance-task", id: "task-wing" });
    assert.equal(read.object?.title, saved.title);
    assert.equal(read.object?.area, "Lab");
    console.log("work_read: runner object matches loadBalanceState");

    const bounded = await run(true, "work_search", { query: "", kinds: ["balance-task"], limit: 1, offset: 0 });
    assert.equal(bounded.status, "partial");
    assert.equal(bounded.coverage, "partial");
    assert.notEqual(bounded.next, null);
    console.log("bounded page: coverage is partial and a continuation is exposed");

    const home = { ...query, areas: [{ id: "area-home", label: "Home", policy: "cloud" as const }] };
    const homeOwner: WorkOwner = { readers: () => ({}), queries: () => balanceWorkReaders(home), now: () => Date.now(), remember: async () => true };
    const deniedTool = workContextTools(homeOwner).find(candidate => candidate.name === "work_search");
    if (!deniedTool) throw new Error("missing work_search");
    const deniedText = await deniedTool.run({ query: "", kinds: ["balance-task"], limit: 1, offset: 0 }, { project: null, graph: null, projects: [], session, signal: new AbortController().signal });
    const denied = JSON.parse(typeof deniedText === "string" ? deniedText : deniedText.text);
    assert.equal(denied.status, "denied");
    assert.equal(denied.restricted, true);
    assert.deepEqual(denied.results, []);
    assert.ok(!JSON.stringify(denied).includes("Home"));
    assert.ok(!JSON.stringify(denied).includes("Water the garden"));
    console.log("denied destination: no names or counts are released");

    rig.removeTask("task-wing");
    const deleted = await run(true, "work_read", { kind: "balance-task", id: "task-wing" });
    assert.equal(deleted.status, "gone");
    assert.ok(!JSON.stringify(deleted).includes("Cut the wing"));
    console.log("deleted task: work_read reports gone without historic evidence");

    const offline = await run(false, "work_read", { kind: "balance-task", id: "task-legacy" });
    assert.equal(offline.status, "ok");
    assert.equal(offline.object?.id, "task-legacy");
    console.log("connection off: the legacy WorkReader remains the answering path");
  } finally {
    await rig.close();
  }
});
