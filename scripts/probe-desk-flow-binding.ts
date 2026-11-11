import { strict as assert } from "node:assert";
import { assertFlowCreated, assertFlowDeleted, assertFlowRefused, assertFlowUncertain, assertFlowReplayBlockedAfterDeletion } from "../src/conversations/domain-adapters/__tests__/fixtures/flow-save-checks";
import { openFlowSaveRig } from "../src/conversations/domain-adapters/__tests__/fixtures/flow-save-fixtures";

const saved = await openFlowSaveRig();
try {
  const shown = await assertFlowCreated(saved);
  assert.equal((await saved.create()).result.state, "created");
  assert.equal(saved.calls.filter(argv => argv.includes("save")).length, 1);
  await assertFlowDeleted(saved, shown);
  console.log("create/repeat/deletion: one save, stable name/hash receipt, historic success after deletion");
} finally { await saved.close(); }

const refused = await openFlowSaveRig();
try {
  await assertFlowRefused(refused);
  console.log("refusal: collision, invalid YAML and mismatched names preserve drafts and leave one Flow");
} finally { await refused.close(); }

for (const mode of ["exit-2", "invalid-output", "timeout"] as const) {
  const crashed = await openFlowSaveRig();
  try {
    crashed.state.mode = mode;
    await assertFlowUncertain(crashed);
    assert.equal(crashed.calls.filter(argv => argv.includes("save")).length, 1);
    assert.ok(crashed.calls.every(argv => !argv.some(arg => ["run", "schedule", "enable"].includes(arg))));
    console.log(`${mode}: uncertain save reconciles by request ID, one Flow and one success receipt`);
  } finally { await crashed.close(); }
}

const deletedUncertain = await openFlowSaveRig();
try {
  await assertFlowReplayBlockedAfterDeletion(deletedUncertain);
  console.log("deleted uncertain save: lookup stays unknown, lifecycle retry blocked, no Flow recreated");
} finally { await deletedUncertain.close(); }
