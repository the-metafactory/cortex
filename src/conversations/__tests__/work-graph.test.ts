import { describe, expect, test } from "bun:test";
import { DeskConversationsSchema, type ToolsConfig } from "../../common/types/desk-conversations";
import type { CommandResult } from "../../surface/mc/desk/spawn";
import type { ModelRoute, Policy } from "../types";
import type { ToolSession } from "../tools/capabilities";
import { createWorkGraphTools, type WorkGraphRunner } from "../tools/work-graph";
import { toolBody, toolRig } from "./fixtures/tool-host";

const DESK = "github:github.com/example/desk";
const OTHER = "github:github.com/example/other";
const GITLAB = "gitlab:gitlab.example.org/group/project";

const ok = (value: unknown): CommandResult => ({ code: 0, signal: null, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const fail = (stderr: string): CommandResult => ({ code: 1, signal: null, stdout: "", stderr });

const graphConfig = (): ToolsConfig => ({
  projects: [
    { id: "project-alpha", root: "/tmp/alpha", policy: "cloud", operations: ["repo.read"] },
  ],
  graphs: [{
    id: "maps",
    policy: "cloud",
    maps: [
      { id: "desk", ref: `${DESK}#1`, label: "Desk" },
      { id: "other", ref: `${OTHER}#2`, label: "Other" },
    ],
    read: { repos: [DESK, OTHER], namespaces: [] },
  }, {
    id: "secret-maps",
    policy: "local",
    maps: [{ id: "private", ref: `${GITLAB}#3` }],
    read: { repos: [], namespaces: ["gitlab:gitlab.example.org/group"] },
  }],
});

const nodeState = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ref: { id: "42" },
  node: { id: "42", title: "A node", kind: "build", autonomy: "auto", checkpointId: "checkpoint" },
  status: "open",
  updatedAt: "2026-11-09T10:00:00Z",
  assignees: [],
  blockedBy: [],
  author: "jcfischer",
  url: "https://github.com/example/desk/issues/42",
  typed: true,
  ...overrides,
});

type Answer = CommandResult | ((argv: string[]) => CommandResult);
interface Rig {
  call: (name: string, input: unknown) => Promise<{ outcome: string; text: string }>;
  argvs: string[][];
  state: { route: ModelRoute; policy: Policy; scope: string[]; tools: ToolsConfig; live: boolean };
}
function rig(routes: Record<string, Answer> = {}, config = graphConfig(), scope = ["maps", "secret-maps", "project-alpha"], route: ModelRoute = "cloud", policy: Policy = "cloud"): Rig {
  const state = { route, policy, scope, tools: config, live: true };
  const argvs: string[][] = [];
  const run: WorkGraphRunner = (argv) => {
    argvs.push(argv);
    const answer = routes[argv[2] ?? ""];
    if (!answer) return Promise.resolve(fail(`soma: no route for ${argv[2] ?? "?"}`));
    return Promise.resolve(typeof answer === "function" ? answer(argv) : answer);
  };
  const session = (): Promise<ToolSession | null> => Promise.resolve(state.live ? { principal: "p", conversationId: "c", transport: "web", route: state.route, policy: state.policy, scope: state.scope } : null);
  const { call } = toolRig({ route, config: () => state.tools, session, tools: createWorkGraphTools({ run, now: () => new Date("2026-11-09T12:00:00Z") }) });
  return { call, argvs, state };
}

describe("work graph tool configuration", () => {
  test("a configured graph requires qualified roots and an explicit read scope that permits them", () => {
    const parsed = DeskConversationsSchema.parse({ tools: { graphs: [{
      id: "maps",
      maps: [{ id: "desk", ref: `${DESK}#1`, label: "Desk" }],
      read: { repos: [DESK], namespaces: ["gitlab:gitlab.example.org/group"] },
    }] } });
    expect(parsed.tools?.graphs?.[0]).toMatchObject({ policy: "local", maps: [{ id: "desk", ref: `${DESK}#1` }], read: { repos: [DESK], namespaces: ["gitlab:gitlab.example.org/group"] } });
    expect(() => DeskConversationsSchema.parse({ tools: { graphs: [{ id: "maps", maps: [{ id: "desk", ref: "desk#1" }], read: { repos: [DESK] } }] } })).toThrow();
    expect(() => DeskConversationsSchema.parse({ tools: { graphs: [{ id: "maps", maps: [{ id: "desk", ref: `${DESK}#1` }], read: {} }] } })).toThrow();
    expect(() => DeskConversationsSchema.parse({ tools: { graphs: [{ id: "maps", maps: [{ id: "desk", ref: `${DESK}#1` }], read: { repos: [OTHER] } }] } })).toThrow();
    expect(() => DeskConversationsSchema.parse({ tools: { graphs: [{ id: "maps", maps: [{ id: "desk", ref: `${DESK}#1` }], read: { namespaces: ["github:github.com/example"] } }] } })).toThrow();
    expect(() => DeskConversationsSchema.parse({ tools: { projects: [{ id: "maps", root: "/tmp/x" }], graphs: [{ id: "maps", maps: [{ id: "desk", ref: `${DESK}#1` }], read: { repos: [DESK] } }] } })).toThrow();
  });
});

