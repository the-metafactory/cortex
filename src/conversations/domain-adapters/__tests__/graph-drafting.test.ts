import { afterEach, expect, test } from "bun:test";
import { CREATE_MAP, CREATE_PARENT, CREATE_REPOSITORY, graphDiscussionOutput, openGraphCreateRig } from "../../../surface/mc/desk/fixtures/graph-create";
import { type DraftEditorView } from "../../../surface/mc/desk/draft-editor-contract";
import { DraftingBindings } from "../drafting";
import { draftPath, editDraft, expectBlockedConfirmation, expectManualModeKeepsEdits, expectRestartReopensDraft, expectStaleRefreshKeepsTitle, makeDraft, ownFields, refreshDraft } from "./fixtures/draft-route";
import { workGraphNodeDraftingBinding } from "../drafting/graph";

type Rig = Awaited<ReturnType<typeof openGraphCreateRig>>;
const rigs: Rig[] = [];
async function open() { const rig = await openGraphCreateRig(); rigs.push(rig); rig.state.output = graphDiscussionOutput(); return rig; }
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
const make = (rig: Rig, extra = {}) => makeDraft(rig, extra);
const expectBlocked = (rig: Rig, view: DraftEditorView) => expectBlockedConfirmation(rig, view, () => rig.soma.calls);

test("graph Make uses trusted guidance, substantive discussion and canonical relationships without filing", async () => {
  const rig = await open();
  const made = await make(rig);
  const draft = made.view.draft;
  expect(draft.fields["/body"]?.value).toMatch(/Problem:[\s\S]*Intended result:[\s\S]*Evidence:[\s\S]*Constraints:/);
  expect(draft.fields["/title"]?.value).toBe("Investigate receipt preservation across restart");
  expect(draft.fields["/checkpoint"]?.value).toBe("receipt-restart-evidence");
  expect(draft.fields["/repository"]).toMatchObject({ origin: "suggested", value: rig.ref("repository", CREATE_REPOSITORY) });
  expect(draft.fields["/parent"]).toMatchObject({ origin: "suggested", value: rig.ref("node", CREATE_MAP) });
  expect(draft.fields["/kind"]).toMatchObject({ origin: "suggested", value: "research" });
  expect(draft.fields["/autonomy"]).toBeUndefined();
  expect(draft.fields["/dependencies"]).toBeUndefined();
  expect(rig.state.requests[0]).toMatchObject({ guidance: workGraphNodeDraftingBinding.guidance, targets: expect.arrayContaining(["/body", "/checkpoint", "/repository"]) });
  expect(made.fields.find(field => field.pointer === "/body")?.long).toBe(true);
  const details = await rig.call("GET", `${draftPath(made)}/details?pointer=/parent`);
  expect(await details.json()).toMatchObject({ details: { sources: [{ id: "turn-example", revision: "1" }], origin: "suggested" } });
  expect(rig.soma.calls).toEqual([]);
});

test("refresh preserves manual fields, clears and compound relationships; restart reopens identity and boundary", async () => {
  const rig = await open();
  const current = await make(rig);
  const draftId = current.view.draft.draftId;
  let edited: DraftEditorView = await editDraft(rig, current, "/title", { kind: "set", value: "Audit restart receipts" });
  edited = await editDraft(rig, edited, "/body", { kind: "omit" });
  edited = await editDraft(rig, edited, "/parent", { kind: "set", value: rig.ref("node", CREATE_PARENT) });
  rig.state.head = "2";
  rig.state.output = graphDiscussionOutput(true);
  const outdated = await rig.editor.service.read(draftId);
  expect(outdated?.outdated).toContain("conversation-changed");
  edited = await refreshDraft(rig, edited);
  expect(edited.view.draft.fields["/title"]?.value).toBe("Audit restart receipts");
  expect(edited.view.draft.fields["/body"]).toMatchObject({ presence: "absent", origin: "principal" });
  expect(edited.view.draft.fields["/parent"]?.value).toEqual(rig.ref("node", CREATE_PARENT));
  await expectRestartReopensDraft(rig, draftId, edited.view.draft);
  expect(rig.soma.calls).toEqual([]);
});

