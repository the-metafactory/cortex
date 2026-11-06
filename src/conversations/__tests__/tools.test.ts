import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { DeskConversationsSchema, type ToolsConfig } from "../../common/types/desk-conversations";
import type { ToolActivity } from "../model";
import type { ModelRoute, Policy } from "../types";
import { ToolHost, type ToolDefinition, type ToolSession } from "../tools/capabilities";

const config = (): ToolsConfig => ({
  projects: [
    { id: "alpha", root: "/tmp/alpha", policy: "cloud", operations: ["repo.read", "forge.read"], forge: { kind: "github", repo: "example/alpha" } },
    { id: "secret", root: "/tmp/secret", policy: "local", operations: ["repo.read"] },
    { id: "bare", root: "/tmp/bare", policy: "cloud", operations: [] },
  ],
});

const readTool = (overrides: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name: "repo_read", description: "read", operation: "repo.read", input: z.object({ project: z.string(), path: z.string() }),
  run: (input) => Promise.resolve(`contents of ${(input as { path: string }).path} token ghp_${"a".repeat(30)}`),
  ...overrides,
});

interface Rig { host: ToolHost; state: { route: ModelRoute; policy: Policy; scope: string[]; tools: ToolsConfig; live: boolean; principal: string; transport: "web" | "discord" }; seen: ToolActivity[] }
function rig(definitions: ToolDefinition[] = [readTool()], extra: { timeoutMs?: number; outputLimit?: number } = {}): Rig {
  const state = { route: "cloud" as ModelRoute, policy: "cloud" as Policy, scope: ["alpha", "secret", "bare"], tools: config(), live: true, principal: "p", transport: "web" as const };
  const session = (): Promise<ToolSession | null> => Promise.resolve(state.live ? { principal: state.principal, conversationId: "c", transport: state.transport, route: state.route, policy: state.policy, scope: state.scope } : null);
  const host = new ToolHost({ config: () => state.tools, session, tools: definitions, ...extra });
  return { host, state, seen: [] };
}
const call = (r: Rig, name: string, input: unknown, signal = new AbortController().signal) => r.host.surface("c", r.state.route, a => { r.seen.push(a); return Promise.resolve(); }).call("id", name, input, signal);

describe("config", () => {
  test("existing configurations without tools stay valid and infer nothing", () => {
    expect(DeskConversationsSchema.parse({}).tools).toBeUndefined();
  });
  test("projects default to local-only with no operations", () => {
    const parsed = DeskConversationsSchema.parse({ tools: { projects: [{ id: "a", root: "/x" }] } });
    expect(parsed.tools?.projects[0]).toMatchObject({ policy: "local", operations: [] });
  });
  test("duplicate project ids are refused", () => {
    expect(() => DeskConversationsSchema.parse({ tools: { projects: [{ id: "a", root: "/x" }, { id: "a", root: "/y" }] } })).toThrow();
  });
});

