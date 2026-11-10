import { afterEach, describe, expect, test } from "bun:test";
import { CORTEX, CORTEX_MAP, CORTEX_NODE, CRISIS, CRISIS_NODE, UNTICKED, trackGraphRigs, type GraphReadRig } from "../../domain-adapters/__tests__/fixtures/graph-read-fixtures";
import type { GraphConversationLink } from "../../domain-adapters/work-graph/read";
import { graphWorkQuery, graphWorkReaders, type GraphWorkRepository } from "../../../surface/mc/desk/graph-work-reader";
import type { ToolSession } from "../capabilities";
import { workContextTools, type WorkObject, type WorkOwner } from "../work-context";

const rigs = trackGraphRigs();
const open = rigs.open;
afterEach(rigs.closeAll);

interface CallOptions {
  readonly links?: readonly GraphConversationLink[];
  readonly repositories?: readonly GraphWorkRepository[];
  readonly sessionPolicy?: "local" | "cloud";
  readonly enabled?: boolean;
}
const LINKS: readonly GraphConversationLink[] = [{ owner: "graph-map", id: CORTEX_MAP }, { owner: "graph-node", id: CORTEX_NODE }, { owner: "graph-node", id: `${UNTICKED}#7` }];
const TICKED: readonly GraphWorkRepository[] = [{ id: CORTEX, policy: "cloud" }, { id: CRISIS, policy: "cloud" }];

