import { afterEach, describe, expect, test } from "bun:test";
import { openInvitationFixture, invitationProvenance as provenance, invitationSelection as selection } from "../mail/invitation-fixture";
import { INVITATION_CAPABILITIES, INVITATION_REPLIES } from "../mail/invitation-contract";
import { MailInvitationHost, type InvitationOutcome } from "../mail/invitation-host";
import { UNDO_WINDOW_MS } from "../../../surface/mc/desk/mail-move";

const fixtures: Awaited<ReturnType<typeof openInvitationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function rig(actions?: Parameters<typeof openInvitationFixture>[0]) {
  const fixture = await openInvitationFixture(actions);
  fixtures.push(fixture);
  return fixture;
}
const receipt = (outcome: InvitationOutcome) => { if (outcome.kind !== "receipt") throw new Error(`Expected a receipt, got ${outcome.kind}`); return outcome.receipt; };
const decline = async (fixture: Awaited<ReturnType<typeof rig>>, choice: "once" | "always" = "always") => receipt(await fixture.host.reply({ ...selection, provenance, reply: "decline", choice }));

describe("Mail invitation reply authority", () => {
  for (const reply of INVITATION_REPLIES) {
    test(`${reply} names covered replies and organizer notification before doing anything`, async () => {
      const fixture = await rig();
      const outcome = await fixture.host.reply({ ...selection, provenance, reply });
      if (outcome.kind !== "needs-grant") throw new Error("Expected a grant prompt.");
      expect(outcome.prompt).toMatchObject({ connectionId: fixture.options.connectionId, covers: INVITATION_REPLIES.map(reply => INVITATION_CAPABILITIES[reply]) });
      expect(outcome.prompt.question).toContain("Accept, Decline, Tentative");
      expect(outcome.prompt.warning).toBe("Replies notify the organizer. Undo cannot retract that notification.");
      expect(outcome.prompt.options.map(option => option.label)).toEqual(["Use one click from now on", "Just this once", "Cancel"]);
      expect(fixture.calls).toHaveLength(0);
      expect(fixture.ids).toHaveLength(0);
      const done = receipt(await fixture.host.reply({ ...selection, provenance, reply, choice: "once" }));
      expect(done.state).toBe("done");
      expect(done.basis).toBe("confirmation");
      expect(done.undo).toEqual({ kind: "unavailable", reason: "organizer-notified" });
      expect(done.message).toContain("No Undo is available");
      expect(fixture.owner.notifications).toBe(1);
      expect(fixture.owner.removed).toBe(false);
      expect(fixture.grants).toHaveLength(0);
      expect((await fixture.host.undo(done.operationId, provenance)).kind).toBe("unavailable");
      await fixture.reopen();
      expect(await fixture.host.receipt(done.operationId)).toEqual(done);
    });
  }

  test("standing reply grant covers only declared replies and never removal, revocation asks again", async () => {
    const fixture = await rig(["accept", "decline", "remove", "restore"]);
    const first = await decline(fixture);
    expect(fixture.grants[0]?.capabilityIds).toEqual(["mail.invitation.accept", "mail.invitation.decline"]);
    const accepted = receipt(await fixture.host.reply({ ...selection, expectedRevision: fixture.owner.revision, provenance, reply: "accept" }));
    expect(accepted.basis).toBe("grant");
    expect((await fixture.host.reply({ ...selection, provenance, reply: "tentative" })).kind).toBe("unavailable");
    expect((await fixture.host.remove({ declineOperationId: first.operationId, provenance })).kind).toBe("needs-grant");
    fixture.revoke();
    expect((await fixture.host.reply({ ...selection, provenance, reply: "accept" })).kind).toBe("needs-grant");
  });

  test("cancel, invalid input, unavailable capabilities and host denials cannot dispatch", async () => {
    const fixture = await rig();
    expect((await fixture.host.reply({ ...selection, provenance, reply: "accept", choice: "cancel" })).kind).toBe("cancelled");
    expect((await fixture.host.reply({ ...selection, expectedRevision: "", provenance, reply: "accept", choice: "always" })).kind).toBe("unavailable");
    fixture.denyGrant();
    expect((await fixture.host.reply({ ...selection, provenance, reply: "accept", choice: "always" })).kind).toBe("denied");
    fixture.denyApproval();
    expect((await fixture.host.reply({ ...selection, provenance, reply: "accept", choice: "once" })).kind).toBe("denied");
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.ids).toHaveLength(0);
    expect(fixture.grants).toHaveLength(0);
  });
});

