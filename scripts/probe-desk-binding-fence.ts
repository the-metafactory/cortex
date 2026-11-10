import assert from "node:assert/strict";
import { ownerResult } from "../src/conversations/domain-adapters/operations/dispatch-fixtures";
import { deniedBridge, fenceTarget, openFenceRig, successFor, successWithoutEvidence, type FenceRig } from "../src/conversations/domain-adapters/operations/fence-fixtures";
import type { PrincipalNotice } from "../src/conversations/domain-adapters/operations/triggers";

const notices: PrincipalNotice[] = [];
const notify = (notice: PrincipalNotice): void => { notices.push(notice); };
const opened: FenceRig[] = [];

async function rig(): Promise<FenceRig> {
  const created = await openFenceRig(notify);
  opened.push(created);
  return created;
}

const report = async (name: string, rig: FenceRig, expected: boolean, trigger: string): Promise<void> => {
  const fenced = await rig.host.lifecycleFences().isFenced(fenceTarget(rig));
  assert.equal(fenced, expected, `${name}: fence state`);
  console.log(JSON.stringify({ probe: name, fenced, ownerCalls: rig.calls.dispatch, notifications: notices.filter(notice => notice.trigger === trigger).map(notice => `${notice.trigger}:${notice.effect}`) }));
};

const duplicate = await rig();
try {
  assert.equal((await duplicate.dispatch()).kind, "timed-out");
  await duplicate.service.ingestLateEvidence(duplicate.approval.operationId, await successFor(duplicate, "first", "task-first"));
  const calls = duplicate.calls.dispatch;
  await duplicate.service.ingestLateEvidence(duplicate.approval.operationId, await successFor(duplicate, "second", "task-second"));
  assert.equal(await duplicate.host.lifecycleFences().isFenced(fenceTarget(duplicate)), true);
  assert.equal((await duplicate.dispatch()).kind, "refused");
  assert.equal(duplicate.calls.dispatch, calls);
  assert.equal(notices.some(notice => notice.trigger === "duplicate_owner_object"), true);

  const missing = await rig();
  assert.equal((await missing.dispatch()).kind, "timed-out");
  await missing.service.ingestLateEvidence(missing.approval.operationId, await successWithoutEvidence(missing));
  assert.equal(await missing.host.lifecycleFences().isFenced(fenceTarget(missing)), true);
  assert.equal(notices.some(notice => notice.trigger === "success_without_owner_evidence"), true);

  const denied = await rig();
  const bridge = deniedBridge(denied);
  assert.equal(await bridge.activate(denied.binding, denied.lease), true);
  assert.equal((await bridge.dispatch(denied.context, denied.approval.operationId, denied.lease)).kind, "refused");
  assert.equal(denied.calls.dispatch, 0);
  assert.equal(await denied.host.lifecycleFences().isFenced(fenceTarget(denied)), true);
  assert.equal(notices.some(notice => notice.trigger === "destination_denied_at_connector"), true);

  const canary = await rig();
  await canary.host.lifecycleFences().trigger({ kind: "canary_secret_leaked", target: { ...fenceTarget(canary), stack: "test", owner: "synthetic-owner" }, evidence: { canaryId: "canary-example", detail: "The canary appeared in a receipt." } });
  assert.equal(await canary.host.lifecycleFences().isFenced(fenceTarget(canary)), true);
  await canary.reopen();
  await canary.activate();
  const reopened = canary.host.lifecycleFences();
  assert.equal(await reopened.isFenced(fenceTarget(canary)), true);
  assert.equal(await reopened.isFenced({ ...fenceTarget(canary), capabilityId: "balance.object.read" }), false);
  const persisted = await reopened.notices();
  assert.equal(persisted.some(notice => notice.trigger === "canary_secret_leaked" && notice.delivered), true, "the notice survived the reopen");
  assert.equal((await reopened.pending()).length, 0, "no notice is left undelivered");
  console.log(JSON.stringify({ probe: "canary-reopen", fenced: await reopened.isFenced(fenceTarget(canary)), notices: persisted.map(notice => `${notice.trigger}:${notice.effect}:delivered=${notice.delivered}`) }));
  assert.equal((await canary.dispatch()).kind, "refused");
  assert.equal(canary.calls.dispatch, 0);
  const lifted = await reopened.lift(fenceTarget(canary), { principal: "principal-example", reason: "The owner rotated the canary and removed the leaking receipt." });
  assert.equal(lifted.state, "open");
  canary.hooks.dispatch = request => Promise.resolve(ownerResult(request, "succeeded"));
  assert.equal((await canary.dispatch()).kind, "settled");
  assert.equal(canary.calls.dispatch, 1);

  const soft = await rig();
  assert.equal((await soft.dispatch()).kind, "timed-out");
  soft.setClock(30_000);
  assert.equal((await soft.advance()).kind, "still-uncertain");
  soft.setClock(35_000);
  assert.equal((await soft.advance()).kind, "still-uncertain");
  assert.equal(notices.filter(notice => notice.trigger === "repeated_uncertain").length, 0);
  soft.setClock(60_000);
  assert.equal((await soft.advance()).kind, "still-uncertain");
  assert.equal(notices.filter(notice => notice.trigger === "repeated_uncertain").length, 1);
  assert.equal(await soft.host.lifecycleFences().isFenced(fenceTarget(soft)), false);

  const readback = await rig();
  assert.equal((await readback.dispatch()).kind, "timed-out");
  readback.hooks.lookup = () => Promise.resolve({ not: "a lookup" });
  readback.setClock(30_000);
  assert.equal((await readback.advance()).kind, "still-uncertain");
  assert.equal(notices.some(notice => notice.trigger === "readback_failed"), true);
  assert.equal(await readback.host.lifecycleFences().isFenced(fenceTarget(readback)), false);

  const crash = await rig();
  crash.hooks.dispatch = () => Promise.reject(new Error("synthetic connector crash"));
  assert.notEqual((await crash.dispatch()).kind, "refused");
  assert.equal(notices.some(notice => notice.trigger === "adapter_crash"), true);
  assert.equal(await crash.host.lifecycleFences().isFenced(fenceTarget(crash)), false);

  await report("duplicate-owner-object", duplicate, true, "duplicate_owner_object");
  await report("success-without-owner-evidence", missing, true, "success_without_owner_evidence");
  await report("destination-denied-at-connector", denied, true, "destination_denied_at_connector");
  await report("canary-secret-leaked", canary, false, "canary_secret_leaked");
  await report("repeated-uncertain", soft, false, "repeated_uncertain");
  await report("readback-failed", readback, false, "readback_failed");
  await report("adapter-crash", crash, false, "adapter_crash");

  console.log("Synthetic binding fence: each hard trigger disabled mutation for exactly its binding and notified the principal; three uncertain results, a failed readback and an adapter crash only notified; the fence survived a durable reopen while another binding stayed open; an explicit principal lift with a reason restored mutation. Temporary state only.");
} finally {
  for (const rig of opened) await rig.close();
}
