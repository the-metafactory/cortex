import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDeskStudioSession, readStudioSession } from "../api/desk-studio-session";
import { HandledLedger } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import { waitsOnYou } from "../desk/studio/board";
import { parseThreadFile } from "../desk/studio/format";
import { sessionModel, type SessionModel } from "../desk/studio/session";
import { SCHEMA_SQL } from "../db/schema";

const dirs: string[] = [];
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const NOTE = "2026-10-31T10:00:00Z";
const fixture = (kind = "idea") => `---\ntype: question\nareas: [lab]\nstate: active\nopened: 2026-10-31\n---\n\n## Question\n\nHow can a paper glider fly farther?\n\n## Where I stand\n\nTry a broad wing.\n\n## Ivy's notes\n\n### ${NOTE}\ntrigger: You asked\nmodel: cloud\nkind: ${kind}\n\nUse a lighter paper wing.\n\n## Log\n`;
const result = { reply: "Try a narrower fold.", summary: "We compared folds.", proposal: "Test a narrow paper wing." };
function rig(kind = "idea") {
  const dir = mkdtempSync(join(tmpdir(), "studio-session-")); dirs.push(dir);
  mkdirSync(join(dir, "threads")); writeFileSync(join(dir, "threads/alpha.md"), fixture(kind));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, ...args]);
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  git("init", "-q"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test"); git("add", "."); git("commit", "-qm", "fixture");
  const db = new Database(":memory:"); databases.push(db); for (const sql of SCHEMA_SQL) db.exec(sql);
  const endpoint = { baseUrl: "http://local.invalid/v1", model: "local-model", timeoutSeconds: 1, maxPerPass: 1 };
  const options = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [{ id: "lab", label: "Lab", color: "", repos: [], goals: [], policy: "cloud" as "cloud" | "local" }], sources: [], studio: { dir, maxActive: 5, filer: { ...endpoint, model: "cloud-model", local: endpoint } } };
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options };
  const id = crypto.randomUUID();
  const post = (body: object, model: SessionModel = async () => result) => handleDeskStudioSession(new Request("http://localhost/api/desk/studio/session", { method: "POST", body: JSON.stringify({ id, ...body }) }), db, runtime, { model });
  const start = (scope: object = { kind: "ghost", note: NOTE }) => post({ action: "start", thread: "alpha", scope });
  const say = (model?: SessionModel, turn = crypto.randomUUID()) => post({ action: "say", turn, text: "Can you reword it around a narrow fold?" }, model);
  const file = () => readFileSync(join(dir, "threads/alpha.md"), "utf8");
  const thread = () => { const p = parseThreadFile("threads/alpha.md", file()); if (!p.ok) throw new Error(p.reason); return p.value; };
  return { dir, db, id, post, start, say, file, thread, git, options };
}

test("session end rewords the selected idea, keeps it and logs the real exchange exactly once", async () => {
  const r = rig(); expect((await r.start()).status).toBe(200); await r.say();
  const outcome = { kind: "reword", text: result.proposal };
  expect((await r.post({ action: "end", outcome })).status).toBe(200);
  expect(r.thread().notes[0]?.text).toBe(result.proposal); expect(r.thread().notes[0]?.status).toBe("kept");
  expect(r.thread().stand).toBe("Try a broad wing."); expect(waitsOnYou(r.thread())).toBe(false); expect(r.file()).toContain("We compared folds."); expect(r.file()).toContain(result.reply);
  const head = r.git("rev-parse", "HEAD");
  expect((await r.post({ action: "end", outcome })).status).toBe(200); expect(r.git("rev-parse", "HEAD")).toBe(head);
  expect((await r.post({ action: "end", outcome: { kind: "dismiss" } })).status).toBe(409);
});

test("keeping a stand adopts it only with the person's explicit outcome; dismissal does not", async () => {
  for (const kind of ["keep", "reword", "dismiss"] as const) {
    const r = rig("stand"); await r.start();
    const outcome = kind === "reword" ? { kind, text: "My own revised stand." } : { kind };
    expect((await r.post({ action: "end", outcome })).status).toBe(200);
    expect(r.thread().stand).toBe(kind === "keep" ? "Use a lighter paper wing." : kind === "reword" ? "My own revised stand." : "Try a broad wing.");
  }
});

test("whole-thread summary can propose a stand without adopting it", async () => {
  const r = rig(); await r.start({ kind: "thread" }); await r.say();
  expect((await r.post({ action: "end", outcome: { kind: "propose", text: result.proposal } })).status).toBe(200);
  expect(r.thread().stand).toBe("Try a broad wing."); expect(r.thread().notes.at(-1)?.kind).toBe("stand"); expect(r.thread().notes.at(-1)?.status).toBe("open");
});

