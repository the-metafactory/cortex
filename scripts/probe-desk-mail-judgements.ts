import { strict as assert } from "node:assert";
import { openMailJudgementRig, judgementMessage, judgementReceipt, JUDGEMENT_BINDING, JUDGEMENT_PROVENANCE } from "../src/conversations/domain-adapters/mail/judgement-fixtures";
import { addVip, listSenders } from "../src/surface/mc/desk/vips";
import { queryMailLog } from "../src/surface/mc/desk/mail-log";
import { trustedViews } from "../src/surface/mc/desk/mail-trust";
import { readSnooze } from "../src/surface/mc/desk/mail-snooze";
import { readWaiting, recordWaiting } from "../src/surface/mc/desk/mail-waiting";
import type { MailJudgementInput } from "../src/conversations/domain-adapters/mail/judgement-contract";
import { AT } from "../src/conversations/domain-adapters/operations/fixtures";

const rig = await openMailJudgementRig();
try {
  const message = judgementMessage();
  const apply = async (input: MailJudgementInput) => {
    const receipt = judgementReceipt(await rig.press(input, "always"));
    assert.equal(receipt.state, "done");
    assert.equal(receipt.undo, true);
    return receipt;
  };
  const undo = async (id: string) => {
    await rig.reopen();
    assert.equal(judgementReceipt(await rig.host.undo(id, JUDGEMENT_PROVENANCE)).state, "done");
  };
  for (const action of ["unimportant", "block-domain"] as const) {
    const receipt = await apply({ action, message });
    assert.equal(listSenders(rig.db, "unimportant").length, 1);
    await undo(receipt.operationId);
    assert.equal(listSenders(rig.db, "unimportant").length, 0);
  }
  const trusted = await apply({ action: "not-phishing", message });
  assert.equal(trustedViews(rig.db).length, 1);
  await undo(trusted.operationId);
  assert.equal(trustedViews(rig.db).length, 0);
  const snoozed = await apply({ action: "snooze", message, until: { kind: "later" } });
  assert.equal(readSnooze(rig.db, message.canonicalId)?.state, "snoozed");
  const cancelled = await apply({ action: "snooze-cancel", message });
  assert.equal(readSnooze(rig.db, message.canonicalId), null);
  await undo(cancelled.operationId);
  assert.equal(readSnooze(rig.db, message.canonicalId)?.state, "snoozed");
  assert.equal(judgementReceipt(await rig.host.undo(snoozed.operationId, JUDGEMENT_PROVENANCE)).state, "conflict");
  const fresh = await apply({ action: "snooze", message, until: { kind: "tomorrow" } });
  await undo(fresh.operationId);
  recordWaiting(rig.db, [{ ...rig.readings[0]!, sent: [{ kind: "sent", id: "sent-example", from: { address: "me@example.net" }, to: [{ address: "sender@example.org" }], subject: "Example question?", text: "Can you answer?", sentAt: AT, account: JUDGEMENT_BINDING.account }] }], Date.parse(AT));
  for (const op of ["snooze", "done", "no-answer", "expect"] as const) {
    const before = readWaiting(rig.db, "sent-example");
    const receipt = await apply({ action: "waiting", message: judgementMessage("sent-example"), op });
    assert.notDeepEqual(readWaiting(rig.db, "sent-example"), before);
    await undo(receipt.operationId);
    assert.deepEqual(readWaiting(rig.db, "sent-example"), before);
  }
  for (const said of ["archive", "junk", "trash"] as const) {
    const receipt = await apply({ action: "correct", message, said });
    assert(queryMailLog(rig.db).some(row => row.where === "correction" && row.action === said));
    await undo(receipt.operationId);
    assert(!queryMailLog(rig.db).some(row => row.where === "correction" && row.action === said));
    assert.equal(rig.folders.get(message.canonicalId), "INBOX");
  }
  const irreversible: MailJudgementInput = { action: "correct", message, said: "matters" };
  assert.equal((await rig.press(irreversible)).kind, "needs-confirmation");
  assert.equal(judgementReceipt(await rig.press(irreversible, "once")).undo, false);
  assert.equal((await rig.press(irreversible)).kind, "needs-confirmation");
  addVip(rig.db, "sender@example.org", "Example VIP", Date.parse(AT));
  const log = queryMailLog(rig.db);
  for (const action of ["unimportant", "block-domain"] as const) {
    assert.equal(judgementReceipt(await rig.press({ action, message }, "always")).state, "refused");
    assert.equal(listSenders(rig.db, "unimportant").length, 0);
    assert.deepEqual(queryMailLog(rig.db), log);
  }
  console.log("Mail judgement probe passed: grants, confirmation, list Undo, trust, snooze, waiting, correction restore, VIP refusal and canonical readback after reopen.");
} finally {
  await rig.close();
}
