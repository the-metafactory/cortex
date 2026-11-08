import { describe, expect, test } from "bun:test";
import { approvalFixture, attemptFixture, AT, authority, eventFixture, prepareOperationFixture, registryFixture, resultFixture, support } from "../operations/fixtures";
import { JournalConflict, OperationJournalStore } from "../operations/journal";
import * as schemas from "../operations/types";
import { canonicalWire, snapshotDigest, validateResultPayload, validateSnapshot } from "../operations/validation";

import { journalStoreTestFixture } from "./journal-store";

const { hosts, open } = journalStoreTestFixture();
async function prepared() {
  const host = await open();
  return { ...host, ...await prepareOperationFixture(host.journal) };
}
const timeout = (attemptId: string) => ({ kind: "wait-expired" as const, attemptId, reason: { code: "deadline_exceeded", message: "Synthetic timeout." } });

function wireExamples() {
  const approval = approvalFixture();
  const attempt = attemptFixture();
  const response = resultFixture(approval, attempt);
  const ref = { adapterId: "balance", connectionId: "connection-example", objectType: "task", canonicalId: "task-example" };
  const event = eventFixture(1, { kind: "approved", snapshot: approval.snapshot, authority });
  return [
    [schemas.EnvelopeSchema, { lifecycleVersion: "1.0.0" }], [schemas.ApprovedSnapshotSchema, approval.snapshot], [schemas.AuthoritySchema, authority], [schemas.OwnerSupportSchema, support],
    [schemas.DispatchRequestSchema, { lifecycleVersion: "1.0.0", operationId: approval.operationId, attemptId: attempt.attemptId, idempotencyKey: approval.operationId, ownerRequestId: approval.ownerRequestId, snapshot: approval.snapshot, authority, supportDeclarationId: support.declarationId, deadlineAt: attempt.deadlineAt }],
    [schemas.AttemptSchema, attempt], [schemas.OwnerResultSchema, response], [schemas.JournalEventSchema, event],
    [schemas.OperationJournalSchema, { lifecycleVersion: "1.0.0", operationId: approval.operationId, sequence: 1, state: "confirmed", idempotencyKey: approval.operationId, ownerRequestId: approval.ownerRequestId, snapshot: approval.snapshot, events: [event] }],
    [schemas.OperationLookupSchema, { lifecycleVersion: "1.0.0", operationId: approval.operationId, checkedAt: AT, result: { kind: "known", response } }],
    [schemas.ObjectReadbackSchema, { lifecycleVersion: "1.0.0", ref, checkedAt: AT, provenance: { adapterId: ref.adapterId, connectionId: ref.connectionId, evidenceId: "evidence-example" }, result: { kind: "unknown", reason: { code: "unavailable", message: "Synthetic unavailable." } } }],
    [schemas.CancelRequestSchema, { lifecycleVersion: "1.0.0", operationId: approval.operationId, cancelId: "cancel-example", authority, requestedAt: AT }],
    [schemas.BatchReceiptSchema, { lifecycleVersion: "1.0.0", batchId: crypto.randomUUID(), atomic: false, items: [], summary: "unattempted" }],
  ] as const;
}

