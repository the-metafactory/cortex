import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { communicationTools, type CommunicationConnector, type CommunicationOwner } from "../../../conversations/tools/communications";
import type { ToolSession } from "../../../conversations/tools/capabilities";
import { initDatabase } from "../db/init";
import { chatClassifier, classifierRunner, commandClassifier, MailClassifier, modelJson, readClassifications, type ClassifierRequest, type CommandConfig, type CommandRunner } from "../desk/classify";
import { composeDesk, type DeskOptions } from "../desk/compose";
import { chatFlagRunner, DigestFlagger, readDigestFlags } from "../desk/mail-digest";
import { handMailToIvy, piHandoffOwner, WORK_MAIL_NO_HANDOFF } from "../desk/mail-handoff";
import { EMBEDDER_LOCAL_NOTE, MailSimilarity } from "../desk/mail-similar";
import { proposeMailThread, WORK_MAIL_NO_THREAD, type MailForStudio } from "../desk/mail-studio";
import type { SweepGroup, SweepMember } from "../desk/mail-sweep";
import { chatWaitingRunner, recordWaiting, WaitingClassifier } from "../desk/mail-waiting";
import { CloudRouteRefused, LOCAL_CONTENT, mailProvenance, NOT_LOCAL_CONTENT, NOTHING_LEAVES, routeOf, sourceBoundary } from "../desk/source-boundary";
import { SourceCache, type SourceMail, type SourceReading, type SourceSent } from "../desk/sources/command";
import { sessionModel, sessionProvenance } from "../desk/studio/session";

const NOW = Date.parse("2026-11-07T09:00:00.000Z");
const AREAS = [
  { id: "office", label: "Office", color: "", repos: [], goals: [], policy: "local" as const },
  { id: "home", label: "Home", color: "", repos: [], goals: [], policy: "cloud" as const },
];
const SOURCES = [
  { id: "work-mail", command: ["work"], area: "office", everySeconds: 300, timeoutSeconds: 30 },
  { id: "personal-mail", command: ["personal"], area: "home", everySeconds: 300, timeoutSeconds: 30 },
];
const boundary = sourceBoundary({ areas: AREAS, sources: SOURCES });
const SECRET = "work-only-canary-text";

const mail = (id: string, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id, from: { name: "Ada", address: "ada@example.org" }, subject: `${SECRET} ${id}`, receivedAt: new Date(NOW - 3_600_000).toISOString(), unread: true,
  account: "work", firstParagraph: SECRET, url: `message://%3c${id}%3e`, headers: {}, ...over,
});

let dir: string;
let codexLog: string;
let codex: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desk-source-guard-"));
  codexLog = join(dir, "spawned.log");
  codex = join(dir, "codex");
  writeFileSync(codex, `#!/bin/sh\ncat >> "${codexLog}"\nprintf '%s' '{"flags":[],"asks":false,"thread":null,"match":false,"reason":"ok","category":"fyi","reply":"ok","summary":"ok"}'\n`);
  chmodSync(codex, 0o755);
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const spawned = (): boolean => existsSync(codexLog);
const codexModel = () => ({ command: [codex], sourcePolicy: "cloud" as const, timeoutSeconds: 5 });
const codexDeclaredLocal = () => ({ command: [codex], sourcePolicy: "local" as const, timeoutSeconds: 5 });

