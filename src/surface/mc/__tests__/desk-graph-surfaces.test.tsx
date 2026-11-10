import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CLOSED_NODE, CORTEX, CORTEX_MAP, CORTEX_NODE, MISSING_NODE, UNTICKED, openGraphReadRig, type GraphReadRig } from "../../../conversations/domain-adapters/__tests__/fixtures/graph-read-fixtures";
import { handleDeskGraphSurfaces } from "../api/desk-graph-surfaces";
import { DisplayCard } from "../dashboard-v2/components/desk-conversation-display-card";
import { createGraphSurfaceReader, graphSurfaceRun, type GraphSurfaceReader } from "../desk/graph-surfaces";
import { GRAPH_SURFACES_DESTINATIONS, graphSurfaceNodePath } from "../desk/graph-surface-schema";

const opened: GraphReadRig[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(rig => rig.close())); });

async function open(enabled = true): Promise<{ rig: GraphReadRig; reader: GraphSurfaceReader }> {
  const rig = await openGraphReadRig();
  opened.push(rig);
  const reader = createGraphSurfaceReader({
    connectionId: rig.connectionId,
    enabled: () => enabled,
    destinations: () => rig.adapter.destinations(),
    readNode: graphSurfaceRun({ connectionId: rig.connectionId, runner: rig.runner, context: rig.rig.context, sink: rig.rig.sink, inputSchemaRef: rig.nodeReadBinding.inputSchemaRef }),
    display: rig.nodeReadBinding.display,
  });
  return { rig, reader };
}

describe("graph surfaces over the host query runner", () => {
  test("destinations offer the ticked repositories and the linked parents, scoped to their repository", async () => {
    const { reader } = await open();
    const found = await reader.destinations();
    if (!found.enabled) throw new Error("graph surfaces were off");
    expect(found.repositories.map(r => r.ref)).toEqual([CORTEX, "gitlab:gitlab.example.org/claw/crisis-simulator"]);
    expect(found.parents.map(p => [p.kind, p.ref, p.repository])).toEqual(expect.arrayContaining([["map", CORTEX_MAP, CORTEX], ["node", CORTEX_NODE, CORTEX]]));
    expect(found.parents.some(p => p.ref.includes("other"))).toBe(false);
  });

  test("an exact reference reads open, closed and missing nodes into a display card", async () => {
    const { rig, reader } = await open();
    expect(await reader.node(CORTEX_NODE)).toEqual({ enabled: true, state: "available", title: "Read graph destinations and nodes", status: "open", kind: "build", url: "https://github.com/the-metafactory/cortex/issues/3348" });
    expect(await reader.node(CLOSED_NODE)).toMatchObject({ state: "available", status: "closed", title: "Publish graph repository ticks" });
    const seen = rig.calls.argv.length;
    expect(await reader.node(MISSING_NODE)).toEqual({ enabled: true, state: "unavailable" });
    expect(rig.calls.argv.length).toBe(seen + 1);
    expect(await reader.node("not a reference")).toEqual({ enabled: true, state: "unavailable" });
    expect(rig.calls.argv.length).toBe(seen + 1);
  });

  test("a bare number reads inside the repository it is entered with", async () => {
    const { reader } = await open();
    expect(await reader.node("3350", CORTEX)).toMatchObject({ state: "available", status: "closed" });
    expect(await reader.node("3350")).toEqual({ enabled: true, state: "unavailable" });
  });

  test("an unticked repository withholds the card before soma runs, and unticking withdraws a choice", async () => {
    const { rig, reader } = await open();
    const seen = rig.calls.argv.length;
    expect(await reader.node(`${UNTICKED}#7`)).toEqual({ enabled: true, state: "withheld" });
    expect(rig.calls.argv.length).toBe(seen);
    await rig.untick(CORTEX);
    expect(await reader.node(CLOSED_NODE)).toEqual({ enabled: true, state: "withheld" });
    const found = await reader.destinations();
    if (!found.enabled) throw new Error("graph surfaces were off");
    expect(found.repositories.map(r => r.ref)).not.toContain(CORTEX);
    expect(found.parents.some(p => p.repository === CORTEX)).toBe(false);
  });

  test("with the connection off nothing is read", async () => {
    const { rig, reader } = await open(false);
    expect(await reader.destinations()).toEqual({ enabled: false });
    expect(await reader.node(CORTEX_NODE)).toEqual({ enabled: false });
    expect(rig.calls.argv).toHaveLength(0);
  });
});

describe("the graph surfaces route", () => {
  const call = (path: string, reader: GraphSurfaceReader | null, method = "GET"): Promise<Response> =>
    handleDeskGraphSurfaces(new Request(`http://127.0.0.1:8767${path}`, { method }), new URL(`http://127.0.0.1:8767${path}`), () => reader);

  test("answers enabled false without a reader, and serves destinations and cards with one", async () => {
    expect(await (await call(GRAPH_SURFACES_DESTINATIONS, null)).json()).toEqual({ enabled: false });
    const { reader } = await open();
    expect(await (await call(GRAPH_SURFACES_DESTINATIONS, reader)).json()).toMatchObject({ enabled: true });
    expect(await (await call(graphSurfaceNodePath(CORTEX_NODE, ""), reader)).json()).toMatchObject({ enabled: true, state: "available", status: "open" });
    expect(await (await call(graphSurfaceNodePath("3350", CORTEX), reader)).json()).toMatchObject({ state: "available", status: "closed" });
    expect((await call("/api/desk/graph-surfaces/node", reader)).status).toBe(400);
    expect((await call(GRAPH_SURFACES_DESTINATIONS, reader, "POST")).status).toBe(405);
  });
});

describe("the saved display card", () => {
  const html = (reading: Parameters<typeof DisplayCard>[0]["reading"]): string => renderToStaticMarkup(<DisplayCard reading={reading} />);

  test("renders title, status, kind and link from the released facts", () => {
    const open = html({ kind: "ready", card: { enabled: true, state: "available", title: "Read nodes", status: "open", kind: "build", url: "https://github.com/the-metafactory/cortex/issues/1" } });
    expect(open).toContain("Read nodes");
    expect(open).toContain("Open</span>");
    expect(open).toContain("Build");
    expect(open).toContain('href="https://github.com/the-metafactory/cortex/issues/1"');
    expect(html({ kind: "ready", card: { enabled: true, state: "available", title: "Done", status: "closed", kind: null, url: null } })).toContain("Closed");
  });

  test("a missing node is unavailable with no retry, an unticked one withholds, and an off connection renders nothing", () => {
    const missing = html({ kind: "ready", card: { enabled: true, state: "unavailable" } });
    expect(missing).toContain("This item is unavailable");
    expect(missing).not.toContain("<button");
    const withheld = html({ kind: "ready", card: { enabled: true, state: "withheld" } });
    expect(withheld).toContain("Content withheld");
    expect(withheld).not.toContain("<a ");
    expect(html({ kind: "off" })).toBe("");
  });

  test("a link that is not http is not rendered", () => {
    expect(html({ kind: "ready", card: { enabled: true, state: "available", title: "t", status: "open", kind: null, url: "javascript:alert(1)" } })).not.toContain("<a ");
  });
});
