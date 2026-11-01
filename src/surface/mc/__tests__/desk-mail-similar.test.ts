import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleDeskMail } from "../api/desk-mail";
import { HandledLedger } from "../desk/actions";
import { buildMessages, MailClassifier, readClassifications, saveClassification, type ClassifierRequest, type CommandConfig, type EndpointConfig } from "../desk/classify";
import { DAY_MS } from "../desk/time";
import { logMailDecision, queryMailLog, type MailFeatures, type MailLogEntry } from "../desk/mail-log";
import {
  CORRECTION_WEIGHT,
  EMBEDDER_DOWN_NOTE,
  embedderFor,
  embeddings,
  groupBySimilarity,
  latestDecisions,
  LOCAL_ONLY_NOTE,
  MailSimilarity,
  nearestDecisions,
  NO_EMBEDDER_NOTE,
  precedentLine,
  readVectors,
  saveVector,
  senderDecisions,
  type EmbedderAccess,
  type EmbedderConfig,
} from "../desk/mail-similar";
import { mailItems } from "../desk/rank";
import { SourceCache, type SourceMail } from "../desk/sources/command";
import { initDatabase } from "../db/init";
import { McSchema } from "../../../common/types/config";
import { mailDesk } from "./desk-mail-fixtures";

const NOW = Date.parse("2026-11-01T09:00:00.000Z");
const quiet = (): void => undefined;

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });

const entry = (id: number, action: MailLogEntry["action"], over: Partial<MailLogEntry> = {}): MailLogEntry => ({
  id, messageId: `m${id}`, account: "work", sourceId: "work-mail", sender: `s${id}@stats.example`, senderDomain: "stats.example", listId: null,
  category: "bulk", subject: `Report ${id}`, summary: "Numbers.", action, where: "desk", folder: null, at: NOW - id * 1000, ...over,
});

const features = (id: string, over: Partial<MailFeatures> = {}): MailFeatures => ({
  messageId: id, account: "work", sourceId: "work-mail", sender: `${id}@example.org`, senderDomain: "example.org", listId: null, category: "bulk",
  subject: "Quarterly zebra census results", summary: "The zebra census for Q3 is attached.", ...over,
});

describe("neighbour selection", () => {
  it("keeps decisions at or above the threshold, closest first, at most the limit", () => {
    const candidates = [
      { entry: entry(1, "archive"), vector: [1, 0, 0] },
      { entry: entry(2, "archive"), vector: [0.9, 0.1, 0] },
      { entry: entry(3, "trash"), vector: [0, 1, 0] },
      { entry: entry(4, "kept"), vector: [0.8, 0.6, 0] },
    ];
    const near = nearestDecisions([1, 0, 0], candidates, 2, 0.75);
    expect(near.map((n) => [n.entry.id, n.action])).toEqual([[1, "archive"], [2, "archive"]]);
    expect(nearestDecisions([1, 0, 0], candidates, 10, 0.75).map((n) => n.entry.id)).toEqual([1, 2, 4]);
    expect(nearestDecisions([0, 0, 1], candidates, 10, 0.75)).toEqual([]);
  });

  it("weighs a correction above an ordinary decision that is slightly closer", () => {
    const candidates = [
      { entry: entry(1, "archive"), vector: [1, 0] },
      { entry: entry(2, "kept", { where: "correction" }), vector: [0.85, Math.sqrt(1 - 0.85 ** 2)] },
    ];
    const near = nearestDecisions([1, 0], candidates, 5, 0.75);
    expect(near.map((n) => [n.action, n.weight])).toEqual([["keep", CORRECTION_WEIGHT], ["archive", 1]]);
  });

  it("counts only each message's newest decision, so an Undo turns an archive into a keep", () => {
    const decided = latestDecisions([entry(1, "archive", { messageId: "x", at: NOW - 5000 }), entry(2, "restore", { messageId: "x", at: NOW - 1000 }), entry(3, "opened")]);
    expect(decided.map((e) => [e.messageId, e.action])).toEqual([["x", "restore"]]);
  });

  it("falls back to the same List-Id first, then the sender domain", () => {
    const list = entry(1, "archive", { listId: "<weekly.stats.example>", senderDomain: "other.example" });
    const domain = entry(2, "trash");
    const near = senderDecisions({ sender: "new@stats.example", listId: "<WEEKLY.stats.example>" }, [domain, list, entry(3, "kept", { senderDomain: "else.example" })], 5);
    expect(near.map((n) => n.entry.id)).toEqual([1, 2]);
  });

  it("groups items whose vectors are alike, for a sweep or bundle", () => {
    const groups = groupBySimilarity([{ item: "a", vector: [1, 0] }, { item: "b", vector: [0, 1] }, { item: "c", vector: [0.95, 0.05] }], 0.9);
    expect(groups).toEqual([["a", "c"], ["b"]]);
  });

  it("names the precedents in plain words", () => {
    const items = [1, 2, 3].map((i) => ({ action: "archive" as const, sender: `s${i}@stats.example` }));
    expect(precedentLine("archive", { basis: "content", items })).toBe("Archived like 3 similar mails from s1@stats.example, s2@stats.example and s3@stats.example.");
    expect(precedentLine("archive", { basis: "sender", note: NO_EMBEDDER_NOTE, items: items.slice(0, 2) })).toBe(`Archived like the last 2 mails from this sender (${NO_EMBEDDER_NOTE}).`);
    expect(precedentLine("reply", { basis: "content", items })).toBeNull();
  });
});

