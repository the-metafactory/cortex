import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { composeDesk, type DeskOptions } from "../desk/compose";
import { mailItems, meetingFor } from "../desk/rank";
import { SourceCache, type CommandRunner, type SourceEvent, type SourceMail } from "../desk/sources/command";
import {
  buildMessages,
  chatClassifier,
  MAX_REASON,
  MailClassifier,
  MissingKey,
  readClassifications,
  validateAnswer,
  type EndpointConfig,
  type ClassifierRequest,
  type ClassifierRunner,
  type MailClassification,
} from "../desk/classify";
import { classifierLines } from "../dashboard-v2/components/desk-settings";
import { setCorrection } from "../desk/corrections";
import { McSchema } from "../../../common/types/config";

const NOW = new Date("2026-10-31T09:00:00").getTime();
const at = (hhmm: string, dayOffset = 0): string => new Date(new Date(`2026-10-31T${hhmm}:00`).getTime() + dayOffset * 86_400_000).toISOString();
const event = (id: string, title: string, start: string): SourceEvent & { sourceId: string } => ({ id, title, start, sourceId: "work-calendar" });
const KUNDEN = event("k1", "Switch-Kundenmeeting 2026", at("14:00", 2));
const KUNDEN_KEY = "cal:work-calendar:k1";

const mail = (id: string, subject: string, over: Partial<SourceMail> = {}): SourceMail & { area: string | null; sourceId: string } => ({
  kind: "mail", id, from: { name: "Sender", address: `${id}@example.org` }, subject, receivedAt: at("08:00"), unread: true,
  firstParagraph: "Hello.", area: null, sourceId: "work-mail", ...over,
});
const NEWSLETTER = mail("n1", "Newsletter November 2026", { from: { name: "Christina Grimm Music", address: "news@grimm.example" } });

const CONFIG: EndpointConfig = { baseUrl: "https://llm.example/v1", model: "chat-fast", timeoutSeconds: 5, maxPerPass: 10 };
const quiet = (): void => undefined;

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

describe("the rules fallback", () => {
  it("never matches a meeting on a shared year", () => {
    expect(meetingFor(NEWSLETTER.subject, [KUNDEN], NOW)).toBeUndefined();
    const [item] = mailItems({ now: NOW, mail: [NEWSLETTER], events: [KUNDEN], vips: new Set() });
    expect(item?.why).not.toContain("Kundenmeeting");
    expect(item?.score).toBeLessThan(20);
  });

  it("still matches on a shared alphabetic word", () => {
    expect(meetingFor("Agenda Kundenmeeting", [KUNDEN], NOW)?.id).toBe("k1");
  });
});

describe("the classifier answer", () => {
  const keys = new Set([KUNDEN_KEY]);

  it("accepts a valid answer and tolerates extra fields", () => {
    expect(validateAnswer({ category: "meeting", meetingKey: KUNDEN_KEY, reason: "It sets the agenda.", summary: "x".repeat(700), suggestedAction: "forward" }, keys))
      .toEqual({ category: "meeting", meetingKey: KUNDEN_KEY, reason: "It sets the agenda." });
  });

  it("treats an empty meeting key as none", () => {
    expect(validateAnswer({ category: "fyi", meetingKey: "", reason: "News." }, keys)).toEqual({ category: "fyi", reason: "News." });
  });

  it("drops a meeting key on bulk mail", () => {
    expect(validateAnswer({ category: "bulk", meetingKey: KUNDEN_KEY, reason: "A newsletter." }, keys)).toEqual({ category: "bulk", reason: "A newsletter." });
  });

  it("rejects an unknown category, an unknown meeting key and a long reason", () => {
    expect(validateAnswer({ category: "spam", reason: "x" }, keys)).toBeNull();
    expect(validateAnswer({ category: "meeting", meetingKey: "cal:x:y", reason: "x" }, keys)).toBeNull();
    expect(validateAnswer({ category: "fyi", reason: "x".repeat(MAX_REASON + 1) }, keys)).toBeNull();
    expect(validateAnswer({ category: "fyi" }, keys)).toBeNull();
  });
});

