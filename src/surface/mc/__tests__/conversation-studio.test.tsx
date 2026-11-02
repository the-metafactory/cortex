import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type AppState } from "../../../balance";
import { openConversationHost, type ConversationHost, type HostStatus } from "../../../conversations/host";
import { scratchDirs } from "../../../conversations/__tests__/fixtures/scratch";
import type { ChatCall } from "../../../conversations/model";
import type { ConversationDetail, ConversationEntry, ConversationMeta, OperationRecord, SourceView } from "../../../conversations/types";
import { handleConversations, importedSessions } from "../api/conversations";
import { handleDeskStudioSession } from "../api/desk-studio-session";
import { buildAllowedHostnames, type MutationGuardContext } from "../api/mutation-guard";
import { HandledLedger } from "../desk/actions";
import { saveBalanceState } from "../desk/balance-store";
import type { DeskRuntime } from "../desk/compose";
import { conversationSources } from "../desk/conversation-sources";
import { parseThreadFile } from "../desk/studio/format";
import type { StudioSession } from "../desk/studio/session-schema";
import { SCHEMA_SQL } from "../db/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceView } from "../dashboard-v2/components/desk-conversation";
import { SourceConversationList } from "../dashboard-v2/components/desk-source-conversations";
import { deskSearch, readDeskLocation } from "../dashboard-v2/hooks/use-desk-studio";
import type { ImportableSession } from "../api/conversation-studio";

const LABEL = "ai.meta-factory.cortex.studio-test";
const NOTE = "2026-10-31T10:00:00Z";
const dirs = scratchDirs("conversation-studio-");
const hosts: ConversationHost[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
  for (const db of databases.splice(0)) db.close();
  await dirs.clean();
});

const thread = `---\ntype: question\nareas: [lab]\nstate: active\nopened: 2026-10-31\n---\n\n## Question\n\nHow can a paper glider fly farther?\n\n## Where I stand\n\nTry a broad wing.\n\n## Ivy's notes\n\n### ${NOTE}\ntrigger: You asked\nmodel: cloud\nkind: idea\n\nUse a lighter paper wing.\n\n## Log\n`;
const balance = (tasks: { id: string; title: string; note?: string }[]): AppState => ({
  outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [{ id: "area:lab", title: "Lab", weight: 50, ordering: "parallel", children: tasks.map(t => ({ ...t, weight: 50, ordering: "parallel" as const, children: [] })) }] },
  settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null,
});