describe("declined invitation removal", () => {
  test("decline leaves the event and offers separately granted removal; Undo is a linked restoration", async () => {
    const fixture = await rig();
    const declined = await decline(fixture);
    expect(declined.message).toContain("The invitation has not been removed.");
    expect(declined.nextActions).toEqual([{ action: "remove", label: "Remove declined invitation", declineOperationId: declined.operationId }]);
    expect(fixture.calls.map(call => call.snapshot.capabilityId)).toEqual(["mail.invitation.decline"]);
    const request = { declineOperationId: declined.operationId, provenance };
    const prompt = await fixture.host.remove(request);
    if (prompt.kind !== "needs-grant") throw new Error("Expected a separate removal prompt.");
    expect(prompt.prompt.covers).toEqual(["mail.invitation.remove", "mail.invitation.restore"]);
    expect(prompt.prompt.question).toContain("removal and restoration");
    expect(fixture.owner.removed).toBe(false);
    const removed = receipt(await fixture.host.remove({ ...request, choice: "always" }));
    expect(fixture.grants).toHaveLength(2);
    expect(removed).toMatchObject({ action: "remove", state: "done", basis: "grant", undo: { kind: "available" } });
    expect(fixture.owner.removed).toBe(true);
    expect(fixture.owner.notifications).toBe(1);
    await fixture.reopen();
    expect(await fixture.host.receipt(removed.operationId)).toEqual(removed);
    const restored = receipt(await fixture.host.undo(removed.operationId, provenance));
    expect(restored).toMatchObject({ action: "restore", state: "done", basis: "grant" });
    expect((await fixture.journal().read(restored.operationId))?.journal.links).toEqual({ compensatesOperationId: removed.operationId });
    expect((await fixture.host.receipt(removed.operationId))?.undo).toEqual({ kind: "unavailable", reason: "undone" });
    expect((await fixture.host.undo(removed.operationId, provenance)).kind).toBe("unavailable");
    expect(fixture.owner.removed).toBe(false);
    expect(fixture.owner.notifications).toBe(1);
  });

  test("without restoration, even a pre-existing removal grant cannot authorize one click", async () => {
    const fixture = await rig([...INVITATION_REPLIES, "remove"]);
    const declined = await decline(fixture);
    fixture.grants.push({ id: "old-removal-grant", capabilityIds: ["mail.invitation.remove"] });
    const request = { declineOperationId: declined.operationId, provenance };
    const prompt = await fixture.host.remove(request);
    if (prompt.kind !== "needs-grant") throw new Error("Expected confirmation each time.");
    expect(prompt.prompt.covers).toEqual([]);
    expect(prompt.prompt.options.map(option => option.choice)).toEqual(["once", "cancel"]);
    expect(prompt.prompt.warning).toContain("cannot restore an event");
    expect((await fixture.host.remove({ ...request, choice: "always" })).kind).toBe("unavailable");
    expect(fixture.calls).toHaveLength(1);
    const removed = receipt(await fixture.host.remove({ ...request, choice: "once" }));
    expect(removed).toMatchObject({ basis: "confirmation", undo: { kind: "unavailable", reason: "unsupported" } });
    expect(removed.message).toContain("No Undo is available");
  });

  test("unknown operations, other connections, other accounts and replies other than decline cannot remove", async () => {
    const fixture = await rig();
    const accepted = receipt(await fixture.host.reply({ ...selection, provenance, reply: "accept", choice: "once" }));
    expect((await fixture.host.remove({ declineOperationId: accepted.operationId, provenance, choice: "once" })).kind).toBe("unavailable");
    const declined = receipt(await fixture.host.reply({ ...selection, expectedRevision: fixture.owner.revision, provenance, reply: "decline", choice: "once" }));
    for (const options of [{ connectionId: "other-connection" }, { account: "other-account" }]) {
      const other = new MailInvitationHost({ ...fixture.options, ...options });
      expect(await other.receipt(declined.operationId)).toBeNull();
      expect((await other.remove({ declineOperationId: declined.operationId, provenance, choice: "once" })).kind).toBe("unavailable");
    }
    expect((await fixture.host.remove({ declineOperationId: "unknown", provenance, choice: "once" })).kind).toBe("unavailable");
    expect(fixture.calls).toHaveLength(2);
  });

  test("Undo expires at the native window", async () => {
    const fixture = await rig();
    const declined = await decline(fixture);
    const removed = receipt(await fixture.host.remove({ declineOperationId: declined.operationId, provenance, choice: "once" }));
    fixture.advance(UNDO_WINDOW_MS);
    expect((await fixture.host.undo(removed.operationId, provenance)).kind).toBe("unavailable");
    expect(fixture.owner.removed).toBe(true);
  });
});

describe("invitation owner refusals", () => {
  test("a changed invitation refuses the reply and re-reads it without notification", async () => {
    const fixture = await rig();
    fixture.owner.revision = "2";
    const result = receipt(await fixture.host.reply({ ...selection, provenance, reply: "accept", choice: "once" }));
    expect(result).toMatchObject({ state: "conflict", refreshInvitation: true });
    expect(fixture.refreshes).toEqual([selection.invitationId]);
    expect(fixture.owner.notifications).toBe(0);
    expect(fixture.calls[0]?.snapshot.expectedOwnerRevision).toBe("1");
  });

  test("changes after declining refuse removal, and changes after removal refuse Undo", async () => {
    const fixture = await rig();
    const declined = await decline(fixture);
    fixture.owner.revision = "3";
    const request = { declineOperationId: declined.operationId, provenance, choice: "once" as const };
    expect(receipt(await fixture.host.remove(request)).state).toBe("conflict");
    expect(fixture.owner.removed).toBe(false);
    fixture.owner.revision = "2";
    const removed = receipt(await fixture.host.remove(request));
    fixture.owner.revision = "4";
    expect(receipt(await fixture.host.undo(removed.operationId, provenance)).state).toBe("conflict");
    expect(fixture.owner.removed).toBe(true);
    expect(fixture.owner.notifications).toBe(1);
  });

  for (const [field, state] of [["missing", "missing"], ["denied", "denied"], ["uncertain", "uncertain"]] as const) {
    test(`${field} has an explicit journal receipt and cannot offer removal`, async () => {
      const fixture = await rig();
      fixture.owner[field] = true;
      const result = await decline(fixture, "once");
      expect(result.state).toBe(state);
      expect(result.nextActions).toEqual([]);
      expect(result.undo.kind).toBe("unavailable");
      expect((await fixture.host.remove({ declineOperationId: result.operationId, provenance, choice: "once" })).kind).toBe("unavailable");
      expect(fixture.owner.notifications).toBe(0);
      expect(fixture.calls).toHaveLength(1);
    });
  }
});