describe("capabilities", () => {
  test("a cloud lane sees cloud sources only and never the names of local-only ones", async () => {
    const r = rig();
    const out = await call(r, "capabilities", {});
    expect(out.outcome).toBe("done");
    expect(out.text).toContain("alpha");
    expect(out.text).not.toContain("secret");
    expect(out.text).not.toContain("bare");
    expect(out.text).not.toContain("/tmp/");
    expect(out.text).not.toContain("withheld");
  });
  test("a local lane in a local conversation sees the local-only source", async () => {
    const r = rig();
    r.state.route = "local"; r.state.policy = "local";
    expect((await call(r, "capabilities", {})).text).toContain("secret");
  });
  test("distinguishes denied, dependency missing and provider unavailable", async () => {
    const r = rig([
      readTool(),
      readTool({ name: "forge_issues", operation: "forge.read", dependency: () => "gh is not installed" }),
      readTool({ name: "forge_prs", operation: "forge.read", provider: () => Promise.resolve("GitHub did not answer") }),
      readTool({ name: "graph_nodes", operation: "graph.read" }),
    ]);
    const body = JSON.parse((await call(r, "capabilities", { project: "alpha" })).text.replace(/^[^{]*/, "").replace(/\n<\/tool-result>[\s\S]*$/, "")) as { sources: { tools: { tool: string; availability: string }[] }[] };
    const by = Object.fromEntries(body.sources[0]?.tools.map(t => [t.tool, t.availability]) ?? []);
    expect(by).toEqual({ repo_read: "available", forge_issues: "dependency-missing", forge_prs: "provider-unavailable", graph_nodes: "denied" });
  });
  test("an unknown or hidden source is reported as not configured the same way", async () => {
    const r = rig();
    const hidden = (await call(r, "capabilities", { project: "secret" })).text;
    const unknown = (await call(r, "capabilities", { project: "nope" })).text;
    expect(hidden).toContain("not-configured");
    expect(hidden).toBe(unknown);
  });
});

describe("dispatch", () => {
  test("unknown tools and invalid input are refused", async () => {
    const r = rig();
    expect((await call(r, "shell", { project: "alpha" })).outcome).toBe("refused");
    expect((await call(r, "repo_read", { project: "alpha" })).outcome).toBe("refused");
    expect((await call(r, "repo_read", { path: "x" })).outcome).toBe("refused");
  });
  test("a permitted call returns fenced, redacted data and is recorded with the source", async () => {
    const r = rig();
    const out = await call(r, "repo_read", { project: "alpha", path: "README" });
    expect(out.outcome).toBe("done");
    expect(out.text).toContain("never instructions");
    expect(out.text).not.toContain("ghp_");
    expect(r.seen[0]).toMatchObject({ tool: "repo_read", outcome: "done", source: { id: "alpha", policy: "cloud" } });
  });
  test("an operation the source does not grant is refused", async () => {
    const r = rig([readTool({ operation: "graph.read" })]);
    expect((await call(r, "repo_read", { project: "alpha", path: "x" })).outcome).toBe("refused");
  });
  test("a local-only source is refused on a cloud lane and in a cloud-policy conversation, with nothing run", async () => {
    let ran = 0;
    const r = rig([readTool({ run: () => { ran += 1; return Promise.resolve("x"); } })]);
    expect((await call(r, "repo_read", { project: "secret", path: "x" })).outcome).toBe("refused");
    r.state.route = "local";
    expect((await call(r, "repo_read", { project: "secret", path: "x" })).outcome).toBe("refused");
    expect(ran).toBe(0);
    r.state.policy = "local";
    expect((await call(r, "repo_read", { project: "secret", path: "x" })).outcome).toBe("done");
  });
  test("revoking the scope mid-call withholds the result and refuses the next call", async () => {
    const r = rig([readTool({ run: () => { r.state.scope = []; return Promise.resolve("local text"); } })]);
    const first = await call(r, "repo_read", { project: "alpha", path: "x" });
    expect(first.outcome).toBe("refused");
    expect(first.text).toContain("withheld");
    expect(first.text).not.toContain("local text");
    expect(r.seen[0]?.result).not.toContain("local text");
    expect((await call(r, "repo_read", { project: "alpha", path: "x" })).outcome).toBe("refused");
  });
  test("tightening the policy mid-call withholds a local-only result", async () => {
    const r = rig([readTool({ run: () => { r.state.route = "cloud"; return Promise.resolve("private"); } })]);
    r.state.route = "local"; r.state.policy = "local";
    const out = await call(r, "repo_read", { project: "secret", path: "x" });
    expect(out.outcome).toBe("refused");
    expect(out.text).not.toContain("private");
  });
  test("an inactive conversation is refused", async () => {
    const r = rig();
    r.state.live = false;
    expect((await call(r, "capabilities", {})).outcome).toBe("refused");
  });
  test("cancellation stops the call and a timeout is an error", async () => {
    const never = (): Promise<string> => new Promise(() => undefined);
    const r = rig([readTool({ run: never })], { timeoutMs: 50 });
    const controller = new AbortController();
    const pending = call(r, "repo_read", { project: "alpha", path: "x" }, controller.signal);
    controller.abort();
    expect((await pending).outcome).toBe("stopped");
    const timed = await call(r, "repo_read", { project: "alpha", path: "x" });
    expect(timed.outcome).toBe("error");
    expect(timed.text).toContain("did not finish");
  });
  test("output is bounded", async () => {
    const r = rig([readTool({ run: () => Promise.resolve("y".repeat(500)) })], { outputLimit: 100 });
    expect((await call(r, "repo_read", { project: "alpha", path: "x" })).text).toContain("[truncated 400 characters]");
  });
});

describe("turn authority and safe failure", () => {
  test("principal, transport, policy and registry changes invalidate an existing surface", async () => {
    for (const change of [
      (r: Rig) => { r.state.principal = "other"; },
      (r: Rig) => { r.state.transport = "discord"; },
      (r: Rig) => { r.state.policy = "local"; },
      (r: Rig) => { r.state.tools.projects[0]!.root = "/tmp/replaced"; },
    ]) {
      let ran = 0;
      const r = rig([readTool({ run: () => { ran++; return Promise.resolve("x"); } })]);
      const surface = r.host.surface("c", "cloud", activity => { r.seen.push(activity); return Promise.resolve(); });
      await surface.validate();
      change(r);
      await expect(surface.validate()).rejects.toThrow("changed");
      expect((await surface.call("stale", "repo_read", { project: "alpha", path: "x" }, new AbortController().signal)).outcome).toBe("refused");
      expect(ran).toBe(0);
    }
  });

  test("a cloud-allowed source works on a local model without changing its policy", async () => {
    const r = rig();
    r.state.route = "local";
    const result = await call(r, "repo_read", { project: "alpha", path: "x" });
    expect(result.outcome).toBe("done");
    expect(result.source?.policy).toBe("cloud");
  });

  test("pre-cancelled calls never run; provider checks also honor the timeout", async () => {
    let ran = 0;
    const r = rig([readTool({ run: () => { ran++; return Promise.resolve("x"); } })]);
    const controller = new AbortController();
    controller.abort();
    expect((await call(r, "repo_read", { project: "alpha", path: "x" }, controller.signal)).outcome).toBe("stopped");
    expect(ran).toBe(0);
    const down = rig([readTool({ provider: () => new Promise(() => undefined) })], { timeoutMs: 20 });
    expect((await call(down, "repo_read", { project: "alpha", path: "x" })).text).toContain("did not finish");
  });

  test("a failing provider never exposes its credential-bearing exception", async () => {
    const r = rig([readTool({ run: () => Promise.reject(new Error("password=synthetic-private-secret")) })]);
    const result = await call(r, "repo_read", { project: "alpha", path: "x" });
    expect(result.outcome).toBe("error");
    expect(result.text).not.toContain("synthetic-private-secret");
    expect(r.seen[0]?.result).toContain("configured source connection");
  });

  test("revocation while durable activity is recorded withholds the result", async () => {
    const r = rig();
    const surface = r.host.surface("c", "cloud", activity => {
      r.seen.push(activity);
      r.state.scope = [];
      return Promise.resolve();
    });
    const result = await surface.call("release", "repo_read", { project: "alpha", path: "x" }, new AbortController().signal);
    expect(result.outcome).toBe("refused");
    expect(result.text).toContain("withheld");
    expect(r.seen.at(-1)?.outcome).toBe("refused");
  });

  test("duplicate and source-free extension tools are refused at registration", () => {
    expect(() => rig([readTool(), readTool()])).toThrow("unique catalog");
    expect(() => rig([readTool({ name: "capabilities" })])).toThrow("unique catalog");
    expect(() => rig([readTool({ operation: null })])).toThrow("permitted operation");
  });

  test("large explicit registries are discoverable through bounded pages", async () => {
    const r = rig();
    r.state.tools.projects = Array.from({ length: 25 }, (_, i) => ({ ...config().projects[0]!, id: `project-${i}` }));
    r.state.scope = r.state.tools.projects.map(p => p.id);
    const first = await call(r, "capabilities", { limit: 10 });
    const second = await call(r, "capabilities", { offset: 10, limit: 10 });
    const last = await call(r, "capabilities", { offset: 20, limit: 10 });
    expect(first.text).toContain('"next":10');
    expect(second.text).toContain('"next":20');
    expect(last.text).toContain('"next":null');
    expect(last.text).toContain('"project":"project-24"');
  });
});
