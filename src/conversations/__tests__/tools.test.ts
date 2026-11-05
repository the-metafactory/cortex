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

interface Rig { host: ToolHost; state: { route: ModelRoute; policy: Policy; scope: string[]; tools: ToolsConfig; live: boolean }; seen: ToolActivity[] }
function rig(definitions: ToolDefinition[] = [readTool()], extra: { timeoutMs?: number; outputLimit?: number } = {}): Rig {
  const state = { route: "cloud" as ModelRoute, policy: "cloud" as Policy, scope: ["alpha", "secret", "bare"], tools: config(), live: true };
  const session = (): Promise<ToolSession | null> => Promise.resolve(state.live ? { principal: "p", conversationId: "c", transport: "web", route: state.route, policy: state.policy, scope: state.scope } : null);
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
    expect(out.text).toContain("\"withheld\":2");
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
    expect(hidden.replace("secret", "X")).toBe(unknown.replace("nope", "X"));
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
    expect(r.seen[0]).toMatchObject({ tool: "repo_read", outcome: "done", args: { source: "alpha" } });
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
    expect((await call(r, "repo_read", { project: "secret", path: "x" })).text).toContain("local-only first");
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
