import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { balanceDestinations } from "../desk/balance-destinations";
import { loadBalanceState } from "../desk/balance-store";
import { openBalanceReadRig, type BalanceReadRig } from "../../../conversations/domain-adapters/__tests__/fixtures/balance-read-fixtures";
import { handleDeskBalanceSurfaces } from "../api/desk-balance-surfaces";
import { BalanceTaskCard } from "../dashboard-v2/components/desk-conversation-balance-task";
import { BALANCE_SURFACES_DESTINATIONS, balanceSurfaceTaskPath, type BalanceSurfaceTask } from "../desk/balance-surface-schema";
import { balanceSurfaceRun, createBalanceSurfaceReader, type BalanceSurfaceReader } from "../desk/balance-surfaces";

const opened: BalanceReadRig[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(rig => rig.close())); });

async function open(enabled = true): Promise<{ rig: BalanceReadRig; reader: BalanceSurfaceReader }> {
  const rig = await openBalanceReadRig();
  opened.push(rig);
  const reader = createBalanceSurfaceReader({
    connectionId: rig.rig.connection.connectionId,
    enabled: () => enabled,
    destinations: () => rig.destinations(),
    readTask: balanceSurfaceRun({ connectionId: rig.rig.connection.connectionId, runner: rig.runner, context: rig.rig.context, sink: rig.rig.sink, inputSchemaRef: rig.taskReadBinding.inputSchemaRef }),
    display: rig.taskReadBinding.display,
  });
  return { rig, reader };
}

describe("Balance surfaces over the host query runner", () => {
  test("destinations offer the configured areas and open projects the legacy picker shows", async () => {
    const { rig, reader } = await open();
    const state = loadBalanceState(rig.db);
    if (!state) throw new Error("balance fixture state missing");
    const legacy = balanceDestinations(state.outline, rig.areas);
    const found = await reader.destinations();
    if (!found.enabled) throw new Error("Balance surfaces were off");
    expect(found.areas.map(area => [area.ref, area.label])).toEqual(legacy.filter(option => !option.project).map(option => [option.area, option.label]));
    expect(found.projects.map(project => [project.ref, project.label, project.area])).toEqual(legacy.filter(option => option.project).map(option => [option.id, option.label, option.area]));
  });

  test("a created task reads its title, area, project, due date, note and effort", async () => {
    const { reader } = await open();
    expect(await reader.task("task-wing", "area-example")).toEqual({ enabled: true, state: "available", title: "Cut the wing", due: "2026-12-01", area: "Lab", project: "Glider", note: "Use paper", effort: 2 });
    expect(await reader.task("task-glue", "area-example")).toMatchObject({ state: "available", title: "Buy glue", project: null, due: null, note: null, effort: 1 });
  });

  test("a deleted task is unavailable and a removed area withholds before the owner is read", async () => {
    const { rig, reader } = await open();
    rig.removeTask("task-wing");
    expect(await reader.task("task-wing", "area-example")).toEqual({ enabled: true, state: "unavailable" });
    const seen = rig.rig.calls.sends.length;
    rig.removeArea("area-example");
    expect(await reader.task("task-glue", "area-example")).toEqual({ enabled: true, state: "withheld" });
    expect(rig.rig.calls.sends.length).toBe(seen);
    const found = await reader.destinations();
    if (!found.enabled) throw new Error("Balance surfaces were off");
    expect(found.areas.map(area => area.ref)).toEqual(["area-home"]);
    expect(found.projects).toEqual([]);
  });

  test("an area outside the connection's read destinations withholds its task content", async () => {
    const { rig, reader } = await open();
    expect(await reader.task("task-garden", "area-home")).toEqual({ enabled: true, state: "withheld" });
    await rig.allowHome();
    expect(await reader.task("task-garden", "area-home")).toMatchObject({ state: "available", title: "Water the garden", area: "Home", due: "2026-11-20" });
  });

  test("a task without its area, or with the connection off, reads nothing", async () => {
    const { rig, reader } = await open(false);
    expect(await reader.destinations()).toEqual({ enabled: false });
    expect(await reader.task("task-wing", "area-example")).toEqual({ enabled: false });
    expect(rig.rig.calls.sends).toHaveLength(0);
    const live = await open();
    expect(await live.reader.task("task-wing", "")).toEqual({ enabled: true, state: "unavailable" });
    expect(await live.reader.task("  ", "area-example")).toEqual({ enabled: true, state: "unavailable" });
    expect(live.rig.rig.calls.sends).toHaveLength(0);
  });
});

describe("the Balance surfaces route", () => {
  const call = (path: string, reader: BalanceSurfaceReader | null, method = "GET"): Promise<Response> =>
    handleDeskBalanceSurfaces(new Request(`http://127.0.0.1:8767${path}`, { method }), new URL(`http://127.0.0.1:8767${path}`), () => reader);

  test("answers enabled false without a reader and serves destinations and tasks with one", async () => {
    expect(await (await call(BALANCE_SURFACES_DESTINATIONS, null)).json()).toEqual({ enabled: false });
    const { reader } = await open();
    expect(await (await call(BALANCE_SURFACES_DESTINATIONS, reader)).json()).toMatchObject({ enabled: true });
    expect(await (await call(balanceSurfaceTaskPath("task-wing", "area-example"), reader)).json()).toMatchObject({ enabled: true, state: "available", title: "Cut the wing" });
    expect((await call(balanceSurfaceTaskPath("task-wing", ""), reader)).status).toBe(400);
    expect((await call("/api/desk/balance-surfaces/unknown", reader)).status).toBe(404);
    expect((await call(BALANCE_SURFACES_DESTINATIONS, reader, "POST")).status).toBe(405);
  });
});

describe("the saved Balance card", () => {
  const html = (task: Exclude<BalanceSurfaceTask, { enabled: false }>): string => renderToStaticMarkup(<BalanceTaskCard id="task-wing" task={task} />);

  test("renders the shared summary from the facts the read released", () => {
    const saved = html({ enabled: true, state: "available", title: "Cut the wing", due: "2026-12-01", area: "Lab", project: "Glider", note: "Use paper", effort: 2 });
    for (const value of ["Saved task details", "Cut the wing", "Glider", "Use paper", "2026-12-01", "Medium", ">Edit</button>"]) expect(saved).toContain(value);
    expect(saved).not.toContain("<input");
    expect(saved).not.toContain("Importance");
  });

  test("a deleted task is unavailable with no retry, and a removed area withholds its content", () => {
    const missing = html({ enabled: true, state: "unavailable" });
    expect(missing).toContain("no longer available in the saved outline");
    expect(missing).not.toContain("<button");
    const withheld = html({ enabled: true, state: "withheld" });
    expect(withheld).toContain("content is withheld");
    expect(withheld).not.toContain("Cut the wing");
    expect(withheld).not.toContain("<button");
  });
});
