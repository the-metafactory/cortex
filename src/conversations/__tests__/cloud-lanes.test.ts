import { describe, expect, test } from "bun:test";
import { answering, openHost, scratchHosts } from "./fixtures/scratch";
import { DeskConversationsSchema } from "../../common/types/desk-conversations";
import { handoffLanes } from "../../surface/mc/desk/mail-handoff";
import { ConversationError, type ConversationHost, type HostOptions } from "../host";
import type { TurnCall, TurnRequest } from "../model";
import type { Policy } from "../types";

const LABEL = "ai.meta-factory.cortex.test";
const local = { provider: "spark", model: "longctx" };
const codex = { id: "codex", provider: "openai-codex", model: "gpt-test" };
const claude = { id: "claude", provider: "anthropic", model: "claude-test" };
const { dirs, hosts } = scratchHosts("conversations-clouds-");

function recorder(answer: (request: TurnRequest) => string = request => `answer from ${request.lane.provider}`): { calls: TurnRequest[]; turns: TurnCall } {
  const calls: TurnRequest[] = [];
  return { calls, turns: answering(request => { calls.push(request); return answer(request); }) };
}

async function open(dir: string, extra: Partial<HostOptions> = {}): Promise<ConversationHost> {
  return openHost(hosts, { dir, stack: "test", label: LABEL, expectedLabel: LABEL, lanes: { local, cloud: [codex, claude] }, turns: answering(() => "ok"), ...extra });
}

const input = (inputId: string, text: string) => ({ inputId, transport: "web" as const, text, mode: "queue" as const });
const create = (host: ConversationHost, policy: Policy = "cloud") => host.create({ title: "Synthetic", links: [], origin: { kind: "web" }, policy }, "local-principal@loopback");
async function ask(host: ConversationHost, id: string, inputId: string, text: string): Promise<void> {
  await host.submit(id, input(inputId, text));
  await host.waitForIdle(id);
}

