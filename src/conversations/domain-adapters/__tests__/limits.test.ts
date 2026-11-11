import { afterEach, expect, test } from "bun:test";
import { initDatabase } from "../../../surface/mc/db/init";
import { catchupItems } from "../../../surface/mc/dashboard-v2/components/desk-catch-up";
import { composeDesk } from "../../../surface/mc/desk/compose";
import { ATTENTION_DESK, attentionRig } from "../../../surface/mc/desk/fixtures/adapter-attention-fixtures";
import { bulkPage, countingConnector, releasedIds, releasedTotal, resumedRequest, stallPage, titledSources, type QueryLimitEntry } from "../reads/limit-fixtures";
import { controlledQueryClock, queryBinding, queryRig, syntheticQueryPage } from "../reads/query-fixtures";
import { QUERY_LIMITS } from "../reads/query-types";
import { ReadBindings } from "../reads/bindings";
import { ReadBindingSchema, type ReadBinding } from "../reads/types";

const opened: QueryLimitEntry[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(entry => entry.rig.close())); });
async function openQuery(clock?: ReturnType<typeof controlledQueryClock>["clock"]): Promise<QueryLimitEntry> {
  const entry = await queryRig(clock);
  opened.push(entry);
  return entry;
}

test("the approved query limits are pinned and a connection cannot declare higher ones", async () => {
  expect({ ...QUERY_LIMITS }).toEqual({ items: 60, invocationMs: 30000, connections: 10, concurrent: 2, pageItems: 20, pageBytes: 1048576, pageMs: 10000, continuationMs: 600000 });
  for (const limits of [{ items: 21 }, { bytes: 1048577 }, { pageMs: 10001 }]) {
    const raised: ReadBinding = { ...queryBinding, query: { ...queryBinding.query!, limits } };
    expect(ReadBindingSchema.safeParse(raised).success).toBe(false);
  }
  const entry = await openQuery();
  const declared: ReadBinding = { ...queryBinding, query: { ...queryBinding.query!, limits: { items: 20, bytes: 1048576, pageMs: 10000 } } };
  const bindings = new ReadBindings(entry.rig.registry);
  expect(bindings.register(declared, { adapterId: "balance", connectionId: entry.source.connectionId, readCapabilityIds: [entry.source.capabilityId] }).ok).toBe(true);
  const asked: number[] = [];
  entry.rig.hooks.query = request => { asked.push(request.limit); return Promise.resolve(syntheticQueryPage(["one"])); };
  expect((await entry.runner.run(entry.rig.context, await entry.runner.create(entry.rig.context, [entry.source], entry.rig.sink), entry.rig.sink)).status).toBe("ok");
  expect(asked).toEqual([QUERY_LIMITS.pageItems]);
});

test("a source with more data than the budget allows stays inside every counted limit", async () => {
  const entry = await openQuery();
  const counted = countingConnector(entry);
  const invocation = entry.runner.invocation();
  const request = await entry.runner.create(entry.rig.context, titledSources(entry.source, "feed"), entry.rig.sink);
  const result = await entry.runner.run(entry.rig.context, request, entry.rig.sink, invocation);
  expect(Math.max(...counted.asked)).toBe(QUERY_LIMITS.pageItems);
  expect(counted.peak()).toBe(QUERY_LIMITS.concurrent);
  expect(counted.bytes.every(size => size <= QUERY_LIMITS.pageBytes)).toBe(true);
  expect(releasedTotal(entry.rig.calls.sends)).toBe(QUERY_LIMITS.items);
  expect(result.status).toBe("partial");
  expect(result.noMatch).toBe(false);
  expect(result.groups.map(group => group.status)).toEqual(["ok", "ok", "ok", "not-attempted", "not-attempted"]);
  expect(result.groups.filter(group => group.coverage === "budget-exhausted")).toHaveLength(2);
  const fetched = entry.rig.calls.read;
  const exhausted = await entry.runner.run(entry.rig.context, resumedRequest(request, result.continuation), entry.rig.sink, invocation);
  expect(exhausted.status).toBe("partial");
  expect(exhausted.noMatch).toBe(false);
  expect(exhausted.groups.every(group => group.status === "not-attempted" && group.coverage === "budget-exhausted" && group.reason?.code === "budget_exhausted")).toBe(true);
  expect(entry.rig.calls.read).toBe(fetched);
});

