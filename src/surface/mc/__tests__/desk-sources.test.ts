import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { handleDeskVips } from "../api/desk-vips";
import { composeDesk, type DeskOptions } from "../desk/compose";
import { meetingFor, mailItems } from "../desk/rank";
import { parseSourceOutput, SourceCache, spawnCommand, type CommandRunner, type DeskSourceConfig, type SourceEvent, type SourceMail } from "../desk/sources/command";
import { addVip, isVip, listVips, normalizeVip } from "../desk/vips";

const NOW = new Date("2026-10-30T12:16:00").getTime();
const at = (hhmm: string, dayOffset = 0): string => new Date(new Date(`2026-10-30T${hhmm}:00`).getTime() + dayOffset * 86_400_000).toISOString();

const mail = (over: Partial<SourceMail> = {}): SourceMail & { area: string | null; sourceId: string } => ({
  kind: "mail", id: "m1@x", from: { name: "Ada Lovelace", address: "ada@example.org" },
  subject: "Budget", receivedAt: at("11:42"), unread: true, firstParagraph: "Could you look at the budget?",
  url: "message://%3Cm1%40x%3E", account: "work", area: "switch", sourceId: "work-mail", ...over,
});

const meeting = (title: string, hhmm: string, dayOffset = 0): SourceEvent & { sourceId: string } => ({ id: title, start: at(hhmm, dayOffset), title, sourceId: "work-calendar" });