async function call(rig: GraphReadRig, name: "work_search" | "work_read", input: object, options: CallOptions = {}) {
  const { links = LINKS, repositories = TICKED, sessionPolicy = "cloud", enabled = true } = options;
  const remembered: WorkObject[] = [];
  const query = graphWorkQuery({ connectionId: rig.connectionId, repositories: () => repositories, links: () => links, runner: rig.runner, context: rig.rig.context, sink: rig.rig.sink });
  const owner: WorkOwner = {
    readers: () => ({}),
    ...(enabled ? { queries: () => graphWorkReaders(query) } : {}),
    now: () => Date.now(),
    remember: async (_session, objects) => { remembered.push(...objects); return true; },
  };
  const session: ToolSession = { principal: "principal-example", conversationId: rig.rig.approval.snapshot.provenance.conversationId, transport: "web", route: "local", policy: sessionPolicy, scope: [] };
  const tool = workContextTools(owner).find(candidate => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  const text = await tool.run(input, { project: null, graph: null, projects: [], session, signal: new AbortController().signal });
  return { json: JSON.parse(typeof text === "string" ? text : text.text) as Record<string, any>, remembered };
}

describe("the work-graph adapter behind work_search and work_read", () => {
  test("a linked node is read through soma and records a source obligation", async () => {
    const rig = await open();
    const { json, remembered } = await call(rig, "work_read", { kind: "graph-node", id: CORTEX_NODE });
    expect(json).toMatchObject({ object: { kind: "graph-node", id: CORTEX_NODE, title: "Read graph destinations and nodes", status: "open", url: "https://github.com/the-metafactory/cortex/issues/3348" } });
    expect(remembered.map(object => `${object.kind}:${object.id}:${object.policy}`)).toEqual([`graph-node:${CORTEX_NODE}:cloud`]);
    expect(rig.calls.argv.every(argv => argv.includes("--read-repo"))).toBe(true);
  });

  test("an exactly referenced node outside the links reads inside a ticked repository", async () => {
    const rig = await open();
    const { json, remembered } = await call(rig, "work_read", { kind: "graph-node", id: `${CORTEX}#3350` }, { links: [] });
    expect(json.object).toMatchObject({ title: "Publish graph repository ticks", status: "closed" });
    expect(remembered).toHaveLength(1);
  });

  test("search covers only linked nodes and reports the coverage limit", async () => {
    const rig = await open();
    const { json, remembered } = await call(rig, "work_search", { query: "", kinds: ["graph-node"], limit: 5, offset: 0 });
    expect(json.status).toBe("ok");
    expect(json.results.map((result: { id: string }) => result.id).sort()).toEqual([CORTEX_MAP, CORTEX_NODE].sort());
    expect(json.coverageLimits).toEqual([{ kind: "graph-node", note: expect.stringContaining("linked to this conversation") }]);
    expect(json.next).toBeNull();
    expect(remembered).toHaveLength(2);
    const filtered = await call(rig, "work_search", { query: "destinations", kinds: ["graph-node"], limit: 5, offset: 0 });
    expect(filtered.json.results.map((result: { id: string }) => result.id)).toEqual([CORTEX_NODE]);
    const none = await call(rig, "work_search", { query: "nothing-like-this", kinds: ["graph-node"], limit: 5, offset: 0 });
    expect(none.json.status).toBe("empty");
    expect(none.json.coverageLimits).toHaveLength(1);
  });

  test("an unticked repository returns nothing and releases no name or count", async () => {
    const rig = await open();
    const read = await call(rig, "work_read", { kind: "graph-node", id: `${UNTICKED}#7` });
    expect(read.json.status).toBe("unauthorized");
    expect(read.json).not.toHaveProperty("object");
    expect(read.remembered).toEqual([]);
    const search = await call(rig, "work_search", { query: "", kinds: ["graph-node"], limit: 5, offset: 0 }, { links: [{ owner: "graph-node", id: `${UNTICKED}#7` }] });
    expect(search.json.results).toEqual([]);
    expect(search.json.status).toBe("empty");
    expect(JSON.stringify(search.json)).not.toContain("metafactory/other");
    await rig.untick(CORTEX);
    const withdrawn = await call(rig, "work_read", { kind: "graph-node", id: CORTEX_NODE });
    expect(withdrawn.json.status).toBe("unauthorized");
    expect(withdrawn.json).not.toHaveProperty("object");
  });

  test("a local-only repository is not released to a cloud conversation", async () => {
    const rig = await open();
    const local: GraphWorkRepository[] = [{ id: CORTEX, policy: "local" }];
    const read = await call(rig, "work_read", { kind: "graph-node", id: CORTEX_NODE }, { repositories: local, sessionPolicy: "cloud" });
    expect(read.json.status).toBe("unauthorized");
    expect(read.json).not.toHaveProperty("object");
    expect(read.remembered).toEqual([]);
    const search = await call(rig, "work_search", { query: "", kinds: ["graph-node"], limit: 5, offset: 0 }, { repositories: local, sessionPolicy: "cloud" });
    expect(search.json.results).toEqual([]);
    const allowed = await call(rig, "work_read", { kind: "graph-node", id: CORTEX_NODE }, { repositories: local, sessionPolicy: "local" });
    expect(allowed.json.object.id).toBe(CORTEX_NODE);
  });

  test("a failing soma reads as unavailable, not as no match or removal", async () => {
    const rig = await open();
    const link: GraphConversationLink[] = [{ owner: "graph-node", id: `${CORTEX}#9998` }];
    const search = await call(rig, "work_search", { query: "", kinds: ["graph-node"], limit: 5, offset: 0 }, { links: link });
    expect(search.json.status).toBe("unavailable");
    expect(search.json.results).toEqual([]);
    expect(search.json.unavailable).toHaveLength(1);
    const read = await call(rig, "work_read", { kind: "graph-node", id: `${CORTEX}#9998` });
    expect(read.json.status).toBe("unavailable");
    expect(read.json.message).toContain("not a confirmed absence");
    expect(read.remembered).toEqual([]);
  });

  test("a bare number cannot name a repository and is unavailable", async () => {
    const rig = await open();
    const read = await call(rig, "work_read", { kind: "graph-node", id: "3348" });
    expect(read.json.status).toBe("unavailable");
    expect(rig.calls.argv).toHaveLength(0);
  });

  test("a GitLab node is read as written", async () => {
    const rig = await open();
    const read = await call(rig, "work_read", { kind: "graph-node", id: CRISIS_NODE });
    expect(read.json.object).toMatchObject({ id: CRISIS_NODE, title: "Crisis simulator short", area: CRISIS.replace(/^gitlab:/, "gitlab:") });
  });

  test("without the adapter enabled the kind is unavailable", async () => {
    const rig = await open();
    const read = await call(rig, "work_read", { kind: "graph-node", id: CORTEX_NODE }, { enabled: false });
    expect(read.json.status).toBe("unavailable");
    expect(rig.calls.argv).toHaveLength(0);
  });
});
