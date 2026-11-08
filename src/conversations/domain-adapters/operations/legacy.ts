import { createHash } from "node:crypto";
import { z } from "zod";
import { ProposalSchema, type Proposal } from "../../creation";
import { OperationRecordSchema, type CreateResult, type OperationRecord, type ReadbackResult } from "../../types";
import { operationUuid, studioRequestId } from "../../../surface/mc/desk/conversation-ids";
import { ObjectReferenceSchema, type ObjectReference } from "../types";
import { OperationJournalStore, StoredSchema, type StoredOperation } from "./journal";
import { parseWire, type Json, type OperationJournal } from "./types";
import { canonicalWire } from "./validation";

export interface LegacySource {
  proposal: Proposal;
  record: OperationRecord;
  ownerReceipts: Json;
  createResult?: CreateResult;
  readback?: ReadbackResult;
}
export interface LegacyContext {
  owner: OperationRecord["owner"];
  adapterId: string;
  connectionId: string;
  capabilityId: string;
  fields: Record<string, string>;
  destinations: ObjectReference[];
  canonicalReference?: ObjectReference;
}
type LegacyBinding = Pick<LegacyContext, "owner" | "adapterId" | "connectionId" | "capabilityId">;
const isBalanceTaskBinding = (binding: LegacyBinding | undefined): boolean => binding?.owner === "balance-task" && binding.adapterId === "balance" && binding.capabilityId === "balance.task.create";
const ContextSchema = z.object({ owner: OperationRecordSchema.shape.owner, adapterId: z.string().min(1), connectionId: z.string().min(1), capabilityId: z.string().min(1), fields: z.record(z.string(), z.string()), destinations: z.array(ObjectReferenceSchema), canonicalReference: ObjectReferenceSchema.optional() }).strict();
const SourceSchema = z.object({ proposal: ProposalSchema, record: OperationRecordSchema, ownerReceipts: z.json(), createResult: z.discriminatedUnion("state", [z.object({ state: z.literal("created"), canonicalId: z.string(), url: z.string().optional() }).strict(), z.object({ state: z.literal("accepted"), receipt: z.string().optional() }).strict(), z.object({ state: z.literal("failed"), error: z.string() }).strict()]).optional(), readback: z.union([z.object({ found: z.literal(true), canonicalId: z.string(), url: z.string().optional() }).strict(), z.object({ found: z.literal(false) }).strict(), z.null()]).optional() }).strict();
const ImportEvidenceSchema = z.object({ source: SourceSchema, context: ContextSchema.nullable(), issues: z.array(z.string()) }).strict();
const hash = (value: unknown): string => createHash("sha256").update(canonicalWire(value)).digest("hex");
export class UpgradeRequired extends Error {
  readonly code = "upgrade-required";
  constructor() { super("This operation requires a lifecycle-aware read-only client."); }
}
export interface LegacyPreview {
  source: LegacySource;
  context: LegacyContext | null;
  sourceDigest: string;
  issues: string[];
  state: "succeeded" | "uncertain";
  dispatchAllowed: false;
  retryAllowed: false;
  ownerRequestId: string;
}

function conversionIssues(source: LegacySource, context: LegacyContext): string[] {
  if (source.record.owner !== "balance-task" || !isBalanceTaskBinding(context)) return ["legacy_capability_mapping_unsupported"];
  const fields = source.proposal.fields;
  const destinations = ["area", "project"].flatMap(objectType => {
    const canonicalId = fields[objectType];
    return canonicalId ? [{ adapterId: context.adapterId, connectionId: context.connectionId, objectType, canonicalId }] : [];
  });
  const issues: string[] = [];
  if (!fields.area || destinations.some(ref => ref.canonicalId.trim() !== ref.canonicalId) || canonicalWire(context.destinations.map(canonicalWire).sort()) !== canonicalWire(destinations.map(canonicalWire).sort())) issues.push("legacy_destination_ambiguous");
  if (context.canonicalReference && (context.canonicalReference.objectType !== "task" || context.canonicalReference.canonicalId !== source.record.canonicalId)) issues.push("legacy_canonical_mapping_unsupported");
  return issues;
}

