import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { handleDeskMail } from "../api/desk-mail";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleDeskSenders } from "../api/desk-vips";
import { HandledLedger } from "../desk/actions";
import { buildMessages, MailClassifier, readClassifications, UNIMPORTANT_MODEL, type ClassifierRequest } from "../desk/classify";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import { CommandTimeout } from "../desk/spawn";
import type { WriterResult } from "../desk/create";
import { mailItems } from "../desk/rank";
import { SourceCache, type SourceMail } from "../desk/sources/command";
import { addVip, listSenders } from "../desk/vips";
import { UNDO_WINDOW_MS } from "../desk/mail-move";
import { createEnrollment, writeEnrollment } from "../../../common/step-up/enrollment";
import { McSchema } from "../../../common/types/config";
import { DEFAULT_CONFIG } from "../config";
import { initDatabase } from "../db/init";
import { startServer } from "../server";

const NOW = Date.parse("2026-10-31T09:00:00.000Z");

const mail = (id: string, address: string, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id, from: { name: "GitLab", address }, subject: `Pipeline ${id}`, receivedAt: "2026-10-31T08:00:00.000Z", unread: true,
  url: `message://%3C${id}%3E`, account: "work", ...over,
});

const GITLAB = mail("g1@gitlab.example", "gitlab@gitlab.example");
const BOSS = mail("b1@example.org", "boss@example.org", { from: { name: "Ada Boss", address: "boss@example.org" }, subject: "Budget" });

const TRASH = ["/opt/adapters/bin/desk-mail-trash.ts"];
const TRASHED_G1 = [{ argv: TRASH, stdin: JSON.stringify({ action: "trash", account: "work", messageId: "g1@gitlab.example" }), timeoutMs: 20_000 }];

const DESK: DeskOptions = {
  enabled: true, displayName: "Ada", topN: 5, rangerUrl: "", areas: [],
  sources: [{ id: "work-mail", command: ["desk-mail"], everySeconds: 300, timeoutSeconds: 30 }],
  mailActions: { trash: TRASH, timeoutSeconds: 20 },
};

const sourceCache = (mails: SourceMail[]) => new SourceCache(async () => JSON.stringify({ items: mails }));

