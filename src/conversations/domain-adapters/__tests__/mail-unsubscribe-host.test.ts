import { afterEach, describe, expect, test } from "bun:test";
import { openMailUnsubscribeRig, unsubscribeReceipt, UNSUBSCRIBE_BINDING, UNSUBSCRIBE_PROVENANCE, unsubscribeMessage } from "../mail/unsubscribe-fixtures";
import { MAIL_UNSUBSCRIBE_CAPABILITY } from "../mail/unsubscribe-contract";
import { GRANT_OPTIONS } from "../mail/move-host";
import { NO_UNDO, UNSUBSCRIBE_QUESTION } from "../mail/unsubscribe-host";

const rigs: Awaited<ReturnType<typeof openMailUnsubscribeRig>>[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
const open = async (options?: { declaresUnsubscribe?: boolean }) => { const rig = await openMailUnsubscribeRig(options); rigs.push(rig); return rig; };
function expectNothingRan(rig: Awaited<ReturnType<typeof open>>): void {
  expect(rig.calls).toHaveLength(0);
  expect(rig.grants).toHaveLength(0);
  expect(rig.ids).toHaveLength(0);
  expect(rig.posts).toHaveLength(0);
}

describe("Mail unsubscribe host: the grant prompt", () => {
  test("with no grant, Unsubscribe asks beside the button, warns the change may not be reversible, and runs nothing", async () => {
    const rig = await open();
    const outcome = await rig.press("message-example");
    if (outcome.kind !== "needs-grant") throw new Error("Expected the grant prompt.");
    expect(outcome.prompt.question).toBe(UNSUBSCRIBE_QUESTION);
    expect(outcome.prompt.question).toContain("may not be reversible");
    expect(outcome.prompt.covers).toEqual([MAIL_UNSUBSCRIBE_CAPABILITY]);
    expect(outcome.prompt.options).toEqual(GRANT_OPTIONS);
    expect(outcome.prompt.connectionId).toBe(UNSUBSCRIBE_BINDING.connectionId);
    expectNothingRan(rig);
  });

  test("Cancel runs nothing and writes nothing", async () => {
    const rig = await open();
    expect(await rig.press("message-example", "cancel")).toEqual({ kind: "cancelled" });
    expectNothingRan(rig);
  });

  test("Just this once runs one unsubscribe on a confirmation and leaves no grant, so the next press asks again", async () => {
    const rig = await open();
    const receipt = unsubscribeReceipt(await rig.press("message-example", "once"));
    expect(receipt).toMatchObject({ state: "done", basis: "confirmation", account: UNSUBSCRIBE_BINDING.account, host: "list.example.org" });
    expect(rig.grants).toHaveLength(0);
    expect(rig.approvals).toEqual([null]);
    expect((await rig.press("message-example")).kind).toBe("needs-grant");
  });
});

describe("Mail unsubscribe host: a one-click grant", () => {
  test("names only the unsubscribe capability on the connection and the receipt says there is no Undo", async () => {
    const rig = await open();
    const first = unsubscribeReceipt(await rig.press("message-example", "always"));
    expect(rig.grants).toEqual([{ id: expect.any(String), capabilities: [MAIL_UNSUBSCRIBE_CAPABILITY] }]);
    expect(first).toMatchObject({ state: "done", basis: "grant", messageId: "message-example", host: "list.example.org", undo: false });
    expect(first.message).toContain(NO_UNDO);
    expect(first.message).toContain("list.example.org");
    expect(rig.approvals).toEqual([rig.grants[0]!.id]);
    expect(rig.posts).toEqual(["list.example.org"]);
    const second = unsubscribeReceipt(await rig.press("message-example"));
    expect(second).toMatchObject({ state: "done", basis: "grant", undo: false });
    expect(rig.approvals).toEqual([rig.grants[0]!.id, rig.grants[0]!.id]);
    expect(await rig.host.receipts()).toHaveLength(2);
  });

  test("a grant for another Mail action never stands in for unsubscribe", async () => {
    const rig = await open();
    rig.grants.push({ id: "grant-move", capabilities: ["mail.move", "mail.trash", "mail.restore"] });
    expect((await rig.press("message-example")).kind).toBe("needs-grant");
    expect(rig.calls).toHaveLength(0);
  });

  test("a revoked authority denies before any effect and writes no receipt", async () => {
    const rig = await open();
    rig.deny();
    expect(await rig.press("message-example", "once")).toMatchObject({ kind: "denied", reason: { code: "authority_denied" } });
    expectNothingRan(rig);
  });
});

describe("Mail unsubscribe host: refused attempts", () => {
  test("a missing message writes a receipt with no Undo and is not retried", async () => {
    const rig = await open();
    rig.removeMessage("message-example");
    const receipt = unsubscribeReceipt(await rig.press("message-example", "always"));
    expect(receipt).toMatchObject({ state: "missing", undo: false, messageId: "message-example" });
    expect(receipt.message).toBe("The message no longer exists.");
    expect(rig.posts).toHaveLength(0);
    expect(rig.calls).toHaveLength(1);
    expect((await rig.host.receipt(receipt.operationId))?.state).toBe("missing");
    expect(rig.calls).toHaveLength(1);
  });

  test("a denied account writes a receipt with no Undo and is not retried", async () => {
    const rig = await open();
    const receipt = unsubscribeReceipt(await rig.pressAs("account-other", "message-example", "always"));
    expect(receipt).toMatchObject({ state: "denied", undo: false, account: "account-other" });
    expect(receipt.message).toBe("This account is not available to the connection.");
    expect(rig.posts).toHaveLength(0);
    expect(rig.calls).toHaveLength(1);
    expect(await rig.host.receipt(receipt.operationId)).toBeNull();
    expect(rig.calls).toHaveLength(1);
  });
});

describe("Mail unsubscribe host: an unavailable capability", () => {
  test("a connection that declares no unsubscribe action is unavailable and runs nothing", async () => {
    const rig = await open({ declaresUnsubscribe: false });
    expect(rig.host.available()).toBe(false);
    expect(await rig.press("message-example", "always")).toMatchObject({ kind: "unavailable", reason: { code: "mail.capability_unavailable" } });
    expectNothingRan(rig);
  });

  test("a message from another connection is refused before any grant is asked", async () => {
    const rig = await open();
    const foreign = { message: { ...unsubscribeMessage(), connectionId: "other-connection" } };
    expect(await rig.host.press(foreign, UNSUBSCRIBE_PROVENANCE, "always")).toMatchObject({ kind: "unavailable", reason: { code: "mail.invalid_request" } });
    expect(rig.grants).toHaveLength(0);
    expect(rig.calls).toHaveLength(0);
  });
});

describe("Mail unsubscribe host: receipt readback", () => {
  test("reads the receipt after the journal reopens and lists only this connection's attempts", async () => {
    const rig = await open();
    const mine = unsubscribeReceipt(await rig.press("message-example", "always"));
    const other = unsubscribeReceipt(await rig.pressAs("account-other", "message-example", "always"));
    await rig.reopen();
    expect(await rig.host.receipt(mine.operationId)).toMatchObject({ state: "done", host: "list.example.org", undo: false });
    expect(await rig.host.receipt(other.operationId)).toBeNull();
    expect((await rig.host.receipts()).map(receipt => receipt.operationId)).toEqual([mine.operationId]);
  });
});
