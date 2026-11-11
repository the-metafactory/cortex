import { afterEach, expect, test } from "bun:test";
import { DRAFT_GLIDER_PROJECT, DRAFT_HOME_GLIDER_PROJECT, DRAFT_HOME_AREA, DRAFT_LAB_AREA, balanceDiscussionOutput, conflictingDueOutput, openBalanceDraftRig } from "../balance/fixtures/balance-draft";
import { DraftingBindings } from "../drafting";
import { balanceTaskDraftingBinding } from "../drafting/balance";
import type { DraftEditorView } from "../../../surface/mc/desk/draft-editor-contract";
import { draftPath, editDraft, expectBlockedConfirmation, expectManualModeKeepsEdits, makeDraft, ownFields, refreshDraft } from "./fixtures/draft-route";

type Rig = Awaited<ReturnType<typeof openBalanceDraftRig>>;
const rigs: Rig[] = [];
async function open(output = balanceDiscussionOutput()) { const rig = await openBalanceDraftRig(); rigs.push(rig); rig.state.output = output; return rig; }
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
const expectUntouched = (rig: Rig, outline: string) => {
  expect(rig.ownerCalls).toEqual([]);
  expect(rig.outlineSnapshot()).toBe(outline);
};
const expectBlocked = (rig: Rig, view: DraftEditorView) => expectBlockedConfirmation(rig, view, () => rig.ownerCalls);

test("Balance Make uses trusted guidance and drafts a useful title, note and typed fields with provenance and no task", async () => {
  const rig = await open();
  const outline = rig.outlineSnapshot();
  const made = await makeDraft(rig);
  const draft = made.view.draft;
  expect(draft.fields["/title"]).toMatchObject({ origin: "generated", value: "Cut the glider wing before the workshop", citations: ["turn-example"] });
  expect(draft.fields["/note"]?.value).toMatch(/What:[\s\S]*Why:[\s\S]*Constraints:[\s\S]*Open question:/);
  expect(draft.fields["/due"]).toMatchObject({ origin: "suggested", value: "2026-11-13", citations: ["turn-example"] });
  expect(draft.fields["/area"]).toMatchObject({ origin: "suggested", value: rig.ref("area", DRAFT_LAB_AREA) });
  expect(draft.fields["/project"]).toMatchObject({ origin: "suggested", value: rig.ref("project", DRAFT_GLIDER_PROJECT) });
  expect(rig.state.requests[0]).toMatchObject({ guidance: balanceTaskDraftingBinding.guidance, targets: expect.arrayContaining(["/title", "/note", "/due", "/area"]) });
  expect(made.fields.find(field => field.pointer === "/note")?.long).toBe(true);
  expect(made.view.status).toBe("ready-for-confirmation");
  const details = await rig.call("GET", `${draftPath(made)}/details?pointer=/project`);
  expect(await details.json()).toMatchObject({ details: { sources: [{ id: "turn-example", revision: "1" }], origin: "suggested" } });
  expectUntouched(rig, outline);
});

test("canonical resolution takes ids and unambiguous labels; titles never become identity", async () => {
  const rig = await open();
  expect(await rig.resolve("Lab", "area")).toEqual({ kind: "unique", ref: rig.ref("area", DRAFT_LAB_AREA) });
  expect(await rig.resolve(DRAFT_HOME_AREA, "area")).toEqual({ kind: "unique", ref: rig.ref("area", DRAFT_HOME_AREA) });
  expect(await rig.resolve("Lab / Glider")).toEqual({ kind: "unique", ref: rig.ref("project", DRAFT_GLIDER_PROJECT) });
  expect(await rig.resolve(DRAFT_GLIDER_PROJECT)).toEqual({ kind: "unique", ref: rig.ref("project", DRAFT_GLIDER_PROJECT) });
  expect(await rig.resolve("Glider")).toEqual({ kind: "multiple", refs: [rig.ref("project", DRAFT_GLIDER_PROJECT), rig.ref("project", DRAFT_HOME_GLIDER_PROJECT)] });
  expect(await rig.resolve("Lab / Shared")).toMatchObject({ kind: "multiple" });
  expect(await rig.resolve("Kitten")).toEqual({ kind: "none" });
  expect(await rig.resolve("Lab", "task")).toEqual({ kind: "unavailable" });
});