function recorder(result: WriterResult | Error = { code: 0, stdout: "", stderr: "" }) {
  const calls: { argv: string[]; stdin: string; timeoutMs: number }[] = [];
  return {
    calls,
    run: async (argv: string[], stdin: string, timeoutMs: number): Promise<WriterResult> => {
      calls.push({ argv, stdin, timeoutMs });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const post = (body: unknown): Request =>
  new Request("http://localhost/api/desk/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let db: Database;
const storedClass = (id: string) => db.query<{ category: string; model: string }, [string]>("SELECT category, model FROM desk_mail_classes WHERE message_id = ?").get(id);
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

async function deskWith(mails: SourceMail[], desk: DeskOptions = DESK): Promise<DeskRuntime> {
  const rt: DeskRuntime = { options: desk, ledger: new HandledLedger(), sourceCache: sourceCache(mails) };
  await view(rt);
  return rt;
}

const view = (rt: DeskRuntime) => composeDesk(db, rt.options ?? DESK, undefined, { now: NOW, handled: rt.ledger, ...(rt.sourceCache ? { sourceCache: rt.sourceCache } : {}) });
const itemKeys = async (rt: DeskRuntime) => (await view(rt)).items.map((i) => i.key);

describe("Delete on a mail item", () => {
  it("runs the trash command with the listed account and Message-ID, then takes the item off the Desk", async () => {
    const rt = await deskWith([GITLAB, BOSS]);
    const r = recorder();
    const res = await handleDeskMail(post({ action: "trash", key: "mail:g1@gitlab.example" }), db, rt, { run: r.run, now: () => NOW });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: "Moved to Trash." });
    expect(r.calls).toEqual(TRASHED_G1);
    expect(await itemKeys(rt)).toEqual(["mail:b1@example.org"]);
  });

  it("keeps the item and says why in one line when the command refuses", async () => {
    const rt = await deskWith([GITLAB]);
    const r = recorder({ code: 3, stdout: "", stderr: "warning: slow server\nThe message is no longer in the work INBOX.\n" });
    const res = await handleDeskMail(post({ action: "trash", key: "mail:g1@gitlab.example" }), db, rt, { run: r.run, now: () => NOW });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "The message is no longer in the work INBOX." });
    expect(await itemKeys(rt)).toEqual(["mail:g1@gitlab.example"]);
  });

  it("says the mail may have moved when the command times out, and keeps the item", async () => {
    const rt = await deskWith([GITLAB]);
    const res = await handleDeskMail(post({ action: "trash", key: "mail:g1@gitlab.example" }), db, rt, { run: recorder(new CommandTimeout("timed out after 20 s")).run });
    expect(res.status).toBe(504);
    expect((await res.json()).error).toBe("The trash command timed out after 20 s. The mail may have moved; check Trash.");
    expect(await itemKeys(rt)).toEqual(["mail:g1@gitlab.example"]);
  });

  it("refuses a mail the Desk does not list, a second send, and a stack without a trash command, before anything runs", async () => {
    const rt = await deskWith([GITLAB]);
    const r = recorder();
    const unknown = await handleDeskMail(post({ action: "trash", key: "mail:someone-else@example.org" }), db, rt, { run: r.run });
    expect(unknown.status).toBe(409);
    expect((await unknown.json()).error).toBe("The Desk no longer lists this mail.");
    expect(r.calls).toHaveLength(0);

    expect((await handleDeskMail(post({ action: "trash", key: "mail:g1@gitlab.example" }), db, rt, { run: r.run })).status).toBe(200);
    const again = await handleDeskMail(post({ action: "trash", key: "mail:g1@gitlab.example" }), db, rt, { run: r.run });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("This mail is already in Trash.");
    expect(r.calls).toHaveLength(1);

    const { mailActions: _off, ...plain } = DESK;
    const off = await deskWith([GITLAB], plain);
    const refused = await handleDeskMail(post({ action: "trash", key: "mail:g1@gitlab.example" }), db, off, { run: r.run });
    expect((await refused.json()).error).toBe("Deleting mail is not set up on this stack.");
    expect(r.calls).toHaveLength(1);
  });

  it("refuses a mail whose source names no account", async () => {
    const { account: _none, ...bare } = GITLAB;
    const rt = await deskWith([bare]);
    const r = recorder();
    const res = await handleDeskMail(post({ action: "trash", key: "mail:g1@gitlab.example" }), db, rt, { run: r.run });
    expect(res.status).toBe(409);
    expect(r.calls).toHaveLength(0);
  });

  it("reads mc.desk.mail.actions from the stack config", () => {
    const parsed = McSchema.parse({ desk: { mail: { actions: { trash: TRASH } } } });
    expect(parsed.desk.mail.actions).toEqual({ trash: TRASH, timeoutSeconds: 30 });
    expect(McSchema.safeParse({ desk: { mail: { actions: { trash: [] } } } }).success).toBe(false);
  });
});

describe("the actions on a mail item", () => {
  const ids = (m: SourceMail, category?: "fyi" | "bulk" | "action", trash = true) => {
    const [item] = mailItems({
      now: NOW, mail: [{ ...m, area: null, sourceId: "work-mail" }], events: [], vips: new Set(["boss@example.org"]), trash,
      ...(category ? { classified: new Map([[m.id, { category, reason: "Sorted." }]]) } : {}),
    });
    return { card: item?.actions.map((a) => `${a.id}:${a.role}`), more: item?.more?.map((a) => a.id) };
  };

  it("leads with a one-click \"Seen, delete\" on fyi and bulk mail", () => {
    for (const category of ["fyi", "bulk"] as const) {
      expect(ids(GITLAB, category).card).toEqual(["mail.seen:primary", "open:secondary", "mail.unimportant:secondary"]);
    }
  });

  it("keeps Open in Mail first and Delete secondary on mail that wants something", () => {
    expect(ids(GITLAB, "action")).toEqual({ card: ["open:primary", "mail.trash:secondary", "mail.unimportant:secondary"], more: ["vip.add", "snooze"] });
    expect(ids(GITLAB).card).toEqual(["open:primary", "mail.trash:secondary", "mail.unimportant:secondary"]);
  });

  it("offers no Delete without a trash command, and no Unimportant for a VIP", () => {
    expect(ids(GITLAB, "bulk", false).card).toEqual(["open:primary", "mail.unimportant:secondary", "snooze:secondary"]);
    expect(ids(BOSS, "action").card).toEqual(["open:primary", "mail.trash:secondary", "snooze:secondary"]);
  });
});

