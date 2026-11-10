import { z } from "zod";
import { SchemaRefSchema, ObjectReferenceSchema, type ObjectReference } from "./types";

const id = z.string().min(1);
const time = z.iso.datetime();
export const LaneSchema = z.enum(["local", "cloud"]);
export type Lane = z.infer<typeof LaneSchema>;
export const FieldSchema = z.object({
  pointer: id,
  presence: z.enum(["present", "null", "absent"]),
  value: z.json().optional(),
  origin: z.enum(["generated", "suggested", "principal", "default"]),
  citations: z.array(id),
  generationId: id.nullable(),
  alternatives: z.array(z.object({ value: z.json(), citations: z.array(id) }).strict()),
  unresolved: id.nullable(),
}).strict();
export type DraftField = z.infer<typeof FieldSchema>;
export const ManifestSchema = z.object({
  generationId: id, capturedAt: time, boundary: z.object({ entryId: id, revision: id }).strict(), policyRevision: id,
  lane: LaneSchema, modelId: id, connectionId: id, schemaRef: SchemaRefSchema, guidance: z.object({ guidanceId: id, version: id }).strict(),
  items: z.array(z.object({ id, kind: z.enum(["turn", "outcome", "linked", "selected"]), revision: id, digest: id, restriction: LaneSchema }).strict()),
  omissions: z.array(z.object({ reason: z.enum(["not-permitted", "unavailable", "context-limit"]), id: id.optional() }).strict()),
  truncated: z.boolean(),
}).strict();
export type Manifest = z.infer<typeof ManifestSchema>;
export const LimitationSchema = z.object({ code: id, message: id }).strict();
export type Limitation = z.infer<typeof LimitationSchema>;
export const DraftSchema = z.object({
  format: z.literal("desk-draft/1"), draftId: id, revision: z.number().int().positive(), conversationId: id, entryId: id,
  adapterId: id, connectionId: id, capabilityId: id, schemaRef: SchemaRefSchema,
  binding: z.object({ guidanceId: id, version: id }).strict().nullable(),
  fields: z.record(z.string(), FieldSchema), manifest: ManifestSchema.nullable(), limitations: z.array(LimitationSchema),
  createdAt: time, updatedAt: time,
}).strict();
export type StoredDraft = z.infer<typeof DraftSchema>;
export const IndexSchema = z.object({ draftIds: z.array(id) }).strict();
export const ModelOutputSchema = z.object({
  fields: z.array(z.object({
    pointer: id, value: z.json().optional(), labels: z.array(z.string()).optional(), citations: z.array(z.string()),
    alternatives: z.array(z.object({ value: z.json(), citations: z.array(z.string()) }).strict()).optional(),
  }).strict()),
}).strict();
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

export interface SourceItem { id: string; kind: "turn" | "outcome" | "linked" | "selected"; revision: string; digest: string; restriction: Lane; text: string; at: string }
export interface SourceCapture { boundary: { entryId: string; revision: string }; items: SourceItem[]; unavailable: number }
export interface DraftSources {
  capture(request: { conversationId: string; entryId: string; selected: readonly string[] }): Promise<SourceCapture>;
  head(conversationId: string): Promise<string>;
}
export interface DraftPolicy {
  revision(): Promise<string>;
  readable(sourceId: string): Promise<boolean>;
  releasable(sourceIds: readonly string[], lane: Lane): Promise<boolean>;
}
export interface ModelRequest {
  lane: Lane; guidance: { guidanceId: string; version: string; instructions: string }; schemaRef: { schemaId: string; version: string }; schema: unknown;
  fieldHints: readonly { pointer: string; role: string; widget?: "long" }[]; targets: readonly string[]; sources: readonly { id: string; kind: string; text: string; at: string }[];
}
export interface DraftModel {
  lanes(): Promise<readonly Lane[]>;
  generate(request: ModelRequest): Promise<{ modelId: string; output: unknown }>;
}
export type DestinationMatch = { kind: "unique"; ref: ObjectReference } | { kind: "multiple"; refs: ObjectReference[] } | { kind: "none" } | { kind: "unavailable" };
export interface DraftDestinations { batch?(): DraftDestinations; resolve(request: { capabilityId: string; connectionId: string; label: string; conversationId?: string; objectType?: string }): Promise<DestinationMatch> }
export const DestinationRefSchema = ObjectReferenceSchema;

export type EditChange = { kind: "set"; value: unknown } | { kind: "null" } | { kind: "omit" };
export interface Blocking { pointer: string; code: "required_missing" | "unresolved" | "invalid_value" | "unsupported_editor" | "schema_unavailable" }
export type OutdatedReason = "conversation-changed" | "policy-changed" | "source-unavailable" | "schema-changed" | "destination-changed";
export interface DraftView {
  draft: StoredDraft; status: "needs-input" | "ready-for-confirmation"; blocking: Blocking[]; outdated: OutdatedReason[];
  unsupported: string[]; withheld: string[]; automaticDrafting: { available: true } | { available: false; reason: string };
}
export type MakeResult = { kind: "draft"; view: DraftView; reopened: boolean } | { kind: "select"; candidates: { draftId: string; revision: number; updatedAt: string }[] };
export type RefreshResult = { kind: "applied"; view: DraftView } | { kind: "stale" } | { kind: "kept"; view: DraftView };
export interface Handoff {
  draftId: string; draftRevision: number; adapterId: string; connectionId: string; capabilityId: string; inputSchemaRef: { schemaId: string; version: string };
  outputSchemaRef: { schemaId: string; version: string }; errorSchemaRef: { schemaId: string; version: string }; input: unknown; destinations: ObjectReference[];
  sources: { id: string; revision: string; digest: string }[]; policy: Lane; digest: string; existing?: { proposalId?: string; operationId?: string };
}
export type HandoffResult = { ok: true; handoff: Handoff } | { ok: false; blocking: Blocking[]; outdated: OutdatedReason[] };
export class DraftConflict extends Error {}
