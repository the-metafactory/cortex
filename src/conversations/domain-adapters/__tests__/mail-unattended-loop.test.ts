import { afterEach, describe, expect, test } from "bun:test";
import { dmarcMail, loopMail, openMailLoopRig, LOOP_PROVENANCE, type MailLoopRig } from "../mail/loop-fixtures";
import type { DmarcLoopWork, RuleLoopWork } from "../mail/loop-host";
import type { MailLoopSelection } from "../mail/loop-contract";

const RULE = { id: "rule-reports", match: "sender" as const, value: "reports@example.org", target: "archive" as const };
const DIGEST = { id: "rule-digest", match: "subject" as const, value: "report domain:", target: "digest" as const };
const ruleSelection = (value = RULE.value): MailLoopSelection => ({ kind: "rule", ruleId: RULE.id, match: RULE.match, value });
const dmarcSelection = (ruleIds = [DIGEST.id]): MailLoopSelection => ({ kind: "dmarc", ruleIds });

const ruleWork = (mail: RuleLoopWork["mail"]): RuleLoopWork => ({ rule: RULE, mail });
const dmarcWork = (mail: DmarcLoopWork["mail"]): DmarcLoopWork => ({ target: "archive", mail });

const rigs: MailLoopRig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
async function open(): Promise<MailLoopRig> {
  const rig = await openMailLoopRig();
  rigs.push(rig);
  return rig;
}

describe("a Mail rule pass without a standing grant", () => {
  test("proposes each match and moves nothing", async () => {
    const rig = await open();
    rig.seed(["m1", "m2"]);
    const pass = await rig.loop.runRules(ruleWork([loopMail("m1"), loopMail("m2")]), LOOP_PROVENANCE);
    expect(pass).toMatchObject({ loop: "rule", paused: false, acted: 0, receipts: [], failures: [] });
    expect(pass.proposals.map(proposal => [proposal.messageId, proposal.reason])).toEqual([["m1", "no-grant"], ["m2", "no-grant"]]);
    expect(rig.calls).toHaveLength(0);
    expect(rig.folders.get("m1")).toBe("INBOX");
    expect(await rig.loop.receipts()).toEqual([]);
    expect(rig.loop.activeGrant("rule")).toBeNull();
  });

  test("a DMARC pass proposes each held report and files nothing", async () => {
    const rig = await open();
    rig.seed(["d1"]);
    const pass = await rig.loop.runDmarc(dmarcWork([dmarcMail("d1", DIGEST.id)]), LOOP_PROVENANCE);
    expect(pass.acted).toBe(0);
    expect(pass.proposals).toMatchObject([{ messageId: "d1", reason: "no-grant", target: "archive" }]);
    expect(rig.calls).toHaveLength(0);
    expect(rig.folders.get("d1")).toBe("INBOX");
  });
});