describe("work graph reads through the conversation boundary", () => {
  test("the permitted map inventory keeps configured identities and fixed read argv", async () => {
    const r = rig({
      maps: ok({ maps: [
        { ref: `${DESK}#1`, state: nodeState({ ref: { id: "1" }, node: { id: "1", title: "Desk root", autonomy: "approve", checkpointId: "desk" }, url: "https://github.com/example/desk/issues/1" }) },
        { ref: `${OTHER}#2`, unavailable: true },
      ] }),
    });
    const result = await r.call("work_graph_maps", { graph: "maps" });
    expect(result.outcome).toBe("done");
    const output = toolBody(result.text);
    expect(output).toMatchObject({ status: "ok", snapshot: "live", unavailable: 1 });
    const maps = output.maps as Record<string, unknown>[];
    expect(maps[0]).toMatchObject({ id: "desk", ref: `${DESK}#1`, label: "Desk", status: "available", map: { ref: `${DESK}#1`, state: "open", typed: true, receiptBacked: false } });
    expect(maps[1]).toMatchObject({ id: "other", status: "unavailable" });
    expect(maps[1]).not.toHaveProperty("map");
    expect(r.argvs).toEqual([["soma", "graph", "maps", "--root", `${DESK}#1`, "--root", `${OTHER}#2`, "--read-repo", DESK, "--read-repo", OTHER, "--json"]]);
  });

  test("a closed node reports a receipt-backed close, assignees and its source link", async () => {
    const r = rig({
      node: ok({
        repo: DESK,
        ...nodeState({
          status: "closed", assignees: ["ivy-agent"], currentCloseReceipt: true,
          node: { id: "42", title: "Closed node", kind: "build", autonomy: "auto", checkpointId: "checkpoint", completion: { closer: "ivy-agent" } },
        }),
      }),
    });
    const output = toolBody((await r.call("work_graph_node", { graph: "maps", map: "desk", node: "#42" })).text);
    expect(output).toMatchObject({ status: "ok", repo: DESK, snapshot: "live", node: { ref: `${DESK}#42`, state: "closed", receiptBacked: true, receiptMissing: false, assigned: true, assignees: ["ivy-agent"], url: "https://github.com/example/desk/issues/42", checkpoint: "checkpoint" } });
    expect(r.argvs[0]).toEqual(["soma", "graph", "node", `${DESK}#42`, "--read-repo", DESK, "--read-repo", OTHER, "--json"]);
  });

  test("a denied cross-repo dependency is neutral, unavailable and still blocking", async () => {
    const r = rig({
      node: ok({
        repo: DESK,
        ...nodeState({ blockedBy: [{ id: "example/secret#7", status: "unavailable" }, { id: "example/other#8", status: "closed" }, { id: "example/secret#9", status: "closed", abandoned: true }] }),
      }),
    });
    const output = toolBody((await r.call("work_graph_node", { graph: "maps", map: "desk", node: "42" })).text);
    expect(output).toMatchObject({ status: "ok", node: { state: "open", blocked: true } });
    const blockers = (output.node as { blockedBy: Record<string, unknown>[] }).blockedBy;
    expect(blockers[0]).toEqual({ ref: "github:github.com/example/secret#7", unavailable: true, cleared: false, message: "This dependency is outside the permitted read scope; its state is unavailable and it remains blocking." });
    expect(blockers[0]).not.toHaveProperty("state");
    expect(blockers[1]).toMatchObject({ ref: "github:github.com/example/other#8", state: "closed", cleared: true });
    expect(blockers[2]).toEqual({ ref: "github:github.com/example/secret#9", unavailable: true, cleared: false, message: "This dependency is outside the permitted read scope; its state is unavailable and it remains blocking." });
    expect(blockers[2]).not.toHaveProperty("state");
    expect(r.argvs).toHaveLength(1);
  });

  test("the frontier is paginated with source-qualified nodes and omitted membership", async () => {
    const r = rig({
      frontier: ok({
        repo: DESK, root: "1",
        frontier: [nodeState({ ref: { id: "11" } }), nodeState({ ref: { id: "12" } }), nodeState({ ref: { id: "13" } })],
        notWritable: [nodeState({ ref: { id: "14" }, writable: false })],
        unavailableMembership: [{ source: { id: "11" }, target: { id: "example/secret#9" } }],
      }),
    });
    const output = toolBody((await r.call("work_graph_frontier", { graph: "maps", map: "desk", offset: 1, limit: 1 })).text);
    expect(output).toMatchObject({ status: "ok", repo: DESK, total: 3, offset: 1, next: 2, map: { id: "desk", ref: `${DESK}#1`, label: "Desk" } });
    expect((output.nodes as { ref: string }[]).map(node => node.ref)).toEqual([`${DESK}#12`]);
    expect(output.notWritable).toMatchObject({ items: [{ ref: `${DESK}#14` }], omitted: 0 });
    expect(output.unavailableMembership).toEqual({ items: [{ source: `${DESK}#11`, target: "github:github.com/example/secret#9", unavailable: true }], omitted: 0 });
    expect(r.argvs[0]).toEqual(["soma", "graph", "frontier", `${DESK}#1`, "--read-repo", DESK, "--read-repo", OTHER, "--json"]);
  });

  test("a scoped audit names unchecked findings and never writes", async () => {
    const r = rig({
      audit: ok({ repo: DESK, root: "1", nodes: 3, buildBriefNotReady: [{ id: "42", missing: ["## Deliverable"] }] }),
    });
    const output = toolBody((await r.call("work_graph_audit", { graph: "maps", map: "desk", scope: "build-brief-not-ready" })).text);
    expect(output).toMatchObject({ status: "ok", scope: "build-brief-not-ready", uncheckedFindings: true, nodes: 3 });
    expect(output.findings).toMatchObject({ buildBriefNotReady: { items: [{ ref: `${DESK}#42`, missing: ["## Deliverable"] }], omitted: 0 }, closedWithoutReceipt: { items: [], omitted: 0 } });
    expect(r.argvs[0]).toContain("--scope");
    expect(r.argvs[0]).not.toContain("--write");
  });

  test("audit finding lists qualify both id objects and bare ids", async () => {
    const r = rig({
      audit: ok({ repo: DESK, root: "1", nodes: 4, closedWithoutReceipt: [{ id: "42" }, "43", { ref: "example/other#44" }], openClaimed: ["45"] }),
    });
    const output = toolBody((await r.call("work_graph_audit", { graph: "maps", map: "desk" })).text);
    expect(output.findings).toMatchObject({
      closedWithoutReceipt: { items: [`${DESK}#42`, `${DESK}#43`, "github:github.com/example/other#44"], omitted: 0 },
      openClaimed: { items: [{ ref: `${DESK}#45`, assignees: [] }], omitted: 0 },
    });
  });

  test("the decisions read is labelled historical and receipt-derived", async () => {
    const r = rig({
      decisions: ok({ repo: DESK, root: "1", decisions: [
        { id: "7", title: "One", url: "https://github.com/example/desk/issues/7", hasReceipt: true, abandoned: false, gist: "Decided one" },
        { id: "8", title: "Two", url: "https://github.com/example/desk/issues/8", hasReceipt: true, abandoned: true, gist: null },
      ] }),
    });
    const output = toolBody((await r.call("work_graph_decisions", { graph: "maps", map: "desk", limit: 1 })).text);
    expect(output).toMatchObject({ status: "ok", historical: true, derivedFrom: "close-receipts", total: 2, offset: 0, next: 1 });
    expect((output.decisions as Record<string, unknown>[])[0]).toEqual({ ref: `${DESK}#7`, title: "One", url: "https://github.com/example/desk/issues/7", receiptBacked: true, abandoned: false, gist: "Decided one" });
    expect(r.argvs[0]).toEqual(["soma", "graph", "decisions", `${DESK}#1`, "--read-repo", DESK, "--read-repo", OTHER, "--json"]);
  });
});

