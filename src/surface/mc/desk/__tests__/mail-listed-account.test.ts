import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskMail } from "../../api/desk-mail";
import { initDatabase } from "../../db/init";
import { HandledLedger } from "../actions";
import type { DeskRuntime } from "../compose";
import type { WriterResult } from "../create";
import { AMBIGUOUS_ACCOUNT_REFUSAL, findListedMail, resolveListedMail } from "../mail-actions";
import { mailDraftWriter } from "../mail-draft-conversation-writer";
import { SourceCache, type SourceMail, type SourceReading } from "../sources/command";
import { mailDesk } from "../../__tests__/desk-mail-fixtures";

const mail = (account: string): SourceMail => ({
  kind: "mail", id: "shared@example.test", from: { name: "Kit Shop", address: "sales@kits.example" }, subject: "Quote", receivedAt: "2026-11-02T08:00:00.000Z", unread: true, account,
});
const reading = (id: string, mails: SourceMail[]): SourceReading => ({ id, area: null, events: [], mail: mails, readAt: 0, error: null, dropped: 0, problems: [] });
const KEY = "mail:shared@example.test";
const DESK = mailDesk({ trash: ["trash"], draft: ["draft"], timeoutSeconds: 5 });

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

const runtimeWith = async (readings: SourceReading[]): Promise<DeskRuntime> => {
  return { options: DESK, ledger: new HandledLedger(), sourceCache: { cached: () => readings } as unknown as SourceCache };
};

function recorder() {
  const calls: string[] = [];
  return { calls, run: async (_argv: string[], stdin: string): Promise<WriterResult> => { calls.push(stdin); return { code: 0, stdout: "", stderr: "" }; } };
}

const post = (body: unknown): Request => new Request("http://localhost/api/desk/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("a Message-ID listed under more than one account", () => {
  const two = [reading("a", [mail("work")]), reading("b", [mail("home")])];

  it("resolves to a named refusal", () => {
    expect(resolveListedMail(two, KEY)).toEqual({ ok: false, reason: "ambiguous", error: AMBIGUOUS_ACCOUNT_REFUSAL });
    expect(findListedMail(two, KEY)).toBeNull();
  });

  it("refuses every Desk mail action and runs no command", async () => {
    const rt = await runtimeWith(two);
    const r = recorder();
    for (const body of [{ action: "trash", key: KEY }, { action: "draft", key: KEY, body: "Thanks" }, { action: "opened", key: KEY }]) {
      const res = await handleDeskMail(post(body), db, rt, { run: r.run });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(AMBIGUOUS_ACCOUNT_REFUSAL);
    }
    expect(r.calls).toHaveLength(0);
  });

  it("fails a conversation mail draft with no effect", async () => {
    const r = recorder();
    const writer = mailDraftWriter({ desk: () => DESK, lookupMail: key => resolveListedMail(two, key), ledger: new HandledLedger(), run: r.run });
    const result = await writer.create({ fields: { mail: KEY, body: "Thanks" }, signal: new AbortController().signal } as never);
    expect(result.state).toBe("failed");
    expect(r.calls).toHaveLength(0);
  });
});

describe("a Message-ID listed under one account", () => {
  it.each([[[reading("a", [mail("work")])]], [[reading("a", [mail("work")]), reading("b", [mail("work")])]]])("still resolves", readings => {
    const found = resolveListedMail(readings, KEY);
    expect(found.ok).toBe(true);
    expect(found.ok && found.mail.account).toBe("work");
  });

  it("drafts through the API as before", async () => {
    const rt = await runtimeWith([reading("a", [mail("work")])]);
    const r = recorder();
    const res = await handleDeskMail(post({ action: "draft", key: KEY, body: "Thanks" }), db, rt, { run: r.run });
    expect(res.status).toBe(200);
    expect(r.calls).toHaveLength(1);
  });
});
