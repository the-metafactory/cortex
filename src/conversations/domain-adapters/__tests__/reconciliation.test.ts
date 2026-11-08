import { afterEach, expect, test } from "bun:test";
import { AT } from "../operations/fixtures";
import { legacyContext, legacyFixture } from "../operations/legacy-fixtures";
import { importLegacyOperation } from "../operations/legacy";
import { boundedWaitMs, convertLegacyReadback, separateHistoricFromCurrent } from "../operations/readback";
import { convertLegacyCreateResult, LEGACY_OWNER_CONVERSIONS, receiptStatus } from "../operations/reconciliation";
import { objectRef } from "../fixtures";
import { reconcileRig, type RigOptions } from "../operations/reconciliation-fixtures";
import { ownerResult } from "../operations/dispatch-fixtures";

type Rig = Awaited<ReturnType<typeof reconcileRig>>;
const rigs: Rig[] = [];
async function started(options?: RigOptions): Promise<Rig> {
  const rig = await reconcileRig(options);
  rigs.push(rig);
  await rig.begin();
  expect((await rig.dispatch()).kind).toBe("timed-out");
  expect((await rig.events())?.journal.state).toBe("uncertain");
  return rig;
}
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
const stored = async (rig: Rig) => { const value = await rig.events(); if (!value) throw new Error("Operation missing."); return value; };
const GUARANTEED = { retentionMs: 600_000 };

async function runLookups(rig: Rig): Promise<void> {
  for (const offset of [30_000, 35_000, 60_000]) {
    rig.setClock(offset);
    const outcome = await rig.advance();
    expect(outcome.kind).toBe("still-uncertain");
  }
}

test("late success is found by the first lookup and enters the journal once with no replay", async () => {
  const rig = await started({ dedup: GUARANTEED });
  rig.owner.reveal = true;
  const outcome = await rig.advance();
  expect(outcome.kind).toBe("settled");
  const operation = await stored(rig);
  expect(operation.journal.state).toBe("succeeded");
  expect(operation.outbox.map(item => item.key)).toEqual([`${rig.approval.operationId}:succeeded`]);
  expect(rig.calls.dispatch).toBe(1);
  expect(rig.calls.lookup).toBe(1);
  expect(rig.owner.effects.size).toBe(1);
  expect(receiptStatus(operation).cleanSuccess).toBe(true);
  expect((await rig.advance()).kind).toBe("not-applicable");
  expect(rig.calls.lookup).toBe(1);
});

test("automatic lookups follow the persisted schedule and survive a restart", async () => {
  const rig = await started({ dedup: "none" });
  const early = await rig.advance();
  expect(early.kind).toBe("still-uncertain");
  expect((await stored(rig)).budgets?.lookupCount).toBe(1);
  expect((await rig.advance()).kind).toBe("waiting");
  rig.setClock(35_000);
  await rig.reopen();
  await rig.activate();
  expect((await stored(rig)).budgets?.lookupCount).toBe(1);
  expect((await rig.advance()).kind).toBe("still-uncertain");
  rig.setClock(36_000);
  expect((await rig.advance()).kind).toBe("waiting");
  rig.setClock(60_000);
  expect((await rig.advance()).kind).toBe("still-uncertain");
  const after = await stored(rig);
  expect(after.budgets?.lookupCount).toBe(3);
  rig.setClock(61_000);
  const exhausted = await rig.advance();
  expect(exhausted.kind).toBe("exhausted");
  expect(rig.calls.lookup).toBe(3);
  expect(rig.calls.dispatch).toBe(1);
});

test("without an attested guarantee nothing is replayed and a manual Check is one read with no retry", async () => {
  const rig = await started({ dedup: "none" });
  await runLookups(rig);
  rig.setClock(62_000);
  const outcome = await rig.advance();
  expect(outcome.kind === "exhausted" && outcome.reason.code).toBe("dedup_unavailable");
  const before = await stored(rig);
  rig.setClock(300_000);
  const checked = await rig.check();
  expect(checked.kind).toBe("still-uncertain");
  const after = await stored(rig);
  expect(after.budgets?.lookupCount).toBe(3);
  expect(after.budgets?.redispatchCount).toBe(0);
  expect(rig.calls.lookup).toBe(4);
  expect(rig.calls.dispatch).toBe(1);
  expect(after.journal.events.length).toBe(before.journal.events.length + 1);
  expect(after.journal.state).toBe("uncertain");
});

