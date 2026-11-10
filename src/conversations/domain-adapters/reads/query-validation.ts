import type { DomainAdapterRegistry } from "../registry";
import type { ReadBinding, ReadPageObject } from "./types";
import { canonicalWire } from "../operations/validation";
import { canonicalSchema } from "../schema-validation";
import { authorityHash } from "../../authority-records";
import { QueryPageSchema, type QueryDispatch, type QueryPage } from "./query-types";
import type { Json } from "../operations/types";

export function readPointer(value: Json, pointer: string): Json | undefined {
  let current: Json | undefined = value;
  for (const token of pointer.slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, token)) return undefined;
    current = (current as Record<string, Json>)[token];
  }
  return current;
}

const scalar = (held: Json): boolean => typeof held === "string";
const nullableScalar = (held: Json): boolean => held === null || typeof held === "string";
const reference = (held: Json): boolean => typeof held === "object" && held !== null && !Array.isArray(held);
const nullableReference = (held: Json): boolean => held === null || reference(held);
const DISPLAY_CHECKS: Record<keyof ReadBinding["display"], (held: Json) => boolean> = {
  title: scalar,
  summary: scalar,
  status: scalar,
  due: nullableScalar,
  area: reference,
  kind: nullableScalar,
  parent: nullableReference,
  url: nullableScalar,
};

function displayAccepted(value: Json, display: ReadBinding["display"]): boolean {
  return Object.entries(DISPLAY_CHECKS).every(([field, accepts]) => {
    const pointer = (display as Readonly<Record<string, string | undefined>>)[field];
    if (pointer === undefined) return true;
    const held = readPointer(value, pointer);
    return held !== undefined && accepts(held);
  });
}

export interface ValidatedQueryPage { page: QueryPage; objects: ReadPageObject[]; released: Json; seen: Record<string, string>; itemCount: number }
export function validateQueryPage(registry: DomainAdapterRegistry, binding: ReadBinding, dispatch: QueryDispatch, raw: unknown): ValidatedQueryPage {
  canonicalSchema(raw);
  const limits = binding.query?.limits;
  if (Buffer.byteLength(canonicalWire(raw)) > (limits?.bytes ?? 1048576)) throw new Error("page_size");
  const page = QueryPageSchema.parse(raw);
  if (!binding.query || !registry.validateOutput(binding.capabilityId, page.payload).ok) throw new Error("invalid_output");
  const aggregates: Record<string, Json> = {};
  const aggregatePointers = binding.query.aggregatePointers ?? [];
  const checkMapping = (value: Json, path: string): void => {
    if (path === binding.query?.objectsPointer) return;
    if (aggregatePointers.includes(path) && (value === null || typeof value !== "object" || Array.isArray(value) && value.every(item => item === null || typeof item !== "object"))) { aggregates[path] = value; return; }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) checkMapping(child, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
      return;
    }
    throw new Error("unknown_provenance");
  };
  checkMapping(page.payload, "");
  const values = readPointer(page.payload, binding.query.objectsPointer);
  if (!Array.isArray(values) || values.length > dispatch.limit || values.length !== page.annotations.length) throw new Error("invalid_annotations");
  if (page.snapshot.kind === "stable" && !binding.query.stableSnapshot || dispatch.snapshotId !== undefined && (page.snapshot.kind !== "stable" || page.snapshot.id !== dispatch.snapshotId)) throw new Error("restart_required");
  const pointers = new Set<string>();
  const seen = { ...dispatch.seen };
  const objects: ReadPageObject[] = [];
  const annotations = [...page.annotations].sort((a, b) => a.position - b.position || (canonicalWire(a.ref) < canonicalWire(b.ref) ? -1 : canonicalWire(a.ref) > canonicalWire(b.ref) ? 1 : 0));
  const fresh: QueryPage["annotations"] = [];
  for (const entry of annotations) {
    if (pointers.has(entry.pointer) || !values.some((_value, index) => entry.pointer === `${binding.query?.objectsPointer}/${index}`)) throw new Error("invalid_annotations");
    pointers.add(entry.pointer);
    const value = readPointer(page.payload, entry.pointer);
    if (value === undefined || entry.ref.adapterId !== binding.adapterId || entry.ref.connectionId !== dispatch.source.connectionId || entry.ref.objectType !== binding.objectType || !dispatch.source.destinations.some(dest => canonicalWire(dest) === canonicalWire(entry.destination)) || !registry.validateObject(binding.adapterId, binding.objectType, entry.schemaRef, value).ok) throw new Error("invalid_annotations");
    if (!displayAccepted(value, binding.display)) throw new Error("invalid_display");
    const key = authorityHash(entry.ref);
    const digest = authorityHash({ value, revision: entry.evidence.revision, schemaRef: entry.schemaRef, destination: entry.destination });
    if (seen[key] !== undefined && seen[key] !== digest) throw new Error("restart_required");
    objects.push({ ref: entry.ref, schemaRef: entry.schemaRef, destination: entry.destination, value });
    if (seen[key] === undefined) fresh.push(entry);
    seen[key] = digest;
  }
  const released: Json = { queryId: dispatch.queryId, untrusted: true, aggregates, objects: fresh.map((entry, index) => ({ ...entry, pointer: `/objects/${index}/value`, value: readPointer(page.payload, entry.pointer) as Json })), observedAt: page.observedAt, consistency: page.snapshot.kind === "stable" ? "stable-snapshot" : "best-effort", incomplete: page.snapshot.kind === "live" };
  return { page, objects, released, seen, itemCount: values.length };
}
