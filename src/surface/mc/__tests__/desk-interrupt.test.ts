import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { composeDesk, type DeskOptions } from "../desk/compose";
import { pushInterrupts, readDeliveries, startInterruptLoop, type DeskPush, type DeskTransport, type InterruptRules, type PushResult } from "../desk/interrupt";
import { discordTransport, pushText } from "../desk/transports";
import { notifyWithResult } from "../../../adapters/notify-result";
import { MockAdapter } from "../../../adapters/mock";
import type { PlatformAdapter } from "../../../adapters/types";
import { addNote } from "../desk/notes";
import { briefing, selectItems } from "../desk/present";
import { SourceCache, type CommandRunner } from "../desk/sources/command";
import type { RangerState } from "../desk/sources/ranger";
import { chimeIfNew, type ChimeAudio } from "../dashboard-v2/lib/desk-chime";
import { freshInterrupts, loadSeen, rememberSeen } from "../dashboard-v2/lib/desk-seen";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.parse("2026-10-31T09:00:00.000Z");
const MIN = 60_000;

const RULES: InterruptRules = { transport: "discord", meetingMinutes: 10, mail: true, reminders: true, maxAgeMinutes: 60, everySeconds: 60, chime: true, notifications: true };

const desk = (rules: InterruptRules = RULES, rangerUrl = ""): DeskOptions => ({
  enabled: true,
  displayName: "Ada",
  topN: 5,
  rangerUrl,
  areas: [],
  sources: [{ id: "cal", command: ["cal"], everySeconds: 300, timeoutSeconds: 5 }],
  interruptions: rules,
});

const calendar = (events: unknown[]): SourceCache => {
  const runner: CommandRunner = async () => JSON.stringify({ events });
  return new SourceCache(runner);
};

class FakeTransport implements DeskTransport {
  readonly id = "discord" as const;
  readonly sent: DeskPush[] = [];
  constructor(private readonly answer: PushResult = { status: "sent", ref: "m-1" }) {}
  async send(push: DeskPush): Promise<PushResult> {
    this.sent.push(push);
    return this.answer;
  }
}

