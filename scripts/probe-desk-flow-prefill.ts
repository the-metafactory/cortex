import assert from "node:assert/strict";
import { FLOW_DRAFT_DISCUSSION, FLOW_DRAFT_NAME, FLOW_DRAFT_STACK, advanceDiscussion, flowDiscussionOutput, flowDraftDefinition, openFlowDraftRig } from "../src/surface/mc/desk/fixtures/flow-draft";
import { withDraftBrowserProbe } from "./desk-make-editor/server";
import { openMakeEditor, reopenOutdatedDraft, revisionSteps } from "./desk-make-editor/steps";
import type { DraftEditorView } from "../src/surface/mc/desk/draft-editor-contract";

const rig = await openFlowDraftRig({ discussion: FLOW_DRAFT_DISCUSSION });
rig.state.output = flowDiscussionOutput();
await withDraftBrowserProbe(rig, async ({ page, errors }) => {
  const { making, editor } = await openMakeEditor(page, "Flow", FLOW_DRAFT_DISCUSSION);
  const name = page.getByLabel("name (required)", { exact: true });
  const definition = page.getByLabel("definition (required)", { exact: true });
  const stack = page.getByLabel("stack (required)", { exact: true });
  await definition.waitFor();
  const made = await (await making).json() as DraftEditorView;
  assert.equal(made.view.draft.entryId, rig.makeInput.entryId);
  assert.equal(await definition.inputValue(), flowDraftDefinition());
  assert.equal(await name.inputValue(), FLOW_DRAFT_NAME);
  assert.equal(await stack.inputValue(), FLOW_DRAFT_STACK);
  assert.equal((await stack.inputValue()).includes("adapterId"), false);
  for (const field of [name, definition]) {
    await editor.locator("fieldset", { has: field }).getByText("Suggested", { exact: true }).waitFor();
  }
  assert.equal(await rig.savedCount(), 0);
  await page.screenshot({ path: (process.argv[2] ?? "/tmp/desk-flow-prefill.png").replace(/\.png$/, "-prefilled.png"), fullPage: true });
  console.log("Make populated the Flow definition from the displayed discussion, took the suggested name from that definition and filled the connection's stack; nothing was saved.");

  const steps = revisionSteps(page, editor);
  const edited = flowDraftDefinition().replace("  - A_EXAMPLE", "  - A_EXAMPLE\n  - A_REVIEW");
  await definition.fill(edited);
  await steps.press("Save definition");
  await editor.locator("fieldset", { has: definition }).getByText("Edited by you", { exact: true }).waitFor();
  assert.equal(await rig.savedCount(), 0);
  advanceDiscussion(rig, "Add a review step after the plan is posted.");
  rig.state.output = flowDiscussionOutput(flowDraftDefinition().replace("  - A_EXAMPLE", "  - A_EXAMPLE\n  - A_POST"));
  await reopenOutdatedDraft(page);
  await steps.press("Refresh draft");
  assert.equal(await definition.inputValue(), edited);
  assert.equal(await name.inputValue(), FLOW_DRAFT_NAME);
  assert.equal(await rig.savedCount(), 0);
  console.log("The principal's edited definition survived an explicit refresh after the discussion moved on, and the name still comes from it; nothing was saved.");

  await page.getByRole("button", { name: "Confirm draft" }).click();
  await page.getByText("Saved operation: succeeded.").waitFor();
  const saved = await rig.pulse.command(["show", FLOW_DRAFT_NAME, "--json"]);
  assert.equal(saved.code, 0);
  assert.match((JSON.parse(saved.stdout) as { yaml: string }).yaml, /A_REVIEW/);
  assert.deepEqual(await rig.savedNames(), [FLOW_DRAFT_NAME]);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: process.argv[2] ?? "/tmp/desk-flow-prefill.png", fullPage: true });
  console.log("Approval saved the exact edited draft once; Pulse lists and shows the same Flow with the review step.");
}, { conversations: () => ({ state: "ready", host: rig.host, tookOver: null, resumed: [], reconciled: [] }), principal: rig.principal.principal, route: `/?desk=conversation&conversation=${rig.makeInput.conversationId}` });
