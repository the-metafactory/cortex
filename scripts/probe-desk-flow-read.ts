import { strict as assert } from "node:assert";
import { assertCloudReaderDenied, assertDeletedFlowUnavailable, assertSavedFlowMatches, openFlowReadRig } from "../src/conversations/domain-adapters/__tests__/fixtures/flow-read-fixtures";

const rig = await openFlowReadRig({ conversationPolicy: "cloud" });
try {
  assert.equal((await rig.save()).status, "saved");
  await assertCloudReaderDenied(rig);
  console.log("default local policy: cloud reader denied before owner dispatch, with no object name or count");

  await rig.setPolicy("cloud");
  const shown = await assertSavedFlowMatches(rig);
  console.log("query and read: match real Pulse listing and show; installed arc Flow excluded");

  await assertDeletedFlowUnavailable(rig, shown);
  console.log("deleted saved Flow: unavailable read and owner-evidenced empty query");

  await rig.setPolicy("local");
  await assertCloudReaderDenied(rig);
  console.log("policy switched back to local: cloud reader denied, including empty-library count");
} finally {
  await rig.close();
}