test("equally named, unknown and foreign-account destinations stay unresolved and are never invented", async () => {
  const outline = (await open()).outlineSnapshot();
  for (const [labels, code] of [[["Glider"], "ambiguous_reference"], [["Shared"], "ambiguous_reference"], [["Nowhere"], "missing_reference"]] as const) {
    const rig = await open({ fields: balanceDiscussionOutput().fields.map(field => field.pointer === "/project" ? { ...field, labels: [...labels] } : field) });
    const made = await makeDraft(rig);
    expect(made.view.draft.fields["/project"]).toMatchObject({ presence: "absent", unresolved: code, origin: "suggested" });
    expect(made.view.blocking).toContainEqual({ pointer: "/project", code: "unresolved" });
    await expectBlocked(rig, made);
    expect(rig.outlineSnapshot()).toBe(outline);
  }
  const rig = await open();
  const made = await makeDraft(rig);
  const foreign = await editDraft(rig, made, "/area", { kind: "set", value: { ...rig.ref("area", DRAFT_LAB_AREA), connectionId: "another-account" } });
  expect(foreign.view.draft.fields["/area"]).toMatchObject({ origin: "principal" });
  const refreshed = await refreshDraft(rig, foreign);
  expect(refreshed.view.outdated).toContain("destination-changed");
  await expectBlocked(rig, refreshed);
});

test("a project outside the chosen area blocks the hand-off", async () => {
  const rig = await open({ fields: balanceDiscussionOutput().fields.map(field => field.pointer === "/project" ? { ...field, labels: ["Home / Glider"] } : field) });
  const made = await makeDraft(rig);
  expect(made.view.draft.fields["/project"]?.value).toEqual(rig.ref("project", DRAFT_HOME_GLIDER_PROJECT));
  const response = await rig.call("POST", `${draftPath(made)}/confirm`, { revision: made.view.draft.revision });
  expect(await response.json()).toMatchObject({ confirmation: { kind: "blocked", reason: "The project is not open in the chosen area; review the draft again." } });
  expect(rig.ownerCalls).toEqual([]);
});

test("missing optional due stays absent and conflicting dates need an explicit choice or omission", async () => {
  const absent = await open({ fields: balanceDiscussionOutput().fields.filter(field => field.pointer !== "/due") });
  const made = await makeDraft(absent);
  expect(made.view.draft.fields["/due"]).toBeUndefined();
  expect(made.view.status).toBe("ready-for-confirmation");

  const rig = await open(conflictingDueOutput());
  let current = await makeDraft(rig);
  expect(current.view.draft.fields["/due"]).toMatchObject({ presence: "absent", unresolved: "conflict", origin: "suggested" });
  expect(current.view.draft.fields["/due"]?.alternatives.map(item => item.value)).toEqual(["2026-11-13", "2026-11-20"]);
  expect(current.view.blocking).toContainEqual({ pointer: "/due", code: "unresolved" });
  await expectBlocked(rig, current);
  current = await editDraft(rig, current, "/due", { kind: "set", value: "2026-11-20" });
  expect(current.view.draft.fields["/due"]).toMatchObject({ origin: "principal", value: "2026-11-20" });
  expect(current.view.status).toBe("ready-for-confirmation");
  const omitting = await makeDraft(rig, { newDraft: true });
  const omitted = await editDraft(rig, omitting, "/due", { kind: "omit" });
  expect(omitted.view.blocking).toEqual([]);
  expect(rig.ownerCalls).toEqual([]);
});

