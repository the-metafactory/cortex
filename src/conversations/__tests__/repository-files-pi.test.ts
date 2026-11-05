import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolsConfig } from "../../common/types/desk-conversations";
import { discoverPi, piTurns } from "../pi";
import { openHost, scratchHosts } from "./fixtures/scratch";
import { toolProvider } from "./fixtures/tool-provider";

const { dirs, hosts } = scratchHosts("repository-files-pi-");
const realPi = discoverPi();
const PRIVATE = "SYNTHETIC_LOCAL_ONLY_PROBE_CONTENT";
const call = (id: string, name: string, input: object) => ({ id, name, input });

describe("installed Pi repository conversation probe", () => {
  test.skipIf(!realPi)("finds a known working symbol and cites its line; escape and local-only attempts disclose zero file bytes", async () => {
    const dir = await dirs.make();
    const root = join(dir, "checkout");
    const local = join(dir, "local-checkout");
    await mkdir(root);
    expect(await Bun.spawn(["git", "init", "--quiet", root], { stdout: "ignore", stderr: "pipe" }).exited).toBe(0);
    await mkdir(local);
    await writeFile(join(root, "beacon.ts"), "export const syntheticBeacon = 42;\n");
    await writeFile(join(local, "note.txt"), PRIVATE);
    await writeFile(join(dir, "outside.txt"), PRIVATE);
    await symlink(join(dir, "outside.txt"), join(root, "escape.txt"));
    const config: ToolsConfig = { projects: [
      { id: "sample", root, policy: "cloud", operations: ["repo.read"] },
      { id: "restricted", root: local, policy: "local", operations: ["repo.read"] },
    ] };
    const provider = await toolProvider(dir, realPi!);
    const host = await openHost(hosts, { dir: join(dir, "store"), stack: "test", label: "test", expectedLabel: "test", lanes: { local: { provider: "synthetic", model: "local" }, cloud: [{ id: "research", provider: "synthetic", model: "cloud" }] }, turns: piTurns(provider.settings), tools: { config: () => config } });
    try {
      for (const policy of ["cloud", "local"] as const) {
        const conversation = await host.create({ title: "Synthetic repository probe", origin: { kind: "web" }, policy, links: [] }, "synthetic-principal");
        const start = provider.requests.length;
        provider.steps.push(
          [call("search", "repo_search", { project: "sample", query: "syntheticBeacon" })],
          [call("escape", "repo_read", { project: "sample", path: "escape.txt" }), call("traversal", "repo_read", { project: "sample", path: "../outside.txt" })],
          ...(policy === "cloud" ? [[call("local-only", "repo_read", { project: "restricted", path: "note.txt" })]] : []),
          "Found syntheticBeacon in beacon.ts:1: export const syntheticBeacon = 42;",
        );
        await host.submit(conversation.id, { inputId: "probe", transport: "web", mode: "queue", text: "Find syntheticBeacon in sample and cite its line. Check that paths outside the project and cloud reads of local-only projects are refused." });
        await host.waitForIdle(conversation.id);
        expect(await host.input(conversation.id, "probe")).toMatchObject({ status: "done", answer: expect.stringContaining("beacon.ts:1") });
        const entries = (await host.entries(conversation.id, 100, undefined)).entries;
        const activities = entries.filter(entry => entry.kind === "cortex.tool-activity").map(entry => entry.data);
        expect(activities).toContainEqual(expect.objectContaining({ callId: "search", outcome: "done", result: expect.stringContaining('"line":1') }));
        for (const id of ["escape", "traversal"]) expect(activities).toContainEqual(expect.objectContaining({ callId: id, outcome: "refused", result: expect.stringContaining('"disclosedBytes":0') }));
        if (policy === "cloud") expect(activities).toContainEqual(expect.objectContaining({ callId: "local-only", outcome: "refused" }));
        const requests = provider.requests.slice(start);
        expect(JSON.stringify(requests)).toContain('syntheticBeacon');
        expect(JSON.stringify(requests)).not.toContain(PRIVATE);
        expect(JSON.stringify(entries)).not.toContain(PRIVATE);
        expect(requests[0]?.tools?.map(tool => tool.function.name).sort()).toEqual(["capabilities", "repo_find", "repo_list", "repo_read", "repo_search"]);
      }
    } finally { await host.close(); hosts.splice(hosts.indexOf(host), 1); await provider.close(); }
  }, 60_000);
});