describe("operation lifecycle validation", () => {
  test("all normative wire envelopes are closed and versioned", () => {
    for (const [schema, value] of wireExamples()) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(schema.safeParse({ ...value, extra: true }).success).toBe(false);
      if ("lifecycleVersion" in value) expect(schema.safeParse({ ...value, lifecycleVersion: "1.1.0" }).success).toBe(false);
    }
    const response = resultFixture(approvalFixture(), attemptFixture());
    expect(schemas.OwnerResultSchema.safeParse({ ...response, operationId: " " }).success).toBe(false);
    expect(schemas.OwnerResultSchema.safeParse({ ...response, result: { kind: "done" } }).success).toBe(false);
    expect(schemas.ApprovedSnapshotSchema.safeParse({ ...approvalFixture().snapshot, destinations: [{ adapterId: "balance" }] }).success).toBe(false);
    expect(() => schemas.parseWire(schemas.OwnerResultSchema, { ...response, result: { ...response.result, receipt: { invalid: undefined } } })).toThrow();
  });
  test("digest uses RFC8785 key and number serialization and rejects noncanonical JSON", () => {
    expect(canonicalWire({ z: 1e30, a: { "10": 10, "2": 2 } })).toBe('{"a":{"10":10,"2":2},"z":1e+30}');
    const snapshot = approvalFixture().snapshot;
    expect(snapshotDigest({ ...snapshot, input: { title: "Synthetic task", area: { canonicalId: "area-example", objectType: "area", connectionId: "connection-example", adapterId: "balance" } } })).toBe(snapshot.digest);
    for (const input of [Infinity, NaN, undefined, "\ud800"]) expect(() => snapshotDigest({ ...snapshot, input } as typeof snapshot)).toThrow();
  });
  test("snapshot pins exact registry versions and retains content without defaults", () => {
    const registry = registryFixture();
    const snapshot = approvalFixture().snapshot;
    expect(validateSnapshot(registry, snapshot)).toEqual(snapshot);
    const incompatibleRegistry = registryFixture();
    expect(() => validateResultPayload(incompatibleRegistry, { ...snapshot, outputSchemaRef: { ...snapshot.outputSchemaRef, version: "1.1.0" } }, resultFixture(approvalFixture(), attemptFixture(), "succeeded"))).toThrow();
    for (const change of [{ inputSchemaRef: { ...snapshot.inputSchemaRef, version: "1.0.1" } }, { outputSchemaRef: { ...snapshot.outputSchemaRef, version: "2.0.0" } }, { input: { title: "missing area" } }, { destinations: [{ ...snapshot.destinations[0]!, connectionId: "other-connection" }] }, { digest: "0".repeat(64) }]) expect(() => validateSnapshot(registry, { ...snapshot, ...change })).toThrow();
  });
});

