import { handleDeskMail } from "../api/desk-mail";
import { SourceCache } from "../desk/sources/command";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../db/init";
import { DEFAULT_SETTINGS } from "../../../balance";
import { saveBalanceState } from "../desk/balance-store";
import { mailYesFilter, readMailDecision, saveDecisionDraft, type MailDecision } from "../desk/mail-yes-filter";
import { MailClassifier, readClassifications, saveClassification, validateAnswer, type MailCommitment } from "../desk/classify";
import { mailItems } from "../desk/rank";
import type { DeskOptions } from "../desk/compose";
import { DEFAULT_YES_FILTER } from "../desk/studio/view";
import { draftReply, type ListedMail } from "../desk/mail-actions";
import { HandledLedger } from "../desk/actions";

const now = Date.parse("2026-11-01T12:00:00Z");
const mail: ListedMail = { kind: "mail", id: "request@example.org", sourceId: "constructor", account: "owned", from: { address: "sender@example.org" }, subject: "Take this on?", unread: true, receivedAt: new Date(now).toISOString() };
let db: ReturnType<typeof initDatabase>;
let dir: string;
let desk: DeskOptions;
const thread = (state: string) => `---\ntype: question\nareas: [lab]\nstate: ${state}\nopened: 2026-10-31\n---\n\n## Question\n\nPrivate existing commitment\n`;
beforeEach(() => {
  db = initDatabase(":memory:");
  dir = mkdtempSync(join(tmpdir(), "yes-filter-"));
  mkdirSync(join(dir, ".git")); mkdirSync(join(dir, "threads"));
  writeFileSync(join(dir, "threads", "active.md"), thread("active"));
  writeFileSync(join(dir, "threads", "parked.md"), thread("parked"));
  desk = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [{ id: "lab", label: "Lab", color: "#123456", repos: [], goals: [] }], sources: [], studio: { dir, maxActive: 5, yesFilter: ["A configured question?"] } };
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test("filter is shown only for an explicit request or invitation independent of ranking category", async () => {
  const yesFilter = await mailYesFilter(db, desk, now);
  for (const category of ["action", "reply", "meeting", "fyi", "bulk"] as const) {
    for (const commitment of [undefined, "unknown", "none", "request", "invitation"] as const) {
      const item = mailItems({ now, mail: [{ ...mail, area: null }], events: [], vips: new Set(), yesFilter, classified: new Map([[mail.id, { category, reason: "Reason", ...(commitment ? { commitment } : {}) }]]) })[0];
      expect(Boolean(item?.yesFilter)).toBe(commitment === "request" || commitment === "invitation");
      if (item?.yesFilter) expect(item.yesFilter.questions).toEqual(["A configured question?"]);
    }
  }
  const fallback = await mailYesFilter(db, { ...desk, studio: { dir, maxActive: 5, yesFilter: [] } }, now);
  expect(fallback.questions).toEqual([...DEFAULT_YES_FILTER]);
});

test("lists only active threads and current unfinished focus projects including prototype-named IDs", async () => {
  saveBalanceState(db, { outline: { id: "root", title: "Root", weight: 100, ordering: "parallel", children: [
    { id: "__proto__", title: "Current project", weight: 100, ordering: "parallel", children: [], focusMonth: "2026-11" },
    { id: "constructor", title: "Past project", weight: 100, ordering: "parallel", children: [], focusMonth: "2026-10" },
    { id: "done", title: "Completed", weight: 100, ordering: "parallel", children: [], focusMonth: "2026-11", done: true },
  ] }, settings: DEFAULT_SETTINGS, log: [], dayState: null, history: { deficits: {}, lastSurfaced: {} } });
  expect((await mailYesFilter(db, desk, now)).commitments).toEqual([{ kind: "thread", id: "active", label: "Private existing commitment" }, { kind: "project", id: "__proto__", label: "Current project" }]);
});

const decision = (): MailDecision => ({ requestId: crypto.randomUUID(), intent: "reply", commitment: { kind: "thread", id: "active", label: "Private existing commitment" } });
const records = () => db.query<{ binding: string; status: string }, []>("SELECT binding, status FROM desk_mail_decisions").all();
test("records actual choice and editable decline locally with the draft, never in writer payload; retries do not duplicate", async () => {
  const d = { ...decision(), intent: "decline" as const };
  const outgoing: string[] = [];
  const body = "Thank you. I cannot take this on.";
  const save = () => draftReply(mail, body, { config: { draft: ["owned-writer"], timeoutSeconds: 1 }, ledger: new HandledLedger(), now, run: async (_argv, stdin) => { outgoing.push(stdin); return { code: 0, stdout: "", stderr: "" }; } });
  const input = { db, desk, mail, body, decision: d, now, save };
  expect((await saveDecisionDraft(input)).ok).toBe(true);
  expect((await saveDecisionDraft(input)).ok).toBe(true);
  expect(outgoing).toHaveLength(1);
  expect(outgoing[0]).not.toContain("Private existing commitment");
  expect(records()[0]?.status).toBe("saved");
  expect(readMailDecision(db, mail.sourceId, mail.id)).toEqual({ status: "saved", intent: "decline", commitment: d.commitment });
  expect(readMailDecision(db, "another-source", mail.id)).toBeUndefined();
  expect(JSON.parse(records()[0]?.binding ?? "{}")).toMatchObject({ body, decision: d, source: "constructor" });
  expect((await mailYesFilter(db, desk, now)).commitments).toContainEqual({ kind: "thread", id: "active", label: "Private existing commitment" });
});

test("rejects stale, renamed and invented choices before a writer runs; records failure honestly", async () => {
  let calls = 0;
  const input = { db, desk, mail, body: "My reply", decision: decision(), now, save: async () => { calls++; return { ok: false as const, status: 502, error: "Owned writer refused" }; } };
  writeFileSync(join(dir, "threads", "active.md"), thread("parked"));
  expect((await saveDecisionDraft(input)).ok).toBe(false);
  expect(calls).toBe(0); expect(records()).toEqual([]);
  writeFileSync(join(dir, "threads", "active.md"), thread("active"));
  expect((await saveDecisionDraft({ ...input, decision: { ...input.decision, commitment: { kind: "thread", id: "active", label: "Forged label" } } })).ok).toBe(false);
  expect((await saveDecisionDraft(input)).ok).toBe(false);
  expect(records()[0]?.status).toBe("uncertain");
  expect(calls).toBe(1);
});

test("concurrent saves dispatch once and timeout retry is blocked as uncertain", async () => {
  let calls = 0;
  const input = { db, desk, mail, body: "Reply", decision: decision(), now, save: async () => { calls++; await Promise.resolve(); return { ok: false as const, status: 504, error: "Check Drafts" }; } };
  await Promise.all([saveDecisionDraft(input), saveDecisionDraft(input)]);
  expect(calls).toBe(1);
  expect(records()[0]?.status).toBe("uncertain");
  expect((await saveDecisionDraft(input)).ok).toBe(false);
  expect(calls).toBe(1);
});

test("refreshes old cached answers once and persists validated explicit markers for both classifier transports", async () => {
  db.query("INSERT INTO desk_mail_classes VALUES (?, 'reply', NULL, 'Old answer', 'old', ?, NULL)").run(mail.id, now);
  for (const command of [true, false]) {
    db.query("UPDATE desk_mail_classes SET details = NULL").run();
    let calls = 0;
    const config = { timeoutSeconds: 1, maxPerPass: 1, ...(command ? { command: ["classifier"] } : { baseUrl: "https://example.org/v1", model: "model" }) };
    const c = new MailClassifier(config, async () => { calls++; return { category: "reply", commitment: "request", reason: "New request" }; }, () => {});
    await c.kick(db, { now, mail: [mail], events: [], vips: [] });
    await c.kick(db, { now, mail: [mail], events: [], vips: [] });
    expect(calls).toBe(1);
    expect(readClassifications(db, [mail.id]).get(mail.id)?.commitment).toBe("request");
  }
  for (const commitment of ["request", "invitation", "none", "unknown"] satisfies MailCommitment[]) {
    expect(validateAnswer({ category: "meeting", commitment, reason: "Evidence" }, new Set())?.commitment).toBe(commitment);
    saveClassification(db, mail.id, { category: "meeting", commitment, reason: "Evidence" }, "new", now);
    expect(readClassifications(db, [mail.id]).get(mail.id)?.commitment).toBe(commitment);
  }
  expect(validateAnswer({ category: "reply", commitment: "made-up", reason: "Bad" }, new Set())).toBeNull();
});


test("an exact saved retry returns its receipt after the selected commitment becomes inactive", async () => {
  let calls = 0;
  const input = { db, desk, mail, body: "Saved reply", decision: decision(), now, save: async () => { calls++; return { ok: true as const, message: "Saved once" }; } };
  expect((await saveDecisionDraft(input)).ok).toBe(true);
  writeFileSync(join(dir, "threads", "active.md"), thread("parked"));
  expect(await saveDecisionDraft(input)).toEqual({ ok: true, message: "Saved once" });
  expect(calls).toBe(1);
});


test("writer failures after invocation are uncertain and cannot be dispatched again", async () => {
  let calls = 0;
  const input = { db, desk, mail, body: "Reply", decision: decision(), now, save: async () => { calls++; return { ok: false as const, status: 502, error: "Writer disconnected" }; } };
  await saveDecisionDraft(input);
  expect(records()[0]?.status).toBe("uncertain");
  await saveDecisionDraft(input);
  expect(calls).toBe(1);
});


test("mail route returns the saved immutable receipt after reclassification and source removal", async () => {
  const cache = new SourceCache(async () => JSON.stringify({ items: [mail] }));
  const options = { ...desk, sources: [{ id: mail.sourceId, command: ["owned-source"], everySeconds: 300, timeoutSeconds: 1 }], mailActions: { draft: ["owned-writer"], timeoutSeconds: 1 } };
  await cache.read(options.sources, now);
  const runtime = { options, sourceCache: cache, ledger: new HandledLedger() };
  saveClassification(db, mail.id, { category: "reply", commitment: "request", reason: "Owned request" }, "owned", now);
  const body = { action: "draft", key: `mail:${mail.id}`, body: "Owned words", decision: decision() };
  const request = () => new Request("http://localhost/api/desk/mail", { method: "POST", body: JSON.stringify(body) });
  let calls = 0;
  const deps = { now: () => now, run: async () => { calls++; return { code: 0, stdout: "", stderr: "" }; } };
  expect((await handleDeskMail(request(), db, runtime, deps)).status).toBe(200);
  writeFileSync(join(dir, "threads", "active.md"), thread("parked"));
  saveClassification(db, mail.id, { category: "fyi", commitment: "none", reason: "Changed" }, "owned", now);
  expect((await handleDeskMail(request(), db, { ...runtime, sourceCache: new SourceCache(async () => "{}") }, deps)).status).toBe(200);
  expect(calls).toBe(1);
});
