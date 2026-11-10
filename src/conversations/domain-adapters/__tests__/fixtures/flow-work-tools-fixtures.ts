import { strict as assert } from "node:assert";
import { flowWorkReaders } from "../../../../surface/mc/desk/flow-work-reader";
import type { ToolSession } from "../../../tools/capabilities";
import { workContextTools, type WorkObject } from "../../../tools/work-context";
import { ARC_FLOW_NAME, FLOW_NAME, type FlowReadRig } from "./flow-read-fixtures";

export const flowReadersFor = (rig: FlowReadRig) => flowWorkReaders({
  destination: rig.adapter.destination, policy: () => rig.dataPolicy,
  runner: rig.runner, context: rig.rig.context, sink: rig.rig.sink,
});

export async function callFlowWorkTool(rig: FlowReadRig, name: "work_search" | "work_read", input: object, options: { transport?: "web" | "discord"; route?: "local" | "cloud"; enabled?: boolean } = {}) {
  const remembered: WorkObject[] = [];
  const readers = flowReadersFor(rig);
  const tools = workContextTools({
    readers: () => ({}), ...(options.enabled === false ? {} : { queries: () => readers }), now: Date.now,
    remember: async (_session, objects) => { remembered.push(...objects); return true; },
  });
  const session: ToolSession = {
    principal: rig.rig.principal.principal, conversationId: rig.rig.approval.snapshot.provenance.conversationId,
    transport: options.transport ?? "web", route: options.route ?? "local", policy: rig.rig.policy.conversationPolicy, scope: [],
  };
  const tool = tools.find(candidate => candidate.name === name);
  assert.ok(tool);
  const output = await tool.run(tool.input.parse(input), { project: null, graph: null, projects: [], session, signal: new AbortController().signal });
  return { json: JSON.parse(typeof output === "string" ? output : output.text) as Record<string, any>, remembered };
}

export async function assertLocalFlowWorkTools(rig: FlowReadRig) {
  const searched = await callFlowWorkTool(rig, "work_search", { kinds: ["flow"] });
  assert.equal(searched.json.status, "ok");
  assert.deepEqual(searched.json.results.map((object: WorkObject) => object.id), [FLOW_NAME]);
  assert.ok(!JSON.stringify(searched.json).includes(ARC_FLOW_NAME));
  assert.deepEqual(searched.remembered.map(object => `${object.kind}:${object.id}`), [`flow:${FLOW_NAME}`]);
  const read = await callFlowWorkTool(rig, "work_read", { kind: "flow", id: FLOW_NAME });
  const shown = await rig.pulse(["show", FLOW_NAME]);
  assert.equal(read.json.status, "ok");
  assert.equal(read.json.object.summary, shown.yaml);
  assert.equal(read.json.object.url, "?routines=flows");
  assert.deepEqual(read.remembered.map(object => [object.kind, object.id, object.policy]), [["flow", FLOW_NAME, rig.dataPolicy]]);
  assert.equal(rig.rig.calls.dispatch, 0);
  assert.equal(rig.rig.calls.cancel, 0);
  assert.equal(rig.rig.calls.lookup, 0);
  assert.equal(rig.rig.calls.readback, 0);
}

export async function assertCloudFlowWorkToolsDenied(rig: FlowReadRig) {
  const before = rig.rig.calls.read;
  const search = await callFlowWorkTool(rig, "work_search", { kinds: ["flow"] });
  assert.equal(search.json.status, "denied");
  assert.deepEqual(search.json.results, []);
  assert.equal(search.json.next, null);
  assert.deepEqual(search.remembered, []);
  assert.doesNotMatch(JSON.stringify(search.json), /F_[A-Z0-9_]+|sha256|provenance|yaml|count/);
  for (const id of [FLOW_NAME, "F_MISSING_EXAMPLE", ARC_FLOW_NAME]) {
    const read = await callFlowWorkTool(rig, "work_read", { kind: "flow", id });
    assert.equal(read.json.status, "unauthorized");
    assert.ok(!("object" in read.json));
    assert.deepEqual(read.remembered, []);
  }
  assert.equal(rig.rig.calls.read, before);
}
