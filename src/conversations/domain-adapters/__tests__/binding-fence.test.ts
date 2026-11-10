import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { objectRef } from "../fixtures";
import { AT } from "../operations/fixtures";
import { ownerResult, dispatchRig } from "../operations/dispatch-fixtures";
import { OperationBridge } from "../operations/dispatch";
import { openFenceRig, successFor, successWithoutEvidence, fenceTarget, type FenceRig } from "../operations/fence-fixtures";
import type { RigOptions } from "../operations/reconciliation-fixtures";
import { FENCE_TRIGGER_KINDS, isHardTrigger, type PrincipalNotice } from "../operations/triggers";
import { balanceResponse, openDraftingRig, type DraftingRig } from "../drafting-fixtures";

type Rig = Awaited<ReturnType<typeof dispatchRig>>;
const rigs: (Rig | FenceRig)[] = [];
const draftingRigs: DraftingRig[] = [];
const notices: PrincipalNotice[] = [];
const notify = (notice: PrincipalNotice): void => { notices.push(notice); };
const HARD = new Set(FENCE_TRIGGER_KINDS.filter(isHardTrigger));

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
  for (const rig of draftingRigs.splice(0)) { await rig.close(); await rm(rig.root, { recursive: true, force: true }); }
  notices.length = 0;
});

async function timedOut(options: RigOptions = {}): Promise<FenceRig> {
  const rig = await openFenceRig(notify, options);
  rigs.push(rig);
  expect((await rig.dispatch()).kind).toBe("timed-out");
  return rig;
}

test("a duplicate owner object fences the binding, notifies, stops mutation, and leaves drafts and reads alone", async () => {
  const rig = await timedOut({ dedup: "none" });
  const operation = rig.approval.operationId;
  await rig.service.ingestLateEvidence(operation, await successFor(rig, "result-first", "task-first"));
  const before = await rig.events();
  expect(before?.journal.state).toBe("succeeded");
  const second = await rig.service.ingestLateEvidence(operation, await successFor(rig, "result-second", "task-second"));
  expect(second).not.toBe("");

  const fences = rig.host.lifecycleFences();
  expect(await fences.isFenced(fenceTarget(rig))).toBe(true);
  expect(notices.map(notice => [notice.trigger, notice.effect])).toEqual([["duplicate_owner_object", "mutation-off"]]);
  expect((await rig.events())?.outbox).toHaveLength(1);

  const calls = rig.calls.dispatch;
  const refused = await rig.dispatch();
  expect(refused.kind).toBe("refused");
  expect(refused.kind === "refused" && refused.reason.code).toBe("binding_fenced");
  expect(rig.calls.dispatch).toBe(calls);

  const ref = objectRef("balance", "area", "area-example");
  rig.hooks.readback = () => Promise.resolve({ lifecycleVersion: "1.0.0", ref, checkedAt: AT, provenance: { adapterId: "balance", connectionId: ref.connectionId, evidenceId: "fence-read" }, result: { kind: "deleted", evidenceId: "tombstone-1" } });
  expect((await rig.reader().read(rig.context, ref, rig.sink)).kind).toBe("released");

  const drafting = await openDraftingRig();
  draftingRigs.push(drafting);
  drafting.state.response = () => balanceResponse();
  const made = await drafting.service.make({ conversationId: "conversation-example", entryId: "turn-1", capabilityId: "balance.task.create", connectionId: "connection-example" });
  if (made.kind !== "draft") throw new Error("Synthetic draft is unavailable.");
  await drafting.host?.lifecycleFences().trigger({ kind: "duplicate_owner_object", target: { adapterId: "balance", connectionId: "connection-example", capabilityId: "balance.task.create" } });
  const again = await drafting.service.make({ conversationId: "conversation-example", entryId: "turn-1", capabilityId: "balance.task.create", connectionId: "connection-example" });
  expect(again.kind).toBe("draft");
  expect(again.kind === "draft" && again.view.draft.draftId).toBe(made.view.draft.draftId);
});

test("a success result with no owner evidence fences at the journal and never records the operation as succeeded", async () => {
  const rig = await timedOut({ dedup: "none" });
  const raw = await successWithoutEvidence(rig);
  await rig.service.ingestLateEvidence(rig.approval.operationId, raw);
  const operation = await rig.events();
  expect(operation?.journal.state).toBe("uncertain");
  expect(operation?.outbox).toHaveLength(0);
  expect(await rig.host.lifecycleFences().isFenced(fenceTarget(rig))).toBe(true);
  expect(notices.some(notice => notice.trigger === "success_without_owner_evidence" && notice.effect === "mutation-off")).toBe(true);
  expect((await rig.dispatch()).kind).toBe("refused");
});

