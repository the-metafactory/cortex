import { afterEach, expect, test } from "bun:test";
import { openMailReplyDraftRig, mailDraftLegacyFixture, DRAFT_ACCOUNT, DRAFT_CONNECTION_ID } from "../mail/reply-draft-fixtures";
import { MAIL_REPLY_DRAFT_CAPABILITY, mailReplyDraftSnapshot } from "../mail/reply-draft-host";
import { importLegacyOperation, previewLegacyOperation, readOperationEvidence, projectLegacyOperation, UpgradeRequired } from "../operations/legacy";
import { AT } from "../operations/fixtures";
import { snapshotDigest } from "../operations/validation";
import { studioRequestId } from "../../conversation-ids";
import type { MailApprovalInput } from "../mail/move-host";
import type { ApprovedSnapshot } from "../operations/types";

type Rig = Awaited<ReturnType<typeof openMailReplyDraftRig>>;
const rigs: Rig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
const open = async (policy: "local" | "cloud" = "local") => { const rig = await openMailReplyDraftRig(policy); rigs.push(rig); return rig; };
const approval = (rig: Rig, proposalId = "reply"): MailApprovalInput => {
  const request = rig.request(proposalId);
  return { operationId: request.operationId, idempotencyKey: request.operationId, ownerRequestId: studioRequestId(request.operationId), snapshot: mailReplyDraftSnapshot(request, rig.facadeConnection, { ok: true, mail: rig.listed }, "local") };
};
async function expectChangedApprovalDenied(rig: Rig, input: MailApprovalInput, changes: Partial<ApprovedSnapshot>[]) {
  for (const change of changes) {
    const snapshot = { ...input.snapshot, ...change };
    snapshot.digest = snapshotDigest(snapshot);
    expect((await rig.authority.confirm(rig.context, { ...input, snapshot })).kind).toBe("denied");
  }
}

test("local reply saves exact text through lifecycle confirmation with message, connection and account in its receipt", async () => {
  const rig = await open();
  const request = rig.request();
  expect(await rig.facade(true).create(request)).toEqual({ state: "created", canonicalId: "draft-example" });
  expect(rig.nativeCalls).toEqual([]);
  expect(rig.calls).toHaveLength(1);
  expect(rig.calls[0]!.snapshot).toMatchObject({ connectionId: DRAFT_CONNECTION_ID, target: { canonicalId: rig.listed.id }, input: { body: request.fields.body }, destinations: [{ canonicalId: DRAFT_ACCOUNT }] });
  const records = await rig.authority.inspectHostRecords();
  expect(records.confirmations).toHaveLength(1);
  expect(records.confirmations[0]).toMatchObject({ digest: rig.calls[0]!.snapshot.digest, connectionId: DRAFT_CONNECTION_ID, target: { canonicalId: rig.listed.id } });
  expect(Object.keys(records.records).some(key => key.startsWith("grant:"))).toBe(false);
  expect((await rig.journal.read(request.operationId))?.journal.state).toBe("succeeded");
  expect(await rig.facade(true).create(request)).toEqual({ state: "created", canonicalId: "draft-example" });
  expect(rig.calls).toHaveLength(1);
  const reopened = await rig.reopen();
  expect((await reopened.journal.read(request.operationId))?.journal.state).toBe("succeeded");
  expect((await reopened.authority.inspectHostRecords()).confirmations).toEqual(records.confirmations);
});

test("the same operation cannot change its approved text, message or connection", async () => {
  const rig = await open();
  const input = approval(rig);
  expect((await rig.authority.confirm(rig.context, input)).kind).toBe("allowed");
  const changes: Partial<ApprovedSnapshot>[] = [
    { input: { message: input.snapshot.target!, body: "Changed reply" } },
    { input: { message: { ...input.snapshot.target!, canonicalId: "another-message" }, body: "Changed reply" }, target: { ...input.snapshot.target!, canonicalId: "another-message" } },
    { connectionId: "another-connection" },
  ];
  await expectChangedApprovalDenied(rig, input, changes);
  expect(rig.calls).toEqual([]);
});

test("another source, account and missing account are refused before approval", async () => {
  const rig = await open();
  for (const overrides of [{ account: "other-account" }, { account: "" }, { sourceId: "other-source" }, { capability: { ...rig.facadeConnection.capability, capabilityId: "mail.send" } }]) {
    expect((await rig.facade(true, overrides).create(rig.request())).state).toBe("failed");
  }
  rig.listed.account = undefined;
  expect((await rig.facade(true).create(rig.request())).state).toBe("failed");
  expect((await rig.authority.inspectHostRecords()).confirmations).toEqual([]);
  expect(rig.calls).toEqual([]);
  expect(rig.nativeCalls).toEqual([]);
});

test("ambiguous or unlisted mail and blank or oversized text cannot produce an approved snapshot", async () => {
  const rig = await open();
  for (const reason of ["unlisted", "ambiguous"] as const) {
    expect(() => mailReplyDraftSnapshot(rig.request(), rig.facadeConnection, { ok: false, reason, error: "The listed mail is unavailable." }, "local")).toThrow("unavailable");
  }
  for (const body of [" \n ", "a".repeat(20_001)]) expect((await rig.facade(true).create(rig.request("invalid", body))).state).toBe("failed");
  expect(rig.calls).toEqual([]);
  expect((await rig.authority.inspectHostRecords()).confirmations).toEqual([]);
});

