import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskMail } from "../api/desk-mail";
import { HandledLedger } from "../desk/actions";
import { setGrant } from "../desk/autonomy";
import { saveClassification } from "../desk/classify";
import { composeDesk, type DeskRuntime } from "../desk/compose";
import { logMailDecision, mailFeatures, queryMailLog } from "../desk/mail-log";
import { createRule, listRules, proposeRules, ruleFor } from "../desk/mail-rules";
import { learnedAction } from "../desk/mail-similar";
import { suspicionContext, suspicionOf, type SuspicionContext } from "../desk/mail-suspicion";
import { trustedViews } from "../desk/mail-trust";
import { SourceCache, type SourceMail } from "../desk/sources/command";
import { initDatabase } from "../db/init";
import { mailDesk, mailPost as post } from "./desk-mail-fixtures";

const NOW = Date.parse("2026-11-01T09:00:00.000Z");
const PASS = { spf: "pass", dkim: "pass", dmarc: "pass", dkimDomains: ["pay.example"] } as const;

const mail = (over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id: "m1@pay.example", from: { name: "Pay", address: "Billing@Pay.example" }, subject: "Your receipt", receivedAt: "2026-11-01T08:00:00.000Z", unread: true,
  url: "message://%3Cm1%40pay.example%3E", account: "personal", headers: { authResults: { ...PASS, dkimDomains: [...PASS.dkimDomains] }, replyTo: "help@support-desk.example" }, ...over,
});

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

describe("a remembered Not phishing", () => {
  const codes = (m: SourceMail, c: SuspicionContext, classifier = false): string[] => suspicionOf(m, c, classifier).map((r) => r.code);
  const dismissed = (keys: Record<string, string[]>): SuspicionContext => ({ vips: new Set(), vipNames: new Map(), ownDomains: [], dismissed: new Map(Object.entries(keys).map(([k, v]) => [k, new Set(v)])) });

  it("waives a Reply-To reason for that exact sender address only", () => {
    const ctx = dismissed({ "billing@pay.example": ["reply-to"] });
    expect(codes(mail(), ctx)).toEqual([]);
    expect(codes(mail({ id: "m2@pay.example" }), ctx)).toEqual([]);
    expect(codes(mail({ from: { name: "Pay", address: "news@pay.example" } }), ctx)).toEqual(["reply-to"]);
  });

  it("still flags mail from the same address that fails its checks, and then shows every reason", () => {
    const ctx = dismissed({ "billing@pay.example": ["reply-to"] });
    const spoof = mail({ id: "spoof@x", headers: { authResults: { spf: "fail", dkim: "fail", dmarc: "fail" }, replyTo: "help@support-desk.example" } });
    expect(codes(spoof, ctx)).toEqual(["dmarc", "spf", "dkim", "reply-to"]);
    expect(codes(mail({ links: [{ text: "pay.example", href: "https://evil.example/" }] }), ctx)).toEqual(["reply-to", "link"]);
    expect(codes(mail(), ctx, true)).toEqual(["reply-to", "classifier"]);
  });

  it("waives an authentication or classifier reason only for the one mail dismissed", () => {
    const ctx = dismissed({ "billing@pay.example": ["dkim m1@pay.example", "classifier m1@pay.example"] });
    const broken = (id: string) => mail({ id, headers: { authResults: { spf: "pass", dkim: "fail" } } });
    expect(codes(broken("m1@pay.example"), ctx, true)).toEqual([]);
    expect(codes(broken("m2@pay.example"), ctx)).toEqual(["dkim"]);
    expect(codes(mail({ id: "m2@pay.example", headers: undefined }), ctx, true)).toEqual(["classifier"]);
  });
});

