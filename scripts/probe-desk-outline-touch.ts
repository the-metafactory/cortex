import assert from "node:assert/strict";
import { balanceSyncFixture, SYNC_DATE, SYNC_NOW, syncFixtureState } from "../src/surface/mc/__tests__/fixtures/desk-balance-sync-fixture";
import { findNode, type OutlineNode } from "../src/balance";
import { saveBalanceState } from "../src/surface/mc/desk/balance-store";
import { balanceDetails } from "../src/surface/mc/desk/balance-command";
import { changeMyDay, type MyDayView } from "../src/surface/mc/desk/my-day";
import { serveMyDayRoute } from "./lib/my-day-route";

const stack = await balanceSyncFixture();
const { server, get } = serveMyDayRoute(stack.readRoute);
const row = (view: MyDayView, id: string): OutlineNode => {
  const node = findNode(view.outline, id);
  if (!node) throw new Error(`Missing outline row ${id}`);
  return node;
};
const change = (now: number, date: string, command: Parameters<typeof changeMyDay>[0]["command"]) => {
  stack.setNow(now);
  return changeMyDay({ db: stack.db, desk: stack.runtime.options, now, date, requestId: crypto.randomUUID(), command });
};
try {
  saveBalanceState(stack.db, syncFixtureState());
  const before = await get();
  assert.equal(before.touchTrackingSince, SYNC_DATE);
  assert.equal(row(before, "task").createdAt, undefined);
  assert.equal(row(before, "task").touchedAt, undefined);

  const added = change(SYNC_NOW, SYNC_DATE, { op: "outline-add", revision: before.revision, parent: "area:work", title: "Probe task" });
  if (!added.outlineId) throw new Error("Missing outline id");
  const created = row(await get(), added.outlineId);
  assert.equal(created.createdAt, SYNC_DATE);
  assert.equal(created.touchedAt, SYNC_DATE);

  const nextNow = SYNC_NOW + 86_400_000;
  const nextDate = "2026-11-02";
  stack.setNow(nextNow);
  const next = await get();
  assert.equal(next.date, nextDate);
  assert.equal(next.touchTrackingSince, SYNC_DATE);
  const edited = change(nextNow, nextDate, { op: "outline-edit", revision: next.revision, id: added.outlineId, details: { ...balanceDetails(row(next, added.outlineId), nextDate), title: "Probe task edited" }, yes: false });
  const touched = row(await get(), added.outlineId);
  assert.equal(touched.title, "Probe task edited");
  assert.equal(touched.createdAt, SYNC_DATE);
  assert.equal(touched.touchedAt, nextDate);
  assert.equal(row(edited.view, "task").touchedAt, undefined);
  assert.equal(row(edited.view, "repeat").touchedAt, undefined);
  console.log(JSON.stringify({ touchTrackingSince: before.touchTrackingSince, created, editedAt: touched.touchedAt, untouchedSiblings: ["task", "repeat"], temporaryStackOnly: true }));
} finally {
  await server.stop(true);
  await stack.close();
}
