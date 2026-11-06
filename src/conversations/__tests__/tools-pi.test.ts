import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type { ToolsConfig } from "../../common/types/desk-conversations";
import { DiscordConversations } from "../discord";
import { discoverPi, piTurns } from "../pi";
import type { ToolDefinition } from "../tools/capabilities";
import { FakeThreads } from "./fixtures/discord-threads";
import { RIG } from "./fixtures/discord-rig";
import { openHost, scratchHosts } from "./fixtures/scratch";
import { toolProvider } from "./fixtures/tool-provider";

const { dirs, hosts } = scratchHosts("conversation-tools-pi-");
const realPi = discoverPi();
const PRIVATE = "LOCAL_ONLY_SYNTHETIC_MARKER";
const call = (id: string, name: string, input: object) => ({ id, name, input });
const input = (inputId: string) => ({ inputId, transport: "web" as const, mode: "queue" as const, text: "Investigate the synthetic project." });
const read = (run: ToolDefinition["run"]): ToolDefinition => ({ name: "repo_read", description: "Read the configured synthetic project's fixture.", operation: "repo.read", input: z.object({ project: z.string() }).strict(), run });

async function registry(dir: string): Promise<ToolsConfig> {
  await writeFile(join(dir, "public.txt"), "PUBLIC_SYNTHETIC_MARKER");
  await writeFile(join(dir, "private.txt"), PRIVATE);
  return { projects: [
    { id: "public", root: dir, operations: ["repo.read"], policy: "cloud" },
    { id: "private", root: dir, operations: ["repo.read"], policy: "local" },
  ] };
}