describe("Draft a reply on a mail item", () => {
  const DRAFT = ["/opt/adapters/bin/desk-mail-draft.ts"];
  const DRAFTING: DeskOptions = { ...DESK, mailActions: { trash: TRASH, draft: DRAFT, timeoutSeconds: 20 } };
  const press = (rt: DeskRuntime, run: ReturnType<typeof recorder>["run"], body: unknown = "Thanks, Friday works.") =>
    handleDeskMail(post({ action: "draft", key: "mail:b1@example.org", body }), db, rt, { run, now: () => NOW });

  it("runs the draft command with the listed account, sender and a Re: subject, and keeps the item on the Desk", async () => {
    const rt = await deskWith([BOSS], DRAFTING);
    const r = recorder({ code: 0, stdout: "{\"id\":\"d1@example.org\"}", stderr: "" });
    const res = await press(rt, r.run);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: "Reply saved in your work Drafts." });
    expect(r.calls).toEqual([{
      argv: DRAFT,
      stdin: JSON.stringify({ action: "draft", account: "work", messageId: "b1@example.org", to: "boss@example.org", subject: "Re: Budget", body: "Thanks, Friday works." }),
      timeoutMs: 20_000,
    }]);
    expect(await itemKeys(rt)).toEqual(["mail:b1@example.org"]);
  });

  it("keeps the item and says what failed in one line when the command refuses", async () => {
    const rt = await deskWith([BOSS], DRAFTING);
    const r = recorder({ code: 1, stdout: "", stderr: "The work account has no Drafts mailbox.\n" });
    const res = await press(rt, r.run);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "The draft was not saved: The work account has no Drafts mailbox." });
    expect(await itemKeys(rt)).toEqual(["mail:b1@example.org"]);
  });

  it("refuses an empty reply, a missing body and a stack without a draft command before anything runs", async () => {
    const r = recorder();
    const rt = await deskWith([BOSS], DRAFTING);
    expect((await (await press(rt, r.run, "  \n")).json()).error).toBe("Write the reply first.");
    expect((await press(rt, r.run, 42)).status).toBe(400);
    const off = await deskWith([BOSS]);
    expect((await (await press(off, r.run)).json()).error).toBe("Drafting replies is not set up on this stack.");
    expect(r.calls).toHaveLength(0);
  });

  it("does not offer the action without a draft command or an account, and leads with it when the classifier suggests a reply", () => {
    const item = (m: SourceMail, draft: boolean, suggestedAction?: "reply") => mailItems({
      now: NOW, mail: [{ ...m, area: null, sourceId: "work-mail" }], events: [], vips: new Set(), trash: true, draft,
      ...(suggestedAction ? { classified: new Map([[m.id, { category: "reply" as const, reason: "Ada asks for a date.", suggestedAction }]]) } : {}),
    })[0];
    const all = (i: ReturnType<typeof item>) => [...(i?.actions ?? []), ...(i?.more ?? [])].map((a) => `${a.id}:${a.role}`);
    expect(all(item(BOSS, false))).not.toContain("mail.draft:secondary");
    expect(item(BOSS, false)?.reply).toBeUndefined();
    const { account: _none, ...bare } = BOSS;
    expect(all(item(bare, true)).some((a) => a.startsWith("mail.draft"))).toBe(false);
    expect(all(item(BOSS, true))).toContain("mail.draft:secondary");
    expect(item(BOSS, true)?.reply).toEqual({ to: "Ada Boss <boss@example.org>", subject: "Re: Budget" });
    expect(item(BOSS, true, "reply")?.actions.map((a) => `${a.id}:${a.role}`)).toEqual(["mail.draft:primary", "open:secondary", "mail.trash:secondary"]);
  });

  it("reads mc.desk.mail.actions.draft from the stack config", () => {
    expect(McSchema.parse({ desk: { mail: { actions: { draft: DRAFT } } } }).desk.mail.actions).toEqual({ draft: DRAFT, timeoutSeconds: 30 });
    expect(McSchema.safeParse({ desk: { mail: { actions: { draft: [] } } } }).success).toBe(false);
  });
});

