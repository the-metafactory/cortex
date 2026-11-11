import { expect } from "bun:test";
import { DESK_DRAFTS_PATH, type DraftEditorView } from "../../../../surface/mc/desk/draft-editor-contract";
import type { DraftClient } from "../../../../surface/mc/desk/fixtures/owner-draft";
import type { DeskDraftEditor } from "../../../../surface/mc/desk/draft-editor";

export interface DraftRouteRig extends DraftClient {
  readonly makeInput: unknown;
}

export type MadeDraft = DraftEditorView & { reopened?: boolean };

export async function makeDraft(rig: DraftRouteRig, extra = {}): Promise<MadeDraft> {
  const response = await rig.call("POST", DESK_DRAFTS_PATH, { ...rig.makeInput as object, ...extra });
  expect(response.status).toBe(200);
  return await response.json();
}

export const draftPath = (view: DraftEditorView): string => `${DESK_DRAFTS_PATH}/${view.view.draft.draftId}`;

export async function editDraft(rig: DraftRouteRig, view: DraftEditorView, pointer: string, change: unknown): Promise<DraftEditorView> {
  const response = await rig.call("PATCH", draftPath(view), { revision: view.view.draft.revision, pointer, change });
  expect(response.status).toBe(200);
  return await response.json();
}

export async function refreshDraft(rig: DraftRouteRig, view: DraftEditorView): Promise<DraftEditorView> {
  const response = await rig.call("POST", `${draftPath(view)}/refresh`, { revision: view.view.draft.revision });
  expect(response.status).toBe(200);
  return await response.json();
}

export async function expectStaleRefreshKeepsTitle(rig: DraftRouteRig & { readonly editor: DeskDraftEditor; readonly state: { onGenerate: undefined | (() => Promise<void>) } }, view: DraftEditorView): Promise<void> {
  rig.state.onGenerate = async () => { rig.state.onGenerate = undefined; await editDraft(rig, view, "/title", { kind: "set", value: "Edited during generation" }); };
  const stale = await rig.call("POST", `${draftPath(view)}/refresh`, { revision: view.view.draft.revision });
  expect(stale.status).toBe(409);
  expect((await rig.editor.service.read(view.view.draft.draftId))?.draft.fields["/title"]?.value).toBe("Edited during generation");
}

export async function ownFields(rig: DraftRouteRig): Promise<DraftEditorView> {
  let current: DraftEditorView = await makeDraft(rig);
  for (const field of current.fields) {
    const value = current.view.draft.fields[field.pointer];
    current = await editDraft(rig, current, field.pointer, value?.presence === "present" ? { kind: "set", value: value.value } : { kind: "omit" });
  }
  return current;
}

export async function expectBlockedConfirmation(rig: DraftRouteRig, view: DraftEditorView, mutations: () => unknown): Promise<void> {
  expect(await rig.confirm(view.view.draft)).toMatchObject({ kind: "blocked" });
  expect(mutations()).toEqual([]);
}

export interface ManualModeRig extends DraftRouteRig {
  readonly state: { modelFails: boolean; localOnly: boolean; sourceAvailable: boolean; requests: readonly unknown[] };
}

export async function expectManualModeKeepsEdits(rig: ManualModeRig, detailPointer: string, mutations: () => unknown): Promise<void> {
  const edited = await editDraft(rig, await makeDraft(rig), "/title", { kind: "set", value: "Manual title" });
  rig.state.modelFails = true;
  const failure = await refreshDraft(rig, edited);
  expect(failure.view.draft.fields["/title"]?.value).toBe("Manual title");
  expect(failure.view.draft.limitations.length).toBeGreaterThan(0);
  rig.state.localOnly = true;
  const calls = rig.state.requests.length;
  const local = await refreshDraft(rig, failure);
  expect(local.view.draft.limitations).toMatchObject([{ code: "model_unavailable" }]);
  expect(rig.state.requests).toHaveLength(calls);
  expect(local.view.withheld).toContain(detailPointer);
  rig.state.sourceAvailable = false;
  const denied = await rig.call("GET", `${draftPath(local)}/details?pointer=${detailPointer}`);
  expect(await denied.json()).toMatchObject({ details: { sources: [], hiddenSources: 1 } });
  await expectBlockedConfirmation(rig, local, mutations);
}
