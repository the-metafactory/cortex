import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDeskMeetingBrief } from "../api/desk-meeting-brief";
import { DEFAULT_CONFIG } from "../config";
import { initDatabase } from "../db/init";
import { saveBalanceState } from "../desk/balance-store";
import type { ClassifierConfig } from "../desk/classify";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { linkToMeeting, type LinkSubject } from "../desk/links";
import type { MeetingBrief } from "../desk/meeting-brief-contract";
import { synthesisModel, type SynthesisModel, type SynthesisPrompt } from "../desk/meeting-brief-synthesis";
import { setPreviousRelation } from "../desk/meeting-previous";
import { addNote } from "../desk/notes";
import { SourceCache } from "../desk/sources/command";
import { LOCAL_CONTENT } from "../desk/source-boundary";
import { startServer } from "../server";
import { briefOptions, briefPost, briefRuntime, EVENT, fixture, NOW, PRINCIPAL, seed } from "./fixtures/meeting-brief";

const BASE_URL = "http://localhost/api/desk/meeting-brief";
const CLOUD: ClassifierConfig = { baseUrl: "https://cloud.example.test/v1", model: "cloud-model", timeoutSeconds: 5, maxPerPass: 1 };
const LOCAL: ClassifierConfig = { baseUrl: "http://127.0.0.1:9/v1", model: "local-model", timeoutSeconds: 5, maxPerPass: 1 };
const MAIL = { sourceId: "cal", sender: "ada@example.org", senderName: "Ada Lovelace", receivedAt: new Date(NOW).toISOString(), url: null, account: "work" };

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void }
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

interface Call { model: string; prompt: SynthesisPrompt; answer: Deferred<unknown>; signal?: AbortSignal }

let db: Database;
let dir: string;
let options: DeskOptions;
let calls: Call[];
let seq = 0;

const model: SynthesisModel = (config, prompt, _content, _name, signal?: AbortSignal) => {
  const answer = deferred<unknown>();
  calls.push({ model: "model" in config ? config.model : "command", prompt, answer, signal });
  return answer.promise;
};

const subject = (kind: LinkSubject["kind"], key: string, mail: LinkSubject["mail"] = null): LinkSubject => ({ kind, key, title: "Untrusted saved title", mail });
const link = (from: LinkSubject): void => {
  const result = linkToMeeting(db, from, { kind: "meeting", key: EVENT, title: "Weekly sync", at: NOW, end: NOW + 1 }, { id: `link-${++seq}`, requestId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, origin: "desk", now: NOW });
  expect(result.ok).toBe(true);
};

const setPolicy = (policy: "cloud" | "local"): void => {
  const [area] = options.areas;
  const [source] = options.sources;
  if (!area || !source) throw new Error("fixture has an area and a source");
  area.policy = policy;
  source.area = "work";
};

const runtime = async (): Promise<DeskRuntime> => {
  const data = fixture();
  writeFileSync(join(dir, "source.json"), JSON.stringify(data));
  return briefRuntime(options, data);
};

const post = (body: unknown): Request => briefPost(BASE_URL, body);
const get = (): Request => new Request(`${BASE_URL}?event=${encodeURIComponent(EVENT)}`);
const send = async (req: Request, rt: DeskRuntime) => {
  const res = await handleDeskMeetingBrief(req, db, rt, { now: () => NOW, synthesisModel: model });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
};
const brief = (json: Record<string, unknown>): MeetingBrief => json as unknown as MeetingBrief;
const idsOf = (call: Call | undefined): string[] => call?.prompt.facts.map(fact => fact.id) ?? [];
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 10));
const answerWith = (call: Call | undefined, text: string): void => call?.answer.resolve({ claims: [{ text, references: idsOf(call).slice(0, 1) }] });

