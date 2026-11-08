import { afterEach, expect, spyOn, test } from "bun:test";
import { OperationJournalStore } from "../domain-adapters/operations/journal";
import { authorityRig } from "../authority-fixtures";

const rigs: Awaited<ReturnType<typeof authorityRig>>[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });

test("confirmation and approval persist atomically and duplicate delivery reopens the same protected records", async () => {
  const rig = await authorityRig();
  rigs.push(rig);
  const first = await rig.confirm();
  expect(first.kind).toBe("allowed");
  const duplicate = await rig.confirm();
  expect(duplicate).toEqual(first);
  const before = await rig.service.inspectHostRecords();
  expect(before.confirmations).toHaveLength(1);
  expect(before.decisions).toHaveLength(1);
  await rig.reopen();
  expect(await rig.service.inspectHostRecords()).toEqual(before);
  expect((await rig.host.lifecycleJournal(rig.registry).read(rig.approval.operationId))?.journal.events).toHaveLength(1);
});

test("prepared dispatch uses only the registered connector once and stores success privately", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  expect(await rig.service.dispatch(rig.context, request, rig.lease)).toEqual({ kind: "admitted" });
  expect(rig.calls.dispatch).toBe(1);
  expect(rig.calls.sends).toEqual([]);
  expect((await rig.host.lifecycleJournal(rig.registry).read(request.operationId))?.journal.state).toBe("succeeded");
  expect((await rig.service.dispatch(rig.context, request, rig.lease)).kind).toBe("denied");
  expect(rig.calls.dispatch).toBe(1);
});

test("revocation before admission makes zero calls; revocation after entry aborts only the existing signal and keeps late factual success", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  await rig.revokeConnection();
  expect((await rig.service.dispatch(rig.context, request, rig.lease)).kind).toBe("denied");
  expect(rig.calls.dispatch).toBe(0);
  expect((await rig.host.lifecycleJournal(rig.registry).read(request.operationId))?.journal.state).toBe("dispatching");
  await rig.reopen();
  expect((await rig.service.inspectHostRecords()).records[`connection:${rig.connection.connectionId}`]).toHaveLength(2);
  expect((await rig.service.dispatch(rig.context, request, rig.lease)).kind).toBe("denied");
});

test("opaque contexts, changed snapshots, forged decision references and stale writer leases deny", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  for (const changed of [{ ...request, authority: { ...request.authority, decisionRef: crypto.randomUUID() } }, { ...request, snapshot: { ...request.snapshot, input: { title: "replacement" } } }, { ...request, authority: { ...request.authority, connectionRevision: "900" } }]) {
    expect((await rig.service.dispatch(rig.context, changed, rig.lease)).kind).toBe("denied");
  }
  expect((await rig.service.dispatch({} as typeof rig.context, request, rig.lease)).kind).toBe("denied");
  expect((await rig.service.dispatch(rig.context, request, { ...rig.lease, epoch: 2 })).kind).toBe("denied");
  expect(rig.calls.dispatch).toBe(0);
  expect(await rig.service.authenticate("model-authored-session")).toBeNull();
});

test("current authenticated-session revocation and policy failures deny with protected safe decisions", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  rig.hooks.sessionEnabled = false;
  expect((await rig.service.dispatch(rig.context, request, rig.lease)).kind).toBe("denied");
  rig.hooks.sessionEnabled = true;
  rig.hooks.policy = async () => { throw new Error("synthetic protected provider detail"); };
  const denied = await rig.service.dispatch(rig.context, request, rig.lease);
  expect(denied.kind).toBe("denied");
  expect(JSON.stringify(denied)).not.toContain("protected provider detail");
  expect((await rig.service.inspectHostRecords()).decisions.some(item => !item.allowed)).toBe(true);
  expect(rig.calls.dispatch).toBe(0);
});

