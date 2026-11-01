import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskMail } from "../api/desk-mail";
import { HandledLedger } from "../desk/actions";
import { setGrant } from "../desk/autonomy";
import { saveClassification, validateAnswer } from "../desk/classify";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import { createRule, pendingRuleMail, ruleFor, runMailRules, listRules } from "../desk/mail-rules";
import { orgDomain, suspicionContext, suspicionOf, type SuspectMail, type SuspicionContext } from "../desk/mail-suspicion";
import { mailItems } from "../desk/rank";
import { parseSourceOutput, SourceCache, type SourceMail, type SourceReading } from "../desk/sources/command";
import { addVip } from "../desk/vips";
import { McSchema } from "../../../common/types/config";
import { initDatabase } from "../db/init";
import { mailDesk, queue } from "./desk-mail-fixtures";

const NOW = Date.parse("2026-11-01T09:00:00.000Z");
const PASS = { spf: "pass", dkim: "pass", dmarc: "pass", dkimDomains: ["bank.example"] } as const;

const mail = (over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id: "m1@bank.example", from: { name: "Bank", address: "service@bank.example" }, subject: "Your statement", receivedAt: "2026-11-01T08:00:00.000Z", unread: true,
  url: "message://%3Cm1%40bank.example%3E", account: "work", headers: { authResults: { ...PASS, dkimDomains: [...PASS.dkimDomains] } }, ...over,
});

const ctx = (over: Partial<SuspicionContext> = {}): SuspicionContext => ({ vips: new Set(["ada@corp.example"]), vipNames: new Map([["ada lovelace", "Ada Lovelace"]]), ownDomains: ["own.example"], ...over });
const codes = (m: SuspectMail, c: SuspicionContext = ctx(), classifier = false) => suspicionOf(m, c, classifier).map((r) => r.code);

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