describe("a Mail rule pass under a standing grant", () => {
  test("names the action and the mail, runs each match as its move verb, and writes a receipt with Undo", async () => {
    const rig = await open();
    rig.seed(["m1", "m2"]);
    const grant = await rig.grant("rule", ["move"], ruleSelection());
    expect(grant).toMatchObject({ loop: "rule", actions: ["move"], selection: ruleSelection(), status: "active" });
    expect(rig.authorityGrants).toHaveLength(1);
    expect(rig.authorityGrants[0]?.capabilities).toEqual(["mail.move", "mail.restore"]);

    const pass = await rig.loop.runRules(ruleWork([loopMail("m1"), loopMail("m2")]), LOOP_PROVENANCE);
    expect(pass.acted).toBe(2);
    expect(pass.proposals).toEqual([]);
    expect(pass.receipts.map(receipt => receipt.state)).toEqual(["done", "done"]);
    for (const receipt of pass.receipts) expect(receipt).toMatchObject({ basis: "grant", action: "move", target: "archive", folder: "Archive", undone: false, undo: { kind: "available" } });
    expect(rig.calls.map(call => call.snapshot.capabilityId)).toEqual(["mail.move", "mail.move"]);
    expect(rig.folders.get("m1")).toBe("Archive");

    const undone = await rig.loop.undo(pass.receipts[0]!.operationId, LOOP_PROVENANCE);
    if (undone.kind !== "receipt") throw new Error("Expected an Undo receipt.");
    expect(undone.receipt).toMatchObject({ action: "restore", state: "done", compensates: pass.receipts[0]!.operationId });
    expect(rig.folders.get("m1")).toBe("INBOX");
  });

  test("a Delete rule runs the trash verb under a grant that names Trash", async () => {
    const rig = await open();
    rig.seed(["t1"]);
    const trash = { ...RULE, target: "trash" as const };
    await rig.grant("rule", ["trash"], ruleSelection());
    const pass = await rig.loop.runRules({ rule: trash, mail: [loopMail("t1")] }, LOOP_PROVENANCE);
    expect(pass.acted).toBe(1);
    expect(pass.receipts[0]).toMatchObject({ action: "trash", target: "trash", folder: "Trash", basis: "grant" });
    expect(rig.folders.get("t1")).toBe("Trash");
  });

  test("a grant that names only Archive proposes a Delete instead of running it", async () => {
    const rig = await open();
    rig.seed(["t1"]);
    await rig.grant("rule", ["move"], ruleSelection());
    const pass = await rig.loop.runRules({ rule: { ...RULE, target: "trash" }, mail: [loopMail("t1")] }, LOOP_PROVENANCE);
    expect(pass.acted).toBe(0);
    expect(pass.proposals).toMatchObject([{ messageId: "t1", reason: "outside-selection" }]);
    expect(rig.folders.get("t1")).toBe("INBOX");
  });

  test("a mail outside the named selection is not touched", async () => {
    const rig = await open();
    rig.seed(["m1"]);
    await rig.grant("rule", ["move"], ruleSelection("someone@elsewhere.example"));
    const pass = await rig.loop.runRules(ruleWork([loopMail("m1")]), LOOP_PROVENANCE);
    expect(pass.acted).toBe(0);
    expect(pass.proposals).toMatchObject([{ messageId: "m1", reason: "outside-selection" }]);
    expect(rig.folders.get("m1")).toBe("INBOX");
  });

  test("a grant for another rule does not run this rule's mail", async () => {
    const rig = await open();
    rig.seed(["m1"]);
    await rig.grant("rule", ["move"], { kind: "rule", ruleId: "rule-other", match: RULE.match, value: RULE.value });
    const pass = await rig.loop.runRules(ruleWork([loopMail("m1")]), LOOP_PROVENANCE);
    expect(pass.acted).toBe(0);
    expect(pass.proposals[0]?.reason).toBe("outside-selection");
  });

  test("a mail for another account is not touched", async () => {
    const rig = await open();
    rig.seed(["m1"]);
    await rig.grant("rule", ["move"], ruleSelection());
    const pass = await rig.loop.runRules(ruleWork([loopMail("m1", { account: "account-other" })]), LOOP_PROVENANCE);
    expect(pass.acted).toBe(0);
    expect(pass.proposals[0]?.reason).toBe("outside-selection");
    expect(rig.calls).toHaveLength(0);
  });
});

describe("a DMARC pass under a standing grant", () => {
  test("files each report the named digest rule held, and leaves a report it did not hold", async () => {
    const rig = await open();
    rig.seed(["d1", "d2"]);
    await rig.grant("dmarc", ["move"], dmarcSelection());
    const pass = await rig.loop.runDmarc(dmarcWork([dmarcMail("d1", DIGEST.id), dmarcMail("d2", "rule-other")]), LOOP_PROVENANCE);
    expect(pass.acted).toBe(1);
    expect(pass.receipts[0]).toMatchObject({ messageId: "d1", folder: "Archive", basis: "grant", undo: { kind: "available" } });
    expect(pass.proposals).toMatchObject([{ messageId: "d2", reason: "outside-selection" }]);
    expect(rig.folders.get("d2")).toBe("INBOX");
  });

  test("a mail that is not a report is outside even when the named rule held it", async () => {
    const rig = await open();
    rig.seed(["n1"]);
    await rig.grant("dmarc", ["move"], dmarcSelection());
    const pass = await rig.loop.runDmarc(dmarcWork([loopMail("n1", { heldBy: DIGEST.id })]), LOOP_PROVENANCE);
    expect(pass.acted).toBe(0);
    expect(pass.proposals[0]?.reason).toBe("outside-selection");
  });

  test("a Delete grant files by the trash verb and reports Trash", async () => {
    const rig = await open();
    rig.seed(["d1"]);
    await rig.grant("dmarc", ["trash"], dmarcSelection());
    const pass = await rig.loop.runDmarc({ target: "trash", mail: [dmarcMail("d1", DIGEST.id)] }, LOOP_PROVENANCE);
    expect(pass.acted).toBe(1);
    expect(pass.receipts[0]).toMatchObject({ action: "trash", folder: "Trash" });
    expect(rig.folders.get("d1")).toBe("Trash");
  });
});