test("policyRevision hashes every protected configured input and actual host tool configuration", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const first = await rig.confirm();
  expect(first.kind).toBe("allowed");
  const baseline = (await rig.service.inspectHostRecords()).policies[0]!.policyRevision;
  const request = await rig.prepare();
  rig.policy.communication = { permitted: "changed" };
  await rig.service.dispatch(rig.context, request, rig.lease);
  const policies = (await rig.service.inspectHostRecords()).policies;
  expect(policies.some(item => item.policyRevision !== baseline)).toBe(true);
  expect(policies.some(item => JSON.stringify(item.input).includes('"communication":{"permitted":"changed"}'))).toBe(true);
});

test("an admitted call survives later revocation as factual success without any new cancellation request", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  const entered = Promise.withResolvers<undefined>();
  const complete = Promise.withResolvers<undefined>();
  rig.hooks.dispatch = async call => {
    entered.resolve(undefined); await complete.promise;
    const { resultFixture } = await import("../domain-adapters/operations/fixtures");
    return resultFixture({ ...rig.approval, authority: call.authority }, { attemptId: call.attemptId } as Parameters<typeof resultFixture>[1], "succeeded");
  };
  const pending = rig.service.dispatch(rig.context, request, rig.lease);
  await entered.promise;
  await rig.revokeConnection();
  expect(rig.calls.signals[0]?.aborted).toBe(true);
  expect(rig.calls.cancel).toBe(0);
  complete.resolve(undefined);
  expect(await pending).toEqual({ kind: "admitted" });
  expect((await rig.host.lifecycleJournal(rig.registry).read(request.operationId))?.journal.state).toBe("succeeded");
  const evidenceRef = Object.keys((await rig.service.inspectHostRecords()).evidence)[0]!;
  expect((await rig.service.release(rig.context, evidenceRef, rig.sink)).kind).toBe("withheld");
  expect(rig.calls.sends).toEqual([]);
  await rig.reopen();
  expect((await rig.service.inspectHostRecords()).evidence[evidenceRef]).toBeDefined();
});

test("revocation interposed after preparation and before admission wins over the cached allowed check", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  let checks = 0;
  const reached = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();
  rig.hooks.policy = async () => { if (++checks === 1) { reached.resolve(undefined); await resume.promise; } };
  const pending = rig.service.dispatch(rig.context, request, rig.lease);
  await reached.promise;
  await rig.revokeConnection();
  resume.resolve(undefined);
  expect((await pending).kind).toBe("denied");
  expect(rig.calls.dispatch).toBe(0);
});

test("new cancellation needs cancellation-specific confirmation and cannot reuse mutation authority", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  const cancelId = crypto.randomUUID();
  const raw = { lifecycleVersion: "1.0.0" as const, operationId: request.operationId, cancelId, authority: request.authority, requestedAt: "2026-11-01T00:00:00.000Z" };
  expect((await rig.service.cancel(rig.context, raw, rig.lease)).kind).toBe("denied");
  expect(rig.calls.cancel).toBe(0);
  const confirmed = await rig.service.confirmCancellation(rig.context, request.operationId, cancelId);
  expect(confirmed.kind).toBe("allowed");
  if (confirmed.kind !== "allowed") throw new Error("Cancellation confirmation missing.");
  expect((await rig.service.cancel(rig.context, { ...raw, authority: confirmed.authority }, rig.lease)).kind).toBe("admitted");
  expect(rig.calls.cancel).toBe(1);
  await rig.revokeConnection();
  expect((await rig.service.cancel(rig.context, { ...raw, cancelId: crypto.randomUUID(), authority: confirmed.authority }, rig.lease)).kind).toBe("denied");
  expect(rig.calls.cancel).toBe(1);
});