test("one attested replay keeps the key and request ID, uses a new attempt, and yields one effect", async () => {
  const rig = await started({ dedup: GUARANTEED });
  await runLookups(rig);
  rig.setClock(60_500);
  expect((await rig.advance()).kind === "exhausted").toBe(true);
  rig.setClock(61_000);
  const replay = await rig.advance();
  expect(replay.kind).toBe("replayed");
  const operation = await stored(rig);
  expect(operation.journal.state).toBe("succeeded");
  const prepared = operation.journal.events.flatMap(entry => entry.event.kind === "attempt-prepared" ? [entry.event.attempt] : []);
  expect(prepared.map(attempt => [attempt.number, attempt.kind])).toEqual([[1, "initial"], [2, "retry"]]);
  expect(new Set(prepared.map(attempt => attempt.attemptId)).size).toBe(2);
  expect(prepared[1]?.dedupValidUntil).toBe(prepared[0]?.dedupValidUntil);
  expect(rig.calls.dispatch).toBe(2);
  expect(rig.owner.effects.size).toBe(1);
  expect(operation.outbox).toHaveLength(1);
  expect(operation.budgets?.redispatchCount).toBe(1);
  const again = await rig.advance();
  expect(again.kind).toBe("not-applicable");
  expect(rig.calls.dispatch).toBe(2);
});

test("a replay is refused after retention expiry, on a clock rollback, with a stop request, or once spent", async () => {
  const expired = await started({ dedup: { retentionMs: 61_000 } });
  await runLookups(expired);
  expired.setClock(61_000);
  const late = await expired.advance();
  expect(late.kind === "exhausted" && late.reason.code).toBe("dedup_expired");
  expect(expired.calls.dispatch).toBe(1);

  const rolled = await started({ dedup: GUARANTEED });
  await runLookups(rolled);
  rolled.setClock(50_000);
  const back = await rolled.advance();
  expect(back.kind === "exhausted" && back.reason.code).toBe("clock_discontinuity");
  expect(rolled.calls.dispatch).toBe(1);

  const stopped = await started({ dedup: GUARANTEED });
  await runLookups(stopped);
  stopped.setClock(61_000);
  const cancelled = await stopped.cancel();
  expect(cancelled.kind).toBe("stop-recorded");
  const blocked = await stopped.advance();
  expect(blocked.kind === "exhausted" && blocked.reason.code).toBe("replay_not_permitted");
  expect(stopped.calls.dispatch).toBe(1);

  const tight = await started({ dedup: GUARANTEED });
  await runLookups(tight);
  tight.setClock(95_000);
  const budgetEnd = await tight.advance();
  expect(budgetEnd.kind === "exhausted" && budgetEnd.reason.code).toBe("work_budget_exhausted");
  expect(tight.calls.dispatch).toBe(1);

  const spent = await started({ dedup: GUARANTEED });
  spent.owner.hangFirst = true;
  await runLookups(spent);
  spent.setClock(61_000);
  spent.hooks.dispatch = () => new Promise(() => undefined);
  expect((await spent.advance()).kind).toBe("replayed");
  expect((await stored(spent)).journal.state).toBe("uncertain");
  spent.setClock(100_000);
  const second = await spent.advance();
  expect(second.kind).toBe("exhausted");
  expect(spent.calls.dispatch).toBe(2);
});

test("a crash after the attempt was prepared reconciles first, then replays under the guarantee", async () => {
  const rig = await started({ dedup: GUARANTEED });
  rig.setClock(31_000);
  await rig.reopen();
  await rig.activate();
  const first = await rig.advance();
  expect(first.kind).toBe("still-uncertain");
  expect(rig.calls.lookup).toBe(1);
  expect(rig.calls.dispatch).toBe(1);
  rig.setClock(36_000);
  await rig.advance();
  rig.setClock(61_000);
  await rig.advance();
  rig.setClock(62_000);
  expect((await rig.advance()).kind).toBe("replayed");
  expect(rig.owner.effects.size).toBe(1);
  expect(rig.calls.dispatch).toBe(2);
  expect((await stored(rig)).outbox).toHaveLength(1);
});

