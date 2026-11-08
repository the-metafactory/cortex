import assert from "node:assert/strict";
import { deferred, dispatchRig, ownerResult } from "../src/conversations/domain-adapters/operations/dispatch-fixtures";

const rig = await dispatchRig(25);
const revoked = await dispatchRig(25);
try {
  assert.deepEqual(await rig.confirm(), await rig.confirm());
  assert.equal(await rig.activate(), true);
  const effects: string[] = [];
  const owner = deferred<unknown>();
  let attemptId = "";
  rig.hooks.dispatch = request => { attemptId = request.attemptId; effects.push("task-example"); return owner.promise; };
  rig.hooks.cancel = request => Promise.resolve(ownerResult({ operationId: request.operationId, attemptId, ownerRequestId: rig.approval.ownerRequestId, snapshot: rig.approval.snapshot }, "accepted", "stop-acknowledged"));

  const first = await rig.dispatch();
  assert.equal(first.kind, "timed-out");
  assert.equal((await rig.events())?.journal.state, "uncertain");
  const cancelled = await rig.cancel();
  assert.equal(cancelled.kind === "stop-recorded" && cancelled.sent, true);
  owner.resolve(ownerResult({ operationId: rig.approval.operationId, attemptId, ownerRequestId: rig.approval.ownerRequestId, snapshot: rig.approval.snapshot }, "succeeded"));
  await rig.bridge.settled();

  const stored = await rig.events();
  assert.equal(stored?.journal.state, "succeeded");
  assert.deepEqual(effects, ["task-example"]);
  assert.equal(rig.calls.dispatch, 1);
  assert.equal(stored?.outbox.length, 1);
  const kinds = stored?.journal.events.map(entry => entry.event.kind);
  assert.ok(kinds?.includes("cancel-requested") && kinds.includes("wait-expired"));
  const results = stored?.journal.events.flatMap(entry => entry.event.kind === "owner-result" ? [entry.event.response.result.kind] : []);
  assert.deepEqual(results, ["accepted", "succeeded"]);

  await revoked.confirm();
  await revoked.activate();
  await revoked.revokeConnection();
  assert.equal((await revoked.dispatch()).kind, "refused");
  assert.equal(revoked.calls.dispatch, 0);
  console.log("Synthetic operation dispatch: confirmed twice to one operation; timeout kept uncertainty; stop request and owner acceptance retained; late success settled once with one owner effect and one success event; revoked authority made zero calls. Temporary state only.");
} finally { await rig.close(); await revoked.close(); }
