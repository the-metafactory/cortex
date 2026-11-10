// glossary-ignore: node
import { afterEach, expect, test } from "bun:test";
import { graphMarker } from "../../../surface/mc/desk/graph-conversation-writer";
import { studioRequestId } from "../../../surface/mc/desk/conversation-ids";
import { objectRef } from "../fixtures";
import type { Json } from "../operations/types";
import { workGraphNodeApprovedSnapshot, workGraphNodeCreateOutcome, workGraphNodeCreateSupport, type WorkGraphNodeBinding } from "../work-graph/node-binding";
import { GRAPH_NODE_CONNECTION, GRAPH_NODE_NOW, GRAPH_NODE_REPOSITORY, graphNodeAuthority, graphNodeFields, graphNodeOperationId, graphNodeRequest, openGraphNodeRig, type GraphNodeRig } from "./fixtures/work-graph-node-fixtures";

const rigs: GraphNodeRig[] = [];
async function open(options?: Parameters<typeof openGraphNodeRig>[0]): Promise<GraphNodeRig> {
  const rig = await openGraphNodeRig(options);
  rigs.push(rig);
  return rig;
}
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });

const repository = objectRef("work-graph", "repository", GRAPH_NODE_REPOSITORY);
const node = (id: string) => objectRef("work-graph", "node", id);
const provenance = (operationId: string) => ({ conversationId: "conversation-example", proposalId: operationId.split(":")[1] ?? "proposal-example", revision: 1, entryId: null, link: "?desk=conversation" });

async function dispatchRequest(rig: GraphNodeRig, operationId: string): Promise<Parameters<WorkGraphNodeBinding["dispatch"]>[0]> {
  const stored = await rig.journal.read(operationId);
  if (!stored || "kind" in stored.journal.snapshot) throw new Error("Expected an approved snapshot.");
  return { lifecycleVersion: "1.0.0", operationId, attemptId: crypto.randomUUID(), idempotencyKey: operationId, ownerRequestId: studioRequestId(operationId), snapshot: stored.journal.snapshot, authority: graphNodeAuthority, supportDeclarationId: rig.binding.support.declarationId, deadlineAt: new Date(GRAPH_NODE_NOW + 60_000).toISOString() };
}

async function forged(rig: GraphNodeRig, name: string, input: Record<string, Json>) {
  const operationId = graphNodeOperationId(name);
  const snapshot = workGraphNodeApprovedSnapshot({ connectionId: GRAPH_NODE_CONNECTION, provenance: provenance(operationId), input: { repository, parent: node("12"), title: "Forged", checkpoint: "cp" } });
  return { lifecycleVersion: "1.0.0" as const, operationId, attemptId: crypto.randomUUID(), idempotencyKey: operationId, ownerRequestId: studioRequestId(operationId), snapshot: { ...snapshot, input: { ...(snapshot.input as Record<string, Json>), ...input } }, authority: graphNodeAuthority, supportDeclarationId: rig.binding.support.declarationId, deadlineAt: new Date(GRAPH_NODE_NOW + 60_000).toISOString() };
}

test("a validated snapshot files one node with the legacy argv, marker and label, and never claims or closes", async () => {
  const rig = await open();
  const id = graphNodeOperationId("create");
  const outcome = await rig.facade.create(graphNodeRequest(graphNodeFields({ body: "Why", dependencies: "7 8" }), id), graphNodeAuthority, rig.lifecycle());
  expect(outcome.kind).toBe("dispatched");
  expect(outcome.result).toEqual({ state: "created", canonicalId: "example/desk#40", url: "https://github.com/example/desk/issues/40" });
  const [argv] = rig.soma.calls;
  expect(argv?.slice(0, 5)).toEqual(["/opt/soma/bin/soma", "graph", "add", "12", "--repo"]);
  expect(argv).toContain(GRAPH_NODE_REPOSITORY);
  expect(argv?.slice(argv.indexOf("--autonomy"), argv.indexOf("--autonomy") + 4)).toEqual(["--autonomy", "approve", "--kind", "grilling"]);
  expect(argv?.slice(argv.indexOf("--label"), argv.indexOf("--label") + 2)).toEqual(["--label", "ivy:conversation"]);
  expect(argv?.slice(argv.indexOf("--blocked-by"), argv.indexOf("--blocked-by") + 4)).toEqual(["--blocked-by", "7", "--blocked-by", "8"]);
  expect(argv).toContain(graphMarker(id));
  expect(argv?.some(part => part === "claim" || part === "close")).toBe(false);
  const stored = await rig.journal.read(id);
  expect(stored?.journal.state).toBe("succeeded");
  const snapshot = stored && !("kind" in stored.journal.snapshot) ? stored.journal.snapshot.input as Record<string, unknown> : {};
  expect(snapshot.autonomy).toBe("approve");
  expect(snapshot.kind).toBe("grilling");
});

test("a repeated dispatch adds no second node", async () => {
  const rig = await open();
  const id = graphNodeOperationId("repeat");
  await rig.facade.create(graphNodeRequest(graphNodeFields(), id), graphNodeAuthority, rig.lifecycle());
  expect((await rig.lifecycle().dispatch(id)).kind).toBe("not-dispatchable");
  const again = await rig.binding.dispatch(await dispatchRequest(rig, id));
  expect(workGraphNodeCreateOutcome(again)).toBe("created");
  expect(rig.soma.nodes.size).toBe(1);
});

