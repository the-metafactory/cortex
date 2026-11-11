import type { DraftService, DraftView, Handoff, Lane } from "../../../conversations/domain-adapters/drafting";

export const DESK_DRAFTS_PATH = "/api/desk/drafts";
export interface DraftTarget { capabilityId: string; connectionId: string; label: string }
export interface EditorField { pointer: string; label: string; schema: Record<string, unknown>; required: boolean; destination: boolean; long: boolean }
export interface DestinationChange { pointer: string; before: unknown; after: unknown }
export interface DraftEditorView { view: DraftView; fields: EditorField[]; destinationChanges: DestinationChange[]; receipt?: DraftReceipt | null }
export type DraftDetails = NonNullable<Awaited<ReturnType<DraftService["details"]>>>;
export type DraftConfirmation = { kind: "blocked"; reason: string } | { kind: "accepted"; operationId: string };
export interface DraftConfirmationRequest { handoff: Handoff; principal: string; transport: "web"; audience: Lane }

export type DraftReceipt = { kind: "withheld" } | { kind: "receipt"; operationId: string; state: string; references: string[] };
