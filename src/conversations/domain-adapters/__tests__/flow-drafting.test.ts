import { afterEach, expect, test } from "bun:test";
import { FLOW_DRAFT_NAME, FLOW_DRAFT_STACK, advanceDiscussion, flowDiscussionOutput, flowDraftDefinition, flowDraftInvalidDefinition, flowNamedOutput, openFlowDraftRig } from "../../../surface/mc/desk/fixtures/flow-draft";
import type { DraftEditorView } from "../../../surface/mc/desk/draft-editor-contract";
import { DraftingBindings } from "../drafting";
import { flowSaveDraftingBinding } from "../drafting/flow";
import { draftPath, editDraft, expectManualModeKeepsEdits, expectRestartReopensDraft, expectServedReopen, makeDraft, refreshDraft } from "./fixtures/draft-route";

type Rig = Awaited<ReturnType<typeof openFlowDraftRig>>;
const rigs: Rig[] = [];
async function open(output = flowDiscussionOutput()) { const rig = await openFlowDraftRig(); rigs.push(rig); rig.state.output = output; return rig; }
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
const expectUnsaved = async (rig: Rig) => expect(await rig.savedCount()).toBe(0);
const expectBlocked = async (rig: Rig, view: DraftEditorView) => {
  expect(await rig.confirm(view.view.draft)).toMatchObject({ kind: "blocked" });
  await expectUnsaved(rig);
};

test("Flow Make drafts a suggested definition and takes the name from it without saving", async () => {
  const rig = await open();
  const made = await makeDraft(rig);
  const draft = made.view.draft;
  expect(draft.fields["/definition"]).toMatchObject({ origin: "suggested", value: flowDraftDefinition(), citations: ["turn-example"] });
  expect(draft.fields["/name"]).toMatchObject({ origin: "suggested", value: FLOW_DRAFT_NAME, citations: ["turn-example"] });
  expect(draft.fields["/stack"]).toMatchObject({ origin: "default", value: rig.ref("stack", FLOW_DRAFT_STACK) });
  expect(made.view.status).toBe("ready-for-confirmation");
  expect(rig.state.requests[0]).toMatchObject({ guidance: flowSaveDraftingBinding.guidance, targets: expect.arrayContaining(["/definition"]) });
  expect(rig.state.requests[0]?.targets).toEqual(["/name", "/definition"]);
  expect(made.fields.find(field => field.pointer === "/definition")?.long).toBe(true);
  const details = await rig.call("GET", `${draftPath(made)}/details?pointer=/name`);
  expect(await details.json()).toMatchObject({ details: { sources: [{ id: "turn-example", revision: "1" }], origin: "suggested" } });
  await expectUnsaved(rig);
});

test("the name always comes from the definition, never from the model or the discussion title", async () => {
  const rig = await open(flowNamedOutput("F_MODEL_GUESS"));
  const made = await makeDraft(rig);
  expect(made.view.draft.fields["/name"]?.value).toBe(FLOW_DRAFT_NAME);
  expect(made.view.draft.fields["/definition"]?.value).toBe(flowDraftDefinition());

  const unnamed = await open(flowDiscussionOutput("input:\n  text: example\nactions:\n  - A_EXAMPLE\n"));
  const draft = await makeDraft(unnamed);
  expect(draft.view.draft.fields["/name"]).toBeUndefined();
  expect(draft.view.blocking).toContainEqual({ pointer: "/name", code: "required_missing" });
  await expectBlocked(unnamed, draft);
});

test("an edited definition survives explicit refresh while an untouched one follows the discussion", async () => {
  const rig = await open();
  let current = await makeDraft(rig);
  const draftId = current.view.draft.draftId;
  const edited = flowDraftDefinition().replace("  - A_EXAMPLE", "  - A_EXAMPLE\n  - A_REVIEW");
  current = await editDraft(rig, current, "/definition", { kind: "set", value: edited });
  advanceDiscussion(rig, "Add a review step after the plan is posted.");
  rig.state.output = flowDiscussionOutput(flowDraftDefinition().replace("  - A_EXAMPLE", "  - A_EXAMPLE\n  - A_REVIEW\n  - A_POST"));
  const outdated = await rig.editor.service.read(draftId);
  expect(outdated?.outdated).toContain("conversation-changed");
  expect(outdated?.draft.fields["/definition"]?.value).toBe(edited);
  current = await refreshDraft(rig, current);
  expect(current.view.draft.fields["/definition"]).toMatchObject({ origin: "principal", value: edited });
  expect(current.view.draft.fields["/name"]?.value).toBe(FLOW_DRAFT_NAME);
  await expectRestartReopensDraft(rig, draftId, current.view.draft);
  await expectUnsaved(rig);
});

