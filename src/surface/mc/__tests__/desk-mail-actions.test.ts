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
    expect(r.calls).toEqual([{ argv: TRASH, stdin: JSON.stringify({ action: "trash", account: "work", messageId: "g1@gitlab.example" }), timeoutMs: 20_000 }]);
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

describe("Unimportant on a mail item", () => {
  it("lists the sender, sorts this mail as bulk and ranks it low", async () => {
    const rt = await deskWith([GITLAB, BOSS]);
    const before = (await view(rt)).items.find((i) => i.key === "mail:g1@gitlab.example");
    const res = await handleDeskMail(post({ action: "unimportant", key: "mail:g1@gitlab.example" }), db, rt, { now: () => NOW });
    expect(await res.json()).toEqual({ ok: true, message: "Mail from GitLab counts as bulk from now on. You can change this in Settings." });
    expect(listSenders(db, "unimportant").map((s) => [s.address, s.label])).toEqual([["gitlab@gitlab.example", "GitLab"]]);
    expect(readClassifications(db, ["g1@gitlab.example"]).get("g1@gitlab.example")?.category).toBe("bulk");
    const after = (await view(rt)).items.find((i) => i.key === "mail:g1@gitlab.example");
    expect(after?.why).toBe("You marked mail from this sender unimportant.");
    expect(after?.actions[0]?.id).toBe("mail.seen");
    expect(after?.actions.some((a) => a.id === "mail.unimportant")).toBe(false);
    expect(after?.score).toBeLessThanOrEqual(before?.score ?? 0);
  });

  it("refuses a VIP, because VIP wins", async () => {
    addVip(db, "@example.org", null, NOW);
    const rt = await deskWith([BOSS]);
    const res = await handleDeskMail(post({ action: "unimportant", key: "mail:b1@example.org" }), db, rt);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Ada Boss is on your VIP list, and VIPs always show. Remove them there first.");
    expect(listSenders(db, "unimportant")).toEqual([]);
  });
});

describe("the classifier and unimportant senders", () => {
  const CONFIG = { baseUrl: "https://llm.example/v1", model: "chat-fast", timeoutSeconds: 5, maxPerPass: 10 };
  const listed = (m: SourceMail) => ({ ...m, sourceId: "work-mail" });

  it("sorts later mail from an unimportant sender as bulk without calling the model, but asks about a VIP on the same domain", async () => {
    const seen: ClassifierRequest[] = [];
    const c = new MailClassifier(CONFIG, async (req) => { seen.push(req); return { category: "action", reason: "Asks for a budget." }; }, () => undefined);
    const next = mail("g2@gitlab.example", "gitlab@gitlab.example");
    const vip = mail("v1@gitlab.example", "lead@gitlab.example");
    await c.kick(db, { now: NOW, mail: [listed(next), listed(vip)], events: [], vips: ["lead@gitlab.example"], unimportant: ["@gitlab.example"] });
    expect(seen.map((r) => r.mail.id)).toEqual(["v1@gitlab.example"]);
    expect(seen[0]?.unimportant).toEqual(["@gitlab.example"]);
    const sorted = readClassifications(db, ["g2@gitlab.example", "v1@gitlab.example"]);
    expect(sorted.get("g2@gitlab.example")).toEqual({ category: "bulk", reason: "You marked mail from this sender unimportant." });
    expect(sorted.get("v1@gitlab.example")?.category).toBe("action");
    const model = db.query<{ model: string }, [string]>("SELECT model FROM desk_mail_classes WHERE message_id = ?").get("g2@gitlab.example")?.model;
    expect(model).toBe(UNIMPORTANT_MODEL);
  });

  it("tells the model about the unimportant list", () => {
    const [system, user] = buildMessages({ mail: { id: "x", from: { address: "a@b.ch" }, subject: "s", firstParagraph: "", receivedAt: "2026-10-31T08:00:00.000Z" }, meetings: [], vips: [], unimportant: ["@gitlab.example"] });
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
