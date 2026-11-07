import { afterEach, expect, test } from "bun:test";
import { initDatabase } from "../db/init";
import { openConversationHost, type HostStatus } from "../../../conversations/host";
import { answering, scratchDirs } from "../../../conversations/__tests__/fixtures/scratch";
import { conversationSources } from "../desk/conversation-sources";
import { handleConversations } from "../api/conversations";
import { buildAllowedHostnames, type MutationGuardContext } from "../api/mutation-guard";
import { HandledLedger } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import type { ConversationMeta, SourceState } from "../../../conversations/types";
import type { WaitingTask } from "../desk/sources/waiting";
import { entryViews } from "../dashboard-v2/lib/conversations";
import { grillingSource } from "../desk/grilling-conversation";

const dirs = scratchDirs("desk-grilling-");
const statuses: HostStatus[] = [];
const databases: ReturnType<typeof initDatabase>[] = [];
afterEach(async () => {
  for (const status of statuses.splice(0)) if (status.state === "ready") await status.host.close();
  for (const db of databases.splice(0)) db.close();
  await dirs.clean();
});
const TITLE = "Which cache should we use?";
const BODY = "## Question\n\nRedis or SQLite?\n\n## Constraints\n\nKeep operation simple.";
const NODE_URL = "https://github.com/example/app/issues/31";
const SOURCE = { owner: "graph-node" as const, id: "example/app#31" };
const DESK = { enabled: true, displayName: "", topN: 5, rangerUrl: "http://127.0.0.1:7311", areas: [{ id: "work", label: "Work", color: "", repos: ["example/app"], goals: [], policy: "cloud" as const }], sources: [] };
const STATE = { current: [], needsYou: [], maps: [{ key: "example/app#1", repo: "example/app", grillings: [{ id: "31", title: "Stale title" }] }] };
const guard: MutationGuardContext = { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: 8767, principals: new Set() };

test("the guarded route seeds authoritative node context once, resumes after restart and makes no graph writes", async () => {
  const dir = await dirs.make();
  const db = initDatabase(":memory:"); databases.push(db);
  const runtime: DeskRuntime = { options: DESK, ledger: new HandledLedger() };
  let writes = 0;
  const requests: string[] = [];
  const turns: string[] = [];
  const boot = async () => {
    const status = await openConversationHost({ dir, stack: "grilling-test", label: "grilling-test", expectedLabel: "grilling-test", lanes: { cloud: { provider: "test", model: "m" } }, turns: answering(request => { turns.push(JSON.stringify(request)); return "Let's compare them."; }) });
    statuses.push(status);
    if (status.state !== "ready") throw new Error(status.reason);
    await status.host.attachSources(conversationSources({ db, desk: () => DESK, runGraph: async () => { writes++; throw new Error("No graph writes at start"); }, grillingReads: {
      fetch: async (_url, init) => { requests.push(init.method ?? "GET"); return Response.json(STATE); },
      task: async () => ({ kind: "open", title: TITLE, question: "Redis or SQLite?", body: BODY, url: NODE_URL }),
    } }));
    return status;
  };
  let status = await boot();
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const request = new Request(`http://127.0.0.1:8767${path}`, { method: body ? "POST" : "GET", headers: { host: "127.0.0.1:8767", "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return handleConversations(request, new URL(request.url), guard, () => status, { db, runtime });
  };
  const start = () => ({ startId: crypto.randomUUID(), source: SOURCE });
  const denied = await call("/api/conversations/starts", start(), { "cf-access-authenticated-user-email": "someone-else@example.invalid" });
  expect(denied.status).toBe(403);
  expect((await call("/api/conversations/starts", start(), { host: "rebound.example:8767" })).status).toBe(403);
  const starts = await Promise.all([call("/api/conversations/starts", start()), call("/api/conversations/starts", start())]);
  expect(starts.map(r => r.status)).toEqual([201, 201]);
  const metas = await Promise.all(starts.map(async r => (await r.json() as { conversation: ConversationMeta }).conversation));
  const id = metas[0]!.id;
  expect(metas[1]?.id).toBe(id);
  expect(metas[0]).toMatchObject({ title: TITLE, links: [SOURCE], origin: { kind: "graph", ref: SOURCE.id }, policy: "cloud" });
  const before = await status.host.entries(id, 200, undefined);
  const text = JSON.stringify(before);
  const rendered = before.entries.flatMap(entryViews);
  expect(rendered.some(view => view.kind === "message" && view.text.includes(TITLE))).toBe(true);
  expect(JSON.stringify(rendered)).not.toContain("earlier Studio session");
  expect(text).toContain(TITLE);
  expect(text).toContain("Redis or SQLite?");
  expect(text).toContain("Keep operation simple.");
  expect(text).toContain(NODE_URL);
  expect(turns).toHaveLength(0);
  await status.host.close(); statuses.splice(statuses.indexOf(status), 1);
  status = await boot();
  const again = await call("/api/conversations/starts", { ...start(), source: { ...SOURCE, id: `github:github.com/${SOURCE.id}` } });
  expect((await again.json() as { conversation: ConversationMeta }).conversation.id).toBe(id);
  expect(await status.host.list()).toHaveLength(1);
  expect(await status.host.entries(id, 200, undefined)).toEqual(before);
  await status.host.submit(id, { inputId: "probe-turn", transport: "web", text: "Compare the options", mode: "queue" });
  await status.host.waitForIdle(id);
  expect(turns.join("\n")).toContain("Redis or SQLite?");
  expect(turns.join("\n")).toContain(NODE_URL);
  expect(writes).toBe(0);
  expect(requests.every(method => method === "GET")).toBe(true);
  expect(db.query("SELECT COUNT(*) AS n FROM desk_graph_operations").get()).toEqual({ n: 0 });
  await status.host.organize(id, { state: "archived" });
  expect((await status.host.meta(id)).state).toBe("archived");
});

test("grilling sources refuse absent, closed or unreadable nodes and preserve local policy", async () => {
  const task = async (): Promise<WaitingTask> => ({ kind: "open", title: TITLE, body: BODY, question: null, url: NODE_URL });
  const fetch = async () => Response.json(STATE);
  expect(await grillingSource(undefined, SOURCE, { fetch, task })).toMatchObject({ state: "unavailable", reason: "unauthorized" });
  expect(await grillingSource(DESK, { ...SOURCE, id: "example/app#999" }, { fetch, task })).toMatchObject({ state: "unavailable" });
  expect(await grillingSource(DESK, SOURCE, { fetch, task: async () => ({ kind: "closed", title: TITLE, body: BODY, question: null, url: NODE_URL }) })).toMatchObject({ state: "unavailable" });
  const local: SourceState = await grillingSource({ ...DESK, areas: [] }, SOURCE, { fetch, task });
  expect(local).toMatchObject({ state: "available", policy: "local", context: `${BODY}\n\nSource: ${NODE_URL}` });
  const response = await handleConversations(new Request("http://127.0.0.1:8767/api/conversations/starts", { method: "POST", headers: { host: "127.0.0.1:8767" } }), new URL("http://127.0.0.1:8767/api/conversations/starts"), guard, () => null);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false, error: "Conversations are not set up on this stack." });
});