describe("ranking with classifications", () => {
  const rank = (classified: Record<string, MailClassification>, vips: string[] = []) =>
    mailItems({
      now: NOW,
      mail: [NEWSLETTER, mail("a1", "Please sign the form"), mail("f1", "Team news"), mail("m1", "Slides for Monday"), mail("v1", "Lunch?")],
      events: [KUNDEN],
      vips: new Set(vips),
      classified: new Map(Object.entries(classified)),
    });

  it("folds bulk low, links a meeting, ranks action above fyi, keeps VIPs first and shows the reason", () => {
    const items = rank({
      n1: { category: "bulk", reason: "A music newsletter" },
      a1: { category: "action", reason: "The sender asks you to sign a form." },
      f1: { category: "fyi", reason: "Team news." },
      m1: { category: "meeting", meetingKey: KUNDEN_KEY, reason: "It sends the slides for the customer meeting." },
      v1: { category: "fyi", reason: "A lunch question." },
    }, ["v1@example.org"]);
    const by = new Map(items.map((i) => [i.key, i]));
    const score = (k: string): number => by.get(`mail:${k}`)?.score ?? NaN;
    expect(by.get("mail:n1")?.why).toBe("A music newsletter.");
    expect(by.get("mail:n1")?.eventKey).toBeUndefined();
    expect(score("n1")).toBeLessThan(20);
    expect(by.get("mail:m1")).toMatchObject({ eventKey: KUNDEN_KEY, urgency: "today" });
    expect(by.get("mail:m1")?.why).toMatch(/^It sends the slides for the customer meeting\. The meeting is /);
    expect(score("a1")).toBeGreaterThan(score("f1"));
    expect(score("v1")).toBeGreaterThan(score("m1"));
    expect(by.get("mail:v1")?.why).toBe("Sender is on your VIP list. A lunch question.");
    expect(by.get("mail:a1")?.detail.history).toContain("The mail classifier sorted it as action.");
  });

  it("does not link a meeting that is no longer ahead", () => {
    const [item] = mailItems({ now: NOW, mail: [mail("m1", "Slides")], events: [], vips: new Set(), classified: new Map([["m1", { category: "meeting", meetingKey: KUNDEN_KEY, reason: "Slides." }]]) });
    expect(item?.eventKey).toBeUndefined();
    expect(item?.score).toBeLessThan(30);
  });
});

describe("the classification pass", () => {
  const input = (mails: SourceMail[], now = NOW) => ({ now, mail: mails.map((m) => ({ ...m, sourceId: "work-mail" })), events: [KUNDEN], vips: ["boss@example.org"] });

  it("classifies each unread mail once, caches it and sends the contract stdin", async () => {
    const seen: ClassifierRequest[] = [];
    const run: ClassifierRunner = async (req) => {
      seen.push(req);
      return { category: "bulk", reason: "A newsletter." };
    };
    const c = new MailClassifier(CONFIG, run, quiet);
    const read = mail("r1", "Old", { unread: false });
    await c.kick(db, input([NEWSLETTER, read]));
    await c.kick(db, input([NEWSLETTER, read]));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      mail: { id: "n1", from: NEWSLETTER.from, subject: NEWSLETTER.subject, firstParagraph: "Hello.", receivedAt: NEWSLETTER.receivedAt },
      meetings: [{ key: KUNDEN_KEY, title: KUNDEN.title, start: KUNDEN.start }],
      vips: ["boss@example.org"],
      unimportant: [],
      corrections: [],
    });
    expect(readClassifications(db, ["n1", "r1"])).toEqual(new Map([["n1", { category: "bulk", reason: "A newsletter." }]]));
  });

  it("offers meetings two weeks ahead and links one only once it is within three days", async () => {
    const later = event("k9", "Board retreat", at("10:00", 9));
    const seen: ClassifierRequest[] = [];
    const c = new MailClassifier(CONFIG, async (req) => { seen.push(req); return { category: "meeting", meetingKey: "cal:work-calendar:k9", reason: "Retreat agenda." }; }, quiet);
    await c.kick(db, { now: NOW, mail: [{ ...mail("r9", "Retreat agenda"), sourceId: "work-mail" }], events: [KUNDEN, later], vips: [] });
    expect(seen[0]?.meetings.map((m) => m.key)).toEqual([KUNDEN_KEY, "cal:work-calendar:k9"]);
    const classified = readClassifications(db, ["r9"]);
    const rankAt = (now: number) => mailItems({ now, mail: [mail("r9", "Retreat agenda", { receivedAt: new Date(now).toISOString() })], events: [later], vips: new Set(), classified })[0];
    expect(rankAt(NOW)?.eventKey).toBeUndefined();
    expect(rankAt(NOW + 7 * 86_400_000)?.eventKey).toBe("cal:work-calendar:k9");
  });

  it("says once that the key is missing and keeps the mail pending", async () => {
    let calls = 0;
    const logged: string[] = [];
    const c = new MailClassifier(CONFIG, () => { calls += 1; return Promise.reject(new MissingKey("the classifier key was not found")); }, (m) => logged.push(m));
    await c.kick(db, input([mail("a", "A"), mail("b", "B")]));
    await c.kick(db, input([mail("a", "A"), mail("b", "B")], NOW + 60_000));
    expect(calls).toBe(2);
    expect(logged).toEqual(["desk: mail classifier: the classifier key was not found"]);
  });

  it("logs the latency per mail", async () => {
    let t = 0;
    const logged: string[] = [];
    const c = new MailClassifier(CONFIG, async () => { t += 700; return { category: "fyi", reason: "News." }; }, (m) => logged.push(m), () => t);
    await c.kick(db, input([mail("a", "A"), mail("b", "B")]));
    expect(logged).toEqual(["desk: mail classifier: sorted 2 of 2 mails, 700 ms per mail"]);
  });

  it("classifies at most maxPerPass mails per pass", async () => {
    let calls = 0;
    const c = new MailClassifier({ ...CONFIG, maxPerPass: 2 }, async () => { calls += 1; return { category: "fyi", reason: "News." }; }, quiet);
    const result = await c.kick(db, input([mail("a", "A"), mail("b", "B"), mail("c", "C")]));
    expect(calls).toBe(2);
    expect(result.classified).toBe(2);
  });

  it("leaves a failed or invalid answer uncached and retries it only after a pause", async () => {
    const answers: (() => Promise<unknown>)[] = [
      () => Promise.reject(new Error("timed out after 5 s")),
      () => Promise.resolve({ category: "meeting", meetingKey: "cal:x:nope", reason: "x" }),
      () => Promise.resolve({ category: "fyi", reason: "News." }),
    ];
    let calls = 0;
    const logged: string[] = [];
    const c = new MailClassifier(CONFIG, () => answers[calls++]?.() ?? Promise.reject(new Error("no more")), (m) => logged.push(m));
    const one = await c.kick(db, input([mail("a", "A"), mail("b", "B", { receivedAt: at("07:00") })]));
    expect(one).toMatchObject({ classified: 0, failed: 2 });
    expect(readClassifications(db, ["a", "b"]).size).toBe(0);
    expect(logged).toContain("desk: mail classifier: timed out after 5 s");
    await c.kick(db, input([mail("a", "A")], NOW + 60_000));
    expect(calls).toBe(2);
    await c.kick(db, input([mail("a", "A")], NOW + 11 * 60_000));
    expect(readClassifications(db, ["a"]).get("a")?.category).toBe("fyi");
  });
});

