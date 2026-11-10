import { strict as assert } from "node:assert";
import { CORTEX, CORTEX_MAP, CORTEX_NODE, UNTICKED, openGraphReadRig } from "../src/conversations/domain-adapters/__tests__/fixtures/graph-read-fixtures";
import type { GraphConversationLink } from "../src/conversations/domain-adapters/work-graph/read";
import { graphWorkQuery, graphWorkReaders, type GraphWorkRepository } from "../src/surface/mc/desk/graph-work-reader";
import { workContextTools, type WorkOwner } from "../src/conversations/tools/work-context";
import { withTempHome } from "./probe-temp-home";

await withTempHome(async () => {
  const rig = await openGraphReadRig();
  try {
    const remembered: string[] = [];
    const run = async (name: "work_search" | "work_read", input: object, links: GraphConversationLink[], repositories: GraphWorkRepository[], policy: "local" | "cloud"): Promise<Record<string, any>> => {
      const query = graphWorkQuery({ connectionId: rig.connectionId, repositories: () => repositories, links: () => links, runner: rig.runner, context: rig.rig.context, sink: rig.rig.sink });
      const owner: WorkOwner = { readers: () => ({}), queries: () => graphWorkReaders(query), now: () => Date.now(), remember: async (_session, objects) => { remembered.push(...objects.map(object => `${object.kind}:${object.id}`)); return true; } };
      const tool = workContextTools(owner).find(candidate => candidate.name === name);
      if (!tool) throw new Error(`missing tool ${name}`);
      const session = { principal: "principal-example", conversationId: rig.rig.approval.snapshot.provenance.conversationId, transport: "web" as const, route: "local" as const, policy, scope: [] };
      const text = await tool.run(input, { project: null, graph: null, projects: [], session, signal: new AbortController().signal });
      return JSON.parse(typeof text === "string" ? text : text.text);
    };
    const links: GraphConversationLink[] = [{ owner: "graph-map", id: CORTEX_MAP }, { owner: "graph-node", id: CORTEX_NODE }];
    const ticked: GraphWorkRepository[] = [{ id: CORTEX, policy: "cloud" }];

    const linked = await run("work_search", { query: "", kinds: ["graph-node"], limit: 5, offset: 0 }, links, ticked, "cloud");
    assert.equal(linked.status, "ok");
    assert.equal(linked.results.length, 2);
    assert.equal(linked.coverageLimits[0]?.kind, "graph-node");
    assert.deepEqual([...remembered].sort(), [`graph-node:${CORTEX_MAP}`, `graph-node:${CORTEX_NODE}`].sort());
    console.log("linked: search reads the linked map and node, records source obligations and reports the linked-only coverage limit");

    const exact = await run("work_read", { kind: "graph-node", id: `${CORTEX}#3350` }, [], ticked, "cloud");
    assert.equal(exact.object?.status, "closed");
    console.log("exact: a node outside the links reads inside a ticked repository");

    const denied = await run("work_read", { kind: "graph-node", id: `${UNTICKED}#7` }, links, ticked, "cloud");
    assert.equal(denied.status, "unauthorized");
    assert.ok(!("object" in denied));
    console.log("unticked: nothing returned and no node content released");

    const localOnly = await run("work_read", { kind: "graph-node", id: CORTEX_NODE }, links, [{ id: CORTEX, policy: "local" }], "cloud");
    assert.equal(localOnly.status, "unauthorized");
    console.log("local-only: local-policy graph content is not released to a cloud conversation");

    const failing = await run("work_read", { kind: "graph-node", id: `${CORTEX}#9998` }, links, ticked, "cloud");
    assert.equal(failing.status, "unavailable");
    console.log("failing soma: reported unavailable, not no match");
  } finally {
    await rig.close();
  }
});