const EMBEDDER: EmbedderConfig = { baseUrl: "http://localhost:11434/v1", model: "bge-m3", timeoutSeconds: 5, threshold: 0.75, neighbours: 8, windowDays: 90, maxPerPass: 64 };

const zebra = (text: string): number[] => (text.toLowerCase().includes("zebra") ? [1, 0.05, 0] : [0, 0.2, 1]);

function fakeEmbed(vector: (text: string) => number[] = zebra) {
  const calls: { access: EmbedderAccess; texts: string[] }[] = [];
  return {
    calls,
    embed: async (access: EmbedderAccess, texts: string[]): Promise<number[][]> => {
      calls.push({ access, texts });
      return texts.map(vector);
    },
  };
}

const probe = { messageId: "new", sourceId: "work-mail", sender: "fourth@else.example", listId: null, subject: "Quarterly zebra census results", summary: "The zebra census for Q3 is attached." };

describe("the similarity module", () => {
  it("falls back to sender domain and List-Id without an embedder, and says so", async () => {
    logMailDecision(db, features("a", { sender: "a@else.example", senderDomain: "else.example" }), "archive", "desk", NOW - 1000);
    const ctx = new MailSimilarity(undefined, fakeEmbed().embed, quiet).load(db, NOW);
    const similar = await ctx.similar(probe);
    expect(similar).toMatchObject({ basis: "sender", note: NO_EMBEDDER_NOTE });
    expect(similar.neighbours.map((n) => n.entry.messageId)).toEqual(["a"]);
  });

  it("embeds the logged decisions once, caches the vectors, and finds content neighbours from other senders", async () => {
    for (const id of ["a", "b", "c"]) logMailDecision(db, features(id), "archive", "desk", NOW - 1000);
    logMailDecision(db, features("d", { subject: "Lunch on Friday?", summary: "Shall we eat?" }), "draft", "desk", NOW - 1000);
    const fake = fakeEmbed();
    const sim = new MailSimilarity(EMBEDDER, fake.embed, quiet);
    const similar = await sim.load(db, NOW).similar(probe);
    expect(similar.basis).toBe("content");
    expect(similar.neighbours.map((n) => [n.entry.messageId, n.action]).sort()).toEqual([["a", "archive"], ["b", "archive"], ["c", "archive"]]);
    const embedded = fake.calls.flatMap((c) => c.texts).length;
    await sim.load(db, NOW).similar(probe);
    expect(fake.calls.flatMap((c) => c.texts).length).toBe(embedded);
  });

  it("falls back and never throws when the embedder is down, then waits before trying again", async () => {
    logMailDecision(db, features("a"), "archive", "desk", NOW - 1000);
    let tries = 0;
    const sim = new MailSimilarity(EMBEDDER, async () => { tries += 1; throw new Error("connect ECONNREFUSED 127.0.0.1:11434"); }, quiet);
    expect(await sim.load(db, NOW).similar(probe)).toMatchObject({ basis: "sender", note: EMBEDDER_DOWN_NOTE });
    await sim.load(db, NOW + 60_000).similar(probe);
    expect(tries).toBe(1);
  });

  it("sends a local-policy area's mail only to a local endpoint", async () => {
    const remote: EmbedderConfig = { ...EMBEDDER, baseUrl: "https://embed.example/v1" };
    expect(embedderFor(remote, true)).toBeNull();
    expect(embedderFor(EMBEDDER, true)).toBe(EMBEDDER);
    const local = { baseUrl: "http://127.0.0.1:11434/v1", model: "bge-m3", timeoutSeconds: 5 };
    expect(embedderFor({ ...remote, local }, true)).toBe(local);
    logMailDecision(db, features("a", { sourceId: "home-mail", subject: "Private zebra diary" }), "archive", "desk", NOW - 1000);
    logMailDecision(db, features("b"), "archive", "desk", NOW - 1000);
    const fake = fakeEmbed();
    const ctx = new MailSimilarity(remote, fake.embed, quiet).load(db, NOW, new Set(["home-mail"]));
    expect(await ctx.similar({ ...probe, sourceId: "home-mail" })).toMatchObject({ basis: "sender", note: LOCAL_ONLY_NOTE });
    expect((await ctx.similar(probe)).neighbours.map((n) => n.entry.messageId)).toEqual(["b"]);
    const sent = fake.calls.flatMap((call) => call.texts);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((t) => t.includes("Private"))).toBe(false);
  });
});

