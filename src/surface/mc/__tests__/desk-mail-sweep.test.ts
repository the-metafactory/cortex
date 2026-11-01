import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskMail } from "../api/desk-mail";
import { HandledLedger } from "../desk/actions";
import { saveClassification, type MailClassification } from "../desk/classify";
import { composeDesk, type DeskRuntime } from "../desk/compose";
import type { WriterResult } from "../desk/create";
import { queryMailLog } from "../desk/mail-log";
import type { MoveDeps } from "../desk/mail-move";
import { buildSweeps, runSweep, undoSweep, type SweepGroup, type SweepInput, type SweepMember } from "../desk/mail-sweep";
import { SourceCache, type SourceMail } from "../desk/sources/command";
import { DAY_MS } from "../desk/time";
import { addVip } from "../desk/vips";
import { initDatabase } from "../db/init";
import { MOVE_DESK as DESK, NOW, queue } from "./desk-mail-fixtures";

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

const mail = (id: string, address: string, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id, from: { name: address.split("@")[0] ?? address, address }, subject: `Subject ${id}`, receivedAt: "2026-11-01T08:00:00.000Z", unread: true, account: "work", ...over,
});
const member = (m: SourceMail): SweepMember => ({ ...m, sourceId: "work-mail", area: null });
const archive = (over: Partial<MailClassification> = {}): MailClassification => ({ category: "bulk", reason: "A report.", predictedAction: "archive", ...over });
const input = (mails: SourceMail[], classified: Record<string, MailClassification>, over: Partial<SweepInput> = {}): SweepInput => ({
  now: NOW, mail: mails.map(member), classified: new Map(Object.entries(classified)), suspicion: { vips: new Set(), vipNames: new Map(), ownDomains: [] }, ...over,
});

const moved = (id: string): WriterResult => ({ code: 0, stdout: JSON.stringify({ id, folder: "Archive", message: "Moved to Archive." }), stderr: "" });
const refused = (line: string): WriterResult => ({ code: 3, stdout: "", stderr: line });

let ids = 0;
function moveDeps(results: (WriterResult | Error)[] = []) {
  const q = queue(results);
  const deps: MoveDeps = { db, config: DESK.mailActions, ledger: new HandledLedger(), run: q.run, now: NOW, newId: () => `id-${++ids}` };
  return { q, deps };
}

const REPORTS = ["r1", "r2", "r3"].map((id) => mail(id, "stats@otrs.example", { headers: { listId: "<stats.otrs.example>" } }));
const group = (members: SourceMail[]): SweepGroup => ({ id: "bundle:archive:x", kind: "bundle", basis: "list", target: "archive", label: "same mailing list", title: "3 mails from the stats list: archive all?", why: "", area: null, members: members.map(member) });
const doneRows = () => db.query<{ attempt_key: string; action: string; status: string; message: string }, []>("SELECT attempt_key, action, status, message FROM desk_done ORDER BY created_at, attempt_key").all();
const movedIds = (calls: { stdin: unknown }[]) => calls.map((c) => (c.stdin as { messageId: string }).messageId);