test("untouched body refreshes; stale results cannot overwrite a later edit", async () => {
  const rig = await open();
  const made = await make(rig);
  rig.state.head = "2";
  rig.state.items.push({ id: "outcome-example", revision: "2", digest: "outcome-2", kind: "outcome", restriction: "cloud", text: "Include a crash immediately after acceptance.", at: "2026-11-09T12:00:00.000Z" });
  rig.state.output = graphDiscussionOutput(true);
  const updated = await refreshDraft(rig, made);
  expect(updated.view.draft.fields["/body"]?.value).toContain("crash immediately after acceptance");
  await expectStaleRefreshKeepsTitle(rig, updated);
  expect(rig.soma.calls).toEqual([]);
});

test("manual relationship labels resolve canonically, flag destination changes and require refresh", async () => {
  const rig = await open();
  const made = await make(rig);
  const response = await rig.call("POST", `${draftPath(made)}/references`, { revision: made.view.draft.revision, pointer: "/parent", labels: [CREATE_PARENT] });
  const changed = await response.json() as DraftEditorView;
  expect(changed.view.draft.fields["/parent"]).toMatchObject({ origin: "principal", value: rig.ref("node", CREATE_PARENT) });
  expect(changed.view.outdated).toContain("destination-changed");
  expect(changed.destinationChanges).toHaveLength(1);
  expect(await rig.confirm(changed.view.draft)).toMatchObject({ kind: "blocked" });
  const updated = await refreshDraft(rig, changed);
  expect(updated.view.outdated).not.toContain("destination-changed");
  expect(updated.view.draft.fields["/parent"]?.value).toEqual(rig.ref("node", CREATE_PARENT));
  expect(rig.soma.calls).toEqual([]);
});

test("unavailable models and revoked or local-only sources keep manual edits and withhold derivatives", async () => {
  const rig = await open();
  await expectManualModeKeepsEdits(rig, "/body", () => rig.soma.calls);
});

test("invalid graph guidance is rejected while the schema remains available for manual editing", async () => {
  const rig = await open();
  const bindings = new DraftingBindings(rig.registry);
  expect(bindings.register({ ...workGraphNodeDraftingBinding, bindingVersion: "2.0.0" }).ok).toBe(false);
  expect(bindings.register({ ...workGraphNodeDraftingBinding, fieldHints: [{ pointer: "/invented", role: "detail" }] }).ok).toBe(false);
  expect(rig.registry.draftingView("work-graph.node.create")?.field("/body")).toBeDefined();
  const missing = graphDiscussionOutput();
  rig.state.output = { fields: missing.fields.filter(field => field.pointer !== "/checkpoint") };
  let current: DraftEditorView = await make(rig);
  expect(current.view.blocking).toContainEqual({ pointer: "/checkpoint", code: "required_missing" });
  current = await editDraft(rig, current, "/checkpoint", { kind: "set", value: "manual-evidence" });
  expect(current.view.status).toBe("ready-for-confirmation");
  expect(rig.soma.calls).toEqual([]);
});

test("the exact current revision hands off once and Make reopens its preserved receipt after restart", async () => {
  const rig = await open();
  const made = await make(rig);
  const edited = await editDraft(rig, made, "/body", { kind: "set", value: "Principal's precise body" });
  const stale = await rig.call("POST", `${draftPath(edited)}/confirm`, { revision: made.view.draft.revision });
  expect(stale.status).toBe(409);
  expect(rig.soma.calls).toEqual([]);
  const result = await rig.confirm(edited.view.draft);
  expect(result.kind).toBe("accepted");
  if (result.kind !== "accepted") throw new Error(result.reason);
  expect((await rig.journal.read(result.operationId))?.journal.snapshot).toMatchObject({ input: { body: "Principal's precise body", autonomy: "approve", kind: "research" }, provenance: { revision: edited.view.draft.revision } });
  await rig.reopen();
  const reopened = await make(rig);
  expect(reopened.receipt).toMatchObject({ kind: "receipt", operationId: result.operationId, state: "succeeded" });
  const refusedEdit = await rig.call("PATCH", draftPath(reopened), { revision: reopened.view.draft.revision, pointer: "/title", change: { kind: "set", value: "Do not create another" } });
  expect(refusedEdit.status).toBe(409);
  expect(rig.soma.calls).toHaveLength(1);
  rig.state.sessionEnabled = false;
  const withheld = await make(rig);
  expect(withheld.receipt).toEqual({ kind: "withheld" });
});

