import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { DomainAdapterRegistry } from "../registry";
import { ObjectReferenceSchema, type ObjectReference } from "../types";
import { ApprovedSnapshotSchema, parseWire, type ApprovedSnapshot, type Json, type OwnerResult } from "./types";

export function canonicalWire(value: unknown): string {
  const serialized = canonicalize(value);
  if (serialized === undefined) throw new Error("Lifecycle data must be canonicalizable JSON.");
  return serialized;
}

export function snapshotDigest(snapshot: Omit<ApprovedSnapshot, "digest"> | ApprovedSnapshot): string {
  const { digest: _digest, ...members } = snapshot as ApprovedSnapshot;
  parseWire(ApprovedSnapshotSchema, { ...members, digest: "0".repeat(64) });
  return createHash("sha256").update(canonicalWire(members)).digest("hex");
}

export function validateSnapshot(registry: DomainAdapterRegistry, raw: unknown): ApprovedSnapshot {
  const snapshot = parseWire(ApprovedSnapshotSchema, raw);
  const found = registry.capability(snapshot.capabilityId);
  if (found.support !== "declared" || found.adapterId !== snapshot.adapterId || found.capability.kind !== "action") throw new Error("Snapshot must select a declared action.");
  for (const field of ["inputSchemaRef", "outputSchemaRef", "errorSchemaRef"] as const) {
    if (canonicalWire(snapshot[field]) !== canonicalWire(found.capability[field])) throw new Error("Snapshot schema must match the exact declared version.");
  }
  const valid = registry.validateInput({ capabilityId: snapshot.capabilityId, inputSchemaRef: snapshot.inputSchemaRef, input: snapshot.input }, undefined);
  if (!valid.ok) throw new Error(valid.error.code);
  for (const ref of [...snapshot.destinations, ...(snapshot.target ? [snapshot.target] : [])]) {
    if (ref.adapterId !== snapshot.adapterId || ref.connectionId !== snapshot.connectionId || !registry.declaresObjectType(ref.adapterId, ref.objectType)) throw new Error("Snapshot reference belongs to a different binding.");
  }
  if (snapshot.expectedOwnerRevision !== undefined && !snapshot.target) throw new Error("An owner precondition requires a target.");
  if (snapshotDigest(snapshot) !== snapshot.digest) throw new Error("Approved snapshot digest does not match its contents.");
  return snapshot;
}

function references(value: Json): ObjectReference[] {
  const result = ObjectReferenceSchema.safeParse(value);
  if (result.success) return [result.data];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(references);
}

export function validateResultPayload(registry: DomainAdapterRegistry, snapshot: ApprovedSnapshot, response: OwnerResult): void {
  validateSnapshot(registry, snapshot);
  const result = response.result;
  if (result.kind === "succeeded") {
    const checked = registry.validateOutput(snapshot.capabilityId, result.output);
    if (!checked.ok) throw new Error(checked.error.code);
    const outputRefs = references(result.output);
    if (result.evidence.refs.length === 0 || result.evidence.refs.some(ref => ref.adapterId !== snapshot.adapterId || ref.connectionId !== snapshot.connectionId || !outputRefs.some(output => canonicalWire(output) === canonicalWire(ref)))) throw new Error("Effect references must agree with canonical output references.");
  }
  if (result.kind === "failed" || result.kind === "conflict") {
    const checked = registry.validateError(snapshot.capabilityId, result.error);
    if (!checked.ok) throw new Error(checked.error.code);
  }
}
