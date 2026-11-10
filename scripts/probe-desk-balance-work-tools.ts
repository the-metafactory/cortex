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
    const run = async (held: WorkOwner, name: "work_search" | "work_read", input: object): Promise<Record<string, any>> => {
      const tool = workContextTools(held).find(candidate => candidate.name === name);
      if (!tool) throw new Error(`missing tool ${name}`);
      const text = await tool.run(input, { project: null, graph: null, projects: [], session, signal: new AbortController().signal });
      return JSON.parse(typeof text === "string" ? text : text.text);
    };
    const answering = (): WorkOwner => ({ readers: () => ({}), queries: () => balanceWorkReaders(queryFor(rig)), now: () => Date.now(), remember: async () => true });
    const state = loadBalanceState(rig.db);
    assert.ok(state);
    const search = await run(owner(true), "work_search", { query: "wing", kinds: ["balance-task"], limit: 5, offset: 0 });
    assert.equal(search.status, "ok");
    const saved = state.outline.children.flatMap(area => area.children).flatMap(child => child.children).find(node => node.id === "task-wing");
    assert.ok(saved);
    assert.equal(search.results[0]?.id, saved.id);
    assert.equal(search.results[0]?.title, saved.title);
    assert.equal(search.results[0]?.status, saved.done === true ? "done" : "open");
    assert.deepEqual(remembered, ["balance-task:task-wing:cloud"]);
    console.log("work_search: runner objects match loadBalanceState and record the owner source obligation");

    const read = await run(owner(true), "work_read", { kind: "balance-task", id: "task-wing" });
    assert.equal(read.object?.title, saved.title);
    assert.equal(read.object?.area, "Lab");
    assert.deepEqual(remembered, ["balance-task:task-wing:cloud", "balance-task:task-wing:cloud"]);
    console.log("work_read: runner object matches loadBalanceState and records the owner source obligation");

    const bounded = await run(owner(true), "work_search", { query: "", kinds: ["balance-task"], limit: 1, offset: 0 });
    assert.equal(bounded.status, "partial");
    assert.equal(bounded.coverage, "partial");
    assert.notEqual(bounded.next, null);
    console.log("bounded page: coverage is partial and a continuation is exposed");

    const tail = await run(owner(true), "work_search", { query: "", kinds: ["balance-task"], limit: 5, offset: 5 });
    assert.deepEqual(tail.results, []);
    assert.equal(tail.next, null);
    assert.equal(tail.status, "empty");
    console.log("exhausted tail: an offset past the last task ends the walk instead of repeating a continuation");

    const home = { ...query, areas: [{ id: "area-home", label: "Home", policy: "cloud" as const }] };
    const homeOwner: WorkOwner = { readers: () => ({}), queries: () => balanceWorkReaders(home), now: () => Date.now(), remember: async () => true };
    const denied = await run(homeOwner, "work_search", { query: "", kinds: ["balance-task"], limit: 1, offset: 0 });
    assert.equal(denied.status, "denied");
    assert.equal(denied.restricted, true);
    assert.deepEqual(denied.results, []);
    assert.ok(!JSON.stringify(denied).includes("Home"));
    assert.ok(!JSON.stringify(denied).includes("Water the garden"));
    console.log("denied destination: no names or counts are released");

    await rig.allowHome();
    const widened = answering();
    const widenedSearch = await run(widened, "work_search", { query: "garden", kinds: ["balance-task"], limit: 5, offset: 0 });
    assert.equal(widenedSearch.status, "ok");
    assert.deepEqual(widenedSearch.results.map((result: { id: string }) => result.id), ["task-garden"]);
    const widenedRead = await run(widened, "work_read", { kind: "balance-task", id: "task-garden" });
    assert.equal(widenedRead.object?.area, "Home");
    console.log("second configured area: search and read reach the task instead of reporting it gone");

    rig.removeTask("task-wing");
    const deleted = await run(owner(true), "work_read", { kind: "balance-task", id: "task-wing" });
    assert.equal(deleted.status, "gone");
    assert.ok(!JSON.stringify(deleted).includes("Cut the wing"));
    console.log("deleted task: work_read reports gone without historic evidence");

    const offline = await run(owner(false), "work_read", { kind: "balance-task", id: "task-legacy" });
    assert.equal(offline.status, "ok");
    assert.equal(offline.object?.id, "task-legacy");
    console.log("connection off: the legacy WorkReader remains the answering path");
  } finally {
    await rig.close();
  }
});