test("an untouched definition refreshes with later turns while a stale result cannot overwrite a later edit", async () => {
  const rig = await open();
  const made = await makeDraft(rig);
  rig.state.head = "2";
  rig.state.output = flowDiscussionOutput(flowDraftDefinition().replace("  - A_EXAMPLE", "  - A_EXAMPLE\n  - A_POST"));
  const updated = await refreshDraft(rig, made);
  expect(updated.view.draft.fields["/definition"]?.value).toContain("A_POST");
  const later = flowDraftDefinition().replace("  - A_EXAMPLE", "  - A_EXAMPLE\n  - A_EDITED");
  rig.state.onGenerate = async () => { rig.state.onGenerate = undefined; await editDraft(rig, updated, "/definition", { kind: "set", value: later }); };
  const stale = await rig.call("POST", `${draftPath(updated)}/refresh`, { revision: updated.view.draft.revision });
  expect(stale.status).toBe(409);
  expect((await rig.editor.service.read(updated.view.draft.draftId))?.draft.fields["/definition"]?.value).toBe(later);
  await expectUnsaved(rig);
});

test("the connection's stack resolves canonically and a revoked stack blocks confirmation", async () => {
  const rig = await open();
  expect(await rig.resolve(FLOW_DRAFT_STACK)).toEqual({ kind: "unique", ref: rig.ref("stack", FLOW_DRAFT_STACK) });
  expect(await rig.resolve("Test")).toEqual({ kind: "unique", ref: rig.ref("stack", FLOW_DRAFT_STACK) });
  expect(await rig.resolve("another-stack")).toEqual({ kind: "none" });
  expect(await rig.resolve(FLOW_DRAFT_STACK, "saved")).toEqual({ kind: "unavailable" });
  const made = await makeDraft(rig);
  await rig.revokeStack();
  const refreshed = await refreshDraft(rig, made);
  expect(refreshed.view.outdated).toContain("destination-changed");
  await expectBlocked(rig, refreshed);
});

test("Pulse's refusal at save shows its finding and keeps the draft", async () => {
  const rig = await open(flowDiscussionOutput(flowDraftInvalidDefinition()));
  const made = await makeDraft(rig);
  expect(made.view.draft.fields["/name"]?.value).toBe(FLOW_DRAFT_NAME);
  const response = await rig.call("POST", `${draftPath(made)}/confirm`, { revision: made.view.draft.revision });
  const result = await response.json() as { confirmation: { kind: string; reason?: string } };
  expect(result.confirmation).toMatchObject({ kind: "blocked", reason: expect.stringContaining("missing or empty 'actions' list") });
  const kept = await rig.call("GET", draftPath(made));
  expect((await kept.json() as DraftEditorView).view.draft.fields["/definition"]?.value).toBe(flowDraftInvalidDefinition());
  await expectUnsaved(rig);

  const scheduled = await open(flowDiscussionOutput(`${flowDraftDefinition()}schedule: daily\n`));
  const scheduling = await makeDraft(scheduled);
  const refused = await scheduled.call("POST", `${draftPath(scheduling)}/confirm`, { revision: scheduling.view.draft.revision });
  expect(await refused.json()).toMatchObject({ confirmation: { kind: "blocked", reason: expect.stringContaining("must not have a schedule key") } });
  await expectUnsaved(scheduled);
});

test("a refused save keeps the draft editable, refresh keeps the correction and the corrected draft saves once", async () => {
  const rig = await open(flowDiscussionOutput(flowDraftInvalidDefinition()));
  const made = await makeDraft(rig);
  const refused = await rig.call("POST", `${draftPath(made)}/confirm`, { revision: made.view.draft.revision });
  expect(await refused.json()).toMatchObject({ confirmation: { kind: "blocked", reason: expect.stringContaining("missing or empty 'actions' list") } });
  expect(await rig.savedCount()).toBe(0);
  const held = await (await rig.call("GET", draftPath(made))).json() as DraftEditorView;
  expect(held.receipt).toBeNull();
  expect(held.view.draft.fields["/definition"]?.value).toBe(flowDraftInvalidDefinition());
  const corrected = await editDraft(rig, made, "/definition", { kind: "set", value: flowDraftDefinition() });
  expect(corrected.view.draft.fields["/definition"]).toMatchObject({ origin: "principal", value: flowDraftDefinition() });
  const refreshed = await refreshDraft(rig, corrected);
  expect(refreshed.view.draft.fields["/definition"]).toMatchObject({ origin: "principal", value: flowDraftDefinition() });
  const confirmed = await rig.confirm(refreshed.view.draft);
  expect(confirmed.kind).toBe("accepted");
  if (confirmed.kind !== "accepted") throw new Error(confirmed.reason);
  expect((await rig.journal.read(confirmed.operationId))?.journal.state).toBe("succeeded");
  expect(await rig.savedNames()).toEqual([FLOW_DRAFT_NAME]);
  const savedRevision = (await rig.editor.service.read(refreshed.view.draft.draftId))?.draft.revision ?? 0;
  const locked = await rig.call("PATCH", draftPath(refreshed), { revision: savedRevision, pointer: "/definition", change: { kind: "set", value: flowDraftInvalidDefinition() } });
  expect(locked.status).toBe(409);
  expect(await rig.savedCount()).toBe(1);
});

