import { afterEach, describe, expect, test } from "bun:test";
import { findNode } from "../../../balance";
import { loadBalanceState, saveBalanceState } from "../../../surface/mc/desk/balance-store";
import { BALANCE_TASK_OBSERVATION_CAPABILITY_ID, BALANCE_TASK_ORDERING, balanceTaskObservationBinding, balanceTaskObservationDeclaration, createBalanceObservationAdapter } from "../balance/observation";
import { balanceReadDeclaration } from "../balance/read";
import { OBSERVATION_LIMITS } from "../reads/observation-policy";
import { LAB_TASK_IDS, openBalanceReadRig, type BalanceReadRig } from "./fixtures/balance-read-fixtures";

const opened: BalanceReadRig[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(rig => rig.close())); });
async function open(): Promise<BalanceReadRig> {
  const rig = await openBalanceReadRig();
  opened.push(rig);
  return rig;
}
const valueOf = (rig: BalanceReadRig, id: string) => {
  const state = loadBalanceState(rig.db);
  const node = state ? findNode(state.outline, id) : null;
  if (!state || !node) throw new Error(`task ${id} is missing`);
  return node;
};
const edit = (rig: BalanceReadRig, id: string, patch: { title?: string; done?: boolean; dueDate?: string; note?: string }): void => {
  const state = loadBalanceState(rig.db);
  if (!state) throw new Error("balance state is missing");
  const node = findNode(state.outline, id);
  if (!node) throw new Error(`task ${id} is missing`);
  Object.assign(node, patch);
  saveBalanceState(rig.db, state);
};

