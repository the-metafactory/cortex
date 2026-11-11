import { z } from "zod";
import { ObjectReferenceSchema, SchemaRefSchema } from "../types";
import type { ObjectReference } from "../types";
import type { Json } from "../operations/types";
import type { QuerySource } from "./query-types";
import type { ReadBinding } from "./types";
import type { DomainAdapterRegistry } from "../registry";
import { canonicalWire } from "../operations/validation";
import { readPointer } from "./query-validation";

import { OBSERVATION_LIMITS, type ObservationRetention } from "./observation-policy";
export { OBSERVATION_LIMITS, ObservationPolicySchema } from "./observation-policy";
const common = { ref: ObjectReferenceSchema, schemaRef: SchemaRefSchema, destination: ObjectReferenceSchema, observedAt: z.iso.datetime(), revision: z.string().min(1).optional() };
export const ObservationBatchSchema = z.object({
  version: z.literal("1.0.0"), payload: z.json(),
  events: z.array(z.discriminatedUnion("kind", [
    z.object({ ...common, kind: z.literal("present"), pointer: z.string(), evidenceId: z.string().min(1).optional() }).strict(),
    z.object({ ...common, kind: z.literal("deleted"), evidenceId: z.string().min(1), ownerDeletion: z.literal(true) }).strict(),
  ])).max(20),
  checkpoint: z.object({ cursor: z.string().min(1).max(65536), expiresAt: z.number() }).strict().optional(),
  continuation: z.string().min(1).max(65536).optional(),
  gap: z.boolean(), coverage: z.enum(["objects", "watermark", "none"]),
}).strict();
export type ObservationBatch = z.infer<typeof ObservationBatchSchema>;
export type ObservationEvent = ObservationBatch["events"][number] & { value?: Json };
export type ObservationMode = "poll" | "subscription" | "resync" | "reconcile";
export interface ObservationRequest { source: QuerySource; mode: ObservationMode; checkpoint?: string; continuation?: string; limit: number }
export interface ObservationConnector {
  modes: readonly ("poll" | "subscription")[];
  ordering?: { id: string; compare(left: string, right: string): "older" | "same" | "newer" | "incomparable" };
  fetch(request: ObservationRequest, signal: AbortSignal): Promise<unknown>;
}
export interface ObservationBasis { head: string; identity: string; binding: ReadBinding }
export type ObservationHealth = "fresh" | "stale" | "conflicted" | "unavailable";
export interface ObservationRow {
  ref: ObjectReference; schemaRef: z.infer<typeof SchemaRefSchema>; destination: ObjectReference; sourceKey: string; identity: string;
  kind: "present" | "deleted"; value?: Json; digest: string; revision?: string; evidenceId?: string;
  observedAt: string; receivedAt: number; lastSuccessAt: number; conflicted: boolean; needsVerification: boolean; links: string[];
}
export interface ObservationView { ref: ObjectReference; kind: "present" | "deleted"; value?: Json; evidenceId?: string; observedAt: string; lastSuccessAt: number; lastAttemptAt: number | null; status: ObservationHealth; receivedAt: number; revision?: string; evidenceCount: number; quarantinedEvidence: number }
export interface ObservationEvidence { key: string; objectKey: string; digest: string; at: number; quarantined: boolean }
export interface ObservationSourceState { source: QuerySource; lastAttemptAt: number | null; lastSuccessAt: number | null; status: ObservationHealth; gap: boolean; generation: number; checkpoint: { cursor: string; expiresAt: number; head: string; generation: number } | null }
export interface ObservationState { retention: ObservationRetention; rows: Record<string, ObservationRow>; evidence: ObservationEvidence[]; sources: Record<string, ObservationSourceState>; oldestEvidenceAt: number | null }
export function validateObservationBatch(registry: DomainAdapterRegistry, binding: ReadBinding, source: QuerySource, raw: unknown): { batch: ObservationBatch; events: ObservationEvent[] } {
  if (Buffer.byteLength(canonicalWire(raw)) > OBSERVATION_LIMITS.bytes) throw new Error("observation_size");
  const batch = ObservationBatchSchema.parse(raw);
  const policy = binding.observation;
  if (!policy || !registry.validateOutput(binding.capabilityId, batch.payload).ok || batch.coverage === "watermark" && !policy.watermark) throw new Error("invalid_observation");
  const values = readPointer(batch.payload, policy.objectsPointer);
  const present = batch.events.filter(event => event.kind === "present");
  if (!Array.isArray(values) || values.length !== present.length) throw new Error("invalid_observation_mapping");
  const mapped = (value: Json, path: string): void => {
    if (path === policy.objectsPointer) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unknown_observation_provenance");
    for (const [key, child] of Object.entries(value)) mapped(child, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
  };
  mapped(batch.payload, "");
  const pointers = new Set<string>();
  const refs = new Set<string>();
  const events = batch.events.map(event => {
    const key = canonicalWire(event.ref);
    if (refs.has(key) || event.ref.adapterId !== source.adapterId || event.ref.connectionId !== source.connectionId || event.ref.objectType !== binding.objectType || !source.destinations.some(ref => canonicalWire(ref) === canonicalWire(event.destination))) throw new Error("invalid_observation_identity");
    refs.add(key);
    if (canonicalWire(event.schemaRef) !== canonicalWire(registry.objectSchemaRef(binding.adapterId, binding.objectType))) throw new Error("invalid_observation_schema");
    if (event.kind === "deleted") return event;
    if (pointers.has(event.pointer) || !values.some((_value, index) => event.pointer === `${policy.objectsPointer}/${index}`)) throw new Error("invalid_observation_pointer");
    pointers.add(event.pointer);
    const value = readPointer(batch.payload, event.pointer);
    if (value === undefined || !registry.validateObject(binding.adapterId, binding.objectType, event.schemaRef, value).ok || typeof readPointer(value, binding.display.title) !== "string") throw new Error("invalid_observation_object");
    return { ...event, value };
  });
  return { batch, events };
}