export function previewLegacyOperation(raw: LegacySource, mapping?: LegacyContext): LegacyPreview {
  parseWire(SourceSchema, raw);
  const source = structuredClone(raw);
  const { record, proposal } = source;
  if (record.operationId !== `${record.conversationId}:${record.proposalId}:${record.revision}` || record.revision < 1 || proposal.conversationId !== record.conversationId || proposal.proposalId !== record.proposalId || proposal.revision < record.revision) throw new Error("Legacy operation identity is inconsistent.");
  const context = mapping ? parseWire(ContextSchema, mapping) : null;
  const issues: string[] = [];
  const canonical = record.canonicalId;
  const validCanonical = canonical !== undefined && canonical.length > 0 && canonical.trim() === canonical && !Array.from(canonical).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  if (record.state === "created" && !validCanonical) issues.push("legacy_canonical_identity_invalid");
  if (record.url !== undefined && !z.url().safeParse(record.url).success) issues.push("legacy_canonical_url_invalid");
  if (!context) issues.push("legacy_context_missing");
  else {
    if (context.owner !== record.owner || proposal.type !== record.owner) issues.push("legacy_owner_ambiguous");
    if (canonicalWire(context.fields) !== canonicalWire(proposal.fields) || proposal.revision !== record.revision) issues.push("legacy_fields_ambiguous");
    const refs = [...context.destinations, ...(context.canonicalReference ? [context.canonicalReference] : [])];
    if (!context.destinations.length || refs.some(ref => ref.adapterId !== context.adapterId || ref.connectionId !== context.connectionId)) issues.push("legacy_destination_ambiguous");
    if (record.state === "created" && (!context.canonicalReference || context.canonicalReference.canonicalId !== canonical)) issues.push("legacy_canonical_mapping_missing");
    issues.push(...conversionIssues(source, context));
  }
  if (source.createResult?.state === "created" && source.createResult.canonicalId !== canonical) issues.push("legacy_result_identity_conflict");
  if (source.readback?.found && source.readback.canonicalId !== canonical) issues.push("legacy_readback_identity_conflict");
  if (!record.owner.startsWith("balance-") && !record.owner.startsWith("studio-") && !record.owner.startsWith("graph-") && record.owner !== "flow") issues.push("legacy_owner_identity_mapping_missing");
  const evidence = { source, context, issues };
  const ownerRequestId = record.owner.startsWith("balance-") ? operationUuid(record.operationId) : record.owner.startsWith("studio-") || record.owner.startsWith("graph-") || record.owner === "flow" ? studioRequestId(record.operationId) : record.operationId;
  return { ...evidence, sourceDigest: hash(evidence), state: record.state === "created" && validCanonical ? "succeeded" : "uncertain", dispatchAllowed: false, retryAllowed: false, ownerRequestId };
}

export async function importLegacyOperation(store: OperationJournalStore, source: LegacySource, mapping: LegacyContext | undefined, importedAt: string): Promise<StoredOperation> {
  const preview = previewLegacyOperation(source, mapping);
  const evidence = { source: preview.source, context: preview.context, issues: preview.issues };
  const journal: OperationJournal = { lifecycleVersion: "1.0.0", operationId: source.record.operationId, sequence: 1, state: preview.state, idempotencyKey: source.record.operationId, ownerRequestId: preview.ownerRequestId, snapshot: { kind: "legacy-unavailable", reason: "Legacy evidence has no lifecycle approval; dispatch and retry require separate reviewed migration." }, events: [{ sequence: 1, eventId: `legacy-import:${preview.sourceDigest}`, at: importedAt, event: { kind: "legacy-import", rawRecord: parseWire(z.json(), evidence), sourceDigest: preview.sourceDigest } }] };
  return store.importLegacy(journal);
}

