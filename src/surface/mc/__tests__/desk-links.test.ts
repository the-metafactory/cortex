import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskMail } from "../api/desk-mail";
import { handleDeskMyDay } from "../api/desk-my-day";
import { DEFAULT_SETTINGS, type AppState } from "../../../balance";
import { HandledLedger } from "../desk/actions";
import { loadBalanceState, saveBalanceState } from "../desk/balance-store";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { activeMailLink, linkedMailIds, linkStudioMail, offDeskIds, readLink } from "../desk/links";
import { historySentence, queryMailLog } from "../desk/mail-log";
import { createRule, pendingRuleMail } from "../desk/mail-rules";
import { SourceCache, type SourceMail } from "../desk/sources/command";
import { initDatabase } from "../db/init";
import { composeWith, mailDesk } from "./desk-mail-fixtures";

const at = (day: number, hour = 10): number => new Date(2026, 10, day, hour).getTime();
const NOW = at(4);
const REQUEST = "0f3c1a52-6c1e-4b8f-9d2a-1f0e5b7c9a11";

const task = (id: string, title: string, done = false) => ({ id, title, weight: 50, ordering: "parallel" as const, children: [], effort: 1 as const, ...(done ? { done: true } : {}) });
const seed = (): AppState => ({
  outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [{ id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: [task("kickoff", "Kickoff prep"), task("shipped", "Ship the deck", true)] }] },
  settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null,
});

const mail = (id: string, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id, from: { name: "Ada Lovelace", address: "ada@example.org" }, subject: "Venue quote", receivedAt: new Date(at(4, 9)).toISOString(), unread: true, account: "work", url: `message://${id}`, ...over,
});

const options: DeskOptions = { ...mailDesk({ move: ["/opt/desk-mail-move.ts"], timeoutSeconds: 20 }), areas: [{ id: "work", label: "Work", color: "", repos: [], goals: [] }] };

let db: Database;
let ids = 0;
beforeEach(() => {
  db = initDatabase(":memory:");
  saveBalanceState(db, seed());
  ids = 0;
});
afterEach(() => db.close());

const runtime = (items: SourceMail[]): DeskRuntime => ({ options, ledger: new HandledLedger(), sourceCache: new SourceCache(async () => JSON.stringify({ items })) });
const post = (body: unknown): Request => new Request("http://localhost/api/desk/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const act = async (rt: DeskRuntime, body: unknown, now = NOW): Promise<{ status: number; json: Record<string, unknown> }> => {
  await rt.sourceCache?.read(options.sources, now);
  const res = await handleDeskMail(post(body), db, rt, { now: () => now, newId: () => `link-${++ids}` });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
};
const attach = (rt: DeskRuntime, id = "kickoff", requestId = REQUEST, key = "mail:m1") => act(rt, { action: "attach", key, requestId, to: { kind: "task", id } });
const myDay = async (rt: DeskRuntime, now = NOW) => (await handleDeskMyDay(new Request("http://localhost/api/desk/my-day"), db, rt, undefined, now)).json() as Promise<{ links: unknown[] }>;