describe("pausing one loop", () => {
  test("a paused loop neither acts nor proposes until resumed", async () => {
    const rig = await open();
    rig.seed(["m1"]);
    await rig.grant("rule", ["move"], ruleSelection());
    rig.pause("rule");
    const paused = await rig.loop.runRules(ruleWork([loopMail("m1")]), LOOP_PROVENANCE);
    expect(paused).toEqual({ loop: "rule", paused: true, acted: 0, proposals: [], receipts: [], failures: [] });
    expect(rig.calls).toHaveLength(0);
    expect(rig.folders.get("m1")).toBe("INBOX");
    rig.resume("rule");
    const resumed = await rig.loop.runRules(ruleWork([loopMail("m1")]), LOOP_PROVENANCE);
    expect(resumed.acted).toBe(1);
  });

  test("pausing the rule loop leaves the DMARC loop running", async () => {
    const rig = await open();
    rig.seed(["m1", "d1"]);
    await rig.grant("rule", ["move"], ruleSelection());
    await rig.grant("dmarc", ["move"], dmarcSelection());
    rig.pause("rule");
    expect((await rig.loop.runRules(ruleWork([loopMail("m1")]), LOOP_PROVENANCE)).paused).toBe(true);
    expect((await rig.loop.runDmarc(dmarcWork([dmarcMail("d1", DIGEST.id)]), LOOP_PROVENANCE)).acted).toBe(1);
  });
});

describe("revoking the standing grant", () => {
  test("after revocation the next pass only proposes", async () => {
    const rig = await open();
    rig.seed(["m1", "m2"]);
    const grant = await rig.grant("rule", ["move"], ruleSelection());
    expect((await rig.loop.runRules(ruleWork([loopMail("m1")]), LOOP_PROVENANCE)).acted).toBe(1);
    expect(rig.revoke(grant.grantId)).toBe(true);
    expect(rig.loop.activeGrant("rule")).toBeNull();
    const pass = await rig.loop.runRules(ruleWork([loopMail("m2")]), LOOP_PROVENANCE);
    expect(pass.acted).toBe(0);
    expect(pass.proposals).toMatchObject([{ messageId: "m2", reason: "no-grant" }]);
    expect(rig.folders.get("m2")).toBe("INBOX");
  });

  test("a second grant replaces the first on the same connection and loop", async () => {
    const rig = await open();
    const first = await rig.grant("rule", ["move"], ruleSelection("first@example.org"));
    const second = await rig.grant("rule", ["move"], ruleSelection("second@example.org"));
    expect(second.grantId).not.toBe(first.grantId);
    expect(rig.loop.activeGrant("rule")?.grantId).toBe(second.grantId);
    expect(rig.loop.activeGrant("rule")?.selection).toMatchObject({ value: "second@example.org" });
  });
});

describe("the standing grant and the pause survive a real store reopen", () => {
  test("the grant, its receipts and the pause are still recorded after reopening", async () => {
    const rig = await open();
    rig.seed(["m1"]);
    const grant = await rig.grant("rule", ["move"], ruleSelection());
    const pass = await rig.loop.runRules(ruleWork([loopMail("m1")]), LOOP_PROVENANCE);
    const operationId = pass.receipts[0]!.operationId;
    rig.pause("rule");
    await rig.reopen();
    expect(rig.loop.activeGrant("rule")?.grantId).toBe(grant.grantId);
    expect(rig.loop.paused("rule")).toBe(true);
    expect(await rig.receipt(operationId)).toMatchObject({ state: "done", basis: "grant", undo: { kind: "available" } });
    expect(rig.folders.get("m1")).toBe("Archive");
  });
});

describe("the host authority still gates every effect", () => {
  test("a denied approval proposes the change and moves nothing", async () => {
    const rig = await open();
    rig.seed(["m1"]);
    await rig.grant("rule", ["move"], ruleSelection());
    rig.deny(true);
    const pass = await rig.loop.runRules(ruleWork([loopMail("m1")]), LOOP_PROVENANCE);
    expect(pass.acted).toBe(0);
    expect(pass.proposals).toMatchObject([{ messageId: "m1", reason: "denied" }]);
    expect(rig.folders.get("m1")).toBe("INBOX");
  });
});