test("manual ambiguous references keep authorized alternatives and failure cannot clear destination review", async () => {
  const rig = await open();
  const made = await make(rig);
  const response = await rig.call("POST", `${draftPath(made)}/references`, { revision: made.view.draft.revision, pointer: "/parent", labels: ["Shared title"] });
  const changed = await response.json() as DraftEditorView;
  expect(changed.view.draft.fields["/parent"]?.unresolved).toBe("ambiguous_reference");
  const details = await rig.call("GET", `${draftPath(changed)}/details?pointer=/parent`);
  expect((await details.json() as { details: { alternatives: unknown[] } }).details.alternatives).toHaveLength(2);
  rig.state.modelFails = true;
  const failed = await refreshDraft(rig, changed);
  expect(failed.view.outdated).toContain("destination-changed");
  await expectBlocked(rig, failed);
});

const invalidDestinations = [
  { name: "unknown parent", pointer: "/parent", value: (rig: Rig) => rig.ref("node", `${CREATE_REPOSITORY}#999`) },
  { name: "ambiguous parent", pointer: "/parent", value: (rig: Rig) => rig.ref("node", "Shared title") },
  { name: "noncanonical parent", pointer: "/parent", value: (rig: Rig) => rig.ref("node", "Lifecycle map") },
  { name: "foreign connection", pointer: "/parent", value: (rig: Rig) => ({ ...rig.ref("node", CREATE_MAP), connectionId: "another-connection" }) },
  { name: "malformed parent", pointer: "/parent", value: () => ({ canonicalId: CREATE_MAP }) },
  { name: "unknown dependency", pointer: "/dependencies", value: (rig: Rig) => [rig.ref("node", CREATE_MAP), rig.ref("node", `${CREATE_REPOSITORY}#999`)] },
];
for (const generate of [false, true]) for (const scenario of invalidDestinations) test(`refresh keeps ${scenario.name} blocked with generation ${generate}`, async () => {
  const rig = await open();
  let current = generate ? await make(rig) : await ownFields(rig);
  const invalid = scenario.value(rig);
  current = await editDraft(rig, current, scenario.pointer, { kind: "set", value: invalid });
  if (!generate) rig.state.lanes = [];
  current = await refreshDraft(rig, current);
  expect(current.view.outdated).toContain("destination-changed");
  expect(current.view.draft.fields[scenario.pointer]).toMatchObject({ origin: "principal", value: invalid });
  expect((await rig.editor.service.handoff(current.view.draft.draftId, current.view.draft.revision)).ok).toBe(false);
  await expectBlocked(rig, current);
});

test("refresh retains destination review when its repository is revoked", async () => {
  const rig = await open();
  let current = await ownFields(rig);
  await rig.untick(CREATE_REPOSITORY);
  rig.state.lanes = [];
  current = await refreshDraft(rig, current);
  expect(current.view.outdated).toContain("destination-changed");
  await expectBlocked(rig, current);
});

test("explicit refresh revalidates fully owned destinations without needing a model", async () => {
  const rig = await open();
  let current = await ownFields(rig);
  expect(current.view.draft.limitations.filter(item => item.code === "destination_changed")).toHaveLength(1);
  expect(current.view.outdated).toContain("destination-changed");
  rig.state.lanes = [];
  const requests = rig.state.requests.length;
  const reads = rig.reads.length;
  current = await refreshDraft(rig, current);
  expect(current.view.outdated).not.toContain("destination-changed");
  expect(current.view.status).toBe("ready-for-confirmation");
  expect(rig.state.requests).toHaveLength(requests);
  expect(rig.reads.length).toBeGreaterThan(reads);
  expect(rig.soma.calls).toEqual([]);
});