test("recovery of a prepared dispatching operation after restart turns it uncertain before any lookup", async () => {
  const rig = await reconcileRig({ dedup: "none" });
  rigs.push(rig);
  await rig.begin();
  await rig.prepare();
  expect((await stored(rig)).journal.state).toBe("dispatching");
  await rig.reopen();
  await rig.activate();
  const outcomes = await rig.reconciler().recoverAll(rig.context, rig.lease, rig.sink, { inFlight: () => Promise.resolve([rig.approval.operationId, rig.approval.operationId]) });
  expect(outcomes.size).toBe(1);
  const operation = await stored(rig);
  expect(operation.journal.state).toBe("uncertain");
  expect(operation.journal.events.map(entry => entry.event.kind)).toEqual(["approved", "attempt-prepared", "wait-expired", "reconciliation"]);
  expect(rig.calls.lookup).toBe(1);
  expect(rig.calls.dispatch).toBe(0);
});

test("an inconclusive, denied or invalid lookup keeps uncertainty and never says no effect", async () => {
  const rig = await started({ dedup: "none" });
  rig.setClock(30_000);
  rig.hooks.lookup = () => Promise.resolve({ not: "a lookup" });
  const invalid = await rig.advance();
  expect(invalid.kind === "still-uncertain" && invalid.lookup).toBe("unavailable");
  rig.setClock(35_000);
  rig.hooks.lookup = () => Promise.reject(new Error("owner unreachable"));
  const down = await rig.advance();
  expect(down.kind === "still-uncertain" && down.lookup).toBe("unavailable");
  await rig.revokeConnection();
  rig.setClock(60_000);
  const denied = await rig.advance();
  expect(denied.kind === "still-uncertain" && denied.lookup).toBe("denied");
  expect((await stored(rig)).journal.state).toBe("uncertain");
  expect(receiptStatus(await stored(rig)).noEffect).toEqual([]);
});

test("a slow owner lookup is cut at its bounded wait and still counts", async () => {
  const rig = await started({ dedup: "none", lookupWaitMs: 15 });
  rig.setClock(30_000);
  rig.hooks.lookup = () => new Promise(() => undefined);
  const outcome = await rig.advance();
  expect(outcome.kind === "still-uncertain" && outcome.lookup).toBe("unavailable");
  const operation = await stored(rig);
  expect(operation.budgets?.lookupCount).toBe(1);
  const event = operation.journal.events.findLast(entry => entry.event.kind === "reconciliation");
  expect(event?.event.kind === "reconciliation" && event.event.lookup.result.kind === "unavailable" && event.event.lookup.result.reason.code).toBe("deadline_exceeded");
});

test("revocation after the fetch keeps the factual success but withholds its release", async () => {
  const rig = await started({ dedup: GUARANTEED });
  rig.owner.reveal = true;
  const reveal = rig.hooks.lookup;
  rig.hooks.lookup = async () => { const found = await reveal?.(); await rig.revokeConnection(); return found; };
  const outcome = await rig.advance();
  expect(outcome.kind).toBe("settled");
  const operation = await stored(rig);
  expect(operation.journal.state).toBe("succeeded");
  expect(receiptStatus(operation).effects).toHaveLength(1);
  expect(rig.calls.sends).toEqual([]);
  expect(rig.calls.dispatch).toBe(1);
});

