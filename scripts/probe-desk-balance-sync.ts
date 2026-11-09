import assert from "node:assert/strict";
import { balanceSyncFixture, SYNC_NOW, syncFixtureState } from "./lib/desk-balance-sync-fixture";
import { findNode } from "../src/balance";
import { saveBalanceState, loadBalanceState } from "../src/surface/mc/desk/balance-store";
import { loadMeta } from "../src/surface/mc/desk/balance-sync";
import { changeMyDay, readMyDay, type MyDayView } from "../src/surface/mc/desk/my-day";
import { readStudioMyDay, syncStudioBalance } from "../src/surface/mc/desk/studio-my-day";

const stack = await balanceSyncFixture();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: stack.readRoute });
const get = async (): Promise<MyDayView> => {
  const response = await fetch(new URL("/api/desk/my-day", server.url));
  assert.equal(response.status, 200);
  return response.json() as Promise<MyDayView>;
};
try {
  for (const populated of [false, true]) {
    if (populated) saveBalanceState(stack.db, syncFixtureState());
    const before = stack.bytes();
    for (let count = 0; count < 3; count++) {
      readMyDay(stack.db, stack.runtime.options, SYNC_NOW);
      await readStudioMyDay(stack.db, stack.runtime.options, SYNC_NOW);
      assert.equal(stack.bytes(), before, "A My Day read changed saved store bytes");
    }
  }
  await stack.note();
  assert.equal(readMyDay(stack.db, stack.runtime.options, SYNC_NOW).studioTasks.length, 0);
  await syncStudioBalance(stack.db, stack.runtime.options, SYNC_NOW);
  const day = await get();
  assert.equal(day.studioTasks.length, 1);
  assert.ok(day.items.some(item => item.task.title === "Respond to Ivy on Which sketch?"));
  assert.equal(findNode(loadBalanceState(stack.db)!.outline, "repeat")?.done, false);
  assert.equal(loadMeta(stack.db).draft, null);
  const before = stack.bytes();
  assert.equal((await get()).revision, day.revision);
  assert.equal(stack.bytes(), before, "Repeated route sync changed the store");
  changeMyDay({ db: stack.db, desk: stack.runtime.options, now: SYNC_NOW, date: day.date, requestId: crypto.randomUUID(), command: { op: "start", ids: ["task"] } });
  stack.setNow(SYNC_NOW + 86_400_000);
  await syncStudioBalance(stack.db, stack.runtime.options, SYNC_NOW + 86_400_000);
  const next = await get();
  assert.equal(next.date, "2026-11-02");
  assert.equal(next.phase, "proposed");
  assert.equal(loadMeta(stack.db).draft, null);
  const rolled = stack.bytes();
  assert.equal((await get()).revision, next.revision);
  assert.equal(stack.bytes(), rolled, "Repeated rollover sync changed the store");
  console.log(JSON.stringify({ pureReads: 12, studioRows: day.studioTasks.length, recurrenceReopened: true, rollover: next.date, repeatedSyncStable: true, temporaryStackOnly: true }));
} finally {
  await server.stop(true);
  await stack.close();
}
