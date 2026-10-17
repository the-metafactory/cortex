// glossary-ignore: run, subscriber
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { MockAdapter } from "../../adapters/mock";
import type { PlatformAdapter } from "../../adapters/types";
import { createFakeJetStream } from "../../bus/jetstream/__tests__/fake-jetstream";
import { LEDGER_STREAM } from "../../bus/jetstream/provision";
import { deriveNatsSubject, type Envelope } from "../../bus/myelin/envelope-validator";
import type { MyelinSubscribePullOpts } from "../../bus/myelin/runtime";
import type { MyelinSubscriber } from "../../bus/myelin/subscriber";
import { runBoundedProcess } from "../../bus/process-runner";
import { AgentConfigSchema } from "../../common/types/config";
import { initDatabase } from "../../surface/mc/db/init";
import { budgetDay } from "../budget";
import { channelKey } from "../channels";
import { getVigilSubject, getVigilTextsSpent, type VigilEventRow } from "../db";
import { VIGIL_TEXT_SENT_TYPE } from "../delivery-receipt";
import { createVigilDeliveryPorts, startVigil, type VigilHandle } from "../index";
import { fakeTickScheduler, ledgerEnvelope, temporaryVigilDatabaseFile } from "./fixtures";

const PRIVATE_WORDING = "render-only wording sentinel";
const INITIAL_NOW = Date.parse("2026-10-16T10:00:00Z");

function discordAdapter() {
  const adapter = new MockAdapter();
  Object.defineProperty(adapter, "platform", { value: "discord" });
  return adapter;
}

function notificationLedger() {
  const fake = createFakeJetStream();
  const archive: Envelope[] = [];
  const published: Envelope[] = [];
  let live: MyelinSubscribePullOpts | undefined;
  const capture = (envelope: Envelope) => {
    const subject = deriveNatsSubject(envelope, "default");
    if (fake.publish(subject) === LEDGER_STREAM) archive.push(envelope);
  };
  return {
    fake, archive, published,
    deliver(envelope: Envelope) {
      capture(envelope);
      expect(live?.onEnvelope(envelope, deriveNatsSubject(envelope, "default"))).toEqual({ kind: "ack" });
      fake.pull(LEDGER_STREAM, live!.durable);
    },
    runtime: {
      jetstreamManager: async () => fake.jsm,
      publish: async (envelope: Envelope) => { published.push(envelope); capture(envelope); },
      subscribePull: (opts: MyelinSubscribePullOpts) => {
        if (opts.durable.includes("replay")) {
          fake.pull(LEDGER_STREAM, opts.durable);
          for (const envelope of archive) {
            expect(opts.onEnvelope(envelope, deriveNatsSubject(envelope, "default"))).toEqual({ kind: "ack" });
          }
        } else {
          live = opts;
        }
        return { ready: Promise.resolve(), stop: async () => {} } as unknown as MyelinSubscriber;
      },
    },
  };
}

