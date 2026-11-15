import { afterEach, describe, expect, test } from "bun:test";
import { LOOP_ACCOUNT } from "../mail/loop-fixtures";
import { ageRule, openMailSweepRig, senderRule, sweepMail, SWEEP_PROVENANCE, type MailSweepRig } from "../mail/sweep-fixtures";
import type { MailSweepOutcome, MailSweepReceipt } from "../mail/sweep-host";
import type { MailSweepRule, MailSweepTarget, SweepMail } from "../mail/sweep-contract";

const rigs: MailSweepRig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
async function open(): Promise<MailSweepRig> {
  const rig = await openMailSweepRig();
  rigs.push(rig);
  return rig;
}

const listed = (ids: readonly string[]): SweepMail[] => ids.map(id => sweepMail(id));
const receiptOf = (outcome: MailSweepOutcome): MailSweepReceipt => {
  if (outcome.kind !== "receipt") throw new Error(`Expected a sweep receipt, got ${outcome.kind}.`);
  return outcome.receipt;
};
const previewOf = (rig: MailSweepRig, mail: readonly SweepMail[], rule: MailSweepRule = senderRule(), target: MailSweepTarget = "archive") => rig.host.preview({ rule, target, mail });
const runOf = async (rig: MailSweepRig, mail: readonly SweepMail[], preview = previewOf(rig, mail), choice?: "always" | "once") =>
  rig.host.run({ preview, mail, provenance: SWEEP_PROVENANCE, ...(choice ? { choice } : {}) });
const sweptOf = async (rig: MailSweepRig, mail: readonly SweepMail[], target: MailSweepTarget = "archive"): Promise<MailSweepReceipt> =>
  receiptOf(await runOf(rig, mail, previewOf(rig, mail, senderRule(), target), "always"));
const undoneOf = async (rig: MailSweepRig, sweepId: string): Promise<MailSweepReceipt> => {
  const outcome = await rig.host.undo(sweepId, SWEEP_PROVENANCE);
  if (outcome.kind !== "receipt") throw new Error(`Expected an Undo receipt, got ${outcome.kind}.`);
  return outcome.receipt;
};

describe("a one-click Mail sweep preview", () => {
  test("names the rule and the exact count before anything runs", async () => {
    const rig = await open();
    rig.seed(["m1", "m2", "m3"]);
    const mail = [...listed(["m1", "m2", "m3"]), sweepMail("elsewhere", { from: { address: "someone@example.net" } }), sweepMail("read", { unread: false })];
    const preview = previewOf(rig, mail);
    expect(preview).toMatchObject({ account: LOOP_ACCOUNT, target: "archive", rule: senderRule(), phrase: "from boss@example.org", count: 3 });
    expect(preview.members.map(member => member.messageId)).toEqual(["m1", "m2", "m3"]);
    expect(preview.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.at).toBe("2026-11-01T00:01:00.000Z");
    expect(rig.calls).toEqual([]);
    expect(rig.grants.list()).toEqual([]);
  });

  test("counts a message the listing repeats only once", async () => {
    const rig = await open();
    const preview = previewOf(rig, listed(["m1", "m1", "m2"]));
    expect(preview.count).toBe(2);
    expect(preview.members.map(member => member.messageId)).toEqual(["m1", "m2"]);
  });

  test("an empty rule previews a count of zero and refuses to run", async () => {
    const rig = await open();
    rig.seed(["m1"]);
    const mail = listed(["m1"]);
    const preview = previewOf(rig, mail, senderRule("nobody@example.org"));
    expect(preview.count).toBe(0);
    expect(await runOf(rig, mail, preview, "always")).toEqual({ kind: "refused", reason: { code: "mail.sweep_empty", message: "The rule matches no unread mail on this connection." } });
    expect(rig.calls).toEqual([]);
  });
});

