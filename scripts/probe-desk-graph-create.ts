import assert from "node:assert/strict";
import { CREATE_REPOSITORY, graphCreateOutput, openGraphCreateRig } from "../src/conversations/domain-adapters/work-graph/fixtures/graph-create";
import { DESK_DRAFTS_PATH, type DraftEditorView } from "../src/surface/mc/desk/draft-editor-contract";

const rig = await openGraphCreateRig();
try {
  const exact = await rig.resolve(`${CREATE_REPOSITORY}#14`);
  const ambiguous = await rig.resolve("Shared title");
  const unknown = await rig.resolve("Unknown map");
  assert.equal(exact.kind, "unique");
  assert.equal(ambiguous.kind, "multiple");
  assert.equal(unknown.kind, "none");
  const server = rig.serve();
  rig.state.output = graphCreateOutput();
  const response = await server.call("POST", DESK_DRAFTS_PATH, rig.makeInput);
  assert.equal(response.status, 200);
  const made = await response.json() as DraftEditorView;
  assert.equal(made.view.status, "ready-for-confirmation");
  const mutationsBeforeConfirmation = rig.soma.calls.length;
  assert.equal(mutationsBeforeConfirmation, 0);
  const confirmed = await server.call("POST", `${DESK_DRAFTS_PATH}/${made.view.draft.draftId}/confirm`, { revision: made.view.draft.revision });
  const result = await confirmed.json() as { confirmation: { kind: string; operationId: string } };
  assert.equal(result.confirmation.kind, "accepted");
  assert.equal(rig.soma.calls.length, 1);
  assert.equal((await rig.journal.read(result.confirmation.operationId))?.journal.state, "succeeded");
  console.log(JSON.stringify({ exact: exact.kind, ambiguous: ambiguous.kind, unknown: unknown.kind, mutationsBeforeConfirmation, mutationsAfterConfirmation: rig.soma.calls.length, authorityConfirmations: (await rig.authority.inspectHostRecords()).confirmations.length, state: "succeeded" }, null, 2));
} finally {
  await rig.close();
}