describe("attach a mail to a task", () => {
  it("writes one link, answers with it, and a replay returns the same link", async () => {
    const rt = runtime([mail("m1")]);
    const first = await attach(rt);
    expect(first).toEqual({ status: 200, json: {
      ok: true, message: "Attached “Venue quote” to “Kickoff prep”.",
      link: { id: "link-1", from: { kind: "mail", key: "mail:m1", title: "Venue quote" }, to: { kind: "task", key: "kickoff", title: "Kickoff prep" }, origin: "desk", at: NOW },
    } });
    expect(await attach(rt)).toEqual(first);
    expect(db.query("SELECT COUNT(*) AS n FROM desk_links").get()).toEqual({ n: 1 });
    expect(queryMailLog(db, {}).map((e) => [e.messageId, e.action, e.where, e.folder])).toEqual([["m1", "attach", "desk", "Kickoff prep"]]);
    const [logged] = queryMailLog(db, {});
    if (!logged) throw new Error("no log entry");
    expect(historySentence(logged, NOW)).toStartWith("You attached it to “Kickoff prep” (");
  });

  it("takes the card off the Desk, leaves the mailbox alone, and lists the link with the task in My day", async () => {
    const rt = runtime([mail("m1"), mail("m2", { subject: "Other" })]);
    await attach(rt);
    const desk = await composeWith(db, options, rt, NOW);
    expect(desk.items.map((i) => i.key).filter((k) => k.startsWith("mail:"))).toEqual(["mail:m2"]);
    expect(rt.ledger.has("move:archive:m1")).toBe(false);
    expect((await myDay(rt)).links).toEqual([{
      id: "link-1", from: { kind: "mail", key: "mail:m1", title: "Venue quote" }, to: { kind: "task", key: "kickoff", title: "Kickoff prep" }, origin: "desk", at: NOW,
      mail: { sender: "ada@example.org", senderName: "Ada Lovelace", receivedAt: new Date(at(4, 9)).toISOString(), url: "message://m1", account: "work" },
    }]);
    expect(loadBalanceState(db)?.outline.children[0]?.children[0]?.note).toBeUndefined();
  });

  it("keeps an attached mail out of rule passes and the off-Desk set", async () => {
    createRule(db, { match: "sender", value: "ada@example.org", action: "archive" }, NOW, () => "rule-1");
    const rt = runtime([mail("m1")]);
    expect(pendingRuleMail(db, [mail("m1")]).size).toBe(1);
    await attach(rt);
    expect(pendingRuleMail(db, [mail("m1")]).size).toBe(0);
    expect([...linkedMailIds(db)]).toEqual(["m1"]);
    expect([...offDeskIds(db)]).toEqual(["m1"]);
  });

  it("refuses a second attachment, a done task, a missing task and an unlisted mail", async () => {
    const rt = runtime([mail("m1"), mail("m2")]);
    await attach(rt);
    expect(await attach(rt, "kickoff", "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed")).toEqual({ status: 409, json: { ok: false, error: "This mail is already attached to “Kickoff prep”. Undo that first." } });
    expect(await attach(rt, "shipped", "2c9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", "mail:m2")).toEqual({ status: 409, json: { ok: false, error: "That task no longer exists or is done. Pick another one." } });
    expect(await attach(rt, "nope", "3d9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", "mail:m2")).toEqual({ status: 409, json: { ok: false, error: "That task no longer exists or is done. Pick another one." } });
    expect(await attach(rt, "kickoff", "4e9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", "mail:gone")).toEqual({ status: 409, json: { ok: false, error: "The Desk no longer lists this mail." } });
    expect(await act(rt, { action: "attach", key: "mail:m2", requestId: "not-a-uuid", to: { kind: "task", id: "kickoff" } })).toMatchObject({ status: 400 });
    expect(activeMailLink(db, "m2")).toBeNull();
  });
});

describe("a thread link racing an attach", () => {
  it("keeps the first link and does not throw", async () => {
    await attach(runtime([mail("m1")]));
    const listed = { ...mail("m1"), sourceId: "work-mail" };
    expect(linkStudioMail(db, listed, { kind: "thread", key: "engines", title: "What can engines make?" }, { id: "capture-1", requestId: "capture-1", origin: "desk", now: NOW })).toBe(false);
    expect(activeMailLink(db, "m1")).toMatchObject({ id: "link-1", toKind: "task" });
  });
});

describe("undo an attach", () => {
  it("brings the card back, logs restore, and refuses a second undo", async () => {
    const rt = runtime([mail("m1")]);
    await attach(rt);
    expect(await act(rt, { action: "attach.undo", link: "link-1" })).toEqual({ status: 200, json: { ok: true, message: "“Venue quote” is back on the Desk.", restored: "mail:m1" } });
    expect(readLink(db, "link-1")?.state).toBe("undone");
    expect(queryMailLog(db, {}).map((e) => e.action).sort()).toEqual(["attach", "restore"]);
    expect((await composeWith(db, options, rt, NOW)).items.some((i) => i.key === "mail:m1")).toBe(true);
    expect((await myDay(rt)).links).toEqual([]);
    expect(await act(rt, { action: "attach.undo", link: "link-1" })).toEqual({ status: 409, json: { ok: false, error: "That is already undone." } });
    expect(await act(rt, { action: "attach.undo", link: "link-9" })).toEqual({ status: 404, json: { ok: false, error: "The Desk has no record of that link." } });
  });

  it("says nothing returns when the mail left the inbox", async () => {
    await attach(runtime([mail("m1")]));
    expect(await act(runtime([]), { action: "attach.undo", link: "link-1" })).toEqual({ status: 200, json: { ok: true, message: "The link to “Kickoff prep” is gone. “Venue quote” is no longer in your inbox, so nothing returns." } });
  });
});

describe("a task that is removed", () => {
  it("marks the link lost and the mail comes back with the reason", async () => {
    const rt = runtime([mail("m1")]);
    await attach(rt);
    const state = seed();
    state.outline.children[0]?.children.splice(0, 1);
    saveBalanceState(db, state);
    expect((await myDay(rt)).links).toEqual([]);
    expect(readLink(db, "link-1")?.state).toBe("linked");
    const back = (await composeWith(db, options, rt, at(4, 11))).items.find((i) => i.key === "mail:m1");
    expect(readLink(db, "link-1")).toMatchObject({ state: "lost", reason: "“Kickoff prep” was removed" });
    expect(back?.why.startsWith("Back because “Kickoff prep” was removed.")).toBe(true);
    expect(back?.back).toEqual({ line: "Back because “Kickoff prep” was removed.", at: at(4, 11) });
  });
});
