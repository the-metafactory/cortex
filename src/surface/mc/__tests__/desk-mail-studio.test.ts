import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitIn, seedStudioRepo } from "./__fixtures__/studio-git";
import { initDatabase } from "../db/init";
import { handleDeskMail } from "../api/desk-mail";
import { handleGetDeskStudio } from "../api/desk-studio";
import { handleDeskCaptureUndo } from "../api/desk-ask";
import { handleDeskLinks } from "../api/desk-links";
import { HandledLedger } from "../desk/actions";
import { readDone } from "../desk/autonomy";
import { saveClassification } from "../desk/classify";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import { queryMailLog } from "../desk/mail-log";
import { activeMailLink } from "../desk/links";
import { WORK_MAIL_NO_THREAD, mailLine, senderPerson } from "../desk/mail-studio";
import { threadPeople } from "../desk/studio/relates";
import { createRule, DEFAULT_MAIL_RULES, runMailRules, undoRuleRun } from "../desk/mail-rules";
import { ruleAttach } from "../desk/rule-attach";
import type { CaptureModel, CaptureRequest } from "../desk/studio/capture";
import { parseThreadFile } from "../desk/studio/format";
import { SourceCache, type SourceMail } from "../desk/sources/command";
import type { ClassifierConfig } from "../desk/classify";

const NOW = Date.parse("2026-11-02T09:00:00.000Z");
const CLOUD = { baseUrl: "https://filer.example.org/v1", model: "cloud-filer", timeoutSeconds: 5, maxPerPass: 10 };
const LOCAL = { baseUrl: "http://127.0.0.1:11434/v1", model: "local-filer", timeoutSeconds: 5, maxPerPass: 10 };
const AREAS = [{ id: "lab", label: "Lab", color: "", repos: [], goals: [], policy: "cloud" as const }, { id: "private", label: "Private", color: "", repos: [], goals: [], policy: "local" as const }];
const thread = (question: string, areas: string): string => `---\ntype: question\nareas: [${areas}]\nstate: active\nopened: 2026-10-31\n---\n\n## Question\n\n${question}\n\n## Where I stand\n\nStill deciding.\n\n## Material\n\n- link: Existing source\n\n## Log\n\n- 2026-10-31: Opened\n`;

const mail = (id: string, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id, from: { name: "Ada Lovelace", address: "ada@example.org" }, subject: `Engines ${id}`, receivedAt: "2026-11-02T08:00:00.000Z", unread: true,
  account: "work", firstParagraph: "The analytical engine could weave patterns.\nSecond line of the body.", url: `message://%3c${id}%3e`, headers: {}, ...over,
});

let dir: string;
let db: Database;
let runtime: DeskRuntime;
let calls: { config: ClassifierConfig; request: CaptureRequest }[];
let answer: unknown;
const model: CaptureModel = async (config, request) => { calls.push({ config, request }); return answer; };
const post = (body: unknown): Request => new Request("http://localhost/api/desk/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const act = async (body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  const res = await handleDeskMail(post(body), db, runtime, { now: () => NOW, captureModel: model });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
};
const readThread = (slug: string): string => readFileSync(join(dir, `threads/${slug}.md`), "utf8");
const git = (...args: string[]): string => gitIn(dir, ...args);