describe("Not phishing on the Desk", () => {
  const first = mail();
  const second = mail({ id: "m2@pay.example", subject: "Another receipt" });
  let items: SourceMail[] = [first];
  const runtime = (): DeskRuntime => ({ options: mailDesk({ move: ["/opt/move"], timeoutSeconds: 20 }), ledger: new HandledLedger(), sourceCache: new SourceCache(async () => JSON.stringify({ items })) });
  const view = (rt: DeskRuntime) => composeDesk(db, rt.options ?? mailDesk(undefined), undefined, { now: NOW, handled: rt.ledger, ...(rt.sourceCache ? { sourceCache: rt.sourceCache } : {}) });
  const card = async (rt: DeskRuntime, id: string) => (await view(rt)).items.find((i) => i.key === `mail:${id}`);
  const act = async (rt: DeskRuntime, body: unknown) => { const res = await handleDeskMail(post(body), db, rt, { now: () => NOW, newId: () => "trust-1" }); return { status: res.status, body: (await res.json()) as Record<string, unknown> }; };

  beforeEach(() => { items = [first]; });

  it("turns a flagged card into a normal one, remembers the sender, and Undo flags it again", async () => {
    let rt = runtime();
    const flagged = await card(rt, first.id);
    expect(flagged?.suspicious).toBe(true);
    expect([...(flagged?.actions ?? []), ...(flagged?.more ?? [])].map((a) => a.id)).toContain("mail.trust");

    const done = await act(rt, { action: "not-phishing", key: `mail:${first.id}` });
    expect(done).toEqual({ status: 200, body: { ok: true, message: "Not phishing: mail from billing@pay.example is no longer flagged for replies going to another domain.", undo: "trust-1" } });
    const normal = await card(rt, first.id);
    expect(normal?.suspicious).toBeUndefined();
    expect(normal?.detail.history.some((h) => h.startsWith("The Desk would flag it (Replies go to support-desk.example"))).toBe(true);
    expect(normal?.detail.history.some((h) => h.startsWith("You said it is not phishing on the Desk"))).toBe(true);
    expect(queryMailLog(db, { actions: ["not-phishing"] }).map((e) => [e.messageId, e.sender, e.where])).toEqual([[first.id, "billing@pay.example", "desk"]]);
    expect(trustedViews(db)).toEqual([{ sender: "billing@pay.example", codes: ["reply-to"], mails: [], at: NOW, sentence: "Not flagged for replies going to another domain." }]);
    const line = (await view(rt)).autonomy.done.find((d) => d.key === "mail-trust:trust-1");
    expect(line).toMatchObject({ action: "mail.trust", undo: "trust-1", title: "Not phishing: “Your receipt”" });

    items = [first, second];
    rt = runtime();
    expect((await card(rt, second.id))?.suspicious).toBeUndefined();

    const undone = await act(rt, { action: "not-phishing.undo", trust: "trust-1" });
    expect(undone.status).toBe(200);
    expect((await card(rt, first.id))?.suspicious).toBe(true);
    expect((await card(rt, second.id))?.suspicious).toBe(true);
    expect(queryMailLog(db, { actions: ["not-phishing"] })).toEqual([]);
    expect(trustedViews(db)).toEqual([]);
    expect((await view(rt)).autonomy.done.find((d) => d.key === "mail-trust:trust-1")?.undo).toBeUndefined();
    expect((await act(rt, { action: "not-phishing.undo", trust: "trust-1" })).status).toBe(409);
  });

  it("refuses a mail that is not flagged, and Remove in Settings forgets the sender", async () => {
    items = [mail({ headers: { authResults: { ...PASS, dkimDomains: ["pay.example"] } } })];
    let rt = runtime();
    await view(rt);
    expect(await act(rt, { action: "not-phishing", key: `mail:${first.id}` })).toEqual({ status: 409, body: { ok: false, error: "This mail is not flagged as possible phishing." } });
    items = [first];
    rt = runtime();
    await view(rt);
    expect((await act(rt, { action: "not-phishing", key: `mail:${first.id}` })).status).toBe(200);
    expect((await act(rt, { action: "not-phishing.remove", sender: "BILLING@pay.example" })).body).toEqual({ ok: true, message: "Mail from billing@pay.example is checked for phishing in full again.", trusted: [] });
    expect((await card(rt, first.id))?.suspicious).toBe(true);
    expect((await view(rt)).autonomy.done.find((d) => d.key === "mail-trust:trust-1")).toMatchObject({ action: "mail.trust.undone", message: "Removed in Settings: flagged as possible phishing again." });
    expect((await act(rt, { action: "not-phishing.undo", trust: "trust-1" })).status).toBe(409);
    expect((await act(rt, { action: "not-phishing.remove", sender: "billing@pay.example" })).status).toBe(404);
  });

  it("lets rules handle the mail once the classifier's verdict on it is dismissed", async () => {
    const plain = mail({ headers: { authResults: { ...PASS, dkimDomains: ["pay.example"] } } });
    items = [plain];
    saveClassification(db, plain.id, { category: "fyi", reason: "r", suspicious: true }, "test", NOW);
    createRule(db, { match: "sender", value: "billing@pay.example", action: "archive" }, NOW, () => "rule-pay");
    setGrant(db, "mail.rules", true, NOW);
    expect(ruleFor(listRules(db), plain, suspicionContext(db), true)).toBeUndefined();
    const rt = runtime();
    await view(rt);
    expect((await act(rt, { action: "not-phishing", key: `mail:${plain.id}` })).body.message).toBe("Not phishing: this mail is no longer flagged.");
    expect(ruleFor(listRules(db), plain, suspicionContext(db), true)?.id).toBe("rule-pay");
    expect(ruleFor(listRules(db), { ...plain, id: "other@pay.example" }, suspicionContext(db), true)).toBeUndefined();
  });

  it("is ignored by rule proposals and by similar-decision learning", () => {
    for (let i = 0; i < 8; i++) {
      const m = mail({ id: `n${i}@pay.example` });
      logMailDecision(db, mailFeatures(db, m), "archive", "desk", NOW - 1000 * (i + 2));
    }
    logMailDecision(db, mailFeatures(db, mail({ id: "n0@pay.example" })), "not-phishing", "desk", NOW - 500);
    expect(proposeRules(db, NOW, { proposeAfter: 8, maxPerPass: 20, windowDays: 90 }).map((p) => [p.match, p.value])).toContainEqual(["sender", "billing@pay.example"]);
    expect(learnedAction("not-phishing")).toBeUndefined();
  });
});