test("an edited title and a deliberately cleared note survive explicit refresh and host restart; untouched fields update", async () => {
  const rig = await open();
  const outline = rig.outlineSnapshot();
  let current = await makeDraft(rig);
  const draftId = current.view.draft.draftId;
  current = await editDraft(rig, current, "/title", { kind: "set", value: "Audit the wing cut" });
  current = await editDraft(rig, current, "/note", { kind: "omit" });
  rig.state.head = "2";
  rig.state.items.push({ id: "outcome-example", revision: "2", digest: "outcome-2", kind: "outcome", restriction: "cloud", text: "Add a fitting check after cutting.", at: "2026-11-09T12:00:00.000Z" });
  rig.state.output = balanceDiscussionOutput(true);
  const outdated = await rig.editor.service.read(draftId);
  expect(outdated?.outdated).toContain("conversation-changed");
  expect(outdated?.draft.fields["/title"]?.value).toBe("Audit the wing cut");
  current = await refreshDraft(rig, current);
  expect(current.view.draft.fields["/title"]).toMatchObject({ origin: "principal", value: "Audit the wing cut" });
  expect(current.view.draft.fields["/note"]).toMatchObject({ presence: "absent", origin: "principal" });
  expect(current.view.draft.fields["/due"]?.value).toBe("2026-11-13");
  const snapshot = current.view.draft;
  const generations = rig.state.requests.length;
  await rig.reopen();
  const reopened = await makeDraft(rig);
  expect(reopened.reopened).toBe(true);
  expect(reopened.view.draft).toEqual(snapshot);
  expect(rig.state.requests).toHaveLength(generations);
  expect((await makeDraft(rig, { newDraft: true })).view.draft.draftId).not.toBe(draftId);
  expectUntouched(rig, outline);
});

test("an untouched note refreshes with later turns while a stale model result cannot overwrite a later edit", async () => {
  const rig = await open();
  const made = await makeDraft(rig);
  rig.state.head = "2";
  rig.state.output = balanceDiscussionOutput(true);
  const updated = await refreshDraft(rig, made);
  expect(updated.view.draft.fields["/note"]?.value).toContain("fitting check");
  rig.state.onGenerate = async () => { rig.state.onGenerate = undefined; await editDraft(rig, updated, "/title", { kind: "set", value: "Edited during generation" }); };
  const stale = await rig.call("POST", `${draftPath(updated)}/refresh`, { revision: updated.view.draft.revision });
  expect(stale.status).toBe(409);
  expect((await rig.editor.service.read(updated.view.draft.draftId))?.draft.fields["/title"]?.value).toBe("Edited during generation");
  expect(rig.ownerCalls).toEqual([]);
});

test("destination changes keep edits, flag incompatibilities and require refresh before confirmation", async () => {
  const rig = await open();
  const made = await makeDraft(rig);
  const response = await rig.call("POST", `${draftPath(made)}/references`, { revision: made.view.draft.revision, pointer: "/area", labels: ["Home"] });
  const changed = await response.json() as DraftEditorView;
  expect(changed.view.draft.fields["/area"]).toMatchObject({ origin: "principal", value: rig.ref("area", DRAFT_HOME_AREA) });
  expect(changed.view.draft.fields["/title"]?.value).toBe("Cut the glider wing before the workshop");
  expect(changed.view.outdated).toContain("destination-changed");
  expect(changed.destinationChanges).toHaveLength(1);
  await expectBlocked(rig, changed);
  const updated = await refreshDraft(rig, changed);
  expect(updated.view.outdated).not.toContain("destination-changed");
  expect(updated.view.draft.fields["/area"]?.value).toEqual(rig.ref("area", DRAFT_HOME_AREA));
  const mismatch = await rig.call("POST", `${draftPath(updated)}/confirm`, { revision: updated.view.draft.revision });
  expect(await mismatch.json()).toMatchObject({ confirmation: { kind: "blocked", reason: expect.stringContaining("not open in the chosen area") } });
  expect(rig.ownerCalls).toEqual([]);
});

test("unavailable models and revoked or local-only sources keep manual editing and withhold derivatives", async () => {
  const rig = await open();
  await expectManualModeKeepsEdits(rig, "/note", () => rig.ownerCalls);
});

test("invalid guidance is rejected, required fields stay editable by hand", async () => {
  const rig = await open();
  const bindings = new DraftingBindings(rig.registry);
  expect(bindings.register({ ...balanceTaskDraftingBinding, bindingVersion: "2.0.0" }).ok).toBe(false);
  expect(bindings.register({ ...balanceTaskDraftingBinding, fieldHints: [{ pointer: "/invented", role: "detail" }] }).ok).toBe(false);
  expect(bindings.register({ ...balanceTaskDraftingBinding, fieldHints: [{ pointer: "/due", role: "destination", resolveWith: "balance.destinations" }] }).ok).toBe(false);
  rig.state.output = { fields: balanceDiscussionOutput().fields.filter(field => field.pointer !== "/title" && field.pointer !== "/area") };
  let current = await makeDraft(rig);
  expect(current.view.blocking).toEqual(expect.arrayContaining([{ pointer: "/title", code: "required_missing" }, { pointer: "/area", code: "required_missing" }]));
  current = await editDraft(rig, current, "/title", { kind: "set", value: "Manual title" });
  const areaResponse = await rig.call("POST", `${draftPath(current)}/references`, { revision: current.view.draft.revision, pointer: "/area", labels: ["Lab"] });
  current = await areaResponse.json() as DraftEditorView;
  current = await refreshDraft(rig, current);
  expect(current.view.blocking).toEqual([]);
  expect(rig.ownerCalls).toEqual([]);
});

