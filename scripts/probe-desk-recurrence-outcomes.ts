import assert from "node:assert/strict";
import { balanceSyncFixture, SYNC_NOW, syncFixtureState } from "../src/surface/mc/__tests__/fixtures/desk-balance-sync-fixture";
import { findNode, type OutlineNode } from "../src/balance";
import { saveBalanceState } from "../src/surface/mc/desk/balance-store";
import { changeMyDay, type MyDayView } from "../src/surface/mc/desk/my-day";
import { serveMyDayRoute } from "./lib/my-day-route";

const DAY = 86_400_000;
const stack = await balanceSyncFixture();
const { server, get } = serveMyDayRoute(stack.readRoute);
const row = (view: MyDayView, id: string): OutlineNode => findNode(view.outline, id) ?? assert.fail(`Missing outline row ${id}`);
try {
  const seed = syncFixtureState();
  const area = findNode(seed.outline, "area:work");
  if (!area) throw new Error("Missing area");
  area.children.push({ id: "twice", title: "Twice a fortnight", weight: 50, ordering: "parallel", effort: 1, children: [], repeat: { unit: "week", interval: 2, weekdays: [1, 4], mode: "calendar", anchor: "2026-11-02" } });
  saveBalanceState(stack.db, seed);

  const lateNow = SYNC_NOW + 16 * DAY;
  const lateDate = "2026-11-17";
  stack.setNow(lateNow);
  const before = await get();
  changeMyDay({ db: stack.db, desk: stack.runtime.options, now: lateNow, date: lateDate, requestId: crypto.randomUUID(), command: { op: "outline-complete", id: "twice", revision: before.revision, confirm: true } });

  const after = await get();
  const task = row(after, "twice");
  assert.equal(task.repeat?.anchor, "2026-11-02");
  assert.equal(task.repeat?.occurrence, "2026-11-19");
  assert.deepEqual((task as OutlineNode & { recurrence?: unknown }).recurrence, { returnsOn: "2026-11-19", finished: false, reappearsOn: "2026-11-19" });

  stack.setNow(lateNow + 2 * DAY);
  const reopened = row(await get(), "twice");
  assert.equal(reopened.done, false);
  assert.equal(reopened.dueDate, "2026-11-19");
  assert.equal(reopened.repeat?.anchor, "2026-11-02");
  console.log(JSON.stringify({ completedOn: lateDate, planned: "2026-11-02", missed: ["2026-11-05", "2026-11-16"], next: reopened.dueDate, anchor: reopened.repeat?.anchor, temporaryStackOnly: true }));
} finally {
  await server.stop(true);
  await stack.close();
}
