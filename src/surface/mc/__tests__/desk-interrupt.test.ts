import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { composeDesk, type DeskOptions } from "../desk/compose";
import { pushInterrupts, readDeliveries, startInterruptLoop, type DeskPush, type DeskTransport, type InterruptRules, type PushResult } from "../desk/interrupt";
import { discordTransport, pushText } from "../desk/transports";
import { addNote } from "../desk/notes";
import { briefing, selectItems } from "../desk/present";
import { SourceCache, type CommandRunner } from "../desk/sources/command";
import type { RangerState } from "../desk/sources/ranger";
import { freshInterrupts, loadChimed, rememberChimed } from "../dashboard-v2/lib/desk-chime";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.parse("2026-10-31T09:00:00.000Z");
const MIN = 60_000;

const RULES: InterruptRules = { transport: "discord", meetingMinutes: 10, mail: true, reminders: true, maxAgeMinutes: 60, everySeconds: 60, chime: true };

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
  constructor(private readonly answer: PushResult = { ok: true, ref: "m-1" }) {}
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
    expect(first.pushed).toEqual([{ key: `meeting:cal:cal:e1@${NOW + 10 * MIN}`, ok: true }]);
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
    const transport = new FakeTransport({ ok: false, error: "Discord did not take the message (timeout)." });
    const cache = calendar([]);
    const first = await tick(transport, NOW, desk(), cache);
    expect(first.pushed).toEqual([{ key: "reminder:1", ok: false }]);
    const view = (await tick(transport, NOW + MIN, desk(), cache)).view;
    const reminder = view.items.find((i) => i.key === "reminder:1");
    expect(reminder?.urgency).toBe("now");
    expect(reminder?.score).toBeGreaterThanOrEqual(99);
    expect(reminder?.interrupt).toEqual({ delivery: "failed", error: "Discord did not take the message (timeout)." });
    expect(readDeliveries(db).get("reminder:1")?.status).toBe("failed");
    expect(transport.sent).toHaveLength(1);
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
    expect((await tick(transport, NOW + 2 * MIN, desk(), cache)).pushed).toEqual([{ key: "reminder:1", ok: true }]);
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
    const fresh = freshInterrupts(view, loadChimed(storage));
    expect(fresh).toEqual([`meeting:cal:cal:e1@${NOW + 10 * MIN}`]);
    rememberChimed(storage, loadChimed(storage), fresh);
    expect(freshInterrupts(view, loadChimed(storage))).toEqual([]);
    expect(freshInterrupts({ ...view, chime: false }, new Set())).toEqual([]);
  });
});

describe("the Discord transport", () => {
  it("writes the item shape and keeps markdown in titles inert", async () => {
    expect(pushText({ key: "k", title: "**Boss** wrote: \"[x](https://evil)\"", why: "VIP.", action: { label: "Open", url: "https://mail.example/1" } }))
      .toBe("**\\*\\*Boss\\*\\* wrote: \"\\[x\\]\\(https://evil\\)\"**\nVIP.\nOpen: <https://mail.example/1>");
  });

  it("reports the message id, or why Discord did not take it", async () => {
    expect(await discordTransport(async () => ({ delivered: true, messageId: "9" })).send({ key: "k", title: "t", why: "w" })).toEqual({ ok: true, ref: "9" });
    expect(await discordTransport(async () => ({ delivered: false, code: "no_dm_target" })).send({ key: "k", title: "t", why: "w" }))
      .toEqual({ ok: false, error: "Discord did not take the message (no_dm_target)." });
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