describe("installed Pi conversation host boundary", () => {
  test.skipIf(!realPi)("local and cloud lanes discover explicit scopes; no local text reaches cloud or Discord records", async () => {
    const dir = await dirs.make();
    const provider = await toolProvider(dir, realPi!);
    const config = await registry(dir);
    const host = await openHost(hosts, { dir: join(dir, "store"), stack: "test", label: "test", expectedLabel: "test", lanes: { local: { provider: "synthetic", model: "local" }, cloud: { provider: "synthetic", model: "cloud" } }, turns: piTurns(provider.settings), tools: { config: () => config, definitions: [read((_input, context) => readFile(join(context.project!.root, `${context.project!.id}.txt`), "utf8"))] } });
    try {
      const local = await host.create({ title: "Synthetic local", origin: { kind: "web" }, policy: "local", links: [] }, RIG.owner);
      provider.steps.push([call("local-cap", "capabilities", {})], [call("local-read", "repo_read", { project: "private" })], "Local investigation complete.");
      await host.submit(local.id, input("local"));
      await host.waitForIdle(local.id);
      expect((await host.input(local.id, "local")).status).toBe("done");
      const localActivities = (await host.entries(local.id, 100, undefined)).entries.filter(entry => entry.kind === "cortex.tool-activity").map(entry => entry.data);
      expect(localActivities).toContainEqual(expect.objectContaining({ callId: "local-cap", outcome: "done", result: expect.stringContaining('"project":"private"') }));
      expect(localActivities).toContainEqual(expect.objectContaining({ callId: "local-cap", result: expect.stringContaining('"project":"public"') }));
      expect(provider.requests[0]?.tools?.map(tool => tool.function.name).sort()).toEqual(["capabilities", "conversation_read", "conversation_search", "repo_read", "work_read", "work_search"]);
      expect(JSON.stringify(provider.requests)).toContain(PRIVATE);
      const fake = new FakeThreads();
      const discord = new DiscordConversations({ host, adapter: () => fake, principalId: RIG.principal, config: { channelId: RIG.channel, guildId: RIG.guild, webUrl: RIG.web }, log: () => undefined });
      discord.setWebPrincipal(RIG.owner);
      await expect(discord.attach(local.id)).rejects.toThrow("local-only");
      await discord.sync(local.id);
      expect(JSON.stringify(fake.posts)).not.toContain(PRIVATE);
      expect(JSON.stringify(await host.deliveries())).not.toContain(PRIVATE);
      const cloudStart = provider.requests.length;
      const cloud = await host.create({ title: "Synthetic cloud", origin: { kind: "web" }, policy: "cloud", links: [] }, RIG.owner);
      provider.steps.push([call("cloud-cap", "capabilities", {})], [call("hidden-read", "repo_read", { project: "private" }), call("cloud-read", "repo_read", { project: "public" })], [call("invalid-read", "repo_read", {}), call("unknown", "bash", { command: "echo forbidden" })], "Cloud investigation complete.");
      await host.submit(cloud.id, input("cloud"));
      await host.waitForIdle(cloud.id);
      expect(await host.input(cloud.id, "cloud")).toMatchObject({ status: "done", answer: "Cloud investigation complete." });
      await discord.attach(cloud.id);
      await discord.sync(cloud.id);
      expect(JSON.stringify(fake.posts)).not.toContain(PRIVATE);
      expect(JSON.stringify(await host.deliveries())).not.toContain(PRIVATE);
      const cloudRequests = provider.requests.slice(cloudStart);
      expect(cloudRequests.every(request => request.model === "cloud")).toBe(true);
      expect(JSON.stringify(cloudRequests)).not.toContain(PRIVATE);
      expect(JSON.stringify(cloudRequests)).toContain("PUBLIC_SYNTHETIC_MARKER");
      expect(cloudRequests[0]?.tools?.map(tool => tool.function.name).sort()).toEqual(["capabilities", "conversation_read", "conversation_search", "repo_read", "work_read", "work_search"]);
      const entries = (await host.entries(cloud.id, 100, undefined)).entries;
      const activities = entries.filter(entry => entry.kind === "cortex.tool-activity").map(entry => entry.data);
      expect(activities).toContainEqual(expect.objectContaining({ callId: "cloud-cap", outcome: "done", result: expect.stringContaining('"project":"public"') }));
      expect(activities).not.toContainEqual(expect.objectContaining({ callId: "cloud-cap", result: expect.stringContaining('"project":"private"') }));
      expect(activities).toContainEqual(expect.objectContaining({ callId: "hidden-read", outcome: "refused" }));
      expect(activities).toContainEqual(expect.objectContaining({ callId: "invalid-read", outcome: "error" }));
      expect(activities).toContainEqual(expect.objectContaining({ tool: "bash", outcome: "refused" }));
      expect(JSON.stringify(entries)).not.toContain(PRIVATE);
      provider.steps.push([call("again", "capabilities", {})], "Fresh permissions checked.");
      await host.submit(cloud.id, input("again"));
      await host.waitForIdle(cloud.id);
      expect((await host.input(cloud.id, "again")).answer).toBe("Fresh permissions checked.");
    } finally { await host.close(); hosts.splice(hosts.indexOf(host), 1); await provider.close(); }
  }, 60_000);

  test.skipIf(!realPi)("revocation during tool dispatch denies release and the next call before another model request", async () => {
    const dir = await dirs.make();
    const provider = await toolProvider(dir, realPi!);
    const config = await registry(dir);
    const host = await openHost(hosts, { dir: join(dir, "store"), stack: "test", label: "test", expectedLabel: "test", lanes: { cloud: { provider: "synthetic", model: "cloud" } }, turns: piTurns(provider.settings), tools: { config: () => config, definitions: [read(() => { config.projects = []; return Promise.resolve(PRIVATE); })] } });
    try {
      const conversation = await host.create({ title: "Synthetic revocation", origin: { kind: "web" }, policy: "cloud", links: [] }, RIG.owner);
      provider.steps.push([call("revoke", "repo_read", { project: "public" }), call("next", "repo_read", { project: "public" })], "This answer must never be requested.");
      await host.submit(conversation.id, input("revoke"));
      await host.waitForIdle(conversation.id);
      const entries = (await host.entries(conversation.id, 100, undefined)).entries;
      const activities = entries.filter(entry => entry.kind === "cortex.tool-activity").map(entry => entry.data);
      expect(activities).toContainEqual(expect.objectContaining({ callId: "revoke", outcome: "refused" }));
      expect(activities).toContainEqual(expect.objectContaining({ callId: "next", outcome: "refused" }));
      expect(provider.requests).toHaveLength(1);
      expect(JSON.stringify(entries)).not.toContain(PRIVATE);
      expect(JSON.stringify(provider.requests)).not.toContain(PRIVATE);
      expect((await host.input(conversation.id, "revoke")).status).toBe("unanswered");
    } finally { await host.close(); hosts.splice(hosts.indexOf(host), 1); await provider.close(); }
  }, 60_000);

  test.skipIf(!realPi)("turn cancellation and timeout stop pending tools and settle durable activity", async () => {
    for (const mode of ["cancel", "timeout"]) {
      const dir = await dirs.make();
      const provider = await toolProvider(dir, realPi!);
      const config = await registry(dir);
      const entered = Promise.withResolvers<undefined>();
      const cancelled = new AbortController();
      let toolStopped = false;
      const turn = piTurns({ ...provider.settings, timeoutSeconds: mode === "timeout" ? 5 : 20 });
      const host = await openHost(hosts, { dir: join(dir, "store"), stack: "test", label: "test", expectedLabel: "test", lanes: { cloud: { provider: "synthetic", model: "cloud" } }, turns: request => turn({ ...request, signal: cancelled.signal }), tools: { config: () => config, definitions: [read((_input, context) => new Promise((_resolve, reject) => {
        entered.resolve(undefined);
        context.signal.addEventListener("abort", () => { toolStopped = true; reject(new Error("cancelled")); }, { once: true });
      }))] } });
      try {
        const conversation = await host.create({ title: "Synthetic interruption", origin: { kind: "web" }, policy: "cloud", links: [] }, RIG.owner);
        provider.steps.push([call("pending", "repo_read", { project: "public" })]);
        await host.submit(conversation.id, input(mode));
        await entered.promise;
        if (mode === "cancel") cancelled.abort();
        await host.waitForIdle(conversation.id);
        expect(toolStopped).toBe(true);
        expect(provider.requests).toHaveLength(1);
        const entries = (await host.entries(conversation.id, 100, undefined)).entries;
        expect(entries.find(entry => entry.kind === "cortex.tool-activity")?.data).toMatchObject({ callId: "pending", outcome: "stopped" });
        expect(entries.find(entry => entry.error)?.error).toContain(mode === "cancel" ? "cancelled" : "did not answer within");
      } finally { await host.close(); hosts.splice(hosts.indexOf(host), 1); await provider.close(); }
    }
  }, 30_000);

});