test("duplicate evidence is a no-op, a conflicting payload is quarantined and blocks every retry", async () => {
  const rig = await started({ dedup: GUARANTEED });
  const request = () => ({ operationId: rig.approval.operationId, attemptId: rig.owner.attempts[0] ?? "", ownerRequestId: rig.approval.ownerRequestId, snapshot: rig.approval.snapshot });
  const accepted = (receipt: string) => rig.answer({ kind: "known", response: { ...ownerResult(request(), "accepted", "same-result"), result: { kind: "accepted", ownerRequestId: rig.approval.ownerRequestId, receipt: { ticket: receipt } } } });
  rig.hooks.lookup = () => Promise.resolve(accepted("ticket-a"));
  rig.setClock(30_000);
  await rig.advance();
  const first = await stored(rig);
  rig.setClock(35_000);
  await rig.advance();
  expect((await stored(rig)).quarantine).toHaveLength(0);
  rig.hooks.lookup = () => Promise.resolve(accepted("ticket-b"));
  rig.setClock(60_000);
  await rig.advance();
  const conflicted = await stored(rig);
  expect(conflicted.quarantine.map(item => item.code)).toEqual(["outcome_conflict"]);
  expect(conflicted.retryBlocked).toBe(true);
  expect(receiptStatus(conflicted).investigation).toBe(true);
  expect(first.quarantine).toHaveLength(0);
  rig.setClock(61_000);
  const outcome = await rig.advance();
  expect(outcome.kind === "exhausted" && outcome.reason.code).toBe("replay_not_permitted");
  expect(rig.calls.dispatch).toBe(1);
});

test("final no-effect evidence fails the operation and never triggers an automatic replay", async () => {
  const rig = await started({ dedup: GUARANTEED });
  rig.setClock(30_000);
  rig.hooks.lookup = () => Promise.resolve(rig.answer({ kind: "no-effect", evidence: { kind: "no-effect", evidenceId: "no-effect-a", observedAt: AT, ownerRequestId: rig.approval.ownerRequestId, receipt: { absent: true }, final: true } }));
  expect((await rig.advance()).kind).toBe("settled");
  const operation = await stored(rig);
  expect(operation.journal.state).toBe("failed");
  expect(receiptStatus(operation).noEffect).toHaveLength(1);
  rig.setClock(120_000);
  expect((await rig.advance()).kind).toBe("not-applicable");
  expect(rig.calls.dispatch).toBe(1);
});

test("a deleted, denied, unavailable or unknown object never changes or disproves the historic success", async () => {
  const rig = await started({ dedup: GUARANTEED });
  rig.owner.reveal = true;
  await rig.advance();
  const ref = objectRef("balance", "area", "area-example");
  const answer = (result: object) => ({ lifecycleVersion: "1.0.0", ref, checkedAt: AT, provenance: { adapterId: "balance", connectionId: ref.connectionId, evidenceId: "read-evidence" }, result });
  const sink = rig.sink;
  const reader = rig.reader();
  const outcomes: Record<string, string> = {};
  const variants: [string, object][] = [
    ["deleted", { kind: "deleted", evidenceId: "tombstone-1" }],
    ["denied", { kind: "denied", reason: { code: "owner_denied", message: "No access." } }],
    ["unavailable", { kind: "unavailable", reason: { code: "owner_down", message: "Down." } }],
    ["unknown", { kind: "unknown", reason: { code: "owner_unknown", message: "Unknown." } }],
  ];
  for (const [name, result] of variants) {
    rig.hooks.readback = () => Promise.resolve(answer(result));
    const read = await reader.read(rig.context, ref, sink);
    const separated = separateHistoricFromCurrent(await stored(rig), read);
    outcomes[name] = `${separated.historic}/${separated.current}`;
    expect(separated.recreateAllowed).toBe(false);
  }
  expect(outcomes).toEqual({ deleted: "succeeded/deleted", denied: "succeeded/denied", unavailable: "succeeded/unavailable", unknown: "succeeded/unknown" });
  expect(rig.calls.dispatch).toBe(1);
  expect(receiptStatus(await stored(rig)).effects).toHaveLength(1);
});

test("object readback is gated before the fetch, bounded, and validated against the registry", async () => {
  const rig = await started({ dedup: "none", lookupWaitMs: 15 });
  const ref = objectRef("balance", "area", "area-example");
  const reader = rig.reader();
  await rig.revokeConnection();
  const gated = await reader.read(rig.context, ref, rig.sink);
  expect(gated.kind).toBe("withheld");
  expect(rig.calls.readback).toBe(0);

  const second = await started({ dedup: "none", lookupWaitMs: 15 });
  second.hooks.readback = () => new Promise(() => undefined);
  const slow = await second.reader().read(second.context, ref, second.sink);
  expect(slow.kind === "unavailable" && slow.reason.code).toBe("deadline_exceeded");
  second.hooks.readback = () => Promise.resolve({ lifecycleVersion: "1.0.0", ref, checkedAt: AT, provenance: { adapterId: "balance", connectionId: ref.connectionId, evidenceId: "x" }, result: { kind: "present", schemaRef: { schemaId: "unknown.schema", version: "1.0.0" }, value: { any: 1 }, links: [] } });
  const invalid = await second.reader().read(second.context, ref, second.sink);
  expect(invalid.kind).toBe("withheld");
});