describe("Desk interruptions", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  const standup = { id: "e1", start: new Date(NOW + 10 * MIN).toISOString(), title: "Stand-up", online: true, url: "https://meet.example/abc" };

  async function tick(transport: DeskTransport | null, at: number, options = desk(), cache = calendar([standup])) {
    const view = await composeDesk(db, options, undefined, { now: at, sourceCache: cache });
    return { view, pushed: await pushInterrupts(db, view.items, options.interruptions?.transport ?? "none", transport, at) };
  }

  it("pushes a meeting that starts in 10 minutes exactly once, in the item shape", async () => {
    const transport = new FakeTransport();
    const cache = calendar([standup]);
    const first = await tick(transport, NOW, desk(), cache);
    expect(first.pushed).toEqual([{ key: `meeting:cal:cal:e1@${NOW + 10 * MIN}`, status: "sent" }]);
    expect(transport.sent).toEqual([{
      key: `meeting:cal:cal:e1@${NOW + 10 * MIN}`,
      title: `"Stand-up" starts at ${new Date(NOW + 10 * MIN).toTimeString().slice(0, 5)}.`,
      why: "It starts in 10 minutes.",
      action: { label: "Join", url: "https://meet.example/abc" },
    }]);
    await tick(transport, NOW + MIN, desk(), cache);
    await tick(transport, NOW + 2 * MIN, desk(), cache);
    expect(transport.sent).toHaveLength(1);
    const later = await tick(transport, NOW + 3 * MIN, desk(), cache);
    expect(later.view.items[0]?.interrupt).toEqual({ delivery: "sent" });
    expect(readDeliveries(db).get(`meeting:cal:cal:e1@${NOW + 10 * MIN}`)?.ref).toBe("m-1");
  });

  it("keeps the push history in the MC db, so a restart does not push again", async () => {
    const path = join(tmpdir(), `desk-interrupt-${crypto.randomUUID()}.db`);
    const disk = initDatabase(path);
    const transport = new FakeTransport();
    const view = await composeDesk(disk, desk(), undefined, { now: NOW, sourceCache: calendar([standup]) });
    await pushInterrupts(disk, view.items, "discord", transport, NOW);
    disk.close();
    const reopened = initDatabase(path);
    const again = await composeDesk(reopened, desk(), undefined, { now: NOW + MIN, sourceCache: calendar([standup]) });
    expect(await pushInterrupts(reopened, again.items, "discord", transport, NOW + MIN)).toEqual([]);
    expect(transport.sent).toHaveLength(1);
    reopened.close();
    rmSync(path, { force: true });
  });

  it("does not push a meeting further out than the rule, nor one that has started", async () => {
    const transport = new FakeTransport();
    const cache = calendar([{ ...standup, id: "far", start: new Date(NOW + 30 * MIN).toISOString() }, { ...standup, id: "past", start: new Date(NOW - MIN).toISOString() }]);
    expect((await tick(transport, NOW, desk(), cache)).pushed).toEqual([]);
  });

  it("does not push a blocked agent that is not due today; it stays for the briefing", async () => {
    const ranger: RangerState = {
      current: [],
      needsYou: [{ key: "k", repo: "example/app", nodeId: "12", title: "Fix the login timeout", status: "parked", reason: { class: "blocked" } }],
      maps: [],
    };
    const transport = new FakeTransport();
    const options = desk(RULES, "http://127.0.0.1:7311");
    const view = await composeDesk(db, options, undefined, { now: NOW, sourceCache: calendar([]), fetchImpl: async () => Response.json(ranger) });
    expect(await pushInterrupts(db, view.items, "discord", transport, NOW)).toEqual([]);
    expect(transport.sent).toEqual([]);
    const blocked = view.items.find((i) => i.kind === "agent-blocked");
    expect(blocked?.interrupt).toBeUndefined();
    expect(briefing(view, selectItems(view, "all", new Set()), null).lines.join(" ")).toContain(blocked?.title ?? "missing");
  });

  it("shows the item as urgent and records the failed delivery when the transport fails, without retrying", async () => {
    addNote(db, "reminder", "Call Ada", NOW - 30 * MIN, NOW - 60 * MIN);
    const transport = new FakeTransport({ status: "failed", error: "Discord did not take the message (timeout)." });
    const cache = calendar([]);
    const first = await tick(transport, NOW, desk(), cache);
    expect(first.pushed).toEqual([{ key: "reminder:1", status: "failed" }]);
    const view = (await tick(transport, NOW + MIN, desk(), cache)).view;
    const reminder = view.items.find((i) => i.key === "reminder:1");
    expect(reminder?.urgency).toBe("now");
    expect(reminder?.score).toBeGreaterThanOrEqual(99);
    expect(reminder?.interrupt).toEqual({ delivery: "failed", error: "Discord did not take the message (timeout)." });
    expect(readDeliveries(db).get("reminder:1")?.status).toBe("failed");
    expect(transport.sent).toHaveLength(1);
  });

  it("records a buffered push and shows it as waiting, not urgent, without pushing again", async () => {
    addNote(db, "reminder", "Call Ada", NOW - MIN, NOW - 60 * MIN);
    const transport = new FakeTransport({ status: "buffered" });
    const cache = calendar([]);
    expect((await tick(transport, NOW, desk(), cache)).pushed).toEqual([{ key: "reminder:1", status: "buffered" }]);
    const second = await tick(transport, NOW + MIN, desk(), cache);
    expect(second.pushed).toEqual([]);
    const reminder = second.view.items.find((i) => i.key === "reminder:1");
    expect(reminder?.interrupt).toEqual({ delivery: "buffered" });
    expect(reminder?.score).toBeLessThan(99);
    expect(readDeliveries(db).get("reminder:1")).toMatchObject({ status: "buffered", error: null, ref: null });
    expect(transport.sent).toHaveLength(1);
  });

  it("records the message id of a delivered push", async () => {
    addNote(db, "reminder", "Call Ada", NOW - MIN, NOW - 60 * MIN);
    await tick(new FakeTransport({ status: "sent", ref: "m-42" }), NOW, desk(), calendar([]));
    expect(readDeliveries(db).get("reminder:1")).toMatchObject({ status: "sent", ref: "m-42", error: null });
  });

  it("records a failed delivery when no transport is running", async () => {
    addNote(db, "reminder", "Call Ada", NOW - MIN, NOW - 60 * MIN);
    await tick(null, NOW, desk(), calendar([]));
    expect(readDeliveries(db).get("reminder:1")).toMatchObject({ status: "failed", error: "No discord transport is running on this stack." });
  });

  it("pushes a reminder once it is due, and not one that was due before the age limit", async () => {
    addNote(db, "reminder", "Call Ada", NOW + MIN, NOW - 60 * MIN);
    addNote(db, "reminder", "Old one", NOW - 2 * 60 * MIN, NOW - 3 * 60 * MIN);
    const transport = new FakeTransport();
    const cache = calendar([]);
    expect((await tick(transport, NOW, desk(), cache)).pushed).toEqual([]);
    expect((await tick(transport, NOW + 2 * MIN, desk(), cache)).pushed).toEqual([{ key: "reminder:1", status: "sent" }]);
    expect((await tick(transport, NOW + 3 * MIN, desk(), cache)).pushed).toEqual([]);
    expect(transport.sent.map((p) => p.title)).toEqual(["Call Ada"]);
  });

  it("marks interruptions but pushes nothing when the transport is none", async () => {
    const transport = new FakeTransport();
    const off = { ...RULES, transport: "none" as const };
    const { view, pushed } = await tick(transport, NOW, desk(off));
    expect(pushed).toEqual([]);
    expect(view.items[0]?.interrupt).toEqual({ delivery: "off" });
    expect(readDeliveries(db).size).toBe(0);
  });

  it("chimes once per new interrupting item, and not at all with chime off", async () => {
    const { view } = await tick(new FakeTransport(), NOW);
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const fresh = freshInterrupts(view, loadSeen(storage, "desk.chimed"));
    expect(fresh).toEqual([`meeting:cal:cal:e1@${NOW + 10 * MIN}`]);
    rememberSeen(storage, "desk.chimed", loadSeen(storage, "desk.chimed"), fresh);
    expect(freshInterrupts(view, loadSeen(storage, "desk.chimed"))).toEqual([]);
    const silent = new Map<string, string>();
    const running = { state: "running" } as unknown as ChimeAudio;
    expect(await chimeIfNew({ ...view, chime: false }, { store: { getItem: (k) => silent.get(k) ?? null, setItem: (k, v) => void silent.set(k, v) }, audio: () => running })).toBe(false);
    expect(silent.size).toBe(0);
  });

  it("plays the chime through Web Audio, and keeps the item unchimed while the browser holds audio back", async () => {
    const { view } = await tick(new FakeTransport(), NOW);
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const tones: number[] = [];
    const audio = (state: AudioContextState): ChimeAudio => {
      const node = { connect: (next: unknown) => next, gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined } };
      return {
        state,
        currentTime: 0,
        destination: {},
        resume: async () => undefined,
        createGain: () => node,
        createOscillator: () => ({ ...node, type: "sine", frequency: { set value(v: number) { tones.push(v); } }, start: () => undefined, stop: () => undefined }),
      } as unknown as ChimeAudio;
    };
    expect(await chimeIfNew(view, { store: storage, audio: () => audio("suspended"), wait: 5 })).toBe(false);
    expect(store.size).toBe(0);
    expect(await chimeIfNew(view, { store: storage, audio: () => audio("running") })).toBe(true);
    expect(tones).toEqual([880, 1318.5]);
    expect(await chimeIfNew(view, { store: storage, audio: () => audio("running") })).toBe(false);
    expect(tones).toHaveLength(2);
  });

  it("pushes mail from a VIP, and not ordinary mail", async () => {
    db.query("INSERT INTO desk_vips (address, label, added_at) VALUES (?, ?, ?)").run("boss@example.com", "Boss", NOW);
    const mail = (id: string, address: string) => ({ kind: "mail", id, from: { name: id, address }, subject: `Hello ${id}`, receivedAt: new Date(NOW - 5 * MIN).toISOString(), unread: true });
    const runner: CommandRunner = async () => JSON.stringify({ items: [mail("vip", "boss@example.com"), mail("plain", "someone@example.com")] });
    const transport = new FakeTransport();
    const { pushed } = await tick(transport, NOW, desk(), new SourceCache(runner));
    expect(pushed).toEqual([{ key: "mail:vip", status: "sent" }]);
  });

  it("shows a push that never finished as failed once it is stuck", async () => {
    const key = `meeting:cal:cal:e1@${NOW + 10 * MIN}`;
    db.query("INSERT INTO desk_deliveries (item_key, transport, status, title, created_at, updated_at) VALUES (?, 'discord', 'sending', 't', ?, ?)").run(key, NOW - 6 * MIN, NOW - 6 * MIN);
    const transport = new FakeTransport();
    const { view, pushed } = await tick(transport, NOW);
    expect(pushed).toEqual([]);
    expect(view.items[0]?.interrupt?.delivery).toBe("failed");
    expect(view.items[0]?.urgency).toBe("now");
  });
});