describe("the suspicion check", () => {
  it("leaves a clean, authenticated mail unflagged", () => {
    expect(suspicionOf(mail({ links: [{ text: "bank.example/login", href: "https://www.bank.example/login" }] }), ctx())).toEqual([]);
  });

  it("flags a DMARC failure", () => {
    const m = mail({ headers: { authResults: { spf: "pass", dkim: "pass", dmarc: "fail", dkimDomains: ["bank.example"] } } });
    expect(suspicionOf(m, ctx())).toEqual([{ code: "dmarc", text: "DMARC failed: bank.example did not authorize this mail." }]);
  });

  it("flags an SPF failure", () => {
    expect(codes(mail({ headers: { authResults: { spf: "fail", dkim: "pass", dkimDomains: ["bank.example"] } } }))).toEqual(["spf"]);
  });

  it("flags a failing DKIM signature even when SPF passed", () => {
    expect(codes(mail({ headers: { authResults: { spf: "pass", dkim: "fail" } } }))).toEqual(["dkim"]);
  });

  it("flags a DKIM signature missing for the From domain when nothing else vouches for the sender", () => {
    const signedByOther = mail({ headers: { authResults: { spf: "none", dkim: "pass", dkimDomains: ["mailer.example"] } } });
    expect(suspicionOf(signedByOther, ctx())[0]?.text).toBe("It is not signed by bank.example (DKIM), only by mailer.example, and nothing else vouches for the sender.");
    expect(codes(mail({ headers: { authResults: { spf: "neutral", dkim: "none" } } }))).toEqual(["dkim"]);
  });

  it("does not flag a missing DKIM signature when SPF passed for the From domain or DMARC passed, or when no verdicts were reported", () => {
    expect(codes(mail({ headers: { authResults: { spf: "pass", dkim: "none", spfDomain: "bounces.bank.example" } } }))).toEqual([]);
    expect(codes(mail({ headers: { authResults: {} } }))).toEqual([]);
    expect(codes(mail({ headers: { authResults: { dmarc: "pass", dkimDomains: [] } } }))).toEqual([]);
    expect(codes(mail({ headers: undefined }))).toEqual([]);
  });

  it("flags a missing DKIM signature when SPF passed only for another domain", () => {
    expect(codes(mail({ headers: { authResults: { spf: "pass", dkim: "none", spfDomain: "attacker.example" } } }))).toEqual(["dkim"]);
    expect(codes(mail({ headers: { authResults: { spf: "pass", dkim: "none" } } }))).toEqual(["dkim"]);
  });

  it("counts a signature from a subdomain of the From domain's organisation as the From domain's", () => {
    expect(codes(mail({ from: { address: "news@mail.bank.example" }, headers: { authResults: { spf: "none", dkimDomains: ["bank.example"] } } }))).toEqual([]);
  });

  it("flags a Reply-To at another domain, naming both domains", () => {
    const m = mail({ headers: { authResults: { ...PASS, dkimDomains: ["bank.example"] }, replyTo: "Bank Support <support@b4nk-help.example>" } });
    expect(suspicionOf(m, ctx())).toEqual([{ code: "reply-to", text: "Replies go to b4nk-help.example, not to bank.example, the domain it claims to come from." }]);
    expect(codes(mail({ headers: { authResults: { ...PASS, dkimDomains: ["bank.example"] }, replyTo: "help@support.bank.example" } }))).toEqual([]);
  });

  it("flags a display name that shows an own-domain address or name while the mail comes from elsewhere", () => {
    expect(codes(mail({ from: { name: "it@own.example", address: "it@bank.example" } }))).toEqual(["display-name"]);
    expect(codes(mail({ from: { name: "own.example IT desk", address: "it@bank.example" } }))).toEqual(["display-name"]);
    expect(codes(mail({ from: { name: "own.example IT desk", address: "it@own.example" }, headers: { authResults: { spf: "pass", dkimDomains: ["own.example"] } } }))).toEqual([]);
  });

  it("flags a display name that imitates a VIP by name or address", () => {
    expect(suspicionOf(mail({ from: { name: "Lovelace, Ada", address: "ada.lovelace@bank.example" } }), ctx())).toEqual([
      { code: "display-name", text: "The sender's name matches your VIP Ada Lovelace, but ada.lovelace@bank.example is not on your VIP list." },
    ]);
    expect(codes(mail({ from: { name: "ada@corp.example", address: "x@bank.example" } }))).toEqual(["display-name"]);
    expect(codes(mail({ from: { name: "Ada Lovelace", address: "ada@corp.example" }, headers: { authResults: { dmarc: "pass" } } }))).toEqual([]);
  });

  it("flags a link whose text names another domain than its target, as plain text", () => {
    const m = mail({ links: [
      { text: "https://www.bank.example/secure", href: "https://login.evil.example/b" },
      { text: "www.bank.example", href: "https://login.evil.example/c" },
      { text: "Click here", href: "https://tracker.example/x" },
    ] });
    expect(suspicionOf(m, ctx())).toEqual([{ code: "link", text: "A link shows www.bank.example but leads to login.evil.example." }]);
  });

  it("adds the classifier's judgment", () => {
    expect(suspicionOf(mail(), ctx(), true)).toEqual([{ code: "classifier", text: "The mail classifier judged it to look like phishing." }]);
  });

  it("finds the registrable domain of a host", () => {
    expect(orgDomain("a.b.example.co.uk")).toBe("example.co.uk");
    expect(orgDomain("mail.bank.example")).toBe("bank.example");
  });

  it("builds its context from the VIP table and ignores short VIP names", () => {
    addVip(db, "ada@corp.example", "Ada Lovelace", NOW);
    addVip(db, "bo@corp.example", "Bo", NOW);
    const c = suspicionContext(db, ["Own.Example"]);
    expect([...c.vipNames.values()]).toEqual(["Ada Lovelace"]);
    expect(c.ownDomains).toEqual(["own.example"]);
  });
});

describe("what a source may report for the check", () => {
  it("keeps valid links and DKIM signers and drops what does not fit, never the mail", () => {
    const out = parseSourceOutput(JSON.stringify({ items: [{
      kind: "mail", id: "x", from: { address: "a@b.example" }, subject: "s", receivedAt: "2026-11-01T08:00:00Z", unread: true,
      headers: { authResults: { spf: "pass", dkimDomains: ["b.example"] } },
      links: [{ text: "b.example", href: "https://b.example/" }, { text: "x", href: "javascript:alert(1)" }, { text: "", href: "https://c.example" }, "nope"],
    }] }));
    expect(out.mail[0]?.links).toEqual([{ text: "b.example", href: "https://b.example/" }]);
    expect(out.mail[0]?.headers?.authResults).toEqual({ spf: "pass", dkimDomains: ["b.example"] });
    const bad = parseSourceOutput(JSON.stringify({ items: [{ kind: "mail", id: "y", from: { address: "a@b.example" }, subject: "s", receivedAt: "2026-11-01T08:00:00Z", unread: true, headers: { authResults: { spf: "pass", dkimDomains: ["not a host", "b.example"], spfDomain: "not a host" } }, links: "nope" }] }));
    expect(bad.mail[0]?.headers?.authResults).toEqual({ spf: "pass", dkimDomains: ["b.example"] });
    expect(bad.mail[0]?.links).toBeUndefined();
  });

  it("reads the classifier's suspicious flag only when it is true", () => {
    expect(validateAnswer({ category: "fyi", reason: "r", suspicious: true }, new Set())?.suspicious).toBe(true);
    expect(validateAnswer({ category: "fyi", reason: "r", suspicious: "yes" }, new Set())?.suspicious).toBeUndefined();
  });
});

