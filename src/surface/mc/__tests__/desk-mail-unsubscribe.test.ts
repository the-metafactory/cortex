import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskMail } from "../api/desk-mail";
import { HandledLedger } from "../desk/actions";
import { saveClassification } from "../desk/classify";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { logMailDecision, mailFeatures, queryMailLog, type MailLogAction, type MailLogWhere } from "../desk/mail-log";
import { listRules } from "../desk/mail-rules";
import type { SuspicionContext } from "../desk/mail-suspicion";
import { archiveWhatArrives, DEFAULT_UNSUBSCRIBE, isPublicAddress, publicLookup, offerContext, oneClickRefusal, unreadDismissals, unsubscribeMail, unsubscribeMethod, unsubscribeOffer, type OneClickPost } from "../desk/mail-unsubscribe";
import { mailItems } from "../desk/rank";
import { SourceCache, type SourceMail } from "../desk/sources/command";
import { initDatabase } from "../db/init";
import { composeWith, MOVE_DESK, NOW } from "./desk-mail-fixtures";

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

const ONE_CLICK = { listUnsubscribe: "<mailto:leave@lists.example?subject=unsubscribe>, <https://lists.example/u/abc123>", listUnsubscribePost: "List-Unsubscribe=One-Click" };
const letter = (id: string, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id, from: { name: "Weekly News", address: "news@lists.example" }, subject: `Issue ${id}`, receivedAt: new Date(NOW - 3600_000).toISOString(), unread: true, account: "personal",
  headers: { listId: "<weekly.lists.example>", ...ONE_CLICK }, ...over,
});
const NO_SUSPICION: SuspicionContext = { vips: new Set(), vipNames: new Map(), ownDomains: [] };
const ctx = (over: { suspicion?: SuspicionContext; flagged?: Set<string> } = {}) => offerContext(db, DEFAULT_UNSUBSCRIBE, over.suspicion ?? NO_SUSPICION, over.flagged);
const decide = (id: string, action: MailLogAction, where: MailLogWhere = "desk", over: Partial<SourceMail> = {}, at = NOW - 86_400_000): void => {
  logMailDecision(db, mailFeatures(db, { ...letter(id, over), sourceId: "personal-mail" }), action, where, at);
};
const archivedUnread = (n: number, over: Partial<SourceMail> = {}): void => {
  for (let i = 0; i < n; i++) decide(`old-${i}`, i % 2 === 0 ? "archive" : "trash", i === 1 ? "client" : "desk", over);
};
const fakePost = (answers: (number | Error)[]) => {
  const calls: string[] = [];
  const post: OneClickPost = async (url) => {
    calls.push(url.href);
    const next = answers.shift() ?? 200;
    if (next instanceof Error) throw next;
    return { status: next };
  };
  return { calls, post };
};
const listed = (m: SourceMail) => ({ ...m, sourceId: "personal-mail" });

describe("List-Unsubscribe header forms", () => {
  it("offers One-Click only for an https URI with the exact List-Unsubscribe-Post value", () => {
    expect(unsubscribeMethod(ONE_CLICK)).toEqual({ kind: "one-click", url: "https://lists.example/u/abc123" });
    expect(unsubscribeMethod({ ...ONE_CLICK, listUnsubscribePost: "  list-unsubscribe = one-click " })).toEqual({ kind: "one-click", url: "https://lists.example/u/abc123" });
    expect(unsubscribeMethod({ listUnsubscribe: "<https://lists.example/u/abc123>" })).toEqual({ kind: "page", url: "https://lists.example/u/abc123" });
    expect(unsubscribeMethod({ listUnsubscribe: "<https://lists.example/u/abc123>", listUnsubscribePost: "List-Unsubscribe=Yes" })).toEqual({ kind: "page", url: "https://lists.example/u/abc123" });
    expect(unsubscribeMethod({ listUnsubscribe: "<http://lists.example/u/1>", listUnsubscribePost: "List-Unsubscribe=One-Click" })).toEqual({ kind: "page", url: "http://lists.example/u/1" });
    expect(unsubscribeMethod({ listUnsubscribe: "<mailto:leave@lists.example>" })).toEqual({ kind: "page", url: "mailto:leave@lists.example" });
    expect(unsubscribeMethod({ listUnsubscribe: "<https://lists.example/u/\r\n abc>", listUnsubscribePost: "List-Unsubscribe=One-Click" })).toEqual({ kind: "one-click", url: "https://lists.example/u/abc" });
    expect(unsubscribeMethod({ listUnsubscribe: "<javascript:alert(1)>, <file:///etc/passwd>" })).toBeNull();
    expect(unsubscribeMethod({ listUnsubscribe: "https://lists.example/u/no-brackets" })).toBeNull();
    expect(unsubscribeMethod(undefined)).toBeNull();
  });
});

