import assert from "node:assert/strict";
import { canonicalWire } from "../src/conversations/domain-adapters/operations/validation";
import { bulkPage, countingConnector, releasedIds, releasedTotal, resumedRequest, stallPage, titledSources } from "../src/conversations/domain-adapters/reads/limit-fixtures";
import { controlledQueryClock, queryRig, syntheticQueryPage } from "../src/conversations/domain-adapters/reads/query-fixtures";
import { QUERY_LIMITS } from "../src/conversations/domain-adapters/reads/query-types";
import { initDatabase } from "../src/surface/mc/db/init";
import { catchupItems } from "../src/surface/mc/dashboard-v2/components/desk-catch-up";
import { composeDesk } from "../src/surface/mc/desk/compose";
import { ATTENTION_DESK, attentionRig } from "../src/surface/mc/desk/fixtures/adapter-attention-fixtures";
import { runWithTemporaryHome } from "./probe-temp-home";

async function queryLimits(): Promise<void> {
  const entry = await queryRig();
  try {
    const counted = countingConnector(entry);
    const invocation = entry.runner.invocation();
    const request = await entry.runner.create(entry.rig.context, titledSources(entry.source, "feed"), entry.rig.sink);
    const result = await entry.runner.run(entry.rig.context, request, entry.rig.sink, invocation);
    const items = releasedTotal(entry.rig.calls.sends);
    assert.ok(Math.max(...counted.asked) <= QUERY_LIMITS.pageItems, "a page asked for more items than the page limit");
    assert.ok(counted.bytes.every(size => size <= QUERY_LIMITS.pageBytes), "a page exceeded the page byte limit");
    assert.ok(items <= QUERY_LIMITS.items, "an invocation released more items than the item limit");
    assert.ok(counted.peak() <= QUERY_LIMITS.concurrent, "more fetches ran at once than the concurrency limit");
    assert.equal(result.noMatch, false);
    console.log(`pages: ${String(counted.asked.length)} fetched, largest asked for ${String(Math.max(...counted.asked))} items of ${String(QUERY_LIMITS.pageItems)}`);
    console.log(`page bytes: ${String(Math.max(...counted.bytes))} bytes of ${String(QUERY_LIMITS.pageBytes)}`);
    console.log(`invocation: ${String(items)} items released of ${String(QUERY_LIMITS.items)}`);
    console.log(`concurrency: peak ${String(counted.peak())} of ${String(QUERY_LIMITS.concurrent)}`);
    const exhausted = await entry.runner.run(entry.rig.context, resumedRequest(request, result.continuation), entry.rig.sink, invocation);
    assert.equal(exhausted.noMatch, false);
    assert.ok(exhausted.groups.every(group => group.coverage === "budget-exhausted"), "a spent invocation was not labelled budget-exhausted");
    console.log(`budget-exhausted: status ${exhausted.status}, no-match ${String(exhausted.noMatch)}`);
  } finally { await entry.rig.close(); }
}

async function pageSize(): Promise<void> {
  const entry = await queryRig();
  try {
    entry.rig.hooks.query = () => Promise.resolve(bulkPage("x".repeat(QUERY_LIMITS.pageBytes + 1024)));
    const oversized = await entry.runner.create(entry.rig.context, [entry.source], entry.rig.sink);
    const refused = await entry.runner.run(entry.rig.context, oversized, entry.rig.sink);
    assert.equal(entry.rig.calls.sends.length, 0, "an oversized page reached the release sink");
    assert.equal(refused.noMatch, false, "a refused oversized page claimed no-match");
    assert.notEqual(refused.status, "ok");
    console.log(`oversized page: refused as ${refused.status}/${String(refused.groups[0]?.reason?.code)}, no-match ${String(refused.noMatch)}`);
    const sized = bulkPage("y".repeat(QUERY_LIMITS.pageBytes - 4096));
    assert.ok(Buffer.byteLength(canonicalWire(sized)) <= QUERY_LIMITS.pageBytes);
    entry.rig.hooks.query = () => Promise.resolve(sized);
    const accepted = await entry.runner.run(entry.rig.context, await entry.runner.create(entry.rig.context, [entry.source], entry.rig.sink), entry.rig.sink);
    assert.equal(accepted.status, "ok");
    assert.deepEqual(releasedIds(entry.rig.calls.sends[0]), ["bulk"]);
    console.log(`page under the byte limit: accepted, ${String(Buffer.byteLength(canonicalWire(sized)))} bytes`);
  } finally { await entry.rig.close(); }
}

async function deadlines(): Promise<void> {
  const time = controlledQueryClock();
  const entry = await queryRig(time.clock);
  try {
    const stalled = await stallPage(entry);
    time.advance(QUERY_LIMITS.pageMs);
    const late = await stalled.pending;
    assert.equal(stalled.signal.aborted, true, "a page past its wall did not abort its connector");
    assert.equal(late.noMatch, false);
    assert.equal(late.groups[0]?.reason?.code, "deadline_exceeded");
    stalled.finish(syntheticQueryPage(["late"]));
    await Bun.sleep(10);
    assert.equal(entry.rig.calls.sends.length, 0, "a late page reached the release sink");
    console.log(`page deadline: ${String(QUERY_LIMITS.pageMs)} ms yields ${late.status}/${String(late.groups[0]?.coverage)}, nothing released`);
    const invocation = entry.runner.invocation();
    time.advance(QUERY_LIMITS.invocationMs);
    const expired = await entry.runner.run(entry.rig.context, await entry.runner.create(entry.rig.context, [entry.source], entry.rig.sink), entry.rig.sink, invocation);
    assert.equal(expired.noMatch, false);
    assert.equal(expired.groups[0]?.coverage, "budget-exhausted");
    console.log(`invocation deadline: ${String(QUERY_LIMITS.invocationMs)} ms yields ${expired.status}, no fetch issued`);
  } finally { await entry.rig.close(); }
}

async function dayComposition(): Promise<void> {
  const item = await attentionRig();
  const db = initDatabase(":memory:");
  try {
    assert.equal((await item.ingest(0)).status, "ok");
    assert.equal((await item.ingest(1)).status, "ok");
    const populated = item.fetches;
    const view = await composeDesk(db, ATTENTION_DESK, undefined, { now: item.time.clock.now(), adapterAttention: item.feature });
    const catchup = catchupItems(view.items, "lab", "all", "adapter");
    assert.equal(catchup.length, 2);
    const afterDay = item.fetches;
    assert.equal(afterDay, populated, "composing Day called the provider");
    assert.equal(item.rig.calls.read, 0);
    console.log(`Day and Catch-up: ${String(catchup.length)} items from the populated projection, ${String(afterDay - populated)} provider calls`);
  } finally {
    db.close();
    await item.rig.close();
  }
}

const probe = async (): Promise<void> => {
  console.log(`approved limits: ${canonicalWire({ ...QUERY_LIMITS })}`);
  await queryLimits();
  await pageSize();
  await deadlines();
  await dayComposition();
};

await runWithTemporaryHome(import.meta.path, probe);