test("standing grants require exact structured sets, closed host context and unchanged grant revision", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const grant = { version: 1 as const, status: "active" as const, purpose: "mutation" as const, grantId: crypto.randomUUID(), grantRevision: "1", principalRef: rig.principal.principalRef, constraints: { adapterId: "balance", connectionId: rig.connection.connectionId, capabilityIds: [rig.approval.snapshot.capabilityId], destinations: rig.approval.snapshot.destinations, context: { kind: "conversation" as const, conversationId: rig.approval.snapshot.provenance.conversationId }, sourceReleaseCeiling: "local" as const }, createdAt: "2026-11-01T00:00:00.000Z" };
  await rig.service.publishHostRecord({ kind: "grant", value: grant }, 0);
  const allowed = await rig.service.approveGrant(rig.context, rig.input(), grant.grantId);
  expect(allowed.kind).toBe("allowed");
  if (allowed.kind !== "allowed") throw new Error("Synthetic grant missing.");
  expect(allowed.authority.basis).toEqual({ kind: "grant", grantId: grant.grantId, grantRevision: "1" });
  await rig.service.publishHostRecord({ kind: "grant", value: { ...grant, grantRevision: "2", status: "revoked", revokedAt: grant.createdAt, revocationReason: "synthetic-revocation" } }, 1);
  expect((await rig.service.approveGrant(rig.context, rig.input(), grant.grantId)).kind).toBe("denied");
  await rig.reopen();
  expect((await rig.service.inspectHostRecords()).records[`grant:${grant.grantId}`]).toHaveLength(2);
  expect((await rig.service.approveGrant(rig.context, rig.input(), grant.grantId)).kind).toBe("denied");
});

test("grant destination subset, duplicate, case change, target mismatch and missing area binding deny", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const constraints = { adapterId: "balance", connectionId: rig.connection.connectionId, capabilityIds: [rig.approval.snapshot.capabilityId], destinations: rig.approval.snapshot.destinations, context: { kind: "area" as const, areaId: "area-example" }, sourceReleaseCeiling: "local" as const };
  for (const change of [{ destinations: [] }, { destinations: [{ ...constraints.destinations[0]!, canonicalId: "Area-example" }] }, { target: constraints.destinations[0] }, { capabilityIds: ["balance.task.other"] }, { context: { kind: "area" as const, areaId: "other-area" } }]) {
    const grant = { version: 1 as const, status: "active" as const, purpose: "mutation" as const, grantId: crypto.randomUUID(), grantRevision: "1", principalRef: rig.principal.principalRef, constraints: { ...constraints, ...change }, createdAt: "2026-11-01T00:00:00.000Z" };
    await rig.service.publishHostRecord({ kind: "grant", value: grant }, 0);
    expect((await rig.service.approveGrant(rig.context, rig.input(), grant.grantId)).kind).toBe("denied");
  }
  const grant = { version: 1 as const, status: "active" as const, purpose: "mutation" as const, grantId: crypto.randomUUID(), grantRevision: "1", principalRef: rig.principal.principalRef, constraints, createdAt: "2026-11-01T00:00:00.000Z" };
  await expect(rig.service.publishHostRecord({ kind: "grant", value: { ...grant, constraints: { ...constraints, destinations: [...constraints.destinations, ...constraints.destinations] } } }, 0)).rejects.toThrow();
  await rig.service.publishHostRecord({ kind: "grant", value: grant }, 0);
  delete rig.policy.areaId;
  expect((await rig.service.approveGrant(rig.context, rig.input(), grant.grantId)).kind).toBe("denied");
});

test("source provenance and current resolver restrictions block local-to-cloud approval", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const source = rig.approval.snapshot.destinations[0]!;
  const restrictionRef = crypto.randomUUID();
  await rig.service.publishHostRecord({ kind: "restriction", value: { version: 1, status: "active", restrictionRef, source, ownerRevision: "owner-1", decisionRef: "synthetic-source-decision", audiences: ["web"], egress: "local", readScope: [rig.principal.principalRef], resolverBinding: "synthetic-restriction-resolver", revision: "1" } }, 0);
  rig.approval.snapshot.sources = [{ ref: source, restrictionRef }];
  const { snapshotDigest } = await import("../domain-adapters/operations/validation");
  rig.approval.snapshot.digest = snapshotDigest(rig.approval.snapshot);
  expect((await rig.confirm()).kind).toBe("allowed");
  rig.approval.snapshot.policy = "cloud";
  rig.approval.snapshot.digest = snapshotDigest(rig.approval.snapshot);
  expect((await rig.confirm()).kind).toBe("denied");
  rig.approval.snapshot.sources = [{ ref: source, restrictionRef: crypto.randomUUID() }];
  rig.approval.snapshot.digest = snapshotDigest(rig.approval.snapshot);
  expect((await rig.confirm()).kind).toBe("denied");
  expect(rig.calls.dispatch).toBe(0);
});

