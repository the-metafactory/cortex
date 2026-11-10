// glossary-ignore: node
import assert from "node:assert/strict";
import { withTempHome } from "./probe-temp-home";
import { studioRequestId } from "../src/surface/mc/desk/conversation-ids";
import { graphMarker } from "../src/surface/mc/desk/graph-conversation-writer";
import { graphNodeAuthority, graphNodeFields, graphNodeOperationId, graphNodeRequest, openGraphNodeRig, type GraphNodeRig } from "../src/conversations/domain-adapters/__tests__/fixtures/work-graph-node-fixtures";

const markersFiled = (rig: GraphNodeRig): number => rig.soma.nodes.size;

await withTempHome(async () => {
  const rig = await openGraphNodeRig();
  try {
    const createId = graphNodeOperationId("probe-create");
    const created = await rig.facade.create(graphNodeRequest(graphNodeFields({ title: "Probe create" }), createId), graphNodeAuthority, rig.lifecycle());
    assert.equal(created.result.state, "created");
    assert.ok(rig.soma.nodes.has(graphMarker(createId)));
    assert.equal(markersFiled(rig), 1);
    console.log("create: one synthetic node under the marker");

    assert.equal((await rig.lifecycle().dispatch(createId)).kind, "not-dispatchable");
    assert.equal(markersFiled(rig), 1);
    console.log("repeat: no second node");

    const refused = await rig.facade.create(graphNodeRequest(graphNodeFields({ kind: "epic" }), graphNodeOperationId("probe-refusal")), graphNodeAuthority, rig.lifecycle());
    assert.equal(refused.kind, "refused");
    assert.equal(markersFiled(rig), 1);
    console.log("refusal: no soma call, no node");

    for (const mode of ["exit-no-file", "exit-after-file", "unattached", "file-under-other-parent"] as const) {
      rig.soma.mode = mode;
      const id = graphNodeOperationId(`probe-${mode}`);
      const before = markersFiled(rig);
      const outcome = await rig.facade.create(graphNodeRequest(graphNodeFields(), id), graphNodeAuthority, rig.lifecycle());
      assert.equal(outcome.kind === "dispatched" && outcome.stored?.journal.state, "uncertain");
      const lookup = await rig.binding.lookup({ lifecycleVersion: "1.0.0", operationId: id, ownerRequestId: studioRequestId(id) });
      assert.equal(rig.soma.calls.at(-1)?.at(-1), "--dry-run");
      assert.equal(lookup.result.kind, mode === "exit-after-file" || mode === "unattached" ? "known" : "unknown");
      assert.equal(markersFiled(rig), before + (mode === "exit-no-file" ? 0 : 1));
      console.log(`${mode}: uncertain, lookup ${lookup.result.kind}`);
    }
    rig.soma.mode = "normal";
    assert.equal(new Set(rig.soma.nodes.keys()).size, markersFiled(rig));
    console.log("one synthetic node per marker");
  } finally {
    await rig.close();
  }
});