const listed = (m: SourceMail) => ({ ...m, area: null, sourceId: "work-mail" });

describe("a suspicious mail on the Desk", () => {
  const phish = mail({ headers: { authResults: { ...PASS, dkimDomains: ["bank.example"] }, replyTo: "x@evil.example" } });

  it("ranks as needing attention with Spam first, never as bulk, and lists every reason", () => {
    const classified = new Map([[phish.id, { category: "bulk" as const, reason: "A newsletter.", predictedAction: "archive" as const }]]);
    const [item] = mailItems({ now: NOW, mail: [listed(phish)], events: [], vips: new Set(), classified, archive: true, spam: true, trash: true, suspicion: ctx() });
    expect(item?.urgency).toBe("today");
    expect(item?.suspicious).toBe(true);
    expect(item?.why).toBe("This may be phishing: Replies go to evil.example, not to bank.example, the domain it claims to come from.");
    expect(item?.actions.map((a) => [a.id, a.role])).toEqual([["mail.spam", "primary"], ["open", "secondary"], ["detail", "secondary"]]);
    expect(item?.detail.suspicion).toEqual(["Replies go to evil.example, not to bank.example, the domain it claims to come from."]);
    expect(item?.detail.links.map((l) => l.url)).toEqual(["message://%3Cm1%40bank.example%3E"]);
    const [clean] = mailItems({ now: NOW, mail: [listed(mail())], events: [], vips: new Set(), classified: new Map([["m1@bank.example", { category: "bulk", reason: "A newsletter." }]]), spam: true, suspicion: ctx() });
    expect(clean?.urgency).toBe("waiting");
    expect(item && clean ? item.score > clean.score : false).toBe(true);
  });

  it("offers Report only when a report target is configured", () => {
    const [hidden] = mailItems({ now: NOW, mail: [listed(phish)], events: [], vips: new Set(), spam: true, suspicion: ctx() });
    const [shown] = mailItems({ now: NOW, mail: [listed(phish)], events: [], vips: new Set(), spam: true, report: true, suspicion: ctx() });
    expect([...(hidden?.actions ?? []), ...(hidden?.more ?? [])].some((a) => a.id === "mail.report")).toBe(false);
    expect(shown?.actions.map((a) => a.id)).toEqual(["mail.spam", "mail.report", "open"]);
  });

  it("is never handled by an automatic rule, nor kept from the classifier for one", async () => {
    const created = createRule(db, { match: "domain", value: "bank.example", action: "archive" }, NOW, () => "rule-bank");
    expect(created.ok).toBe(true);
    setGrant(db, "mail.rules", true, NOW);
    const rules = listRules(db);
    const context = suspicionContext(db, []);
    expect(ruleFor(rules, phish, context)).toBeUndefined();
    expect(ruleFor(rules, mail({ id: "ok@bank.example" }), context)?.id).toBe("rule-bank");
    const flaggedByModel = mail({ id: "model@bank.example" });
    saveClassification(db, flaggedByModel.id, { category: "fyi", reason: "r", suspicious: true }, "test", NOW);
    expect(pendingRuleMail(db, [phish, flaggedByModel, mail({ id: "ok@bank.example" })])).toEqual(new Set(["ok@bank.example"]));
    const q = queue([{ code: 0, stdout: JSON.stringify({ id: "x", folder: "Archive", message: "Moved." }), stderr: "" }]);
    const reading: SourceReading = { id: "work-mail", area: null, events: [], mail: [phish, flaggedByModel, mail({ id: "ok@bank.example" })], readAt: NOW, error: null, dropped: 0, problems: [] };
    const desk = mailDesk({ move: ["/opt/move"], timeoutSeconds: 20 });
    await runMailRules([reading], { db, mailActions: desk.mailActions, ledger: new HandledLedger(), run: q.run, now: () => NOW, config: { proposeAfter: 8, maxPerPass: 20, windowDays: 90 }, newId: () => "run-1" });
    expect(q.calls.map((c) => (c.stdin as { messageId: string }).messageId)).toEqual(["ok@bank.example"]);
  });
});

