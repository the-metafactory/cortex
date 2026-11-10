import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { findNode } from "../../../balance";
import { loadBalanceState } from "../desk/balance-store";
import { handleDeskMyDay } from "../api/desk-my-day";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import { HandledLedger } from "../desk/actions";
import { localDay, type MyDayView } from "../desk/my-day";
import { MyDayLane } from "../dashboard-v2/components/desk-my-day";
import { DeskBalance } from "../dashboard-v2/components/desk-balance";
import { DeskTimeFirst } from "../dashboard-v2/components/desk-time-first";
import { openBalanceReadRig, type BalanceReadRig } from "../../../conversations/domain-adapters/__tests__/fixtures/balance-read-fixtures";
import { deskFixtureOptions } from "./fixtures/desk-options-fixture";

const NOW = new Date(2026, 10, 1, 10).getTime();
const DATE = localDay(NOW);
const OBSERVED_AT = "2026-11-01T00:00:00.000Z";

describe("My Day reads the Balance observation projection", () => {
  let rig: BalanceReadRig;
  let desk: DeskOptions;
  let runtime: DeskRuntime;

  beforeEach(async () => {
    rig = await openBalanceReadRig();
    desk = { ...deskFixtureOptions, areas: rig.areas.map(area => ({ ...area, repos: [], goals: [] })) };
    runtime = { options: desk, ledger: new HandledLedger(), adapterDay: () => rig.reader() };
  });
  afterEach(async () => { await rig.close(); });

  const route = (body?: unknown, path = "/api/desk/my-day") => handleDeskMyDay(
    new Request(`http://localhost${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) }),
    rig.db, runtime, undefined, NOW,
  );
  const read = async (): Promise<MyDayView> => {
    const response = await route();
    expect(response.status).toBe(200);
    return response.json() as Promise<MyDayView>;
  };
  const stored = () => {
    const state = loadBalanceState(rig.db);
    if (!state) throw new Error("the owner store is empty");
    return state;
  };

  it("renders the owner store outline from a fresh projection", async () => {
    const view = await read();
    expect(view.observation).toEqual({ status: "fresh", observedAt: OBSERVED_AT });
    expect(view.outline).toEqual(stored().outline);
    expect(view.items.length).toBeGreaterThan(0);
    expect((await rig.views()).map(observed => observed.ref.canonicalId).sort()).toEqual(["task-done", "task-glue", "task-wing"]);
  });

  it("keeps commands on changeMyDay and follows their owner change into the projection", async () => {
    const current = await read();
    const response = await route({ date: DATE, requestId: crypto.randomUUID(), command: { op: "outline-add", revision: current.revision, parent: "area:area-example", title: "New wing", note: "Cut it" } });
    expect(response.status).toBe(200);
    const changed = await response.json() as { view: MyDayView; outlineId: string };
    const after = await read();
    expect(after.outline).toEqual(stored().outline);
    expect(findNode(after.outline, changed.outlineId)?.title).toBe("New wing");
    expect((await rig.views()).find(observed => observed.ref.canonicalId === changed.outlineId)?.value).toMatchObject({ title: "New wing", note: "Cut it" });
    const replay = await route({ date: DATE, requestId: crypto.randomUUID(), command: { op: "propose" } });
    expect(replay.status).toBe(200);
  });

  it("shows the stale marker with an explicit refresh and never hides a task the projection has not seen", async () => {
    await read();
    rig.unavailable(true);
    const stale = await read();
    expect(stale.observation).toEqual({ status: "stale", observedAt: OBSERVED_AT });
    expect(findNode(stale.outline, "task-wing")).not.toBeNull();
    expect(findNode(stale.outline, "task-garden")).not.toBeNull();
    expect((await rig.views()).some(observed => observed.ref.canonicalId === "task-garden")).toBe(false);
    const html = renderToStaticMarkup(createElement(MyDayLane, { day: stale, onChanged: () => undefined }));
    expect(html).toContain("Balance reads are stale.");
    expect(html).toContain(">Refresh</button>");
    rig.unavailable(false);
    const refreshed = await read();
    expect(refreshed.observation?.status).toBe("fresh");
    const refreshedHtml = renderToStaticMarkup(createElement(MyDayLane, { day: refreshed, onChanged: () => undefined }));
    expect(refreshedHtml).not.toContain("Balance reads are stale.");
  });

  it("shows the stale marker with Refresh in the mounted Day and Balance surfaces", async () => {
    await read();
    const composed = await composeDesk(rig.db, desk, undefined, { now: NOW, adapterDay: () => rig.reader() });
    const fresh = composed.myDay;
    if (!fresh) throw new Error("Missing My day view");
    const day = (current: MyDayView): string => renderToStaticMarkup(createElement(DeskTimeFirst, { day: current, now: NOW, before: null, after: null, proposal: null, preview: null, ambient: null, areas: desk.areas, onChanged: () => undefined, onThread: () => undefined }));
    const balance = (current: MyDayView): string => renderToStaticMarkup(createElement(DeskBalance, { day: current, view: { ...composed, myDay: current }, foreground: { kind: "unavailable", reason: "Not yet measured" }, onChanged: () => undefined, onThread: () => undefined }));
    expect(day(fresh)).not.toContain("Balance reads are");
    expect(balance(fresh)).not.toContain("Balance reads are");
    rig.unavailable(true);
    const stale = await read();
    expect(stale.observation).toEqual({ status: "stale", observedAt: OBSERVED_AT });
    for (const html of [day(stale), balance(stale)]) {
      expect(html).toContain("Balance reads are stale.");
      expect(html).toContain(">Refresh</button>");
    }
  });

  it("drops a removed area's cached tasks from the panel at once", async () => {
    await read();
    rig.removeArea("area-example");
    desk.areas = desk.areas.filter(area => area.id !== "area-example");
    const removed = await read();
    expect(findNode(removed.outline, "task-wing")).toBeNull();
    expect(findNode(removed.outline, "task-glue")).toBeNull();
    expect(findNode(removed.outline, "task-garden")).not.toBeNull();
    expect(removed.observation).toBeNull();
  });

  it("reads the owner store as before while the connection is off", async () => {
    runtime.adapterDay = () => null;
    const view = await read();
    expect(view.observation).toBeNull();
    expect(view.outline).toEqual(stored().outline);
    const html = renderToStaticMarkup(createElement(MyDayLane, { day: view, onChanged: () => undefined }));
    expect(html).not.toContain("Balance reads are");
  });

  it("declares no attention mapping, so Day and Catch-up gain no ranked adapter item", async () => {
    const composed = await composeDesk(rig.db, desk, undefined, { now: NOW, adapterDay: () => rig.reader() });
    expect(composed.items.every(item => item.kind !== "adapter")).toBe(true);
    expect(composed.sources.some(source => source.id.startsWith("adapter:"))).toBe(false);
    expect(rig.observationBinding.attention).toBeUndefined();
  });
});
