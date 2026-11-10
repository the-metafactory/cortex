// glossary-ignore: host, owner
import { createHash } from "node:crypto";
import type { AuthorityState, HostRecord, RestrictionRecord } from "../../../conversations/authority-records";
import { canonicalWire } from "../../../conversations/domain-adapters/operations/validation";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";

export const GRAPH_SCOPE_ADAPTER_ID = "work-graph";
export const GRAPH_SCOPE_OBJECT_TYPE = "repository";
export const GRAPH_SCOPE_RESOLVER_BINDING = "desk-graph-repositories";

const SCOPE_DECISION_REF = "desk-settings-graph-scope";
const SCOPE_AUDIENCES: RestrictionRecord["audiences"] = ["web", "model", "view"];
const SCOPE_EGRESS: RestrictionRecord["egress"] = "cloud";

export interface GraphScopeStore {
  inspectHostRecords(): Promise<AuthorityState>;
  publishHostRecord(record: HostRecord, expectedRevision: number): Promise<void>;
}

export interface GraphScopeBinding {
  readonly store: GraphScopeStore;
  readonly stack: string;
  readonly principalRef: string;
  readonly connectionId?: string;
  readonly now?: () => number;
}

export interface GraphScopeAddress {
  readonly connectionId: string;
  readonly principalRef: string;
}

export type GraphScopePublication = { ok: true; changed: string[] } | { ok: false; reason: string };

