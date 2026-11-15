import { strict as assert } from "node:assert";
import { openMailReplyDraftRig, mailDraftLegacyFixture } from "../src/conversations/domain-adapters/mail/reply-draft-fixtures";
import { importLegacyOperation, readOperationEvidence } from "../src/conversations/domain-adapters/operations/legacy";
import { AT } from "../src/conversations/domain-adapters/operations/fixtures";
import { MAIL_REPLY_DRAFT_CAPABILITY } from "../src/conversations/domain-adapters/mail/reply-draft-host";

const rig = await openMailReplyDraftRig();
try {
  const request = rig.request();
  assert.deepEqual(await rig.facade().create(request), { state: "created", canonicalId: "native-draft" });
  assert.equal(rig.calls.length, 0);
  assert.deepEqual(await rig.facade(true).create(request), { state: "created", canonicalId: "draft-example" });
  assert.equal((await rig.journal.read(request.operationId))?.journal.state, "succeeded");
  assert.equal(rig.calls[0]?.authority.basis.kind, "confirmation");
  assert.equal((await rig.facade(true, { account: "other-account" }).create(rig.request("other"))).state, "failed");
  assert.equal(await rig.authority.grantConnectionActions(rig.context, rig.connection.connectionId, [MAIL_REPLY_DRAFT_CAPABILITY]), null);
  for (const canonicalId of ["historic-draft", ""]) {
    const { source, mapping } = mailDraftLegacyFixture(canonicalId);
    source.record.operationId = `${source.record.conversationId}:${canonicalId || "empty"}:1`;
    source.record.proposalId = canonicalId || "empty";
    source.proposal.proposalId = source.record.proposalId;
    const imported = await importLegacyOperation(rig.journal, source, mapping, AT);
    assert.equal(imported.retryBlocked, true);
    const evidence = readOperationEvidence(await rig.journal.read(source.record.operationId));
    assert.equal(evidence.kind, "legacy");
    if (evidence.kind === "legacy") assert.deepEqual(evidence.source, source);
    assert.equal((await rig.bridge.redispatch(rig.context, source.record.operationId, rig.lease)).kind, "not-eligible");
  }
  assert.equal(rig.calls.length, 1);
  const reopened = await rig.reopen();
  assert.equal((await reopened.journal.read(request.operationId))?.journal.state, "succeeded");
  const legacy = await reopened.journal.read("conversation-example:empty:1");
  assert.equal(legacy?.retryBlocked, true);
  assert.equal(readOperationEvidence(legacy).kind, "legacy");
  console.log("Mail reply draft probe passed: native fallback, exact local confirmation, account refusal and raw legacy receipts without retry.");
} finally {
  await rig.close();
}
