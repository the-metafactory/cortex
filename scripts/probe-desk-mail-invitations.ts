import assert from "node:assert/strict";
import { INVITATION_REPLIES } from "../src/conversations/domain-adapters/mail/invitation-contract";
import { openInvitationFixture, invitationSelection, invitationProvenance } from "../src/conversations/domain-adapters/mail/invitation-fixture";

for (const reply of INVITATION_REPLIES) {
  const fixture = await openInvitationFixture();
  try {
    const request = { ...invitationSelection, provenance: invitationProvenance, reply };
    const prompt = await fixture.host.reply(request);
    assert.equal(prompt.kind, "needs-grant");
    if (prompt.kind !== "needs-grant") throw new Error("Missing reply prompt");
    assert.match(prompt.prompt.question, /Accept, Decline, Tentative/);
    assert.match(prompt.prompt.warning, /notify the organizer.*Undo cannot retract/);
    assert.equal(fixture.calls.length, 0);
    const result = await fixture.host.reply({ ...request, choice: "always" });
    assert.equal(result.kind, "receipt");
    if (result.kind !== "receipt") throw new Error("Missing reply receipt");
    assert.equal(result.receipt.state, "done");
    assert.equal(result.receipt.undo.kind, "unavailable");
    assert.match(result.receipt.message, /No Undo is available/);
    assert.equal(fixture.owner.removed, false);
    assert.equal(fixture.owner.notifications, 1);
    if (reply === "decline") {
      assert.equal(result.receipt.nextActions[0]?.label, "Remove declined invitation");
      const removal = { declineOperationId: result.receipt.operationId, provenance: invitationProvenance };
      const separate = await fixture.host.remove(removal);
      assert.equal(separate.kind, "needs-grant");
      if (separate.kind !== "needs-grant") throw new Error("Missing removal prompt");
      assert.deepEqual(separate.prompt.covers, ["mail.invitation.remove", "mail.invitation.restore"]);
      const removed = await fixture.host.remove({ ...removal, choice: "always" });
      assert.equal(removed.kind, "receipt");
      if (removed.kind !== "receipt") throw new Error("Missing removal receipt");
      assert.equal(removed.receipt.state, "done");
      assert.equal(removed.receipt.undo.kind, "available");
      assert.equal(fixture.owner.removed, true);
      assert.equal(fixture.grants.length, 2);
      await fixture.reopen();
      assert.deepEqual(await fixture.host.receipt(removed.receipt.operationId), removed.receipt);
      const restored = await fixture.host.undo(removed.receipt.operationId, invitationProvenance);
      assert.equal(restored.kind, "receipt");
      if (restored.kind !== "receipt") throw new Error("Missing restoration receipt");
      assert.equal(restored.receipt.state, "done");
      assert.deepEqual((await fixture.journal().read(restored.receipt.operationId))?.journal.links, { compensatesOperationId: removed.receipt.operationId });
      assert.equal(fixture.owner.removed, false);
      await fixture.reopen();
      assert.deepEqual(await fixture.options.index.compensations(removed.receipt.operationId), [restored.receipt.operationId]);
      assert.deepEqual(await fixture.host.receipt(restored.receipt.operationId), restored.receipt);
      assert.deepEqual((await fixture.host.receipt(removed.receipt.operationId))?.undo, { kind: "unavailable", reason: "undone" });
      assert.equal((await fixture.host.undo(removed.receipt.operationId, invitationProvenance)).kind, "unavailable");
      assert.equal(fixture.calls.length, 3);
      console.log("PASS decline leaves event; removal has its own grant; receipts and consumed Undo survive journal and index reopen");
    }
    console.log(`PASS ${reply}: explicit warning, scoped reply grant and no-Undo receipt`);
  } finally { await fixture.close(); }
}

const irreversible = await openInvitationFixture([...INVITATION_REPLIES, "remove"]);
try {
  const declined = await irreversible.host.reply({ ...invitationSelection, provenance: invitationProvenance, reply: "decline", choice: "always" });
  if (declined.kind !== "receipt") throw new Error("Missing decline receipt");
  const request = { declineOperationId: declined.receipt.operationId, provenance: invitationProvenance };
  const prompt = await irreversible.host.remove(request);
  if (prompt.kind !== "needs-grant") throw new Error("Missing irreversible removal prompt");
  assert.deepEqual(prompt.prompt.covers, []);
  assert.deepEqual(prompt.prompt.options.map(option => option.choice), ["once", "cancel"]);
  assert.equal((await irreversible.host.remove({ ...request, choice: "always" })).kind, "unavailable");
  const removed = await irreversible.host.remove({ ...request, choice: "once" });
  if (removed.kind !== "receipt") throw new Error("Missing irreversible removal receipt");
  assert.equal(removed.receipt.undo.kind, "unavailable");
  assert.equal(removed.receipt.basis, "confirmation");
  console.log("PASS connection without event restoration requires confirmation for removal");
} finally { await irreversible.close(); }