function scopedUuid(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The one `work-graph` connection a stack owns, derived from the stack name so a tick can publish its
 * scope before the connection is set up and the later cutover adopts the same identity.
 */
export const workGraphConnectionId = (stack: string): string => scopedUuid("cortex.desk.graph-scope/1", stack);

const scopeRestrictionRef = (stack: string, principalRef: string, ref: string): string => scopedUuid("cortex.desk.graph-scope/1", stack, principalRef, ref);

/** The destination identity a ticked repository takes on that connection: its canonical ID is the exact stored ref. */
export const graphScopeSource = (ref: string, connectionId: string): ObjectReference => ({ adapterId: GRAPH_SCOPE_ADAPTER_ID, connectionId, objectType: GRAPH_SCOPE_OBJECT_TYPE, canonicalId: ref });

const scopeRestrictions = (state: AuthorityState, connectionId: string): RestrictionRecord[] =>
  Object.values(state.records).flatMap(records => {
    const head = records.at(-1);
    return head?.kind === "restriction" && head.value.source.adapterId === GRAPH_SCOPE_ADAPTER_ID && head.value.source.connectionId === connectionId && head.value.source.objectType === GRAPH_SCOPE_OBJECT_TYPE ? [head.value] : [];
  });

const byRevisionDescending = (left: RestrictionRecord, right: RestrictionRecord): number => Number(right.revision) - Number(left.revision);

/** Every active repository destination the scope grants this principal on that connection, ordered by exact ref. An empty record set grants nothing. */
export function permittedGraphDestinations(state: AuthorityState, address: GraphScopeAddress): ObjectReference[] {
  const held = new Map<string, ObjectReference>();
  for (const record of scopeRestrictions(state, address.connectionId)) {
    if (record.status !== "active" || !record.readScope.includes(address.principalRef)) continue;
    held.set(record.source.canonicalId, record.source);
  }
  return [...held.values()].sort((left, right) => left.canonicalId.localeCompare(right.canonicalId));
}

/** True only for the exact stored ref a `repository` restriction source carries: a string comparison, no normalisation. */
export function graphDestinationPermitted(state: AuthorityState, address: GraphScopeAddress, ref: string): boolean {
  return permittedGraphDestinations(state, address).some(source => source.canonicalId === ref);
}

const failureReason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Publishes the Desk Settings graph scope as host authority restrictions: one `repository` restriction per
 * ticked ref on the stack's `work-graph` connection, revoked when the ref is unticked. The Settings route is
 * the only caller. The graph cutover registers `GRAPH_SCOPE_RESOLVER_BINDING` so the mediator revalidates each
 * restriction as a source, and adopts `workGraphConnectionId` as the connection's own identity and destination
 * list. The Settings table and the host store are separate stores, so the route saves the table first and puts
 * it back when publication fails: a crash between the two leaves the authority narrower than Settings, never
 * wider, and the next change publishes the whole ticked set again.
 */
export class GraphScope {
  readonly connectionId: string;

  constructor(private readonly binding: GraphScopeBinding) {
    this.connectionId = binding.connectionId ?? workGraphConnectionId(binding.stack);
  }

  private address(): GraphScopeAddress {
    return { connectionId: this.connectionId, principalRef: this.binding.principalRef };
  }

  private now(): string {
    return String((this.binding.now ?? Date.now)());
  }

  private current(record: RestrictionRecord | undefined, ref: string): boolean {
    return record?.status === "active" && canonicalWire(record.source) === canonicalWire(graphScopeSource(ref, this.connectionId)) && canonicalWire(record.readScope) === canonicalWire([this.binding.principalRef]) && canonicalWire(record.audiences) === canonicalWire(SCOPE_AUDIENCES) && record.egress === SCOPE_EGRESS && record.resolverBinding === GRAPH_SCOPE_RESOLVER_BINDING;
  }

  private record(ref: string, status: RestrictionRecord["status"], existing?: RestrictionRecord): RestrictionRecord {
    const source = graphScopeSource(ref, this.connectionId);
    const base: RestrictionRecord = existing ?? {
      version: 1, status, restrictionRef: scopeRestrictionRef(this.binding.stack, this.binding.principalRef, ref), source,
      ownerRevision: this.now(), decisionRef: SCOPE_DECISION_REF, audiences: [...SCOPE_AUDIENCES], egress: SCOPE_EGRESS,
      readScope: [this.binding.principalRef], resolverBinding: GRAPH_SCOPE_RESOLVER_BINDING, revision: "1",
    };
    return { ...base, status, source, ownerRevision: this.now(), revision: String(Number(existing?.revision ?? "0") + 1) };
  }

  async permitted(): Promise<ObjectReference[]> {
    return permittedGraphDestinations(await this.binding.store.inspectHostRecords(), this.address());
  }

  async admits(ref: string): Promise<boolean> {
    return graphDestinationPermitted(await this.binding.store.inspectHostRecords(), this.address(), ref);
  }

  async publish(refs: readonly string[]): Promise<GraphScopePublication> {
    const wanted = [...new Set(refs)].sort();
    const heads = scopeRestrictions(await this.binding.store.inspectHostRecords(), this.connectionId);
    const groups = new Map<string, RestrictionRecord[]>();
    for (const record of heads) groups.set(record.source.canonicalId, [...(groups.get(record.source.canonicalId) ?? []), record]);
    for (const [canonicalId, records] of groups) {
      if (records.filter(record => record.status === "active").length > 1) return { ok: false, reason: `${canonicalId} already has more than one active restriction.` };
    }
    const revocations = heads.filter(record => record.status === "active" && !wanted.includes(record.source.canonicalId)).sort(byRevisionDescending);
    const additions = wanted.flatMap(ref => {
      const latest = [...(groups.get(ref) ?? [])].sort(byRevisionDescending)[0];
      return this.current(latest, ref) ? [] : [{ ref, existing: latest }];
    });
    const changes = [
      ...revocations.map(record => ({ value: this.record(record.source.canonicalId, "revoked", record), expected: Number(record.revision) })),
      ...additions.map(item => ({ value: this.record(item.ref, "active", item.existing), expected: Number(item.existing?.revision ?? "0") })),
    ];
    const changed: string[] = [];
    for (const change of changes) {
      try {
        await this.binding.store.publishHostRecord({ kind: "restriction", value: change.value }, change.expected);
      } catch (err) {
        return { ok: false, reason: failureReason(err) };
      }
      changed.push(change.value.source.canonicalId);
    }
    return { ok: true, changed };
  }
}