describe("unsubscribe offer", () => {
  it("appears once the list was archived or deleted unread five times, on the Desk or in the mail client", () => {
    archivedUnread(4);
    expect(unsubscribeOffer(db, letter("new"), ctx())).toBeNull();
    decide("old-4", "archive");
    expect(unreadDismissals(db, letter("new"))).toBe(5);
    expect(unsubscribeOffer(db, letter("new"), ctx())).toEqual({ kind: "one-click", url: "https://lists.example/u/abc123", host: "lists.example", dismissed: 5 });
  });

  it("does not count rule runs, corrections, mails read and kept, or moves the principal undid", () => {
    archivedUnread(4);
    decide("r1", "archive", "rule");
    decide("c1", "archive", "correction");
    decide("k1", "kept", "client");
    decide("u1", "archive");
    decide("u1", "restore", "desk", {}, NOW - 3600_000);
    expect(unreadDismissals(db, letter("new"))).toBe(4);
    expect(unsubscribeOffer(db, letter("new"), ctx())).toBeNull();
  });

  it("counts by sender when the mail has no List-Id", () => {
    const noList = { headers: { ...ONE_CLICK } };
    archivedUnread(5, noList);
    expect(unsubscribeOffer(db, letter("new", noList), ctx())?.kind).toBe("one-click");
    expect(unsubscribeOffer(db, letter("new", { ...noList, from: { address: "other@lists.example" } }), ctx())).toBeNull();
  });

  it("offers only the page for mailto or GET unsubscribe, and nothing without the header", () => {
    archivedUnread(5);
    expect(unsubscribeOffer(db, letter("new", { headers: { listId: "<weekly.lists.example>", listUnsubscribe: "<mailto:leave@lists.example>" } }), ctx())).toEqual({ kind: "page", url: "mailto:leave@lists.example", host: "lists.example", dismissed: 5 });
    expect(unsubscribeOffer(db, letter("new", { headers: { listId: "<weekly.lists.example>" } }), ctx())).toBeNull();
  });

  it("is never offered for a VIP or a mail flagged as suspicious", () => {
    archivedUnread(5);
    expect(unsubscribeOffer(db, letter("new"), ctx({ suspicion: { ...NO_SUSPICION, vips: new Set(["news@lists.example"]) } }))).toBeNull();
    expect(unsubscribeOffer(db, letter("new"), ctx({ flagged: new Set(["new"]) }))).toBeNull();
    const failing = letter("new", { headers: { listId: "<weekly.lists.example>", ...ONE_CLICK, authResults: { spf: "fail", dkim: "fail", dmarc: "fail" } } });
    expect(unsubscribeOffer(db, failing, ctx())).toBeNull();
  });

  it("can be turned off", () => {
    archivedUnread(5);
    expect(unsubscribeOffer(db, letter("new"), { ...ctx(), config: { ...DEFAULT_UNSUBSCRIBE, enabled: false } })).toBeNull();
  });
});

