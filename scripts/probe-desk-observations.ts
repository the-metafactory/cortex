import assert from "node:assert/strict";
import { objectRef } from "../src/conversations/domain-adapters/fixtures";
import { observationRig, observationViews, syntheticDeletion, syntheticObservation } from "../src/conversations/domain-adapters/reads/observation-fixtures";
import { runWithTemporaryHome } from "./probe-temp-home";

async function probe() {
  const item = await observationRig();
  const check = (mode: "poll" | "subscription" = "poll") => item.store.check(item.rig.context, item.source, item.rig.sink, mode);
  try {
    assert.equal((await check()).changed, 1);
    assert.equal((await check("subscription")).changed, 0);
    const first = await observationViews(item);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.evidenceCount, 1);
    console.log("duplicate: one current object, one evidence entry");
    const success = item.time.clock.now();
    item.time.advance(720000);
    item.hooks.fetch = () => Promise.reject(new Error("Synthetic poll failure"));
    assert.equal((await check()).status, "unavailable");
    const stale = (await observationViews(item))[0];
    assert.equal(stale?.status, "stale");
    assert.equal(stale.lastSuccessAt, success);
    assert.equal(stale.lastAttemptAt, success + 720000);
    console.log("failed poll: stale; last success preserved, last attempt advanced 12 minutes");
    await item.rig.reopen();
    item.hooks.fetch = request => { assert.equal(request.checkpoint, "synthetic protected checkpoint"); return Promise.resolve(syntheticObservation()); };
    assert.equal((await check("subscription")).status, "ok");
    console.log("reopen: resumed from protected matching checkpoint; replay deduplicated");
    await item.store.link(item.source, objectRef("balance", "task", "task-example"), "conversation-example");
    item.hooks.fetch = () => Promise.resolve(syntheticDeletion());
    assert.equal((await check()).status, "ok");
    assert.equal((await observationViews(item)).length, 0);
    const marker = (await observationViews(item, true))[0];
    assert.equal(marker?.kind, "deleted");
    assert.equal(marker.value, undefined);
    console.log("owner deletion: absent from active objects; linked metadata-only marker retained");
  } finally { await item.rig.close(); }
}

await runWithTemporaryHome(import.meta.path, probe);