describe("Report", () => {
  const phish = mail({ headers: { replyTo: "x@evil.example" } });
  const post = (body: unknown): Request => new Request("http://localhost/api/desk/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const runtime = (desk: DeskOptions): DeskRuntime => ({ options: desk, ledger: new HandledLedger(), sourceCache: new SourceCache(async () => JSON.stringify({ items: [phish] })) });

  it("runs the report command with the listed account, Message-ID and target, and moves nothing", async () => {
    const desk: DeskOptions = { ...mailDesk({ move: ["/opt/move"], timeoutSeconds: 20 }), mailReport: { command: ["/opt/report"], to: "abuse@provider.example", timeoutSeconds: 15 } };
    const rt = runtime(desk);
    const view = await composeDesk(db, desk, undefined, { now: NOW, handled: rt.ledger, ...(rt.sourceCache ? { sourceCache: rt.sourceCache } : {}) });
    expect(view.items.find((i) => i.key === `mail:${phish.id}`)?.actions.map((a) => a.id)).toContain("mail.report");
    const q = queue([{ code: 0, stdout: JSON.stringify({ id: "d1", message: "Report draft saved in work Drafts." }), stderr: "" }]);
    const res = await handleDeskMail(post({ action: "report", key: `mail:${phish.id}` }), db, rt, { run: q.run, now: () => NOW });
    expect(await res.json()).toEqual({ ok: true, message: "Report draft saved in work Drafts." });
    expect(q.calls).toEqual([{ argv: ["/opt/report"], stdin: { action: "report", account: "work", messageId: phish.id, to: "abuse@provider.example" } }]);
  });

  it("is refused when no report target is configured, and when the command fails", async () => {
    const plain = runtime(mailDesk({ move: ["/opt/move"], timeoutSeconds: 20 }));
    await composeDesk(db, plain.options ?? mailDesk(undefined), undefined, { now: NOW, handled: plain.ledger, ...(plain.sourceCache ? { sourceCache: plain.sourceCache } : {}) });
    const refused = await handleDeskMail(post({ action: "report", key: `mail:${phish.id}` }), db, plain, { run: queue().run, now: () => NOW });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, error: "Reporting mail is not set up on this stack." });
    const desk: DeskOptions = { ...mailDesk(undefined), mailReport: { command: ["/opt/report"], timeoutSeconds: 15 } };
    const rt = runtime(desk);
    await composeDesk(db, desk, undefined, { now: NOW, handled: rt.ledger, ...(rt.sourceCache ? { sourceCache: rt.sourceCache } : {}) });
    const failed = await handleDeskMail(post({ action: "report", key: `mail:${phish.id}` }), db, rt, { run: queue([{ code: 1, stdout: "", stderr: "No Drafts folder." }]).run, now: () => NOW });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ ok: false, error: "The mail was not reported: No Drafts folder." });
  });

  it("is configured with a command and an optional address", () => {
    const parse = (report: unknown) => McSchema.safeParse({ desk: { mail: { report } } });
    expect(parse({ command: ["/opt/report"], to: "abuse@provider.example" }).success).toBe(true);
    expect(parse({ to: "abuse@provider.example" }).success).toBe(false);
    expect(parse({ command: ["/opt/report"], to: "not an address" }).success).toBe(false);
  });
});

describe("what counts as a link that shows a domain", () => {
  it("is a link whose whole text is a host or URL, not a file name or a sentence", () => {
    const linked = (text: string) => codes(mail({ links: [{ text, href: "https://elsewhere.example/x" }] }));
    expect(linked("bank.example")).toEqual(["link"]);
    expect(linked("https://bank.example:8443/login?x=1")).toEqual(["link"]);
    expect(linked("www.contributing.md")).toEqual(["link"]);
    expect(linked("contributing.md")).toEqual([]);
    expect(linked("Read more on bank.example")).toEqual([]);
  });
});

describe("a link-stuffed mail", () => {
  it("still keeps its first valid links instead of dropping the whole list", () => {
    const links = [...Array.from({ length: 300 }, () => "junk"), { text: "bank.example", href: "https://evil.example/" }];
    const early = [{ text: "bank.example", href: "https://evil.example/" }, ...Array.from({ length: 300 }, () => "junk")];
    const parse = (list: unknown[]) => parseSourceOutput(JSON.stringify({ items: [{ kind: "mail", id: "z", from: { address: "a@b.example" }, subject: "s", receivedAt: "2026-11-01T08:00:00Z", unread: true, links: list }] })).mail[0]?.links;
    expect(parse(early)).toEqual([{ text: "bank.example", href: "https://evil.example/" }]);
    expect(parse(links)).toEqual([{ text: "bank.example", href: "https://evil.example/" }]);
  });
});
