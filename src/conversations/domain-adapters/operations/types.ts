import { z } from "zod";
import { BoundaryErrorSchema, ObjectReferenceSchema, SchemaRefSchema, type ObjectReference } from "../types";
import { canonicalSchema } from "../schema-validation";

const id = z.string().refine(value => value.trim().length > 0);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = counter.min(1);
const time = z.iso.datetime({ offset: false });
const json = z.json();
const envelope = { lifecycleVersion: z.literal("1.0.0") };
export const EnvelopeSchema = z.object(envelope).strict();
export const ProvenanceSchema = z.object({ conversationId: id, proposalId: id, revision: positive, entryId: id.nullable(), link: z.string() }).strict();
export const AuthoritySchema = z.object({
  principalRef: id,
  basis: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("confirmation"), confirmationId: id, transport: z.enum(["web", "discord"]) }).strict(),
    z.object({ kind: z.literal("grant"), grantId: id, grantRevision: id }).strict(),
  ]),
  connectionRevision: id, policyRevision: id, decisionRef: id, authorizedAt: time,
}).strict();
export const ApprovedSnapshotSchema = z.object({
  provenance: ProvenanceSchema, adapterId: id, connectionId: id, capabilityId: id,
  inputSchemaRef: SchemaRefSchema, outputSchemaRef: SchemaRefSchema, errorSchemaRef: SchemaRefSchema,
  input: json, destinations: z.array(ObjectReferenceSchema), target: ObjectReferenceSchema.optional(), expectedOwnerRevision: id.optional(),
  sources: z.array(z.object({ ref: ObjectReferenceSchema, restrictionRef: id }).strict()), policy: z.enum(["local", "cloud"]), digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const OwnerSupportSchema = z.object({
  ...envelope, adapterId: id, connectionId: id, capabilityId: id, declarationId: id,
  dedup: z.discriminatedUnion("kind", [z.object({ kind: z.literal("none") }).strict(), z.object({ kind: z.literal("guaranteed"), scope: z.literal("connection-capability"), retentionMs: positive, bindsSnapshot: z.literal(true), concurrent: z.literal(true) }).strict()]),
  operationLookup: z.enum(["none", "historical"]), conditionalUpdate: z.enum(["none", "owner-enforced"]), cancellation: z.enum(["none", "best-effort", "confirmed-no-effect"]), compensationCapabilityId: id.optional(),
}).strict();
export const EffectEvidenceSchema = z.object({ kind: z.literal("effect"), evidenceId: id, observedAt: time, ownerRequestId: id, receipt: json, refs: z.array(ObjectReferenceSchema), ownerRevision: id.optional() }).strict();
export const NoEffectEvidenceSchema = z.object({ kind: z.literal("no-effect"), evidenceId: id, observedAt: time, ownerRequestId: id, receipt: json, final: z.literal(true) }).strict();
export const OwnerResultSchema = z.object({
  ...envelope, operationId: id, attemptId: id, snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/), resultId: id, reportedAt: time,
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("accepted"), ownerRequestId: id, receipt: json }).strict(),
    z.object({ kind: z.literal("succeeded"), output: json, evidence: EffectEvidenceSchema }).strict(),
    z.object({ kind: z.literal("failed"), error: BoundaryErrorSchema, evidence: NoEffectEvidenceSchema }).strict(),
    z.object({ kind: z.literal("conflict"), error: BoundaryErrorSchema, currentOwnerRevision: id, evidence: NoEffectEvidenceSchema }).strict(),
    z.object({ kind: z.literal("cancelled"), evidence: NoEffectEvidenceSchema }).strict(),
    z.object({ kind: z.literal("uncertain"), error: BoundaryErrorSchema, ownerRequestId: id.optional(), receipt: json.optional() }).strict(),
  ]),
}).strict();
export const DispatchRequestSchema = z.object({ ...envelope, operationId: id, attemptId: id, idempotencyKey: id, ownerRequestId: id, snapshot: ApprovedSnapshotSchema, authority: AuthoritySchema, supportDeclarationId: id, deadlineAt: time }).strict();
export const AttemptSchema = z.object({ attemptId: z.uuid(), number: positive, kind: z.enum(["initial", "retry"]), preparedAt: time, deadlineAt: time, authority: AuthoritySchema, supportDeclarationId: id, dedupValidUntil: time.optional() }).strict();
export const OperationStateSchema = z.enum(["confirmed", "dispatching", "pending", "uncertain", "succeeded", "failed", "conflict", "refused", "cancelled"]);
export const OperationLookupSchema = z.object({
  ...envelope, operationId: id, checkedAt: time,
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("known"), response: OwnerResultSchema }).strict(),
    z.object({ kind: z.literal("no-effect"), evidence: NoEffectEvidenceSchema }).strict(),
    ...(["unknown", "denied", "unavailable"] as const).map(kind => z.object({ kind: z.literal(kind), reason: BoundaryErrorSchema }).strict()),
  ]),
}).strict();
export const JournalEventSchema = z.object({
  sequence: positive, eventId: id, at: time,
  event: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("approved"), snapshot: ApprovedSnapshotSchema, authority: AuthoritySchema }).strict(),
    z.object({ kind: z.literal("attempt-prepared"), attempt: AttemptSchema }).strict(),
    z.object({ kind: z.literal("owner-result"), response: OwnerResultSchema }).strict(),
    z.object({ kind: z.literal("local-outcome"), state: z.enum(["refused", "cancelled"]), reason: BoundaryErrorSchema }).strict(),
    z.object({ kind: z.literal("wait-expired"), attemptId: z.uuid(), reason: BoundaryErrorSchema }).strict(),
    z.object({ kind: z.literal("cancel-requested"), cancelId: id, authority: AuthoritySchema }).strict(),
    z.object({ kind: z.literal("reconciliation"), lookup: OperationLookupSchema }).strict(),
    z.object({ kind: z.literal("legacy-import"), rawRecord: json, sourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ]),
}).strict();
export const OperationJournalSchema = z.object({
  ...envelope, operationId: id, sequence: positive, state: OperationStateSchema, idempotencyKey: id, ownerRequestId: id,
  snapshot: z.union([ApprovedSnapshotSchema, z.object({ kind: z.literal("legacy-unavailable"), reason: id }).strict()]), events: z.array(JournalEventSchema),
  links: z.object({ batchId: z.uuid().optional(), itemId: id.optional(), compensatesOperationId: id.optional(), replacesOperationId: id.optional() }).strict().optional(),
}).strict();
export const ObjectReadbackSchema = z.object({
  ...envelope, ref: ObjectReferenceSchema, checkedAt: time, provenance: z.object({ adapterId: id, connectionId: id, evidenceId: id }).strict(),
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("present"), schemaRef: SchemaRefSchema, value: json, ownerRevision: id.optional(), links: z.array(z.object({ label: id, url: z.url() }).strict()) }).strict(),
    z.object({ kind: z.literal("deleted"), evidenceId: id, deletedAt: time.optional() }).strict(),
    ...(["denied", "unavailable", "unknown"] as const).map(kind => z.object({ kind: z.literal(kind), reason: BoundaryErrorSchema }).strict()),
  ]),
}).strict();
export const CancelRequestSchema = z.object({ ...envelope, operationId: id, cancelId: id, authority: AuthoritySchema, requestedAt: time }).strict();
export const BatchReceiptSchema = z.object({ ...envelope, batchId: z.uuid(), atomic: z.literal(false), items: z.array(z.object({ itemId: id, operationId: id, state: z.union([z.literal("unattempted"), OperationStateSchema]) }).strict()), summary: z.enum(["unattempted", "pending", "succeeded", "partial", "failed", "uncertain", "cancelled"]) }).strict();