test("read authority inspects history after write removal and absent current objects never change historic success", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  await rig.service.dispatch(rig.context, request, rig.lease);
  const connection = { ...rig.connection, connectionRevision: "2", writeCapabilityIds: [] };
  await rig.service.publishHostRecord({ kind: "connection", value: connection }, 1);
  const result = await rig.service.lookup(rig.context, { lifecycleVersion: "1.0.0", operationId: request.operationId, ownerRequestId: request.ownerRequestId }, rig.sink);
  expect(result.kind).toBe("released");
  expect(rig.calls.lookup).toBe(1);
  expect((await rig.host.lifecycleJournal(rig.registry).read(request.operationId))?.journal.state).toBe("succeeded");
  const readback = await rig.service.readback(rig.context, { lifecycleVersion: "1.0.0", ref: request.snapshot.destinations[0]! }, rig.sink);
  expect(readback.kind).toBe("released");
  expect(rig.calls.readback).toBe(1);
  expect((await rig.host.lifecycleJournal(rig.registry).read(request.operationId))?.journal.state).toBe("succeeded");
});

test("current read denial makes zero fetches and hides operation existence", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  rig.policy.operationVisible = false;
  const result = await rig.service.lookup(rig.context, { lifecycleVersion: "1.0.0", operationId: request.operationId, ownerRequestId: request.ownerRequestId }, rig.sink);
  expect(result.kind).toBe("withheld");
  expect(JSON.stringify(result)).not.toContain(request.operationId);
  expect(JSON.stringify(result)).not.toContain(request.ownerRequestId);
  expect(rig.calls.lookup).toBe(0);
  expect(rig.calls.sends).toHaveLength(0);
});

test("revocation immediately before sink entry withholds fetched data; post-entry revocation cannot recall an admitted send", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  rig.hooks.lookup = async () => {
    await rig.revokeConnection();
    return { lifecycleVersion: "1.0.0", operationId: request.operationId, checkedAt: "2026-11-01T00:00:00.000Z", result: { kind: "unknown", reason: { code: "synthetic_unknown", message: "Protected fetched data" } } };
  };
  expect((await rig.service.lookup(rig.context, { lifecycleVersion: "1.0.0", operationId: request.operationId, ownerRequestId: request.ownerRequestId }, rig.sink)).kind).toBe("withheld");
  expect(rig.calls.lookup).toBe(1);
  expect(rig.calls.sends).toHaveLength(0);
  const second = await authorityRig(); rigs.push(second);
  const next = await second.prepare();
  const entered = Promise.withResolvers<undefined>();
  const complete = Promise.withResolvers<undefined>();
  second.hooks.sink = async () => { entered.resolve(undefined); await complete.promise; };
  const sending = second.service.lookup(second.context, { lifecycleVersion: "1.0.0", operationId: next.operationId, ownerRequestId: next.ownerRequestId }, second.sink);
  await entered.promise;
  await second.revokeConnection();
  complete.resolve(undefined);
  expect((await sending).kind).toBe("released");
  expect(second.calls.sends).toHaveLength(1);
  const evidenceRef = Object.keys((await second.service.inspectHostRecords()).evidence)[0]!;
  expect((await second.service.release(second.context, evidenceRef, second.sink)).kind).toBe("withheld");
  expect(second.calls.sends).toHaveLength(1);
});