describe("a sweep permission", () => {
  test("a one-message move grant does not cover a sweep, so the sweep asks for its own", async () => {
    const rig = await open();
    rig.seed(["m1", "m2"]);
    const press = await rig.moves.press({ action: "move", messageId: "m1", target: "archive", provenance: SWEEP_PROVENANCE, choice: "always" });
    expect(press.kind).toBe("receipt");
    expect(rig.calls).toHaveLength(1);
    const outcome = await runOf(rig, listed(["m1", "m2"]));
    if (outcome.kind !== "needs-grant") throw new Error(`Expected a grant prompt, got ${outcome.kind}.`);
    expect(outcome.prompt).toMatchObject({ target: "archive", rule: senderRule(), count: 2, capabilities: ["mail.move", "mail.restore"] });
    expect(outcome.prompt.question).toContain("2 mails from boss@example.org");
    expect(rig.calls).toHaveLength(1);
    expect(rig.grants.list()).toEqual([]);
  });

  test("names the action and the rule, runs the set under one permission per message, and reads back", async () => {
    const rig = await open();
    rig.seed(["m1", "m2"]);
    const receipt = await sweptOf(rig, listed(["m1", "m2"]));
    expect(receipt).toMatchObject({ count: 2, summary: "succeeded", restored: 0, conflicts: 0, undone: false, message: "Archived 2 mails from boss@example.org." });
    expect(receipt.items.map(item => [item.messageId, item.state, item.undo.kind])).toEqual([["m1", "done", "available"], ["m2", "done", "available"]]);
    expect([rig.folders.get("m1"), rig.folders.get("m2")]).toEqual(["Archive", "Archive"]);
    expect(rig.authorityGrants.map(grant => grant.capabilities)).toEqual([["mail.move", "mail.restore"], ["mail.move", "mail.restore"]]);
    expect(rig.authorityGrants.map(grant => grant.selection?.target.canonicalId)).toEqual(["m1", "m2"]);
    expect(rig.grants.list()).toMatchObject([{ target: "archive", rule: senderRule(), status: "active" }]);
    expect(rig.calls.map(call => call.snapshot.capabilityId)).toEqual(["mail.move", "mail.move"]);
    expect(await rig.host.receipt(receipt.sweepId)).toEqual(receipt);
    expect(await rig.host.receipts()).toEqual([receipt]);
  });

  test("a sweep permission never answers a single move's standing grant lookup", async () => {
    const rig = await open();
    rig.seed(["m1", "m2", "m3"]);
    await sweptOf(rig, listed(["m1", "m2"]));
    expect(await rig.authority.findGrant("mail.move")).toBeNull();
    expect(await rig.authority.findGrant("mail.restore")).toBeNull();
    const press = await rig.moves.press({ action: "move", messageId: "m3", target: "archive", provenance: SWEEP_PROVENANCE });
    expect(press.kind).toBe("needs-grant");
    expect(rig.folders.get("m3")).toBe("INBOX");
    expect(rig.calls.map(call => (call.snapshot.input as { message: { canonicalId: string } }).message.canonicalId)).toEqual(["m1", "m2"]);
  });

  test("a permission for one selection rule asks again for another rule", async () => {
    const rig = await open();
    rig.seed(["m1", "m2"]);
    const mail = listed(["m1", "m2"]);
    await sweptOf(rig, mail);
    expect(rig.grants.list()).toHaveLength(1);
    const outcome = await runOf(rig, mail, previewOf(rig, mail, ageRule(7)));
    if (outcome.kind !== "needs-grant") throw new Error(`Expected a grant prompt, got ${outcome.kind}.`);
    expect(outcome.prompt.rule).toEqual(ageRule(7));
    expect(outcome.prompt.question).toContain("older than 7 days");
    expect(rig.grants.list()).toHaveLength(1);
    expect(rig.folders.get("m1")).toBe("Archive");
  });

  test("Just this once runs the set on confirmations and leaves no standing permission", async () => {
    const rig = await open();
    rig.seed(["m1", "m2", "m3"]);
    const receipt = receiptOf(await runOf(rig, listed(["m1", "m2"]), undefined, "once"));
    expect(receipt.items.map(item => item.state)).toEqual(["done", "done"]);
    expect(rig.grants.list()).toEqual([]);
    expect((await runOf(rig, listed(["m3"]))).kind).toBe("needs-grant");
  });

  test("a Trash sweep runs the trash verb and its receipt names Trash", async () => {
    const rig = await open();
    rig.seed(["t1"]);
    const receipt = await sweptOf(rig, listed(["t1"]), "trash");
    expect(receipt.message).toBe("Moved 1 mail to Trash from boss@example.org.");
    expect(rig.authorityGrants.map(grant => grant.capabilities)).toEqual([["mail.trash", "mail.restore"]]);
    expect(rig.calls.map(call => call.snapshot.capabilityId)).toEqual(["mail.trash"]);
    expect(rig.folders.get("t1")).toBe("Trash");
  });
});

