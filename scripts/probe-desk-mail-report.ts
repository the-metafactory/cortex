import { strict as assert } from "node:assert";
import { openMailReportRig, reportReceipt } from "../src/conversations/domain-adapters/mail/report-fixtures";
import { MAIL_REPORT_CAPABILITY } from "../src/conversations/domain-adapters/mail/report-contract";

const rig = await openMailReportRig();
try {
  const draft = reportReceipt(await rig.press("draft", "message-example"));
  assert.equal(draft.state, "done");
  assert.equal(rig.grants.length, 0);

  const asked = await rig.press("spam", "message-example");
  if (asked.kind !== "needs-grant") throw new Error("Expected the grant prompt.");
  assert.match(asked.prompt.question, /cannot retract a report/);
  assert.deepEqual(asked.prompt.covers, [MAIL_REPORT_CAPABILITY.spam]);
  assert.equal(rig.submitted.length, 0);

  const spam = reportReceipt(await rig.press("spam", "message-example", "always"));
  assert.equal(spam.state, "done");
  assert.deepEqual(rig.grants.map(grant => grant.capabilities), [[MAIL_REPORT_CAPABILITY.spam]]);

  const undone = await rig.undo(spam.operationId);
  if (undone.kind !== "undo") throw new Error("Expected an Undo outcome.");
  assert.equal(undone.state, "done");
  assert.match(undone.message, /The report stands\./);
  assert.equal(rig.submitted.length, 1);

  await rig.reopen();
  assert.equal((await rig.host.receipt(spam.operationId))?.undone, true);

  const phishing = reportReceipt(await rig.press("phishing", "message-example", "once"));
  rig.moveElsewhere("message-example", "Archive");
  const conflict = await rig.undo(phishing.operationId);
  if (conflict.kind !== "undo") throw new Error("Expected an Undo outcome.");
  assert.equal(conflict.state, "conflict");

  rig.removeMessage("message-example");
  const missing = reportReceipt(await rig.press("phishing", "message-example", "once"));
  assert.equal(missing.state, "missing");
  const denied = reportReceipt(await rig.pressAs("account-other", "spam", "message-example"));
  assert.equal(denied.state, "denied");

  console.log("Mail report probe passed: a draft asks for no grant, a provider report warns Undo cannot retract it, an undone report says it stands, and refusals still write a receipt.");
} finally {
  await rig.close();
}