describe("the inactive Balance observation binding", () => {
  test("a poll projects each configured task once and repeated delivery adds nothing", async () => {
    const rig = await open();
    const first = await rig.check();
    expect(first).toMatchObject({ status: "ok", changed: LAB_TASK_IDS.length, quarantined: 0 });
    const views = await rig.views();
    expect(views.map(view => view.ref.canonicalId).sort()).toEqual([...LAB_TASK_IDS].sort());
    expect(views.every(view => view.status === "fresh" && view.evidenceCount === 1)).toBe(true);
    const wing = views.find(view => view.ref.canonicalId === "task-wing");
    expect(wing?.value).toMatchObject({ title: "Cut the wing", status: "open", dueDate: "2026-12-01", note: "Use paper", effort: 2 });
    expect(wing?.value).toMatchObject({ area: { canonicalId: "area-example" }, project: { canonicalId: "project-glider" } });
    expect(views.some(view => view.ref.canonicalId === "task-garden")).toBe(false);
    const repeated = await rig.check();
    expect(repeated).toMatchObject({ status: "ok", changed: 0 });
    expect(await rig.views()).toHaveLength(LAB_TASK_IDS.length);
    expect((await rig.views()).every(view => view.evidenceCount === 1)).toBe(true);
  });

  test("an owner change replaces the one current object for that canonical reference", async () => {
    const rig = await open();
    await rig.check();
    edit(rig, "task-wing", { title: "Cut the second wing", done: true, dueDate: "2026-12-03" });
    expect((await rig.check()).changed).toBe(1);
    const views = await rig.views();
    expect(views).toHaveLength(LAB_TASK_IDS.length);
    expect(views.find(view => view.ref.canonicalId === "task-wing")?.value).toMatchObject({ title: "Cut the second wing", status: "done", dueDate: "2026-12-03" });
    expect((await rig.check()).changed).toBe(0);
  });

  test("a value the owner restores becomes current again without a conflict", async () => {
    const rig = await open();
    await rig.check();
    const original = (await rig.views()).find(view => view.ref.canonicalId === "task-wing")?.value;
    edit(rig, "task-wing", { title: "Cut the second wing", done: true });
    expect((await rig.check()).changed).toBe(1);
    expect((await rig.views()).find(view => view.ref.canonicalId === "task-wing")?.value).toMatchObject({ title: "Cut the second wing", status: "done" });
    edit(rig, "task-wing", { title: "Cut the wing", done: false });
    expect(await rig.check()).toMatchObject({ status: "ok", changed: 1, quarantined: 0 });
    const restored = (await rig.views()).find(view => view.ref.canonicalId === "task-wing");
    expect(restored).toMatchObject({ kind: "present", status: "fresh", value: original });
    expect((await rig.check()).changed).toBe(0);
    expect((await rig.views()).find(view => view.ref.canonicalId === "task-wing")?.value).toEqual(original);
  });

  test("a task that disappears from the owner keeps its value, goes stale, and is never read as deleted", async () => {
    const rig = await open();
    await rig.check();
    rig.removeTask("task-glue");
    expect((await rig.check()).status).toBe("ok");
    const kept = (await rig.views()).find(view => view.ref.canonicalId === "task-glue");
    expect(kept).toMatchObject({ kind: "present" });
    expect(kept?.value).toMatchObject({ title: "Buy glue" });
    expect((await rig.views(true)).some(view => view.ref.canonicalId === "task-glue" && view.kind === "deleted")).toBe(false);
    rig.time.advance(OBSERVATION_LIMITS.staleMs);
    expect((await rig.views()).find(view => view.ref.canonicalId === "task-glue")?.status).toBe("stale");
  });

  test("an unavailable owner leaves every retained value stale and never empties the projection", async () => {
    const rig = await open();
    expect((await rig.check()).status).toBe("ok");
    const before = await rig.views();
    rig.unavailable(true);
    expect(await rig.check()).toMatchObject({ status: "unavailable", changed: 0 });
    expect((await rig.views()).map(view => [view.ref.canonicalId, view.kind, view.status])).toEqual(before.map(view => [view.ref.canonicalId, view.kind, "stale"]));
    rig.unavailable(false);
    expect((await rig.check()).status).toBe("ok");
    expect((await rig.views()).every(view => view.status === "fresh")).toBe(true);
  });

  test("a removed area contributes no observation source and its cached tasks stop being current", async () => {
    const rig = await open();
    await rig.check();
    expect(await rig.day()).toMatchObject({ status: "fresh" });
    rig.removeArea("area-example");
    expect(await rig.day()).toBeNull();
  });

  test("the binding declares no attention mapping and adds only the observation capability", async () => {
    const rig = await open();
    expect(rig.observationBinding).toMatchObject({ mode: "poll", objectType: "task", destinationType: "area", display: { title: "/title", summary: "/summary", status: "/status", due: "/dueDate", area: "/area" } });
    expect(rig.observationBinding.observation).toMatchObject({ modes: ["poll"], objectsPointer: "/items", resumable: false, ordering: BALANCE_TASK_ORDERING });
    expect(rig.observationBinding.attention).toBeUndefined();
    expect(rig.observationBinding.query).toBeUndefined();
    expect(rig.adapter.readBindings.filter(binding => binding.attention !== undefined)).toHaveLength(0);
    const read = balanceReadDeclaration();
    const observation = balanceTaskObservationDeclaration();
    expect(observation.objectTypes).toEqual(read.objectTypes);
    expect(observation.schemas.filter(schema => !read.schemas.some(held => held.schemaId === schema.schemaId)).map(schema => schema.schemaId)).toEqual(["balance.task.observation.input", "balance.task.observation.output"]);
    expect(observation.capabilities.filter(capability => !read.capabilities.some(held => held.capabilityId === capability.capabilityId)).map(capability => [capability.capabilityId, capability.kind])).toEqual([[BALANCE_TASK_OBSERVATION_CAPABILITY_ID, "observation"]]);
    expect(balanceTaskObservationBinding()).toEqual(rig.observationBinding);
    const adapter = createBalanceObservationAdapter({ connectionId: "connection-example", state: () => null, areas: () => [] });
    expect(adapter.bindings.observations).toEqual({ [BALANCE_TASK_OBSERVATION_CAPABILITY_ID]: { modes: ["poll"], ordering: BALANCE_TASK_ORDERING } });
    expect(valueOf(rig, "task-wing").title).toBe("Cut the wing");
  });
});