describe("composeDesk with a classifier", () => {
  const DESK: DeskOptions = {
    enabled: true, displayName: "Ada", topN: 5, rangerUrl: "", areas: [],
    sources: [
      { id: "work-calendar", command: ["cal"], everySeconds: 300, timeoutSeconds: 5 },
      { id: "work-mail", command: ["mail"], everySeconds: 300, timeoutSeconds: 5 },
    ],
    mailClassifier: { ...CONFIG, apiKeyEnv: "DESK_TEST_KEY_THAT_IS_UNSET" },
  };
  const runner: CommandRunner = async ([cmd]) => JSON.stringify(cmd === "cal" ? { events: [KUNDEN] } : { items: [NEWSLETTER] });

  it("answers from the rules first, then from the cache, without waiting for the model", async () => {
    let release: (v: unknown) => void = () => undefined;
    const c = new MailClassifier(DESK.mailClassifier ?? CONFIG, () => new Promise((r) => { release = r; }), quiet);
    const deps = { now: NOW, sourceCache: new SourceCache(runner), mailClassifier: c };
    const first = await composeDesk(db, DESK, undefined, deps);
    expect(first.items.find((i) => i.key === "mail:n1")?.why).toMatch(/^It arrived /);
    expect(first.mailClassifier).toEqual({ kind: "endpoint", host: "llm.example", model: "chat-fast", keyNeeded: true, keyFound: false });
    release({ category: "bulk", reason: "A newsletter from a music school." });
    await c.kick(db, { now: NOW, mail: [], events: [], vips: [] });
    const second = await composeDesk(db, DESK, undefined, deps);
    expect(second.items.find((i) => i.key === "mail:n1")?.why).toBe("A newsletter from a music school.");
  });

  it("hands the command the latest mail corrections only and shows it in Settings", async () => {
    setCorrection(db, "mail", "work-mail", "less", NOW - 1000);
    setCorrection(db, "goal", "vigil", "always", NOW);
    const command = { command: ["/opt/desk/bin/desk-classify-mail.ts"], timeoutSeconds: 75, maxPerPass: 10 };
    const seen: ClassifierRequest[] = [];
    const c = new MailClassifier(command, async (req) => { seen.push(req); return { category: "fyi", reason: "News." }; }, quiet);
    const view = await composeDesk(db, { ...DESK, mailClassifier: command }, undefined, { now: NOW, sourceCache: new SourceCache(runner), mailClassifier: c });
    await c.kick(db, { now: NOW, mail: [], events: [], vips: [] });
    expect(seen[0]?.corrections).toEqual([{ kind: "mail", source: "work-mail", mode: "less", label: "Mail you may want to read, from work-mail" }]);
    expect(view.mailClassifier).toEqual({ kind: "command", command: "desk-classify-mail.ts", keyNeeded: false, keyFound: false });
    expect(classifierLines(view.mailClassifier ?? null)[0]).toBe("A command sorts your unread mail: desk-classify-mail.ts.");
  });

  it("ignores cached classifications when no classifier is configured", async () => {
    const c = new MailClassifier(CONFIG, async () => ({ category: "action", reason: "Do it." }), quiet);
    await c.kick(db, { now: NOW, mail: [{ ...NEWSLETTER }], events: [], vips: [] });
    const { mailClassifier: _off, ...plain } = DESK;
    const view = await composeDesk(db, plain, undefined, { now: NOW, sourceCache: new SourceCache(runner), mailClassifier: c });
    expect(view.items.find((i) => i.key === "mail:n1")?.why).toMatch(/^It arrived /);
    expect(view.mailClassifier).toBeNull();
  });
});