test("protected late success is not released to Discord and malformed evidence stays quarantined", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  await rig.service.dispatch(rig.context, request, rig.lease);
  const evidenceRef = Object.keys((await rig.service.inspectHostRecords()).evidence)[0]!;
  const discord = await rig.service.authenticate("discord-session");
  expect(discord).not.toBeNull();
  const projection = await rig.service.release(discord!, evidenceRef, { kind: "discord", conversationId: request.snapshot.provenance.conversationId });
  expect(projection.kind).toBe("withheld");
  expect(JSON.stringify(projection)).not.toContain("task-example");
  expect(JSON.stringify(projection)).not.toContain("committed");
  const invalid = await rig.service.ingestLateEvidence(request.operationId, { lifecycleVersion: "1.0.0", protected: "malformed-owner-data" });
  expect((await rig.service.release(rig.context, invalid, rig.sink)).kind).toBe("withheld");
  expect((await rig.host.lifecycleJournal(rig.registry).read(request.operationId))?.quarantine).toHaveLength(1);
  expect(rig.calls.sends).toHaveLength(0);
});

test("actual host tool configuration enters the canonical policy vector", async () => {
  const config = { projects: [{ id: "synthetic", root: "/tmp/synthetic-authority", policy: "local" as const, operations: ["repo.read" as const] }] };
  const rig = await authorityRig({ tools: { config: () => config, definitions: [] } }); rigs.push(rig);
  const request = await rig.prepare();
  const before = (await rig.service.inspectHostRecords()).policies[0]!;
  config.projects[0]!.root = "/tmp/synthetic-authority-updated";
  await rig.service.dispatch(rig.context, request, rig.lease);
  const policies = (await rig.service.inspectHostRecords()).policies;
  expect(policies.some(item => item.policyRevision !== before.policyRevision && JSON.stringify(item.input).includes("synthetic-authority-updated"))).toBe(true);
});

test("a newly selected current cancellation grant works without reviving a mutation grant", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  const grant = { version: 1 as const, status: "active" as const, purpose: "cancellation" as const, grantId: crypto.randomUUID(), grantRevision: "1", principalRef: rig.principal.principalRef, constraints: { adapterId: "balance", connectionId: rig.connection.connectionId, capabilityIds: [request.snapshot.capabilityId], destinations: request.snapshot.destinations, context: { kind: "principal" as const }, sourceReleaseCeiling: "local" as const }, createdAt: "2026-11-01T00:00:00.000Z" };
  await rig.service.publishHostRecord({ kind: "grant", value: grant }, 0);
  expect((await rig.service.approveGrant(rig.context, rig.input(), grant.grantId)).kind).toBe("denied");
  const cancelId = crypto.randomUUID();
  const check = await rig.service.approveCancellationGrant(rig.context, request.operationId, cancelId, grant.grantId);
  expect(check.kind).toBe("allowed");
  if (check.kind !== "allowed") throw new Error("Cancellation grant unavailable.");
  expect((await rig.service.cancel(rig.context, { lifecycleVersion: "1.0.0", operationId: request.operationId, cancelId, authority: check.authority, requestedAt: grant.createdAt }, rig.lease)).kind).toBe("admitted");
  expect(rig.calls.cancel).toBe(1);
});

test("protected success outbox stores only references and retries pass current release admission", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  await rig.service.dispatch(rig.context, request, rig.lease);
  const reference = Object.keys((await rig.service.inspectHostRecords()).evidence)[0]!;
  const queued = await rig.service.queueRelease(rig.context, reference, rig.sink);
  expect(queued.kind).toBe("queued");
  if (queued.kind !== "queued") throw new Error("Synthetic outbox missing.");
  expect(await rig.service.queueRelease(rig.context, reference, rig.sink)).toEqual(queued);
  const item = (await rig.service.inspectHostRecords()).outbox[queued.outboxRef]!;
  expect(Object.keys(item).sort()).toEqual(["evidenceRef", "sink", "state"]);
  rig.policy.releaseAllowed = false;
  expect((await rig.service.deliver(rig.context, queued.outboxRef)).kind).toBe("withheld");
  expect(rig.calls.sends).toHaveLength(0);
  rig.policy.releaseAllowed = true;
  expect((await rig.service.deliver(rig.context, queued.outboxRef)).kind).toBe("released");
  expect(rig.calls.sends).toHaveLength(1);
  expect((await rig.service.deliver(rig.context, queued.outboxRef)).kind).toBe("withheld");
  expect(rig.calls.sends).toHaveLength(1);
});