describe("running Vigil notification delivery", () => {
  let file: ReturnType<typeof temporaryVigilDatabaseFile>;
  let db: Database;
  let handle: VigilHandle | null;
  let ledger: ReturnType<typeof notificationLedger>;
  let scheduler: ReturnType<typeof fakeTickScheduler>;
  let discord: ReturnType<typeof discordAdapter>;
  let now: number;
  let config: ReturnType<typeof AgentConfigSchema.parse>;
  const log = { info: mock((_text: string) => {}), warn: mock((_text: string) => {}) };
  const emailRun = mock<typeof runBoundedProcess>(async () => ({ ok: true }));

  beforeEach(() => {
    file = temporaryVigilDatabaseFile("vigil-notification-delivery-");
    db = initDatabase(file.path);
    handle = null;
    ledger = notificationLedger();
    scheduler = fakeTickScheduler();
    discord = discordAdapter();
    now = INITIAL_NOW;
    config = AgentConfigSchema.parse({
      claude: {}, agent: { name: "assistant", displayName: "Assistant" }, mc: { enabled: true },
      vigil: { enabled: true, fallback: { email: {
        command: "email", account: "alerts", to: "principal@example.test", timeout_ms: 1234,
      } } },
    });
    log.info.mockClear();
    log.warn.mockClear();
    emailRun.mockClear();
    emailRun.mockImplementation(async () => ({ ok: true }));
  });

  afterEach(async () => {
    await handle?.stop();
    db.close();
    file[Symbol.dispose]();
  });

  async function boot(adapters: PlatformAdapter[] = [discord], wording = true) {
    handle = await startVigil({
      config, db, runtime: ledger.runtime, principal: "jc", stack: "default", log,
      now: () => now, schedule: scheduler.schedule,
      ...createVigilDeliveryPorts({
        config: config.vigil, adapters, email: { run: emailRun, warn: log.warn },
        resolveGoalWording: wording ? (id) => `${PRIVATE_WORDING} ${id}` : undefined,
      }),
    });
    expect(handle).not.toBeNull();
    await Bun.sleep(0);
  }

  function observe(goal: string, offset = 0) {
    ledger.deliver(ledgerEnvelope({
      ran: { kind: "job", ref: `sensor-${goal}` }, outcome: "succeeded", serves: { goal },
      state: { subject: goal, value: "at-risk" },
      started_at: new Date(now - 2000 + offset).toISOString(),
      ended_at: new Date(now - 1000 + offset).toISOString(),
    }));
  }

  const events = () => db.query<VigilEventRow, []>("SELECT * FROM vigil_events ORDER BY occurred_at, rowid").all();
  const texts = () => events().filter((event) => event.subject_key.startsWith("state:goal:"));
  const receipts = () => ledger.published.filter((envelope) => envelope.type === VIGIL_TEXT_SENT_TYPE);
  async function tick() { scheduler.tick(); await Bun.sleep(0); }

  function assertPrivateWordingIsEphemeral() {
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'vigil_%' OR name = 'attention_items')").all();
    for (const { name } of tables) {
      expect(JSON.stringify(db.query(`SELECT * FROM "${name}"`).all())).not.toContain(PRIVATE_WORDING);
    }
    expect(JSON.stringify(ledger.published)).not.toContain(PRIVATE_WORDING);
  }

  test("five-minute ticks deliver the three oldest texts, hold the fourth, and leave digest events untouched", async () => {
    const other = new MockAdapter();
    const secondDiscord = discordAdapter();
    await boot([other, discord, secondDiscord]);
    expect(scheduler.intervalMs).toBe(300_000);
    observe("G3", 30);
    observe("G1", 10);
    observe("G4", 40);
    observe("G2", 20);
    ledger.deliver(ledgerEnvelope({ ran: { kind: "flow", ref: "unrelated" } }));
    const digest = events().filter((event) => event.route === "digest");
    await tick();
    expect(discord.principalNotifications).toEqual(["G1", "G2", "G3"].map((id) => `Vigil: goal ${PRIVATE_WORDING} ${id} — at-risk`));
    expect(discord.principalNotificationCalls.every(({ opts }) => opts?.buffer === false)).toBe(true);
    expect(other.principalNotifications).toEqual([]);
    expect(secondDiscord.principalNotifications).toEqual([]);
    expect(texts().map(({ delivery, held_reason }) => [delivery, held_reason])).toEqual([
      ["sent", null], ["sent", null], ["sent", null], ["held", "budget"],
    ]);
    expect(events().filter((event) => event.route === "digest")).toEqual(digest);
    expect(getVigilTextsSpent(db, budgetDay(now))).toBe(3);
    expect(receipts().map((envelope) => envelope.payload)).toEqual(texts().slice(0, 3).map((event) => ({
      event_id: event.id, subject_key: event.subject_key, budget_day: budgetDay(now),
    })));
    expect(ledger.archive.filter((envelope) => envelope.type === VIGIL_TEXT_SENT_TYPE)).toEqual(receipts());
    expect(ledger.fake.streamSubjects(LEDGER_STREAM)).toContain("local.jc.default.system.vigil.>");
    expect(emailRun).not.toHaveBeenCalled();
    await tick();
    expect(discord.principalNotifications).toHaveLength(3);
    expect(receipts()).toHaveLength(3);
    assertPrivateWordingIsEphemeral();
  });

  test("quiet hours hold texts before either surface is tried and spend nothing", async () => {
    now = Date.parse("2026-10-16T20:00:00Z");
    await boot();
    for (let i = 1; i <= 4; i++) observe(`G${i}`);
    await tick();
    expect(texts().map(({ delivery, held_reason }) => [delivery, held_reason])).toEqual(Array.from({ length: 4 }, () => ["held", "quiet"]));
    expect(getVigilTextsSpent(db, budgetDay(now))).toBe(0);
    expect(discord.principalNotifications).toEqual([]);
    expect(emailRun).not.toHaveBeenCalled();
    expect(receipts()).toEqual([]);
    assertPrivateWordingIsEphemeral();
  });

  test("permanent DM failure produces one bounded email batch, one outage notice and three charged receipts", async () => {
    discord.notifyPrincipalResult = { delivered: false, kind: "permanent", code: "50007" };
    await boot();
    for (let i = 1; i <= 4; i++) observe(`G${i}`, i);
    await tick();
    expect(emailRun).toHaveBeenCalledTimes(1);
    const [argv, options] = emailRun.mock.calls[0]!;
    expect(options).toEqual({ timeout_ms: 1234 });
    expect(argv.slice(0, 9)).toEqual(["email", "send", "-a", "alerts", "-t", "principal@example.test", "-s", "[Vigil] 3 text(s)", "-b"]);
    expect(argv[9]!.split("\n")).toEqual([
      "Vigil: check vigil:dm-channel — ok → regressed",
      ...["G1", "G2", "G3"].map((id) => `Vigil: goal ${PRIVATE_WORDING} ${id} — at-risk`),
    ]);
    expect(argv[10]).toBe("--no-markdown");
    expect(texts().slice(0, 3).every((event) => event.delivery === "sent" && event.via === "email")).toBe(true);
    expect(texts()[3]).toMatchObject({ delivery: "held", held_reason: "budget", via: null });
    expect(events().filter((event) => event.subject_key === channelKey("dm-channel"))).toHaveLength(1);
    expect(getVigilTextsSpent(db, budgetDay(now))).toBe(3);
    expect(receipts()).toHaveLength(3);
    await tick();
    expect(emailRun).toHaveBeenCalledTimes(1);
    assertPrivateWordingIsEphemeral();
  });

  test("failed email leaves texts pending across ticks and recovery charges only confirmed deliveries", async () => {
    discord.notifyPrincipalResult = { delivered: false, kind: "permanent", code: "50007" };
    emailRun.mockImplementation(async () => ({ ok: false, reason: "exit-7" }));
    await boot();
    observe("G1"); observe("G2");
    await tick();
    expect(texts().every((event) => event.delivery === "pending" && event.via === null && event.last_error === "exit 7")).toBe(true);
    expect(getVigilTextsSpent(db, budgetDay(now))).toBe(0);
    expect(receipts()).toEqual([]);
    expect(getVigilSubject(db, channelKey("email-channel"))?.value).toBe("regressed");
    emailRun.mockImplementation(async () => ({ ok: true }));
    now += 300_000;
    await tick();
    expect(emailRun).toHaveBeenCalledTimes(2);
    expect(texts().every((event) => event.delivery === "sent" && event.via === "email" && event.attempts === 2)).toBe(true);
    expect(getVigilTextsSpent(db, budgetDay(now))).toBe(2);
    expect(receipts()).toHaveLength(2);
    expect(events().filter((event) => event.subject_key === channelKey("dm-channel"))).toHaveLength(1);
    expect(events().find((event) => event.subject_key === channelKey("email-channel") && event.direction === "better")).toMatchObject({ route: "digest", delivery: "pending" });
    assertPrivateWordingIsEphemeral();
  });

  test("transient DMs retry on three ticks before email, then a real DM recovers the channel without resending", async () => {
    discord.notifyPrincipalResult = { delivered: false, kind: "transient", code: "network" };
    await boot();
    observe("G1");
    for (let attempt = 1; attempt < 3; attempt++) {
      await tick();
      expect(texts()[0]).toMatchObject({ delivery: "pending", attempts: attempt });
      expect(getVigilTextsSpent(db, budgetDay(now))).toBe(0);
      expect(emailRun).not.toHaveBeenCalled();
      expect(receipts()).toEqual([]);
      assertPrivateWordingIsEphemeral();
      now += 300_000;
    }
    await tick();
    expect(texts()[0]).toMatchObject({ delivery: "sent", via: "email", attempts: 3 });
    expect(emailRun).toHaveBeenCalledTimes(1);
    expect(getVigilSubject(db, channelKey("dm-channel"))?.value).toBe("regressed");
    discord.notifyPrincipalResult = { delivered: true, messageId: "recovered" };
    observe("G2");
    await tick();
    expect(texts()[1]).toMatchObject({ delivery: "sent", via: "dm", attempts: 1 });
    expect(getVigilSubject(db, channelKey("dm-channel"))?.value).toBe("ok");
    expect(events().find((event) => event.subject_key === channelKey("dm-channel") && event.direction === "better")).toMatchObject({ route: "digest", delivery: "pending" });
    expect(emailRun).toHaveBeenCalledTimes(1);
    expect(discord.principalNotifications).toHaveLength(4);
    expect(getVigilTextsSpent(db, budgetDay(now))).toBe(2);
    expect(receipts()).toHaveLength(2);
    assertPrivateWordingIsEphemeral();
  });

  test("no Discord adapter uses email, while no fallback block warns once and leaves items pending", async () => {
    const other = new MockAdapter();
    await boot([other]);
    observe("G1");
    await tick();
    expect(other.principalNotifications).toEqual([]);
    expect(texts()[0]).toMatchObject({ delivery: "sent", via: "email" });
    expect(emailRun).toHaveBeenCalledTimes(1);
    await handle!.stop();
    config.vigil.fallback = undefined;
    await boot([other]);
    observe("G2");
    await tick(); await tick();
    expect(texts()[1]).toMatchObject({ delivery: "pending", last_error: "no-fallback" });
    expect(log.warn.mock.calls).toEqual([["Vigil: no vigil.fallback.email configured; undelivered DMs remain pending"]]);
    expect(getVigilTextsSpent(db, budgetDay(now))).toBe(1);
    expect(emailRun).toHaveBeenCalledTimes(1);
    assertPrivateWordingIsEphemeral();
  });

  test("the same tick flushes a goal sensor made stale by its sweep using ID-only wording by default", async () => {
    config.vigil.cadence = { "run:job:sensor": 1000 };
    await boot([discord], false);
    ledger.deliver(ledgerEnvelope({
      ran: { kind: "job", ref: "sensor" }, outcome: "succeeded", serves: { goal: "G1" },
      started_at: new Date(now - 4000).toISOString(), ended_at: new Date(now - 3000).toISOString(),
    }));
    await tick();
    expect(discord.principalNotifications).toEqual(["Vigil: sensor (serves G1) — succeeded → stale"]);
    expect(ledger.published.map((envelope) => envelope.type)).toEqual(["system.attention.opened", VIGIL_TEXT_SENT_TYPE]);
    expect(getVigilTextsSpent(db, budgetDay(now))).toBe(1);
    assertPrivateWordingIsEphemeral();
  });

  test.each(["dm", "email"])("stop waits for an in-flight %s delivery and its receipt", async (via) => {
    const pending = Promise.withResolvers<undefined>();
    if (via === "dm") {
      discord.notifyPrincipal = async () => { await pending.promise; return { delivered: true }; };
    } else {
      discord.notifyPrincipalResult = { delivered: false, kind: "permanent", code: "50007" };
      emailRun.mockImplementation(async () => { await pending.promise; return { ok: true }; });
    }
    await boot();
    observe("G1");
    await tick();
    let stopped = false;
    const stopping = handle!.stop().then(() => { stopped = true; });
    try {
      await Bun.sleep(0);
      expect(stopped).toBe(false);
      expect(receipts()).toEqual([]);
      expect(scheduler.cancellations).toBe(1);
    } finally { pending.resolve(undefined); await stopping; }
    expect(texts()[0]).toMatchObject({ delivery: "sent", via });
    expect(receipts()).toHaveLength(1);
    await tick();
    expect(receipts()).toHaveLength(1);
    assertPrivateWordingIsEphemeral();
  });

  test.each(["dm", "email"])("restart and LEDGER replay reconstruct the %s budget without resending", async (via) => {
    if (via === "email") discord.notifyPrincipalResult = { delivered: false, kind: "permanent", code: "50007" };
    await boot();
    observe("G1"); observe("G2");
    await tick();
    const sentReceipts = receipts();
    expect(sentReceipts).toHaveLength(2);
    await handle!.stop();
    db.close();
    db = initDatabase(file.path);
    await boot();
    expect(getVigilTextsSpent(db, budgetDay(now))).toBe(2);
    expect(receipts()).toEqual(sentReceipts);
    const dmAttempts = discord.principalNotifications.length;
    const emailAttempts = emailRun.mock.calls.length;
    await handle!.stop();
    db.close();
    file[Symbol.dispose]();
    db = initDatabase(file.path);
    await boot();
    expect(getVigilTextsSpent(db, budgetDay(now))).toBe(2);
    expect(events()).toEqual([]);
    expect(db.query("SELECT * FROM attention_items").all()).toEqual([]);
    expect(receipts()).toEqual(sentReceipts);
    expect(discord.principalNotifications).toHaveLength(dmAttempts);
    expect(emailRun).toHaveBeenCalledTimes(emailAttempts);
    expect(log.warn).not.toHaveBeenCalled();
    assertPrivateWordingIsEphemeral();
  });
});
