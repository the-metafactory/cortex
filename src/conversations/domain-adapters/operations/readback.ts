import type { Denial, HostContext, ObservedRead } from "../../authority";
import type { ReleaseSink } from "../../authority-records";
import type { ReadbackResult } from "../../types";
import type { BoundaryError, ObjectReference } from "../types";
import type { StoredOperation } from "./journal";
import { ObjectReadbackSchema, parseWire, type ObjectReadback, type OperationState } from "./types";
import { canonicalWire } from "./validation";

export const FAST_LOOKUP_WAIT_MS = 5_000;
export const GRAPH_LOOKUP_WAIT_MS = 20_000;
const GRAPH_FAMILIES = ["work-graph", "graph"];

export function boundedWaitMs(subject: string): number {
  return GRAPH_FAMILIES.some(family => subject === family || subject.startsWith(`${family}.`) || subject.startsWith(`${family}-`)) ? GRAPH_LOOKUP_WAIT_MS : FAST_LOOKUP_WAIT_MS;
}

export interface ReadbackAuthority {
  readbackObserved(context: HostContext, request: { lifecycleVersion: "1.0.0"; ref: ObjectReference }, sink: ReleaseSink, signal?: AbortSignal): Promise<ObservedRead>;
}
export interface ReadbackOptions { authority: ReadbackAuthority; waitMs?: (ref: ObjectReference) => number }
export type ReadbackOutcome =
  | { kind: "released"; readback: ObjectReadback; decisionRef: string }
  | { kind: "withheld"; reason: BoundaryError; recovery: Denial["recovery"] }
  | { kind: "unavailable"; reason: BoundaryError };

const unavailable = (code: string, message: string): ReadbackOutcome => ({ kind: "unavailable", reason: { code, message } });

export async function timeBoxed<T>(waitMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<{ done: false }>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ done: false }); }, waitMs); });
  try { return await Promise.race([work(controller.signal).then(value => ({ done: true as const, value })), expiry]); }
  finally { clearTimeout(timer); }
}

export class ObjectReader {
  private readonly waitFor: (ref: ObjectReference) => number;

  constructor(private readonly options: ReadbackOptions) {
    this.waitFor = options.waitMs ?? (ref => boundedWaitMs(ref.adapterId));
  }

  async read(context: HostContext, ref: ObjectReference, sink: ReleaseSink): Promise<ReadbackOutcome> {
    const request = { lifecycleVersion: "1.0.0" as const, ref };
    const waited = await timeBoxed(this.waitFor(ref), signal => this.options.authority.readbackObserved(context, request, sink, signal));
    if (!waited.done) return unavailable("deadline_exceeded", "The owner did not answer the object read within its bounded wait.");
    const projection = waited.value.projection;
    if (projection.kind === "withheld") return { kind: "withheld", reason: projection.reason, recovery: projection.recovery };
    try {
      const readback = parseWire(ObjectReadbackSchema, projection.value);
      if (canonicalWire(readback.ref) !== canonicalWire(ref)) return unavailable("invalid_output", "The owner answered for a different object.");
      return { kind: "released", readback, decisionRef: projection.decisionRef };
    } catch (error) { return unavailable("invalid_output", error instanceof Error ? "The owner read failed lifecycle validation." : "The owner read was unreadable."); }
  }
}

export type HistoricStanding = "succeeded" | "failed" | "conflict" | "cancelled" | "refused" | "uncertain" | "confirmed" | "in-flight";
export interface HistoricAndCurrent {
  historic: HistoricStanding;
  current: ObjectReadback["result"]["kind"] | "withheld" | "not-read";
  recreateAllowed: false;
}

const HISTORIC: Record<OperationState, HistoricStanding> = { confirmed: "confirmed", dispatching: "in-flight", pending: "in-flight", uncertain: "uncertain", succeeded: "succeeded", failed: "failed", conflict: "conflict", refused: "refused", cancelled: "cancelled" };

export function separateHistoricFromCurrent(stored: StoredOperation, current: ReadbackOutcome | null): HistoricAndCurrent {
  const standing = current === null ? "not-read" : current.kind === "released" ? current.readback.result.kind : current.kind === "withheld" ? "withheld" : "unavailable";
  return { historic: HISTORIC[stored.journal.state], current: standing, recreateAllowed: false };
}

export interface LegacyReadbackMapping { identityLinked: boolean; deletionProof: boolean }
export const CONSERVATIVE_LEGACY_READBACK: LegacyReadbackMapping = { identityLinked: false, deletionProof: false };
export interface LegacyReadbackProjection {
  historic: "positive-linked" | "unknown";
  current: "present" | "deleted" | "unknown" | "unavailable";
  canonicalId?: string;
  url?: string;
  retryPermitted: false;
  observedAt: string;
}

export function convertLegacyReadback(result: ReadbackResult, observedAt: string, mapping: LegacyReadbackMapping = CONSERVATIVE_LEGACY_READBACK): LegacyReadbackProjection {
  if (result === null) return { historic: "unknown", current: "unavailable", retryPermitted: false, observedAt };
  if (!result.found) return { historic: "unknown", current: mapping.deletionProof ? "deleted" : "unknown", retryPermitted: false, observedAt };
  return { historic: mapping.identityLinked ? "positive-linked" : "unknown", current: "present", canonicalId: result.canonicalId, ...(result.url === undefined ? {} : { url: result.url }), retryPermitted: false, observedAt };
}