describe("the embeddings endpoint", () => {
  it("posts the texts to /embeddings and returns the vectors in input order", async () => {
    const seen: { url: string; body: { model: string; input: string[] } }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(init.body as string) as { model: string; input: string[] } });
      return Response.json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
    }) as unknown as typeof fetch;
    expect(await embeddings(fake, async () => null)(EMBEDDER, ["a", "b"])).toEqual([[1, 0], [0, 1]]);
    expect(seen[0]).toEqual({ url: "http://localhost:11434/v1/embeddings", body: { model: "bge-m3", input: ["a", "b"] } });
  });

  it("fails on an HTTP error or a short answer", async () => {
    const status = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(embeddings(status, async () => null)(EMBEDDER, ["a"])).rejects.toThrow("HTTP 403");
    const short = (async () => Response.json({ data: [{ embedding: [1] }] })) as unknown as typeof fetch;
    await expect(embeddings(short, async () => null)(EMBEDDER, ["a", "b"])).rejects.toThrow("does not accept");
  });

  it("accepts an https or loopback embedder in the desk block, and nothing else", () => {
    const parse = (baseUrl: string) => McSchema.safeParse({ desk: { mail: { embedder: { baseUrl, model: "bge-m3" } } } });
    expect(parse("http://localhost:11434/v1").success).toBe(true);
    expect(parse("https://api.example/v1").success).toBe(true);
    expect(parse("http://embed.example/v1").success).toBe(false);
    const local = (baseUrl: string) => McSchema.safeParse({ desk: { mail: { embedder: { baseUrl: "https://api.example/v1", model: "m", local: { baseUrl, model: "bge-m3" } } } } }).success;
    expect(local("http://127.0.0.1:11434/v1")).toBe(true);
    expect(local("https://embed.example/v1")).toBe(false);
    expect(embedderFor({ ...EMBEDDER, baseUrl: "https://api.example/v1", local: { baseUrl: "https://embed.example/v1", model: "m", timeoutSeconds: 5 } }, true)).toBeNull();
    expect(McSchema.parse({ desk: { mail: { embedder: { baseUrl: "http://localhost:11434/v1", model: "bge-m3" } } } }).desk.mail.embedder).toMatchObject({ threshold: 0.65, neighbours: 8, timeoutSeconds: 10 });
  });
});