describe("host guard", () => {
  it("accepts public unicast addresses only", () => {
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700::6810:84e5", "2a00:1450:4001::200e"]) expect(isPublicAddress(ip)).toBe(true);
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.100.1.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fe80::1", "fd00::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "2001:db8::1", "2001::1", "2002:7f00:1::1", "64:ff9b::7f00:1", "localhost", "not-an-ip"]) expect(isPublicAddress(ip)).toBe(false);
  });

  it("refuses a host name that resolves to a loopback address at connect time", async () => {
    const error = await new Promise<Error | null>((resolve) => { publicLookup("localhost", { all: true }, (err) => { resolve(err); }); });
    expect(error?.message).toContain("private or local address");
  });

  it("refuses non-https, user info, other ports, IP literals and local names", () => {
    expect(oneClickRefusal("https://lists.example/u/1")).toBeNull();
    expect(oneClickRefusal("http://lists.example/u/1")).toContain("https");
    expect(oneClickRefusal("https://user:pw@lists.example/u")).toContain("user name");
    expect(oneClickRefusal("https://lists.example:8443/u")).toContain("port");
    expect(oneClickRefusal("https://127.0.0.1/u")).toContain("IP address");
    expect(oneClickRefusal("https://[::1]/u")).toContain("IP address");
    expect(oneClickRefusal("https://localhost/u")).toContain("local");
    expect(oneClickRefusal("https://printer.local/u")).toContain("local");
    expect(oneClickRefusal("https://intranet/u")).toContain("local");
  });
});

describe("unsubscribe", () => {
  it("sends one POST after the tap, records it, refuses a second one, and then offers an archive rule", async () => {
    archivedUnread(5);
    const ledger = new HandledLedger();
    const { calls, post } = fakePost([200]);
    const done = await unsubscribeMail(listed(letter("new")), ctx(), { db, ledger, now: NOW, post });
    expect(done).toMatchObject({ ok: true });
    expect(done.ok && done.message).toContain("lists.example accepted it (HTTP 200)");
    expect(calls).toEqual(["https://lists.example/u/abc123"]);
    expect(queryMailLog(db, { actions: ["unsubscribe"] }).map((e) => [e.messageId, e.where])).toEqual([["new", "desk"]]);
    expect(unsubscribeOffer(db, letter("next"), ctx())).toEqual({ kind: "rule", at: NOW, host: "lists.example" });
    expect(await unsubscribeMail(listed(letter("next")), ctx(), { db, ledger, now: NOW, post })).toMatchObject({ ok: false, status: 409 });
    expect(calls).toHaveLength(1);
    expect(archiveWhatArrives(db, listed(letter("next")), NOW)).toMatchObject({ ok: true });
    expect(listRules(db).map((r) => [r.match, r.value, r.action])).toEqual([["list", "<weekly.lists.example>", "archive"]]);
    expect(unsubscribeOffer(db, letter("next"), ctx())).toBeNull();
  });

  it("keeps the offer with the error when the POST fails, and never follows a redirect", async () => {
    archivedUnread(5);
    const ledger = new HandledLedger();
    const { calls, post } = fakePost([500, 302, new Error("connect ETIMEDOUT")]);
    expect(await unsubscribeMail(listed(letter("new")), ctx(), { db, ledger, now: NOW, post })).toEqual({ ok: false, status: 502, error: "The unsubscribe did not go through: lists.example answered HTTP 500." });
    expect(unsubscribeOffer(db, letter("new"), ctx())).toMatchObject({ kind: "one-click", failed: "lists.example answered HTTP 500" });
    expect(await unsubscribeMail(listed(letter("new")), ctx(), { db, ledger, now: NOW + 1, post })).toMatchObject({ ok: false, error: expect.stringContaining("redirect (HTTP 302)") });
    expect(await unsubscribeMail(listed(letter("new")), ctx(), { db, ledger, now: NOW + 2, post })).toMatchObject({ ok: false, error: expect.stringContaining("could not be reached: connect ETIMEDOUT") });
    expect(calls).toHaveLength(3);
    expect(queryMailLog(db, { actions: ["unsubscribe"] })).toEqual([]);
    expect(archiveWhatArrives(db, listed(letter("new")), NOW)).toMatchObject({ ok: false, status: 409 });
    const card = mailItems({ now: NOW, mail: [{ ...listed(letter("new")), area: null }], events: [], vips: new Set(), unsubscribe: new Map([["new", { kind: "one-click", url: "https://lists.example/u/abc123", host: "lists.example", dismissed: 5, failed: "lists.example answered HTTP 500" }]]) })[0];
    expect(card?.why).toContain("The last unsubscribe attempt failed: lists.example answered HTTP 500.");
    expect(card?.actions.find((a) => a.id === "mail.unsubscribe")).toMatchObject({ label: "Unsubscribe", target: "lists.example" });
  });

  it("never fetches a page unsubscribe and refuses an unsafe One-Click address before any request", async () => {
    archivedUnread(5);
    const { calls, post } = fakePost([]);
    const page = letter("new", { headers: { listId: "<weekly.lists.example>", listUnsubscribe: "<https://lists.example/u/1>" } });
    expect(await unsubscribeMail(listed(page), ctx(), { db, ledger: new HandledLedger(), now: NOW, post })).toMatchObject({ ok: false, status: 409 });
    const local = letter("local", { headers: { listId: "<weekly.lists.example>", listUnsubscribe: "<https://10.0.0.5/u>", listUnsubscribePost: "List-Unsubscribe=One-Click" } });
    expect(await unsubscribeMail(listed(local), ctx(), { db, ledger: new HandledLedger(), now: NOW, post })).toMatchObject({ ok: false, status: 422, error: expect.stringContaining("IP address") });
    expect(calls).toEqual([]);
  });
});

