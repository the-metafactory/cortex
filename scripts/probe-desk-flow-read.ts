import { strict as assert } from "node:assert";
import { releasedObjects } from "../src/conversations/domain-adapters/__tests__/fixtures/balance-read-fixtures";
import { ARC_FLOW_NAME, FLOW_NAME, openFlowReadRig } from "../src/conversations/domain-adapters/__tests__/fixtures/flow-read-fixtures";

const rig = await openFlowReadRig({ conversationPolicy: "cloud" });
try {
  assert.equal((await rig.save()).status, "saved");
  const listed = await rig.pulse(["list", "--saved"]);
  const expected = (listed.flows as Record<string, unknown>[]).filter(flow => flow.source === "saved");
  assert.ok((listed.flows as Record<string, unknown>[]).some(flow => flow.source === "arc" && flow.name === ARC_FLOW_NAME));
  const denied = await rig.query();
  assert.equal(denied.result.status, "denied");
  assert.equal(denied.released, undefined);
  assert.ok(!JSON.stringify(denied.result).includes(FLOW_NAME));
  console.log("default local policy: cloud reader denied before owner dispatch, with no object name or count");

  await rig.setPolicy("cloud");
  const queried = await rig.query();
  assert.equal(queried.result.status, "ok");
  assert.deepEqual(releasedObjects(queried.released).map(object => object.value), expected);
  const shown = await rig.pulse(["show", FLOW_NAME]);
  const queriedFlow = releasedObjects(queried.released)[0];
  assert.ok(queriedFlow);
  const { package: _package, ...queryMetadata } = queriedFlow.value;
  const { yaml: _yaml, ...shownMetadata } = shown;
  assert.deepEqual(queryMetadata, shownMetadata);
  const read = await rig.read();
  assert.equal(read.result.status, "ok");
  const [object] = releasedObjects(read.released);
  assert.equal(object?.ref.canonicalId, FLOW_NAME);
  assert.deepEqual(object?.value, shown);
  const arc = await rig.read(ARC_FLOW_NAME);
  assert.equal(arc.result.status, "unavailable");
  assert.equal(arc.released, undefined);
  console.log("query and read: match real Pulse listing and show; installed arc Flow excluded");

  await rig.pulse(["delete", FLOW_NAME, "--expected-sha256", String(shown.sha256)]);
  const missing = await rig.read();
  assert.equal(missing.result.status, "unavailable");
  assert.equal(missing.released, undefined);
  assert.ok(!/F_SAVED_EXAMPLE|operation|receipt|sha256/.test(JSON.stringify(missing.result)));
  const empty = await rig.query();
  assert.equal(empty.result.status, "ok");
  assert.equal(empty.result.noMatch, true);
  assert.deepEqual(releasedObjects(empty.released), []);
  console.log("deleted saved Flow: unavailable read and owner-evidenced empty query");

  await rig.setPolicy("local");
  const restricted = await rig.query();
  assert.equal(restricted.result.status, "denied");
  assert.equal(restricted.result.noMatch, false);
  assert.equal(restricted.released, undefined);
  console.log("policy switched back to local: cloud reader denied, including empty-library count");
} finally {
  await rig.close();
}