async function rig(chat: ChatCall = (_endpoint, turns) => Promise.resolve(`Ivy on: ${turns.at(-1)?.content ?? ""}`)) {
  const studioDir = await dirs.make();
  const hostDir = await dirs.make();
  mkdirSync(join(studioDir, "threads"));
  writeFileSync(join(studioDir, "threads/alpha.md"), thread);
  const git = (...args: string[]): string => {
    const r = Bun.spawnSync(["git", "-C", studioDir, ...args]);
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  git("init", "-q"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test"); git("add", "."); git("commit", "-qm", "fixture");
  const db = new Database(":memory:"); databases.push(db); for (const sql of SCHEMA_SQL) db.run(sql);
  const endpoint = { baseUrl: "http://model.invalid/v1", model: "test-model", timeoutSeconds: 5 };
  const options = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [{ id: "lab", label: "Lab", color: "", repos: [], goals: [], policy: "cloud" as "cloud" | "local" }], sources: [], studio: { dir: studioDir, maxActive: 5 } };
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options };
  let status: HostStatus | null = null;
  let skew = 0;
  const boot = async (): Promise<ConversationHost> => {
    status = await openConversationHost({ dir: hostDir, stack: "test", label: LABEL, expectedLabel: LABEL, endpoints: { local: endpoint, cloud: endpoint }, chat });
    if (status.state !== "ready") throw new Error(status.reason);
    status.host.attachSources(conversationSources({ db, desk: () => options, now: () => Date.now() + skew }));
    hosts.push(status.host);
    return status.host;
  };
  let host = await boot();
  const guard: MutationGuardContext = { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: 8767, principals: new Set() };
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Reply }> => {
    const res = await handleConversations(new Request(`http://127.0.0.1:8767${path}`, { method, headers: { host: "127.0.0.1:8767", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://127.0.0.1:8767${path}`), guard, () => status, { db, runtime });
    return { status: res.status, body: await res.json() as Reply };
  };
  const restart = async (): Promise<void> => { await host.close(); hosts.splice(hosts.indexOf(host), 1); host = await boot(); };
  const file = (): string => readFileSync(join(studioDir, "threads/alpha.md"), "utf8");
  const parsed = () => { const p = parseThreadFile("threads/alpha.md", file()); if (!p.ok) throw new Error(p.reason); return p.value; };
  const entries = async (id: string): Promise<ConversationEntry[]> => (await call("GET", `/api/conversations/${id}/entries?limit=500`)).body.entries;
  const idle = (id: string): Promise<void> => host.waitForIdle(id);
  const expire = (): void => { skew += 10_000; };
  return { expire, db, runtime, options, call, restart, file, parsed, git, entries, idle, host: () => host, access: () => status };
}

interface Reply extends ConversationDetail { operation: OperationRecord; error: string; source: SourceView; sessions: ImportableSession[]; conversations: ConversationMeta[]; entries: ConversationEntry[] }
const say = (inputId: string, text: string, mode: "queue" | "steer" = "queue") => ({ inputId, transport: "web", text, mode });
const IDEA = { owner: "studio-note", id: `alpha#${NOTE}` };

describe("Ivy conversations from Studio and Balance", () => {
  test("a Studio idea starts one conversation, keeps two turns and the unsent draft across a restart, and Leave ends nothing", async () => {
    const r = await rig();
    const startId = crypto.randomUUID();
    const first = await r.call("POST", "/api/conversations/starts", { startId, source: IDEA });
    expect(first.status).toBe(201);
    const again = await r.call("POST", "/api/conversations/starts", { startId, source: IDEA });
    expect(again.body.conversation.id).toBe(first.body.conversation.id);
    const id = first.body.conversation.id;
    expect(first.body.conversation).toMatchObject({ title: "Discuss: Use a lighter paper wing.", links: [IDEA], origin: { kind: "studio", ref: "alpha" } });
    await r.call("POST", `/api/conversations/${id}/inputs`, say("t1", "Why lighter?"));
    await r.idle(id);
    await r.call("POST", `/api/conversations/${id}/inputs`, say("t2", "And the fold?"));
    await r.idle(id);
    expect((await r.call("PUT", `/api/conversations/${id}/draft`, { text: "Half-typed thought" })).status).toBe(200);
    await r.restart();
    const detail = await r.call("GET", `/api/conversations/${id}`);
    expect(detail.body.draft).toBe("Half-typed thought");
    expect(detail.body.sources[0]).toMatchObject({ state: "available", title: "Use a lighter paper wing." });
    expect(detail.body.studio).toMatchObject({ scope: "note", subject: "Use a lighter paper wing.", outcome: null });
    const said = (await r.entries(id)).filter(e => e.kind !== "cortex.subject" && (e.role === "user" || e.role === "assistant")).map(e => e.text);
    expect(said.length).toBe(4);
    expect(said[0]).toBe("Why lighter?");
    expect(said[1]).toContain("Why lighter?");
    expect(said[2]).toBe("And the fold?");
    expect(said[3]).toContain("And the fold?");
    const listed = await r.call("GET", "/api/conversations/source?owner=studio-thread&id=alpha");
    expect(listed.body.conversations.map(c => c.id)).toEqual([id]);
    expect(r.git("log", "--oneline").split("\n")).toHaveLength(1);
  });

  test("an outcome saves one note through the Studio owner, a retry repeats nothing, and a changed idea is refused without a ghost update", async () => {
    const r = await rig();
    const { body } = await r.call("POST", "/api/conversations/starts", { startId: crypto.randomUUID(), source: IDEA });
    const id = body.conversation.id;
    await r.call("POST", `/api/conversations/${id}/inputs`, say("t1", "Reword it around a narrow fold"));
    await r.idle(id);
    const proposalId = crypto.randomUUID();
    const outcome = { kind: "reword", text: "Use a narrow paper fold." };
    const saved = await r.call("POST", `/api/conversations/${id}/outcome`, { proposalId, outcome });
    expect(saved.status).toBe(200);
    expect(saved.body.operation.state).toBe("created");
    expect(r.parsed().notes[0]).toMatchObject({ text: "Use a narrow paper fold.", status: "kept" });
    expect(r.file()).toContain("You: Reword it around a narrow fold");
    const head = r.git("rev-parse", "HEAD");
    const retry = await r.call("POST", `/api/conversations/${id}/outcome`, { proposalId, outcome });
    expect(retry.body.operation.canonicalId).toBe(saved.body.operation.canonicalId);
    expect(r.git("rev-parse", "HEAD")).toBe(head);
    expect((await r.call("POST", `/api/conversations/${id}/outcome`, { proposalId, outcome: { kind: "dismiss" } })).status).toBe(409);
    const before = r.file();
    const ghost = await r.call("POST", `/api/conversations/${id}/outcome`, { proposalId: crypto.randomUUID(), outcome: { kind: "dismiss" } });
    expect(ghost.status).toBe(409);
    expect(ghost.body.operation.state).toBe("failed");
    expect(r.file()).toBe(before);
    expect(r.git("rev-parse", "HEAD")).toBe(head);
    expect((await r.entries(id)).filter(e => e.kind === "cortex.decision")).toHaveLength(1);
  });

  test("Studio sessions convert lazily and idempotently; ending waits for Studio recovery, ended imports archived and read-only, and the old panel stops continuing them", async () => {
    const r = await rig();
    const turn = { id: crypto.randomUUID(), text: "Earlier question", answer: { reply: "Earlier answer", summary: "We talked.", proposal: null }, model: "old-model", policy: "local" as const };
    const session = (phase: StudioSession["phase"]): StudioSession => ({ id: crypto.randomUUID(), thread: "alpha", scope: { kind: "ghost", note: NOTE }, original: "Use a lighter paper wing.", stand: "Try a broad wing.", policy: "local", turns: [turn], draft: "Unsent words", phase });
    const store = (s: StudioSession): void => { r.db.query("INSERT INTO desk_studio_sessions (id, directory, data) VALUES (?, ?, ?)").run(s.id, r.options.studio.dir, JSON.stringify(s)); };
    const open = session({ kind: "open" });
    const ending = session({ kind: "ending", outcome: { kind: "keep" } });
    const ended = session({ kind: "ended", outcome: { kind: "keep" }, commit: "a".repeat(40) });
    for (const s of [open, ending, ended]) store(s);
    const offered = await r.call("GET", `/api/conversations/source?owner=studio-thread&id=alpha`);
    expect(offered.body.sessions.map(s => s.id).sort()).toEqual([open.id, ending.id, ended.id].sort());
    const first = await r.call("POST", "/api/conversations/imports", { sessionId: open.id });
    const second = await r.call("POST", "/api/conversations/imports", { sessionId: open.id });
    expect(second.body.conversation.id).toBe(first.body.conversation.id);
    expect(first.body.conversation).toMatchObject({ policy: "local", state: "current", origin: { kind: "imported-studio-session", ref: open.id } });
    const imported = (await r.entries(first.body.conversation.id)).filter(e => e.kind === "cortex.imported-turn");
    expect(imported.map(e => e.data)).toEqual([expect.objectContaining({ text: "Earlier question", reply: "Earlier answer", model: "old-model", policy: "local" })]);
    expect((await r.call("GET", `/api/conversations/${first.body.conversation.id}`)).body.draft).toBe("Unsent words");
    expect((await r.call("POST", "/api/conversations/imports", { sessionId: ending.id })).status).toBe(409);
    const archived = await r.call("POST", "/api/conversations/imports", { sessionId: ended.id });
    expect(archived.body.conversation.state).toBe("archived");
    const decision = (await r.entries(archived.body.conversation.id)).find(e => e.kind === "cortex.decision");
    expect(decision?.data).toMatchObject({ readOnly: true, commit: "a".repeat(40), outcome: { kind: "keep" } });
    expect((await r.call("GET", `/api/conversations/${archived.body.conversation.id}`)).body.studio).toBeNull();
    expect((await r.call("POST", `/api/conversations/${archived.body.conversation.id}/inputs`, say("later", "Continue the old idea"))).status).toBe(409);
    expect((await r.call("PATCH", `/api/conversations/${archived.body.conversation.id}`, { state: "current" })).body.conversation.state).toBe("current");
    expect((await r.call("POST", `/api/conversations/${archived.body.conversation.id}/inputs`, say("later", "Continue the old idea"))).status).toBe(202);
    await r.idle(archived.body.conversation.id);
    expect(r.git("log", "--oneline").split("\n")).toHaveLength(1);
    expect(r.parsed().notes[0]?.status).toBe("open");
    const legacy = (body: object) => handleDeskStudioSession(new Request("http://localhost/api/desk/studio/session", { method: "POST", body: JSON.stringify(body) }), r.db, r.runtime, { imported: importedSessions(r.access) });
    expect((await legacy({ action: "say", id: open.id, turn: crypto.randomUUID(), text: "old panel" })).status).toBe(409);
    const recovered = await (await legacy({ action: "recover", id: crypto.randomUUID() })).json() as { sessions: StudioSession[] };
    expect(recovered.sessions.map(s => s.id)).toEqual([ending.id]);
    const left = await r.call("GET", `/api/conversations/source?owner=studio-thread&id=alpha`);
    expect(left.body.sessions.map(s => s.id)).toEqual([ending.id]);
  });

  test("a Balance task offers its conversations; once the task is gone it shows unavailable without its content and the history stays", async () => {
    const seen: string[] = [];
    const r = await rig((_endpoint, turns) => { seen.push(JSON.stringify(turns)); return Promise.resolve("noted"); });
    saveBalanceState(r.db, balance([{ id: "task-1", title: "Draft the workshop exercise", note: "Private prep detail" }]));
    const source = { owner: "balance-task" as const, id: "task-1" };
    const one = await r.call("POST", "/api/conversations/starts", { startId: crypto.randomUUID(), source });
    const two = await r.call("POST", "/api/conversations/starts", { startId: crypto.randomUUID(), source });
    expect(one.body.conversation.id).not.toBe(two.body.conversation.id);
    await r.call("POST", `/api/conversations/${one.body.conversation.id}/inputs`, say("b1", "Where do I start?"));
    await r.idle(one.body.conversation.id);
    const listed = await r.call("GET", "/api/conversations/source?owner=balance-task&id=task-1");
    expect(listed.body.conversations.map(c => c.id).sort()).toEqual([one.body.conversation.id, two.body.conversation.id].sort());
    expect(seen[0]).toContain("Private prep detail");
    saveBalanceState(r.db, balance([]));
    const detail = await r.call("GET", `/api/conversations/${one.body.conversation.id}`);
    expect(detail.body.sources).toEqual([{ ref: source, state: "unavailable", reason: "gone" }]);
    expect(JSON.stringify(detail.body)).not.toContain("Private prep detail");
    expect(JSON.stringify(await r.entries(one.body.conversation.id))).not.toContain("Private prep detail");
    expect(detail.body.conversation.title).toBe("Conversation about work that is no longer available");
    await r.call("POST", `/api/conversations/${one.body.conversation.id}/inputs`, say("b2", "Still there?"));
    await r.idle(one.body.conversation.id);
    expect(seen.at(-1)).not.toContain("Private prep detail");
    expect(detail.body.conversation.policy).toBe("local");
    expect((await r.entries(one.body.conversation.id)).some(e => e.text === "Where do I start?")).toBe(true);
    expect((await r.call("POST", "/api/conversations/starts", { startId: crypto.randomUUID(), source })).status).toBe(403);
  });

  test("queued status and Use this now come from the host's order, not the browser", async () => {
    const { promise: release, resolve } = Promise.withResolvers<undefined>();
    let calls = 0;
    const r = await rig(async (_endpoint, turns) => { calls += 1; if (calls === 1) await release; return `answer ${turns.at(-1)?.content ?? ""}`; });
    const { body } = await r.call("POST", "/api/conversations/starts", { startId: crypto.randomUUID(), source: { owner: "studio-thread", id: "alpha" } });
    const id = body.conversation.id;
    await r.call("POST", `/api/conversations/${id}/inputs`, say("q1", "start"));
    await r.call("POST", `/api/conversations/${id}/inputs`, say("q2", "later"));
    await r.call("POST", `/api/conversations/${id}/inputs`, say("q3", "now please", "steer"));
    const busy = await r.call("GET", `/api/conversations/${id}`);
    expect(busy.body.conversation.activity.status).toBe("working");
    expect(busy.body.pending.filter(p => p.status === "queued").map(p => p.inputId).sort()).toEqual(["q2", "q3"]);
    resolve(undefined);
    await r.idle(id);
    expect((await r.call("GET", `/api/conversations/${id}`)).body.pending).toEqual([]);
  });
});

describe("workspace A over the authenticated conversation API", () => {
  const noop = (): void => undefined;
  const view = (detail: ConversationDetail, entries: ConversationEntry[], busy = false): string => renderToStaticMarkup(<WorkspaceView detail={detail} entries={entries} draft={detail.draft} ready busy={busy} sending={false} retrying={false} error={null} onDraft={noop} onSend={noop} onLeave={noop} onSaved={noop} organizing={false} onOrganize={noop} />);

  test("shows saved messages, the Studio source context, the restored draft, Use this now while busy, and an unavailable source without its content", async () => {
    const { promise: release, resolve } = Promise.withResolvers<undefined>();
    let calls = 0;
    const r = await rig(async (_endpoint, turns) => { calls += 1; if (calls === 2) await release; return `Ivy: ${turns.at(-1)?.content ?? ""}`; });
    const { body } = await r.call("POST", "/api/conversations/starts", { startId: crypto.randomUUID(), source: IDEA });
    const id = body.conversation.id;
    await r.call("POST", `/api/conversations/${id}/inputs`, say("w1", "First thought"));
    await r.idle(id);
    await r.call("POST", `/api/conversations/${id}/inputs`, say("w2", "Second thought"));
    await r.call("POST", `/api/conversations/${id}/inputs`, say("w3", "Queued thought"));
    await r.call("PUT", `/api/conversations/${id}/draft`, { text: "Still typing" });
    const busy = (await r.call("GET", `/api/conversations/${id}`)).body;
    const html = view(busy, await r.entries(id), true);
    expect(html).toContain("Discuss: Use a lighter paper wing.");
    expect(html).toContain("First thought");
    expect(html).toContain("Ivy: First thought");
    expect(html).toContain("Use a lighter paper wing.");
    expect(html).toContain("Still typing");
    expect(html).toContain("Queued · waits for Ivy&#x27;s current turn");
    expect(html).toContain("Use this now");
    expect(html).toContain("Save to the Studio");
    resolve(undefined);
    await r.idle(id);
    writeFileSync(join(r.options.studio.dir, "threads/alpha.md"), thread.replace(/### [^]*?Use a lighter paper wing\.\n\n/, ""));
    r.expire();
    const gone = (await r.call("GET", `/api/conversations/${id}`)).body;
    const after = view(gone, await r.entries(id));
    expect(after).toContain("Unavailable");
    expect(after).not.toContain("Use this now");
    expect(after).toContain("Second thought");
    expect(gone.sources.map(s => s.state)).toEqual(["unavailable"]);
  });

  test("a source lists every conversation and unopened earlier exchange, and the location survives a reload", async () => {
    const r = await rig();
    const one = await r.call("POST", "/api/conversations/starts", { startId: crypto.randomUUID(), source: { owner: "studio-thread", id: "alpha" } });
    const listed = (await r.call("GET", "/api/conversations/source?owner=studio-thread&id=alpha")).body;
    const html = renderToStaticMarkup(<SourceConversationList data={listed} pending={false} onResume={noop} onImport={noop} onNew={noop} newLabel="New conversation" />);
    expect(html).toContain(`Resume · ${one.body.conversation.title}`);
    expect(html).toContain("New conversation");
    const location = { mode: "conversation" as const, thread: null, conversation: one.body.conversation.id };
    expect(readDeskLocation(deskSearch("", location))).toEqual(location);
    expect(readDeskLocation("?desk=conversation&conversation=not-an-id")).toEqual({ mode: "conversation", thread: null, conversation: null });
  });
});