describe("the Discord transport", () => {
  it("drops an action link that could break out of the autolink", () => {
    expect(pushText({ key: "k", title: "t", why: "w", action: { label: "Join", url: "https://x.example/a>[evil](https://e)" } })).toBe("**t**\nw");
    expect(pushText({ key: "k", title: "t", why: "w", action: { label: "Join", url: "javascript:alert(1)" } })).toBe("**t**\nw");
  });

  it("writes the item shape and keeps markdown in titles inert", async () => {
    expect(pushText({ key: "k", title: "**Boss** wrote: \"[x](https://evil)\"", why: "VIP.", action: { label: "Open", url: "https://mail.example/1" } }))
      .toBe("**\\*\\*Boss\\*\\* wrote: \"\\[x\\]\\(https://evil\\)\"**\nVIP.\nOpen: <https://mail.example/1>");
  });

  it("reports the message id, a buffered push, or why Discord did not take it", async () => {
    const push = { key: "k", title: "t", why: "w" };
    expect(await discordTransport(async () => ({ delivered: true, messageId: "9" })).send(push)).toEqual({ status: "sent", ref: "9" });
    expect(await discordTransport(async () => ({ delivered: false, code: "buffered" })).send(push)).toEqual({ status: "buffered" });
    expect(await discordTransport(async () => ({ delivered: false, code: "no_dm_target" })).send(push))
      .toEqual({ status: "failed", error: "Discord did not take the message (no_dm_target)." });
    expect(await discordTransport(async () => ({ delivered: false, code: "50007", detail: "Cannot send messages to this user" })).send(push))
      .toEqual({ status: "failed", error: "Discord did not take the message (50007: Cannot send messages to this user)." });
  });

  it("asks the adapter to buffer, and treats an adapter that returns nothing as sent with no id", async () => {
    const adapter = new MockAdapter();
    adapter.notifyPrincipalResult = { delivered: false, kind: "transient", code: "buffered" };
    const push = { key: "k", title: "t", why: "w" };
    expect(await discordTransport((text) => notifyWithResult(adapter, text, { buffer: true })).send(push)).toEqual({ status: "buffered" });
    expect(adapter.principalNotificationCalls.at(-1)?.opts).toEqual({ buffer: true });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const legacy: PlatformAdapter = new MockAdapter();
      legacy.notifyPrincipal = async () => undefined;
      expect(await discordTransport((text) => notifyWithResult(legacy, text, { buffer: true })).send(push)).toEqual({ status: "sent" });
    } finally {
      console.warn = warn;
    }
  });
});

