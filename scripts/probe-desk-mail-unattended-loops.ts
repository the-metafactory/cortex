import { strict as assert } from "node:assert";
import { dmarcMail, loopMail, openMailLoopRig, LOOP_PROVENANCE } from "../src/conversations/domain-adapters/mail/loop-fixtures";
import type { MailLoopPass } from "../src/conversations/domain-adapters/mail/loop-host";
import type { MailLoopSelection } from "../src/conversations/domain-adapters/mail/loop-contract";

const RULE = { id: "rule-reports", match: "sender" as const, value: "reports@example.org", target: "archive" as const };
const DIGEST = "rule-digest";
const ruleSelection: MailLoopSelection = { kind: "rule", ruleId: RULE.id, match: RULE.match, value: RULE.value };
const dmarcSelection: MailLoopSelection = { kind: "dmarc", ruleIds: [DIGEST] };

const proposesOnly = (pass: MailLoopPass, messageIds: readonly string[]): void => {
  assert.equal(pass.paused, false);
  assert.equal(pass.acted, 0);
  assert.deepEqual(pass.receipts, []);
  assert.deepEqual(pass.proposals.map(proposal => proposal.messageId), [...messageIds]);
  assert.deepEqual(pass.proposals.map(proposal => proposal.reason), messageIds.map(() => "no-grant"));
};

const moves = (pass: MailLoopPass, messageIds: readonly string[]): void => {
  assert.equal(pass.paused, false);
  assert.equal(pass.acted, messageIds.length);
  assert.deepEqual(pass.proposals, []);
  assert.deepEqual(pass.receipts.map(receipt => receipt.messageId), [...messageIds]);
  assert.deepEqual(pass.receipts.map(receipt => receipt.state), messageIds.map(() => "done"));
  assert.deepEqual(pass.receipts.map(receipt => receipt.basis), messageIds.map(() => "grant"));
  assert.deepEqual(pass.receipts.map(receipt => receipt.undo.kind), messageIds.map(() => "available"));
};

const rig = await openMailLoopRig();
try {
  rig.seed(["rule-1", "rule-2", "dmarc-1"]);

  proposesOnly(await rig.loop.runRules({ rule: RULE, mail: [loopMail("rule-1"), loopMail("rule-2")] }, LOOP_PROVENANCE), ["rule-1", "rule-2"]);
  assert.deepEqual(rig.calls, []);
  assert.equal(rig.loop.activeGrant("rule"), null);

  const ruleGrant = await rig.grant("rule", ["move"], ruleSelection);
  assert.equal(rig.authorityGrants[0]?.capabilityIds.join(","), "mail.move,mail.restore");
  const rulePass = await rig.loop.runRules({ rule: RULE, mail: [loopMail("rule-1"), loopMail("rule-2")] }, LOOP_PROVENANCE);
  moves(rulePass, ["rule-1", "rule-2"]);
  assert.equal(rig.folders.get("rule-1"), "Archive");
  assert.equal(rig.folders.get("rule-2"), "Archive");
  const undone = await rig.loop.undo(rulePass.receipts[0]!.operationId, LOOP_PROVENANCE);
  assert.equal(undone.kind, "receipt");
  assert.equal(rig.folders.get("rule-1"), "INBOX");

  proposesOnly(await rig.loop.runDmarc({ target: "archive", mail: [dmarcMail("dmarc-1", DIGEST)] }, LOOP_PROVENANCE), ["dmarc-1"]);
  assert.equal(rig.folders.get("dmarc-1"), "INBOX");

  await rig.grant("dmarc", ["move"], dmarcSelection);
  moves(await rig.loop.runDmarc({ target: "archive", mail: [dmarcMail("dmarc-1", DIGEST)] }, LOOP_PROVENANCE), ["dmarc-1"]);
  assert.equal(rig.folders.get("dmarc-1"), "Archive");

  rig.pause("rule");
  const paused = await rig.loop.runRules({ rule: RULE, mail: [loopMail("rule-2")] }, LOOP_PROVENANCE);
  assert.equal(paused.paused, true);
  assert.equal(paused.acted, 0);
  assert.deepEqual(paused.proposals, []);
  rig.resume("rule");

  assert.equal(rig.revoke(ruleGrant.grantId), true);
  proposesOnly(await rig.loop.runRules({ rule: RULE, mail: [loopMail("rule-2")] }, LOOP_PROVENANCE), ["rule-2"]);

  await rig.reopen();
  assert.equal(rig.loop.activeGrant("rule"), null);
  assert.equal(rig.loop.activeGrant("dmarc")?.status, "active");
  assert.equal(rig.loop.paused("rule"), false);
  assert.equal((await rig.receipts()).filter(receipt => receipt.state === "done" && receipt.action !== "restore").length, 3);
  console.log("Mail unattended-loop probe passed: proposals without a grant, move receipts and Undo under a per-connection standing grant, pause, revocation and readback after reopen.");
} finally {
  await rig.close();
}