describe("Desk cards and API", () => {
  const post = (body: unknown): Request => new Request("http://localhost/api/desk/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const desk = (mails: SourceMail[]) => {
    for (const m of mails) saveClassification(db, m.id, { category: "bulk", reason: "A newsletter.", predictedAction: "archive" }, "test", NOW);
    const options: DeskOptions = MOVE_DESK;
    const rt: DeskRuntime = { options, ledger: new HandledLedger(), sourceCache: new SourceCache(async () => JSON.stringify({ items: mails })) };
    return { rt, view: () => composeWith(db, options, rt, NOW) };
  };

  it("offers Unsubscribe on the card, sends it through the API, then offers the archive rule", async () => {
    archivedUnread(5);
    const { rt, view } = desk([letter("new")]);
    const card = (await view()).items.find((i) => i.key === "mail:new");
    expect(card?.actions.map((a) => a.id)).toEqual(["mail.unsubscribe", "mail.archive", "mail.trash"]);
    expect(card?.why).toContain("You archived or deleted 5 of its mails unread. It offers a one-click unsubscribe via lists.example.");
    const { calls, post: fake } = fakePost([204]);
    const res = await handleDeskMail(post({ action: "unsubscribe", key: "mail:new" }), db, rt, { now: () => NOW, post: fake });
    expect(await res.json()).toMatchObject({ ok: true });
    expect(calls).toEqual(["https://lists.example/u/abc123"]);
    const after = (await view()).items.find((i) => i.key === "mail:new");
    expect(after?.actions.map((a) => a.id)).toContain("mail.unsubscribe.rule");
    expect(after?.why).toContain("You unsubscribed");
    const rule = await handleDeskMail(post({ action: "unsubscribe.rule", key: "mail:new" }), db, rt, { now: () => NOW });
    expect(await rule.json()).toMatchObject({ ok: true });
    expect(listRules(db)).toHaveLength(1);
  });

  it("shows the page URL instead of fetching it, and offers nothing on a suspicious mail", async () => {
    archivedUnread(5);
    const page = letter("page", { headers: { listId: "<weekly.lists.example>", listUnsubscribe: "<mailto:leave@lists.example>" } });
    const phish = letter("phish", { from: { name: "Weekly News", address: "news@lists.example" }, headers: { listId: "<weekly.lists.example>", ...ONE_CLICK, authResults: { spf: "fail", dkim: "fail", dmarc: "fail" } } });
    const { rt, view } = desk([page, phish]);
    const v = await view();
    const card = v.items.find((i) => i.key === "mail:page");
    expect(card?.actions.find((a) => a.id === "mail.unsubscribe.page")).toMatchObject({ label: "Open unsubscribe page", url: "mailto:leave@lists.example" });
    expect(card?.detail.links).toContainEqual({ label: "Unsubscribe page: mailto:leave@lists.example", url: "mailto:leave@lists.example" });
    const suspicious = v.items.find((i) => i.key === "mail:phish");
    expect(suspicious?.suspicious).toBe(true);
    expect([...(suspicious?.actions ?? []), ...(suspicious?.more ?? [])].some((a) => a.id.startsWith("mail.unsubscribe"))).toBe(false);
    const { calls, post: fake } = fakePost([]);
    const res = await handleDeskMail(post({ action: "unsubscribe", key: "mail:phish" }), db, rt, { now: () => NOW, post: fake });
    expect(res.status).toBe(409);
    expect(calls).toEqual([]);
  });
});
