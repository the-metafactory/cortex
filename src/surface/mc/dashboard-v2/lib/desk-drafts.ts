import { DESK_DRAFTS_PATH, type DraftConfirmation, type DraftDetails, type DraftEditorView, type DraftTarget } from "../../desk/draft-editor-contract";
import type { EditChange } from "../../../../conversations/domain-adapters/drafting-types";
import { getJson, postJson } from "./api";

export type { DraftConfirmation, DraftDetails, DraftEditorView, DraftTarget };
export type MakeDraftReply = ({ kind: "draft"; reopened: boolean } & DraftEditorView) | { kind: "select"; candidates: { draftId: string; revision: number; updatedAt: string }[] };
const path = (id: string): string => `${DESK_DRAFTS_PATH}/${encodeURIComponent(id)}`;
export const draftTargets = (signal?: AbortSignal): Promise<{ targets: DraftTarget[] }> => getJson(DESK_DRAFTS_PATH, { signal });
export const makeDraft = (input: { conversationId: string; entryId: string; capabilityId: string; connectionId: string; newDraft?: boolean; selectDraftId?: string }): Promise<MakeDraftReply> => postJson(DESK_DRAFTS_PATH, input);
export const readDraft = (id: string): Promise<DraftEditorView> => getJson(path(id));
export const editDraft = (id: string, revision: number, pointer: string, change: EditChange): Promise<DraftEditorView> => getJson(path(id), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision, pointer, change }) });
export const refreshDraft = (id: string, revision: number): Promise<DraftEditorView> => postJson(`${path(id)}/refresh`, { revision });
export const draftDetails = (id: string, pointer: string): Promise<{ details: DraftDetails }> => getJson(`${path(id)}/details?pointer=${encodeURIComponent(pointer)}`);
export const confirmDraft = (id: string, revision: number): Promise<{ confirmation: DraftConfirmation }> => postJson(`${path(id)}/confirm`, { revision });
export const changeDraftDestination = (id: string, revision: number, target: DraftTarget): Promise<DraftEditorView> => postJson(`${path(id)}/destination`, { revision, capabilityId: target.capabilityId, connectionId: target.connectionId });