describe("sweep builder", () => {
  it("never includes a VIP's mail or mail flagged as suspicious", () => {
    const vip = mail("v1", "boss@corp.example", { headers: { listId: "<stats.otrs.example>" } });
    const flagged = mail("s1", "stats@otrs.example", { headers: { listId: "<stats.otrs.example>" } });
    const groups = buildSweeps(input([...REPORTS, vip, flagged], { r1: archive(), r2: archive(), r3: archive(), v1: archive(), s1: archive({ suspicious: true }) }, {
      suspicion: { vips: new Set(["boss@corp.example"]), vipNames: new Map(), ownDomains: [] },
    }));
    const members = groups.flatMap((g) => g.members.map((m) => m.id));
    expect(members).not.toContain("v1");
    expect(members).not.toContain("s1");
    expect(groups[0]).toMatchObject({ kind: "bundle", basis: "list", target: "archive" });
    expect(groups[0]?.members.map((m) => m.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("bundles by content similarity when vectors exist, across senders, and keeps unlike mail apart", () => {
    const a = mail("a", "one@x.example", { subject: "Weekly ITIL statistics" });
    const b = mail("b", "two@y.example", { subject: "Monthly ITIL statistics" });
    const c = mail("c", "three@z.example", { subject: "Lunch on Friday" });
    const vectors = new Map([["a", [1, 0, 0]], ["b", [0.95, 0.1, 0]], ["c", [0, 0, 1]]]);
    const groups = buildSweeps(input([a, b, c], { a: archive(), b: archive(), c: archive() }, { vectors, threshold: 0.8 }));
    expect(groups.map((g) => [g.basis, g.members.map((m) => m.id)])).toEqual([["similar", ["a", "b"]]]);
    expect(groups[0]?.title).toBe("2 mails like “Weekly ITIL statistics”: archive all?");
  });

  it("falls back to List-Id or sender when no vector is cached, and needs the same predicted move", () => {
    const junk = mail("j1", "stats@otrs.example", { headers: { listId: "<stats.otrs.example>" } });
    const groups = buildSweeps(input([...REPORTS, junk], { r1: archive(), r2: archive(), r3: archive(), j1: archive({ predictedAction: "junk" }) }));
    expect(groups.filter((g) => g.kind === "bundle").map((g) => [g.target, g.members.length])).toEqual([["archive", 3]]);
  });

  it("offers a category-and-age sweep and leaves out mail the Desk would answer", () => {
    const old = new Date(NOW - 5 * DAY_MS).toISOString();
    const fyi = ["f1", "f2", "f3", "f4"].map((id, i) => mail(id, `n${i}@news${i}.example`, { receivedAt: old }));
    const reply = mail("q1", "pal@friends.example", { receivedAt: old });
    const fresh = mail("f5", "n5@news5.example");
    const fyiClass = { category: "fyi" as const, reason: "Information." };
    const groups = buildSweeps(input([...fyi, reply, fresh], { f1: fyiClass, f2: fyiClass, f3: fyiClass, f4: fyiClass, f5: fyiClass, q1: { ...fyiClass, predictedAction: "reply" } }));
    const sweep = groups.find((g) => g.id === "sweep:age:fyi");
    expect(sweep?.title).toBe("4 fyi mails older than 3 days are still unread");
    expect(sweep?.members.map((m) => m.id)).toEqual(["f1", "f2", "f3", "f4"]);
  });
});

describe("sweep executor", () => {
  it("moves exactly the previewed mails, logs each, and writes one Done for you line", async () => {
    const { q, deps } = moveDeps([moved("r1"), moved("r2"), moved("r3")]);
    const r = await runSweep(group(REPORTS), ["mail:r1", "mail:r2", "mail:r3"], deps);
    expect(r).toMatchObject({ ok: true, moved: 3, failed: [], skipped: 0, message: "Archived 3 mails." });
    expect(movedIds(q.calls)).toEqual(["r1", "r2", "r3"]);
    expect(q.calls.every((c) => (c.stdin as { action: string; target: string }).action === "move" && (c.stdin as { target: string }).target === "archive")).toBe(true);
    expect(queryMailLog(db, {}).map((e) => [e.messageId, e.action, e.where]).sort()).toEqual([["r1", "archive", "desk"], ["r2", "archive", "desk"], ["r3", "archive", "desk"]]);
    expect(doneRows()).toEqual([{ attempt_key: "mail-sweep:id-1", action: "mail.sweep", status: "done", message: "Archived 3 mails." }]);
  });

  it("keeps a mail the principal unticked, and refuses keys that are not in the group", async () => {
    const { q, deps } = moveDeps([moved("r1"), moved("r3")]);
    const r = await runSweep(group(REPORTS), ["mail:r1", "mail:r3", "mail:boss@corp"], deps);
    expect(movedIds(q.calls)).toEqual(["r1", "r3"]);
    expect(r).toMatchObject({ ok: true, moved: 2, skipped: 1 });
    expect(deps.ledger.has("moved:archive:r2")).toBe(false);
  });

  it("lists the mails that did not move when one move fails", async () => {
    const { deps } = moveDeps([moved("r1"), refused("No message with that Message-ID in INBOX."), moved("r3")]);
    const r = await runSweep(group(REPORTS), ["mail:r1", "mail:r2", "mail:r3"], deps);
    expect(r).toMatchObject({ ok: true, moved: 2, failed: [{ subject: "Subject r2", error: "No message with that Message-ID in INBOX." }] });
    expect(r.ok && r.message).toBe("Archived 2 of 3. Not moved: “Subject r2” (No message with that Message-ID in INBOX).");
    expect(doneRows()[0]).toMatchObject({ action: "mail.sweep", status: "done" });
    expect(queryMailLog(db, {}).map((e) => e.messageId).sort()).toEqual(["r1", "r3"]);
  });

  it("undoes the whole sweep: every moved mail goes back, and Done for you marks it undone", async () => {
    const { q, deps } = moveDeps([moved("r1"), moved("r2"), moved("r3"), moved("r1"), refused("INBOX is not writable."), moved("r3"), moved("r2")]);
    const r = await runSweep(group(REPORTS), ["mail:r1", "mail:r2", "mail:r3"], deps);
    if (!r.ok) throw new Error(r.error);
    const partial = await undoSweep(r.sweep, deps);
    expect(partial).toMatchObject({ ok: true, message: "Moved 2 of 3 back to INBOX. Still moved: “Subject r2” (The mail was not moved back: INBOX is not writable). Undo again to retry." });
    expect(doneRows()[0]?.action).toBe("mail.sweep");
    const all = await undoSweep(r.sweep, deps);
    expect(all).toEqual({ ok: true, message: "Moved 3 mails back to INBOX." });
    const restores = q.calls.slice(3).map((c) => c.stdin as { action: string; messageId: string; from: string });
    expect(restores.map((c) => [c.action, c.messageId, c.from])).toEqual([["restore", "r1", "archive"], ["restore", "r2", "archive"], ["restore", "r3", "archive"], ["restore", "r2", "archive"]]);
    expect(doneRows()[0]).toMatchObject({ action: "mail.sweep.undone", message: "Moved 3 mails back to INBOX." });
    expect(queryMailLog(db, { actions: ["restore"] })).toHaveLength(3);
    expect(await undoSweep(r.sweep, deps)).toEqual({ ok: false, status: 409, error: "That sweep is already undone." });
  });
});

describe("sweeps on the Desk", () => {
  const sourceCache = (mails: SourceMail[]) => new SourceCache(async () => JSON.stringify({ items: mails }));
  const post = (body: unknown): Request => new Request("http://localhost/api/desk/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const VIP = mail("v1", "boss@corp.example", { headers: { listId: "<stats.otrs.example>" } });

  async function desk() {
    for (const m of [...REPORTS, VIP]) saveClassification(db, m.id, archive(), "test", NOW);
    addVip(db, "boss@corp.example", null, NOW);
    const rt: DeskRuntime = { options: DESK, ledger: new HandledLedger(), sourceCache: sourceCache([...REPORTS, VIP]) };
    const view = () => composeDesk(db, DESK, undefined, { now: NOW, handled: rt.ledger, ...(rt.sourceCache ? { sourceCache: rt.sourceCache } : {}) });
    return { rt, view };
  }

  it("shows a bundle at the top and does not repeat its mails as single cards", async () => {
    const { view } = await desk();
    const v = await view();
    expect(v.mailSweeps?.map((s) => [s.kind, s.mails.map((m) => m.key)])).toEqual([["bundle", ["mail:r1", "mail:r2", "mail:r3"]]]);
    expect(v.items.filter((i) => i.kind === "mail").map((i) => i.key)).toEqual(["mail:v1"]);
  });

  it("confirms through the API, never moves a VIP even when the page asks, and offers Undo for the sweep", async () => {
    const { rt, view } = await desk();
    const id = (await view()).mailSweeps?.[0]?.id ?? "";
    const q = queue([moved("r1"), moved("r3")]);
    const res = await handleDeskMail(post({ action: "sweep", sweep: id, keys: ["mail:r1", "mail:r3", "mail:v1"] }), db, rt, { run: q.run, now: () => NOW, newId: () => `sw-${++ids}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, moved: 2, skipped: 1 });
    expect(movedIds(q.calls)).toEqual(["r1", "r3"]);
    const after = await view();
    expect(after.mailSweeps).toEqual([]);
    expect(after.items.filter((i) => i.kind === "mail").map((i) => i.key).sort()).toEqual(["mail:r2", "mail:v1"]);
    const line = after.autonomy.done.find((d) => d.action === "mail.sweep");
    expect(line?.undo).toBeString();
  });

  it("refuses a group that changed since the preview", async () => {
    const { rt } = await desk();
    const res = await handleDeskMail(post({ action: "sweep", sweep: "bundle:archive:gone", keys: ["mail:r1"] }), db, rt, { run: queue().run, now: () => NOW });
    expect(res.status).toBe(409);
  });
});
