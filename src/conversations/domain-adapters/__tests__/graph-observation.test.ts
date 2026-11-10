import { afterEach, describe, expect, test } from "bun:test";
import { workGraphReadDeclaration } from "../work-graph/read";
import { workGraphObservationDeclaration, WORK_GRAPH_OBSERVATION_CAPABILITY_ID } from "../work-graph/observation";
import { OBSERVED, OBSERVED_NODE, OBSERVED_NODE_THREE, OBSERVED_NODE_TWO, OBSERVED_PARENT, openGraphObservationRig, syntheticGraph, syntheticListing, syntheticRow, type GraphObservationRig } from "./fixtures/graph-observation-fixtures";
import { OBSERVATION_LIMITS } from "../reads/observation-policy";

const opened: GraphObservationRig[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(rig => rig.close())); });
async function open(pageItems?: number, graph = syntheticGraph()): Promise<GraphObservationRig> {
  const rig = await openGraphObservationRig(graph, pageItems === undefined ? {} : { pageItems });
  opened.push(rig);
  return rig;
}
const returnCall = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
const nodeGrant = (repository: string): string[] => ["--repo", repository, ...(repository === OBSERVED ? ["--read-repo", repository] : [])];

describe("the inactive work-graph observation binding", () => {
  test("a poll crosses a page boundary, projects each listed node once and repeats nothing", async () => {
    const rig = await open(2);
    const first = await rig.check();
    expect(first).toMatchObject({ status: "ok", changed: 3, quarantined: 0 });
    expect(rig.graph.calls.argv).toHaveLength(2);
    expect(rig.graph.calls.argv[0]).toEqual(["soma", "graph", "list", "--repo", OBSERVED, "--state", "all", "--limit", "2", "--read-repo", OBSERVED, "--json"]);
    const secondPage = rig.graph.calls.argv[1] ?? [];
    expect(returnCall(secondPage, "--cursor")).toBe("after:2");
    expect(returnCall(secondPage, "--repo")).toBe(OBSERVED);
    const views = await rig.views();
    expect(views.map(view => view.ref.canonicalId).sort()).toEqual([OBSERVED_NODE, OBSERVED_NODE_TWO, OBSERVED_NODE_THREE].sort());
    expect(views.every(view => view.status === "fresh" && view.evidenceCount === 1)).toBe(true);
    expect(views.find(view => view.ref.canonicalId === OBSERVED_NODE)?.value).toEqual({
      title: "Observe graph nodes", status: "open", kind: "build", url: "https://example.invalid/3348",
      parent: { adapterId: "work-graph", connectionId: rig.connectionId, objectType: "node", canonicalId: OBSERVED_PARENT },
    });
    const repeated = await rig.check();
    expect(repeated).toMatchObject({ status: "ok", changed: 0, quarantined: 0 });
    expect(await rig.views()).toHaveLength(3);
    expect((await rig.views()).every(view => view.evidenceCount === 1)).toBe(true);
  });

  test("a changed node with a stable reference becomes current instead of conflicting", async () => {
    const rig = await open();
    await rig.check();
    rig.graph.replace(OBSERVED, syntheticListing().map(row => row.id === "3348" ? { ...row, title: "Observe graph nodes continuously", status: "closed" as const } : row));
    expect((await rig.check()).changed).toBe(1);
    expect((await rig.views()).find(view => view.ref.canonicalId === OBSERVED_NODE)?.value).toMatchObject({ title: "Observe graph nodes continuously", status: "closed" });
  });

  test("a node that disappears from a listing keeps its value and goes stale; only the owner's not-found removes it", async () => {
    const rig = await open();
    rig.links.push({ owner: "graph-node", id: OBSERVED_NODE_THREE, title: "Read the graph picker" });
    await rig.check();
    await rig.store.link(rig.source, { adapterId: "work-graph", connectionId: rig.connectionId, objectType: "node", canonicalId: OBSERVED_NODE_THREE }, "conversation-example");
    rig.graph.replace(OBSERVED, syntheticListing().filter(row => row.id !== "3350"));
    const listed = await rig.check();
    expect(listed.status).toBe("ok");
    expect(rig.graph.calls.argv.some(argv => argv[2] === "node")).toBe(true);
    const kept = (await rig.views()).find(view => view.ref.canonicalId === OBSERVED_NODE_THREE);
    expect(kept?.kind).toBe("present");
    expect(kept?.value).toMatchObject({ title: "Read the graph picker", status: "closed" });
    expect(await rig.views(true)).toHaveLength(3);
    rig.time.advance(OBSERVATION_LIMITS.staleMs);
    expect((await rig.views()).find(view => view.ref.canonicalId === OBSERVED_NODE_THREE)?.status).toBe("stale");
    expect((await rig.views()).find(view => view.ref.canonicalId === OBSERVED_NODE)?.status).toBe("stale");

    rig.graph.forget(OBSERVED_NODE_THREE);
    expect((await rig.check()).status).toBe("ok");
    const active = await rig.views();
    expect(active.map(view => view.ref.canonicalId).sort()).toEqual([OBSERVED_NODE, OBSERVED_NODE_TWO].sort());
    const marker = (await rig.views(true)).find(view => view.ref.canonicalId === OBSERVED_NODE_THREE);
    expect(marker).toMatchObject({ kind: "deleted", status: "fresh" });
    expect(marker?.value).toBeUndefined();
    expect(JSON.stringify(await rig.views(true))).not.toContain("Read the graph picker");
  });

  test("a truncated listing never probes an owner and never deletes a row it did not read", async () => {
    const rows = Array.from({ length: 25 }, (_value, index) => syntheticRow(String(4000 + index), `Row ${index}`));
    const graph = syntheticGraph();
    graph.replace(OBSERVED, rows);
    const rig = await open(10, graph);
    rig.links.push({ owner: "graph-node", id: `${OBSERVED}#4000` });
    graph.forget(`${OBSERVED}#4000`);
    const checked = await rig.check();
    expect(checked.status).toBe("ok");
    expect(rig.graph.calls.argv.filter(argv => argv[2] === "node")).toHaveLength(0);
    expect(await rig.views()).toHaveLength(20);
    expect((await rig.views()).every(view => view.kind === "present")).toBe(true);
    expect(rig.graph.calls.argv.filter(argv => argv[2] === "list")).toHaveLength(2);
  });

  test("a failing verb, a malformed page and a stalled continuation leave the projection stale and never empty", async () => {
    const rig = await open(2);
    await rig.check();
    const before = await rig.views();
    expect(before).toHaveLength(3);
    rig.graph.fail = "soma could not reach the graph owner";
    expect(await rig.check()).toMatchObject({ status: "unavailable", changed: 0 });
    expect((await rig.views()).map(view => [view.ref.canonicalId, view.status])).toEqual(before.map(view => [view.ref.canonicalId, "stale"]));
    expect(await rig.views()).toHaveLength(3);

    rig.graph.fail = null;
    rig.graph.corrupt = JSON.stringify({ nodes: { "3348": "Observe graph nodes" }, next: null });
    expect(await rig.check()).toMatchObject({ status: "unavailable" });
    rig.graph.corrupt = JSON.stringify({ nodes: [syntheticRow("3348", "Observe graph nodes")], next: "" });
    expect(await rig.check()).toMatchObject({ status: "unavailable" });
    rig.graph.corrupt = JSON.stringify({ nodes: [syntheticRow("3348", "Observe graph nodes")] });
    expect(await rig.check()).toMatchObject({ status: "unavailable" });
    expect(await rig.views()).toHaveLength(3);

    rig.graph.corrupt = null;
    rig.graph.repeatCursor = true;
    expect(await rig.check()).toMatchObject({ status: "unavailable" });
    expect(rig.graph.calls.argv.filter(argv => argv[2] === "node")).toHaveLength(0);
    expect(await rig.views()).toHaveLength(3);
    expect((await rig.views()).every(view => view.kind === "present")).toBe(true);
  });

  test("an unticked repository leaves results at once and reads nothing further", async () => {
    const rig = await open();
    await rig.check();
    const calls = rig.graph.calls.argv.length;
    await rig.untick();
    expect(await rig.check()).toMatchObject({ status: "denied" });
    expect(rig.graph.calls.argv).toHaveLength(calls);
    expect((await rig.read()).kind).toBe("withheld");
    expect((await rig.read(true)).kind).toBe("withheld");
    await expect(rig.fetch()).rejects.toThrow(/work-graph\.destination_denied/);
    expect(rig.graph.calls.argv).toHaveLength(calls);
  });

  test("the binding declares no attention mapping and adds only the observation capability", async () => {
    const rig = await open();
    expect(rig.binding).toMatchObject({ mode: "poll", objectType: "node", destinationType: "repository", display: { title: "/title", status: "/status", kind: "/kind", parent: "/parent", url: "/url" } });
    expect(rig.binding.observation).toMatchObject({ modes: ["poll"], objectsPointer: "/items", resumable: false, ordering: "work-graph.current-listing" });
    expect(rig.binding.attention).toBeUndefined();
    expect(rig.binding.query).toBeUndefined();
    expect(rig.adapter.readBindings.filter(binding => binding.attention !== undefined)).toHaveLength(0);
    const read = workGraphReadDeclaration();
    const observation = workGraphObservationDeclaration();
    expect(observation.objectTypes).toEqual(read.objectTypes);
    expect(observation.schemas.filter(schema => !read.schemas.some(held => held.schemaId === schema.schemaId))).toHaveLength(2);
    expect(observation.capabilities.filter(capability => !read.capabilities.some(held => held.capabilityId === capability.capabilityId)).map(capability => [capability.capabilityId, capability.kind])).toEqual([[WORK_GRAPH_OBSERVATION_CAPABILITY_ID, "observation"]]);
    expect(observation.capabilities.find(capability => capability.capabilityId === "work-graph.node.create")?.kind).toBe("action");
    expect(observation.capabilities.find(capability => capability.capabilityId === "work-graph.node.read")?.kind).toBe("query");
    expect(rig.adapter.bindings.observations).toEqual({ [WORK_GRAPH_OBSERVATION_CAPABILITY_ID]: { modes: ["poll"], ordering: "work-graph.current-listing" } });
    expect(nodeGrant(OBSERVED)).toContain("--read-repo");
  });
});
