import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { authorityRig } from "../../authority-fixtures";
import { BatchReceiptError, legacyBatchProjection, summarizeBatch, type BatchReadOutcome } from "../operations/batches";
import { AT, approvalFixture, attemptFixture, eventFixture, support } from "../operations/fixtures";
import { ownerResult } from "../operations/dispatch-fixtures";
import type { OperationState, OwnerResult } from "../operations/types";

type Rig = Awaited<ReturnType<typeof authorityRig>>;
const rigs: Rig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
async function rigged(): Promise<Rig> { const rig = await authorityRig(); rigs.push(rig); return rig; }

type Kind = "unattempted" | OperationState;
interface Built { batchId: string; items: { itemId: string; operationId: string }[]; kinds: Kind[] }

function failed(request: Parameters<typeof ownerResult>[0], resultId = "result-failed"): OwnerResult {
  const base = ownerResult(request, "cancelled", resultId);
  if (base.result.kind !== "cancelled") throw new Error("Synthetic result malformed.");
  return { ...base, result: { kind: "failed", error: { code: "balance.synthetic_failure", message: "The owner refused." }, evidence: base.result.evidence } };
}

async function build(rig: Rig, kinds: Kind[], batchId = randomUUID()): Promise<Built> {
  const journal = rig.host.lifecycleJournal(rig.registry);
  const items = kinds.map((_, at) => ({ itemId: `item-${at}`, operationId: `${batchId}:op-${at}` }));
  await rig.host.lifecycleBatches().register({ batchId, connectionId: rig.connection.connectionId, items });
  for (const [at, kind] of kinds.entries()) {
    const item = items[at];
    if (!item || kind === "unattempted") continue;
    const approval = { ...approvalFixture(item.operationId), ownerRequestId: `request-${item.operationId}`, links: { batchId, itemId: item.itemId } };
    await journal.approve(approval);
    if (kind === "confirmed") continue;
    const attempt = attemptFixture();
    const request = { operationId: item.operationId, attemptId: attempt.attemptId, ownerRequestId: approval.ownerRequestId, snapshot: approval.snapshot };
    let stored = await journal.append(item.operationId, 1, eventFixture(2, { kind: "attempt-prepared", attempt }), { support });
    const feed = async (response: OwnerResult): Promise<void> => { stored = await journal.append(item.operationId, stored.revision, eventFixture(stored.journal.sequence + 1, { kind: "owner-result", response })); };
    if (kind === "succeeded") await feed(ownerResult(request, "succeeded"));
    else if (kind === "pending") await feed(ownerResult(request, "accepted"));
    else if (kind === "cancelled") await feed(ownerResult(request, "cancelled"));
    else if (kind === "failed") await feed(failed(request));
    else if (kind === "uncertain") await journal.append(item.operationId, stored.revision, eventFixture(stored.journal.sequence + 1, { kind: "wait-expired", attemptId: attempt.attemptId, reason: { code: "deadline_exceeded", message: "No answer." } }));
  }
  return { batchId, items, kinds };
}

async function read(rig: Rig, batchId: string): Promise<Extract<BatchReadOutcome, { kind: "released" }>> {
  const outcome = await rig.host.lifecycleBatchReader(rig.registry, rig.bindings).read(rig.context, batchId, rig.sink);
  if (outcome.kind !== "released") throw new Error(`Batch read withheld: ${outcome.reason.code}`);
  return outcome;
}

test("F7 partial batch keeps every item state, never reruns a success and makes zero owner calls", async () => {
  const rig = await rigged();
  const built = await build(rig, ["succeeded", "failed", "uncertain", "unattempted"]);
  const outcome = await read(rig, built.batchId);
  expect(outcome.projection.receipt.summary).toBe("partial");
  expect(outcome.projection.receipt.atomic).toBe(false);
  expect(outcome.projection.receipt.items.map(item => item.state)).toEqual(["succeeded", "failed", "uncertain", "unattempted"]);
  expect(outcome.projection.receipt.items.map(item => item.operationId)).toEqual(built.items.map(item => item.operationId));
  expect(rig.calls.dispatch + rig.calls.lookup + rig.calls.cancel + rig.calls.readback).toBe(0);
  const again = await read(rig, built.batchId);
  expect(again.projection).toEqual(outcome.projection);
  expect(rig.calls.dispatch).toBe(0);
});