test("a denied destination at connector entry fences before the owner is called", async () => {
  const rig = await dispatchRig(20, undefined, () => new Date(AT), notify);
  rigs.push(rig);
  const confirmed = await rig.confirm();
  expect(confirmed.kind).toBe("allowed");
  const bridge = new OperationBridge({
    journal: rig.host.lifecycleJournal(rig.registry),
    authority: rig.host.lifecycleAuthority(rig.registry, rig.bindings),
    writers: rig.host.lifecycleWriters(),
    supportFor: () => rig.declared.support,
    fences: rig.host.lifecycleFences(),
    connectorEntry: () => Promise.resolve({ kind: "denied", reason: { code: "destination_denied", message: "The destination left the write scope." } }),
    now: () => new Date(AT),
  });
  expect(await bridge.activate(rig.binding, rig.lease)).toBe(true);
  const outcome = await bridge.dispatch(rig.context, rig.approval.operationId, rig.lease);
  expect(outcome.kind).toBe("refused");
  expect(outcome.kind === "refused" && outcome.reason.code).toBe("destination_denied");
  expect(rig.calls.dispatch).toBe(0);
  expect(await rig.host.lifecycleFences().isFenced(fenceTarget(rig))).toBe(true);
  expect(notices.some(notice => notice.trigger === "destination_denied_at_connector" && notice.effect === "mutation-off")).toBe(true);
});

test("a failed canary probe fences the probed binding, a restart keeps it, and only a principal with a reason lifts it", async () => {
  const rig = await dispatchRig(20, undefined, () => new Date(AT), notify);
  rigs.push(rig);
  await rig.confirm();
  expect(await rig.activate()).toBe(true);
  const target = fenceTarget(rig);
  const fences = rig.host.lifecycleFences();
  await fences.trigger({ kind: "canary_secret_leaked", target: { ...target, stack: "test", owner: "synthetic-owner" }, evidence: { canaryId: "canary-example", detail: "The canary appeared in a receipt." } });
  expect(await fences.isFenced(target)).toBe(true);
  expect(notices.map(notice => notice.trigger)).toEqual(["canary_secret_leaked"]);

  await rig.reopen();
  await rig.activate();
  const reopened = rig.host.lifecycleFences();
  expect(await reopened.isFenced(target)).toBe(true);
  expect(await reopened.isFenced({ ...target, capabilityId: "balance.object.read" })).toBe(false);
  expect((await rig.dispatch()).kind).toBe("refused");
  expect(rig.calls.dispatch).toBe(0);
  await expect(reopened.lift(target, { principal: "principal-example", reason: " " })).rejects.toThrow();

  const lifted = await reopened.lift(target, { principal: "principal-example", reason: "The owner rotated the canary and removed the leaking receipt." });
  expect(lifted).toMatchObject({ state: "open", liftedBy: "principal-example", liftReason: "The owner rotated the canary and removed the leaking receipt." });
  expect(await reopened.isFenced(target)).toBe(false);
  rig.hooks.dispatch = request => Promise.resolve(ownerResult(request, "succeeded"));
  expect((await rig.dispatch()).kind).toBe("settled");
  expect(rig.calls.dispatch).toBe(1);
});

test("three uncertain results notify once in 24 hours, and a failed readback and an adapter crash notify without fencing", async () => {
  const rig = await timedOut({ dedup: "none" });
  rig.setClock(30_000);
  expect((await rig.advance()).kind).toBe("still-uncertain");
  rig.setClock(35_000);
  expect((await rig.advance()).kind).toBe("still-uncertain");
  expect(notices.filter(notice => notice.trigger === "repeated_uncertain")).toHaveLength(0);
  rig.setClock(60_000);
  expect((await rig.advance()).kind).toBe("still-uncertain");
  expect(notices.filter(notice => notice.trigger === "repeated_uncertain")).toHaveLength(1);
  expect(notices.every(notice => notice.effect === "notify-only")).toBe(true);
  expect(await rig.host.lifecycleFences().isFenced(fenceTarget(rig))).toBe(false);
  expect(rig.calls.dispatch).toBe(1);

  const readback = await timedOut({ dedup: "none" });
  readback.hooks.lookup = () => Promise.resolve({ not: "a lookup" });
  readback.setClock(30_000);
  expect((await readback.advance()).kind).toBe("still-uncertain");
  expect(notices.some(notice => notice.trigger === "readback_failed" && notice.effect === "notify-only")).toBe(true);
  expect(await readback.host.lifecycleFences().isFenced(fenceTarget(readback))).toBe(false);

  const crash = await dispatchRig(20, undefined, () => new Date(AT), notify);
  rigs.push(crash);
  await crash.confirm();
  expect(await crash.activate()).toBe(true);
  crash.hooks.dispatch = () => Promise.reject(new Error("synthetic connector crash"));
  expect((await crash.dispatch()).kind).not.toBe("refused");
  expect(notices.some(notice => notice.trigger === "adapter_crash" && notice.effect === "notify-only")).toBe(true);
  expect(await crash.host.lifecycleFences().isFenced(fenceTarget(crash))).toBe(false);
});

test("the hard trigger set is exactly the four that turn mutation off", () => {
  expect([...HARD].sort()).toEqual(["canary_secret_leaked", "destination_denied_at_connector", "duplicate_owner_object", "success_without_owner_evidence"]);
  expect(FENCE_TRIGGER_KINDS.filter(kind => isHardTrigger(kind))).toHaveLength(4);
});
