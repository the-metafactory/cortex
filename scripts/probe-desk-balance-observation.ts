import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { findNode } from "../src/balance";
import { openBalanceReadRig } from "../src/conversations/domain-adapters/__tests__/fixtures/balance-read-fixtures";
import { deskFixtureOptions } from "../src/surface/mc/__tests__/fixtures/desk-options-fixture";
import { handleDeskMyDay } from "../src/surface/mc/api/desk-my-day";
import { HandledLedger } from "../src/surface/mc/desk/actions";
import { loadBalanceState } from "../src/surface/mc/desk/balance-store";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../src/surface/mc/desk/compose";
import { localDay, type MyDayView } from "../src/surface/mc/desk/my-day";
import { MyDayLane } from "../src/surface/mc/dashboard-v2/components/desk-my-day";
import { runWithTemporaryHome } from "./probe-temp-home";

const NOW = new Date(2026, 10, 1, 10).getTime();

await runWithTemporaryHome(import.meta.path, async () => {
  const rig = await openBalanceReadRig();
  const desk: DeskOptions = { ...deskFixtureOptions, areas: rig.areas.map(area => ({ ...area, repos: [], goals: [] })) };
  const runtime: DeskRuntime = { options: desk, ledger: new HandledLedger(), adapterDay: () => rig.reader() };
  const access = () => rig.reader();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handleDeskMyDay(request, rig.db, runtime, undefined, NOW, access) });
  const stored = () => {
    const state = loadBalanceState(rig.db);
    assert.ok(state, "the owner store is missing");
    return state;
  };
  const get = async (path = "/api/desk/my-day"): Promise<MyDayView> => {
    const response = await fetch(new URL(path, server.url));
    assert.equal(response.status, 200);
    return response.json() as Promise<MyDayView>;
  };
  try {
    const fresh = await get();
    assert.equal(fresh.observation?.status, "fresh");
    assert.deepEqual(fresh.outline, stored().outline);
    assert.ok((await rig.views()).length >= 3);
    console.log("fresh: the rendered outline equals the owner store through the durable projection");

    const added = await fetch(new URL("/api/desk/my-day", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: localDay(NOW), requestId: crypto.randomUUID(), command: { op: "outline-add", revision: fresh.revision, parent: "area:area-example", title: "Probe wing" } }) });
    assert.equal(added.status, 200);
    const changed = await added.json() as { view: MyDayView; outlineId: string };
    const after = await get();
    assert.deepEqual(after.outline, stored().outline);
    assert.ok((await rig.views()).some(observed => observed.ref.canonicalId === changed.outlineId));
    console.log("changeMyDay: the owner change is observed and the panel still matches the store");

    rig.unavailable(true);
    const stale = await get();
    assert.equal(stale.observation?.status, "stale");
    assert.ok(findNode(stale.outline, "task-wing"));
    assert.ok(findNode(stale.outline, "task-garden"));
    const html = renderToStaticMarkup(createElement(MyDayLane, { day: stale, onChanged: () => {} }));
    assert.ok(html.includes("Balance reads are stale."));
    assert.ok(html.includes(">Refresh</button>"));
    console.log("stale: the marker and an explicit Refresh show while last values stay, including a task the projection never saw");

    rig.unavailable(false);
    const refreshed = await get("/api/desk/my-day?observation=refresh");
    assert.equal(refreshed.observation?.status, "fresh");
    console.log("refresh: the explicit read restores a fresh projection");

    rig.removeArea("area-example");
    desk.areas = desk.areas.filter(area => area.id !== "area-example");
    const removed = await get();
    assert.equal(findNode(removed.outline, "task-wing"), null);
    assert.equal(findNode(removed.outline, "task-garden") === null, false);
    assert.equal(removed.observation, null);
    console.log("removed area: its cached tasks leave the panel at once");

    const composed = await composeDesk(rig.db, desk, undefined, { now: NOW, adapterDay: () => rig.reader() });
    assert.ok(composed.items.every(item => item.kind !== "adapter"));
    assert.ok(composed.sources.every(source => !source.id.startsWith("adapter:")));
    console.log("attention: no ranked adapter item appears on Day or in Catch-up");
  } finally {
    server.stop(true);
    await rig.close();
  }
});
