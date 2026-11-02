import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "./fixtures/scratch";
import { ConversationError, openConversationHost, type ConversationHost, type HostOptions } from "../host";
import type { ChatCall, ChatTurn } from "../model";
import type { LinkResolvers, Policy, SourceState } from "../types";

const LABEL = "ai.meta-factory.cortex.test";
const local = { baseUrl: "http://local.invalid", model: "local-model", timeoutSeconds: 5 };
const cloud = { baseUrl: "http://cloud.invalid", model: "cloud-model", timeoutSeconds: 5 };
const dirs = scratchDirs("conversations-host-");
const scratch = dirs.make;
const hosts: ConversationHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
  await dirs.clean();
});

interface Call { model: string; turns: ChatTurn[] }
function recorder(answer: (turns: ChatTurn[]) => Promise<string> | string = turns => `echo ${turns.at(-1)?.content ?? ""}`): { calls: Call[]; chat: ChatCall } {
  const calls: Call[] = [];
  return { calls, chat: async (endpoint, turns) => { calls.push({ model: endpoint.model, turns }); return answer(turns); } };
}

async function open(dir: string, extra: Partial<HostOptions> = {}): Promise<ConversationHost> {
  const status = await openConversationHost({ dir, stack: "test", label: LABEL, expectedLabel: LABEL, endpoints: { local, cloud }, ...extra });
  if (status.state !== "ready") throw new Error(status.reason);
  hosts.push(status.host);
  return status.host;
}

const lockOwner = (pid: number, label: string) => JSON.stringify({ pid, label, stack: "test", at: "2026-11-01T00:00:00.000Z" });
async function writeLock(dir: string, pid: number, label: string): Promise<void> {
  await mkdir(join(dir, "host.lock"), { recursive: true });
  await writeFile(join(dir, "host.lock", "owner.json"), lockOwner(pid, label));
}

const input = (inputId: string, text: string, mode: "queue" | "steer" = "queue") => ({ inputId, transport: "web" as const, text, mode });
const create = (host: ConversationHost, policy: Policy = "cloud", links: { owner: "studio-thread"; id: string }[] = []) => host.create({ title: "Synthetic", links, origin: { kind: "web" }, policy }, "local-principal@loopback");