export function parseWire<T>(schema: z.ZodType<T>, raw: unknown): T {
  canonicalSchema(raw);
  json.parse(raw);
  return schema.parse(raw);
}

export type Json = z.infer<typeof json>;
export type Envelope = z.infer<typeof EnvelopeSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type Authority = z.infer<typeof AuthoritySchema>;
export type ApprovedSnapshot = z.infer<typeof ApprovedSnapshotSchema>;
export type OwnerSupport = z.infer<typeof OwnerSupportSchema>;
export type EffectEvidence = z.infer<typeof EffectEvidenceSchema>;
export type NoEffectEvidence = z.infer<typeof NoEffectEvidenceSchema>;
export type OwnerResult = z.infer<typeof OwnerResultSchema>;
export type DispatchRequest = z.infer<typeof DispatchRequestSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;
export type OperationState = z.infer<typeof OperationStateSchema>;
export type JournalEvent = z.infer<typeof JournalEventSchema>;
export type OperationJournal = z.infer<typeof OperationJournalSchema>;
export type OperationLookup = z.infer<typeof OperationLookupSchema>;
export type ObjectReadback = z.infer<typeof ObjectReadbackSchema>;
export type CancelRequest = z.infer<typeof CancelRequestSchema>;
export type BatchReceipt = z.infer<typeof BatchReceiptSchema>;
export interface LookupRequest { lifecycleVersion: "1.0.0"; operationId: string; ownerRequestId: string }
export interface ReadbackRequest { lifecycleVersion: "1.0.0"; ref: ObjectReference }