test("the exact current revision hands off once; Make then shows the preserved receipt after restart without a second write", async () => {
  const rig = await open();
  const made = await makeDraft(rig);
  const edited = await editDraft(rig, made, "/note", { kind: "set", value: "Principal's precise note" });
  const stale = await rig.call("POST", `${draftPath(edited)}/confirm`, { revision: made.view.draft.revision });
  expect(stale.status).toBe(409);
  expect(rig.ownerCalls).toEqual([]);
  const before = rig.taskCount();
  const confirmed = await rig.call("POST", `${draftPath(edited)}/confirm`, { revision: edited.view.draft.revision });
  const result = await confirmed.json() as { confirmation: { kind: string; operationId: string } };
  expect(result.confirmation).toMatchObject({ kind: "accepted" });
  expect((await rig.journal.read(result.confirmation.operationId))?.journal.snapshot).toMatchObject({ input: { note: "Principal's precise note", title: "Cut the glider wing before the workshop", due: "2026-11-13", area: rig.ref("area", DRAFT_LAB_AREA), project: rig.ref("project", DRAFT_GLIDER_PROJECT) }, provenance: { revision: edited.view.draft.revision } });
  expect(rig.taskCount()).toBe(before + 1);
  await rig.reopen();
  const reopened = await makeDraft(rig);
  expect(reopened.receipt).toMatchObject({ kind: "receipt", operationId: result.confirmation.operationId, state: "succeeded" });
  const refusedEdit = await rig.call("PATCH", draftPath(reopened), { revision: reopened.view.draft.revision, pointer: "/title", change: { kind: "set", value: "Do not create another" } });
  expect(refusedEdit.status).toBe(409);
  expect(rig.ownerCalls).toHaveLength(1);
  expect(rig.taskCount()).toBe(before + 1);
  rig.state.sessionEnabled = false;
  expect((await makeDraft(rig)).receipt).toEqual({ kind: "withheld" });
});

test("a revoked area or a local-only area blocks confirmation, leaving the draft editable", async () => {
  const rig = await open();
  const owned = await ownFields(rig);
  await rig.restrict(DRAFT_LAB_AREA, { status: "revoked" });
  rig.state.lanes = [];
  const refreshed = await refreshDraft(rig, owned);
  expect(refreshed.view.outdated).toContain("destination-changed");
  await expectBlocked(rig, refreshed);

  const local = await open();
  await local.localArea(DRAFT_LAB_AREA);
  const made = await makeDraft(local);
  await expectBlocked(local, made);
});

test("the shared drafting seam carries no Balance field branches", async () => {
  const sources = await Promise.all(["src/surface/mc/desk/draft-editor.ts", "src/surface/mc/api/desk-drafts.ts", "src/conversations/domain-adapters/drafting.ts", "src/surface/mc/desk/owner-draft-entry.ts"].map(path => Bun.file(path).text()));
  for (const source of sources) expect(source).not.toMatch(/balance|"\/note"|"\/due"|"\/area"|"\/project"/i);
});

test("Make through the served route reopens the saved draft and accepts only a valid draft id", async () => {
  const rig = await open();
  const server = rig.serve();
  const first = await (await server.call("POST", "/api/desk/drafts", rig.makeInput)).json() as DraftEditorView;
  const again = await (await server.call("POST", "/api/desk/drafts", rig.makeInput)).json() as DraftEditorView & { reopened: boolean };
  expect(again.reopened).toBe(true);
  expect(again.view.draft.draftId).toBe(first.view.draft.draftId);
  expect(rig.state.requests).toHaveLength(1);
  expect(rig.ownerCalls).toEqual([]);
});