describe("conversation host", () => {
  test("an input is acknowledged after commit, answered, and an equal retry returns the original", async () => {
    const { calls, chat } = recorder();
    const host = await open(await scratch(), { chat });
    const conversation = await create(host);
    const first = await host.submit(conversation.id, input("in-1", "hello"));
    expect(first.duplicate).toBe(false);
    expect(["queued", "placed", "done"]).toContain(first.submission.status);
    await host.waitForIdle(conversation.id);
    const settled = await host.input(conversation.id, "in-1");
    expect(settled).toMatchObject({ status: "done", answer: "echo hello" });
    const retry = await host.submit(conversation.id, input("in-1", "hello"));
    expect(retry).toEqual({ duplicate: true, submission: settled });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.turns[0]?.content).toContain("You are Ivy");
    expect((await host.meta(conversation.id)).activity.status).toBe("waiting");
  });

  test("a conflicting payload under a used input id is refused with 409 and never reaches the record", async () => {
    const { chat } = recorder();
    const host = await open(await scratch(), { chat });
    const conversation = await create(host);
    await host.submit(conversation.id, input("in-1", "hello"));
    await host.waitForIdle(conversation.id);
    const refused = await host.submit(conversation.id, input("in-1", "CONFLICTING")).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConversationError);
    expect((refused as ConversationError).status).toBe(409);
    expect(JSON.stringify(await host.entries(conversation.id, 100, undefined))).not.toContain("CONFLICTING");
  });

  test("busy input queues by default and a steer waits for the next safe boundary instead of interrupting the run", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<undefined>();
    let entered = false;
    const { chat } = recorder(async turns => {
      if (!entered) { entered = true; await gate; }
      return `answer to ${turns.at(-1)?.content ?? ""}`;
    });
    const host = await open(await scratch(), { chat });
    const conversation = await create(host);
    await host.submit(conversation.id, input("web-1", "start"));
    while (!entered) await Bun.sleep(5);
    const follow = await host.submit(conversation.id, input("discord-1", "queued follow-up"));
    const steer = await host.submit(conversation.id, input("web-steer", "use this now", "steer"));
    expect(follow.submission.status).toBe("queued");
    expect(steer.submission.status).toBe("queued");
    expect((await host.meta(conversation.id)).activity.status).toBe("working");
    release(undefined);
    await host.waitForIdle(conversation.id);
    const entries = (await host.entries(conversation.id, 100, undefined)).entries;
    const at = (text: string) => entries.findIndex(e => e.kind === "cortex.input" && e.text === text);
    const firstAnswer = entries.findIndex(e => e.kind === "pi.assistant");
    expect(at("start")).toBeLessThan(firstAnswer);
    expect(at("use this now")).toBeGreaterThan(firstAnswer);
    expect(at("queued follow-up")).toBeGreaterThan(firstAnswer);
    expect((await host.input(conversation.id, "web-steer")).status).toBe("done");
    expect((await host.input(conversation.id, "discord-1")).status).toBe("done");
  });

  test("the strictest linked policy routes to the local model and a tightened conversation records reconstructed context", async () => {
    let threadPolicy: Policy = "cloud";
    const resolvers: LinkResolvers = { "studio-thread": () => Promise.resolve({ state: "available", policy: threadPolicy, title: "Thread A" }) };
    const { calls, chat } = recorder();
    const host = await open(await scratch(), { chat, resolvers });
    const conversation = await create(host, "cloud", [{ owner: "studio-thread", id: "thread-a" }]);
    await host.submit(conversation.id, input("in-1", "first"));
    await host.waitForIdle(conversation.id);
    threadPolicy = "local";
    await host.submit(conversation.id, input("in-2", "second"));
    await host.waitForIdle(conversation.id);
    expect(calls.map(c => c.model)).toEqual(["cloud-model", "local-model"]);
    expect((await host.meta(conversation.id)).policy).toBe("local");
    threadPolicy = "cloud";
    expect((await host.meta(conversation.id)).policy).toBe("local");
    const continuation = (await host.entries(conversation.id, 100, undefined)).entries.find(e => e.kind === "cortex.continuation");
    expect(continuation?.data).toMatchObject({ mode: "reconstructed", from: "cloud", to: "local" });
  });

  test("a local conversation without a local model fails closed and admits nothing", async () => {
    const { calls, chat } = recorder();
    const host = await open(await scratch(), { chat, endpoints: { cloud } });
    const conversation = await create(host, "local");
    const refused = await host.submit(conversation.id, input("in-1", "private")).catch((error: unknown) => error);
    expect((refused as ConversationError).status).toBe(503);
    expect((refused as ConversationError).message).toContain("no cloud fallback");
    expect(calls).toHaveLength(0);
    expect(await host.input(conversation.id, "in-1").catch((error: unknown) => (error as ConversationError).status)).toBe(404);
  });

  test("a gone source shows as unavailable without context, keeps the conversation and its history, and allows only the local model", async () => {
    let source: SourceState = { state: "available", policy: "cloud", title: "Thread A", context: "private question" };
    const { calls, chat } = recorder();
    const host = await open(await scratch(), { chat, resolvers: { "studio-thread": () => Promise.resolve(source) } });
    const linked = await create(host, "cloud", [{ owner: "studio-thread", id: "thread-a" }]);
    await host.submit(linked.id, input("in-1", "first"));
    await host.waitForIdle(linked.id);
    source = { state: "unavailable", reason: "gone" };
    expect((await host.list()).map(c => c.id)).toEqual([linked.id]);
    const detail = await host.detail(linked.id);
    expect(detail.sources).toEqual([{ ref: { owner: "studio-thread", id: "thread-a" }, state: "unavailable", reason: "gone" }]);
    expect(JSON.stringify(detail)).not.toContain("private question");
    expect(detail.conversation.policy).toBe("local");
    expect((await host.entries(linked.id, 100, undefined)).entries.filter(e => e.role === "user").map(e => e.text)).toEqual(["first"]);
    await host.submit(linked.id, input("in-2", "second"));
    await host.waitForIdle(linked.id);
    expect(calls.map(c => c.model)).toEqual(["cloud-model", "local-model"]);
    source = { state: "available", policy: "cloud", title: "Thread A" };
    expect((await host.meta(linked.id)).policy).toBe("cloud");
  });

  test("an unresolvable linked object is refused before any model context is built", async () => {
    const { calls, chat } = recorder();
    const host = await open(await scratch(), { chat, resolvers: { "studio-thread": () => Promise.resolve({ state: "unavailable", reason: "gone" }) } });
    const refused = await create(host, "cloud", [{ owner: "studio-thread", id: "missing" }]).catch((error: unknown) => error);
    expect((refused as ConversationError).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("attachment bytes are copied at ingress and an input may reference only stored attachments", async () => {
    const { calls, chat } = recorder();
    const dir = await scratch();
    const host = await open(dir, { chat });
    const conversation = await create(host);
    const ref = await host.storeAttachment(conversation.id, { name: "note.txt", mediaType: "text/plain", base64: Buffer.from("synthetic bytes").toString("base64") });
    expect(await readFile(join(dir, "attachments", ref.sha256), "utf8")).toBe("synthetic bytes");
    await host.submit(conversation.id, { ...input("in-1", "see attached"), attachments: [ref] });
    await host.waitForIdle(conversation.id);
    expect(calls[0]?.turns.at(-1)?.content).toContain(ref.sha256);
    const forged = { ...ref, sha256: "0".repeat(64), uri: `attachment://sha256/${"0".repeat(64)}` };
    const refused = await host.submit(conversation.id, { ...input("in-2", "forged"), attachments: [forged] }).catch((error: unknown) => error);
    expect((refused as ConversationError).status).toBe(400);
  });
});

describe("host lock", () => {
  test("a live holder keeps a second host out with an explicit reason", async () => {
    const dir = await scratch();
    await open(dir, { chat: recorder().chat });
    const second = await openConversationHost({ dir, stack: "test", label: LABEL, expectedLabel: LABEL, endpoints: {}, pid: 999_999_001, alive: pid => pid === process.pid });
    expect(second.state).toBe("unavailable");
    expect(second.state === "unavailable" && second.reason).toBe(`Conversations unavailable: store held by ${process.pid}/${LABEL}`);
  });

  test("a dead holder with this stack's launchd label is taken over; another label is refused", async () => {
    const dir = await scratch();
    await writeLock(dir, 999_999_002, "ai.meta-factory.cortex.other");
    const refused = await openConversationHost({ dir, stack: "test", label: LABEL, expectedLabel: LABEL, endpoints: {}, alive: () => false });
    expect(refused.state === "unavailable" && refused.reason).toContain("does not match");
    await writeLock(dir, 999_999_002, LABEL);
    const taken = await openConversationHost({ dir, stack: "test", label: LABEL, expectedLabel: LABEL, endpoints: {}, alive: pid => pid === process.pid });
    expect(taken.state).toBe("ready");
    if (taken.state !== "ready") return;
    hosts.push(taken.host);
    expect(taken.tookOver?.pid).toBe(999_999_002);
    await taken.host.close();
    expect(existsSync(join(dir, "host.lock"))).toBe(false);
  });
});

describe("host lock edge cases", () => {
  test("a dead holder without a launchd label is refused with the lock path, as the contract requires", async () => {
    const dir = await scratch();
    await writeLock(dir, 999_999_003, "");
    const refused = await openConversationHost({ dir, stack: "test", label: LABEL, expectedLabel: LABEL, endpoints: {}, alive: () => false });
    expect(refused.state === "unavailable" && refused.reason).toBe(`Conversations unavailable: store held by 999999003/no launchd label; its label does not match ${LABEL}, so it is not taken over (lock ${join(dir, "host.lock")})`);
  });

  test("a stale lock whose PID was reused by this process is taken over when the label matches", async () => {
    const dir = await scratch();
    await writeLock(dir, process.pid, LABEL);
    const taken = await openConversationHost({ dir, stack: "test", label: LABEL, expectedLabel: LABEL, endpoints: {} });
    expect(taken.state).toBe("ready");
    if (taken.state === "ready") hosts.push(taken.host);
  });

  test("a lock that cannot be written reports the host unavailable instead of failing boot", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "not-a-directory"), "x");
    const status = await openConversationHost({ dir: join(dir, "not-a-directory"), stack: "test", label: LABEL, expectedLabel: LABEL, endpoints: {} });
    expect(status.state === "unavailable" && status.reason).toStartWith("Conversations unavailable: the store lock could not be taken:");
  });
});