describe("the source boundary", () => {
  it("treats an unnamed source, a source without an area and an area without a cloud policy as local", () => {
    const local = sourceBoundary({ areas: [{ id: "a", policy: "cloud" }, { id: "b", policy: "local" }, { id: "c" }], sources: [{ id: "cloud-source", area: "a" }, { id: "local-source", area: "b" }, { id: "no-policy", area: "c" }, { id: "no-area" }, { id: "gone-area", area: "z" }] });
    expect(local.has("cloud-source")).toBe(false);
    for (const id of ["local-source", "no-policy", "no-area", "gone-area", "never-configured"]) expect(local.has(id)).toBe(true);
  });

  it("marks a prompt local when any source is local, missing, or when no source is named", () => {
    expect(mailProvenance(boundary, ["personal-mail"]).local).toBe(false);
    expect(mailProvenance(boundary, ["personal-mail", "work-mail"]).local).toBe(true);
    expect(mailProvenance(boundary, ["personal-mail", null]).local).toBe(true);
    expect(mailProvenance(boundary, []).local).toBe(true);
    expect(mailProvenance(NOTHING_LEAVES, ["personal-mail"]).local).toBe(true);
  });

  it("calls a route local only on a declaration or on loopback, and never for a known cloud client", () => {
    expect(routeOf({ baseUrl: "http://127.0.0.1:8081/v1" })).toBe("local");
    expect(routeOf({ baseUrl: "https://llm.example.org/v1" })).toBe("cloud");
    expect(routeOf({ baseUrl: "https://llm.example.org/v1", sourcePolicy: "local" })).toBe("local");
    expect(routeOf({ baseUrl: "http://127.0.0.1:8081/v1", sourcePolicy: "cloud" })).toBe("cloud");
    expect(routeOf({ command: ["local-model"], sourcePolicy: "local" })).toBe("local");
    expect(routeOf({ command: ["local-model"] })).toBe("cloud");
    for (const command of [["/opt/bin/codex"], ["helper", "--codex", "/x"], ["/a/desk-codex-json.ts", "--model", "m"]]) expect(routeOf({ command, sourcePolicy: "local" })).toBe("cloud");
  });
});

describe("the model dispatch", () => {
  const messages = [{ role: "user" as const, content: SECRET }];

  it("refuses local content on a cloud endpoint before any request", async () => {
    let calls = 0;
    const fake = (async () => { calls += 1; return Response.json({}); }) as unknown as typeof fetch;
    await expect(modelJson({ baseUrl: "https://llm.example.org/v1", model: "m", timeoutSeconds: 1 }, fake, async () => null)(messages, 1000, LOCAL_CONTENT)).rejects.toThrow(CloudRouteRefused);
    expect(calls).toBe(0);
  });

  it("refuses local content on a cloud command before it reads a key or spawns", async () => {
    let spawns = 0;
    let keys = 0;
    const run: CommandRunner = async () => { spawns += 1; return { code: 0, signal: null, stdout: "{}", stderr: "" }; };
    const config = { command: ["model"], sourcePolicy: "cloud" as const, timeoutSeconds: 1, apiKeyFile: "/k" };
    await expect(modelJson(config, fetch, async () => { keys += 1; return "k"; }, "model", 600, run)(messages, 1000, LOCAL_CONTENT)).rejects.toThrow("no model was called");
    expect({ spawns, keys }).toEqual({ spawns: 0, keys: 0 });
    expect(await modelJson(config, fetch, async () => "k", "model", 600, run)(messages, 1000, NOT_LOCAL_CONTENT)).toEqual({});
    expect(spawns).toBe(1);
  });

  it("refuses work mail in both classifier transports", async () => {
    const request = { mail: { id: "w", from: { address: "a@example.org" }, subject: SECRET, firstParagraph: SECRET, receivedAt: "", sourceId: "work-mail" }, meetings: [], vips: [], unimportant: [], corrections: [], examples: [], examplesBasis: "sender" } as ClassifierRequest;
    let used = 0;
    const fake = (async () => { used += 1; return Response.json({}); }) as unknown as typeof fetch;
    await expect(chatClassifier({ baseUrl: "https://llm.example.org/v1", model: "m", timeoutSeconds: 1, maxPerPass: 1 }, fake, async () => null)(request, 1000, LOCAL_CONTENT)).rejects.toThrow(CloudRouteRefused);
    const run: CommandRunner = async () => { used += 1; return { code: 0, signal: null, stdout: "{}", stderr: "" }; };
    await expect(commandClassifier({ command: ["model"], timeoutSeconds: 1, maxPerPass: 1, sourcePolicy: "cloud" }, run, async () => null)(request, 1000, LOCAL_CONTENT)).rejects.toThrow(CloudRouteRefused);
    expect(used).toBe(0);
  });
});