const COMMAND: CommandConfig = { command: ["/opt/desk/bin/desk-classify-mail.ts"], timeoutSeconds: 75, maxPerPass: 10 };

const listed = (id: string, over: Partial<SourceMail> = {}): SourceMail & { sourceId: string; area: null } => ({
  kind: "mail", id, from: { name: "Fourth", address: "fourth@else.example" }, subject: "Quarterly zebra census results", receivedAt: new Date(NOW - 60_000).toISOString(),
  unread: true, firstParagraph: "The zebra census for Q3 is attached.", account: "work", sourceId: "work-mail", area: null, ...over,
});

describe("triage with precedents", () => {
  it("gives the classifier the nearest decisions and corrections, and the card follows the prediction", async () => {
    ["a", "b", "c"].forEach((id, i) => logMailDecision(db, features(id), "archive", "desk", NOW - 3000 + i * 1000));
    logMailDecision(db, features("k", { subject: "Zebra census feedback", summary: "Please read" }), "kept", "correction", NOW - 900);
    const seen: ClassifierRequest[] = [];
    const sim = new MailSimilarity(EMBEDDER, fakeEmbed().embed, quiet);
    const classifier = new MailClassifier(COMMAND, async (req) => { seen.push(req); return { category: "bulk", reason: "A report.", predictedAction: "archive" }; }, quiet, () => NOW, sim);
    await classifier.kick(db, { now: NOW, mail: [listed("new")], events: [], vips: [], corrections: [{ kind: "mail", source: "k@example.org", mode: "keep", label: "x" }] });
    expect(seen[0]?.examplesBasis).toBe("content");
    expect(seen[0]?.examples.map((e) => [e.action, e.weight])).toEqual([["keep", 2], ["archive", 1], ["archive", 1], ["archive", 1]]);
    expect(seen[0]?.corrections).toHaveLength(1);
    const first = seen[0];
    if (!first) throw new Error("the classifier got no request");
    const endpointUser = JSON.parse(buildMessages(first)[1]?.content ?? "{}") as { examples: unknown[]; corrections: unknown[] };
    expect([endpointUser.examples.length, endpointUser.corrections.length]).toEqual([4, 1]);
    const sorted = readClassifications(db, ["new"]);
    expect(sorted.get("new")?.predictedAction).toBe("archive");
    const [card] = mailItems({ now: NOW, mail: [listed("new")], events: [], vips: new Set(), classified: sorted, trash: true, archive: true, spam: true });
    expect(card?.actions[0]).toMatchObject({ id: "mail.archive", role: "primary" });
    expect(card?.why).toBe("Archived like 3 similar mails from c@example.org, b@example.org and a@example.org.");
    expect(card?.detail.precedents?.map((p) => [p.subject, p.action, p.correction ?? false])).toEqual([
      ["Zebra census feedback", "kept in the inbox", true],
      ["Quarterly zebra census results", "archived", false],
      ["Quarterly zebra census results", "archived", false],
      ["Quarterly zebra census results", "archived", false],
    ]);
    expect(JSON.stringify(card?.detail.precedents)).not.toContain("@");
  });

  it("puts Spam first for a predicted junk mail and says on the card when it matched by sender", () => {
    const classified = new Map([["new", { category: "bulk" as const, reason: "Spam.", predictedAction: "junk" as const, precedents: { basis: "sender" as const, note: NO_EMBEDDER_NOTE, items: [{ subject: "Win", sender: "x@else.example", action: "junk" as const, at: NOW - 1000, correction: false }] } }]]);
    const [card] = mailItems({ now: NOW, mail: [listed("new")], events: [], vips: new Set(), classified, trash: true, archive: true, spam: true });
    expect(card?.actions[0]).toMatchObject({ id: "mail.spam", role: "primary" });
    expect(card?.why).toBe(`Moved to Spam like the last mail from this sender (${NO_EMBEDDER_NOTE}).`);
    expect(card?.detail.history).toContain(`Similar past mail was ${NO_EMBEDDER_NOTE}.`);
  });
});