beforeEach(() => {
  db = initDatabase(":memory:");
  saveBalanceState(db, seed());
  dir = mkdtempSync(join(tmpdir(), "desk-brief-synthesis-"));
  mkdirSync(join(dir, "studio", "threads"), { recursive: true });
  for (const args of [["init", "-q"], ["config", "user.name", "Test Author"], ["config", "user.email", "author@example.test"]]) Bun.spawnSync(["git", ...args], { cwd: join(dir, "studio") });
  options = { ...briefOptions(dir), studio: { dir: join(dir, "studio"), maxActive: 3, filer: { ...CLOUD, local: LOCAL } } };
  calls = [];
  seq = 0;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("meeting brief synthesis", () => {
  it("shares the source read across concurrent prepare and poll requests", async () => {
    const rt = await runtime();
    const sourceAnswer = deferred<null>();
    let reads = 0;
    rt.sourceCache = new SourceCache(async () => {
      reads += 1;
      await sourceAnswer.promise;
      return JSON.stringify(fixture());
    });
    const requests = [send(post({ event: EVENT }), rt), send(get(), rt), send(get(), rt)];
    sourceAnswer.resolve(null);
    await Promise.all(requests);
    expect(reads).toBe(1);
  });

  it("returns evidence at once, coalesces duplicate requests into one model call, and polls to a cited summary", async () => {
    setPolicy("cloud");
    link(subject("mail", "mail:m1", MAIL));
    link(subject("task", "task:kickoff"));
    const rt = await runtime();
    const [first, second] = await Promise.all([send(post({ event: EVENT }), rt), send(post({ event: EVENT }), rt)]);
    const queued = brief(first.json);
    expect(queued.facts).toHaveLength(2);
    expect(queued.synthesis).toMatchObject({ state: "preparing", phrase: { code: "brief.synthesis-preparing" } });
    expect(brief(second.json).synthesis).toEqual(queued.synthesis);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("cloud-model");

    const polling = await send(get(), rt);
    expect(brief(polling.json).synthesis).toEqual(queued.synthesis);
    expect(calls).toHaveLength(1);

    const factIds = queued.facts.map(fact => fact.id);
    calls[0]?.answer.resolve({ claims: [{ text: "The venue costs 900 and the kickoff needs prep.", references: factIds }] });
    await settle();
    const done = brief((await send(get(), rt)).json);
    expect(done.synthesis).toMatchObject({ state: "ready", claims: [{ text: "The venue costs 900 and the kickoff needs prep.", references: factIds }] });
    expect(done.preparedAt).toBe(queued.preparedAt);
    expect(done.synthesis.state === "ready" && done.synthesis.completedAt).toBe(new Date(NOW).toISOString());
    expect(done.facts).toEqual(queued.facts);

    const reused = await send(post({ event: EVENT }), rt);
    expect(brief(reused.json).synthesis).toEqual(done.synthesis);
    expect(calls).toHaveLength(1);
  });

  it("sends a brief holding a local-only source to the local lane only, never the cloud one", async () => {
    setPolicy("cloud");
    link(subject("mail", "mail:m1", MAIL));
    link(subject("note", `note:${addNote(db, "note", "Bring the budget sheet", null, NOW).id}`));
    const rt = await runtime();
    await send(post({ event: EVENT }), rt);
    expect(calls.map(call => call.model)).toEqual(["local-model"]);
    answerWith(calls[0], "A note and a mail exist.");
    await settle();
    expect(brief((await send(get(), rt)).json).synthesis.state).toBe("ready");
    expect(calls).toHaveLength(1);
  });

  it("makes zero model calls and never falls back to the cloud when a local-only source has no local model", async () => {
    link(subject("mail", "mail:m1", MAIL));
    const rt = await runtime();
    const { filer } = options.studio ?? {};
    if (!filer) throw new Error("fixture has a filer");
    delete filer.local;
    const prepared = brief((await send(post({ event: EVENT }), rt)).json);
    expect(prepared.facts).toHaveLength(1);
    expect(prepared.synthesis).toMatchObject({ state: "unavailable", reason: "no-local-model", phrase: { code: "brief.synthesis-no-local-model" } });
    expect(calls).toHaveLength(0);
    expect(brief((await send(get(), rt)).json).synthesis).toMatchObject({ state: "unavailable", reason: "no-local-model" });
  });

  it("includes the previous meeting's sources in the policy join", async () => {
    setPolicy("cloud");
    link(subject("task", "task:kickoff"));
    const note = addNote(db, "note", "Private agreement from last time", null, NOW);
    const earlier = { kind: "meeting" as const, key: "cal:cal:prior", title: "Earlier sync", at: NOW - 86_400_000, end: NOW - 86_400_000 + 1 };
    expect(linkToMeeting(db, subject("note", `note:${note.id}`), earlier, { id: "prior-link", requestId: "00000000-0000-4000-8000-0000000000aa", origin: "desk", now: NOW }).ok).toBe(true);
    setPreviousRelation(db, { event: EVENT, eventConnection: "cal", previousEvent: "cal:cal:prior", previousConnection: "cal" }, NOW);
    const data = fixture();
    data.events.push({ id: "prior", title: "Earlier sync", start: new Date(NOW - 86_400_000).toISOString(), end: new Date(NOW - 86_400_000 + 3_600_000).toISOString() });
    const rt = await briefRuntime(options, data);
    const prepared = brief((await send(post({ event: EVENT }), rt)).json);
    expect(prepared.previousMeeting.state).toBe("identified");
    expect(calls.map(call => call.model)).toEqual(["local-model"]);
    expect(calls[0]?.prompt.facts.map(fact => fact.text)).toEqual(["Task: Kickoff prep", "Note: Private agreement from last time"]);
  });

  it.each([
    ["a mix of known and unknown references", (ids: string[]) => ({ claims: [{ text: "Made up.", references: [...ids, "fact-0000000000000000"] }] })],
    ["an empty reference list", (_ids: string[]) => ({ claims: [{ text: "Unsupported.", references: [] }] })],
    ["a missing reference list", () => ({ claims: [{ text: "Unsupported." }] })],
    ["a claim from another brief", () => ({ claims: [{ text: "Other.", references: ["fact-ffffffffffffffff"] }] })],
    ["no claims", () => ({ claims: [] })],
    ["no JSON object", () => "an essay"],
  ])("fails the whole summary on %s and keeps the evidence readable", async (_name, answer) => {
    setPolicy("cloud");
    link(subject("task", "task:kickoff"));
    const rt = await runtime();
    await send(post({ event: EVENT }), rt);
    calls[0]?.answer.resolve(answer(idsOf(calls[0])));
    await settle();
    const read = brief((await send(get(), rt)).json);
    expect(read.facts).toHaveLength(1);
    expect(read.synthesis).toMatchObject({ state: "failed", reason: "invalid-output", phrase: { code: "brief.synthesis-invalid-output" } });
    expect(JSON.stringify(read.synthesis)).not.toContain("Unsupported");
    expect(JSON.stringify(read.synthesis)).not.toContain("Made up");

    await send(post({ event: EVENT }), rt);
    expect(calls).toHaveLength(2);
  });

  it("reports a model failure with a redacted explanation and retries on the next POST", async () => {
    setPolicy("cloud");
    link(subject("task", "task:kickoff"));
    const rt = await runtime();
    await send(post({ event: EVENT }), rt);
    calls[0]?.answer.reject(new Error("connect to https://cloud.example.test failed with key sk-secret"));
    await settle();
    const failed = brief((await send(get(), rt)).json);
    expect(failed.facts).toHaveLength(1);
    expect(failed.synthesis).toMatchObject({ state: "failed", reason: "model-failed", phrase: { code: "brief.synthesis-model-failed" } });
    expect(JSON.stringify(failed.synthesis)).not.toContain("sk-secret");
    const retried = brief((await send(post({ event: EVENT }), rt)).json);
    expect(retried.synthesis.state).toBe("preparing");
    expect(calls).toHaveLength(2);
  });

  it("lets a refresh start a new generation whose result no late older result can overwrite", async () => {
    setPolicy("cloud");
    link(subject("task", "task:kickoff"));
    const rt = await runtime();
    const first = brief((await send(post({ event: EVENT }), rt)).json).synthesis;
    const refreshed = brief((await send(post({ event: EVENT, refresh: true }), rt)).json).synthesis;
    expect(calls).toHaveLength(2);
    if (first.state !== "preparing" || refreshed.state !== "preparing") throw new Error("both generations are preparing");
    expect(refreshed.generation).not.toBe(first.generation);
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(calls[1]?.signal?.aborted).toBe(false);

    answerWith(calls[1], "Refreshed result.");
    await settle();
    answerWith(calls[0], "Late older result.");
    await settle();
    const read = brief((await send(get(), rt)).json).synthesis;
    expect(read).toMatchObject({ state: "ready", generation: refreshed.generation });
    expect(JSON.stringify(read)).toContain("Refreshed result.");
    expect(JSON.stringify(read)).not.toContain("Late older result.");
  });

  it("does not show an older generation that finishes first as the refreshed result", async () => {
    setPolicy("cloud");
    link(subject("task", "task:kickoff"));
    const rt = await runtime();
    await send(post({ event: EVENT }), rt);
    await send(post({ event: EVENT, refresh: true }), rt);
    answerWith(calls[0], "Older result.");
    await settle();
    const midway = brief((await send(get(), rt)).json).synthesis;
    expect(midway.state).toBe("preparing");
    answerWith(calls[1], "Refreshed result.");
    await settle();
    expect(JSON.stringify(brief((await send(get(), rt)).json).synthesis)).toContain("Refreshed result.");
  });

  it("starts a new generation when the evidence changes and drops the older one's result", async () => {
    setPolicy("cloud");
    link(subject("task", "task:kickoff"));
    link(subject("note", `note:${addNote(db, "note", "Agenda", null, NOW).id}`));
    const rt = await runtime();
    await send(post({ event: EVENT }), rt);
    saveBalanceState(db, (() => { const state = seed(); const task = state.outline.children[0]?.children[0]; if (task) task.title = "Kickoff prep, revised"; return state; })());
    const stale = await send(get(), rt);
    expect(stale.status).toBe(409);
    await send(post({ event: EVENT, refresh: true }), rt);
    expect(calls).toHaveLength(2);
    answerWith(calls[0], "From the old evidence.");
    await settle();
    expect(brief((await send(get(), rt)).json).synthesis.state).toBe("preparing");
  });

  it("turns a worker that died into a recoverable failure instead of preparing forever", async () => {
    setPolicy("cloud");
    link(subject("task", "task:kickoff"));
    const rt = await runtime();
    const queued = brief((await send(post({ event: EVENT }), rt)).json).synthesis;
    if (queued.state !== "preparing") throw new Error("queued");
    db.query("UPDATE desk_meeting_syntheses SET generation = 'dead-worker', body = json_set(body, '$.generation', 'dead-worker')").run();
    const read = brief((await send(get(), rt)).json);
    expect(read.facts).toHaveLength(1);
    expect(read.synthesis).toMatchObject({ state: "failed", reason: "interrupted", phrase: { code: "brief.synthesis-interrupted" } });
    const retried = brief((await send(post({ event: EVENT }), rt)).json).synthesis;
    expect(retried).toMatchObject({ state: "preparing" });
    expect(calls).toHaveLength(2);
  });

  it("never serves a cached summary after its source was revoked, restricted or its lane removed", async () => {
    setPolicy("cloud");
    link(subject("mail", "mail:m1", MAIL));
    link(subject("task", "task:kickoff"));
    const rt = await runtime();
    await send(post({ event: EVENT }), rt);
    answerWith(calls[0], "The venue costs 900.");
    await settle();
    expect(brief((await send(get(), rt)).json).synthesis.state).toBe("ready");

    const savedAreas = options.areas;
    options.areas = [];
    const revoked = await send(get(), rt);
    expect(revoked.status).toBe(409);
    expect(JSON.stringify(revoked.json)).not.toContain("venue");
    options.areas = savedAreas;

    setPolicy("local");
    const restricted = await send(get(), rt);
    expect(restricted.status).toBe(409);
    expect(JSON.stringify(restricted.json)).not.toContain("venue");
    const again = brief((await send(post({ event: EVENT }), rt)).json);
    expect(again.synthesis.state).toBe("preparing");
    expect(calls.map(call => call.model)).toEqual(["cloud-model", "local-model"]);

    answerWith(calls[1], "Local summary.");
    await settle();
    const { filer } = options.studio ?? {};
    if (!filer) throw new Error("fixture has a filer");
    delete filer.local;
    const noLane = brief((await send(get(), rt)).json);
    expect(noLane.facts).toHaveLength(2);
    expect(noLane.synthesis).toMatchObject({ state: "unavailable", reason: "no-local-model" });
    expect(JSON.stringify(noLane)).not.toContain("Local summary.");
  });

  it("reuses a completed summary only while the model configuration is unchanged", async () => {
    setPolicy("cloud");
    link(subject("task", "task:kickoff"));
    const rt = await runtime();
    await send(post({ event: EVENT }), rt);
    answerWith(calls[0], "First.");
    await settle();
    const { filer } = options.studio ?? {};
    if (!filer || !("model" in filer)) throw new Error("fixture has an endpoint filer");
    filer.model = "another-cloud-model";
    expect(brief((await send(get(), rt)).json).synthesis).toMatchObject({ state: "unavailable", reason: "not-prepared" });
    await send(post({ event: EVENT }), rt);
    expect(calls.map(call => call.model)).toEqual(["cloud-model", "another-cloud-model"]);
  });
});

describe("meeting brief synthesis over the real Mission Control routes", () => {
  it("delivers evidence before a slow local model answers and keeps the cloud endpoint untouched", async () => {
    const hits = { local: 0, cloud: 0 };
    const gate = deferred<null>();
    const endpoint = (kind: keyof typeof hits, wait: boolean) => Bun.serve({
      port: 0,
      async fetch(req) {
        hits[kind] += 1;
        const body = await req.json() as { messages: { content: string }[] };
        if (wait) await gate.promise;
        const facts = (JSON.parse(body.messages[1]?.content ?? "{}") as SynthesisPrompt).facts;
        const content = JSON.stringify({ claims: [{ text: `Summary from ${kind}.`, references: facts.map(fact => fact.id) }] });
        return Response.json({ choices: [{ message: { content } }] });
      },
    });
    const local = endpoint("local", true);
    const cloud = endpoint("cloud", false);
    const dbHttp = initDatabase(join(dir, "http.sqlite"));
    saveBalanceState(dbHttp, seed());
    const previous = db;
    db = dbHttp;
    link(subject("mail", "mail:m1", MAIL));
    db = previous;
    writeFileSync(join(dir, "source.json"), JSON.stringify(fixture()));
    const httpOptions: DeskOptions = {
      ...briefOptions(dir),
      studio: { dir: join(dir, "studio"), maxActive: 3, filer: { baseUrl: `http://localhost:${cloud.port}/v1`, model: "cloud-model", timeoutSeconds: 5, maxPerPass: 1, sourcePolicy: "cloud", local: { baseUrl: `http://127.0.0.1:${local.port}/v1`, model: "local-model", timeoutSeconds: 5, maxPerPass: 1 } } },
    };
    const ctx = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: [PRINCIPAL], localPrincipal: PRINCIPAL } }, dbHttp, { desk: httpOptions });
    const base = `http://localhost:${ctx.server.port}/api/desk/meeting-brief`;
    const headers = { origin: `http://localhost:${ctx.server.port}`, "content-type": "application/json", "Cf-Access-Authenticated-User-Email": PRINCIPAL };
    try {
      const prepared = await fetch(base, { method: "POST", headers, body: JSON.stringify({ event: EVENT }) });
      const queued = await prepared.json() as MeetingBrief;
      expect(prepared.status).toBe(200);
      expect(queued.facts).toHaveLength(1);
      expect(queued.synthesis.state).toBe("preparing");
      const polled = await (await fetch(`${base}?event=${EVENT}`, { headers })).json() as MeetingBrief;
      expect(polled.synthesis.state).toBe("preparing");
      expect(hits).toEqual({ local: 1, cloud: 0 });
      gate.resolve(null);
      let finished = polled;
      for (let attempt = 0; attempt < 50 && finished.synthesis.state === "preparing"; attempt += 1) {
        await settle();
        finished = await (await fetch(`${base}?event=${EVENT}`, { headers })).json() as MeetingBrief;
      }
      expect(finished.synthesis).toMatchObject({ state: "ready", claims: [{ text: "Summary from local.", references: queued.facts.map(fact => fact.id) }] });
      expect(hits).toEqual({ local: 1, cloud: 0 });
    } finally {
      gate.resolve(null);
      ctx.stop(true);
      dbHttp.close();
      local.stop(true);
      cloud.stop(true);
    }
  });
});