test("summary precedence follows the approved order", () => {
  const cases: [Kind[], ReturnType<typeof summarizeBatch>][] = [
    [["unattempted", "unattempted"], "unattempted"],
    [["succeeded", "succeeded"], "succeeded"],
    [["succeeded", "unattempted"], "partial"],
    [["succeeded", "uncertain"], "partial"],
    [["uncertain", "failed", "unattempted"], "uncertain"],
    [["pending", "failed"], "pending"],
    [["confirmed", "unattempted"], "pending"],
    [["cancelled", "cancelled"], "cancelled"],
    [["cancelled", "failed"], "failed"],
    [["conflict", "refused"], "failed"],
    [["failed", "unattempted"], "failed"],
  ];
  for (const [states, summary] of cases) expect(summarizeBatch(states)).toBe(summary);
  expect(() => summarizeBatch([])).toThrow(BatchReceiptError);
});

test("all-cancelled and mixed terminal batches read through the public seam", async () => {
  const rig = await rigged();
  const cancelled = await build(rig, ["cancelled", "cancelled"]);
  expect((await read(rig, cancelled.batchId)).projection.receipt.summary).toBe("cancelled");
  const mixed = await build(rig, ["failed", "cancelled", "unattempted"]);
  expect((await read(rig, mixed.batchId)).projection.receipt.summary).toBe("failed");
  const fresh = await build(rig, ["unattempted", "unattempted"]);
  expect((await read(rig, fresh.batchId)).projection.receipt.summary).toBe("unattempted");
});