describe("local-policy areas", () => {
  it("never hands a local area's past mail to a remote classifier as an example, but a loopback one may see it", async () => {
    logMailDecision(db, features("home", { sourceId: "home-mail", subject: "Private zebra census results" }), "archive", "desk", NOW - 2000);
    logMailDecision(db, features("work"), "archive", "desk", NOW - 1000);
    const examples = async (config: CommandConfig | EndpointConfig): Promise<string[]> => {
      const seen: ClassifierRequest[] = [];
      const classifier = new MailClassifier(config, async (req) => { seen.push(req); return { category: "bulk", reason: "A report." }; }, quiet, () => NOW, new MailSimilarity(EMBEDDER, fakeEmbed().embed, quiet));
      await classifier.kick(db, { now: NOW, mail: [listed("new")], events: [], vips: [], localSources: new Set(["home-mail"]) });
      db.run("DELETE FROM desk_mail_classes");
      return seen[0]?.examples.map((e) => e.subject) ?? [];
    };
    expect(await examples(COMMAND)).toEqual(["Quarterly zebra census results"]);
    expect(await examples({ baseUrl: "https://llm.example/v1", model: "m", timeoutSeconds: 5, maxPerPass: 10 })).toEqual(["Quarterly zebra census results"]);
    expect((await examples({ baseUrl: "http://127.0.0.1:11434/v1", model: "m", timeoutSeconds: 5, maxPerPass: 10 })).sort()).toEqual(["Private zebra census results", "Quarterly zebra census results"]);
  });

  it("forgets vectors no pass has used within the window", () => {
    saveVector(db, "m", "old", [1, 0], NOW - 200 * DAY_MS);
    saveVector(db, "m", "fresh", [0, 1], NOW);
    new MailSimilarity(EMBEDDER, fakeEmbed().embed, quiet).load(db, NOW);
    expect([...readVectors(db, "m", ["old", "fresh"], NOW).keys()]).toEqual(["fresh"]);
  });
});

describe("a per-mail correction", () => {
  it("is logged as a weighted decision and sends the mail back to the classifier", async () => {
    const { sourceId: _s, area: _a, ...plain } = listed("new");
    const cache = new SourceCache(async () => JSON.stringify({ items: [plain] }));
    const desk = mailDesk({ move: ["/opt/move"], timeoutSeconds: 20 });
    await cache.read(desk.sources, NOW);
    saveClassification(db, "new", { category: "bulk", reason: "A report.", predictedAction: "archive" }, "m", NOW);
    const post = (body: object) => handleDeskMail(new Request("http://x/api/desk/mail", { method: "POST", body: JSON.stringify(body) }), db, { options: desk, ledger: new HandledLedger(), sourceCache: cache }, { now: () => NOW });
    const res = await post({ action: "correct", key: "mail:new", said: "not-bulk" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { message: string }).message).toContain("Noted: this mail is not bulk.");
    expect(queryMailLog(db, { where: "correction" }).map((e) => [e.messageId, e.action, e.category])).toEqual([["new", "kept", "not bulk"]]);
    expect(readClassifications(db, ["new"]).size).toBe(0);
    expect((await post({ action: "correct", key: "mail:new", said: "forward" })).status).toBe(400);
    expect((await post({ action: "correct", key: "mail:gone", said: "archive" })).status).toBe(409);
  });
});