test("host authority refuses foreign account destinations, mismatched targets and local-only grants", async () => {
  const rig = await open();
  const input = approval(rig);
  await expectChangedApprovalDenied(rig, input, [{ destinations: [{ ...input.snapshot.destinations[0]!, canonicalId: "other-account" }] }, { target: { ...input.snapshot.target!, canonicalId: "other-message" } }]);
  expect(await rig.authority.grantConnectionActions(rig.context, DRAFT_CONNECTION_ID, [MAIL_REPLY_DRAFT_CAPABILITY])).toBeNull();
  expect((await rig.authority.confirm(rig.context, input)).kind).toBe("allowed");
  expect(await rig.facade(true).create(rig.request())).toMatchObject({ state: "created" });
  expect(await rig.authority.grantApprovedOperation(rig.context, input.operationId, "conversation")).toBeNull();
});

test("a cloud-created grant cannot authorize a local-only reply", async () => {
  const rig = await open("cloud");
  const grant = await rig.authority.grantConnectionActions(rig.context, DRAFT_CONNECTION_ID, [MAIL_REPLY_DRAFT_CAPABILITY]);
  expect(grant).not.toBeNull();
  rig.policy.conversationPolicy = "local";
  expect((await rig.authority.approveGrant(rig.context, approval(rig), grant!)).kind).toBe("denied");
  expect(rig.calls).toEqual([]);
});

test("a broad destination list does not permit drafting to another account", async () => {
  const rig = await open();
  const input = approval(rig);
  const otherAccount = { ...input.snapshot.destinations[0]!, canonicalId: "other-account" };
  rig.connection.writeDestinations.push(otherAccount);
  rig.connection.connectionRevision = "2";
  await rig.authority.publishHostRecord({ kind: "connection", value: rig.connection }, 1);
  await expectChangedApprovalDenied(rig, input, [{ destinations: [otherAccount] }]);
  expect(rig.calls).toEqual([]);
});

test("an account rebound after confirmation is refused at dispatch", async () => {
  const rig = await open();
  const input = approval(rig);
  expect((await rig.authority.confirm(rig.context, input)).kind).toBe("allowed");
  rig.connection.accountScope = { account: "other-account" };
  rig.connection.connectionRevision = "2";
  await rig.authority.publishHostRecord({ kind: "connection", value: rig.connection }, 1);
  expect((await rig.bridge.dispatch(rig.context, input.operationId, rig.lease)).kind).toBe("refused");
  expect(rig.calls).toEqual([]);
});

test("revocation and cancellation before dispatch preserve the reply without owner calls", async () => {
  const rig = await open();
  expect((await rig.facade(true).create({ ...rig.request(), signal: AbortSignal.abort() })).state).toBe("failed");
  rig.policy.writesAllowed = false;
  expect((await rig.facade(true).create(rig.request())).state).toBe("failed");
  expect(rig.calls).toEqual([]);
  expect(await rig.journal.read(rig.request().operationId)).toBeNull();
});

test("inactive facade runs the unchanged native draft command without lifecycle approval", async () => {
  const rig = await open();
  for (const active of [undefined, false]) {
    expect(await rig.facade(active).create(rig.request())).toEqual({ state: "created", canonicalId: "native-draft" });
  }
  expect(rig.calls).toEqual([]);
  expect(rig.nativeCalls).toHaveLength(2);
  expect(rig.nativeCalls[0]!.argv).toEqual(["fixture-native-draft"]);
  expect(JSON.parse(rig.nativeCalls[0]!.stdin)).toEqual({ action: "draft", account: DRAFT_ACCOUNT, messageId: rig.listed.id, to: rig.listed.from.address, subject: "Re: Example subject", body: rig.request().fields.body });
  expect((await rig.authority.inspectHostRecords()).confirmations).toEqual([]);
  expect(await rig.journal.read(rig.request().operationId)).toBeNull();
});

for (const id of ["draft-example", ""]) {
  test(`legacy draft ${id || "empty ID"} keeps raw evidence and cannot dispatch or retry`, async () => {
    const rig = await open();
    const { source, mapping } = mailDraftLegacyFixture(id);
    const preview = previewLegacyOperation(source, mapping);
    expect(preview.issues).toEqual(id ? [] : ["legacy_canonical_identity_invalid", "legacy_canonical_mapping_missing"]);
    const stored = await importLegacyOperation(rig.journal, source, mapping, AT);
    expect(stored.retryBlocked).toBe(true);
    expect(stored.journal.ownerRequestId).toBe(source.record.operationId);
    expect(readOperationEvidence(await rig.journal.read(source.record.operationId))).toMatchObject({ kind: "legacy", source, retryAllowed: false, dispatchAllowed: false });
    if (id) expect(projectLegacyOperation(stored)).toEqual(source.record);
    else expect(() => projectLegacyOperation(stored)).toThrow(UpgradeRequired);
    expect((await rig.bridge.dispatch(rig.context, source.record.operationId, rig.lease)).kind).toBe("refused");
    expect((await rig.bridge.redispatch(rig.context, source.record.operationId, rig.lease)).kind).toBe("not-eligible");
    expect(rig.calls).toEqual([]);
    const reopened = await rig.reopen();
    const evidence = readOperationEvidence(await reopened.journal.read(source.record.operationId));
    expect(evidence).toMatchObject({ kind: "legacy", source, retryAllowed: false, dispatchAllowed: false });
  });
}