describe("Unimportant on a mail item", () => {
  const press = (rt: DeskRuntime, run: ReturnType<typeof recorder>["run"]) =>
    handleDeskMail(post({ action: "unimportant", key: "mail:g1@gitlab.example" }), db, rt, { run, now: () => NOW });

  it("marks the sender, moves the mail to Trash like \"Seen, delete\", and the item stays gone on reload", async () => {
    const rt = await deskWith([GITLAB, BOSS]);
    const r = recorder();
    const res = await press(rt, r.run);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: "Moved to Trash. Mail from GitLab will be treated as unimportant." });
    expect(listSenders(db, "unimportant").map((s) => [s.address, s.label])).toEqual([["gitlab@gitlab.example", "GitLab"]]);
    expect(storedClass("g1@gitlab.example")).toEqual({ category: "bulk", model: UNIMPORTANT_MODEL });
    expect(r.calls).toEqual(TRASHED_G1);
    expect(await itemKeys(rt)).toEqual(["mail:b1@example.org"]);
  });

  it("keeps the sender marked and the item listed, and says why in one line, when the trash command refuses", async () => {
    const rt = await deskWith([GITLAB]);
    const res = await press(rt, recorder({ code: 3, stdout: "", stderr: "The message is no longer in the work INBOX.\n" }).run);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "Mail from GitLab will be treated as unimportant, but moving it to Trash failed: The message is no longer in the work INBOX." });
    expect(listSenders(db, "unimportant").map((s) => s.address)).toEqual(["gitlab@gitlab.example"]);
    const after = (await view(rt)).items.find((i) => i.key === "mail:g1@gitlab.example");
    expect(after?.why).toBe("You marked mail from this sender unimportant.");
    expect(after?.actions[0]?.id).toBe("mail.seen");
  });

  it("only marks the sender without a trash command, and hides the mail like a trashed one", async () => {
    const { mailActions: _off, ...plain } = DESK;
    const rt = await deskWith([GITLAB, BOSS], plain);
    const r = recorder();
    const res = await press(rt, r.run);
    expect(await res.json()).toEqual({ ok: true, message: "Mail from GitLab will be treated as unimportant." });
    expect(r.calls).toHaveLength(0);
    expect(storedClass("g1@gitlab.example")).toEqual({ category: "bulk", model: UNIMPORTANT_MODEL });
    expect(await itemKeys(rt)).toEqual(["mail:b1@example.org"]);
  });

  it("lets go of the bulk verdict once the sender is removed in Settings, and the model sorts the mail again", async () => {
    const rt = await deskWith([GITLAB]);
    await press(rt, recorder({ code: 1, stdout: "", stderr: "IMAP is down." }).run);
    const del = new Request("http://localhost/api/desk/unimportant?address=gitlab%40gitlab.example", { method: "DELETE" });
    expect((await handleDeskSenders(del, new URL(del.url), db, "unimportant", NOW)).status).toBe(200);
    const after = (await view(rt)).items.find((i) => i.key === "mail:g1@gitlab.example");
    expect(after?.why).not.toContain("unimportant");
    expect(after?.actions.some((a) => a.id === "mail.unimportant")).toBe(true);
    const seen: string[] = [];
    const c = new MailClassifier({ baseUrl: "https://llm.example/v1", model: "chat-fast", timeoutSeconds: 5, maxPerPass: 10 }, async (req) => { seen.push(req.mail.id); return { category: "action", reason: "Asks for a fix." }; }, () => undefined);
    await c.kick(db, { now: NOW, mail: [{ ...GITLAB, sourceId: "work-mail" }], events: [], vips: [], unimportant: [] });
    expect(seen).toEqual(["g1@gitlab.example"]);
    expect(storedClass("g1@gitlab.example")).toEqual({ category: "action", model: "chat-fast" });
  });

  it("refuses a VIP, because VIP wins", async () => {
    addVip(db, "@example.org", null, NOW);
    const rt = await deskWith([BOSS]);
    const r = recorder();
    const res = await handleDeskMail(post({ action: "unimportant", key: "mail:b1@example.org" }), db, rt, { run: r.run });
    expect(res.status).toBe(409);
    expect(r.calls).toHaveLength(0);
    expect((await res.json()).error).toBe("Ada Boss is on your VIP list, and VIPs always show. Remove them there first.");
    expect(listSenders(db, "unimportant")).toEqual([]);
  });
});

describe("the classifier and unimportant senders", () => {
  const CONFIG = { baseUrl: "https://llm.example/v1", model: "chat-fast", timeoutSeconds: 5, maxPerPass: 10 };
  const listed = (m: SourceMail) => ({ ...m, sourceId: "work-mail" });

  it("never sends later mail from an unimportant sender to the model and ranks it bulk, but asks about a VIP on the same domain", async () => {
    const seen: ClassifierRequest[] = [];
    const c = new MailClassifier(CONFIG, async (req) => { seen.push(req); return { category: "action", reason: "Asks for a budget." }; }, () => undefined);
    const next = mail("g2@gitlab.example", "gitlab@gitlab.example");
    const vip = mail("v1@gitlab.example", "lead@gitlab.example");
    await c.kick(db, { now: NOW, mail: [listed(next), listed(vip)], events: [], vips: ["lead@gitlab.example"], unimportant: ["@gitlab.example"] });
    expect(seen.map((r) => r.mail.id)).toEqual(["v1@gitlab.example"]);
    expect(seen[0]?.unimportant).toEqual(["@gitlab.example"]);
    const classified = readClassifications(db, ["g2@gitlab.example", "v1@gitlab.example"]);
    expect(classified.get("v1@gitlab.example")?.category).toBe("action");
    const items = mailItems({ now: NOW, mail: [next, vip].map((m) => ({ ...m, area: null, sourceId: "work-mail" })), events: [], vips: new Set(["lead@gitlab.example"]), unimportant: new Set(["@gitlab.example"]), classified, trash: true });
    expect(items.map((i) => [i.key, i.why, i.actions[0]?.id])).toEqual([
      ["mail:g2@gitlab.example", "You marked mail from this sender unimportant.", "mail.seen"],
      ["mail:v1@gitlab.example", "GitLab is on your VIP list. Asks for a budget.", "open"],
    ]);
  });

  it("tells the model about the unimportant list", () => {
    const [system, user] = buildMessages({ mail: { id: "x", from: { address: "a@b.ch" }, subject: "s", firstParagraph: "", receivedAt: "2026-10-31T08:00:00.000Z" }, meetings: [], vips: [], unimportant: ["@gitlab.example"], corrections: [] });
    expect(system?.content).toContain("the senders they marked unimportant");
    expect(JSON.parse(user?.content ?? "{}").unimportant).toEqual(["@gitlab.example"]);
  });
});