beforeEach(async () => {
  dir = seedStudioRepo("desk-mail-studio-", { engines: thread("What can engines make?", "lab"), home: thread("How do we live at home?", "private") });
  db = initDatabase(":memory:");
  calls = [];
  answer = { thread: "engines", reason: "It is about what engines make." };
  const options: DeskOptions = {
    enabled: true, displayName: "Ada", topN: 5, rangerUrl: "", areas: AREAS,
    sources: [{ id: "work-mail", command: ["work"], area: "lab", everySeconds: 300, timeoutSeconds: 30 }, { id: "home-mail", command: ["home"], area: "private", everySeconds: 300, timeoutSeconds: 30 }],
    studio: { dir, maxActive: 5, filer: { ...CLOUD, local: LOCAL } },
  };
  const items: Record<string, SourceMail[]> = { work: [mail("w1")], home: [mail("h1", { from: { address: "nan@example.org" } })] };
  runtime = { options, ledger: new HandledLedger(), sourceCache: new SourceCache(async (argv) => JSON.stringify({ items: items[argv[0] ?? ""] ?? [] })) };
  await composeDesk(db, options, undefined, { now: NOW, handled: runtime.ledger, sourceCache: runtime.sourceCache });
  saveClassification(db, "w1", { category: "fyi", reason: "News.", summary: "Ada describes a weaving engine." }, "test", NOW);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("Add a mail to a Studio thread", () => {
  it("offers Add to thread on mail cards when the Studio is set up", async () => {
    const options = runtime.options;
    if (!options) throw new Error("no desk options");
    const view = await composeDesk(db, options, undefined, { now: NOW, handled: runtime.ledger, ...(runtime.sourceCache ? { sourceCache: runtime.sourceCache } : {}) });
    const card = view.items.find((i) => i.key === "mail:w1");
    expect([...(card?.actions ?? []), ...(card?.more ?? [])].some((a) => a.id === "mail.studio" && a.label === "Add to thread")).toBe(true);
  });

  it("proposes the filer's thread with its reason and lists every thread the mail may go to", async () => {
    const { status, json } = await act({ action: "studio.propose", key: "mail:w1" });
    expect(status).toBe(200);
    expect(json.proposal).toEqual({ thread: "engines", reason: "It is about what engines make.", threads: [{ slug: "engines", question: "What can engines make?" }, { slug: "home", question: "How do we live at home?" }], canIncludeText: true });
    expect(calls[0]?.config).toMatchObject({ model: "local-filer" });
    expect(calls[0]?.request.capture).toContain("Ada describes a weaving engine.");
    expect(calls[0]?.request.capture).not.toContain("Second line of the body");
    expect(readdirSync(dir)).not.toContain("inbox");
  });

  it("does not preselect a thread the filer only calls a suggestion", async () => {
    answer = { thread: "engines", match: false, reason: "Only loosely related." };
    const { json } = await act({ action: "studio.propose", key: "mail:w1" });
    expect(json.proposal).toMatchObject({ thread: null, reason: "Only loosely related." });
  });

  it("does not send local or unknown mail to a cloud filer even with only cloud threads", async () => {
    const desk = runtime.options;
    if (!desk?.studio?.filer) throw new Error("no Studio fixture");
    writeFileSync(join(dir, "threads/home.md"), readThread("home").replace("areas: [private]", "areas: [lab]"));
    desk.studio.filer.local = undefined;
    const result = await act({ action: "studio.propose", key: "mail:h1" });
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(result.json.proposal).toMatchObject({ thread: null });
  });

  it("keeps a mail from a local-policy area to local threads, and out of cloud threads and the inbox", async () => {
    const before = git("rev-parse", "HEAD");
    const { json } = await act({ action: "studio.propose", key: "mail:h1" });
    expect((json.proposal as { threads: { slug: string }[] }).threads.map((t) => t.slug)).toEqual(["home"]);
    for (const thread of ["engines", null]) {
      const refused = await act({ action: "studio.add", key: "mail:h1", requestId: `req-local-${thread}`, thread, includeText: false });
      expect(refused.status).toBe(409);
      expect(String(refused.json.error)).toBe(WORK_MAIL_NO_THREAD);
    }
    expect(git("rev-parse", "HEAD")).toBe(before);
    expect(readThread("engines")).not.toContain("Mail from nan@example.org");
    expect((await act({ action: "studio.add", key: "mail:h1", requestId: "req-local-home", thread: "home", includeText: false })).status).toBe(200);
    expect(readThread("home")).toContain("Mail from nan@example.org");
  });

  it("files the summary, sender, date and link in the proposed thread, without the body, and logs it", async () => {
    const before = git("rev-parse", "HEAD");
    const { status, json } = await act({ action: "studio.add", key: "mail:w1", requestId: "req-add-1", thread: "engines", reason: "It is about what engines make.", includeText: false });
    expect(status).toBe(200);
    expect(json.message).toBe("Added “Engines w1” to “What can engines make?”.");
    const text = readThread("engines");
    expect(text).toContain("Mail from Ada Lovelace <ada@example.org>, received 2026-11-02");
    expect(text).toContain("“Engines w1”. Ada describes a weaving engine. Open in Mail: <message://%3cw1%3e>");
    expect(text).not.toContain("weave patterns");
    expect(text).toContain("the filer said: It is about what engines make.");
    expect(git("rev-parse", "HEAD")).not.toBe(before);
    expect(queryMailLog(db).map((e) => [e.messageId, e.action, e.where])).toEqual([["w1", "studio", "desk"]]);
    expect(readDone(db, NOW)[0]?.action).toBe("studio.capture");
  });

  it("lets the principal override to the Studio inbox and copies the text only when asked", async () => {
    const { status } = await act({ action: "studio.add", key: "mail:w1", requestId: "req-inbox-1", thread: null, includeText: true });
    expect(status).toBe(200);
    const [name] = readdirSync(join(dir, "inbox"));
    const inbox = readFileSync(join(dir, `inbox/${name ?? ""}`), "utf8");
    expect(inbox).toContain("via: mail");
    expect(inbox).toContain("> The analytical engine could weave patterns.");
    expect(readThread("engines")).not.toContain("capture:");
    expect(inbox).not.toContain("person:");
  });

  it("Undo removes the capture and its quoted text from the thread", async () => {
    const seeded = readThread("engines");
    await act({ action: "studio.add", key: "mail:w1", requestId: "req-undo-1", thread: "engines", includeText: true });
    const added = readThread("engines");
    expect(added).toContain("  > The analytical engine could weave patterns.");
    expect(added).toContain("you chose this thread");
    const parsed = parseThreadFile("threads/engines.md", added);
    expect(parsed.ok && parsed.value.material.map((m) => m.kind)).toEqual(["link", "capture", "person"]);
    const id = readDone(db, NOW)[0]?.itemKey ?? "";
    const res = await handleDeskCaptureUndo(new Request("http://localhost/api/desk/capture/undo", { method: "POST", body: JSON.stringify({ id, requestId: "req-undo-2" }) }), db, runtime);
    expect(res.status).toBe(200);
    const after = readThread("engines");
    expect(after).not.toContain("capture:");
    expect(after).not.toContain("weave patterns");
    expect(after.split("## Log")[0]).toBe(seeded.split("## Log")[0]);
    expect(readDone(db, NOW)[0]?.action).toBe("studio.capture.undone");
  });

  it("Add to thread attaches the mail: the card leaves the Desk, and the capture undo brings it back", async () => {
    const compose = async () => (await composeDesk(db, runtime.options ?? ({} as DeskOptions), undefined, { now: NOW, handled: runtime.ledger, ...(runtime.sourceCache ? { sourceCache: runtime.sourceCache } : {}) })).items.some((i) => i.key === "mail:w1");
    await act({ action: "studio.add", key: "mail:w1", requestId: "req-link-1", thread: "engines", includeText: false });
    const id = readDone(db, NOW)[0]?.itemKey ?? "";
    expect(activeMailLink(db, "w1")).toMatchObject({ id, toKind: "thread", toKey: "engines", toTitle: "What can engines make?", origin: "desk" });
    expect(await compose()).toBe(false);
    expect((await act({ action: "studio.add", key: "mail:w1", requestId: "req-link-1", thread: "engines", includeText: false })).status).toBe(200);
    expect(await act({ action: "studio.add", key: "mail:w1", requestId: "req-link-2", thread: "engines", includeText: false })).toEqual({ status: 409, json: { ok: false, error: "This mail is already attached to “What can engines make?”. Undo that first." } });
    await handleDeskCaptureUndo(new Request("http://localhost/api/desk/capture/undo", { method: "POST", body: JSON.stringify({ id, requestId: "req-link-3" }) }), db, runtime);
    expect(activeMailLink(db, "w1")).toBeNull();
    expect(await compose()).toBe(true);
  });

  it("attach.undo on a thread link removes the capture from the thread", async () => {
    await act({ action: "studio.add", key: "mail:w1", requestId: "req-link-4", thread: "engines", includeText: false });
    const id = readDone(db, NOW)[0]?.itemKey ?? "";
    expect(await act({ action: "attach.undo", link: id })).toEqual({ status: 200, json: { ok: true, message: "“Engines w1” is back on the Desk.", restored: "mail:w1" } });
    expect(readThread("engines")).not.toContain("capture:");
    expect(readDone(db, NOW)[0]?.action).toBe("studio.capture.undone");
  });

  it("serves a mail filed with its text as the capture item's untrusted text", async () => {
    await act({ action: "studio.add", key: "mail:w1", requestId: "req-text-1", thread: "engines", includeText: true });
    const body = await (await handleGetDeskStudio(runtime)).json() as { materialText: string; studio: { active: { slug: string; material: { kind: string; text?: string }[] }[] } };
    expect(body.materialText).toBe("untrusted");
    const material = body.studio.active.find((t) => t.slug === "engines")?.material ?? [];
    expect(material.map((m) => [m.kind, m.text ?? null])).toEqual([["link", null], ["capture", "The analytical engine could weave patterns.\nSecond line of the body."], ["person", null]]);
  });

  it("links a Studio thread to a meeting", async () => {
    const event = { id: "e1", start: "2026-11-02T13:00:00.000Z", end: "2026-11-02T14:00:00.000Z", title: "Engine review" };
    runtime = { ...runtime, sourceCache: new SourceCache(async (argv) => JSON.stringify({ items: argv[0] === "work" ? [mail("w1")] : [], events: argv[0] === "work" ? [event] : [] })) };
    await runtime.sourceCache?.read(runtime.options?.sources ?? [], NOW);
    const res = await handleDeskLinks(new Request("http://localhost/api/desk/links", { method: "POST", body: JSON.stringify({ op: "link", requestId: "0f3c1a52-6c1e-4b8f-9d2a-1f0e5b7c9a11", from: { kind: "thread", slug: "engines" }, to: { kind: "meeting", event: "cal:work-mail:e1" } }) }), db, runtime, { now: () => NOW, newId: () => "link-1" });
    expect(await res.json()).toMatchObject({ ok: true, link: { from: { kind: "thread", key: "thread:engines", title: "What can engines make?" }, to: { kind: "meeting", title: "Engine review" } } });
  });

  it("an attach rule files matching mail in its thread, and Undo removes the capture", async () => {
    const options = runtime.options;
    if (!options) throw new Error("no desk options");
    createRule(db, { match: "sender", value: "ada@example.org", action: "attach", target: { kind: "thread", key: "engines", title: "What can engines make?" } }, NOW, () => "r1");
    const readings = runtime.sourceCache?.cached() ?? [];
    const attach = ruleAttach(db, options, () => readings, () => NOW);
    const ledger = new HandledLedger();
    expect(await runMailRules(readings, { db, mailActions: undefined, ledger, run: async () => ({ code: 0, stdout: "", stderr: "" }), now: () => NOW, config: DEFAULT_MAIL_RULES, newId: () => "run-thread-1", attach })).toEqual({ handled: 1, failed: 0, paused: [] });
    expect(readThread("engines")).toContain("“Engines w1”");
    expect(activeMailLink(db, "w1")).toMatchObject({ toKind: "thread", toKey: "engines", origin: "rule", ruleRun: "run-thread-1" });
    expect(await undoRuleRun("run-thread-1", { db, config: undefined, ledger, run: async () => ({ code: 0, stdout: "", stderr: "" }), now: NOW }, attach)).toMatchObject({ ok: true, restored: "mail:w1" });
    expect(readThread("engines")).not.toContain("capture:");
    expect(activeMailLink(db, "w1")).toBeNull();
  });

  it("refuses a mail the Desk does not list, an inactive thread and a stack without a Studio", async () => {
    expect((await act({ action: "studio.add", key: "mail:gone", requestId: "req-gone-1", thread: "engines", includeText: false })).status).toBe(409);
    expect((await act({ action: "studio.add", key: "mail:w1", requestId: "req-gone-2", thread: "nowhere", includeText: false })).status).toBe(409);
    expect(queryMailLog(db)).toHaveLength(0);
    const { studio: _studio, ...rest } = runtime.options ?? { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [] };
    runtime = { ...runtime, options: rest };
    expect((await act({ action: "studio.propose", key: "mail:w1" })).status).toBe(409);
  });

  it("adds the sender as a person under the capture, so the thread counts them among its people", async () => {
    await act({ action: "studio.add", key: "mail:w1", requestId: "req-person-1", thread: "engines", includeText: true });
    const text = readThread("engines");
    expect(text).toMatch(/- capture: \[capture-[a-f0-9]{32}\] Mail from Ada Lovelace[^\n]*\n( {2}>[^\n]*\n)+- person: Ada Lovelace\n/);
    const parsed = parseThreadFile("threads/engines.md", text);
    expect(parsed.ok && threadPeople(parsed.value).map((p) => p.title)).toEqual(["Ada Lovelace"]);
  });

  it("does not add a sender without a display name", async () => {
    await act({ action: "studio.add", key: "mail:h1", requestId: "req-person-2", thread: "home", includeText: false });
    expect(readThread("home")).toContain("Mail from nan@example.org");
    expect(readThread("home")).not.toContain("person:");
  });

  it("does not add a sender the thread already names, and Undo keeps that person", async () => {
    writeFileSync(join(dir, "threads/engines.md"), readThread("engines").replace("- link: Existing source", "- person: ada  LOVELACE\n\n- link: Existing source"));
    git("commit", "-qam", "Name Ada");
    const seeded = readThread("engines");
    await act({ action: "studio.add", key: "mail:w1", requestId: "req-person-3", thread: "engines", includeText: false });
    expect(readThread("engines").match(/- person: /g)).toHaveLength(1);
    const id = readDone(db, NOW)[0]?.itemKey ?? "";
    const res = await handleDeskCaptureUndo(new Request("http://localhost/api/desk/capture/undo", { method: "POST", body: JSON.stringify({ id, requestId: "req-person-4" }) }), db, runtime);
    expect(await res.json()).toMatchObject({ ok: true, message: "Removed the capture from its thread. Later changes were kept." });
    expect(readThread("engines").split("## Log")[0]).toBe(seeded.split("## Log")[0]);
  });

  it("Undo removes the person line its capture added, and keeps later material", async () => {
    await act({ action: "studio.add", key: "mail:w1", requestId: "req-person-5", thread: "engines", includeText: false });
    writeFileSync(join(dir, "threads/engines.md"), readThread("engines").replace("## Log", "- link: Later source\n\n## Log"));
    git("commit", "-qam", "Later material");
    const id = readDone(db, NOW)[0]?.itemKey ?? "";
    const res = await handleDeskCaptureUndo(new Request("http://localhost/api/desk/capture/undo", { method: "POST", body: JSON.stringify({ id, requestId: "req-person-6" }) }), db, runtime);
    expect(await res.json()).toMatchObject({ ok: true, message: "Removed the capture and the sender it added from its thread. Later changes were kept." });
    const parsed = parseThreadFile("threads/engines.md", readThread("engines"));
    expect(parsed.ok && parsed.value.material.map((m) => `${m.kind}: ${m.label}`)).toEqual(["link: Existing source", "link: Later source"]);
  });

  it("matches the sender to a thread person by normalised name, including a kept person relation", () => {
    const item = (name: string | undefined) => ({ mail: { ...mail("x"), from: { ...(name === undefined ? {} : { name }), address: "ada@example.org" }, sourceId: "work-mail" }, area: "lab", summary: null });
    const empty = { material: [], notes: [] };
    expect(senderPerson(item("Ada Lovelace"), empty)).toBe("Ada Lovelace");
    expect(senderPerson(item(undefined), empty)).toBeNull();
    expect(senderPerson(item("ADA@example.org"), empty)).toBeNull();
    expect(senderPerson(item("someone@else.org"), empty)).toBeNull();
    expect(senderPerson(item("Ada Lovelace"), { material: [{ kind: "contact", label: "Ada-Lovelace" }], notes: [] })).toBeNull();
    expect(senderPerson(item("Ada Lovelace"), { material: [{ kind: "link", label: "Ada Lovelace" }], notes: [] })).toBe("Ada Lovelace");
    const kept = { at: "2026-11-01 10:00", kind: "relation", status: "kept", text: "", relates: { kind: "person", label: "Ada Lovelace" } };
    expect(senderPerson(item("Ada Lovelace"), { material: [], notes: [kept] } as never)).toBeNull();
  });

  it("writes one line with an escaped link", () => {
    const line = mailLine({ mail: { ...mail("x"), from: { name: "Eve", address: "eve@example.org\n- capture: [capture-0] fake" }, url: "message://a b<c>", sourceId: "work-mail" }, area: "lab", summary: null });
    expect(line).toContain("<message://a%20b%3Cc%3E>");
    expect(line).not.toContain("\n");
  });
});