describe("operation journal skeleton", () => {
  test("states advance only along the contract and boot turns an unreadable running operation into uncertain", async () => {
    const dir = await scratch();
    const first = await open(dir, { chat: recorder().chat });
    const conversation = await create(first);
    const op = await first.propose(conversation.id, "proposal-1", 1, "graph-node");
    expect(op.operationId).toBe(`${conversation.id}:proposal-1:1`);
    expect((await first.propose(conversation.id, "proposal-1", 1, "graph-node")).history).toHaveLength(1);
    expect(await first.transition(op.operationId, "running").catch((error: unknown) => (error as ConversationError).status)).toBe(409);
    await first.transition(op.operationId, "confirmed");
    await first.transition(op.operationId, "running");
    expect(await first.transition(op.operationId, "created").catch((error: unknown) => (error as ConversationError).status)).toBe(409);
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);
    const second = await openConversationHost({ dir, stack: "test", label: LABEL, expectedLabel: LABEL, endpoints: {} });
    if (second.state !== "ready") throw new Error(second.reason);
    hosts.push(second.host);
    expect(second.reconciled).toEqual([op.operationId]);
    const [after] = await second.host.operations(conversation.id);
    expect(after?.state).toBe("uncertain");
    await second.host.close();
    hosts.splice(hosts.indexOf(second.host), 1);
    const third = await open(dir, { readbacks: { "graph-node": () => Promise.resolve({ found: true, canonicalId: "the-metafactory/cortex#1" }) } });
    expect((await third.operations(conversation.id))[0]).toMatchObject({ state: "created", canonicalId: "the-metafactory/cortex#1" });
  });
});
