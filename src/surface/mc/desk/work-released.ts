import type { Json } from "../../../conversations/domain-adapters/operations/types";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import type { HostContext } from "../../../conversations/authority";
import type { ReleaseSink } from "../../../conversations/authority-records";
import type { QueryRunner } from "../../../conversations/domain-adapters/reads/query";
import type { QueryResult } from "../../../conversations/domain-adapters/reads/query-types";

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

export interface QueryRun {
  readonly result: QueryResult;
  readonly released?: Json;
}
type QuerySourceInput = Parameters<QueryRunner["create"]>[1][number];

export async function runReleased(runner: Pick<QueryRunner, "create" | "run">, context: HostContext, sink: ReleaseSink, source: QuerySourceInput): Promise<QueryRun> {
  const created = await runner.create(context, [source], sink);
  let released: Json | undefined;
  const result = await runner.run(context, created, sink, undefined, undefined, { released: value => { released = value; } });
  return { result, ...(released === undefined ? {} : { released }) };
}

export const observedAtOf = (object: ReleasedObject, at: number): number => {
  const time = object.evidence?.observedAt ? Date.parse(object.evidence.observedAt) : Number.NaN;
  return Number.isFinite(time) ? time : at;
};
