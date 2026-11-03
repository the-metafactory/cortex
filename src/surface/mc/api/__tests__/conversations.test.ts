import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { openConversationHost, type HostStatus } from "../../../../conversations/host";
import { DiscordConversations } from "../../../../conversations/discord";
import { BOT, FakeThreads } from "../../../../conversations/__tests__/fixtures/discord-threads";
import { answering, scratchDirs } from "../../../../conversations/__tests__/fixtures/scratch";
import { handleConversations, isStackPrincipal } from "../conversations";
import { buildAllowedHostnames, type MutationGuardContext } from "../mutation-guard";
import { initDatabase } from "../../db/init";
import { HandledLedger } from "../../desk/actions";

const FIXTURE = join(import.meta.dir, "../../../../conversations/__tests__/fixtures/conversation-server.ts");
const LABEL = "ai.meta-factory.cortex.fixture";
const OTHER = { "cf-access-authenticated-user-email": "someone-else@example.invalid" };
const dirs = scratchDirs("conversations-api-");
const scratch = dirs.make;
const children: Subprocess[] = [];
const statuses: HostStatus[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) { child.kill("SIGKILL"); await child.exited; }
  for (const status of statuses.splice(0)) if (status.state === "ready") await status.host.close().catch(() => undefined);
  await dirs.clean();
});

