import { afterEach, expect, test } from "bun:test";
import { deferred, dispatchRig, ownerResult } from "../operations/dispatch-fixtures";
import { snapshotDigest } from "../operations/validation";

type Rig = Awaited<ReturnType<typeof dispatchRig>>;
const rigs: Rig[] = [];
async function ready(waitMs?: number): Promise<Rig> {
  const rig = await dispatchRig(waitMs);
  rigs.push(rig);
  const confirmed = await rig.confirm();
  if (confirmed.kind !== "allowed") throw new Error("Synthetic confirmation denied.");
  expect(await rig.activate()).toBe(true);
  return rig;
}

function attemptOf(stored: Awaited<ReturnType<Rig["events"]>>): string {
  const entry = stored?.journal.events.find(item => item.event.kind === "attempt-prepared");
  if (entry?.event.kind !== "attempt-prepared") throw new Error("Attempt missing.");
  return entry.event.attempt.attemptId;
}
const kinds = async (rig: Rig) => (await rig.events())?.journal.events.map(entry => entry.event.kind);
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });

test("repeated confirmation returns one operation and concurrent dispatch makes one owner call and one success event", async () => {
  const rig = await ready();
  expect(await rig.confirm()).toEqual(await rig.confirm());
  rig.hooks.dispatch = request => Promise.resolve(ownerResult(request, "succeeded"));
  const outcomes = await Promise.all([rig.dispatch(), rig.dispatch()]);
  expect(outcomes.map(item => item.kind).sort()).toEqual(["not-dispatchable", "settled"]);
  expect(rig.calls.dispatch).toBe(1);
  const stored = await rig.events();
  expect(stored?.journal.state).toBe("succeeded");
  expect(stored?.outbox.map(item => item.key)).toEqual([`${rig.approval.operationId}:succeeded`]);
  expect((await rig.dispatch()).kind).toBe("not-dispatchable");
  expect(rig.calls.dispatch).toBe(1);
});

test("an inactive bridge, a missing declaration and revoked authority make zero owner calls", async () => {
  const rig = await dispatchRig();
  rigs.push(rig);
  await rig.confirm();
  expect((await rig.dispatch()).kind).toBe("refused");
  expect((await rig.events())?.journal.state).toBe("confirmed");
  await rig.activate();
  rig.declared.support = undefined;
  const missing = await rig.dispatch();
  expect(missing.kind === "refused" && missing.reason.code).toBe("support_missing");
  expect((await rig.events())?.journal.state).toBe("refused");
  expect(rig.calls.dispatch).toBe(0);
});

test("authority revoked before the attempt refuses without preparing or calling", async () => {
  const rig = await ready();
  await rig.revokeConnection();
  const outcome = await rig.dispatch();
  expect(outcome.kind).toBe("refused");
  expect(rig.calls.dispatch).toBe(0);
  expect(await kinds(rig)).toEqual(["approved", "local-outcome"]);
  expect((await rig.events())?.journal.state).toBe("refused");
});

test("a valid accepted receipt is persisted as pending and duplicate delivery adds nothing", async () => {
  const rig = await ready();
  let accepted: ReturnType<typeof ownerResult> | undefined;
  rig.hooks.dispatch = request => Promise.resolve(accepted = ownerResult(request, "accepted"));
  const outcome = await rig.dispatch();
  expect(outcome.kind === "settled" && outcome.operation.journal.state).toBe("pending");
  const before = await kinds(rig);
  await rig.service.ingestLateEvidence(rig.approval.operationId, accepted);
  expect(await kinds(rig)).toEqual(before);
  await rig.reopen();
  expect((await rig.events())?.journal.state).toBe("pending");
});

test("malformed responses and exceptions leave the attempt uncertain", async () => {
  const malformed = await ready();
  malformed.hooks.dispatch = () => Promise.resolve({ nonsense: true });
  expect((await malformed.dispatch()).kind).toBe("settled");
  expect((await malformed.events())?.journal.state).toBe("uncertain");
  const thrown = await ready();
  thrown.hooks.dispatch = () => Promise.reject(new Error("socket reset"));
  await thrown.dispatch();
  expect((await thrown.events())?.journal.state).toBe("uncertain");
  expect(thrown.calls.dispatch).toBe(1);
});

test("timeout yields uncertainty and a late validated success settles once without a second call", async () => {
  const rig = await ready(20);
  const gate = deferred<unknown>();
  rig.hooks.dispatch = () => gate.promise;
  const outcome = await rig.dispatch();
  expect(outcome.kind).toBe("timed-out");
  expect((await rig.events())?.journal.state).toBe("uncertain");
  gate.resolve(ownerResult({ operationId: rig.approval.operationId, attemptId: attemptOf(await rig.events()), ownerRequestId: rig.approval.ownerRequestId, snapshot: rig.approval.snapshot }, "succeeded"));
  await rig.bridge.settled();
  const stored = await rig.events();
  expect(stored?.journal.state).toBe("succeeded");
  expect(stored?.outbox).toHaveLength(1);
  expect(rig.calls.dispatch).toBe(1);
  expect((await rig.dispatch()).kind).toBe("not-dispatchable");
});