describe("the OpenAI-compatible provider", () => {
  const request: ClassifierRequest = { mail: { id: "n1", from: NEWSLETTER.from, subject: NEWSLETTER.subject, firstParagraph: "", receivedAt: NEWSLETTER.receivedAt }, meetings: [], vips: [], unimportant: [], corrections: [] };

  it("posts the request as JSON with the key from the named env var and parses a fenced answer", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ choices: [{ message: { content: "```json\n{\"category\":\"bulk\",\"reason\":\"A newsletter.\"}\n```" } }] });
    }) as unknown as typeof fetch;
    const run = chatClassifier({ ...CONFIG, baseUrl: "https://llm.example/v1/", apiKeyEnv: "K" }, fake, async () => "sk-test");
    expect(await run(request, 1000)).toEqual({ category: "bulk", reason: "A newsletter." });
    expect(calls[0]?.url).toBe("https://llm.example/v1/chat/completions");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const body = JSON.parse(calls[0]?.init.body as string) as { model: string; messages: { content: string }[] };
    expect(body.model).toBe("chat-fast");
    expect(body.messages).toEqual(buildMessages(request));
    const { corrections: _corrections, ...endpointRequest } = request;
    expect(JSON.parse(body.messages[1]?.content ?? "")).toEqual(endpointRequest);
  });

  it("trusts the configured CA file for a gateway with a private certificate", async () => {
    const ca = join(tmpdir(), `desk-ca-${process.pid}.pem`);
    await Bun.write(ca, "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n");
    let tls: unknown;
    const fake = (async (_url: string, init: RequestInit & { tls?: unknown }) => {
      tls = init.tls;
      return Response.json({ choices: [{ message: { content: "{\"category\":\"fyi\",\"reason\":\"News.\"}" } }] });
    }) as unknown as typeof fetch;
    try {
      await chatClassifier({ ...CONFIG, caFile: ca }, fake, async () => null)(request, 1000);
      expect(tls).toEqual({ ca: "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n" });
      await chatClassifier(CONFIG, fake, async () => null)(request, 1000);
      expect(tls).toBeUndefined();
      await expect(chatClassifier({ ...CONFIG, caFile: `${ca}.missing` }, fake, async () => null)(request, 1000)).rejects.toThrow(`the classifier CA file could not be read: ${ca}.missing`);
    } finally {
      await Bun.file(ca).delete();
    }
  });

  it("refuses to call without a configured key, and reports an HTTP error", async () => {
    let called = false;
    const fake = (async () => { called = true; return new Response("no", { status: 401 }); }) as unknown as typeof fetch;
    await expect(chatClassifier({ ...CONFIG, apiKeyFile: "/nope" }, fake, async () => null)(request, 1000)).rejects.toThrow("the classifier key was not found");
    expect(called).toBe(false);
    await expect(chatClassifier(CONFIG, fake, async () => null)(request, 1000)).rejects.toThrow("HTTP 401");
  });
});

describe("the classifier config", () => {
  const parse = (baseUrl: string) => McSchema.safeParse({ desk: { mail: { classifier: { baseUrl, model: "m" } } } }).success;

  it("needs https unless the endpoint is on loopback", () => {
    expect(parse("https://api.example/v1")).toBe(true);
    expect(parse("http://127.0.0.1:11434/v1")).toBe(true);
    expect(parse("http://llm.example/v1")).toBe(false);
  });
});

describe("Settings", () => {
  it("shows the provider read-only and whether its key was found", () => {
    expect(classifierLines({ kind: "endpoint", host: "api.spark.switch.ch", model: "coder", keyNeeded: true, keyFound: false }).join(" "))
      .toBe("A model sorts your unread mail: coder at api.spark.switch.ch. Its API key was not found, so the Desk sorts mail by shared words until it is. Change it in the stack config.");
    expect(classifierLines(null)[0]).toMatch(/^The Desk sorts unread mail by the words/);
  });
});
