import { strict as assert } from "node:assert";
import { CORTEX, CORTEX_MAP, CORTEX_NODE, UNTICKED, openGraphReadRig } from "../src/conversations/domain-adapters/__tests__/fixtures/graph-read-fixtures";
import type { GraphConversationLink } from "../src/conversations/domain-adapters/work-graph/read";
import type { GraphWorkRepository } from "../src/surface/mc/desk/graph-work-reader";
import { callGraphWorkTool } from "../src/conversations/domain-adapters/__tests__/fixtures/graph-work-tools-fixtures";
import { withTempHome } from "./probe-temp-home";

await withTempHome(async () => {
  const rig = await openGraphReadRig();
  try {
    const links: GraphConversationLink[] = [{ owner: "graph-map", id: CORTEX_MAP }, { owner: "graph-node", id: CORTEX_NODE }];
    const ticked: GraphWorkRepository[] = [{ id: CORTEX, policy: "cloud" }];

    const { json: linked, remembered } = await callGraphWorkTool(rig, "work_search", { query: "", kinds: ["graph-node"], limit: 5, offset: 0 }, { links, repositories: ticked, sessionPolicy: "cloud" });
    assert.equal(linked.status, "ok");
    assert.equal(linked.results.length, 2);
    assert.equal(linked.coverageLimits[0]?.kind, "graph-node");
    assert.deepEqual(remembered.map(object => `${object.kind}:${object.id}`).sort(), [`graph-node:${CORTEX_MAP}`, `graph-node:${CORTEX_NODE}`].sort());
    console.log("linked: search reads the linked map and node, records source obligations and reports the linked-only coverage limit");

    const { json: exact } = await callGraphWorkTool(rig, "work_read", { kind: "graph-node", id: `${CORTEX}#3350` }, { links: [], repositories: ticked, sessionPolicy: "cloud" });
    assert.equal(exact.object?.status, "closed");
    console.log("exact: a node outside the links reads inside a ticked repository");

    const { json: denied } = await callGraphWorkTool(rig, "work_read", { kind: "graph-node", id: `${UNTICKED}#7` }, { links, repositories: ticked, sessionPolicy: "cloud" });
    assert.equal(denied.status, "unauthorized");
    assert.ok(!("object" in denied));
    console.log("unticked: nothing returned and no node content released");

    const { json: localOnly } = await callGraphWorkTool(rig, "work_read", { kind: "graph-node", id: CORTEX_NODE }, { links, repositories: [{ id: CORTEX, policy: "local" }], sessionPolicy: "cloud" });
    assert.equal(localOnly.status, "unauthorized");
    console.log("local-only: local-policy graph content is not released to a cloud conversation");

    const { json: failing } = await callGraphWorkTool(rig, "work_read", { kind: "graph-node", id: `${CORTEX}#9998` }, { links, repositories: ticked, sessionPolicy: "cloud" });
    assert.equal(failing.status, "unavailable");
    console.log("failing soma: reported unavailable, not no match");
  } finally {
    await rig.close();
  }
});