describe("a sweep whose set changed since its preview", () => {
  test("refuses and shows the refreshed preview instead of running", async () => {
    const rig = await open();
    rig.seed(["m1", "m2", "m3"]);
    const preview = previewOf(rig, listed(["m1", "m2"]));
    const grown = await runOf(rig, listed(["m1", "m2", "m3"]), preview, "always");
    if (grown.kind !== "stale") throw new Error(`Expected a stale sweep, got ${grown.kind}.`);
    expect(grown.preview).toMatchObject({ count: 3, rule: senderRule() });
    expect(rig.calls).toEqual([]);
    expect(rig.grants.list()).toEqual([]);
    expect(await runOf(rig, listed(["m1"]), preview, "always")).toMatchObject({ kind: "stale", preview: { count: 1 } });
    expect(rig.calls).toEqual([]);
  });

  test("refuses a preview that names another rule than its own digest", async () => {
    const rig = await open();
    const mail = listed(["m1"]);
    const preview = { ...previewOf(rig, mail), rule: senderRule("someone@example.net") };
    expect(await runOf(rig, mail, preview, "always")).toMatchObject({ kind: "unavailable", reason: { code: "mail.invalid_request" } });
    expect(rig.calls).toEqual([]);
  });
});

describe("Undo of a sweep", () => {
  test("restores every message it can and reports each message that moved since as a conflict", async () => {
    const rig = await open();
    rig.seed(["m1", "m2", "m3"]);
    const receipt = await sweptOf(rig, listed(["m1", "m2", "m3"]));
    rig.folders.set("m2", "Junk");
    const undone = await undoneOf(rig, receipt.sweepId);
    expect(undone).toMatchObject({ restored: 2, conflicts: 1, undone: false, count: 3 });
    expect(undone.items.map(item => [item.messageId, item.undone, item.conflict])).toEqual([["m1", true, false], ["m2", false, true], ["m3", true, false]]);
    expect([rig.folders.get("m1"), rig.folders.get("m2"), rig.folders.get("m3")]).toEqual(["INBOX", "Junk", "INBOX"]);
    expect(undone.items[1]?.message).toContain("Junk");
    expect(undone.message).toContain("Moved 2 of 3 back to INBOX");
    expect(undone.message).toContain("Undo again to retry");
    expect((await rig.host.receipt(receipt.sweepId))?.conflicts).toBe(1);
  });

  test("retries the conflict once the mail is back, then closes the sweep", async () => {
    const rig = await open();
    rig.seed(["m1", "m2"]);
    const receipt = await sweptOf(rig, listed(["m1", "m2"]));
    rig.folders.set("m2", "Junk");
    await rig.host.undo(receipt.sweepId, SWEEP_PROVENANCE);
    rig.folders.set("m2", "Archive");
    const retried = await undoneOf(rig, receipt.sweepId);
    expect(retried).toMatchObject({ restored: 2, conflicts: 0, undone: true });
    expect(rig.folders.get("m2")).toBe("INBOX");
    expect(await rig.host.undo(receipt.sweepId, SWEEP_PROVENANCE)).toMatchObject({ kind: "unavailable", reason: { code: "mail.undo_unavailable" } });
  });

  test("stays open while a move is unresolved, then restores that message when it settles", async () => {
    const rig = await open();
    rig.seed(["m1", "m2"]);
    rig.hold(["m2"]);
    const receipt = await sweptOf(rig, listed(["m1", "m2"]));
    expect(receipt.items.map(item => [item.messageId, item.state])).toEqual([["m1", "done"], ["m2", "pending"]]);
    const first = await undoneOf(rig, receipt.sweepId);
    expect(first).toMatchObject({ restored: 1, undone: false });
    expect(first.message).toContain("the move did not finish");
    expect(rig.folders.get("m1")).toBe("INBOX");
    await rig.settle("m2");
    expect(rig.folders.get("m2")).toBe("Archive");
    const retried = await undoneOf(rig, receipt.sweepId);
    expect(retried).toMatchObject({ restored: 2, conflicts: 0, undone: true });
    expect(rig.folders.get("m2")).toBe("INBOX");
  });

  test("an unknown sweep has no Undo", async () => {
    const rig = await open();
    expect(await rig.host.undo("2f1f4d5e-7a4b-4c6d-8e9f-0123456789ab", SWEEP_PROVENANCE)).toMatchObject({ kind: "unavailable", reason: { code: "mail.sweep_unknown" } });
  });
});

describe("a sweep with a message the provider no longer has", () => {
  test("reports the missing message per item and still moves the rest", async () => {
    const rig = await open();
    rig.seed(["m1", "m2"]);
    const receipt = await sweptOf(rig, listed(["m1", "m2", "gone"]));
    expect(receipt.summary).toBe("partial");
    expect(receipt.items.map(item => [item.messageId, item.state])).toEqual([["gone", "missing"], ["m1", "done"], ["m2", "done"]]);
    expect(receipt.message).toContain("Archived 2 of 3");
    expect(receipt.message).toContain("Subject gone");
    expect(rig.folders.get("m1")).toBe("Archive");
    expect(rig.folders.get("gone")).toBeUndefined();
  });
});
