import { afterEach, expect, test } from "bun:test";
import { CREATE_MAP, CREATE_PARENT, CREATE_REPOSITORY, graphDiscussionOutput, openGraphCreateRig } from "../work-graph/fixtures/graph-create";
import { DESK_DRAFTS_PATH, type DraftEditorView } from "../../../surface/mc/desk/draft-editor-contract";
import { DraftingBindings } from "../drafting";
import { workGraphNodeDraftingBinding } from "../drafting/graph";

type Rig = Awaited<ReturnType<typeof openGraphCreateRig>>;
const rigs: Rig[] = [];
async function open() { const rig = await openGraphCreateRig(); rigs.push(rig); rig.state.output = graphDiscussionOutput(); return rig; }
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
async function make(rig: Rig, extra = {}): Promise<DraftEditorView & { reopened: boolean }> {
  const response = await rig.call("POST", DESK_DRAFTS_PATH, { ...rig.makeInput, ...extra });
  expect(response.status).toBe(200);
  return await response.json();
}
const path = (view: DraftEditorView) => `${DESK_DRAFTS_PATH}/${view.view.draft.draftId}`;
async function edit(rig: Rig, view: DraftEditorView, pointer: string, change: unknown): Promise<DraftEditorView> {
  const response = await rig.call("PATCH", path(view), { revision: view.view.draft.revision, pointer, change });
  expect(response.status).toBe(200);
  return await response.json();
}
async function refresh(rig: Rig, view: DraftEditorView): Promise<DraftEditorView> {
  const response = await rig.call("POST", `${path(view)}/refresh`, { revision: view.view.draft.revision });
  expect(response.status).toBe(200);
  return await response.json();
}

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
  const details = await rig.call("GET", `${path(made)}/details?pointer=/parent`);
  expect(await details.json()).toMatchObject({ details: { sources: [{ id: "turn-example", revision: "1" }], origin: "suggested" } });
  expect(rig.soma.calls).toEqual([]);
});

test("refresh preserves manual fields, clears and compound relationships; restart reopens identity and boundary", async () => {
  const rig = await open();
  let current = await make(rig);
  const draftId = current.view.draft.draftId;
  let edited: DraftEditorView = await edit(rig, current, "/title", { kind: "set", value: "Audit restart receipts" });
  edited = await edit(rig, edited, "/body", { kind: "omit" });
  edited = await edit(rig, edited, "/parent", { kind: "set", value: rig.ref("node", CREATE_PARENT) });
  rig.state.head = "2";
  rig.state.output = graphDiscussionOutput(true);
  const outdated = await rig.editor.service.read(draftId);
  expect(outdated?.outdated).toContain("conversation-changed");
  edited = await refresh(rig, edited);
  expect(edited.view.draft.fields["/title"]?.value).toBe("Audit restart receipts");
  expect(edited.view.draft.fields["/body"]).toMatchObject({ presence: "absent", origin: "principal" });
  expect(edited.view.draft.fields["/parent"]?.value).toEqual(rig.ref("node", CREATE_PARENT));
  const snapshot = edited.view.draft;
  const generations = rig.state.requests.length;
  await rig.reopen();
  current = await make(rig);
  expect(current.reopened).toBe(true);
  expect(current.view.draft).toEqual(snapshot);
  expect(rig.state.requests).toHaveLength(generations);
  const fresh = await make(rig, { newDraft: true });
  expect(fresh.view.draft.draftId).not.toBe(draftId);
  expect(rig.soma.calls).toEqual([]);
});

test("untouched body refreshes; stale results cannot overwrite a later edit", async () => {
  const rig = await open();
  const made = await make(rig);
  rig.state.head = "2";
  rig.state.items.push({ id: "outcome-example", revision: "2", digest: "outcome-2", kind: "outcome", restriction: "cloud", text: "Include a crash immediately after acceptance.", at: "2026-11-09T12:00:00.000Z" });
  rig.state.output = graphDiscussionOutput(true);
  const updated = await refresh(rig, made);
  expect(updated.view.draft.fields["/body"]?.value).toContain("crash immediately after acceptance");
  rig.state.onGenerate = async () => { rig.state.onGenerate = undefined; await edit(rig, updated, "/title", { kind: "set", value: "Edited during generation" }); };
  const stale = await rig.call("POST", `${path(updated)}/refresh`, { revision: updated.view.draft.revision });
  expect(stale.status).toBe(409);
  expect((await rig.editor.service.read(updated.view.draft.draftId))?.draft.fields["/title"]?.value).toBe("Edited during generation");
  expect(rig.soma.calls).toEqual([]);
});

test("manual relationship labels resolve canonically, flag destination changes and require refresh", async () => {
  const rig = await open();
  const made = await make(rig);
  const response = await rig.call("POST", `${path(made)}/references`, { revision: made.view.draft.revision, pointer: "/parent", labels: [CREATE_PARENT] });
  const changed = await response.json() as DraftEditorView;
  expect(changed.view.draft.fields["/parent"]).toMatchObject({ origin: "principal", value: rig.ref("node", CREATE_PARENT) });
  expect(changed.view.outdated).toContain("destination-changed");
  expect(changed.destinationChanges).toHaveLength(1);
  const denied = await rig.call("POST", `${path(changed)}/confirm`, { revision: changed.view.draft.revision });
  expect(await denied.json()).toMatchObject({ confirmation: { kind: "blocked" } });
  const updated = await refresh(rig, changed);
  expect(updated.view.outdated).not.toContain("destination-changed");
  expect(updated.view.draft.fields["/parent"]?.value).toEqual(rig.ref("node", CREATE_PARENT));
  expect(rig.soma.calls).toEqual([]);
});