test("a crash after attempt-prepared recovers as uncertain and is never replayed as an initial call", async () => {
  const rig = await ready();
  await rig.prepare();
  await rig.reopen();
  await rig.activate();
  await rig.bridge.recover(rig.approval.operationId);
  expect((await rig.events())?.journal.state).toBe("uncertain");
  expect((await rig.dispatch()).kind).toBe("not-dispatchable");
  expect(rig.calls.dispatch).toBe(0);
});

test("cancellation before the attempt makes zero owner calls", async () => {
  const rig = await ready();
  const cancelled = await rig.cancel();
  expect(cancelled.kind).toBe("cancelled-before-dispatch");
  expect((await rig.dispatch()).kind).toBe("not-dispatchable");
  expect(rig.calls.dispatch + rig.calls.cancel).toBe(0);
  expect((await rig.events())?.journal.state).toBe("cancelled");
});

test.each([["succeeded", "succeeded"], ["cancelled", "cancelled"], ["uncertain", "uncertain"]] as const)("cancel after dispatch records the stop and a %s reply yields %s", async (reply, state) => {
  const rig = await ready(20);
  const gate = deferred<unknown>();
  rig.hooks.dispatch = () => gate.promise;
  rig.hooks.cancel = request => Promise.resolve(ownerResult({ operationId: request.operationId, attemptId: attemptOf(stored), ownerRequestId: rig.approval.ownerRequestId, snapshot: rig.approval.snapshot }, reply, `cancel-${reply}`));
  await rig.dispatch();
  const stored = await rig.events();
  const outcome = await rig.cancel();
  expect(outcome.kind === "stop-recorded" && outcome.sent).toBe(true);
  expect(rig.calls.cancel).toBe(1);
  const after = await rig.events();
  expect(after?.journal.events.some(entry => entry.event.kind === "cancel-requested")).toBe(true);
  expect(after?.journal.state).toBe(state);
});

test("cancellation without declared support only records the stop request", async () => {
  const rig = await ready(20);
  rig.hooks.dispatch = () => deferred<unknown>().promise;
  await rig.dispatch();
  if (rig.declared.support) rig.declared.support = { ...rig.declared.support, cancellation: "none" };
  const outcome = await rig.cancel();
  expect(outcome.kind === "stop-recorded" && outcome.sent).toBe(false);
  expect(rig.calls.cancel).toBe(0);
  expect((await rig.events())?.cancelRequested).toBe(true);
});

test("legacy mutations keep the old route until a capability migrates, then upgrade or use the facade", async () => {
  const rig = await dispatchRig();
  rigs.push(rig);
  await rig.confirm();
  const other = { ...rig.binding, owner: "unmigrated-owner" };
  expect((await rig.bridge.legacyMutation(rig.context, other, rig.approval.operationId, rig.lease)).route).toBe("legacy");
  expect((await rig.bridge.legacyMutation(rig.context, rig.binding, rig.approval.operationId, rig.lease)).route).toBe("upgrade-required");
  await rig.activate();
  rig.hooks.dispatch = request => Promise.resolve(ownerResult(request, "succeeded"));
  expect((await rig.bridge.legacyMutation(rig.context, rig.binding, rig.approval.operationId, rig.lease)).route).toBe("bridge");
  expect(rig.calls.dispatch).toBe(1);
});

test("a call that ends abnormally after preparation is uncertain, never a no-call refusal", async () => {
  const rig = await ready();
  rig.hooks.dispatch = () => Promise.reject(new Error("connector crashed"));
  const outcome = await rig.dispatch();
  expect(outcome.kind).not.toBe("refused");
  expect((await rig.events())?.journal.state).toBe("uncertain");
  expect(rig.calls.dispatch).toBe(1);
});

test("outstanding owner calls are capped and a refused admission prepares no attempt", async () => {
  const rig = await dispatchRig(10, 1);
  rigs.push(rig);
  await rig.confirm();
  await rig.activate();
  const never = deferred<ReturnType<typeof ownerResult>>();
  rig.hooks.dispatch = () => never.promise;
  expect((await rig.dispatch()).kind).toBe("timed-out");
  const proposalId = "proposal-second";
  const snapshot = { ...rig.approval.snapshot, provenance: { ...rig.approval.snapshot.provenance, proposalId } };
  const operationId = `${snapshot.provenance.conversationId}:${proposalId}:1`;
  const other = { operationId, idempotencyKey: operationId, ownerRequestId: `${rig.approval.ownerRequestId}-second`, snapshot: { ...snapshot, digest: snapshotDigest(snapshot) } };
  expect((await rig.service.confirm(rig.context, other)).kind).toBe("allowed");
  const calls = rig.calls.dispatch;
  const second = await rig.bridge.dispatch(rig.context, operationId, rig.lease);
  expect(second.kind === "refused" && second.reason.code).toBe("capacity_exceeded");
  expect(rig.calls.dispatch).toBe(calls);
  expect((await rig.host.lifecycleJournal(rig.registry).read(operationId))?.journal.state).toBe("confirmed");
  const probe = await dispatchRig(10, 0);
  rigs.push(probe);
  await probe.confirm();
  await probe.activate();
  const capped = await probe.dispatch();
  expect(capped.kind === "refused" && capped.reason.code).toBe("capacity_exceeded");
  expect(probe.calls.dispatch).toBe(0);
  expect((await probe.events())?.journal.state).toBe("confirmed");
  never.resolve(ownerResult({ operationId: "x", attemptId: "x", ownerRequestId: "x", snapshot: rig.approval.snapshot }, "uncertain"));
});