test("empty batches, duplicate links and cross-batch links are rejected without allocating identities", async () => {
  const rig = await rigged();
  const batches = rig.host.lifecycleBatches();
  const connectionId = rig.connection.connectionId;
  const batchId = randomUUID();
  await expect(batches.register({ batchId, connectionId, items: [] })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(batches.register({ batchId, connectionId, items: [{ itemId: "a", operationId: "o1" }, { itemId: "a", operationId: "o2" }] })).rejects.toMatchObject({ code: "link_conflict" });
  await expect(batches.register({ batchId, connectionId, items: [{ itemId: "a", operationId: "o1" }, { itemId: "b", operationId: "o1" }] })).rejects.toMatchObject({ code: "link_conflict" });
  expect(await batches.index(batchId)).toBeNull();
  await batches.register({ batchId, connectionId, items: [{ itemId: "a", operationId: "o1" }] });
  await batches.register({ batchId, connectionId, items: [{ itemId: "a", operationId: "o1" }] });
  await expect(batches.register({ batchId, connectionId, items: [{ itemId: "a", operationId: "o9" }] })).rejects.toMatchObject({ code: "link_conflict" });
  await expect(batches.register({ batchId: randomUUID(), connectionId, items: [{ itemId: "z", operationId: "o1" }] })).rejects.toMatchObject({ code: "link_conflict" });
});

test("a journal that links another batch, another connection or a compensation is rejected", async () => {
  const rig = await rigged();
  const journal = rig.host.lifecycleJournal(rig.registry);
  const batches = rig.host.lifecycleBatches();
  const connectionId = rig.connection.connectionId;
  const other = randomUUID();
  await journal.approve({ ...approvalFixture("cross:1"), links: { batchId: other, itemId: "a" } });
  await expect(batches.register({ batchId: randomUUID(), connectionId, items: [{ itemId: "a", operationId: "cross:1" }] })).rejects.toMatchObject({ code: "link_mismatch" });
  await journal.approve({ ...approvalFixture("missing:1") });
  await expect(batches.register({ batchId: randomUUID(), connectionId, items: [{ itemId: "a", operationId: "missing:1" }] })).rejects.toMatchObject({ code: "link_mismatch" });
  const batchId = randomUUID();
  await journal.approve({ ...approvalFixture("comp:1"), links: { batchId, itemId: "a", compensatesOperationId: "x" } });
  await expect(batches.register({ batchId, connectionId, items: [{ itemId: "a", operationId: "comp:1" }] })).rejects.toMatchObject({ code: "link_mismatch" });
  await expect(batches.register({ batchId: randomUUID(), connectionId: "other-connection", items: [{ itemId: "a", operationId: "cross:1" }] })).rejects.toMatchObject({ code: "link_mismatch" });
});

test("a journal created later with wrong links makes the read fail closed", async () => {
  const rig = await rigged();
  const batchId = randomUUID();
  await rig.host.lifecycleBatches().register({ batchId, connectionId: rig.connection.connectionId, items: [{ itemId: "a", operationId: "late:1" }] });
  await rig.host.lifecycleJournal(rig.registry).approve({ ...approvalFixture("late:1"), links: { batchId: randomUUID(), itemId: "a" } });
  await expect(rig.host.lifecycleBatches().derive(batchId)).rejects.toMatchObject({ code: "link_mismatch" });
});

test("results arriving duplicated or after reopening change the derived state without owner calls", async () => {
  const rig = await rigged();
  const built = await build(rig, ["pending", "unattempted"]);
  expect((await read(rig, built.batchId)).projection.receipt.summary).toBe("pending");
  const journal = rig.host.lifecycleJournal(rig.registry);
  const opId = built.items[0]?.operationId ?? "";
  const stored = await journal.read(opId);
  const attempt = stored?.journal.events.find(entry => entry.event.kind === "attempt-prepared");
  if (attempt?.event.kind !== "attempt-prepared" || !stored || "kind" in stored.journal.snapshot) throw new Error("Fixture incomplete.");
  const response = ownerResult({ operationId: opId, attemptId: attempt.event.attempt.attemptId, ownerRequestId: stored.journal.ownerRequestId, snapshot: stored.journal.snapshot }, "succeeded");
  const first = await journal.append(opId, stored.revision, eventFixture(stored.journal.sequence + 1, { kind: "owner-result", response }));
  await journal.append(opId, first.revision, eventFixture(first.journal.sequence + 1, { kind: "owner-result", response }));
  await rig.reopen();
  const outcome = await read(rig, built.batchId);
  expect(outcome.projection.receipt.items.map(item => item.state)).toEqual(["succeeded", "unattempted"]);
  expect(outcome.projection.receipt.summary).toBe("partial");
  expect((await rig.host.lifecycleJournal(rig.registry).read(opId))?.journal.events.filter(entry => entry.event.kind === "owner-result")).toHaveLength(2);
  expect(rig.calls.dispatch + rig.calls.lookup).toBe(0);
});

test("a quarantined item is flagged for investigation without exposing raw evidence", async () => {
  const rig = await rigged();
  const built = await build(rig, ["pending", "unattempted"]);
  const journal = rig.host.lifecycleJournal(rig.registry);
  const opId = built.items[0]?.operationId ?? "";
  const stored = await journal.read(opId);
  if (!stored) throw new Error("Fixture incomplete.");
  await journal.receive(opId, stored.revision, { garbage: true }, AT);
  const outcome = await read(rig, built.batchId);
  expect(outcome.projection.investigation).toEqual([{ itemId: "item-0", operationId: opId, retryBlocked: true, quarantined: 1 }]);
  expect(JSON.stringify(outcome.projection)).not.toContain("garbage");
});

test("the read route is gated by current authority and unknown batches look the same as withheld ones", async () => {
  const rig = await rigged();
  const built = await build(rig, ["succeeded"]);
  const reader = rig.host.lifecycleBatchReader(rig.registry, rig.bindings);
  expect((await reader.read(rig.context, randomUUID(), rig.sink)).kind).toBe("withheld");
  expect((await reader.read(rig.context, built.batchId, { kind: "web", conversationId: "someone-else" })).kind).toBe("withheld");
  rig.policy.releaseAllowed = false;
  const denied = await reader.read(rig.context, built.batchId, rig.sink);
  expect(denied.kind).toBe("withheld");
  rig.policy.releaseAllowed = true;
  rig.policy.readsAllowed = false;
  expect((await reader.read(rig.context, built.batchId, rig.sink)).kind).toBe("withheld");
  expect(rig.calls.sends).toHaveLength(0);
  rig.policy.readsAllowed = true;
  await rig.revokeConnection();
  expect((await reader.read(rig.context, built.batchId, rig.sink)).kind).toBe("withheld");
});

test("narrowing the connection read scope withholds batches whose items fall outside it", async () => {
  const rig = await rigged();
  const built = await build(rig, ["succeeded", "unattempted"]);
  const reader = rig.host.lifecycleBatchReader(rig.registry, rig.bindings);
  expect((await reader.read(rig.context, built.batchId, rig.sink)).kind).toBe("released");
  const previous = Number(rig.connection.connectionRevision);
  rig.connection.connectionRevision = String(previous + 1);
  rig.connection.readCapabilityIds = rig.connection.readCapabilityIds.filter(id => id !== rig.approval.snapshot.capabilityId);
  await rig.service.publishHostRecord({ kind: "connection", value: rig.connection }, previous);
  expect((await reader.read(rig.context, built.batchId, rig.sink)).kind).toBe("withheld");
});

test("internal derivation confers no access and legacy clients are told to upgrade", async () => {
  const rig = await rigged();
  const built = await build(rig, ["succeeded"]);
  expect((await rig.host.lifecycleBatches().derive(built.batchId)).receipt.summary).toBe("succeeded");
  expect(rig.calls.sends).toHaveLength(0);
  expect(legacyBatchProjection()).toMatchObject({ route: "upgrade-required", reason: { code: "upgrade_required" } });
});
