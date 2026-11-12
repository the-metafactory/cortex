import type { AuthorityState, RestrictionRecord } from "../../../conversations/authority-records";
import type { Json } from "../../../conversations/domain-adapters/operations/types";
import type { DestinationMatch } from "../../../conversations/domain-adapters/drafting";
import { canonicalWire } from "../../../conversations/domain-adapters/operations/validation";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import { isRecord } from "../../../conversations/tools/json";

export interface ReleasedObject {
  readonly ref: ObjectReference;
  readonly destination: ObjectReference;
  readonly value: Record<string, unknown>;
  readonly evidence?: { readonly observedAt?: string };
}

export const objectReference = (value: unknown): ObjectReference | null =>
  isRecord(value) && typeof value.adapterId === "string" && typeof value.connectionId === "string" && typeof value.objectType === "string" && typeof value.canonicalId === "string"
    ? { adapterId: value.adapterId, connectionId: value.connectionId, objectType: value.objectType, canonicalId: value.canonicalId }
    : null;

export const releasedObjects = (released: Json): ReleasedObject[] => {
  const held = isRecord(released) ? released.objects : undefined;
  if (!Array.isArray(held)) return [];
  const objects: ReleasedObject[] = [];
  for (const entry of held) {
    if (!isRecord(entry)) continue;
    const ref = objectReference(entry.ref);
    const destination = objectReference(entry.destination);
    const value = entry.value;
    if (!ref || !destination || !isRecord(value)) continue;
    const evidence = isRecord(entry.evidence) ? entry.evidence as { observedAt?: string } : undefined;
    objects.push({ ref, destination, value, ...(evidence ? { evidence } : {}) });
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
