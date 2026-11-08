import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { authorityRig } from "../src/conversations/authority-fixtures";
import { ownerResult } from "../src/conversations/domain-adapters/operations/dispatch-fixtures";
import { approvalFixture, attemptFixture, eventFixture, support } from "../src/conversations/domain-adapters/operations/fixtures";
import type { OwnerResult } from "../src/conversations/domain-adapters/operations/types";

const rig = await authorityRig();
try {
  const batchId = randomUUID();
  const items = ["succeeded", "failed", "uncertain", "unattempted"].map((state, at) => ({ state, itemId: `item-${at}`, operationId: `${batchId}:op-${at}` }));
  await rig.host.lifecycleBatches().register({ batchId, connectionId: rig.connection.connectionId, items: items.map(({ itemId, operationId }) => ({ itemId, operationId })) });
  const journal = rig.host.lifecycleJournal(rig.registry);
  for (const item of items) {
    if (item.state === "unattempted") continue;
    const approval = { ...approvalFixture(item.operationId), ownerRequestId: `request-${item.operationId}`, links: { batchId, itemId: item.itemId } };
    await journal.approve(approval);
    const attempt = attemptFixture();
    const request = { operationId: item.operationId, attemptId: attempt.attemptId, ownerRequestId: approval.ownerRequestId, snapshot: approval.snapshot };
    const prepared = await journal.append(item.operationId, 1, eventFixture(2, { kind: "attempt-prepared", attempt }), { support });
    if (item.state === "uncertain") { await journal.append(item.operationId, prepared.revision, eventFixture(3, { kind: "wait-expired", attemptId: attempt.attemptId, reason: { code: "deadline_exceeded", message: "No answer." } })); continue; }
    let response: OwnerResult = ownerResult(request, item.state === "succeeded" ? "succeeded" : "cancelled");
    if (item.state === "failed" && response.result.kind === "cancelled") response = { ...response, result: { kind: "failed", error: { code: "balance.synthetic_failure", message: "The owner refused." }, evidence: response.result.evidence } };
    await journal.append(item.operationId, prepared.revision, eventFixture(3, { kind: "owner-result", response }));
  }
  const observe = async () => {
    const outcome = await rig.host.lifecycleBatchReader(rig.registry, rig.bindings).read(rig.context, batchId, rig.sink);
    assert.equal(outcome.kind, "released");
    return outcome.kind === "released" ? outcome.projection.receipt : assert.fail("Batch read withheld.");
  };
  const first = await observe();
  assert.equal(first.summary, "partial");
  assert.deepEqual(first.items.map(item => item.state), ["succeeded", "failed", "uncertain", "unattempted"]);
  await rig.reopen();
  const second = await observe();
  assert.deepEqual(second, first);
  assert.equal(rig.calls.dispatch + rig.calls.lookup + rig.calls.cancel + rig.calls.readback, 0);
  console.log("Synthetic batch receipts: a succeeded, failed, uncertain and unattempted item derived a partial receipt; after a store reopen the stable links and item states were identical; zero owner calls. Temporary state only.");
} finally { await rig.close(); }