test("strictest current policy picks the model and the session never loses its local privacy pin", async () => {
  const r = rig(); await r.start(); const models: string[] = [];
  const model: SessionModel = async (config, prompt) => { models.push(config.model); expect(prompt.context).toBe(""); return result; };
  await r.say(model); r.options.areas.splice(0, 1, { id: "lab", label: "Lab", color: "", repos: [], goals: [], policy: "local" }); await r.say(model);
  r.options.areas.splice(0, 1, { id: "lab", label: "Lab", color: "", repos: [], goals: [], policy: "cloud" }); await r.say(model);
  expect(models).toEqual(["cloud-model", "local-model", "local-model"]);
});

test("unknown and mixed areas require local; an absent local endpoint saves text and makes no model call", async () => {
  const r = rig(); writeFileSync(join(r.dir, "threads/alpha.md"), fixture().replace("[lab]", "[lab, unknown]")); r.git("add", "."); r.git("commit", "-qm", "unknown area");
  Reflect.deleteProperty(r.options.studio.filer, "local");
  await r.start(); let calls = 0;
  const response = await r.say(async () => { calls++; return result; });
  expect(response.status).toBe(503); expect(calls).toBe(0); expect(readStudioSession(r.db, r.dir, r.id)?.turns).toHaveLength(1);
  expect((await r.post({ action: "end", outcome: { kind: "leave" } })).status).toBe(200); expect(r.file()).toContain("No answer received");
});

test("model failure retains text, permits exact retry and refuses a conflicting turn id", async () => {
  const r = rig(); await r.start(); const turn = crypto.randomUUID();
  expect((await r.say(async () => { throw new Error("offline"); }, turn)).status).toBe(502);
  expect(readStudioSession(r.db, r.dir, r.id)?.turns[0]?.text).toContain("narrow fold");
  expect((await r.post({ action: "say", turn, text: "Changed" })).status).toBe(409);
  expect((await r.say(undefined, turn)).status).toBe(200); expect(readStudioSession(r.db, r.dir, r.id)?.turns).toHaveLength(1);
});

test("closing during a model wait records the finished turn and preserves the idea", async () => {
  const r = rig(); await r.start(); let unblock = (): void => {}; let entered = (): void => {};
  const waiting = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { unblock = resolve; });
  const saying = r.say(async () => { entered(); await gate; return result; }); await waiting;
  const ending = r.post({ action: "end", outcome: { kind: "leave" } }); unblock();
  expect((await saying).status).toBe(200); expect((await ending).status).toBe(200);
  expect(r.file()).toContain(result.reply); expect(r.thread().notes[0]?.status).toBe("open");
});

test("retry after a note commit before the SQLite receipt replays the commit and rejects another outcome", async () => {
  const r = rig(); await r.start(); await r.say(); const outcome = { kind: "keep" };
  const before = readStudioSession(r.db, r.dir, r.id); if (!before) throw new Error("no session");
  await r.post({ action: "end", outcome }); const head = r.git("rev-parse", "HEAD");
  r.db.query("UPDATE desk_studio_sessions SET data = ? WHERE id = ?").run(JSON.stringify({ ...before, phase: { kind: "ending", outcome } }), r.id);
  expect((await r.post({ action: "end", outcome: { kind: "dismiss" } })).status).toBe(409);
  expect((await r.post({ action: "end", outcome })).status).toBe(200); expect(r.git("rev-parse", "HEAD")).toBe(head);
});

test("concurrent committed edits survive; changed ghost refuses applying outcome but close can save", async () => {
  const r = rig(); await r.start(); await r.say();
  writeFileSync(join(r.dir, "threads/alpha.md"), r.file().replace("Use a lighter paper wing.", "Human changed this idea.")); r.git("add", "."); r.git("commit", "-qm", "human edit");
  expect((await r.post({ action: "end", outcome: { kind: "keep" } })).status).toBe(409);
  expect(r.file()).toContain("Human changed this idea."); expect(r.thread().notes).toHaveLength(1);
  expect((await r.post({ action: "end", outcome: { kind: "leave" } })).status).toBe(200); expect(r.file()).toContain("Human changed this idea.");
});

test("the real session transport declares no tools and sends only its explicit synthetic payload", async () => {
  const server = Bun.serve({ port: 0, fetch: async req => {
    const body = await req.json(); expect(body.tools).toBeUndefined(); expect(body.messages).toHaveLength(2); expect(body.messages[1].content).toContain("paper glider");
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  } });
  try { expect(await sessionModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "test", timeoutSeconds: 2, maxPerPass: 1 }, { question: "paper glider", stand: "", subject: "fold", context: "", exchange: [] })).toEqual(result); }
  finally { server.stop(true); }
});