export type OperationEvidence = { kind: "legacy"; source: LegacySource; context: LegacyContext | null; issues: string[]; lifecycle: StoredOperation; dispatchAllowed: false; retryAllowed: false } | { kind: "lifecycle"; lifecycle: StoredOperation } | { kind: "legacy-only"; source: LegacySource; dispatchAllowed: false; retryAllowed: false } | { kind: "upgrade-required"; raw: unknown };
export function readOperationEvidence(raw: unknown): OperationEvidence {
  try {
    const parsed = parseWire(StoredSchema, raw);
    const entry = parsed.journal.events.find(item => item.event.kind === "legacy-import");
    if (entry?.event.kind === "legacy-import") {
      parseWire(ImportEvidenceSchema, entry.event.rawRecord);
      const evidence = structuredClone(entry.event.rawRecord) as unknown as z.infer<typeof ImportEvidenceSchema>;
      if (hash(entry.event.rawRecord) !== entry.event.sourceDigest) throw new UpgradeRequired();
      const issues = [...new Set([...evidence.issues, ...previewLegacyOperation(evidence.source, evidence.context ?? undefined).issues])];
      return { kind: "legacy", ...evidence, issues, lifecycle: parsed, dispatchAllowed: false, retryAllowed: false };
    }
    return { kind: "lifecycle", lifecycle: parsed };
  } catch (error) {
    if (SourceSchema.safeParse(raw).success) return { kind: "legacy-only", source: structuredClone(raw) as LegacySource, dispatchAllowed: false, retryAllowed: false };
    if (error instanceof Error) return { kind: "upgrade-required", raw: structuredClone(raw) };
    throw error;
  }
}

export function projectLegacyOperation(raw: unknown, binding?: LegacyBinding): OperationRecord {
  const evidence = readOperationEvidence(raw);
  if (evidence.kind === "upgrade-required") throw new UpgradeRequired();
  if (evidence.kind === "legacy-only") throw new UpgradeRequired();
  const { journal } = evidence.lifecycle;
  if (journal.links?.batchId || journal.links?.itemId) throw new UpgradeRequired();
  if (evidence.kind === "legacy") {
    const record = structuredClone(evidence.source.record);
    if (evidence.issues.length || ["proposed", "confirmed"].includes(record.state)) throw new UpgradeRequired();
    if (journal.state === "uncertain" && ["failed", "running", "uncertain"].includes(record.state)) record.state = "uncertain";
    return record;
  }
  if ("kind" in journal.snapshot) throw new UpgradeRequired();
  const snapshot = journal.snapshot;
  if (!binding || !isBalanceTaskBinding(binding)) throw new UpgradeRequired();
  const approval = journal.events.find(item => item.event.kind === "approved");
  if (approval?.event.kind !== "approved" || snapshot.capabilityId !== binding.capabilityId || snapshot.adapterId !== binding.adapterId || snapshot.connectionId !== binding.connectionId) throw new UpgradeRequired();
  const states: Partial<Record<OperationJournal["state"], OperationRecord["state"]>> = { confirmed: "confirmed", dispatching: "running", pending: "running", uncertain: "uncertain" };
  let state = states[journal.state];
  let canonicalId: string | undefined;
  if (journal.state === "succeeded") {
    const success = journal.events.findLast(item => item.event.kind === "owner-result" && item.event.response.result.kind === "succeeded");
    const result = success?.event.kind === "owner-result" ? success.event.response.result : undefined;
    if (result?.kind !== "succeeded" || result.evidence.refs.length !== 1) throw new UpgradeRequired();
    const ref = result.evidence.refs[0];
    if (ref?.adapterId !== binding.adapterId || ref.connectionId !== binding.connectionId || ref.objectType !== "task") throw new UpgradeRequired();
    canonicalId = ref.canonicalId;
    state = "created";
  }
  if (!state) throw new UpgradeRequired();
  const { conversationId, proposalId, revision } = snapshot.provenance;
  return { operationId: journal.operationId, conversationId, proposalId, revision, owner: binding.owner, state, digest: snapshot.digest, ...(canonicalId ? { canonicalId } : {}), history: [{ state: "confirmed", at: approval.at }] };
}