test("unavailable models and revoked or local-only sources keep manual edits and withhold derivatives", async () => {
  const rig = await open();
  const edited = await edit(rig, await make(rig), "/title", { kind: "set", value: "Manual title" });
  rig.state.modelFails = true;
  const failure = await refresh(rig, edited);
  expect(failure.view.draft.fields["/title"]?.value).toBe("Manual title");
  expect(failure.view.draft.limitations.length).toBeGreaterThan(0);
  rig.state.localOnly = true;
  const calls = rig.state.requests.length;
  const local = await refresh(rig, failure);
  expect(local.view.draft.limitations).toMatchObject([{ code: "model_unavailable" }]);
  expect(rig.state.requests).toHaveLength(calls);
  expect(local.view.withheld).toContain("/body");
  rig.state.sourceAvailable = false;
  const deniedDetails = await rig.call("GET", `${path(local)}/details?pointer=/body`);
  expect(await deniedDetails.json()).toMatchObject({ details: { sources: [], hiddenSources: 1 } });
  const denied = await rig.call("POST", `${path(local)}/confirm`, { revision: local.view.draft.revision });
  expect(await denied.json()).toMatchObject({ confirmation: { kind: "blocked" } });
  expect(rig.soma.calls).toEqual([]);
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
  current = await edit(rig, current, "/checkpoint", { kind: "set", value: "manual-evidence" });
  expect(current.view.status).toBe("ready-for-confirmation");
  expect(rig.soma.calls).toEqual([]);
});

test("the exact current revision hands off once and Make reopens its preserved receipt after restart", async () => {
  const rig = await open();
  const made = await make(rig);
  const edited = await edit(rig, made, "/body", { kind: "set", value: "Principal's precise body" });
  const stale = await rig.call("POST", `${path(edited)}/confirm`, { revision: made.view.draft.revision });
  expect(stale.status).toBe(409);
  expect(rig.soma.calls).toEqual([]);
  const confirmed = await rig.call("POST", `${path(edited)}/confirm`, { revision: edited.view.draft.revision });
  const result = await confirmed.json() as { confirmation: { kind: string; operationId: string } };
  expect(result.confirmation.kind).toBe("accepted");
  expect((await rig.journal.read(result.confirmation.operationId))?.journal.snapshot).toMatchObject({ input: { body: "Principal's precise body", autonomy: "approve", kind: "research" }, provenance: { revision: edited.view.draft.revision } });
  await rig.reopen();
  const reopened = await make(rig);
  expect(reopened.receipt).toMatchObject({ kind: "receipt", operationId: result.confirmation.operationId, state: "succeeded" });
  const refusedEdit = await rig.call("PATCH", path(reopened), { revision: reopened.view.draft.revision, pointer: "/title", change: { kind: "set", value: "Do not create another" } });
  expect(refusedEdit.status).toBe(409);
  expect(rig.soma.calls).toHaveLength(1);
  rig.state.sessionEnabled = false;
  const withheld = await make(rig);
  expect(withheld.receipt).toEqual({ kind: "withheld" });
});

test("manual ambiguous references keep authorized alternatives and failure cannot clear destination review", async () => {
  const rig = await open();
  const made = await make(rig);
  const response = await rig.call("POST", `${path(made)}/references`, { revision: made.view.draft.revision, pointer: "/parent", labels: ["Shared title"] });
  const changed = await response.json() as DraftEditorView;
  expect(changed.view.draft.fields["/parent"]?.unresolved).toBe("ambiguous_reference");
  const details = await rig.call("GET", `${path(changed)}/details?pointer=/parent`);
  expect((await details.json() as { details: { alternatives: unknown[] } }).details.alternatives).toHaveLength(2);
  rig.state.modelFails = true;
  const failed = await refresh(rig, changed);
  expect(failed.view.outdated).toContain("destination-changed");
  const denied = await rig.call("POST", `${path(failed)}/confirm`, { revision: failed.view.draft.revision });
  expect(await denied.json()).toMatchObject({ confirmation: { kind: "blocked" } });
  expect(rig.soma.calls).toEqual([]);
});

test("explicit refresh revalidates fully owned destinations without needing a model", async () => {
  const rig = await open();
  let current: DraftEditorView = await make(rig);
  for (const field of current.fields) {
    const value = current.view.draft.fields[field.pointer];
    current = await edit(rig, current, field.pointer, value?.presence === "present" ? { kind: "set", value: value.value } : { kind: "omit" });
  }
  expect(current.view.outdated).toContain("destination-changed");
  rig.state.lanes = [];
  const requests = rig.state.requests.length;
  current = await refresh(rig, current);
  expect(current.view.outdated).not.toContain("destination-changed");
  expect(current.view.status).toBe("ready-for-confirmation");
  expect(rig.state.requests).toHaveLength(requests);
  expect(rig.soma.calls).toEqual([]);
});