describe("a fake codex is never spawned for work mail", () => {
  it("in the classifier, and is for personal mail", async () => {
    const config: CommandConfig = { ...codexModel(), maxPerPass: 5 };
    const logged: string[] = [];
    const classifier = new MailClassifier(config, classifierRunner(config), (m) => logged.push(m));
    const work = await classifier.kick(db, { now: NOW, mail: [{ ...mail("w1"), sourceId: "work-mail" }], events: [], vips: [], localSources: boundary });
    expect(work).toMatchObject({ classified: 0, failed: 1 });
    expect(spawned()).toBe(false);
    expect(logged.join("\n")).toContain("no model was called");
    const unknown = await classifier.kick(db, { now: NOW, mail: [{ ...mail("u1"), sourceId: "renamed-source" }], events: [], vips: [], localSources: boundary });
    expect(unknown).toMatchObject({ classified: 0, failed: 1 });
    expect(spawned()).toBe(false);
    const personal = await classifier.kick(db, { now: NOW, mail: [{ ...mail("p1", { firstParagraph: "personal" }), sourceId: "personal-mail" }], events: [], vips: [], localSources: boundary });
    expect(personal.classified).toBe(1);
    expect(readFileSync(codexLog, "utf8")).toContain("personal");
  });

  it("when a meeting from a work calendar would travel with personal mail", async () => {
    const config: CommandConfig = { ...codexModel(), maxPerPass: 5 };
    const classifier = new MailClassifier(config, classifierRunner(config), () => undefined);
    const events = [{ id: "e1", start: new Date(NOW + 86_400_000).toISOString(), title: SECRET, sourceId: "work-calendar" }];
    expect(await classifier.kick(db, { now: NOW, mail: [{ ...mail("p2"), sourceId: "personal-mail" }], events, vips: [], localSources: boundary })).toMatchObject({ classified: 0, failed: 1 });
    expect(spawned()).toBe(false);
  });

  it("in the digest, even in a local slot that hides a cloud client", async () => {
    const member: SweepMember = { ...mail("w1"), sourceId: "work-mail", area: null };
    const group = { id: "g1", members: [member] } as unknown as SweepGroup;
    const logged: string[] = [];
    const flagger = new DigestFlagger({ ...codexModel(), local: codexDeclaredLocal() }, chatFlagRunner(), (m) => logged.push(m));
    await flagger.kick(db, [group], [{ kind: "goal", name: "Ship", local: false }], boundary, NOW);
    expect(spawned()).toBe(false);
    expect(logged.join("\n")).toContain("no model was called");
    expect(readDigestFlags(db, ["g1"]).size).toBe(0);
  });

  it("in waiting, even in a local slot that hides a cloud client", async () => {
    const sent: SourceSent = { kind: "sent", id: "s1", from: { name: "A", address: "a@example.org" }, to: [{ name: "B", address: "b@example.org" }], subject: SECRET, sentAt: new Date(NOW).toISOString(), text: `${SECRET}?`, account: "work", url: "message://%3cs1%3e" };
    const readings: SourceReading[] = [{ id: "work-mail", area: "office", events: [], mail: [], sent: [sent], readAt: NOW, error: null, dropped: 0, problems: [] }];
    recordWaiting(db, readings, NOW);
    const logged: string[] = [];
    await new WaitingClassifier({ ...codexModel(), local: codexDeclaredLocal() }, chatWaitingRunner(), (m) => logged.push(m)).kick(db, readings, boundary, NOW);
    expect(spawned()).toBe(false);
    expect(logged.join("\n")).toContain("no model was called");
  });

  it("in a Studio session on a local thread", async () => {
    await expect(sessionModel({ ...codexModel(), maxPerPass: 1 }, { question: SECRET, stand: "", subject: "", context: "", exchange: [] }, sessionProvenance({ policy: "local" }))).rejects.toThrow(CloudRouteRefused);
    expect(spawned()).toBe(false);
  });
});

