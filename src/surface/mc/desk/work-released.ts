import type { AuthorityState, RestrictionRecord } from "../../../conversations/authority-records";
import type { Json } from "../../../conversations/domain-adapters/operations/types";
import type { DestinationMatch } from "../../../conversations/domain-adapters/drafting";
import { canonicalWire } from "../../../conversations/domain-adapters/operations/validation";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";

export interface ReleasedObject {
  readonly ref: ObjectReference;
  readonly destination: ObjectReference;
  readonly value: Record<string, unknown>;
  readonly evidence?: { readonly observedAt?: string };
}

export const objectReference = (value: unknown): ObjectReference | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const held = value as Record<string, unknown>;
  return typeof held.adapterId === "string" && typeof held.connectionId === "string" && typeof held.objectType === "string" && typeof held.canonicalId === "string"
    ? { adapterId: held.adapterId, connectionId: held.connectionId, objectType: held.objectType, canonicalId: held.canonicalId }
    : null;
};

export const releasedObjects = (released: Json): ReleasedObject[] => {
  if (typeof released !== "object" || released === null || Array.isArray(released)) return [];
  const held = (released as { objects?: unknown }).objects;
  if (!Array.isArray(held)) return [];
  const objects: ReleasedObject[] = [];
  for (const entry of held) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const ref = objectReference(raw.ref);
    const destination = objectReference(raw.destination);
    const value = raw.value;
    if (!ref || !destination || typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const evidence = typeof raw.evidence === "object" && raw.evidence !== null && !Array.isArray(raw.evidence) ? raw.evidence as { observedAt?: string } : undefined;
    objects.push({ ref, destination, value: value as Record<string, unknown>, ...(evidence ? { evidence } : {}) });
  }
  return objects;
};

export type { HostQueryRun as QueryRun } from "./query-run";

export const observedAtOf = (object: ReleasedObject, at: number): number => {
  const time = object.evidence?.observedAt ? Date.parse(object.evidence.observedAt) : Number.NaN;
  return Number.isFinite(time) ? time : at;
};

export const activeRestriction = (state: Pick<AuthorityState, "records">, source: ObjectReference): RestrictionRecord | undefined => {
  const restrictions = Object.values(state.records).flatMap(history => {
    const record = history.at(-1);
    return record?.kind === "restriction" && record.value.status === "active" && canonicalWire(record.value.source) === canonicalWire(source) ? [record.value] : [];
  });
  return restrictions.length === 1 ? restrictions[0] : undefined;
};

export const destinationMatch = (refs: ObjectReference[]): DestinationMatch => {
  const unique = [...new Map(refs.map(ref => [JSON.stringify(ref), ref])).values()];
  const first = unique[0];
  return !first ? { kind: "none" } : unique.length === 1 ? { kind: "unique", ref: first } : { kind: "multiple", refs: unique };
};