test("an intervening human stand edit is never overwritten by a stale discussion choice", async () => {
  const r = rig("stand"); await r.start();
  writeFileSync(join(r.dir, "threads/alpha.md"), r.file().replace("Try a broad wing.", "My newer stand.")); r.git("add", "."); r.git("commit", "-qm", "new stand");
  expect((await r.post({ action: "end", outcome: { kind: "keep" } })).status).toBe(409);
  expect(r.thread().stand).toBe("My newer stand.");
  expect((await r.post({ action: "end", outcome: { kind: "leave" }, draft: "My unsent closing thought." })).status).toBe(200);
  expect(r.file()).toContain("My unsent closing thought."); expect(r.thread().stand).toBe("My newer stand.");
});

test("dirty-tree end refusal retains the exchange for recovery and a clean retry", async () => {
  const r = rig(); await r.start(); await r.say(); writeFileSync(join(r.dir, "human.txt"), "A human edit.");
  expect((await r.post({ action: "end", outcome: { kind: "leave" } })).status).toBe(409);
  const recovery = await r.post({ action: "recover" }); expect((await recovery.json()).sessions).toHaveLength(1);
  expect(r.file()).not.toContain(result.reply); r.git("add", "."); r.git("commit", "-qm", "human addition");
  expect((await r.post({ action: "end", outcome: { kind: "leave" } })).status).toBe(200); expect(readFileSync(join(r.dir, "human.txt"), "utf8")).toBe("A human edit.");
});


test("clearing a draft after a refused ending excludes it from the eventual note", async () => {
  const r = rig(); await r.start(); writeFileSync(join(r.dir, "scratch.txt"), "temporary dirty edit");
  expect((await r.post({ action: "end", outcome: { kind: "leave" }, draft: "Obsolete unsent text." })).status).toBe(409);
  rmSync(join(r.dir, "scratch.txt"));
  expect((await r.post({ action: "end", outcome: { kind: "leave" }, draft: "" })).status).toBe(200);
  expect(r.file()).not.toContain("Obsolete unsent text.");
});

test("sending a replacement retires a draft retained by an earlier refused ending", async () => {
  const r = rig(); await r.start(); writeFileSync(join(r.dir, "scratch.txt"), "temporary dirty edit");
  expect((await r.post({ action: "end", outcome: { kind: "leave" }, draft: "Discarded draft." })).status).toBe(409);
  rmSync(join(r.dir, "scratch.txt")); await r.post({ action: "say", turn: crypto.randomUUID(), text: "Can you reword it around a narrow fold?", draft: "Can you reword it around a narrow fold?" });
  expect((await r.post({ action: "end", outcome: { kind: "leave" } })).status).toBe(200);
  expect(r.file()).not.toContain("Discarded draft."); expect(r.file()).toContain("Can you reword it around a narrow fold?");
});


test("composer snapshots distinguish absent, cleared and replacement drafts without changing saved turns", async () => {
  const cases = [{ snapshot: undefined, expected: "Retained original draft." }, { snapshot: "", expected: null }, { snapshot: "Replacement draft.", expected: "Replacement draft." }];
  for (const c of cases) {
    const r = rig(); await r.start(); await r.say(); writeFileSync(join(r.dir, "scratch.txt"), "dirty");
    expect((await r.post({ action: "end", outcome: { kind: "leave" }, draft: "Retained original draft." })).status).toBe(409);
    rmSync(join(r.dir, "scratch.txt"));
    expect((await r.post({ action: "end", outcome: { kind: "leave" }, ...(c.snapshot !== undefined ? { draft: c.snapshot } : {}) })).status).toBe(200);
    expect(r.file()).toContain("You: Can you reword it around a narrow fold?");
    if (c.expected) expect(r.file()).toContain(`You (unsent draft): ${c.expected}`);
    else expect(r.file()).not.toContain("You (unsent draft)");
    if (c.snapshot !== undefined) expect(r.file()).not.toContain("Retained original draft.");
  }
});

test("replaying an answered turn can retain a separate edited next draft without changing that turn", async () => {
  const r = rig(); await r.start(); const turn = crypto.randomUUID(); await r.say(undefined, turn);
  const text = "Can you reword it around a narrow fold?";
  expect((await r.post({ action: "say", turn, text, draft: "A separate edited next thought." })).status).toBe(200);
  const saved = readStudioSession(r.db, r.dir, r.id); expect(saved?.turns).toHaveLength(1); expect(saved?.turns[0]?.text).toBe(text); expect(saved?.draft).toBe("A separate edited next thought.");
  expect((await r.post({ action: "end", outcome: { kind: "leave" } })).status).toBe(200); expect(r.file()).toContain("A separate edited next thought.");
});
