import { strict as assert } from "node:assert";
import { openMailUnsubscribeRig, unsubscribeReceipt } from "../src/conversations/domain-adapters/mail/unsubscribe-fixtures";
import { MAIL_UNSUBSCRIBE_CAPABILITY } from "../src/conversations/domain-adapters/mail/unsubscribe-contract";

const rig = await openMailUnsubscribeRig();
try {
  const asked = await rig.press("message-example");
  assert.equal(asked.kind, "needs-grant");
  if (asked.kind !== "needs-grant") throw new Error("Expected the grant prompt.");
  assert.match(asked.prompt.question, /may not be reversible/);
  assert.deepEqual(asked.prompt.covers, [MAIL_UNSUBSCRIBE_CAPABILITY]);
  assert.equal(rig.calls.length, 0);
  assert.equal(rig.posts.length, 0);

  const granted = unsubscribeReceipt(await rig.press("message-example", "always"));
  assert.deepEqual(rig.grants.map(grant => grant.capabilities), [[MAIL_UNSUBSCRIBE_CAPABILITY]]);
  assert.equal(granted.state, "done");
  assert.equal(granted.undo, false);
  assert.match(granted.message, /There is no Undo\./);
  assert.equal(granted.host, "list.example.org");
  assert.deepEqual(rig.posts, ["list.example.org"]);

  await rig.reopen();
  assert.equal((await rig.host.receipt(granted.operationId))?.state, "done");

  const denied = unsubscribeReceipt(await rig.pressAs("account-other", "message-example", "always"));
  assert.equal(denied.state, "denied");
  assert.equal(denied.undo, false);
  assert.equal(denied.account, "account-other");

  rig.removeMessage("message-example");
  const missing = unsubscribeReceipt(await rig.press("message-example"));
  assert.equal(missing.state, "missing");
  assert.equal(missing.undo, false);
  assert.equal(missing.message, "The message no longer exists.");
  assert.equal(missing.operationId.startsWith("mail-unsubscribe:"), true);

  console.log("Mail unsubscribe probe passed: the prompt warns the change may not be reversible, the grant names only unsubscribe, receipts carry no Undo, and refusals still write a receipt.");
} finally {
  await rig.close();
}
