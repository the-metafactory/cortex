import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskMail } from "../api/desk-mail";
import { HandledLedger } from "../desk/actions";
import { readClassifications, saveClassification } from "../desk/classify";
import type { DeskRuntime } from "../desk/compose";
import type { WriterResult } from "../desk/create";
import { queryMailLog } from "../desk/mail-log";
import { SourceCache, type SourceMail } from "../desk/sources/command";
import { initDatabase } from "../db/init";
import { composeWith, MOVE_DESK, NOW, queue } from "./desk-mail-fixtures";

const MAIL: SourceMail = {
  kind: "mail", id: "p1@example.org", from: { name: "Probe", address: "probe@example.org" }, subject: "Quarterly census", receivedAt: "2026-11-01T08:00:00.000Z",
  unread: true, url: "message://%3Cp1%40example.org%3E", account: "work",
};
const KEY = "mail:p1@example.org";
const MOVED: WriterResult = { code: 0, stdout: `${JSON.stringify({ folder: "Trash", message: "Moved to Trash." })}\n`, stderr: "" };
const RESTORED: WriterResult = { code: 0, stdout: `${JSON.stringify({ message: "Moved back to INBOX from Trash." })}\n`, stderr: "" };

let db: Database;
let rt: DeskRuntime;
beforeEach(async () => {
  db = initDatabase(":memory:");
  rt = { options: MOVE_DESK, ledger: new HandledLedger(), sourceCache: new SourceCache(async () => JSON.stringify({ items: [MAIL] })) };
  await composeWith(db, MOVE_DESK, rt, NOW);
  saveClassification(db, MAIL.id, { category: "fyi", reason: "A colleague.", predictedAction: "keep" }, "m", NOW);
});
afterEach(() => { db.close(); });

const send = async (body: object, run: ReturnType<typeof queue>["run"]) => {
  const res = await handleDeskMail(new Request("http://x/api/desk/mail", { method: "POST", body: JSON.stringify(body) }), db, rt, { run, now: () => NOW, newId: () => "move-1" });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const keys = async () => (await composeWith(db, MOVE_DESK, rt, NOW)).items.map((i) => i.key);
const log = () => queryMailLog(db).map((e) => [e.action, e.where]);

describe("a mail correction that names a move", () => {
  it("moves the mail through the move path, answers with Undo, and logs the correction once", async () => {
    const r = queue([MOVED]);
    const res = await send({ action: "correct", key: KEY, said: "trash" }, r.run);
    expect(res).toEqual({ status: 200, body: { ok: true, message: "Moved to Trash. Corrected: you would delete this.", undo: "move-1" } });
    expect(r.calls).toEqual([{ argv: ["/opt/adapters/bin/desk-mail-move.ts"], stdin: { action: "move", account: "work", messageId: MAIL.id, target: "trash" } }]);
    expect(log()).toEqual([["trash", "correction"]]);
    expect(readClassifications(db, [MAIL.id]).size).toBe(0);
    expect(await keys()).toEqual([]);
    expect((await composeWith(db, MOVE_DESK, rt, NOW)).autonomy.done.map((d) => d.title)).toEqual(["Deleted after your correction: “Quarterly census”"]);
  });

  it("moves spam to Junk and offers to block the domain", async () => {
    const res = await send({ action: "correct", key: KEY, said: "junk" }, queue([MOVED]).run);
    expect(res.body).toMatchObject({ ok: true, undo: "move-1", block: "@example.org" });
    expect(log()).toEqual([["junk", "correction"]]);
  });

  it("withdraws the correction on Undo and brings the mail back", async () => {
    const r = queue([MOVED, RESTORED]);
    await send({ action: "correct", key: KEY, said: "archive" }, r.run);
    const undone = await send({ action: "undo", move: "move-1" }, r.run);
    expect(undone.body).toEqual({ ok: true, message: "Moved back to INBOX from Trash. Your correction is withdrawn.", restored: KEY });
    expect(log()).toEqual([["restore", "desk"]]);
    expect(await keys()).toEqual([KEY]);
  });

  it("keeps the mail and the recorded correction when the move fails, and says so", async () => {
    const r = queue([{ code: 1, stdout: "", stderr: "The work account has no Trash mailbox.\n" }]);
    const res = await send({ action: "correct", key: KEY, said: "trash" }, r.run);
    expect(res).toEqual({ status: 502, body: { ok: false, recorded: true, correction: expect.any(Number), error: "Corrected: you would delete this. The correction is recorded, but the mail was not moved: The work account has no Trash mailbox." } });
    expect(log()).toEqual([["trash", "correction"]]);
    expect(await keys()).toEqual([KEY]);
  });

  it("retries only the move of a recorded correction, keeps one log row, and Undo then withdraws it", async () => {
    const r = queue([{ code: 1, stdout: "", stderr: "Mail server busy.\n" }, { code: 1, stdout: "", stderr: "Still busy.\n" }, MOVED, RESTORED]);
    const first = await send({ action: "correct", key: KEY, said: "trash" }, r.run);
    const correction = first.body.correction;
    expect(typeof correction).toBe("number");
    const again = await send({ action: "correct", key: KEY, said: "trash", correction }, r.run);
    expect(again.body).toMatchObject({ ok: false, recorded: true, correction });
    const retried = await send({ action: "correct", key: KEY, said: "trash", correction }, r.run);
    expect(retried.body).toMatchObject({ ok: true, undo: "move-1" });
    expect(log()).toEqual([["trash", "correction"]]);
    expect((await send({ action: "correct", key: KEY, said: "trash", correction }, r.run)).status).toBe(409);
    expect((await send({ action: "undo", move: "move-1" }, r.run)).body.message).toBe("Moved back to INBOX from Trash. Your correction is withdrawn.");
    expect(log()).toEqual([["restore", "desk"]]);
    expect(r.calls).toHaveLength(4);
  });

  it("refuses a retry that names no correction of this kind for this mail, before anything runs", async () => {
    const r = queue();
    const kept = await send({ action: "correct", key: KEY, said: "keep" }, r.run);
    expect(kept.status).toBe(200);
    const [row] = queryMailLog(db);
    expect((await send({ action: "correct", key: KEY, said: "trash", correction: row?.id }, r.run)).status).toBe(409);
    expect((await send({ action: "correct", key: KEY, said: "trash", correction: 9999 }, r.run)).status).toBe(409);
    expect(r.calls).toEqual([]);
    expect(log()).toEqual([["kept", "correction"]]);
  });

  it("records the correction when the mail is already moved, without running the command again", async () => {
    const r = queue([MOVED]);
    await send({ action: "move", key: KEY, target: "archive" }, r.run);
    const res = await send({ action: "correct", key: KEY, said: "trash" }, r.run);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ recorded: true, error: expect.stringContaining("already in Archive") });
    expect(r.calls).toHaveLength(1);
    expect(log()).toEqual([["trash", "correction"], ["archive", "desk"]]);
  });
});

describe("a mail correction that keeps the mail", () => {
  it("logs the correction, moves nothing and keeps the card", async () => {
    const r = queue();
    const res = await send({ action: "correct", key: KEY, said: "keep" }, r.run);
    expect(res.body).toEqual({ ok: true, message: "Corrected: you keep this. The Desk sorts it and mail like it again with that in mind." });
    expect(r.calls).toEqual([]);
    expect(log()).toEqual([["kept", "correction"]]);
    expect(await keys()).toEqual([KEY]);
  });
});