describe("durable lifecycle journal", () => {
  test("F10 approval is immutable and one concurrent attempt wins across journal instances", async () => {
    const host = await open();
    const approval = approvalFixture();
    const original = await host.journal.approve(approval);
    expect(await host.journal.approve(approval)).toEqual(original);
    const changed = structuredClone(approval);
    changed.snapshot.input = { area: approval.snapshot.destinations[0]!, title: "Edited after approval" };
    changed.snapshot.digest = snapshotDigest(changed.snapshot);
    await expect(host.journal.approve(changed)).rejects.toBeInstanceOf(JournalConflict);
    const concurrent = new OperationJournalStore(host.engine, registryFixture());
    const writes = await Promise.allSettled([host.journal, concurrent].map(journal => journal.append(approval.operationId, 1, eventFixture(2, { kind: "attempt-prepared", attempt: attemptFixture() }), { support })));
    expect(writes.filter(write => write.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter(write => write.status === "rejected")).toHaveLength(1);
    expect((await host.journal.read(approval.operationId))?.journal.events).toHaveLength(2);
    await host.close(); hosts.pop();
    const reopened = await open(host.dir);
    await expect(reopened.journal.append(approval.operationId, 2, eventFixture(3, { kind: "attempt-prepared", attempt: attemptFixture() }), { support })).rejects.toThrow();
    expect((await reopened.journal.read(approval.operationId))?.journal.ownerRequestId).toBe(approval.ownerRequestId);
  });
  test("F4 F5 exact accepted receipt survives reopen; duplicate and late success create one outbox item", async () => {
    const host = await prepared();
    const accepted = resultFixture(host.approval, host.attempt);
    await host.journal.receive(host.approval.operationId, 2, accepted, AT);
    const once = await host.journal.receive(host.approval.operationId, 3, accepted, AT);
    expect(once.journal.sequence).toBe(3);
    await host.close(); hosts.pop();
    const reopened = await open(host.dir);
    expect(await reopened.journal.read(host.approval.operationId)).toEqual(once);
    await reopened.journal.append(host.approval.operationId, 3, eventFixture(4, timeout(host.attempt.attemptId)));
    const success = resultFixture(host.approval, host.attempt, "succeeded");
    const done = await reopened.journal.receive(host.approval.operationId, 4, success, AT);
    expect(done.journal.state).toBe("succeeded");
    expect(done.journal.snapshot).toEqual(host.approval.snapshot);
    expect(done.outbox).toEqual([{ key: `${host.approval.operationId}:succeeded`, event: done.journal.events[4]!, delivered: false }]);
    const repeat = await reopened.journal.receive(host.approval.operationId, 5, success, AT);
    expect(repeat).toEqual(done);
    await reopened.close(); hosts.pop();
    const again = await open(host.dir);
    expect(await again.journal.read(host.approval.operationId)).toEqual(done);
    const delivered = await again.journal.acknowledgeSuccess(host.approval.operationId, 5, done.outbox[0]!.key);
    expect(delivered.outbox[0]?.delivered).toBe(true);
  });
  test("F4 malformed acceptance retains raw data and can never assert no effect", async () => {
    const host = await prepared();
    const accepted = resultFixture(host.approval, host.attempt);
    const raw = { ...accepted, result: { kind: "accepted", ownerRequestId: host.approval.ownerRequestId } };
    const stored = await host.journal.receive(host.approval.operationId, 2, raw, AT);
    expect(stored.journal.state).toBe("uncertain");
    expect(stored.quarantine[0]?.raw).toEqual(raw);
    expect(stored.retryBlocked).toBe(true);
    expect(stored.outbox).toHaveLength(0);
  });
  test("identity and exact domain output errors quarantine receipts without success", async () => {
    for (const mode of ["operation", "attempt", "digest", "request", "output", "refs", "error"] as const) {
      const host = await prepared();
      const response = resultFixture(host.approval, host.attempt, "succeeded");
      if (mode === "operation") response.operationId = "other-operation";
      if (mode === "attempt") response.attemptId = crypto.randomUUID();
      if (mode === "digest") response.snapshotDigest = "0".repeat(64);
      if (response.result.kind !== "succeeded") throw new Error("Success fixture required.");
      if (mode === "request") response.result.evidence.ownerRequestId = "wrong-request";
      if (mode === "output") response.result.output = { nonsense: true };
      if (mode === "refs") response.result.evidence.refs[0]!.canonicalId = "other-task";
      if (mode === "error") response.result = { kind: "failed", error: { code: "wrong.error", message: "Synthetic failure." }, evidence: { kind: "no-effect", evidenceId: "no-effect-example", observedAt: AT, ownerRequestId: host.approval.ownerRequestId, receipt: {}, final: true } };
      const stored = await host.journal.receive(host.approval.operationId, 2, response, AT);
      expect(stored.journal.state).toBe("uncertain");
      expect(stored.quarantine).toHaveLength(1);
      expect(stored.retryBlocked).toBe(true);
      expect(stored.outbox).toHaveLength(0);
    }
  });
  test("F9 stop before dispatch prevents all attempts; stop after dispatch preserves late success", async () => {
    const host = await open();
    const approval = approvalFixture();
    await host.journal.approve(approval);
    const cancelled = await host.journal.append(approval.operationId, 1, eventFixture(2, { kind: "cancel-requested", cancelId: "cancel-example", authority }));
    expect(cancelled.journal.state).toBe("cancelled");
    await expect(host.journal.append(approval.operationId, 2, eventFixture(3, { kind: "attempt-prepared", attempt: attemptFixture() }), { support })).rejects.toThrow();
    const active = await prepared();
    await active.journal.append(active.approval.operationId, 2, eventFixture(3, { kind: "cancel-requested", cancelId: "cancel-example", authority }));
    const succeeded = await active.journal.receive(active.approval.operationId, 3, resultFixture(active.approval, active.attempt, "succeeded"), AT);
    expect(succeeded.journal.state).toBe("succeeded");
    expect(succeeded.cancelRequested).toBe(true);
    expect(succeeded.quarantine).toHaveLength(0);
    await active.close(); hosts.pop();
    const reopened = await open(active.dir);
    expect((await reopened.journal.read(active.approval.operationId))?.cancelRequested).toBe(true);
  });
  test("contradictory and same-id changed evidence is preserved and blocks retries", async () => {
    const host = await prepared();
    const accepted = resultFixture(host.approval, host.attempt);
    await host.journal.receive(host.approval.operationId, 2, accepted, AT);
    const changed = structuredClone(accepted);
    if (changed.result.kind !== "accepted") throw new Error("Acceptance fixture required.");
    changed.result.receipt = { ticket: "different-ticket" };
    const conflict = await host.journal.receive(host.approval.operationId, 3, changed, AT);
    expect(conflict.journal.events).toHaveLength(4);
    expect(conflict.quarantine[0]?.code).toBe("outcome_conflict");
    expect(conflict.retryBlocked).toBe(true);
    const effect = resultFixture(host.approval, host.attempt, "succeeded");
    await host.journal.receive(host.approval.operationId, 4, effect, AT);
    const noEffect: schemas.OwnerResult = { ...accepted, resultId: "result-no-effect", result: { kind: "cancelled", evidence: { kind: "no-effect", evidenceId: "no-effect-example", observedAt: AT, ownerRequestId: host.approval.ownerRequestId, receipt: { fenced: true }, final: true } } };
    const late = await host.journal.receive(host.approval.operationId, 5, noEffect, AT);
    expect(late.journal.state).toBe("succeeded");
    expect(late.quarantine.at(-1)?.code).toBe("outcome_conflict");
    expect(late.outbox).toHaveLength(1);
  });
  test("F10 recovery turns persisted dispatching into uncertainty without preparing another attempt", async () => {
    const host = await prepared();
    await host.close(); hosts.pop();
    const reopened = await open(host.dir);
    const recovered = await reopened.journal.recover(host.approval.operationId, 2, "2026-11-01T00:00:31.000Z");
    expect(recovered.journal.state).toBe("uncertain");
    expect(recovered.journal.events.filter(entry => entry.event.kind === "attempt-prepared")).toHaveLength(1);
    expect(recovered.journal.ownerRequestId).toBe(host.approval.ownerRequestId);
    expect(await reopened.journal.recover(host.approval.operationId, recovered.revision, "2026-11-01T00:00:32.000Z")).toEqual(recovered);
  });
  test("historical final no-effect permits an explicit retry while lookup and outbox bookkeeping preserve contiguous events", async () => {
    const host = await prepared();
    await host.journal.append(host.approval.operationId, 2, eventFixture(3, timeout(host.attempt.attemptId)));
    const reserved = await host.journal.reserveLookup(host.approval.operationId, 3, "2026-11-01T00:00:30.000Z");
    expect(reserved.revision).toBe(4);
    expect(reserved.journal.sequence).toBe(3);
    const looked = await host.journal.append(host.approval.operationId, 4, eventFixture(4, { kind: "reconciliation", lookup: { lifecycleVersion: "1.0.0", operationId: host.approval.operationId, checkedAt: AT, result: { kind: "no-effect", evidence: { kind: "no-effect", evidenceId: "fence-example", observedAt: AT, ownerRequestId: host.approval.ownerRequestId, receipt: { fenced: true }, final: true } } } }));
    expect(looked.journal.state).toBe("failed");
    const retry = { ...host.attempt, attemptId: crypto.randomUUID(), number: 2, kind: "retry" as const, preparedAt: "2026-11-01T00:00:31.000Z", deadlineAt: "2026-11-01T00:01:01.000Z" };
    const next = await host.journal.append(host.approval.operationId, looked.revision, eventFixture(5, { kind: "attempt-prepared", attempt: retry }, retry.preparedAt), { support, retryAuthorized: true });
    expect(next.journal.state).toBe("dispatching");
    expect(next.journal.events.map(entry => entry.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(next.budgets?.redispatchCount).toBe(1);
  });
  test("F14 valid retained dedup permits one same-key retry after lookup; expired retention blocks replay", async () => {
    for (const retentionMs of [120_000, 40_000]) {
      const host = await open();
      const approval = approvalFixture();
      const guaranteed: schemas.OwnerSupport = { ...support, operationLookup: "historical", dedup: { kind: "guaranteed", scope: "connection-capability", retentionMs, bindsSnapshot: true, concurrent: true } };
      const first = { ...attemptFixture(), dedupValidUntil: new Date(Date.parse(AT) + retentionMs).toISOString() };
      await host.journal.approve(approval);
      await host.journal.append(approval.operationId, 1, eventFixture(2, { kind: "attempt-prepared", attempt: first }), { support: guaranteed });
      await host.journal.append(approval.operationId, 2, eventFixture(3, timeout(first.attemptId)));
      await host.journal.reserveLookup(approval.operationId, 3, "2026-11-01T00:00:30.000Z");
      const lookup = await host.journal.append(approval.operationId, 4, eventFixture(4, { kind: "reconciliation", lookup: { lifecycleVersion: "1.0.0", operationId: approval.operationId, checkedAt: "2026-11-01T00:00:30.000Z", result: { kind: "unknown", reason: { code: "unknown", message: "Synthetic unknown." } } } }, "2026-11-01T00:00:30.000Z"));
      const retry = { ...first, attemptId: crypto.randomUUID(), number: 2, kind: "retry" as const, preparedAt: "2026-11-01T00:00:31.000Z", deadlineAt: "2026-11-01T00:01:01.000Z" };
      const tooSoon = { ...retry, preparedAt: "2026-11-01T00:00:30.500Z", deadlineAt: "2026-11-01T00:01:00.500Z" };
      await expect(host.journal.append(approval.operationId, lookup.revision, eventFixture(5, { kind: "attempt-prepared", attempt: tooSoon }, tooSoon.preparedAt), { support: guaranteed, retryAuthorized: true })).rejects.toThrow();
      const write = host.journal.append(approval.operationId, lookup.revision, eventFixture(5, { kind: "attempt-prepared", attempt: retry }, retry.preparedAt), { support: guaranteed, retryAuthorized: true });
      if (retentionMs === 40_000) await expect(write).rejects.toThrow();
      else {
        const stored = await write;
        expect(stored.journal.idempotencyKey).toBe(approval.idempotencyKey);
        expect(stored.journal.ownerRequestId).toBe(approval.ownerRequestId);
        expect(stored.journal.snapshot).toEqual(approval.snapshot);
        expect(stored.budgets?.redispatchCount).toBe(1);
        await host.close(); hosts.pop();
        const reopened = await open(host.dir);
        expect(await reopened.journal.read(approval.operationId)).toEqual(stored);
      }
    }
  });
  test("F16 changed same-id success is quarantined without becoming a success outbox", async () => {
    const host = await prepared();
    const accepted = resultFixture(host.approval, host.attempt);
    await host.journal.receive(host.approval.operationId, 2, accepted, AT);
    const success = { ...resultFixture(host.approval, host.attempt, "succeeded"), resultId: accepted.resultId };
    const stored = await host.journal.receive(host.approval.operationId, 3, success, AT);
    expect(stored.journal.state).toBe("uncertain");
    expect(stored.outbox).toHaveLength(0);
    expect(stored.quarantine[0]?.raw).toMatchObject({ event: { response: success } });
    expect(stored.retryBlocked).toBe(true);
  });
  test("F9 cancellation preserves final no-effect and unknown outcomes; F16 historical fences quarantine late effects", async () => {
    for (const final of [true, false]) {
      const host = await prepared();
      await host.journal.append(host.approval.operationId, 2, eventFixture(3, { kind: "cancel-requested", cancelId: "cancel-example", authority }));
      await host.journal.append(host.approval.operationId, 3, eventFixture(4, timeout(host.attempt.attemptId)));
      const result: schemas.OperationLookup["result"] = final ? { kind: "no-effect", evidence: { kind: "no-effect", evidenceId: "cancel-fence", ownerRequestId: host.approval.ownerRequestId, observedAt: AT, receipt: { cancelled: true }, final: true } } : { kind: "unknown", reason: { code: "unknown", message: "Synthetic unknown." } };
      const stored = await host.journal.append(host.approval.operationId, 4, eventFixture(5, { kind: "reconciliation", lookup: { lifecycleVersion: "1.0.0", operationId: host.approval.operationId, checkedAt: AT, result } }));
      expect(stored.cancelRequested).toBe(true);
      expect(stored.journal.state).toBe(final ? "cancelled" : "uncertain");
      const late = await host.journal.receive(host.approval.operationId, stored.revision, resultFixture(host.approval, host.attempt, "succeeded"), AT);
      expect(late.journal.state).toBe("succeeded");
      expect(late.retryBlocked).toBe(final);
      expect(late.quarantine.some(item => item.code === "outcome_conflict")).toBe(final);
    }
    const host = await prepared();
    await host.journal.append(host.approval.operationId, 2, eventFixture(3, timeout(host.attempt.attemptId)));
    const fenced = await host.journal.append(host.approval.operationId, 3, eventFixture(4, { kind: "reconciliation", lookup: { lifecycleVersion: "1.0.0", operationId: host.approval.operationId, checkedAt: AT, result: { kind: "no-effect", evidence: { kind: "no-effect", evidenceId: "failure-fence", ownerRequestId: host.approval.ownerRequestId, observedAt: AT, receipt: { fenced: true }, final: true } } } }));
    expect(fenced.journal.state).toBe("failed");
    const late = await host.journal.receive(host.approval.operationId, fenced.revision, resultFixture(host.approval, host.attempt, "succeeded"), AT);
    expect(late.journal.state).toBe("succeeded");
    expect(late.quarantine.at(-1)?.code).toBe("outcome_conflict");
  });
  test("F14 persisted lookup budgets and backward clocks cannot reset on reopen", async () => {
    const host = await prepared();
    await host.journal.append(host.approval.operationId, 2, eventFixture(3, timeout(host.attempt.attemptId)));
    const reserved = await host.journal.reserveLookup(host.approval.operationId, 3, "2026-11-01T00:00:30.000Z");
    expect(reserved.budgets?.lookupCount).toBe(1);
    await expect(host.journal.reserveLookup(host.approval.operationId, 4, AT)).rejects.toThrow();
    await host.close(); hosts.pop();
    const reopened = await open(host.dir);
    expect(await reopened.journal.read(host.approval.operationId)).toEqual(reserved);
    await reopened.journal.reserveLookup(host.approval.operationId, 4, "2026-11-01T00:00:35.000Z");
    await reopened.journal.reserveLookup(host.approval.operationId, 5, "2026-11-01T00:01:00.000Z");
    await expect(reopened.journal.reserveLookup(host.approval.operationId, 6, "2026-11-01T00:01:01.000Z")).rejects.toThrow();
    const retry = { ...host.attempt, attemptId: crypto.randomUUID(), number: 2, kind: "retry" as const, preparedAt: "2026-11-01T00:01:00.000Z", deadlineAt: "2026-11-01T00:01:30.000Z" };
    await expect(reopened.journal.append(host.approval.operationId, 6, eventFixture(4, { kind: "attempt-prepared", attempt: retry }, retry.preparedAt), { support, retryAuthorized: true })).rejects.toThrow();
  });
});