describe("several cloud models", () => {
  test("the config takes a list of named cloud lanes or the single legacy lane, and refuses duplicate ids", () => {
    expect(DeskConversationsSchema.parse({ cloud: [codex, claude] }).cloud).toEqual([codex, claude]);
    expect(DeskConversationsSchema.parse({ cloud: { provider: "openai-codex", model: "gpt-test" } }).cloud).toEqual({ provider: "openai-codex", model: "gpt-test" });
    expect(DeskConversationsSchema.safeParse({ cloud: [codex, { ...claude, id: "codex" }] }).success).toBe(false);
    expect(DeskConversationsSchema.safeParse({ cloud: [{ ...codex, id: "Not An Id" }] }).success).toBe(false);
    expect(DeskConversationsSchema.safeParse({ cloud: [] }).success).toBe(false);
  });

  test("a conversation uses the first cloud lane by default, the chosen one after a choice, and records who answered each turn", async () => {
    const { calls, turns } = recorder();
    const host = await open(await dirs.make(), { turns });
    const conversation = await create(host);
    expect((await host.detail(conversation.id)).models).toEqual({ cloud: [{ id: "codex", provider: "openai-codex", model: "gpt-test" }, { id: "claude", provider: "anthropic", model: "claude-test" }], chosen: null, using: "codex" });
    await ask(host, conversation.id, "in-1", "first");
    await host.organize(conversation.id, { cloud: "claude" });
    expect((await host.detail(conversation.id)).models).toMatchObject({ chosen: "claude", using: "claude" });
    await ask(host, conversation.id, "in-2", "second");
    expect(calls.map(call => [call.route, call.lane.provider])).toEqual([["cloud:codex", "openai-codex"], ["cloud:claude", "anthropic"]]);
    const { entries } = await host.entries(conversation.id, 100, undefined);
    expect(entries.filter(entry => entry.role === "assistant").map(entry => [entry.text, entry.model])).toEqual([["answer from openai-codex", "openai-codex/gpt-test"], ["answer from anthropic", "anthropic/claude-test"]]);
    expect(entries.find(entry => entry.kind === "cortex.continuation")?.data).toMatchObject({ mode: "reconstructed", from: "cloud:codex", to: "cloud:claude" });
    expect((await host.exchange(conversation.id)).map(turn => [turn.model, turn.policy])).toEqual([["openai-codex/gpt-test", "cloud"], ["anthropic/claude-test", "cloud"]]);
    await host.organize(conversation.id, { cloud: null });
    expect((await host.detail(conversation.id)).models).toMatchObject({ chosen: null, using: "codex" });
  });

  test("a failing chosen model shows its failure with the model's name and never switches to another provider", async () => {
    const { calls, turns } = recorder(request => {
      if (request.lane.provider === "anthropic") throw new Error("not signed in");
      return "fine";
    });
    const host = await open(await dirs.make(), { turns });
    const conversation = await create(host);
    await host.organize(conversation.id, { cloud: "claude" });
    await ask(host, conversation.id, "in-1", "hello");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.lane.provider === "anthropic")).toBe(true);
    const failed = (await host.entries(conversation.id, 100, undefined)).entries.filter(entry => entry.role === "assistant");
    expect(failed.at(-1)).toMatchObject({ model: "anthropic/claude-test" });
    expect(failed.at(-1)?.error).toContain("not signed in");
    expect(failed.some(entry => entry.text)).toBe(false);
  });

  test("an unknown choice is refused, and a choice removed from the config refuses the turn instead of using another model", async () => {
    const { calls, turns } = recorder();
    const dir = await dirs.make();
    const first = await open(dir, { turns });
    const conversation = await create(first);
    const refused = await first.organize(conversation.id, { cloud: "gemini" }).catch((error: unknown) => error);
    expect((refused as ConversationError).status).toBe(400);
    expect((await first.detail(conversation.id)).models.chosen).toBeNull();
    await first.organize(conversation.id, { cloud: "claude" });
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);
    const second = await open(dir, { turns, lanes: { local, cloud: [codex] } });
    expect((await second.detail(conversation.id)).models).toMatchObject({ chosen: "claude", using: null });
    const blocked = await second.submit(conversation.id, input("in-1", "hello")).catch((error: unknown) => error);
    expect((blocked as ConversationError).status).toBe(503);
    expect((blocked as ConversationError).message).toContain("no longer configured");
    expect(calls).toHaveLength(0);
  });

  test("a local-only conversation stays on the local lane whatever cloud model was chosen", async () => {
    const { calls, turns } = recorder();
    const host = await open(await dirs.make(), { turns });
    const conversation = await create(host, "local");
    await host.organize(conversation.id, { cloud: "claude" });
    expect((await host.detail(conversation.id)).models.using).toBeNull();
    await ask(host, conversation.id, "in-1", "private");
    expect(calls.map(call => call.route)).toEqual(["local"]);
  });

  test("a single legacy cloud lane keeps the cloud route and is the only choice", async () => {
    const { calls, turns } = recorder();
    const host = await open(await dirs.make(), { turns, lanes: { cloud: { provider: "openai-codex", model: "gpt-test" } } });
    const conversation = await create(host);
    expect((await host.detail(conversation.id)).models).toEqual({ cloud: [{ id: "cloud", provider: "openai-codex", model: "gpt-test" }], chosen: null, using: "cloud" });
    await ask(host, conversation.id, "in-1", "hello");
    expect(calls.map(call => call.route)).toEqual(["cloud"]);
  });

  test("mail hand-offs read with the default cloud lane", () => {
    expect(handoffLanes({ local, cloud: [claude, codex] })).toEqual({ local, cloud: { provider: "anthropic", model: "claude-test" } });
    expect(handoffLanes({ cloud: { provider: "openai-codex", model: "gpt-test", thinking: "low" } })).toEqual({ cloud: { provider: "openai-codex", model: "gpt-test", thinking: "low" } });
    expect(handoffLanes({})).toEqual({});
  });
});