describe("mail hand-off and Studio", () => {
  const item = (sourceId: string, area: string | null): MailForStudio => ({ mail: { ...mail("w1"), sourceId }, area, summary: null });

  it("refuses to hand work mail to Ivy and files no task", async () => {
    let writes = 0;
    const result = await handMailToIvy(item("work-mail", "office"), { requestId: "req-000000000001", instruction: null, suspicious: false }, {
      localSources: boundary, db, writers: { task: ["task-writer"] }, maps: [{ ref: "owner/repo#1", label: "Tasks" }], lanes: { cloud: { provider: "p", model: "m" } },
      run: async () => { writes += 1; return { code: 0, stdout: "{}", stderr: "" }; }, now: NOW, timeoutMs: 1000,
    });
    expect(result).toEqual({ ok: false, status: 409, error: WORK_MAIL_NO_HANDOFF });
    expect(writes).toBe(0);
  });

  it("refuses a stored cloud hand-off of work mail before the turn runs", async () => {
    let turns = 0;
    const owner = piHandoffOwner(async () => { turns += 1; return { text: "{}", session: "s", resumed: false }; }, { cloud: { provider: "p", model: "m" } }, boundary);
    await expect(owner({ sourceId: "work-mail", id: "h", route: "cloud", from: "a", subject: SECRET, receivedAt: "", summary: null, text: SECRET, url: null, instruction: null, task: "t" })).rejects.toThrow(CloudRouteRefused);
    expect(turns).toBe(0);
  });

  it("keeps work mail away from cloud threads when it proposes one", async () => {
    const seen: string[] = [];
    const proposed = await proposeMailThread(item("work-mail", "office"), {
      options: { dir: join(dir, "missing-studio"), maxActive: 5, filer: { ...codexModel(), maxPerPass: 1 } }, areas: AREAS, db,
      model: (_config, request) => { seen.push(...request.threads.map((t) => t.slug)); return Promise.resolve({ thread: null, match: false, reason: "no" }); },
    });
    expect(proposed.threads).toEqual([]);
    expect(seen).toEqual([]);
    expect(spawned()).toBe(false);
    expect(WORK_MAIL_NO_THREAD).toContain("local-policy thread");
  });
});

describe("mail similarity", () => {
  it("does not embed local mail with a cloud embedder and says why", async () => {
    let calls = 0;
    const similarity = new MailSimilarity({ baseUrl: "https://embed.example.org/v1", model: "m", timeoutSeconds: 1, threshold: 0.5, neighbours: 5, windowDays: 30, maxPerPass: 8 }, async () => { calls += 1; return [[1]]; }, () => undefined);
    const context = similarity.load(db, NOW, new Set(["work-mail"]), boundary);
    const found = await context.similar({ messageId: "w1", sourceId: "work-mail", sender: "a@example.org", listId: null, subject: SECRET, summary: SECRET });
    expect(found.note).toBe(EMBEDDER_LOCAL_NOTE);
    expect(calls).toBe(0);
  });

  it("embeds work mail on a loopback embedder", async () => {
    let calls = 0;
    const similarity = new MailSimilarity({ baseUrl: "http://localhost:11434/v1", model: "m", timeoutSeconds: 1, threshold: 0.5, neighbours: 5, windowDays: 30, maxPerPass: 8 }, async (_a, texts) => { calls += 1; return texts.map(() => [1]); }, () => undefined);
    await similarity.load(db, NOW, new Set(["work-mail"]), boundary).similar({ messageId: "w1", sourceId: "work-mail", sender: "a@example.org", listId: null, subject: SECRET, summary: SECRET });
    expect(calls).toBe(1);
  });
});

