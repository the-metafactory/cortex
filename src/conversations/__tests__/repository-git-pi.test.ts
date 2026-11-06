import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { discoverPi, piTurns } from "../pi";
import type { ToolActivity } from "../model";
import { createRepositoryGitTools } from "../tools/repository-git";
import { directGit, gitFixture, snapshot } from "./fixtures/repository-git";
import { openHost, scratchHosts } from "./fixtures/scratch";
import { toolProvider } from "./fixtures/tool-provider";

const { dirs, hosts } = scratchHosts("repository-git-pi-");
const realPi = discoverPi();
const call = (id: string, name: string, input: object = {}) => ({ id, name: `repo_git_${name}`, input: { project: "sample", ...input } });
const resultBody = (text: string): Record<string, any> => JSON.parse(text.slice(text.indexOf("\n") + 1, text.lastIndexOf("\n</tool-result>"))) as Record<string, any>;

describe("installed Pi conversation Git probe", () => {
  test.skipIf(!realPi)("branch, uncommitted diff and last synthetic-file change agree with direct Git, preserve all bytes, and enforce cloud/local policy", async () => {
    const dir = await dirs.make();
    const r = await gitFixture(dir);
    const before = await snapshot(r.root);
    const directDiff = await directGit(r.root, ["diff", "HEAD", "--", "beacon.txt"]);
    const branch = (await directGit(r.root, ["branch", "--show-current"])).trim();
    const provider = await toolProvider(dir, realPi!);
    const host = await openHost(hosts, { dir: join(dir, "store"), stack: "test", label: "test", expectedLabel: "test", lanes: { local: { provider: "synthetic", model: "local" }, cloud: { provider: "synthetic", model: "cloud" } }, turns: piTurns(provider.settings), tools: { config: () => r.config, definitions: createRepositoryGitTools() } });
    try {
      for (const policy of ["cloud", "local"] as const) {
        const conversation = await host.create({ title: "Synthetic Git inspection", origin: { kind: "web" }, policy, links: [] }, "synthetic-principal");
        const start = provider.requests.length;
        provider.steps.push(
          [call("head", "head"), call("diff", "diff", { path: "beacon.txt" }), call("last", "log", { path: "beacon.txt", limit: 1 })],
          [call("restricted", "show", { ref: r.first, path: "restricted/note.txt" })],
          `Branch ${branch}; beacon.txt has staged and unstaged changes. Its last commit is ${r.head}: Synthetic beacon change.`,
        );
        await host.submit(conversation.id, { inputId: "probe", transport: "web", mode: "queue", text: "Read the current branch, uncommitted diff and the last change to beacon.txt. Check whether restricted/note.txt may be read in this conversation." });
        await host.waitForIdle(conversation.id);
        expect(await host.input(conversation.id, "probe")).toMatchObject({ status: "done", answer: expect.stringContaining(`Branch ${branch}`) });
        const entries = (await host.entries(conversation.id, 100, undefined)).entries;
        const activities = entries.filter(entry => entry.kind === "cortex.tool-activity").map(entry => entry.data as ToolActivity);
        const read = (id: string): ToolActivity => {
          const activity = activities.find(item => item.callId === id);
          if (!activity) throw new Error(`Missing tool evidence: ${id}`);
          return activity;
        };
        expect(resultBody(read("head").result).provenance).toMatchObject({ branch, revision: r.head });
        expect(resultBody(read("diff").result).diff).toBe(directDiff);
        expect(resultBody(read("last").result).commits[0]).toMatchObject({ revision: r.head, paths: ["beacon.txt"], subject: "Synthetic beacon change" });
        expect(read("restricted").outcome).toBe(policy === "cloud" ? "refused" : "done");
        if (policy === "cloud") {
          expect(JSON.stringify(provider.requests.slice(start))).not.toContain("SYNTHETIC_LOCAL_ONLY");
          expect(JSON.stringify(entries)).not.toContain("SYNTHETIC_LOCAL_ONLY");
        }
      }
      expect(await snapshot(r.root)).toEqual(before);
    } finally { await host.close(); hosts.splice(hosts.indexOf(host), 1); await provider.close(); }
  }, 60_000);
});
