import { afterEach, describe, expect, test } from "bun:test";
import { findNode } from "../../../balance";
import { localDay } from "../../../common/local-day";
import { loadBalanceState, saveBalanceState } from "../../../surface/mc/desk/balance-store";
import { BALANCE_TASK_ATTENTION, BALANCE_TASK_ROW_CAPABILITIES } from "../balance/attention";
import { balanceTaskObservationBinding } from "../balance/observation";
import { closeTrackedBalanceReadRigs, openTrackedBalanceReadRig, type BalanceReadRig } from "./fixtures/balance-read-fixtures";

afterEach(closeTrackedBalanceReadRigs);
const open = openTrackedBalanceReadRig;

const observedAt = new Date("2026-11-01T00:00:00.000Z");
const TODAY = localDay(observedAt.getTime());

function saved(rig: BalanceReadRig) {
  const state = loadBalanceState(rig.db);
  if (!state) throw new Error("balance state is missing");
  return state;
}
function plan(rig: BalanceReadRig, ids: string[]): void {
  const state = saved(rig);
  state.dayState = { date: TODAY, confirmed: ids, closed: false };
  saveBalanceState(rig.db, state);
}
function edit(rig: BalanceReadRig, id: string, patch: { deferredUntil?: string }): void {
  const state = saved(rig);
  const node = findNode(state.outline, id);
  if (!node) throw new Error(`task ${id} is missing`);
  Object.assign(node, patch);
  saveBalanceState(rig.db, state);
}
async function values(rig: BalanceReadRig): Promise<Map<string, Record<string, unknown>>> {
  const views = await rig.views();
  return new Map(views.map(view => [view.ref.canonicalId, view.value as Record<string, unknown>]));
}

describe("the Balance attention mapping", () => {
  test("the observation binding carries the approved mapping and no row capability of its own", () => {
    expect(BALANCE_TASK_ATTENTION).toEqual({ pointer: "/why", badge: "/badge", owner: "/owner" });
    expect(BALANCE_TASK_ROW_CAPABILITIES).toEqual([]);
    const binding = balanceTaskObservationBinding();
    expect(binding.attention).toEqual(BALANCE_TASK_ATTENTION);
    expect(binding.capabilities).toBeUndefined();
    expect(binding.display).toEqual({ title: "/title", summary: "/summary", status: "/status", due: "/dueDate", area: "/area" });
  });

  test("an actionable task carries the engine's reason and its In today badge", async () => {
    const rig = await open();
    plan(rig, ["task-wing"]);
    expect((await rig.check()).status).toBe("ok");
    const task = (await values(rig)).get("task-wing");
    expect(task?.why).toBe("Keeps Lab moving.");
    expect(task?.badge).toBe("In today");
    expect(task?.owner).toBeNull();
    expect((await values(rig)).get("task-glue")?.badge).toBeNull();
  });

  test("a task the engine does not rank stays in the projection without a reason", async () => {
    const rig = await open();
    edit(rig, "task-glue", { deferredUntil: "2026-11-02" });
    expect((await rig.check()).status).toBe("ok");
    const held = await values(rig);
    expect(held.get("task-glue")).toMatchObject({ title: "Buy glue", status: "open", why: null });
    expect(held.get("task-wing")?.why).toBeString();
  });

  test("a done task keeps its value for My Day and gains no row", async () => {
    const rig = await open();
    expect((await rig.check()).status).toBe("ok");
    expect((await values(rig)).get("task-done")).toMatchObject({ title: "Fold the body", status: "done", why: null, badge: null });
  });

  test("a Studio task is marked as the Studio's and answers with its own reason", async () => {
    const rig = await open();
    expect((await rig.check()).status).toBe("ok");
    expect((await values(rig)).get("task-studio")).toMatchObject({ title: "Studio answer", status: "open", owner: "studio", why: "Waiting for your answer in Studio." });
  });

  test("the mapping is not declared on the query bindings, so a query never becomes a row", async () => {
    const rig = await open();
    expect(rig.adapter.readBindings.some(binding => binding.attention !== undefined)).toBe(false);
  });
});
