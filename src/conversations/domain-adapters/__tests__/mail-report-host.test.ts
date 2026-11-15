import { afterEach, describe, expect, test } from "bun:test";
import { openMailReportRig, reportReceipt, REPORT_BINDING } from "../mail/report-fixtures";
import { MAIL_REPORT_CAPABILITY } from "../mail/report-contract";
import { GRANT_OPTIONS } from "../mail/move-host";
import { REPORT_CANNOT_BE_RETRACTED, REPORT_STANDS } from "../mail/report-host";

const rigs: Awaited<ReturnType<typeof openMailReportRig>>[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
const open = async (options?: Parameters<typeof openMailReportRig>[0]) => { const rig = await openMailReportRig(options); rigs.push(rig); return rig; };

describe("Mail report host: Report as draft", () => {
  test("asks for no grant, runs on a confirmation and offers no Undo", async () => {
    const rig = await open();
    const receipt = reportReceipt(await rig.press("draft", "message-example"));
    expect(receipt).toMatchObject({ kind: "draft", state: "done", basis: "confirmation", folder: "Drafts", reportStands: false, undo: { kind: "unavailable", reason: "draft" } });
    expect(rig.grants).toHaveLength(0);
    expect(rig.approvals).toEqual([null]);
    expect(rig.drafts).toEqual(["message-example"]);
    expect(rig.submitted).toHaveLength(0);
  });

  test("a standing grant for a provider report never changes that a draft asks for none", async () => {
    const rig = await open();
    await rig.press("spam", "message-example", "always");
    const receipt = reportReceipt(await rig.press("draft", "message-example"));
    expect(receipt.basis).toBe("confirmation");
  });
});

describe("Mail report host: the provider grant prompt", () => {
  test("with no grant, warns Undo cannot retract the report and runs nothing", async () => {
    const rig = await open();
    const outcome = await rig.press("spam", "message-example");
    if (outcome.kind !== "needs-grant") throw new Error("Expected the grant prompt.");
    expect(outcome.prompt.question).toContain(REPORT_CANNOT_BE_RETRACTED);
    expect(outcome.prompt.question).toContain("cannot retract a report");
    expect(outcome.prompt.covers).toEqual([MAIL_REPORT_CAPABILITY.spam]);
    expect(outcome.prompt.options).toEqual(GRANT_OPTIONS);
    expect(outcome.prompt.connectionId).toBe(REPORT_BINDING.connectionId);
    expect(rig.calls).toHaveLength(0);
    expect(rig.grants).toHaveLength(0);
    expect(rig.submitted).toHaveLength(0);
  });

  test("Cancel runs nothing", async () => {
    const rig = await open();
    expect(await rig.press("phishing", "message-example", "cancel")).toEqual({ kind: "cancelled" });
    expect(rig.calls).toHaveLength(0);
  });

  test("a grant names one report type, so the other type asks again", async () => {
    const rig = await open();
    const spam = reportReceipt(await rig.press("spam", "message-example", "always"));
    expect(rig.grants).toEqual([{ id: expect.any(String), capabilities: [MAIL_REPORT_CAPABILITY.spam] }]);
    expect(spam).toMatchObject({ state: "done", basis: "grant", folder: "Junk", reportStands: true });
    expect(spam.message).toContain(REPORT_CANNOT_BE_RETRACTED);
    expect((await rig.press("phishing", "message-example")).kind).toBe("needs-grant");
    expect(reportReceipt(await rig.press("spam", "message-example")).basis).toBe("grant");
  });

  test("Just this once reports on a confirmation and leaves no grant", async () => {
    const rig = await open();
    expect(reportReceipt(await rig.press("phishing", "message-example", "once"))).toMatchObject({ state: "done", basis: "confirmation", kind: "phishing" });
    expect(rig.grants).toHaveLength(0);
    expect(rig.submitted).toEqual([{ messageId: "message-example", kind: "phishing" }]);
    expect((await rig.press("phishing", "message-example")).kind).toBe("needs-grant");
  });

  test("a grant for moving mail never stands in for a report", async () => {
    const rig = await open();
    rig.grants.push({ id: "grant-move", capabilities: ["mail.move", "mail.trash", "mail.restore"] });
    expect((await rig.press("spam", "message-example")).kind).toBe("needs-grant");
  });
});

describe("Mail report host: Undo", () => {
  test("moves the mail back and the receipt says the report stands", async () => {
    const rig = await open();
    const reported = reportReceipt(await rig.press("spam", "message-example", "always"));
    expect(reported.undo).toEqual({ kind: "available" });
    const undone = await rig.undo(reported.operationId);
    if (undone.kind !== "undo") throw new Error("Expected an Undo outcome.");
    expect(undone.state).toBe("done");
    expect(undone.message).toContain(REPORT_STANDS);
    expect(undone.receipt).toMatchObject({ undone: true, reportStands: true, undo: { kind: "unavailable", reason: "undone" } });
    expect(undone.receipt.message).toContain(REPORT_STANDS);
    expect(rig.folders.get("message-example")).toBe("INBOX");
    expect(rig.submitted).toHaveLength(1);
    expect((await rig.undo(reported.operationId)).kind).toBe("unavailable");
  });

  test("a mail that moved since is a conflict: nothing moves and the report still stands", async () => {
    const rig = await open();
    const reported = reportReceipt(await rig.press("phishing", "message-example", "once"));
    rig.moveElsewhere("message-example", "Archive");
    const undone = await rig.undo(reported.operationId);
    if (undone.kind !== "undo") throw new Error("Expected an Undo outcome.");
    expect(undone.state).toBe("conflict");
    expect(rig.folders.get("message-example")).toBe("Archive");
    expect(undone.receipt.undone).toBe(false);
  });

  test("is unavailable after the window", async () => {
    const rig = await open();
    const reported = reportReceipt(await rig.press("spam", "message-example", "always"));
    rig.advance(8 * 24 * 3600 * 1000);
    expect(await rig.undo(reported.operationId)).toMatchObject({ kind: "unavailable" });
    expect(rig.folders.get("message-example")).toBe("Junk");
  });
});

describe("Mail report host: refused attempts", () => {
  test("a missing message writes a receipt and is not retried", async () => {
    const rig = await open();
    rig.removeMessage("message-example");
    const receipt = reportReceipt(await rig.press("spam", "message-example", "always"));
    expect(receipt).toMatchObject({ state: "missing", reportStands: false, undo: { kind: "unavailable", reason: "not-done" } });
    expect(receipt.message).toBe("The message no longer exists.");
    expect(rig.submitted).toHaveLength(0);
    expect((await rig.host.receipt(receipt.operationId))?.state).toBe("missing");
    expect(rig.calls.map(call => call.operationId)).toEqual([receipt.operationId]);
  });

  test("a denied account writes a receipt", async () => {
    const rig = await open();
    const receipt = reportReceipt(await rig.pressAs("account-other", "phishing", "message-example", "always"));
    expect(receipt).toMatchObject({ state: "denied", account: "account-other", reportStands: false });
    expect(receipt.message).toBe("This account is not available to the connection.");
    expect(rig.submitted).toHaveLength(0);
  });

  test("a draft for a missing message also writes a receipt", async () => {
    const rig = await open();
    rig.removeMessage("message-example");
    expect(reportReceipt(await rig.press("draft", "message-example"))).toMatchObject({ state: "missing", kind: "draft" });
  });

  test("a revoked authority denies before any effect", async () => {
    const rig = await open();
    rig.deny();
    expect(await rig.press("spam", "message-example", "once")).toMatchObject({ kind: "denied", reason: { code: "authority_denied" } });
    expect(rig.calls).toHaveLength(0);
  });
});

describe("Mail report host: availability and readback", () => {
  test("a provider report is unavailable when its kind is undeclared", async () => {
    const rig = await open({ kinds: ["draft"] });
    expect(rig.host.available("spam")).toBe(false);
    expect(await rig.press("spam", "message-example", "always")).toMatchObject({ kind: "unavailable", reason: { code: "mail.capability_unavailable" } });
    expect(rig.calls).toHaveLength(0);
    expect(rig.host.available("draft")).toBe(true);
  });

  test("reads receipts after the journal reopens and only for this account", async () => {
    const rig = await open();
    const mine = reportReceipt(await rig.press("spam", "message-example", "always"));
    const other = reportReceipt(await rig.pressAs("account-other", "spam", "message-example", "always"));
    await rig.undo(mine.operationId);
    await rig.reopen();
    expect(await rig.host.receipt(mine.operationId)).toMatchObject({ state: "done", undone: true });
    expect(await rig.host.receipt(other.operationId)).toBeNull();
    expect((await rig.host.receipts()).map(receipt => receipt.operationId)).toEqual([mine.operationId]);
  });
});