test("changed accounts and narrowed read scopes cannot release data fetched under an older connection", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  rig.hooks.lookup = async () => {
    await rig.service.publishHostRecord({ kind: "connection", value: { ...rig.connection, connectionRevision: "2", accountScope: { account: "another-synthetic-account" } } }, 1);
    return { lifecycleVersion: "1.0.0", operationId: request.operationId, checkedAt: "2026-11-01T00:00:00.000Z", result: { kind: "unknown", reason: { code: "synthetic_unknown", message: "Protected result" } } };
  };
  expect((await rig.service.lookup(rig.context, { lifecycleVersion: "1.0.0", operationId: request.operationId, ownerRequestId: request.ownerRequestId }, rig.sink)).kind).toBe("withheld");
  expect(rig.calls.sends).toHaveLength(0);
});

test("trusted registrations are immutable per host and caller-provided sink/callback fields are rejected", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  expect(() => rig.host.lifecycleAuthority(rig.registry, { ...rig.bindings })).toThrow();
  expect((await rig.service.dispatch(rig.context, { ...request, callback: () => { throw new Error("Untrusted callback entered."); } } as typeof request, rig.lease)).kind).toBe("denied");
  await rig.service.dispatch(rig.context, request, rig.lease);
  const reference = Object.keys((await rig.service.inspectHostRecords()).evidence)[0]!;
  expect((await rig.service.release(rig.context, reference, { kind: "web", conversationId: "different-conversation" })).kind).toBe("withheld");
  expect(rig.calls.sends).toHaveLength(0);
});

test("a real multi-document transaction abort leaves no confirmation, allowed decision or journal approval", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const original = OperationJournalStore.prototype.approveInTransaction;
  const failure = spyOn(OperationJournalStore.prototype, "approveInTransaction").mockImplementation(async function (this: OperationJournalStore, tx, approval) { await original.call(this, tx, approval); throw new Error("Synthetic atomic abort after journal write."); });
  try { expect((await rig.confirm()).kind).toBe("denied"); }
  finally { failure.mockRestore(); }
  const state = await rig.service.inspectHostRecords();
  expect(state.confirmations).toHaveLength(0);
  expect(state.decisions.filter(item => item.allowed)).toHaveLength(0);
  expect(await rig.host.lifecycleJournal(rig.registry).read(rig.approval.operationId)).toBeNull();
  expect((await rig.confirm()).kind).toBe("allowed");
});

test("legacy authority records cannot be adopted and unsupported protected policy versions deny", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  await rig.host.lifecycleJournal(rig.registry).approve(rig.approval);
  expect((await rig.confirm()).kind).toBe("denied");
  expect((await rig.service.inspectHostRecords()).confirmations).toHaveLength(0);
  const other = await authorityRig(); rigs.push(other);
  (other.policy as unknown as { version: number }).version = 2;
  expect((await other.confirm()).kind).toBe("denied");
  expect(other.calls.dispatch).toBe(0);
});

test("current connector credential resolution denies dispatch and cancellation without a new owner call", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  const cancelId = crypto.randomUUID();
  const cancellation = await rig.service.confirmCancellation(rig.context, request.operationId, cancelId);
  if (cancellation.kind !== "allowed") throw new Error("Synthetic cancellation missing.");
  rig.hooks.credentialsAvailable = false;
  expect((await rig.service.dispatch(rig.context, request, rig.lease)).kind).toBe("denied");
  expect((await rig.service.cancel(rig.context, { lifecycleVersion: "1.0.0", operationId: request.operationId, cancelId, authority: cancellation.authority, requestedAt: "2026-11-01T00:00:00.000Z" }, rig.lease)).kind).toBe("denied");
  expect(rig.calls.dispatch).toBe(0);
  expect(rig.calls.cancel).toBe(0);
});