describe("Ivy's communications connector", () => {
  it("denies a work scope on a cloud conversation without reading it", async () => {
    let reads = 0;
    const connector: CommunicationConnector = {
      id: "mail", service: "Mail", family: "email", operations: [{ id: "search", summary: "s", effect: "read", input: z.object({}) }], actions: [],
      scopes: () => [{ id: "work", label: "Work", policy: "local" }, { id: "personal", label: "Personal", policy: "cloud" }],
      status: async () => ({ state: "available" }), authorize: async () => true,
      read: async () => { reads += 1; return { items: [], next: null, observedAt: NOW }; },
    };
    const owner: CommunicationOwner = { connectors: () => [connector], now: () => NOW, remember: async () => true };
    const read = communicationTools(owner).find((tool) => tool.name === "communication_read");
    if (!read) throw new Error("no read tool");
    const session = { principal: "p", transport: "web", route: "codex" } as unknown as ToolSession;
    const signal = new AbortController().signal;
    const denied = JSON.parse(await read.run({ connector: "mail", scope: "work", operation: "search", input: {} }, { session, signal } as never) as string) as { status: string };
    expect(denied.status).toBe("denied");
    expect(reads).toBe(0);
    await read.run({ connector: "mail", scope: "personal", operation: "search", input: {} }, { session, signal } as never);
    expect(reads).toBe(1);
  });
});

describe("routing per source on the Desk", () => {
  it("sends work mail to the local model and personal mail to the cloud command, and neither to the other", async () => {
    const items: Record<string, SourceMail[]> = { work: [mail("w1")], personal: [mail("p1", { account: "personal", firstParagraph: "personal text", subject: "personal subject" })] };
    const localPrompts: string[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      localPrompts.push(init.body as string);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ category: "fyi", reason: "News." }) } }] });
    }) as unknown as typeof fetch;
    const localConfig = { baseUrl: "http://127.0.0.1:8081/v1", model: "local-model", timeoutSeconds: 5, maxPerPass: 5, sourcePolicy: "local" as const };
    const cloudConfig: CommandConfig = { ...codexModel(), maxPerPass: 5 };
    const cloud = new MailClassifier(cloudConfig, classifierRunner(cloudConfig), () => undefined);
    const local = new MailClassifier(localConfig, chatClassifier(localConfig, fake, async () => null), () => undefined);
    const desk: DeskOptions = { enabled: true, displayName: "A", topN: 5, rangerUrl: "", areas: AREAS, sources: SOURCES, mailClassifier: { ...cloudConfig, local: localConfig } };
    const sourceCache = new SourceCache(async (argv) => JSON.stringify({ items: items[argv[0] ?? ""] ?? [] }));
    await composeDesk(db, desk, undefined, { now: NOW, sourceCache, mailClassifier: cloud, localMailClassifier: local });
    await Promise.all([cloud.kick(db, { now: NOW, mail: [], events: [], vips: [] }), local.kick(db, { now: NOW, mail: [], events: [], vips: [] })]);
    expect(localPrompts.join("\n")).toContain(SECRET);
    expect(localPrompts.join("\n")).not.toContain("personal text");
    const toCodex = readFileSync(codexLog, "utf8");
    expect(toCodex).toContain("personal text");
    expect(toCodex).not.toContain(SECRET);
    expect([...readClassifications(db, ["w1", "p1"]).keys()].sort()).toEqual(["p1", "w1"]);
    const models = db.query<{ message_id: string; model: string }, []>("SELECT message_id, model FROM desk_mail_classes ORDER BY message_id").all();
    expect(models).toEqual([{ message_id: "p1", model: "codex" }, { message_id: "w1", model: "local-model" }]);
  });
});