test("a read that outlives its wait is never released to the sink", async () => {
  const rig = await started({ dedup: "none" });
  const ref = objectRef("balance", "area", "area-example");
  const late = { lifecycleVersion: "1.0.0", ref, checkedAt: AT, provenance: { adapterId: "balance", connectionId: ref.connectionId, evidenceId: "late" }, result: { kind: "deleted", evidenceId: "tombstone-late" } };
  rig.hooks.readback = () => new Promise(resolve => setTimeout(() => resolve(late), 40));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const observed = await rig.host.lifecycleAuthority(rig.registry, rig.bindings).readbackObserved(rig.context, { lifecycleVersion: "1.0.0", ref }, rig.sink, controller.signal);
  expect(observed.called).toBe(true);
  expect(observed.projection.kind).toBe("withheld");
});

test("recovery advances independent operations concurrently", async () => {
  const rig = await started({ dedup: "none", lookupWaitMs: 100 });
  rig.hooks.lookup = () => new Promise(resolve => setTimeout(() => resolve(rig.answer(rig.unknown)), 60));
  const ids = [rig.approval.operationId, "missing-a", "missing-b"];
  const outcomes = await rig.reconciler().recoverAll(rig.context, rig.lease, rig.sink, { inFlight: () => Promise.resolve(ids) });
  expect([...outcomes.keys()].sort()).toEqual([...ids].sort());
});

test("legacy imports are never looked up or replayed, and legacy shapes map conservatively", async () => {
  const rig = await reconcileRig({ dedup: GUARANTEED });
  rigs.push(rig);
  const source = legacyFixture("running");
  const operationId = source.record.operationId;
  const imported = await importLegacyOperation(rig.host.lifecycleJournal(rig.registry), source, legacyContext(source), AT);
  expect(imported.journal.state).toBe("uncertain");
  const outcome = await rig.reconciler().advance(rig.context, operationId, rig.lease, rig.sink);
  expect(outcome.kind === "not-applicable" && outcome.reason.code).toBe("legacy_ambiguous");
  expect(rig.calls.lookup).toBe(0);
  expect(rig.calls.dispatch).toBe(0);

  expect(convertLegacyReadback({ found: false }, AT)).toMatchObject({ historic: "unknown", current: "unknown", retryPermitted: false });
  expect(convertLegacyReadback(null, AT)).toMatchObject({ historic: "unknown", current: "unavailable", retryPermitted: false });
  expect(convertLegacyReadback({ found: true, canonicalId: "task-example" }, AT)).toMatchObject({ historic: "unknown", current: "present" });
  expect(convertLegacyReadback({ found: true, canonicalId: "task-example" }, AT, { identityLinked: true, deletionProof: false }).historic).toBe("positive-linked");
  expect(convertLegacyCreateResult({ state: "failed", error: "Owner connection closed" }, "balance-task").state).toBe("uncertain");
  expect(convertLegacyCreateResult({ state: "failed", error: "closed" }, "balance-task", new Map([["balance-task", { owner: "balance-task", failureProvesNoEffect: true }]])).state).toBe("failed");
  expect(convertLegacyCreateResult({ state: "accepted" }, "balance-task").state).toBe("uncertain");
  expect(convertLegacyCreateResult({ state: "accepted", receipt: "original-acceptance" }, "balance-task")).toMatchObject({ state: "pending", receipt: "original-acceptance", retryPermitted: false });
  expect(LEGACY_OWNER_CONVERSIONS.size).toBe(0);
});

test("per-lookup budgets are five seconds for Balance and Flow and twenty for the work graph", () => {
  expect(boundedWaitMs("balance.task.create")).toBe(5_000);
  expect(boundedWaitMs("flow.saved.create")).toBe(5_000);
  expect(boundedWaitMs("work-graph.node.create")).toBe(20_000);
  expect(boundedWaitMs("graph.read")).toBe(20_000);
});
