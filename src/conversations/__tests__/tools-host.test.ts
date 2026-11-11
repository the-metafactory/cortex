import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { ToolsConfig } from "../../common/types/desk-conversations";
import { type ConversationHost, type HostOptions } from "../host";
import type { ToolOutcome, TurnRequest } from "../model";
import { type ToolDefinition } from "../tools/capabilities";
import { answering, openHost, scratchHosts } from "./fixtures/scratch";

const { dirs, hosts } = scratchHosts("conversation-tools-host-");
const lane = { provider: "fixture", model: "model" };
const registry = (): ToolsConfig => ({ projects: [
  { id: "public", root: "/tmp/synthetic-public", policy: "cloud", operations: ["repo.read"] },
  { id: "private", root: "/tmp/synthetic-private", policy: "local", operations: ["repo.read"] },
] });
const read = (run: ToolDefinition["run"] = () => Promise.resolve("SYNTHETIC_PRIVATE_CONTENT")): ToolDefinition => ({ name: "repo_read", description: "Read the synthetic source", operation: "repo.read", input: z.object({ project: z.string() }).strict(), run });
const input = (inputId: string, transport: "web" | "discord" = "web") => ({ inputId, transport, text: "investigate", mode: "queue" as const });
const create = (host: ConversationHost, policy: "local" | "cloud" = "local") => host.create({ title: "Synthetic", links: [], origin: { kind: "web" }, policy }, "synthetic-principal");
async function open(config: ToolsConfig, answer: (r: TurnRequest) => Promise<string>, extra: Partial<HostOptions> = {}) {
  return openHost(hosts, { dir: await dirs.make(), stack: "test", label: "test", expectedLabel: "test", lanes: { local: lane, cloud: lane }, tools: { config: () => config, definitions: [read()] }, turns: answering(answer), ...extra });
}

describe("durable conversation tool authorization", () => {
  test("local-only results never reach a Discord turn, even on the local lane", async () => {
    const config = registry();
    const outcomes: ToolOutcome[] = [];
    const host = await open(config, async request => {
      const result = await request.tools!.call("call", "repo_read", { project: "private" }, request.signal);
      outcomes.push(result);
      return result.text;
    });
    const conversation = await create(host);
    await host.submit(conversation.id, input("discord", "discord"));
    await host.waitForIdle(conversation.id);
    expect(outcomes[0]?.outcome).toBe("refused");
    expect(JSON.stringify(await host.entries(conversation.id, 100, undefined))).not.toContain("SYNTHETIC_PRIVATE_CONTENT");
  });

  test("tool source policy survives restart and tightening refuses a cloud resume", async () => {
    const config = registry();
    const dir = await dirs.make();
    const host = await open(config, async request => (await request.tools!.call("call", "repo_read", { project: "public" }, request.signal)).text, { dir });
    const conversation = await create(host, "cloud");
    await host.submit(conversation.id, input("one"));
    await host.waitForIdle(conversation.id);
    const entries = (await host.entries(conversation.id, 100, undefined)).entries;
    expect(entries.find(e => e.kind === "cortex.tool-activity")?.data).toMatchObject({ source: { id: "public", policy: "cloud" }, outcome: "done" });
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    config.projects[0]!.policy = "local";
    let called = false;
    const restarted = await openHost(hosts, { dir, stack: "test", label: "test", expectedLabel: "test", lanes: { local: lane, cloud: lane }, tools: { config: () => config, definitions: [read()] }, turns: answering(request => { called = true; expect(request.route).toBe("local"); return "private on web"; }) });
    expect((await restarted.meta(conversation.id)).policy).toBe("local");
    await restarted.submit(conversation.id, input("two"));
    await restarted.waitForIdle(conversation.id);
    expect(called).toBe(true);
  });

  test("a revoked source closes only its own conversation: the lists still answer and show it as local-only", async () => {
    const config = registry();
    let bound = false;
    const host = await open(config, async request => {
      if (bound) return "SYNTHETIC_UNTOUCHED_TRANSCRIPT";
      bound = true;
      await request.tools!.call("call", "repo_read", { project: "public" }, request.signal);
      return "SYNTHETIC_REVOKED_TRANSCRIPT";
    }, { resolvers: { "studio-thread": () => Promise.resolve({ state: "available", policy: "cloud", title: "Thread" }) } });
    const revoked = await host.create({ title: "Synthetic", links: [{ owner: "studio-thread", id: "thread-a" }], origin: { kind: "web" }, policy: "cloud" }, "synthetic-principal");
    const untouched = await create(host, "cloud");
    await host.submit(revoked.id, input("one"));
    await host.waitForIdle(revoked.id);
    await host.submit(untouched.id, input("two"));
    await host.waitForIdle(untouched.id);
    const search = async (q: string) => (await host.overview({ state: "current", q, limit: 25 })).rows.map(found => found.conversation.id);
    expect(await search("SYNTHETIC_REVOKED_TRANSCRIPT")).toEqual([revoked.id]);
    config.projects.splice(0, 1);

    const listed = await host.list();
    expect(listed.find(row => row.id === revoked.id)).toMatchObject({ policy: "local", links: [] });
    expect(listed.find(row => row.id === untouched.id)).toMatchObject({ policy: "cloud" });
    const { rows } = await host.overview({ state: "current", q: "", limit: 25 });
    expect(rows.map(row => row.conversation.id).sort()).toEqual([revoked.id, untouched.id].sort());
    const row = rows.find(candidate => candidate.conversation.id === revoked.id);
    expect(row).toMatchObject({ conversation: { policy: "local" }, latest: null, match: null, linked: [] });
    expect(JSON.stringify(rows)).toContain("SYNTHETIC_UNTOUCHED_TRANSCRIPT");
    expect(JSON.stringify(rows)).not.toContain("SYNTHETIC_REVOKED_TRANSCRIPT");
    expect(await search("SYNTHETIC_REVOKED_TRANSCRIPT")).toEqual([]);
    expect(await search("Synthetic")).toContain(revoked.id);
    await expect(host.submit(revoked.id, input("two"))).rejects.toThrow("revoked or changed");
    await expect(host.detail(revoked.id)).rejects.toThrow("revoked or changed");
  });

  test("revoking a previously read source blocks history forwarding", async () => {
    const config = registry();
    let calls = 0;
    const host = await open(config, async request => { calls++; return (await request.tools!.call("call", "repo_read", { project: "public" }, request.signal)).text; });
    const conversation = await create(host, "cloud");
    await host.submit(conversation.id, input("one"));
    await host.waitForIdle(conversation.id);
    config.projects.splice(0, 1);
    await expect(host.submit(conversation.id, input("two"))).rejects.toThrow("revoked or changed");
    expect(calls).toBe(1);
  });

  test("scope revocation during a call withholds the result and the turn's final answer", async () => {
    const config = registry();
    const outcomes: ToolOutcome[] = [];
    const host = await open(config, async request => {
      outcomes.push(await request.tools!.call("first", "repo_read", { project: "public" }, request.signal));
      outcomes.push(await request.tools!.call("next", "repo_read", { project: "public" }, request.signal));
      return "stale reply";
    }, { tools: { config: () => config, definitions: [read(() => { config.projects = []; return Promise.resolve("REVOKED_CONTENT"); })] } });
    const conversation = await create(host, "cloud");
    await host.submit(conversation.id, input("one"));
    await host.waitForIdle(conversation.id);
    expect(outcomes.map(o => o.outcome)).toEqual(["refused", "refused"]);
    const record = JSON.stringify(await host.entries(conversation.id, 100, undefined));
    expect(record).not.toContain("REVOKED_CONTENT");
    expect(record).not.toContain("stale reply");
  });

  test("a queued Discord input cannot change the active web turn's bound transport", async () => {
    const config = registry();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let count = 0;
    const outcomes: ToolOutcome[] = [];
    const host = await open(config, async request => {
      count++;
      if (count === 1) { entered.resolve(undefined); await release.promise; }
      const result = await request.tools!.call(`call-${count}`, "repo_read", { project: "private" }, request.signal);
      outcomes.push(result);
      return result.text;
    });
    const conversation = await create(host);
    await host.submit(conversation.id, input("web"));
    await entered.promise;
    await host.submit(conversation.id, input("discord", "discord"));
    release.resolve(undefined);
    await host.waitForIdle(conversation.id);
    expect(outcomes.map(o => o.outcome)).toEqual(["done", "refused"]);
  });
});


