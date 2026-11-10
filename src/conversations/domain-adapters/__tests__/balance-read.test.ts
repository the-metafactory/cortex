import { afterEach, describe, expect, test } from "bun:test";
import { balanceDestinations } from "../../../surface/mc/desk/balance-destinations";
import { loadBalanceState } from "../../../surface/mc/desk/balance-store";
import { createBalanceReadAdapter } from "../balance/read";
import { objectRef } from "../fixtures";
import { BALANCE_CONNECTION, HOME_AREA, LAB_AREA, openBalanceReadRig, releasedObjects, tasksIn, type BalanceReadRig } from "./fixtures/balance-read-fixtures";

const GLIDER = objectRef("balance", "project", "project-glider");
const opened: BalanceReadRig[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(rig => rig.close())); });
async function open(): Promise<BalanceReadRig> { const rig = await openBalanceReadRig(); opened.push(rig); return rig; }

describe("the inactive Balance read adapter", () => {
  test("balance destinations list configured areas and open projects by canonical identity", async () => {
    const rig = await open();
    const state = loadBalanceState(rig.db);
    if (!state) throw new Error("balance fixture state missing");
    const expected = balanceDestinations(state.outline, rig.areas);
    const page = await rig.destinations();
    const payload = page.payload as { items: { label: string }[] };
    expect(page.annotations.map(annotation => [annotation.ref.objectType, annotation.ref.canonicalId])).toEqual(expected.map(destination => [destination.project ? "project" : "area", destination.project ? destination.id : destination.area]));
    expect(payload.items.map(item => item.label)).toEqual(expected.map(destination => destination.label));
    for (const [index, annotation] of page.annotations.entries()) {
      expect(annotation.ref.canonicalId).not.toBe(payload.items[index]?.label);
      expect(annotation.destination).toEqual(annotation.ref);
      expect(annotation.schemaRef.schemaId).toBe(annotation.ref.objectType === "project" ? "balance.project" : "balance.area");
    }
    expect(rig.destinationsBinding.display).toEqual({ title: "/label" });
    expect(rig.rig.bindings.readBindings?.lookup("balance", BALANCE_CONNECTION, "balance.destinations")).toMatchObject({ state: "available" });
    expect(rig.adapter.bindings.observations).toEqual({});
  });

  test("task query and task read match the saved outline and declare display pointers", async () => {
    const rig = await open();
    const state = loadBalanceState(rig.db);
    if (!state) throw new Error("balance fixture state missing");
    const source = tasksIn(state, "area-example");
    const query = await rig.taskQuery();
    expect(query.result.status).toBe("ok");
    expect(query.result.groups[0]?.coverage).toBe("exhausted");
    const queried = releasedObjects(query.released);
    expect(queried.map(object => object.ref.canonicalId)).toEqual(source.map(node => node.id));
    expect(queried.map(object => [object.value.title, object.value.status, object.value.dueDate])).toEqual(source.map(node => [node.title, node.done ? "done" : "open", node.dueDate ?? null]));
    expect(queried[0]?.value).toMatchObject({ area: LAB_AREA, project: GLIDER, summary: "open · due 2026-12-01 · Lab", note: "Use paper", effort: 2 });
    expect(queried[1]?.value).toMatchObject({ area: LAB_AREA, project: GLIDER, summary: "done · Lab" });
    expect(queried[2]?.value).toMatchObject({ area: LAB_AREA, project: null, summary: "open · Lab" });
    expect(rig.taskQueryBinding.display).toEqual({ title: "/title", summary: "/summary", status: "/status", due: "/dueDate", area: "/area" });
    const read = await rig.taskRead("task-wing");
    expect(read.result.status).toBe("ok");
    expect(read.result.groups[0]?.coverage).toBe("exhausted");
    const [task] = releasedObjects(read.released);
    expect(task?.ref.canonicalId).toBe("task-wing");
    expect(task?.value).toMatchObject({ title: "Cut the wing", status: "open", dueDate: "2026-12-01", area: LAB_AREA });
  });

  test("a deleted task reads as unavailable and asserts nothing about historic operations", async () => {
    const rig = await open();
    const before = rig.rig.calls.sends.length;
    rig.removeTask("task-wing");
    const read = await rig.taskRead("task-wing");
    expect(read.result.status).toBe("unavailable");
    expect(read.released).toBeUndefined();
    expect(rig.rig.calls.sends.length).toBe(before);
    const text = JSON.stringify(read.result);
    expect(text).not.toContain("Cut the wing");
    expect(text).not.toMatch(/operation|receipt|history/i);
  });

  test("an area outside the connection or removed from configuration denies reads without names or counts", async () => {
    const rig = await open();
    const calls = rig.rig.calls.read;
    const denied = await rig.taskQuery({ area: HOME_AREA }, [HOME_AREA]);
    expect(denied.result.status).toBe("denied");
    expect(denied.result.restricted).toBe(true);
    expect(rig.rig.calls.read).toBe(calls);
    expect(denied.released).toBeUndefined();
    expect(JSON.stringify(denied.result)).not.toContain("Home");
    expect(JSON.stringify(denied.result)).not.toContain("Water the garden");
    await rig.allowHome();
    rig.removeArea("area-home");
    const missing = await rig.taskQuery({ area: HOME_AREA }, [HOME_AREA]);
    expect(missing.result.status).toBe("unavailable");
    expect(missing.released).toBeUndefined();
    expect(JSON.stringify(missing.result)).not.toContain("Home");
    expect(JSON.stringify(missing.result)).not.toContain("Water the garden");
    const read = await rig.taskRead("task-garden", HOME_AREA, [HOME_AREA]);
    expect(read.result.status).toBe("unavailable");
    expect(read.released).toBeUndefined();
  });

  test("creating the adapter enables no connection and leaves stored state and authority records unchanged", async () => {
    const rig = await open();
    const records = JSON.stringify(await rig.rig.service.inspectHostRecords());
    const state = JSON.stringify(loadBalanceState(rig.db));
    const another = createBalanceReadAdapter({ connectionId: BALANCE_CONNECTION, state: () => loadBalanceState(rig.db), areas: () => rig.areas });
    expect(another.bindings.observations).toEqual({});
    await another.query({ readVersion: "1.0.0", queryId: "query-example", capabilityId: "balance.task.query", input: { area: LAB_AREA }, destinations: [LAB_AREA], limit: 20 });
    await another.destinations();
    expect(JSON.stringify(await rig.rig.service.inspectHostRecords())).toBe(records);
    expect(JSON.stringify(loadBalanceState(rig.db))).toBe(state);
  });
});