describe("the unimportant senders API", () => {
  const req = (method: string, path: string, body?: unknown) =>
    new Request(`http://localhost${path}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const call = (r: Request) => handleDeskSenders(r, new URL(r.url), db, "unimportant", NOW);

  it("adds, lists and removes a sender, and refuses what is not an address or a domain", async () => {
    expect(await (await call(req("POST", "/api/desk/unimportant", { address: "GitLab.example" }))).json()).toEqual({ unimportant: [{ address: "@gitlab.example", label: null, addedAt: NOW }] });
    expect((await call(req("POST", "/api/desk/unimportant", { address: "not a sender" }))).status).toBe(400);
    expect(await (await call(req("GET", "/api/desk/unimportant"))).json()).toEqual({ unimportant: [{ address: "@gitlab.example", label: null, addedAt: NOW }] });
    expect(await (await call(req("DELETE", "/api/desk/unimportant?address=%40gitlab.example"))).json()).toEqual({ unimportant: [] });
    const missing = await call(req("DELETE", "/api/desk/unimportant?address=%40gitlab.example"));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("not on the unimportant list");
  });
});

describe("the mail action route through Mission Control", () => {
  let tmpDir: string;
  let fileDb: Database;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `mc-desk-mail-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    fileDb = initDatabase(join(tmpDir, "test.db"));
  });
  afterEach(() => {
    fileDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("moves a mail for the principal without a step-up code, and refuses another identity before the command runs", async () => {
    const secretPath = join(tmpDir, "step-up-totp.json");
    writeEnrollment(secretPath, createEnrollment("2026-10-16T00:00:00.000Z"));
    const source = join(tmpDir, "desk-mail");
    writeFileSync(source, `#!/bin/sh\necho '${JSON.stringify({ items: [GITLAB] })}'\n`, { mode: 0o755 });
    const marker = join(tmpDir, "trash-calls");
    const trash = join(tmpDir, "desk-mail-trash");
    writeFileSync(trash, `#!/bin/sh\ncat >> ${marker}\n`, { mode: 0o755 });
    const ctx = startServer(
      { ...DEFAULT_CONFIG, port: 0, governance: { principals: ["principal@example.com"], stepUp: { secretPath } } },
      fileDb,
      { desk: { ...DESK, sources: [{ id: "work-mail", command: [source], everySeconds: 300, timeoutSeconds: 10 }], mailActions: { trash: [trash], timeoutSeconds: 10 } } },
    );
    const base = `http://localhost:${ctx.server.port}`;
    const send = (email: string) => fetch(`${base}/api/desk/mail`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, "Cf-Access-Authenticated-User-Email": email },
      body: JSON.stringify({ action: "trash", key: "mail:g1@gitlab.example" }),
    });
    try {
      expect((await fetch(`${base}/api/desk`)).status).toBe(200);
      const stranger = await send("unlisted@example.com");
      expect(stranger.status).toBe(403);
      expect(existsSync(marker)).toBe(false);

      const ok = await send("principal@example.com");
      expect(ok.status).toBe(200);
      expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ action: "trash", account: "work", messageId: "g1@gitlab.example" });
    } finally {
      ctx.stop(true);
    }
  });
});

const MOVE = ["/opt/adapters/bin/desk-mail-move.ts"];
const MOVING: DeskOptions = { ...DESK, mailActions: { move: MOVE, timeoutSeconds: 20 } };
const printed = (folder: string, message: string): WriterResult => ({ code: 0, stdout: `${JSON.stringify({ id: "g1@gitlab.example", folder, message })}\n`, stderr: "" });