test("an uncertain save keeps the draft locked with its receipt", async () => {
  const rig = await open();
  const made = await makeDraft(rig);
  rig.pulse.failSaves();
  const confirmed = await rig.confirm(made.view.draft);
  expect(confirmed.kind).toBe("accepted");
  if (confirmed.kind !== "accepted") throw new Error(confirmed.reason);
  expect((await rig.journal.read(confirmed.operationId))?.journal.state).toBe("uncertain");
  const held = await (await rig.call("GET", draftPath(made))).json() as DraftEditorView;
  expect(held.receipt).toMatchObject({ kind: "receipt", state: "uncertain" });
  const locked = await rig.call("PATCH", draftPath(made), { revision: made.view.draft.revision, pointer: "/definition", change: { kind: "set", value: flowDraftDefinition() } });
  expect(locked.status).toBe(409);
  expect(await rig.savedCount()).toBe(0);
});

test("a name that differs from the definition is refused before Pulse and the draft is kept", async () => {
  const rig = await open();
  const made = await makeDraft(rig);
  const renamed = await editDraft(rig, made, "/name", { kind: "set", value: "F_PRINCIPAL_EDIT" });
  const response = await rig.call("POST", `${draftPath(renamed)}/confirm`, { revision: renamed.view.draft.revision });
  expect(await response.json()).toMatchObject({ confirmation: { kind: "blocked", reason: "The name and the flow definition's name differ. Nothing was created." } });
  expect((await rig.editor.service.read(renamed.view.draft.draftId))?.draft.fields["/name"]?.value).toBe("F_PRINCIPAL_EDIT");
  await expectUnsaved(rig);
});

test("unavailable models and local-only sources keep manual editing and withhold derivatives", async () => {
  const rig = await open();
  await expectManualModeKeepsEdits(rig, "/name", () => [], "/definition");
  await expectUnsaved(rig);
});

test("invalid guidance is rejected while the schema stays available for manual editing", async () => {
  const rig = await open();
  const bindings = new DraftingBindings(rig.registry);
  expect(bindings.register({ ...flowSaveDraftingBinding, bindingVersion: "2.0.0" }).ok).toBe(false);
  expect(bindings.register({ ...flowSaveDraftingBinding, fieldHints: [{ pointer: "/invented", role: "detail" }] }).ok).toBe(false);
  expect(bindings.register({ ...flowSaveDraftingBinding, bindingVersion: "1.0.0" }).ok).toBe(false);
  expect(rig.registry.draftingView("flow.saved.create")?.field("/definition")).toBeDefined();
  rig.state.output = { fields: [] };
  let current = await makeDraft(rig);
  expect(current.view.blocking).toContainEqual({ pointer: "/definition", code: "required_missing" });
  current = await editDraft(rig, current, "/definition", { kind: "set", value: flowDraftDefinition() });
  current = await editDraft(rig, current, "/name", { kind: "set", value: FLOW_DRAFT_NAME });
  expect(current.view.status).toBe("ready-for-confirmation");
  await expectUnsaved(rig);
});

test("the exact current revision saves once and reads the Flow back from Pulse", async () => {
  const rig = await open();
  const made = await makeDraft(rig);
  const edited = flowDraftDefinition().replace("  - A_EXAMPLE", "  - A_EXAMPLE\n  - A_REVIEW");
  const current = await editDraft(rig, made, "/definition", { kind: "set", value: edited });
  const stale = await rig.call("POST", `${draftPath(current)}/confirm`, { revision: made.view.draft.revision });
  expect(stale.status).toBe(409);
  await expectUnsaved(rig);
  const confirmed = await rig.confirm(current.view.draft);
  expect(confirmed.kind).toBe("accepted");
  if (confirmed.kind !== "accepted") throw new Error(confirmed.reason);
  expect((await rig.journal.read(confirmed.operationId))?.journal.snapshot).toMatchObject({ input: { name: FLOW_DRAFT_NAME, definition: edited, stack: rig.ref("stack", FLOW_DRAFT_STACK) }, provenance: { revision: current.view.draft.revision } });
  expect(await rig.savedNames()).toEqual([FLOW_DRAFT_NAME]);
  await rig.reopen();
  const reopened = await makeDraft(rig);
  expect(reopened.receipt).toMatchObject({ kind: "receipt", operationId: confirmed.operationId, state: "succeeded" });
  const refused = await rig.call("PATCH", draftPath(reopened), { revision: reopened.view.draft.revision, pointer: "/definition", change: { kind: "set", value: flowDraftDefinition() } });
  expect(refused.status).toBe(409);
  expect(await rig.savedCount()).toBe(1);
});

test("the shared drafting seam carries no Flow field branches", async () => {
  const sources = await Promise.all(["src/surface/mc/desk/draft-editor.ts", "src/surface/mc/api/desk-drafts.ts", "src/conversations/domain-adapters/drafting.ts", "src/surface/mc/desk/owner-draft-entry.ts"].map(path => Bun.file(path).text()));
  for (const source of sources) expect(source).not.toMatch(/"\/definition"|"\/stack"|flow\.saved\.create/i);
});

test("Make through the served route reopens the saved draft and accepts only a valid draft id", async () => {
  const rig = await open();
  await expectServedReopen(rig);
  expect(rig.state.requests).toHaveLength(1);
  await expectUnsaved(rig);
});
