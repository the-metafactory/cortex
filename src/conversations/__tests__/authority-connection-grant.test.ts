import { afterEach, expect, test } from "bun:test";
import { authorityRig } from "../authority-fixtures";
import { snapshotDigest } from "../domain-adapters/operations/validation";

type AuthorityRig = Awaited<ReturnType<typeof authorityRig>>;
const rigs: AuthorityRig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });

const capability = (rig: AuthorityRig): string => rig.approval.snapshot.capabilityId;
function otherTarget(rig: AuthorityRig, operationId: string, canonicalId = "target-other") {
  const { digest: _digest, ...rest } = rig.approval.snapshot;
  const snapshot = { ...rest, target: { ...rig.approval.snapshot.destinations[0]!, canonicalId } };
  return { operationId, idempotencyKey: operationId, ownerRequestId: crypto.randomUUID(), snapshot: { ...snapshot, digest: snapshotDigest(snapshot) } };
}

test("a connection grant covers the named capabilities for any target on that connection", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  expect(await rig.service.findConnectionGrant(rig.context, rig.connection.connectionId, capability(rig))).toBeNull();
  const grantId = await rig.service.grantConnectionActions(rig.context, rig.connection.connectionId, [capability(rig)]);
  expect(grantId).not.toBeNull();
  expect(await rig.service.findConnectionGrant(rig.context, rig.connection.connectionId, capability(rig))).toBe(grantId);
  const exact = await rig.service.approveGrant(rig.context, rig.input(), grantId!);
  expect(exact.kind).toBe("allowed");
  const elsewhere = await rig.service.approveGrant(rig.context, otherTarget(rig, `${rig.approval.operationId}-other`), grantId!);
  expect(elsewhere.kind).toBe("allowed");
  if (elsewhere.kind === "allowed") expect(elsewhere.authority.basis).toMatchObject({ kind: "grant", grantId });
});

test("a connection grant names exact actions: another capability is not covered and cannot be granted", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  expect(await rig.service.grantConnectionActions(rig.context, rig.connection.connectionId, [capability(rig), "balance.task.delete"])).toBeNull();
  expect(await rig.service.grantConnectionActions(rig.context, rig.connection.connectionId, [])).toBeNull();
  const grantId = await rig.service.grantConnectionActions(rig.context, rig.connection.connectionId, [capability(rig)]);
  expect(await rig.service.findConnectionGrant(rig.context, rig.connection.connectionId, "balance.task.delete")).toBeNull();
  expect(grantId).not.toBeNull();
});

test("a connection grant never reaches another connection", async () => {
  const rig = await authorityRig({}, "local", undefined, {}); rigs.push(rig);
  const grantId = await rig.service.grantConnectionActions(rig.context, rig.connection.connectionId, [capability(rig)]);
  expect(await rig.service.findConnectionGrant(rig.context, "connection-unknown", capability(rig))).toBeNull();
  expect(await rig.service.grantConnectionActions(rig.context, "connection-unknown", [capability(rig)])).toBeNull();
  expect(grantId).not.toBeNull();
});

test("an exact grant covers only the object it names and never answers a standing lookup", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const named = { ...rig.approval.snapshot.destinations[0]!, canonicalId: "target-named" };
  const grantId = await rig.service.grantConnectionActions(rig.context, rig.connection.connectionId, [capability(rig)], { destinations: rig.approval.snapshot.destinations, target: named });
  expect(grantId).not.toBeNull();
  expect(await rig.service.findConnectionGrant(rig.context, rig.connection.connectionId, capability(rig))).toBeNull();
  expect((await rig.service.approveGrant(rig.context, otherTarget(rig, `${rig.approval.operationId}-named`, "target-named"), grantId!)).kind).toBe("allowed");
  expect((await rig.service.approveGrant(rig.context, otherTarget(rig, `${rig.approval.operationId}-elsewhere`, "target-elsewhere"), grantId!)).kind).toBe("denied");
});

test("revoking a connection grant stops it from covering the next attempt", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const grantId = await rig.service.grantConnectionActions(rig.context, rig.connection.connectionId, [capability(rig)]);
  await rig.service.revokeCreationGrant(rig.context, grantId!);
  expect(await rig.service.findConnectionGrant(rig.context, rig.connection.connectionId, capability(rig))).toBeNull();
  expect((await rig.service.approveGrant(rig.context, rig.input(), grantId!)).kind).toBe("denied");
});

test("a connection grant survives a host reopen", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const grantId = await rig.service.grantConnectionActions(rig.context, rig.connection.connectionId, [capability(rig)]);
  await rig.reopen();
  expect(await rig.service.findConnectionGrant(rig.context, rig.connection.connectionId, capability(rig))).toBe(grantId);
});
