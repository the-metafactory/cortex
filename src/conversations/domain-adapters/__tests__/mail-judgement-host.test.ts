import { afterEach, describe, expect, test } from "bun:test";
import { openMailJudgementRig, judgementMessage, judgementReceipt, JUDGEMENT_BINDING, JUDGEMENT_PROVENANCE } from "../mail/judgement-fixtures";
import { addSender, addVip, listSenders, removeSender } from "../../../surface/mc/desk/vips";
import { saveClassification, readClassifications } from "../../../surface/mc/desk/classify";
import { logMailDecision, mailFeatures, queryMailLog } from "../../../surface/mc/desk/mail-log";
import { readSnooze, snoozeMail } from "../../../surface/mc/desk/mail-snooze";
import { readWaiting } from "../../../surface/mc/desk/mail-waiting";
import { trustedViews } from "../../../surface/mc/desk/mail-trust";
import { UNDO_WINDOW_MS } from "../../../surface/mc/desk/mail-move";
import { mailJudgementSnapshot } from "../mail/judgement-contract";
import { snapshotDigest } from "../operations/validation";
import { withAdmittedCall } from "../package-backend";
import { AT } from "../operations/fixtures";

const rigs: Awaited<ReturnType<typeof openMailJudgementRig>>[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
const open = async () => { const rig = await openMailJudgementRig(); rigs.push(rig); return rig; };
const message = judgementMessage();
const unimportant = { action: "unimportant" as const, message };
const mark = async (rig: Awaited<ReturnType<typeof open>>, choice?: "always" | "once" | "cancel") => judgementReceipt(await rig.press(unimportant, choice));

describe("Mail judgement host authority and receipts", () => {
  test("first use asks, cancellation changes nothing, and a grant names only this action and Undo", async () => {
    const rig = await open();
    expect(await rig.press(unimportant)).toMatchObject({ kind: "needs-grant", prompt: { covers: ["mail.judgement.unimportant", "mail.judgement.undo"] } });
    expect(await rig.press(unimportant, "cancel")).toEqual({ kind: "cancelled" });
    expect(rig.calls).toHaveLength(0);
    expect(listSenders(rig.db, "unimportant")).toEqual([]);
    const receipt = await mark(rig, "always");
    expect(receipt).toMatchObject({ state: "done", basis: "grant", undo: true });
    expect(rig.approvals).toEqual([rig.grants[0]!.id]);
    expect((await rig.press({ action: "block-domain", message })).kind).toBe("needs-grant");
    removeSender(rig.db, "unimportant", "sender@example.org");
    expect(await mark(rig)).toMatchObject({ state: "done", basis: "grant", undo: true });
    expect(await rig.press(unimportant, "cancel")).toEqual({ kind: "cancelled" });
  });

  test("corrections without Undo require a card every time, including with a grant for move corrections", async () => {
    const rig = await open();
    judgementReceipt(await rig.press({ action: "correct", message, said: "archive" }, "always"));
    for (const said of ["matters", "not-bulk", "reply", "plan", "todo", "keep"] as const) {
      const input = { action: "correct" as const, message, said };
      const count = rig.calls.length;
      expect((await rig.press(input)).kind).toBe("needs-confirmation");
      expect((await rig.press(input, "always")).kind).toBe("needs-confirmation");
      expect(rig.calls).toHaveLength(count);
      expect(judgementReceipt(await rig.press(input, "once"))).toMatchObject({ state: "done", basis: "confirmation", undo: false });
      expect(rig.approvals.at(-1)).toBeNull();
      expect((await rig.press(input)).kind).toBe("needs-confirmation");
    }
  });

  test("revocation prevents writes and a foreign message cannot create a grant", async () => {
    const rig = await open();
    expect(await rig.press({ ...unimportant, message: { ...message, connectionId: "other" } }, "always")).toMatchObject({ kind: "unavailable" });
    expect(rig.grants).toHaveLength(0);
    rig.deny();
    expect(await rig.press(unimportant, "once")).toMatchObject({ kind: "denied" });
    expect(rig.calls).toHaveLength(0);
    expect(listSenders(rig.db, "unimportant")).toEqual([]);
  });
});

describe("Mail list ownership and exact Undo", () => {
  for (const action of ["unimportant", "block-domain"] as const) {
    test(`${action} Undo removes only the entry it inserted and survives reopen`, async () => {
      const rig = await open();
      addSender(rig.db, "unimportant", "other@example.net", "Keep", 1);
      saveClassification(rig.db, message.canonicalId, { category: "fyi", reason: "Example" }, "example-model", 1);
      const receipt = judgementReceipt(await rig.press({ action, message }, "always"));
      const entry = action === "unimportant" ? "sender@example.org" : "@example.org";
      expect(listSenders(rig.db, "unimportant").map(row => row.address)).toContain(entry);
      expect(queryMailLog(rig.db)).toHaveLength(1);
      logMailDecision(rig.db, mailFeatures(rig.db, rig.readings[0]!.mail[0]!), "kept", "desk", Date.parse(AT));
      const unrelatedLog = queryMailLog(rig.db).filter(row => row.action === "kept");
      await rig.reopen();
      const restored = judgementReceipt(await rig.host.undo(receipt.operationId, JUDGEMENT_PROVENANCE));
      expect(restored).toMatchObject({ state: "done", compensates: receipt.operationId, undo: false });
      expect(listSenders(rig.db, "unimportant").map(row => row.address)).toEqual(["other@example.net"]);
      expect(readClassifications(rig.db, [message.canonicalId]).get(message.canonicalId)?.category).toBe("fyi");
      expect(queryMailLog(rig.db)).toEqual(unrelatedLog);
      expect(rig.folders.get(message.canonicalId)).toBe("INBOX");
      expect(await rig.host.receipt(receipt.operationId)).toMatchObject({ undone: true, undo: false });
      expect((await rig.host.undo(receipt.operationId, JUDGEMENT_PROVENANCE)).kind).toBe("unavailable");
    });

    test(`${action} does not claim a pre-existing entry or remove a replacement`, async () => {
      const rig = await open();
      const address = action === "unimportant" ? "sender@example.org" : "@example.org";
      addSender(rig.db, "unimportant", address, "Existing", 1);
      expect(judgementReceipt(await rig.press({ action, message }, "once"))).toMatchObject({ undo: false });
      expect(listSenders(rig.db, "unimportant")[0]?.label).toBe("Existing");
      removeSender(rig.db, "unimportant", address);
      const created = judgementReceipt(await rig.press({ action, message }, "once"));
      removeSender(rig.db, "unimportant", address);
      addSender(rig.db, "unimportant", address, "Replacement", Date.parse(AT));
      expect(judgementReceipt(await rig.host.undo(created.operationId, JUDGEMENT_PROVENANCE))).toMatchObject({ state: "conflict" });
      expect(listSenders(rig.db, "unimportant")[0]?.label).toBe("Replacement");
    });
  }

  for (const [action, vip] of [["unimportant", "sender@example.org"], ["unimportant", "@example.org"], ["block-domain", "sender@example.org"], ["block-domain", "another@example.org"], ["block-domain", "@example.org"]] as const) {
    test(`${action} refuses VIP ${vip} before any judgement changes`, async () => {
      const rig = await open();
      addVip(rig.db, vip, "Example VIP", 1);
      const receipt = judgementReceipt(await rig.press({ action, message }, "always"));
      expect(receipt).toMatchObject({ state: "refused", undo: false });
      expect(listSenders(rig.db, "unimportant")).toEqual([]);
      expect(queryMailLog(rig.db)).toEqual([]);
      expect(rig.folders.get(message.canonicalId)).toBe("INBOX");
    });
  }
});

describe("Mail trust, snooze, waiting and corrections read back from the native store", () => {
  test("Not phishing uses the native trust scopes and Undo withdraws only its dismissal", async () => {
    const rig = await open();
    rig.readings[0]!.mail[0]!.headers = { replyTo: "other@elsewhere.example", authResults: { dmarc: "fail" } };
    const receipt = judgementReceipt(await rig.press({ action: "not-phishing", message }, "always"));
    expect(receipt).toMatchObject({ state: "done", undo: true });
    const trust = trustedViews(rig.db)[0]!;
    expect(trust.codes).toContain("reply-to");
    expect(trust.mails[0]?.codes).toContain("dmarc");
    expect(queryMailLog(rig.db).map(row => row.action)).toEqual(["not-phishing"]);
    await rig.reopen();
    expect(judgementReceipt(await rig.host.undo(receipt.operationId, JUDGEMENT_PROVENANCE)).state).toBe("done");
    expect(trustedViews(rig.db)).toEqual([]);
    expect(queryMailLog(rig.db)).toEqual([]);
  });

  test("snooze and cancellation each restore the previous native row, while a later edit conflicts", async () => {
    const rig = await open();
    const first = judgementReceipt(await rig.press({ action: "snooze", message, until: { kind: "later" } }, "always"));
    const original = readSnooze(rig.db, message.canonicalId);
    const changed = judgementReceipt(await rig.press({ action: "snooze", message, until: { kind: "tomorrow" } }));
    expect(readSnooze(rig.db, message.canonicalId)?.untilAt).not.toBe(original?.untilAt);
    expect(judgementReceipt(await rig.host.undo(changed.operationId, JUDGEMENT_PROVENANCE)).state).toBe("done");
    expect(readSnooze(rig.db, message.canonicalId)).toEqual(original);
    const cancelled = judgementReceipt(await rig.press({ action: "snooze-cancel", message }, "once"));
    expect(readSnooze(rig.db, message.canonicalId)).toBeNull();
    await rig.host.undo(cancelled.operationId, JUDGEMENT_PROVENANCE);
    expect(readSnooze(rig.db, message.canonicalId)).toEqual(original);
    rig.db.query("UPDATE desk_mail_snoozes SET label = 'Later edit' WHERE message_id = ?").run(message.canonicalId);
    expect(judgementReceipt(await rig.host.undo(first.operationId, JUDGEMENT_PROVENANCE)).state).toBe("conflict");
    expect(readSnooze(rig.db, message.canonicalId)?.label).toBe("Later edit");
  });

  for (const op of ["snooze", "done", "no-answer", "expect"] as const) {
    test(`waiting ${op} has a linked Undo of its native state and log`, async () => {
      const rig = await open();
      rig.recordSentWaiting();
      const before = readWaiting(rig.db, "sent-example");
      const receipt = judgementReceipt(await rig.press({ action: "waiting", message: judgementMessage("sent-example"), op }, "always"));
      expect(receipt).toMatchObject({ state: "done", undo: true });
      expect(readWaiting(rig.db, "sent-example")).not.toEqual(before);
      await rig.reopen();
      expect(judgementReceipt(await rig.host.undo(receipt.operationId, JUDGEMENT_PROVENANCE)).state).toBe("done");
      expect(readWaiting(rig.db, "sent-example")).toEqual(before);
      expect(queryMailLog(rig.db)).toEqual([]);
    });
  }

  for (const said of ["archive", "junk", "trash"] as const) {
    test(`Undo of a ${said} correction withdraws its exact log row after restore succeeds`, async () => {
      const rig = await open();
      const receipt = judgementReceipt(await rig.press({ action: "correct", message, said }, "always"));
      expect(queryMailLog(rig.db)).toMatchObject([{ action: said, where: "correction" }]);
      rig.folders.set(message.canonicalId, "Projects");
      expect(judgementReceipt(await rig.host.undo(receipt.operationId, JUDGEMENT_PROVENANCE)).state).toBe("conflict");
      expect(queryMailLog(rig.db)).toHaveLength(1);
      rig.folders.set(message.canonicalId, said === "archive" ? "Archive" : said === "junk" ? "Junk" : "Trash");
      await rig.reopen();
      expect(judgementReceipt(await rig.host.undo(receipt.operationId, JUDGEMENT_PROVENANCE))).toMatchObject({ state: "done", message: "Moved back. Your correction is withdrawn." });
      expect(queryMailLog(rig.db)).toEqual([]);
      expect(rig.folders.get(message.canonicalId)).toBe("INBOX");
    });
  }
});

describe("Mail judgement admission and replay", () => {
  test("a receipt write failure rolls back local state and replay recovers with Undo", async () => {
    const rig = await open();
    rig.db.run("CREATE TRIGGER fixture_receipt_failure BEFORE UPDATE OF result_json ON desk_mail_judgement_operations BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END");
    await expect(rig.press(unimportant, "once")).rejects.toThrow("receipt write failed");
    expect(listSenders(rig.db, "unimportant")).toEqual([]);
    expect(queryMailLog(rig.db)).toEqual([]);
    rig.db.run("DROP TRIGGER fixture_receipt_failure");
    await rig.reopen();
    expect((await rig.owner.dispatch(JUDGEMENT_BINDING, rig.calls[0]!)).result).toMatchObject({ kind: "succeeded", output: { undo: true } });
    expect(listSenders(rig.db, "unimportant")).toHaveLength(1);
  });

  test("a correction move and restore recover their historical result after local receipt failure", async () => {
    const rig = await open();
    rig.db.run("CREATE TRIGGER fixture_receipt_failure BEFORE UPDATE OF result_json ON desk_mail_judgement_operations BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END");
    await expect(rig.press({ action: "correct", message, said: "archive" }, "once")).rejects.toThrow("receipt write failed");
    expect(rig.folders.get(message.canonicalId)).toBe("Archive");
    expect(queryMailLog(rig.db)).toEqual([]);
    rig.db.run("DROP TRIGGER fixture_receipt_failure");
    rig.readings[0]!.mail = [];
    await rig.reopen();
    const moved = rig.calls[0]!;
    expect((await rig.owner.dispatch(JUDGEMENT_BINDING, moved)).result).toMatchObject({ kind: "succeeded", output: { undo: true } });
    expect(queryMailLog(rig.db)).toHaveLength(1);
    const restoreSnapshot = mailJudgementSnapshot({ ...JUDGEMENT_BINDING, input: { action: "undo", message, operationId: moved.operationId }, provenance: JUDGEMENT_PROVENANCE });
    const restore = { ...moved, operationId: "restore-example", ownerRequestId: "restore-request-example", snapshot: restoreSnapshot };
    rig.db.run("CREATE TRIGGER fixture_restore_failure BEFORE UPDATE OF result_json ON desk_mail_judgement_operations WHEN NEW.operation_id = 'restore-example' BEGIN SELECT RAISE(ABORT, 'restore receipt failed'); END");
    await expect(rig.owner.dispatch(JUDGEMENT_BINDING, restore)).rejects.toThrow("restore receipt failed");
    expect(rig.folders.get(message.canonicalId)).toBe("INBOX");
    expect(queryMailLog(rig.db)).toHaveLength(1);
    rig.db.run("DROP TRIGGER fixture_restore_failure");
    rig.deny();
    expect((await rig.owner.dispatch(JUDGEMENT_BINDING, restore)).result.kind).toBe("uncertain");
    expect(rig.db.query<{ undo_operation: string }, [string]>("SELECT undo_operation FROM desk_mail_judgement_operations WHERE operation_id = ?").get(moved.operationId)?.undo_operation).toBe(restore.operationId);
    expect(queryMailLog(rig.db)).toHaveLength(1);
    rig.allow();
    rig.advance(UNDO_WINDOW_MS + 1);
    await rig.reopen();
    expect((await rig.owner.dispatch(JUDGEMENT_BINDING, restore)).result.kind).toBe("succeeded");
    expect(queryMailLog(rig.db)).toEqual([]);
    expect(rig.folders.get(message.canonicalId)).toBe("INBOX");
  });

  test("reopen prunes expired settled receipts without losing unresolved moves or Mail state", async () => {
    const rig = await open();
    await mark(rig, "once");
    const expired = rig.calls[0]!;
    judgementReceipt(await rig.press({ ...unimportant, message: judgementMessage("missing-example") }, "once"));
    rig.db.run("CREATE TRIGGER fixture_receipt_failure BEFORE UPDATE OF result_json ON desk_mail_judgement_operations BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END");
    await expect(rig.press({ action: "correct", message, said: "archive" }, "once")).rejects.toThrow("receipt write failed");
    const unresolved = rig.calls.at(-1)!;
    rig.db.run("DROP TRIGGER fixture_receipt_failure");
    const log = queryMailLog(rig.db);
    rig.advance(UNDO_WINDOW_MS + 31_000);
    const recent = judgementReceipt(await rig.press({ action: "block-domain", message }, "once"));
    await rig.reopen();
    const saved = rig.db.query<{ operation_id: string }, []>("SELECT operation_id FROM desk_mail_judgement_operations ORDER BY operation_id").all().map(row => row.operation_id);
    expect(saved.sort()).toEqual([unresolved.operationId, recent.operationId].sort());
    expect(listSenders(rig.db, "unimportant")).toHaveLength(2);
    expect(queryMailLog(rig.db).filter(row => row.at === log[0]!.at)).toEqual(log);
    expect((await rig.owner.dispatch(JUDGEMENT_BINDING, expired)).result).toMatchObject({ kind: "failed", error: { code: "mail.operation_expired" } });
    expect((await rig.owner.dispatch(JUDGEMENT_BINDING, unresolved)).result).toMatchObject({ kind: "succeeded" });
    expect(rig.folders.get(message.canonicalId)).toBe("Archive");
    expect(queryMailLog(rig.db).filter(row => row.where === "correction")).toHaveLength(1);
  });

  test("a granted repeated Unimportant is a true no-op without an irreversible log append", async () => {
    const rig = await open();
    await mark(rig, "always");
    const before = queryMailLog(rig.db);
    expect(await mark(rig)).toMatchObject({ state: "done", undo: false });
    expect(queryMailLog(rig.db)).toEqual(before);
  });

  test("snooze refuses another source's row and a Message-ID shared across accounts", async () => {
    const rig = await open();
    const mail = { ...rig.readings[0]!.mail[0]!, sourceId: "other-source", account: "other-account" };
    snoozeMail(rig.db, mail, { kind: "later" }, { now: Date.parse(AT), readings: [] });
    const before = readSnooze(rig.db, message.canonicalId);
    expect(judgementReceipt(await rig.press({ action: "snooze-cancel", message }, "once")).state).toBe("conflict");
    expect(judgementReceipt(await rig.press({ action: "snooze", message, until: { kind: "tomorrow" } }, "once")).state).toBe("conflict");
    expect(readSnooze(rig.db, message.canonicalId)).toEqual(before);
    rig.readings[0]!.mail.push({ ...mail, account: "other-account" });
    expect(await mark(rig, "once")).toMatchObject({ state: "conflict" });
    expect(listSenders(rig.db, "unimportant")).toEqual([]);
  });

  test("effects revalidate current authority after journal admission", async () => {
    const rig = await open();
    rig.adapter(request => { rig.deny(); return rig.bridge.changeJudgement(request); });
    expect(await mark(rig, "once")).toMatchObject({ state: "denied", undo: false });
    expect(listSenders(rig.db, "unimportant")).toEqual([]);
    expect(queryMailLog(rig.db)).toEqual([]);
  });

  test("a detached callback cannot retain mutation authority after dispatch settles", async () => {
    const rig = await open();
    const later = Promise.withResolvers<undefined>();
    let escaped: Promise<unknown> | undefined;
    rig.adapter(request => {
      escaped = later.promise.then(() => rig.bridge.changeJudgement(request));
      return rig.bridge.changeJudgement(request);
    });
    await mark(rig, "once");
    later.resolve(undefined);
    await expect(escaped).rejects.toMatchObject({ error: { code: "mail_judgement_unadmitted" } });
    expect(queryMailLog(rig.db)).toHaveLength(1);
  });

  test("the bridge refuses outside dispatch, including inside a query's admitted connection", async () => {
    const rig = await open();
    await mark(rig, "once");
    const request = rig.calls[0]!;
    await expect(rig.bridge.changeJudgement(request)).rejects.toMatchObject({ error: { code: "mail_judgement_unadmitted" } });
    await expect(withAdmittedCall(JUDGEMENT_BINDING, () => rig.bridge.changeJudgement(request))).rejects.toMatchObject({ error: { code: "mail_judgement_unadmitted" } });
  });

  test("the adapter cannot substitute an action or message inside the admitted dispatch", async () => {
    const rig = await open();
    rig.adapter(request => rig.bridge.changeJudgement({ ...request, snapshot: mailJudgementSnapshot({ ...JUDGEMENT_BINDING, input: { action: "block-domain", message }, provenance: JUDGEMENT_PROVENANCE }) }));
    await expect(rig.press(unimportant, "once")).rejects.toMatchObject({ error: { code: "mail_judgement_unadmitted" } });
    expect(listSenders(rig.db, "unimportant")).toEqual([]);
    expect(queryMailLog(rig.db)).toEqual([]);
  });

  test("owner dedup survives reopen and an operation identity cannot change its payload", async () => {
    const rig = await open();
    await mark(rig, "always");
    const request = rig.calls[0]!;
    const before = queryMailLog(rig.db);
    await rig.reopen();
    expect((await rig.owner.dispatch(JUDGEMENT_BINDING, request)).result.kind).toBe("succeeded");
    expect(queryMailLog(rig.db)).toEqual(before);
    const snapshot = mailJudgementSnapshot({ ...JUDGEMENT_BINDING, input: { action: "block-domain", message }, provenance: JUDGEMENT_PROVENANCE });
    expect((await rig.owner.dispatch(JUDGEMENT_BINDING, { ...request, snapshot })).result.kind).toBe("conflict");
    expect(listSenders(rig.db, "unimportant")).toHaveLength(1);
  });

  test("the owner denies an account mismatch and enforces confirmation independently of the host", async () => {
    const rig = await open();
    await mark(rig, "always");
    const request = rig.calls[0]!;
    const snapshot = mailJudgementSnapshot({ ...JUDGEMENT_BINDING, input: { action: "correct", message, said: "matters" }, provenance: JUDGEMENT_PROVENANCE });
    expect((await rig.owner.dispatch(JUDGEMENT_BINDING, { ...request, operationId: "forged-confirmation", snapshot })).result).toMatchObject({ kind: "failed", error: { code: "mail.confirmation_required" } });
    snapshot.destinations[0]!.canonicalId = "other-account";
    snapshot.digest = snapshotDigest(snapshot);
    expect((await rig.owner.dispatch(JUDGEMENT_BINDING, { ...request, operationId: "forged-account", snapshot })).result).toMatchObject({ kind: "failed", error: { code: "mail.account_denied" } });
    expect(queryMailLog(rig.db)).toHaveLength(1);
  });

  test("missing mail and expired Undo have explicit receipts or refusals and no fallback writes", async () => {
    const rig = await open();
    const receipt = await mark(rig, "once");
    rig.advance(UNDO_WINDOW_MS + 1);
    expect((await rig.host.undo(receipt.operationId, JUDGEMENT_PROVENANCE)).kind).toBe("unavailable");
    expect(judgementReceipt(await rig.press({ ...unimportant, message: judgementMessage("missing-example") }, "once"))).toMatchObject({ state: "missing", undo: false });
    expect(listSenders(rig.db, "unimportant")).toHaveLength(1);
  });
});