function queue(results: (WriterResult | Error)[] = []) {
  const calls: { argv: string[]; stdin: unknown }[] = [];
  return {
    calls,
    run: async (argv: string[], stdin: string): Promise<WriterResult> => {
      calls.push({ argv, stdin: JSON.parse(stdin) });
      const next = results.shift() ?? { code: 0, stdout: "", stderr: "" };
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

let moves = 0;
const send = (rt: DeskRuntime, body: unknown, run: ReturnType<typeof queue>["run"], now = NOW) =>
  handleDeskMail(post(body), db, rt, { run, now: () => now, newId: () => `move-${++moves}` });

describe("Archive, Spam and Delete through one move command", () => {
  it("archives: the command gets the target, the receipt names the folder, the item leaves and Done for you offers Undo", async () => {
    const rt = await deskWith([GITLAB, BOSS], MOVING);
    const r = queue([printed("Archiv", "Moved to Archiv.")]);
    const res = await send(rt, { action: "move", key: "mail:g1@gitlab.example", target: "archive" }, r.run);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, message: "Moved to Archiv.", undo: expect.stringMatching(/^move-\d+$/) });
    expect(r.calls).toEqual([{ argv: MOVE, stdin: { action: "move", account: "work", messageId: "g1@gitlab.example", target: "archive" } }]);
    expect(db.query("SELECT folder FROM desk_mail_moves").get()).toEqual({ folder: "Archiv" });
    expect(await itemKeys(rt)).toEqual(["mail:b1@example.org"]);
    const done = (await view(rt)).autonomy.done;
    expect(done).toEqual([{ key: `mail-move:${body.undo}`, action: "mail.move", undo: body.undo, title: "Archived: “Pipeline g1@gitlab.example”", message: "Moved to Archiv.", at: NOW, ok: true }]);
  });

  it("sends Delete and the legacy trash request through the move command once it is set", async () => {
    const rt = await deskWith([GITLAB], MOVING);
    const r = queue([printed("Deleted Items", "Moved to Deleted Items.")]);
    const res = await send(rt, { action: "trash", key: "mail:g1@gitlab.example" }, r.run);
    expect(await res.json()).toMatchObject({ ok: true, message: "Moved to Deleted Items." });
    expect(r.calls[0]?.stdin).toEqual({ action: "move", account: "work", messageId: "g1@gitlab.example", target: "trash" });
  });

  it("falls back to the legacy trash command for Delete only, without Undo, and refuses Archive and Spam there", async () => {
    const rt = await deskWith([GITLAB]);
    const r = queue();
    const archive = await send(rt, { action: "move", key: "mail:g1@gitlab.example", target: "archive" }, r.run);
    expect(archive.status).toBe(409);
    expect((await archive.json()).error).toBe("Archiving mail is not set up on this stack.");
    expect((await (await send(rt, { action: "move", key: "mail:g1@gitlab.example", target: "junk" }, r.run)).json()).error).toBe("Moving mail to Junk is not set up on this stack.");
    expect(r.calls).toEqual([]);
    expect(await (await send(rt, { action: "move", key: "mail:g1@gitlab.example", target: "trash" }, r.run)).json()).toEqual({ ok: true, message: "Moved to Trash." });
    expect(r.calls).toEqual([{ argv: TRASH, stdin: { action: "trash", account: "work", messageId: "g1@gitlab.example" } }]);
    expect((await view(rt)).autonomy.done).toEqual([]);
  });

  it("keeps the item and shows the command's refusal, which names the account and target", async () => {
    const rt = await deskWith([GITLAB], MOVING);
    const r = queue([{ code: 1, stdout: "", stderr: "The work account has no Archive mailbox, so nothing was moved.\n" }]);
    const res = await send(rt, { action: "move", key: "mail:g1@gitlab.example", target: "archive" }, r.run);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("The work account has no Archive mailbox, so nothing was moved.");
    expect(await itemKeys(rt)).toEqual(["mail:g1@gitlab.example"]);
    expect((await view(rt)).autonomy.done).toEqual([]);
  });

  it("says the mail may have moved on a timeout, and refuses a second move of a moved mail before anything runs", async () => {
    const rt = await deskWith([GITLAB], MOVING);
    const slow = await send(rt, { action: "move", key: "mail:g1@gitlab.example", target: "junk" }, queue([new CommandTimeout("timed out after 20 s")]).run);
    expect(slow.status).toBe(504);
    expect((await slow.json()).error).toBe("The move command timed out after 20 s. The mail may have moved; check Junk.");
    const r = queue();
    expect((await send(rt, { action: "move", key: "mail:g1@gitlab.example", target: "archive" }, r.run)).status).toBe(200);
    const again = await send(rt, { action: "move", key: "mail:g1@gitlab.example", target: "trash" }, r.run);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("This mail is already in Archive.");
    expect(r.calls).toHaveLength(1);
  });

  it("refuses an unknown target before anything runs", async () => {
    const rt = await deskWith([GITLAB], MOVING);
    const r = queue();
    expect((await send(rt, { action: "move", key: "mail:g1@gitlab.example", target: "INBOX" }, r.run)).status).toBe(400);
    expect(r.calls).toEqual([]);
  });
});

describe("Undo of a move", () => {
  it("moves the mail back to INBOX by Message-ID, brings the item back and marks the Done for you line undone", async () => {
    const rt = await deskWith([GITLAB], MOVING);
    const r = queue([printed("Junk", "Moved to Junk."), printed("INBOX", "Moved back to INBOX from Junk.")]);
    const { undo } = await (await send(rt, { action: "move", key: "mail:g1@gitlab.example", target: "junk" }, r.run)).json();
    expect(await itemKeys(rt)).toEqual([]);
    const res = await send(rt, { action: "undo", move: undo }, r.run);
    expect(await res.json()).toEqual({ ok: true, message: "Moved back to INBOX from Junk.", restored: "mail:g1@gitlab.example" });
    expect(r.calls[1]).toEqual({ argv: MOVE, stdin: { action: "restore", account: "work", messageId: "g1@gitlab.example", from: "junk" } });
    expect(await itemKeys(rt)).toEqual(["mail:g1@gitlab.example"]);
    const [line] = (await view(rt)).autonomy.done;
    expect(line).toMatchObject({ action: "mail.move.undone", message: "Moved back to INBOX from Junk." });
    expect(line?.undo).toBeUndefined();

    const twice = await send(rt, { action: "undo", move: undo }, r.run);
    expect(twice.status).toBe(409);
    expect((await twice.json()).error).toBe("That move is already undone.");
    expect(r.calls).toHaveLength(2);
  });

  it("keeps the mail moved when the command refuses, and refuses an unknown or too old move before anything runs", async () => {
    const rt = await deskWith([GITLAB], MOVING);
    const r = queue([printed("Archiv", "Moved to Archiv."), { code: 1, stdout: "", stderr: "The message is no longer in the work Archiv." }]);
    const { undo } = await (await send(rt, { action: "move", key: "mail:g1@gitlab.example", target: "archive" }, r.run)).json();
    const refused = await send(rt, { action: "undo", move: undo }, r.run);
    expect(refused.status).toBe(502);
    expect((await refused.json()).error).toBe("The mail was not moved back: The message is no longer in the work Archiv.");
    expect(await itemKeys(rt)).toEqual([]);
    expect((await view(rt)).autonomy.done[0]?.undo).toBe(undo);

    expect((await send(rt, { action: "undo", move: "nope" }, r.run)).status).toBe(404);
    const old = await send(rt, { action: "undo", move: undo }, r.run, NOW + UNDO_WINDOW_MS + 1);
    expect((await old.json()).error).toBe("That move is too old to undo from the Desk. Move the mail back in your mail client.");
    expect(r.calls).toHaveLength(2);
  });
});

describe("Spam, and blocking the sender's domain as a second step", () => {
  it("offers the sender's domain with the receipt, and blocks it as @domain in the unimportant list", async () => {
    const rt = await deskWith([GITLAB], MOVING);
    const r = queue([printed("Junk", "Moved to Junk.")]);
    const moved = await (await send(rt, { action: "move", key: "mail:g1@gitlab.example", target: "junk" }, r.run)).json();
    expect(moved.block).toBe("@gitlab.example");
    expect(listSenders(db, "unimportant")).toEqual([]);
    const res = await send(rt, { action: "block", move: moved.undo }, r.run);
    expect(await res.json()).toEqual({ ok: true, message: "Blocked @gitlab.example: its mail now counts as unimportant. You can change this in Settings." });
    expect(listSenders(db, "unimportant").map((s) => s.address)).toEqual(["@gitlab.example"]);
    expect(r.calls).toHaveLength(1);
  });

  it("refuses to block a domain with a VIP on it, and a move that was not Spam", async () => {
    addVip(db, "ada@example.org", "Ada", NOW);
    const rt = await deskWith([BOSS, GITLAB], MOVING);
    const r = queue();
    const spam = await (await send(rt, { action: "move", key: "mail:b1@example.org", target: "junk" }, r.run)).json();
    const vip = await send(rt, { action: "block", move: spam.undo }, r.run);
    expect(vip.status).toBe(409);
    expect((await vip.json()).error).toBe("@example.org has a sender on your VIP list, and VIPs always show. Nothing was blocked.");
    const archived = await (await send(rt, { action: "move", key: "mail:g1@gitlab.example", target: "archive" }, r.run)).json();
    expect(archived.block).toBeUndefined();
    expect((await (await send(rt, { action: "block", move: archived.undo }, r.run)).json()).error).toBe("Only mail moved to Junk can block its sender's domain.");
    expect(listSenders(db, "unimportant")).toEqual([]);
  });
});

describe("a move the Desk cannot record", () => {
  it("says the mail moved and keeps it hidden, instead of reporting that the command did not run", async () => {
    const rt = await deskWith([GITLAB], MOVING);
    db.exec("DROP TABLE desk_mail_moves");
    const res = await send(rt, { action: "move", key: "mail:g1@gitlab.example", target: "archive" }, queue([printed("Archiv", "Moved to Archiv.")]).run);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toStartWith("The mail moved, but the Desk could not record it:");
    expect(await itemKeys(rt)).toEqual([]);
  });

  it("shows a restored mail again even when the Desk cannot record the Undo", async () => {
    const rt = await deskWith([GITLAB], MOVING);
    const r = queue([printed("Archiv", "Moved to Archiv."), printed("INBOX", "Moved back to INBOX from Archiv.")]);
    const { undo } = await (await send(rt, { action: "move", key: "mail:g1@gitlab.example", target: "archive" }, r.run)).json();
    db.exec("CREATE TRIGGER no_undo BEFORE UPDATE ON desk_mail_moves BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const res = await send(rt, { action: "undo", move: undo }, r.run);
    expect(res.status).toBe(500);
    expect(await itemKeys(rt)).toEqual(["mail:g1@gitlab.example"]);
  });

  it("refuses to block a sender address without a domain", async () => {
    const rt = await deskWith([mail("odd@x", "odd@", { from: { address: "odd@" } })], MOVING);
    const moved = await (await send(rt, { action: "move", key: "mail:odd@x", target: "junk" }, queue().run)).json();
    expect((await (await send(rt, { action: "block", move: moved.undo }, queue().run)).json()).error).toBe("The sender's address has no domain the Desk can block.");
    expect(listSenders(db, "unimportant")).toEqual([]);
  });
});

describe("the move actions on a mail card", () => {
  const card = (suggestedAction: "archive" | "reply" | undefined, moves: boolean, category: "fyi" | "action" = "action") => {
    const [item] = mailItems({
      now: NOW, mail: [{ ...GITLAB, area: null, sourceId: "work-mail" }], events: [], vips: new Set(), trash: true, archive: moves, spam: moves,
      classified: new Map([[GITLAB.id, { category, reason: "Sorted.", ...(suggestedAction ? { suggestedAction } : {}) }]]),
    });
    return { actions: [...(item?.actions ?? []), ...(item?.more ?? [])].map((a) => `${a.id}:${a.role}`), suggestion: item?.suggestion };
  };

  it("makes Archive the primary action when the classifier suggests archive, even on quiet mail", () => {
    expect(card("archive", true)).toEqual({ suggestion: "Suggested: archive", actions: ["mail.archive:primary", "open:secondary", "mail.trash:secondary", "vip.add:secondary", "mail.spam:secondary", "mail.unimportant:secondary", "snooze:secondary"] });
    const quiet = card("archive", true, "fyi").actions;
    expect(quiet.slice(0, 3)).toEqual(["mail.archive:primary", "open:secondary", "mail.trash:secondary"]);
    expect(quiet).not.toContain("mail.seen:primary");
  });

  it("offers Archive and Spam on every card with the move command, and drops the archive suggestion without it", () => {
    const plain = card(undefined, true).actions;
    expect(plain.slice(0, 3)).toEqual(["open:primary", "mail.archive:secondary", "mail.trash:secondary"]);
    expect(plain).toContain("mail.spam:secondary");
    const legacy = card("archive", false);
    expect(legacy.suggestion).toBeUndefined();
    expect(legacy.actions.some((a) => a.startsWith("mail.archive") || a.startsWith("mail.spam"))).toBe(false);
  });

  it("reads mc.desk.mail.actions.move from the stack config", () => {
    expect(McSchema.parse({ desk: { mail: { actions: { move: MOVE } } } }).desk.mail.actions).toEqual({ move: MOVE, timeoutSeconds: 30 });
    expect(McSchema.safeParse({ desk: { mail: { actions: { move: [] } } } }).success).toBe(false);
  });
});