describe("worker status host release", () => {
  test("the host asks the source to remember status and withholds a revoked response", async () => {
    let remembered = 0;
    const outcomes: ToolOutcome[] = [];
    const host = await open(registry(), async request => {
      const result = await request.tools!.call("worker", "worker_status", { node: "example/maps#30" }, request.signal);
      outcomes.push(result);
      return result.text;
    });
    await host.attachSources({ resolvers: {}, readbacks: {}, writers: {}, workers: {
      maps: () => ["example/maps#12"], recorded: () => "cloud", now: Date.now,
      read: () => Promise.resolve({ state: "available", handoff: { node: "example/maps#30", map: "example/maps#12", policy: "cloud", state: "running", reason: null, generation: 3, pr: null, result: "REVOKED_WORKER_RESULT", observedAt: Date.now() } }),
      remember: () => { remembered += 1; return Promise.resolve(false); },
    } });
    const conversation = await create(host, "cloud");
    await host.submit(conversation.id, input("worker"));
    await host.waitForIdle(conversation.id);
    expect(remembered).toBeGreaterThan(0);
    expect(outcomes[0]!.text).not.toContain("REVOKED_WORKER_RESULT");
    expect(JSON.stringify(await host.entries(conversation.id, 100, undefined))).not.toContain("REVOKED_WORKER_RESULT");
  });
});


describe("worker source getters", () => {
  test("a late attached getter can release currently authorized worker status", async () => {
    const outcomes: ToolOutcome[] = [];
    const host = await open(registry(), async request => {
      const result = await request.tools!.call("worker", "worker_status", { node: "example/maps#30" }, request.signal);
      outcomes.push(result);
      return result.text;
    });
    await host.attachSources({ resolvers: {}, readbacks: {}, writers: {}, get workers() { return {
      maps: () => ["example/maps#12"], recorded: () => "cloud" as const, now: Date.now,
      read: () => Promise.resolve({ state: "available" as const, handoff: { node: "example/maps#30", map: "example/maps#12", policy: "cloud" as const, state: "running" as const, reason: null, generation: 3, pr: null, result: "AUTHORIZED_WORKER_RESULT", observedAt: Date.now() } }),
      remember: () => Promise.resolve(true),
    }; } });
    const conversation = await create(host, "cloud");
    await host.submit(conversation.id, input("worker"));
    await host.waitForIdle(conversation.id);
    expect(outcomes[0]!.text).toContain("AUTHORIZED_WORKER_RESULT");
  });
});