describe("work graph authorization and owner output", () => {
  test("a missing source scope is refused before any owner call", async () => {
    const noScope = rig({ maps: ok({ maps: [] }) }, graphConfig(), ["project-alpha"]);
    expect((await noScope.call("work_graph_maps", { graph: "maps" })).outcome).toBe("refused");
    expect(noScope.argvs).toHaveLength(0);
    const projectSource = rig({ maps: ok({ maps: [] }) });
    expect((await projectSource.call("work_graph_maps", { graph: "project-alpha" })).outcome).toBe("refused");
    const unknown = rig({ maps: ok({ maps: [] }) });
    expect((await unknown.call("work_graph_maps", { graph: "nope" })).outcome).toBe("refused");
    const missingMap = rig({ node: ok({ repo: DESK, ...nodeState() }) });
    expect((await missingMap.call("work_graph_node", { graph: "maps", map: "nope", node: "42" })).text).toContain("No configured map has that id.");
    const bareWithoutMap = rig({ node: ok({ repo: DESK, ...nodeState() }) });
    expect((await bareWithoutMap.call("work_graph_node", { graph: "maps", node: "42" })).outcome).toBe("refused");
    const outside = rig({ node: ok({ repo: DESK, ...nodeState() }) });
    const denied = toolBody((await outside.call("work_graph_node", { graph: "maps", node: "github:github.com/example/secret#5" })).text);
    expect(denied).toMatchObject({ status: "invalid-source" });
    expect([noScope, projectSource, unknown, missingMap, bareWithoutMap, outside].every(r => r.argvs.length === 0)).toBe(true);
  });

  test("a local-only graph is refused on a cloud lane without running the owner", async () => {
    const r = rig({ maps: ok({ maps: [] }) }, graphConfig(), ["maps", "secret-maps"]);
    const refused = await r.call("work_graph_maps", { graph: "secret-maps" });
    expect(refused.outcome).toBe("refused");
    expect(r.argvs).toHaveLength(0);
    const local = rig({ maps: ok({ maps: [{ ref: `${GITLAB}#3`, state: nodeState({ ref: { id: "3" }, node: { id: "3", title: "Private map" } }) }] }) }, graphConfig(), ["maps", "secret-maps"], "local", "local");
    expect((await local.call("work_graph_maps", { graph: "secret-maps" })).outcome).toBe("done");
    expect(local.argvs[0]).toEqual(["soma", "graph", "maps", "--root", `${GITLAB}#3`, "--read-namespace", "gitlab:gitlab.example.org/group", "--json"]);
  });

  test("malformed, mismatched and truncated owner output releases nothing", async () => {
    const malformed = rig({ frontier: ok("not json") });
    expect(toolBody((await malformed.call("work_graph_frontier", { graph: "maps", map: "desk" })).text)).toMatchObject({ status: "unreadable" });
    const missingLists = rig({ frontier: ok({ repo: DESK, root: "1" }) });
    expect(toolBody((await missingLists.call("work_graph_frontier", { graph: "maps", map: "desk" })).text)).toMatchObject({ status: "unreadable" });
    const wrongRepo = rig({ node: ok({ repo: OTHER, ...nodeState() }) });
    expect(toolBody((await wrongRepo.call("work_graph_node", { graph: "maps", map: "desk", node: "42" })).text)).toMatchObject({ status: "identity-mismatch" });
    const wrongNode = rig({ node: ok({ repo: DESK, ...nodeState({ ref: { id: "43" } }) }) });
    expect(toolBody((await wrongNode.call("work_graph_node", { graph: "maps", map: "desk", node: "42" })).text)).toMatchObject({ status: "identity-mismatch" });
    const denied = rig({ node: fail("Graph read unavailable in the permitted scope") });
    expect(toolBody((await denied.call("work_graph_node", { graph: "maps", map: "desk", node: "42" })).text)).toMatchObject({ status: "denied" });
  });

  test("changing the graph source during a call withholds the result", async () => {
    const r = rig({
      maps: () => {
        r.state.tools = { projects: [] };
        return ok({ maps: [{ ref: `${DESK}#1`, state: nodeState({ ref: { id: "1" }, node: { id: "1", title: "SECRET_MAP_TITLE" } }) }] });
      },
    });
    const result = await r.call("work_graph_maps", { graph: "maps" });
    expect(result.outcome).toBe("refused");
    expect(result.text).toContain("withheld");
    expect(result.text).not.toContain("SECRET_MAP_TITLE");
  });

  test("capabilities lists the graph as its own source kind", async () => {
    const r = rig({});
    const output = toolBody((await r.call("capabilities", {})).text);
    const sources = output.sources as { source: string; project: string; kind: string; tools: { tool: string; availability: string }[] }[];
    expect(sources.find(source => source.source === "maps")).toMatchObject({ project: "maps", kind: "graph" });
    expect(sources.find(source => source.source === "project-alpha")).toMatchObject({ kind: "project" });
    expect(sources.find(source => source.source === "project-alpha")?.tools).toEqual([]);
    expect(sources.find(source => source.source === "maps")?.tools.map(tool => tool.tool).sort()).toEqual(["work_graph_audit", "work_graph_decisions", "work_graph_frontier", "work_graph_maps", "work_graph_node"]);
    const filtered = toolBody((await r.call("capabilities", { source: "maps" })).text);
    expect((filtered.sources as { source: string }[]).map(source => source.source)).toEqual(["maps"]);
  });
});