test("concurrent fetches stay at two while the item budget would allow more", async () => {
  const entry = await openQuery();
  let active = 0;
  let peak = 0;
  let pages = 0;
  entry.rig.hooks.query = async request => {
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(20);
    active--;
    return syntheticQueryPage([`slow-${pages++}`], request.cursor === undefined ? `slow-cursor-${pages}` : undefined);
  };
  const request = await entry.runner.create(entry.rig.context, titledSources(entry.source, "slow"), entry.rig.sink);
  const result = await entry.runner.run(entry.rig.context, request, entry.rig.sink);
  expect(result.status).toBe("partial");
  expect(result.noMatch).toBe(false);
  expect(entry.rig.calls.read).toBe(5);
  expect(peak).toBe(QUERY_LIMITS.concurrent);
  expect(releasedTotal(entry.rig.calls.sends)).toBeLessThanOrEqual(QUERY_LIMITS.items);
});

test("an oversized page is refused and a spent budget never claims no-match", async () => {
  const entry = await openQuery();
  entry.rig.hooks.query = () => Promise.resolve(bulkPage("x".repeat(QUERY_LIMITS.pageBytes + 1024)));
  const request = await entry.runner.create(entry.rig.context, [entry.source], entry.rig.sink);
  const refused = await entry.runner.run(entry.rig.context, request, entry.rig.sink);
  expect(entry.rig.calls.sends).toHaveLength(0);
  expect(refused.noMatch).toBe(false);
  expect(["partial", "unavailable"]).toContain(refused.status);
  expect(refused.groups[0]?.reason?.code).toBe("source_unavailable");
  expect(JSON.stringify(refused)).not.toContain("xxxxxxxx");
  const sized = bulkPage("y".repeat(QUERY_LIMITS.pageBytes - 4096));
  expect(Buffer.byteLength(JSON.stringify(sized))).toBeGreaterThan(QUERY_LIMITS.pageBytes - 8192);
  entry.rig.hooks.query = () => Promise.resolve(sized);
  const accepted = await entry.runner.run(entry.rig.context, await entry.runner.create(entry.rig.context, [entry.source], entry.rig.sink), entry.rig.sink);
  expect(accepted.status).toBe("ok");
  expect(releasedIds(entry.rig.calls.sends[0])).toEqual(["bulk"]);
});

test("page and invocation deadlines from the fake clock leave results partial or unavailable", async () => {
  const time = controlledQueryClock();
  const entry = await openQuery(time.clock);
  const stalled = await stallPage(entry);
  time.advance(QUERY_LIMITS.pageMs - 1);
  expect(time.clock.now()).toBe(Date.parse("2026-11-01T00:00:00.000Z") + QUERY_LIMITS.pageMs - 1);
  time.advance(1);
  const pageLate = await stalled.pending;
  expect(stalled.signal.aborted).toBe(true);
  expect(pageLate.status).toBe("partial");
  expect(pageLate.noMatch).toBe(false);
  expect(pageLate.groups[0]?.coverage).toBe("incomplete");
  expect(pageLate.groups[0]?.reason?.code).toBe("deadline_exceeded");
  stalled.finish(syntheticQueryPage(["late"]));
  await Bun.sleep(10);
  expect(entry.rig.calls.sends).toHaveLength(0);
  const invocation = entry.runner.invocation();
  time.advance(QUERY_LIMITS.invocationMs);
  entry.rig.hooks.query = () => Promise.resolve(syntheticQueryPage(["never"]));
  const expired = await entry.runner.run(entry.rig.context, await entry.runner.create(entry.rig.context, [entry.source], entry.rig.sink), entry.rig.sink, invocation);
  expect(expired.noMatch).toBe(false);
  expect(expired.groups[0]?.status).toBe("not-attempted");
  expect(expired.groups[0]?.coverage).toBe("budget-exhausted");
  expect(entry.rig.calls.read).toBe(1);
});

test("Day and Catch-up render the populated projection without another provider call", async () => {
  const item = await attentionRig();
  const db = initDatabase(":memory:");
  try {
    expect((await item.ingest(0)).status).toBe("ok");
    expect((await item.ingest(1)).status).toBe("ok");
    const populated = item.fetches;
    expect(populated).toBe(2);
    const view = await composeDesk(db, ATTENTION_DESK, undefined, { now: item.time.clock.now(), adapterAttention: item.feature });
    expect(view.items.map(card => card.source).sort()).toEqual(["synthetic-one", "synthetic-two"]);
    expect(catchupItems(view.items, "lab", "all", "adapter")).toHaveLength(2);
    expect(item.fetches).toBe(populated);
    expect(item.rig.calls.read).toBe(0);
    item.time.advance(720000);
    const stale = await composeDesk(db, ATTENTION_DESK, undefined, { now: item.time.clock.now(), adapterAttention: item.feature });
    expect(stale.items.map(card => card.freshness)).toEqual(["stale", "stale"]);
    expect(catchupItems(stale.items, "lab", "all", "adapter")).toHaveLength(2);
    expect(item.fetches).toBe(populated);
    expect(item.rig.calls.read).toBe(0);
  } finally {
    db.close();
    await item.rig.close();
  }
});