describe("the source contract", () => {
  it("keeps valid events and mail and counts the entries it drops", () => {
    const parsed = parseSourceOutput(JSON.stringify({
      events: [{ id: "e1", start: at("13:00"), title: "DA results" }, { id: "e2", start: "not a date", title: "x" }],
      items: [mail(), { kind: "mail", id: "m2" }],
    }));
    expect(parsed.events.map((e) => e.id)).toEqual(["e1"]);
    expect(parsed.mail.map((m) => m.id)).toEqual(["m1@x"]);
    expect(parsed.dropped).toBe(2);
  });

  it("kills a command that runs past its timeout", async () => {
    await expect(spawnCommand(["sleep", "5"], 200)).rejects.toThrow("timed out");
  });

  it("returns on time even when the command's child keeps the output pipe open", async () => {
    const started = Date.now();
    await expect(spawnCommand(["bash", "-c", "sleep 5 & sleep 5"], 300)).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("drops links other than http, https and message", () => {
    const parsed = parseSourceOutput(JSON.stringify({
      events: [{ id: "a", start: at("13:00"), title: "ok", url: "https://teams.example" }, { id: "b", start: at("14:00"), title: "bad", url: "javascript:alert(1)" }],
      items: [mail({ url: "message://%3Cm%3E" }), mail({ id: "m2", url: "data:text/html,x" })],
    }));
    expect(parsed.events.map((e) => e.id)).toEqual(["a"]);
    expect(parsed.mail.map((m) => m.id)).toEqual(["m1@x"]);
    expect(parsed.dropped).toBe(2);
  });

  it("runs a source once per interval, shares a run between requests, and keeps the last reading on failure", async () => {
    let calls = 0;
    let fail = false;
    const runner: CommandRunner = async () => {
      calls += 1;
      if (fail) throw new Error("exited 1");
      return JSON.stringify({ events: [{ id: "e1", start: at("13:00"), title: "DA results" }] });
    };
    const cache = new SourceCache(runner);
    const source: DeskSourceConfig = { id: "cal", command: ["x"], area: "switch", everySeconds: 300, timeoutSeconds: 5 };
    const [a, b] = await Promise.all([cache.read([source], NOW), cache.read([source], NOW)]);
    expect(calls).toBe(1);
    expect(a[0]?.events).toHaveLength(1);
    expect(b[0]?.area).toBe("switch");
    await cache.read([source], NOW + 60_000);
    expect(calls).toBe(1);
    fail = true;
    const [served] = await cache.read([source], NOW + 301_000);
    expect(served?.readAt).toBe(NOW);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
    const [stale] = await cache.read([source], NOW + 302_000);
    expect(stale?.error).toBe("exited 1");
    expect(stale?.events).toHaveLength(1);
  });
});

describe("VIPs", () => {
  it("accepts an address or a domain and rejects the rest", () => {
    expect(normalizeVip(" Grace@Example.net ")).toBe("grace@example.net");
    expect(normalizeVip("example.org")).toBe("@example.org");
    expect(normalizeVip("@example.org")).toBe("@example.org");
    expect(normalizeVip("not an address")).toBeNull();
  });

  it("matches a sender by address or by domain", () => {
    const vips = new Set(["grace@example.net", "@example.com"]);
    expect(isVip(vips, "Grace@example.net")).toBe(true);
    expect(isVip(vips, "anyone@example.com")).toBe(true);
    expect(isVip(vips, "someone@example.net")).toBe(false);
  });
});

describe("mail on the Desk", () => {
  it("ranks unread VIP mail high, shows its first paragraph and opens it in Mail", () => {
    const [item] = mailItems({ now: NOW, mail: [mail()], events: [], vips: new Set(["ada@example.org"]) });
    expect(item).toMatchObject({ kind: "mail", urgency: "today", title: 'Ada Lovelace wrote: "Budget"', excerpt: "Could you look at the budget?", area: "switch" });
    expect(item?.why).toMatch(/^Ada Lovelace is on your VIP list\./);
    expect(item?.actions[0]).toMatchObject({ id: "open", label: "Open in Mail", url: "message://%3Cm1%40x%3E", wired: true });
    expect(item?.actions.some((a) => a.id === "vip.add")).toBe(false);
    expect(item?.score).toBeGreaterThan(70);
  });

  it("raises mail that seems to be about a meeting in the next three days", () => {
    const events = [meeting("Visit of the partner CISOs", "08:45", 3), meeting("CISO Forum agenda", "09:00", 1)];
    expect(meetingFor("Agenda for Monday's CISO visit", events, NOW)?.title).toBe("CISO Forum agenda");
    const [item] = mailItems({ now: NOW, mail: [mail({ from: { address: "coord@example.com" }, subject: "CISO forum: agenda" })], events, vips: new Set() });
    expect(item?.why).toBe('It may be about "CISO Forum agenda" tomorrow at 09:00.');
    expect(item?.more?.find((a) => a.id === "vip.add")).toMatchObject({ target: "coord@example.com", wired: true });
  });

  it("leaves read mail off the Desk and ranks other unread mail low", () => {
    const items = mailItems({ now: NOW, mail: [mail({ unread: false }), mail({ id: "m2", from: { address: "news@x.ch" }, subject: "Newsletter" })], events: [], vips: new Set() });
    expect(items.map((i) => i.key)).toEqual(["mail:m2"]);
    expect(items[0]?.score).toBeLessThan(20);
  });
});

describe("composeDesk with command sources", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  const DESK: DeskOptions = {
    enabled: true, displayName: "Ada", topN: 5, rangerUrl: "", areas: [],
    sources: [
      { id: "work-calendar", command: ["cal"], area: "switch", everySeconds: 300, timeoutSeconds: 5 },
      { id: "work-mail", command: ["mail"], area: "switch", everySeconds: 300, timeoutSeconds: 5 },
      { id: "broken", command: ["broken"], everySeconds: 300, timeoutSeconds: 5 },
    ],
  };
  const runner: CommandRunner = async ([cmd]) => {
    if (cmd === "cal") return JSON.stringify({ events: [meeting("DA results", "13:00"), { id: "f", start: at("00:00"), allDay: true, title: "Focus Day" }, meeting("Partner visit", "08:45", 3)] });
    if (cmd === "mail") return JSON.stringify({ items: [mail()] });
    throw new Error("exited 127");
  };

  it("puts today's meetings on the timeline, the next days ahead, VIP mail in the items, and a broken source in systems", async () => {
    addVip(db, "ada@example.org", "Ada", NOW);
    const view = await composeDesk(db, DESK, undefined, { now: NOW, sourceCache: new SourceCache(runner) });
    expect(view.today.map((e) => [e.title, e.kind, e.area])).toEqual([["Focus Day", "all-day", "switch"], ["DA results", "meeting", "switch"]]);
    expect(view.ahead.map((e) => e.title)).toEqual(["Partner visit"]);
    expect(view.items[0]).toMatchObject({ kind: "mail", title: 'Ada Lovelace wrote: "Budget"' });
    expect(view.vips).toEqual([{ address: "ada@example.org", label: "Ada" }]);
    expect(view.sources).toContainEqual({ id: "broken", ok: false, error: "exited 127" });
    expect(view.systems).toContain("The broken source is unreachable.");
  });

  it("says when a source sent entries the Desk could not read", async () => {
    const view = await composeDesk(db, { ...DESK, sources: [{ id: "odd", command: ["odd"], everySeconds: 300, timeoutSeconds: 5 }] }, undefined, {
      now: NOW, sourceCache: new SourceCache(async () => JSON.stringify({ events: [{ id: "x" }, { id: "y", start: "never", title: "y" }] })),
    });
    expect(view.sources).toContainEqual({ id: "odd", ok: true });
    expect(view.systems).toContain("The odd source sent 2 entries the Desk could not read.");
  });
});

describe("the VIP API", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });
  const call = (method: string, path: string, body?: unknown) =>
    handleDeskVips(new Request(`http://127.0.0.1${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), new URL(`http://127.0.0.1${path}`), db, NOW);

  it("adds, lists and removes VIPs, and refuses what is not an address", async () => {
    expect((await call("POST", "/api/desk/vips", { address: "nope" })).status).toBe(400);
    expect((await call("POST", "/api/desk/vips", { address: "Mary.Somerville@example.org", label: "Mary" })).status).toBe(200);
    expect(listVips(db)).toEqual([{ address: "mary.somerville@example.org", label: "Mary", addedAt: NOW }]);
    expect((await call("DELETE", "/api/desk/vips?address=someone@x.ch")).status).toBe(404);
    const removed = await call("DELETE", "/api/desk/vips?address=mary.somerville@example.org");
    expect(await removed.json()).toEqual({ vips: [] });
  });
});