test("refusals before soma runs are refused and soma is never called", async () => {
  const unticked = await open({ ticked: false });
  expect((await unticked.facade.create(graphNodeRequest(graphNodeFields()), graphNodeAuthority, unticked.lifecycle())).kind).toBe("refused");
  const rig = await open();
  for (const fields of [graphNodeFields({ autonomy: "claim" }), graphNodeFields({ kind: "epic" }), graphNodeFields({ parent: "--repo" }), graphNodeFields({ dependencies: "5 --body-file" })]) {
    expect((await rig.facade.create(graphNodeRequest(fields), graphNodeAuthority, rig.lifecycle())).kind).toBe("refused");
  }
  const inputs: Record<string, Json>[] = [{ autonomy: "claim" }, { kind: "epic" }, { parent: node("--repo") }, { dependencies: [node("-x")] }, { repository: objectRef("work-graph", "repository", "github:github.com/example/other") }];
  for (const [index, input] of inputs.entries()) {
    const response = await rig.binding.dispatch(await forged(rig, `forged-${index}`, input));
    expect(workGraphNodeCreateOutcome(response)).toBe("refused");
    expect(response.result.kind === "failed" && response.result.evidence.final).toBe(true);
  }
  expect(rig.soma.calls).toEqual([]);
});

test("a missing soma binary is refused before any call", async () => {
  const rig = await open({ somaBin: "" });
  const response = await rig.binding.dispatch(await forged(rig, "no-soma", {}));
  expect(workGraphNodeCreateOutcome(response)).toBe("refused");
  expect(rig.soma.calls).toEqual([]);
});

test("any non-zero exit or unattached node is uncertain and lookup uses the stored argv with --dry-run", async () => {
  for (const mode of ["exit-no-file", "exit-after-file", "unattached"] as const) {
    const rig = await open();
    rig.soma.mode = mode;
    const id = graphNodeOperationId(mode);
    const outcome = await rig.facade.create(graphNodeRequest(graphNodeFields(), id), graphNodeAuthority, rig.lifecycle());
    expect(outcome.kind === "dispatched" && outcome.stored?.journal.state).toBe("uncertain");
    const lookup = await rig.binding.lookup({ lifecycleVersion: "1.0.0", operationId: id, ownerRequestId: studioRequestId(id) });
    const dry = rig.soma.calls.at(-1);
    expect(dry?.at(-1)).toBe("--dry-run");
    expect(dry?.slice(1, 4)).toEqual(["graph", "add", "12"]);
    if (mode === "exit-no-file") expect(lookup.result.kind).toBe("unknown");
    else {
      expect(lookup.result.kind).toBe("known");
      expect(lookup.result.kind === "known" && lookup.result.response.result.kind === "succeeded" && lookup.result.response.result.evidence.refs[0]?.canonicalId).toBe("example/desk#40");
    }
  }
});

test("a node found under another parent stays unknown", async () => {
  const rig = await open();
  rig.soma.mode = "file-under-other-parent";
  const id = graphNodeOperationId("wrong-parent");
  await rig.facade.create(graphNodeRequest(graphNodeFields(), id), graphNodeAuthority, rig.lifecycle());
  const lookup = await rig.binding.lookup({ lifecycleVersion: "1.0.0", operationId: id, ownerRequestId: studioRequestId(id) });
  expect(lookup.result.kind).toBe("unknown");
});

test("the binding declares marker dedup and lookup, and no update, cancellation or compensation", () => {
  const support = workGraphNodeCreateSupport(GRAPH_NODE_CONNECTION);
  expect(support.dedup.kind).toBe("guaranteed");
  expect(support.operationLookup).toBe("historical");
  expect(support.conditionalUpdate).toBe("none");
  expect(support.cancellation).toBe("none");
  expect(support.compensationCapabilityId).toBeUndefined();
});

test("overlapping dispatches of one operation file one node", async () => {
  const rig = await open();
  const id = graphNodeOperationId("overlap");
  await rig.journal.approve({ operationId: id, idempotencyKey: id, ownerRequestId: studioRequestId(id), snapshot: workGraphNodeApprovedSnapshot({ connectionId: GRAPH_NODE_CONNECTION, provenance: provenance(id), input: { repository, parent: node("12"), title: "Overlap", checkpoint: "cp" } }), authority: graphNodeAuthority, at: new Date(GRAPH_NODE_NOW).toISOString() });
  const request = await dispatchRequest(rig, id);
  const [first, second] = await Promise.all([rig.binding.dispatch(request), rig.binding.dispatch({ ...request, attemptId: crypto.randomUUID() })]);
  expect(workGraphNodeCreateOutcome(first)).toBe("created");
  expect(workGraphNodeCreateOutcome(second)).toBe("created");
  expect(rig.soma.nodes.size).toBe(1);
});

test("a found node after an uncertain dispatch reconciles through the journal", async () => {
  const rig = await open();
  rig.soma.mode = "exit-after-file";
  const id = graphNodeOperationId("reconcile");
  await rig.facade.create(graphNodeRequest(graphNodeFields(), id), graphNodeAuthority, rig.lifecycle());
  const lookup = await rig.binding.lookup({ lifecycleVersion: "1.0.0", operationId: id, ownerRequestId: studioRequestId(id) });
  expect(lookup.result.kind === "known" && lookup.result.response.resultId).toContain("work-graph.lookup:");
  const uncertain = (await rig.journal.read(id))?.journal.events.flatMap(entry => entry.event.kind === "owner-result" ? [entry.event.response] : []);
  expect(uncertain?.some(response => lookup.result.kind === "known" && response.resultId === lookup.result.response.resultId)).toBe(false);
});
