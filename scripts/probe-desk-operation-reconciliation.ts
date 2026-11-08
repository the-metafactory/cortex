import assert from "node:assert/strict";
import { objectRef } from "../src/conversations/domain-adapters/fixtures";
import { AT } from "../src/conversations/domain-adapters/operations/fixtures";
import { separateHistoricFromCurrent } from "../src/conversations/domain-adapters/operations/readback";
import { receiptStatus } from "../src/conversations/domain-adapters/operations/reconciliation";
import { reconcileRig } from "../src/conversations/domain-adapters/operations/reconciliation-fixtures";

const SCHEDULE_MS = [30_000, 35_000, 60_000];

async function ambiguous(dedup: "none" | { retentionMs: number }) {
  const rig = await reconcileRig({ dedup });
  await rig.begin();
  assert.equal((await rig.dispatch()).kind, "timed-out");
  assert.equal((await rig.events())?.journal.state, "uncertain");
  await rig.reopen();
  await rig.activate();
  for (const offset of SCHEDULE_MS) {
    rig.setClock(offset);
    assert.equal((await rig.advance()).kind, "still-uncertain");
  }
  rig.setClock(61_000);
  return rig;
}

const guaranteed = await ambiguous({ retentionMs: 600_000 });
const unsupported = await ambiguous("none");
const expired = await ambiguous({ retentionMs: 61_000 });
try {
  assert.equal((await guaranteed.advance()).kind, "replayed");
  const stored = await guaranteed.events();
  assert.equal(stored?.journal.state, "succeeded");
  assert.equal(guaranteed.owner.effects.size, 1);
  assert.equal(guaranteed.calls.dispatch, 2);
  assert.equal(stored?.outbox.length, 1);
  const status = receiptStatus(stored ?? assert.fail("Operation missing."));
  assert.equal(status.cleanSuccess, true);
  assert.equal(status.effects.length, 1);
  const task = objectRef("balance", "area", "area-example");
  guaranteed.hooks.readback = () => Promise.resolve({ lifecycleVersion: "1.0.0", ref: task, checkedAt: AT, provenance: { adapterId: "balance", connectionId: task.connectionId, evidenceId: "tombstone" }, result: { kind: "deleted", evidenceId: "tombstone-1" } });
  const read = await guaranteed.reader().read(guaranteed.context, task, guaranteed.sink);
  const view = separateHistoricFromCurrent(stored ?? assert.fail("Operation missing."), read);
  assert.deepEqual(view, { historic: "succeeded", current: "deleted", recreateAllowed: false });
  assert.equal(receiptStatus((await guaranteed.events()) ?? assert.fail("Operation missing.")).effects.length, 1);

  for (const rig of [unsupported, expired]) {
    const outcome = await rig.advance();
    assert.equal(outcome.kind, "exhausted");
    assert.equal(rig.calls.dispatch, 1);
    assert.equal((await rig.events())?.journal.state, "uncertain");
    assert.equal(rig.owner.effects.size, 1);
  }
  console.log("Synthetic operation reconciliation: an ambiguous call survived a state reopen; three scheduled lookups stayed uncertain; one attested replay under the same key produced one owner effect and one preserved success receipt; a deleted current object left the historic success intact; an unsupported guarantee and an expired retention window each made zero replays. Temporary state only.");
} finally { await guaranteed.close(); await unsupported.close(); await expired.close(); }