describe("the interruption loop", () => {
  it("logs a failing tick and keeps going", async () => {
    const logged: string[] = [];
    let calls = 0;
    const loop = startInterruptLoop(60_000, async () => {
      calls += 1;
      throw new Error("ranger down");
    }, (m) => logged.push(m));
    await loop.tick();
    await loop.tick();
    loop.stop();
    expect(calls).toBe(2);
    expect(logged).toEqual(["desk: interruption tick failed: ranger down", "desk: interruption tick failed: ranger down"]);
  });
});

describe("the desk_deliveries table", () => {
  it("widens an existing table to accept buffered and keeps its rows", () => {
    const path = join(tmpdir(), `desk-deliveries-${crypto.randomUUID()}.db`);
    try {
      initDatabase(path).close();
      const old = new Database(path);
      old.run("DROP TABLE desk_deliveries");
      old.run(`CREATE TABLE desk_deliveries (
        item_key TEXT PRIMARY KEY,
        transport TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('sending','sent','failed')),
        title TEXT NOT NULL,
        error TEXT,
        ref TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      old.run("INSERT INTO desk_deliveries VALUES ('reminder:1', 'discord', 'sent', 'Call Ada', NULL, 'm-1', 1, 2)");
      old.close();
      const db = initDatabase(path);
      try {
        db.query("INSERT INTO desk_deliveries VALUES ('reminder:2', 'discord', 'buffered', 'Call Bo', NULL, NULL, 3, 4)").run();
        expect([...readDeliveries(db).values()].map((d) => [d.key, d.status, d.ref])).toEqual([
          ["reminder:1", "sent", "m-1"],
          ["reminder:2", "buffered", null],
        ]);
        expect(() => db.query("INSERT INTO desk_deliveries VALUES ('reminder:3', 'discord', 'lost', 't', NULL, NULL, 5, 6)").run()).toThrow();
      } finally {
        db.close();
      }
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });
});