describe("meeting brief model cancellation", () => {
  it("aborts an in-flight HTTP request before its model answers", async () => {
    const started = deferred<null>();
    const answer = deferred<null>();
    const endpoint = Bun.serve({ port: 0, async fetch() { started.resolve(null); await answer.promise; return Response.json({}); } });
    const controller = new AbortController();
    const pending = synthesisModel({ ...LOCAL, baseUrl: `http://127.0.0.1:${endpoint.port}/v1` }, { facts: [] }, LOCAL_CONTENT, "Assistant", controller.signal);
    try {
      await started.promise;
      controller.abort();
      await expect(pending).rejects.toThrow();
    } finally {
      controller.abort();
      answer.resolve(null);
      endpoint.stop(true);
    }
  });

  it("terminates a command model when its generation is aborted", async () => {
    const pidPath = join(dir, "model.pid");
    const script = 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);';
    const controller = new AbortController();
    const pending = synthesisModel({ command: [process.execPath, "-e", script, pidPath], timeoutSeconds: 5, maxPerPass: 1, sourcePolicy: "local" }, { facts: [] }, LOCAL_CONTENT, "Assistant", controller.signal);
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(pidPath); attempt += 1) await settle();
      expect(existsSync(pidPath)).toBe(true);
      const pid = Number(readFileSync(pidPath, "utf8"));
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
    }
  });
});