const guard = (port = 8767): MutationGuardContext => ({ isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: port, principals: new Set() });
const call = (status: HostStatus | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  handleConversations(new Request(`http://127.0.0.1:8767${path}`, { method, headers: { host: "127.0.0.1:8767", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://127.0.0.1:8767${path}`), guard(), () => status);
const NEW = { title: "Synthetic probe", origin: { kind: "web" } };
const say = (inputId: string, text: string) => ({ inputId, transport: "web", text });

describe("conversation API gates", () => {
  test("only this stack's principal reads or writes, every method passes the rebind guard, and an unavailable host says why", async () => {
    const dir = await scratch();
    const status = await openConversationHost({ dir, stack: "api", label: LABEL, expectedLabel: LABEL, lanes: { cloud: { provider: "test", model: "m" } }, turns: answering(() => "ok") });
    statuses.push(status);
    const created = await call(status, "POST", "/api/conversations", NEW);
    expect(created.status).toBe(201);
    const { conversation } = await created.json() as { conversation: { id: string } };
    expect((await call(status, "GET", `/api/conversations/${conversation.id}`)).status).toBe(200);
    expect((await call(status, "GET", `/api/conversations/${conversation.id}`, undefined, OTHER)).status).toBe(403);
    expect((await call(status, "GET", `/api/conversations/${conversation.id}/entries`, undefined, OTHER)).status).toBe(403);
    expect((await call(status, "POST", `/api/conversations/${conversation.id}/inputs`, say("in-1", "x"), OTHER)).status).toBe(403);
    expect((await call(status, "GET", `/api/conversations/${conversation.id}`, undefined, { host: "rebound.example:8767" })).status).toBe(403);
    expect((await call(status, "POST", `/api/conversations/${conversation.id}/inputs`, { inputId: "in-1" })).status).toBe(400);
    expect((await call(status, "POST", `/api/conversations/${conversation.id}/inputs`, { ...say("in-0", "x"), transport: "discord" })).status).toBe(400);
    expect((await call(status, "POST", `/api/conversations/${conversation.id}/inputs`, say("in-1", "hello"))).status).toBe(202);
    expect((await call(status, "POST", `/api/conversations/${conversation.id}/inputs`, say("in-1", "hello"))).status).toBe(200);
    const conflict = await call(status, "POST", `/api/conversations/${conversation.id}/inputs`, say("in-1", "different"));
    expect(conflict.status).toBe(409);
    expect((await call(status, "GET", "/api/conversations/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await call(status, "GET", `/api/conversations/${conversation.id}/inputs/%E0%A4%A`)).status).toBe(400);
    const unavailable = await call({ state: "unavailable", reason: "Conversations unavailable: store held by 42/ai.meta-factory.cortex.default" }, "GET", "/api/conversations");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ ok: false, error: "Conversations unavailable: store held by 42/ai.meta-factory.cortex.default" });
    expect((await call(null, "GET", "/api/conversations")).status).toBe(503);
  });

  test("a command-bar question starts one conversation, sends the typed text first and Ivy answers; a retry opens the same one", async () => {
    const dir = await scratch();
    const status = await openConversationHost({ dir, stack: "api", label: LABEL, expectedLabel: LABEL, lanes: { cloud: { provider: "test", model: "m" } }, turns: answering(request => `Some names for ${request.prompt.length} chars`) });
    statuses.push(status);
    if (status.state !== "ready") throw new Error("host not ready");
    const text = "can we think of a better name for this product? \"Desk\" is underselling it";
    const ask = { startId: "6f1d1c6e-3b0a-4c39-9d43-2a7f3e3c0a11", text };
    const first = await call(status, "POST", "/api/conversations/asks", ask);
    expect(first.status).toBe(201);
    const { conversation } = await first.json() as { conversation: { id: string; title: string; origin: unknown; policy: string } };
    expect(conversation).toMatchObject({ title: text, origin: { kind: "web", ref: "desk-ask" }, policy: "cloud" });
    const again = await call(status, "POST", "/api/conversations/asks", ask);
    expect(((await again.json()) as { conversation: { id: string } }).conversation.id).toBe(conversation.id);
    expect((await status.host.list()).filter(c => c.id === conversation.id)).toHaveLength(1);
    expect(await status.host.input(conversation.id, `desk-ask:${ask.startId}`)).toMatchObject({ status: "done", answer: expect.stringContaining("Some names") });
    const { entries } = await status.host.entries(conversation.id, 50, undefined);
    expect(entries.filter(e => e.role === "user").map(e => e.text)).toEqual([text]);
    expect((await call(status, "POST", "/api/conversations/asks", { startId: "not-a-uuid", text })).status).toBe(400);
    const lab = { enabled: true, displayName: "", topN: 5, rangerUrl: "", sources: [], areas: [{ id: "lab", label: "Lab", color: "", repos: [], goals: [], policy: "local" as const }] };
    const path = "/api/conversations/asks";
    const local = await handleConversations(new Request(`http://127.0.0.1:8767${path}`, { method: "POST", headers: { host: "127.0.0.1:8767", "content-type": "application/json" }, body: JSON.stringify({ startId: "2c9a7e51-8b0d-4f3a-9c6e-1d2b3a4f5e60", text: "a lab question", area: "lab" }) }), new URL(`http://127.0.0.1:8767${path}`), guard(), () => status, { db: initDatabase(":memory:"), runtime: { options: lab, ledger: new HandledLedger() } });
    expect(local.status).toBe(503);
    expect(((await local.json()) as { error: string }).error).toContain("No local model is configured");
  });

  test("a command-bar question says why when conversations are not set up or no model can answer, and nothing is sent", async () => {
    const ask = { startId: "0b6d3f0e-9a3e-4c1f-8f7e-5d2c1b0a9e88", text: "what should we call it?" };
    const missing = await call(null, "POST", "/api/conversations/asks", ask);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ ok: false, error: "Conversations are not set up on this stack." });
    const dir = await scratch();
    const status = await openConversationHost({ dir, stack: "api", label: LABEL, expectedLabel: LABEL, lanes: {}, turns: answering(() => "never") });
    statuses.push(status);
    const failed = await call(status, "POST", "/api/conversations/asks", ask);
    expect(failed.status).toBe(503);
    expect(((await failed.json()) as { error: string }).error).toContain("Nothing was sent");
  });

  test("the stack principal is the governance allowlist when set, else the local principal", () => {
    expect(isStackPrincipal("local-principal@loopback", guard())).toBe(true);
    expect(isStackPrincipal("someone@example.invalid", guard())).toBe(false);
    expect(isStackPrincipal("Principal@Example.org", { ...guard(), principals: new Set(["principal@example.org"]) })).toBe(true);
    expect(isStackPrincipal("local-principal@loopback", { ...guard(), principals: new Set(["principal@example.org"]) })).toBe(false);
  });
});

interface Started { child: Subprocess<"ignore", "pipe", "pipe">; base: string; boot: { state: string; resumed?: string[]; tookOver?: number | null; reason?: string } }
async function start(dir: string, hang = false): Promise<Started> {
  const child = Bun.spawn([process.execPath, FIXTURE], { env: { ...process.env, CONVERSATION_DIR: dir, CONVERSATION_LABEL: LABEL, CONVERSATION_HANG: hang ? "1" : "0" }, stdout: "pipe", stderr: "pipe" });
  children.push(child);
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`fixture exited: ${await new Response(child.stderr).text()}`);
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const boot = JSON.parse(text.slice(0, text.indexOf("\n"))) as Started["boot"] & { port: number };
  return { child, base: `http://127.0.0.1:${boot.port}`, boot };
}
async function stop(started: Started, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  started.child.kill(signal);
  await started.child.exited;
  children.splice(children.indexOf(started.child), 1);
}
const http = async (base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
async function settled(base: string, id: string, inputId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400; i++) {
    const { body } = await http(base, "GET", `/api/conversations/${id}/inputs/${inputId}`);
    const submission = body.submission as { status: string } | undefined;
    if (submission && submission.status !== "queued" && submission.status !== "placed") return submission;
    await Bun.sleep(25);
  }
  throw new Error(`input ${inputId} never settled`);
}

describe("conversation record across process restarts", () => {
  test("a clean restart returns the identical record; a crash during a model turn keeps the input and resumes natively", async () => {
    const dir = await scratch();
    let server = await start(dir);
    expect(server.boot.state).toBe("ready");
    const created = await http(server.base, "POST", "/api/conversations", NEW);
    const id = (created.body.conversation as { id: string }).id;
    expect((await http(server.base, "POST", `/api/conversations/${id}/inputs`, say("probe-1", "deterministic test turn"))).status).toBe(202);
    expect(await settled(server.base, id, "probe-1")).toMatchObject({ status: "done", answer: "fixture answer: deterministic test turn" });
    const before = (await http(server.base, "GET", `/api/conversations/${id}/entries`)).body;
    await stop(server, "SIGTERM");
    expect(existsSync(join(dir, "host.lock"))).toBe(false);

    server = await start(dir, true);
    expect(server.boot).toMatchObject({ state: "ready", resumed: [], tookOver: null });
    expect((await http(server.base, "GET", `/api/conversations/${id}/entries`)).body).toEqual(before);
    expect((await http(server.base, "GET", `/api/conversations/${id}/entries`, undefined, OTHER)).status).toBe(403);
    expect((await http(server.base, "POST", `/api/conversations/${id}/inputs`, say("probe-2", "HANG during the model turn"))).status).toBe(202);
    for (let i = 0; i < 400 && !existsSync(join(dir, "model-entered")); i++) await Bun.sleep(25);
    await stop(server, "SIGKILL");
    expect(existsSync(join(dir, "host.lock"))).toBe(true);

    server = await start(dir);
    expect(server.boot.state).toBe("ready");
    expect(server.boot.resumed).toEqual([id]);
    expect(server.boot.tookOver).toBeNumber();
    expect(await settled(server.base, id, "probe-2")).toMatchObject({ status: "done", answer: "fixture answer: HANG during the model turn" });
    const after = (await http(server.base, "GET", `/api/conversations/${id}/entries`)).body as { entries: { kind: string; text?: string; data?: unknown }[] };
    const earlier = (before as { entries: unknown[] }).entries;
    expect(after.entries.slice(0, earlier.length)).toEqual(earlier as typeof after.entries);
    expect(after.entries.filter(e => e.kind === "cortex.input" && e.text === "HANG during the model turn")).toHaveLength(1);
    expect(after.entries.find(e => e.kind === "cortex.continuation")?.data).toMatchObject({ mode: "native-resume", engine: "pi-durable@1.4.0" });
    await stop(server, "SIGTERM");
  }, 60_000);
});

describe("conversation Discord routes", () => {
  const principal = "285700000000000001";
  async function withDiscord(fake: FakeThreads | null) {
    const dir = await scratch();
    const status = await openConversationHost({ dir, stack: "api", label: LABEL, expectedLabel: LABEL, lanes: { cloud: { provider: "test", model: "m" }, local: { provider: "test", model: "l" } }, turns: answering(() => "ok") });
    statuses.push(status);
    if (status.state !== "ready") throw new Error(status.reason);
    const bridge = fake ? new DiscordConversations({ host: status.host, adapter: () => fake, config: { channelId: "1566000000000000001", guildId: "1460000000000000001", webUrl: "http://127.0.0.1:8767" }, principalId: principal, log: () => undefined }) : null;
    const access = Object.assign(() => status, { discord: () => bridge });
    const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      handleConversations(new Request(`http://127.0.0.1:8767${path}`, { method, headers: { host: "127.0.0.1:8767", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://127.0.0.1:8767${path}`), guard(), access);
    return { send, status };
  }

  test("the principal checks the bot, continues a cloud conversation in Discord and sees the thread on the web", async () => {
    const fake = new FakeThreads();
    const { send } = await withDiscord(fake);
    const check = await send("POST", "/api/conversations/discord/check");
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({ ok: true, check: { members: [BOT, principal], deleted: true } });
    expect((await send("POST", "/api/conversations/discord/check", undefined, OTHER)).status).toBe(403);
    const { conversation } = await (await send("POST", "/api/conversations", NEW)).json() as { conversation: { id: string } };
    expect((await send("POST", `/api/conversations/${conversation.id}/discord`, undefined, OTHER)).status).toBe(403);
    expect((await send("POST", `/api/conversations/${conversation.id}/discord`, { retry: "yes" })).status).toBe(400);
    const attached = await send("POST", `/api/conversations/${conversation.id}/discord`);
    expect(attached.status).toBe(200);
    expect(await attached.json()).toMatchObject({ conversation: { discord: { threadId: "thread-2" } }, discord: { available: true, url: "https://discord.com/channels/1460000000000000001/thread-2" } });
    const detail = await (await send("GET", `/api/conversations/${conversation.id}`)).json() as { conversation: { discord?: { threadId: string } }; discord: { url?: string } };
    expect(detail.conversation.discord?.threadId).toBe("thread-2");
    expect(detail.discord.url).toBe("https://discord.com/channels/1460000000000000001/thread-2");
    const local = await (await send("POST", "/api/conversations", { ...NEW, policy: "local" })).json() as { conversation: { id: string } };
    expect((await send("POST", `/api/conversations/${local.conversation.id}/discord`)).status).toBe(403);
    expect(fake.created).toBe(2);
  });

  test("a stack without Discord conversations says so and creates nothing", async () => {
    const { send } = await withDiscord(null);
    const { conversation } = await (await send("POST", "/api/conversations", NEW)).json() as { conversation: { id: string } };
    expect((await send("POST", "/api/conversations/discord/check")).status).toBe(503);
    expect((await send("POST", `/api/conversations/${conversation.id}/discord`)).status).toBe(503);
    const detail = await (await send("GET", `/api/conversations/${conversation.id}`)).json() as { discord: { available: boolean } };
    expect(detail.discord.available).toBe(false);
  });
});
