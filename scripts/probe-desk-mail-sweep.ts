import { strict as assert } from "node:assert";
import { openMailSweepRig, senderRule, sweepMail, SWEEP_PROVENANCE } from "../src/conversations/domain-adapters/mail/sweep-fixtures";

const rig = await openMailSweepRig();
try {
  rig.seed(["m1", "m2", "m3"]);
  const mail = ["m1", "m2", "m3"].map(id => sweepMail(id));

  const preview = rig.host.preview({ rule: senderRule(), target: "archive", mail });
  assert.equal(preview.phrase, "from boss@example.org");
  assert.equal(preview.count, 3);
  assert.deepEqual(preview.members.map(member => member.messageId), ["m1", "m2", "m3"]);
  assert.deepEqual(rig.calls, []);
  assert.deepEqual(rig.grants.list(), []);

  const prompted = await rig.host.run({ preview, mail, provenance: SWEEP_PROVENANCE });
  assert.equal(prompted.kind, "needs-grant");
  if (prompted.kind === "needs-grant") {
    assert.deepEqual(prompted.prompt.capabilities, ["mail.move", "mail.restore"]);
    assert.ok(prompted.prompt.question.includes("3 mails from boss@example.org"));
  }
  assert.deepEqual(rig.calls, []);

  const run = await rig.host.run({ preview, mail, provenance: SWEEP_PROVENANCE, choice: "always" });
  assert.equal(run.kind, "receipt");
  if (run.kind !== "receipt") throw new Error("The sweep previews, then runs under its own permission.");
  assert.equal(run.receipt.summary, "succeeded");
  assert.equal(run.receipt.count, 3);
  assert.deepEqual(run.receipt.items.map(item => item.state), ["done", "done", "done"]);
  assert.equal(run.receipt.message, "Archived 3 mails from boss@example.org.");
  assert.equal(rig.folders.get("m1"), "Archive");
  assert.deepEqual(rig.authorityGrants.map(grant => grant.selection?.target.canonicalId), ["m1", "m2", "m3"]);
  assert.equal(await rig.authority.findGrant("mail.move"), null);
  assert.equal((await rig.moves.press({ action: "move", messageId: "m9", target: "archive", provenance: SWEEP_PROVENANCE })).kind, "needs-grant");

  const grown = await rig.host.run({ preview, mail: [...mail, sweepMail("m4")], provenance: SWEEP_PROVENANCE, choice: "always" });
  assert.equal(grown.kind, "stale");
  if (grown.kind === "stale") assert.equal(grown.preview.count, 4);

  rig.folders.set("m2", "Junk");
  const undone = await rig.host.undo(run.receipt.sweepId, SWEEP_PROVENANCE);
  assert.equal(undone.kind, "receipt");
  if (undone.kind !== "receipt") throw new Error("The sweep Undo restores the set.");
  assert.equal(undone.receipt.restored, 2);
  assert.equal(undone.receipt.conflicts, 1);
  assert.equal(undone.receipt.undone, false);
  assert.equal(rig.folders.get("m1"), "INBOX");
  assert.equal(rig.folders.get("m2"), "Junk");
  assert.equal(rig.folders.get("m3"), "INBOX");
  assert.ok(undone.receipt.message.includes("Moved 2 of 3 back to INBOX"));

  rig.folders.set("m2", "Archive");
  const retried = await rig.host.undo(run.receipt.sweepId, SWEEP_PROVENANCE);
  assert.equal(retried.kind, "receipt");
  if (retried.kind === "receipt") {
    assert.equal(retried.receipt.restored, 3);
    assert.equal(retried.receipt.conflicts, 0);
    assert.equal(retried.receipt.undone, true);
  }
  assert.equal(rig.folders.get("m2"), "INBOX");
  console.log("Mail sweep probe passed: a preview names the rule and count, the set asks for and runs under its own rule-scoped permission that answers no other move, a changed set is refused with a fresh preview, and Undo restores all but the message that moved since.");
} finally {
  await rig.close();
}
