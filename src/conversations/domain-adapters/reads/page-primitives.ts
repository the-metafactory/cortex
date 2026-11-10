import { authorityHash } from "../../authority-records";
import type { Json } from "../operations/types";
import { ObjectReferenceSchema, type ObjectReference, type SchemaRef } from "../types";
import type { QueryPage } from "./query-types";

export type { Json } from "../operations/types";
export type { QueryFetchRequest, QueryPage } from "./query-types";
export type { ReadBinding } from "./types";

export interface QueryPageEntry { readonly ref: ObjectReference; readonly schemaRef: SchemaRef; readonly destination: ObjectReference; readonly evidenceId: string; readonly value: Json }
export interface ReadHandlerContext { readonly destinations: readonly ObjectReference[]; readonly cursor?: string; readonly limit: number }
export type ReadFailure = (code: string) => never;

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const parseObjectReference = (value: unknown, fail: ReadFailure): ObjectReference => { const parsed = ObjectReferenceSchema.safeParse(value); return parsed.success ? parsed.data : fail("invalid_input"); };
export const readObservedAt = (source: { now?: () => Date }): string => (source.now?.() ?? new Date()).toISOString();
export const readSnapshotId = (adapterId: string, scope: string, content: Json): string => `${adapterId}.${scope}:${authorityHash(content)}`;

export function readPageLimit(raw: unknown, maximum: number, fail: ReadFailure, code: string): number {
  if (raw === undefined) return maximum;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return fail(code);
  return Math.min(raw, maximum);
}

export function parseReadHandlerContext(raw: unknown, maximum: number, fail: ReadFailure): ReadHandlerContext {
  if (!isRecord(raw)) return fail("invalid_context");
  const destinations = Array.isArray(raw.destinations) ? raw.destinations.map(value => parseObjectReference(value, fail)) : fail("invalid_context");
  if (raw.cursor !== undefined && typeof raw.cursor !== "string") return fail("invalid_context");
  return { destinations, ...(typeof raw.cursor === "string" ? { cursor: raw.cursor } : {}), limit: readPageLimit(raw.limit, maximum, fail, "invalid_context") };
}

export function readPage(entries: readonly QueryPageEntry[], snapshot: string, at: string, cursor?: string): QueryPage {
  return {
    readVersion: "1.0.0",
    payload: { items: entries.map(entry => entry.value) },
    annotations: entries.map((entry, position) => ({
      pointer: `/items/${position}`,
      ref: entry.ref,
      schemaRef: entry.schemaRef,
      destination: entry.destination,
      position,
      evidence: { evidenceId: entry.evidenceId, revision: "1", observedAt: at },
    })),
    observedAt: at,
    ordering: "provider",
    snapshot: { kind: "stable", id: snapshot },
    ...(cursor === undefined ? {} : { cursor }),
  };
}
