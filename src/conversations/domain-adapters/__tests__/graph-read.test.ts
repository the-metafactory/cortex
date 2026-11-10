import { afterEach, describe, expect, test } from "bun:test";
import { readPointer } from "../reads/query-validation";
import type { Json } from "../operations/types";
import { canonicalGraphRef, createWorkGraphReadAdapter } from "../work-graph/read";
import { CLOSED_NODE, CORTEX, CORTEX_MAP, CORTEX_NODE, CRISIS, CRISIS_NODE, MISSING_NODE, UNTICKED, graphRef, trackGraphRigs, releasedObjects, type GraphReadRig } from "./fixtures/graph-read-fixtures";

const rigs = trackGraphRigs();
const open = rigs.open;
afterEach(rigs.closeAll);

describe("the inactive work-graph read adapter", () => {
  test("destinations list the exact ticked refs and the conversation's linked maps and nodes", async () => {
    const rig = await open();
    const page = await rig.destinations();
    const payload = page.payload as { items: { title: string }[] };
    expect(page.annotations.map(annotation => [annotation.ref.objectType, annotation.ref.canonicalId])).toEqual([
      ["repository", CORTEX],
      ["repository", CRISIS],
      ["map", CORTEX_MAP],
      ["node", CORTEX_NODE],
      ["node", CRISIS_NODE],
    ]);
    expect(payload.items.map(item => item.title)).toEqual([canonicalGraphRef(CORTEX), canonicalGraphRef(CRISIS), CORTEX_MAP, CORTEX_NODE, CRISIS_NODE]);
    expect(page.annotations.map(annotation => [annotation.ref.objectType, annotation.destination.canonicalId])).toEqual([
      ["repository", CORTEX],
      ["repository", CRISIS],
      ["map", CORTEX],
      ["node", CORTEX],
      ["node", CRISIS],
    ]);
    expect(page.annotations.every(annotation => annotation.destination.objectType === "repository")).toBe(true);
    expect(page.annotations.every(annotation => annotation.destination.adapterId === "work-graph" && annotation.destination.connectionId === rig.connectionId)).toBe(true);
    expect(page.snapshot.kind).toBe("stable");
    expect(page.snapshot.kind === "stable" && page.snapshot.id.startsWith("work-graph.destinations:")).toBe(true);
    expect(rig.destinationsBinding.display).toEqual({ title: "/title" });
    expect(rig.rig.bindings.readBindings?.lookup("work-graph", rig.connectionId, "work-graph.destinations")).toMatchObject({ state: "available" });
    expect(rig.rig.bindings.readBindings?.lookup("work-graph", rig.connectionId, "work-graph.node.read")).toMatchObject({ state: "available" });
    expect(rig.adapter.bindings.observations).toEqual({});
    expect(rig.calls.argv).toHaveLength(0);
  });

  test("an open node reads through soma and exposes title, status, kind, parent and URL through display pointers", async () => {
    const rig = await open();
    const step = await rig.node(CORTEX_NODE);
    expect(step.result.status).toBe("ok");
    expect(step.result.groups[0]?.coverage).toBe("exhausted");
    expect(step.argv).toEqual([["soma", "graph", "node", `${CORTEX}#3348`, "--read-repo", CORTEX, "--json"]]);
    const [node] = releasedObjects(step.released);
    if (!node) throw new Error("graph node was not released");
    expect(node.ref).toEqual(graphRef(rig.connectionId, "node", CORTEX_NODE));
    expect(node.value).toMatchObject({
      title: "Read graph destinations and nodes",
      status: "open",
      kind: "build",
      url: "https://github.com/the-metafactory/cortex/issues/3348",
      parent: graphRef(rig.connectionId, "node", `${CORTEX}#3293`),
    });
    const display = rig.nodeReadBinding.display;
    expect(display).toEqual({ title: "/title", status: "/status", kind: "/kind", parent: "/parent", url: "/url" });
    for (const pointer of [display.title, display.status, display.kind, display.parent, display.url]) {
      if (pointer === undefined) throw new Error("graph display pointer missing");
      expect(readPointer(node.value as Json, pointer)).toBeDefined();
    }
    expect(step.result.continuation).toBeUndefined();
  });

  test("a closed node is available with status closed, a missing node is unavailable and proves nothing historic", async () => {
    const rig = await open();
    const closed = await rig.node(CLOSED_NODE);
    expect(closed.result.status).toBe("ok");
    const [node] = releasedObjects(closed.released);
    expect(node?.value).toMatchObject({ title: "Publish graph repository ticks", status: "closed", kind: "build" });
    const missing = await rig.node(MISSING_NODE);
    expect(missing.result.status).toBe("unavailable");
    expect(missing.released).toBeUndefined();
    expect(missing.argv).toHaveLength(1);
    const text = JSON.stringify(missing.result);
    expect(text).not.toContain("Publish graph repository ticks");
    expect(text).not.toMatch(/operation|receipt|history/i);
  });

  test("a bare number is combined with the one requested repository, and stored ids stay as written", async () => {
    const rig = await open();
    const step = await rig.node("3348");
    expect(step.result.status).toBe("ok");
    expect(step.argv[0]?.slice(3, 4)).toEqual([`${CORTEX}#3348`]);
    const [node] = releasedObjects(step.released);
    expect(node?.ref.canonicalId).toBe("3348");
    expect(canonicalGraphRef(`${CORTEX}#3348`)).toBe("the-metafactory/cortex#3348");
    expect(canonicalGraphRef("3348", CORTEX)).toBe("the-metafactory/cortex#3348");
    expect(canonicalGraphRef(CRISIS_NODE)).toBe(CRISIS_NODE);
  });

  test("a GitLab reference is read as written and never normalised", async () => {
    const rig = await open();
    const step = await rig.node(CRISIS_NODE, [graphRef(rig.connectionId, "repository", CRISIS)]);
    expect(step.result.status).toBe("ok");
    expect(step.argv[0]?.slice(3, 4)).toEqual([CRISIS_NODE]);
    const [node] = releasedObjects(step.released);
    expect(node?.ref).toEqual(graphRef(rig.connectionId, "node", CRISIS_NODE));
    expect(node?.value).toMatchObject({ title: "Crisis simulator short", status: "open", kind: "task", parent: null });
  });

  test("an unticked repository denies before soma runs and releases no node data", async () => {
    const rig = await open();
    const denied = await rig.node(CORTEX_NODE, [graphRef(rig.connectionId, "repository", UNTICKED)]);
    expect(denied.result.status).toBe("denied");
    expect(denied.result.restricted).toBe(true);
    expect(denied.released).toBeUndefined();
    expect(denied.argv).toHaveLength(0);
    expect(JSON.stringify(denied.result)).not.toContain("Read graph destinations and nodes");
    const outside = await rig.node(CRISIS_NODE, [graphRef(rig.connectionId, "repository", CORTEX)]);
    expect(outside.result.status).toBe("unavailable");
    expect(outside.released).toBeUndefined();
    expect(outside.argv).toHaveLength(0);
    await rig.untick(CORTEX);
    const withdrawn = await rig.node(CORTEX_NODE);
    expect(withdrawn.result.status).toBe("denied");
    expect(withdrawn.released).toBeUndefined();
    expect(withdrawn.argv).toHaveLength(0);
  });

  test("the adapter itself refuses a repository that is not ticked, without waiting for host admission", async () => {
    const rig = await open();
    const before = rig.calls.argv.length;
    await expect(rig.adapter.query({
      readVersion: "1.0.0", queryId: "query-unticked", capabilityId: "work-graph.node.read", input: { ref: graphRef(rig.connectionId, "node", `${UNTICKED}#7`) },
      destinations: [graphRef(rig.connectionId, "repository", UNTICKED)], limit: 1,
    })).rejects.toThrow("work-graph.destination_denied");
    expect(rig.calls.argv.length).toBe(before);
    expect((await rig.destinations()).annotations.some(annotation => annotation.destination.canonicalId === UNTICKED)).toBe(false);
  });

  test("a requested destination outside the node's repository never widens the soma read scope", async () => {
    const rig = await open();
    const before = rig.calls.argv.length;
    const page = await rig.adapter.query({
      readVersion: "1.0.0", queryId: "query-wide", capabilityId: "work-graph.node.read", input: { ref: graphRef(rig.connectionId, "node", CORTEX_NODE) },
      destinations: [
        graphRef(rig.connectionId, "repository", CORTEX),
        graphRef(rig.connectionId, "repository", CRISIS),
        graphRef(rig.connectionId, "repository", UNTICKED),
        { adapterId: "balance", connectionId: rig.connectionId, objectType: "repository", canonicalId: UNTICKED },
      ],
      limit: 1,
    });
    expect(page.annotations.map(annotation => annotation.destination)).toEqual([graphRef(rig.connectionId, "repository", CORTEX)]);
    expect(rig.calls.argv.slice(before)).toEqual([["soma", "graph", "node", `${CORTEX}#3348`, "--read-repo", CORTEX, "--json"]]);
  });

  test("a failing soma reads as unavailable, not as an empty result", async () => {
    const rig = await open();
    const failed = await rig.node(`${CORTEX}#9998`);
    expect(failed.result.status).toBe("unavailable");
    expect(failed.result.noMatch).toBe(false);
    expect(failed.released).toBeUndefined();
    expect(failed.argv).toHaveLength(1);
  });

  test("the adapter declares only query capabilities and no connection, observation or mutation surface of its own", () => {
    const adapter = createWorkGraphReadAdapter({ connectionId: "connection-inactive", repositories: () => [CORTEX], links: () => [] });
    const capabilities = adapter.declaration.capabilities;
    expect(capabilities.map(capability => capability.kind)).toEqual(["query", "query"]);
    expect(capabilities.map(capability => capability.capabilityId).sort()).toEqual(Object.keys(adapter.bindings.handlers).sort());
    expect(adapter.bindings.observations).toEqual({});
    expect(adapter.readBindings.map(binding => binding.mode)).toEqual(["destinations", "query"]);
    expect(adapter.declaration.objectTypes.map(object => object.objectType)).toEqual(["repository", "map", "node"]);
  });
});
