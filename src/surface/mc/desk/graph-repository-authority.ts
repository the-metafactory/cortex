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
const STACK_ID = /^[^/\s]+\/[^/\s]+$/;

/**
 * A stack's canonical identity, `stack.id` (`{principal}/{slug}`). The graph scope's connection identity derives
 * from this literal, so a caller holding a config locator, a directory name or a bare slug has to resolve it
 * first instead of minting a connection the graph cutover could never adopt.
 */
export type StackId = string & { readonly canonicalStackId: "stack.id" };

/** Claims a value as a stack's canonical `stack.id`, refusing anything that is not `{principal}/{slug}`. */
export function stackId(value: string): StackId {
  if (!STACK_ID.test(value)) throw new Error(`A stack id is {principal}/{slug}, but this one is ${JSON.stringify(value)}.`);
  return value as StackId;
}

export interface GraphScopeStore {
  inspectHostRecords(): Promise<AuthorityState>;
  publishHostRecord(record: HostRecord, expectedRevision: number): Promise<void>;
}

export interface GraphScopeBinding {
  readonly store: GraphScopeStore;
  readonly stackId: StackId;
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
 * The one `work-graph` connection a stack owns, derived from its `stack.id` so a tick can publish its scope
 * before the connection is set up and the later cutover adopts the same identity.
 */
export const workGraphConnectionId = (stackId: StackId): string => scopedUuid("cortex.desk.graph-scope/1", stackId);

const scopeRestrictionRef = (stackId: StackId, principalRef: string, ref: string): string => scopedUuid("cortex.desk.graph-scope/1", stackId, principalRef, ref);

/** The destination identity a ticked repository takes on that connection: its canonical ID is the exact stored ref. */
export const graphScopeSource = (ref: string, connectionId: string): ObjectReference => ({ adapterId: GRAPH_SCOPE_ADAPTER_ID, connectionId, objectType: GRAPH_SCOPE_OBJECT_TYPE, canonicalId: ref });

/** The current record of every graph-scope restriction chain, whichever connection it names: what Settings published. */
export function graphScopeRestrictionHeads(state: AuthorityState): RestrictionRecord[] {
  return Object.values(state.records).flatMap(records => {
    const head = records.at(-1);
    return head?.kind === "restriction" && head.value.source.adapterId === GRAPH_SCOPE_ADAPTER_ID ? [head.value] : [];
  });
}

const scopeRestrictions = (state: AuthorityState, connectionId: string): RestrictionRecord[] =>
  graphScopeRestrictionHeads(state).filter(record => record.source.connectionId === connectionId && record.source.objectType === GRAPH_SCOPE_OBJECT_TYPE);

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

/** The reason a failed publication carries: what the Settings route reports and logs. */
export const failureReason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const SCOPE_FIELDS = ["source", "readScope", "audiences", "egress", "resolverBinding"] as const;

type ScopeFields = Pick<RestrictionRecord, (typeof SCOPE_FIELDS)[number]>;

const pickScopeFields = (record: RestrictionRecord): ScopeFields => Object.fromEntries(SCOPE_FIELDS.map(field => [field, record[field]])) as ScopeFields;

/**
 * Publishes the Desk Settings graph scope as host authority restrictions: one `repository` restriction per
 * ticked ref on the stack's `work-graph` connection, revoked when the ref is unticked. Settings is the only
 * caller. The graph cutover registers `GRAPH_SCOPE_RESOLVER_BINDING` so the mediator revalidates each
 * restriction as a source, and adopts `workGraphConnectionId` as the connection's own identity and destination
 * list. The Settings table and the authority store are separate stores, so the route orders each change so the
 * authority is never wider than the table: a tick writes its row and puts it back when the publication fails,
 * an untick withdraws the restriction and writes its row only after that landed. A crash between the two
 * writes leaves the authority narrower than Settings; a tick whose publication failed keeps its row exactly
 * when the withdrawal that would have removed it cannot land again, so the table still covers every published
 * restriction. Either way the next change republishes the whole ticked set.
 */
export class GraphScope {
  readonly connectionId: string;

  constructor(private readonly binding: GraphScopeBinding) {
    this.connectionId = binding.connectionId ?? workGraphConnectionId(binding.stackId);
  }

  private address(): GraphScopeAddress {
    return { connectionId: this.connectionId, principalRef: this.binding.principalRef };
  }

  private now(): string {
    return String((this.binding.now ?? Date.now)());
  }

  private scopeFields(ref: string): ScopeFields {
    return { source: graphScopeSource(ref, this.connectionId), readScope: [this.binding.principalRef], audiences: [...SCOPE_AUDIENCES], egress: SCOPE_EGRESS, resolverBinding: GRAPH_SCOPE_RESOLVER_BINDING };
  }

  private current(record: RestrictionRecord | undefined, ref: string): boolean {
    return record?.status === "active" && canonicalWire(pickScopeFields(record)) === canonicalWire(this.scopeFields(ref));
  }

  private record(ref: string, status: RestrictionRecord["status"], existing?: RestrictionRecord): RestrictionRecord {
    const fields = this.scopeFields(ref);
    const base: RestrictionRecord = existing ?? {
      version: 1, status, restrictionRef: scopeRestrictionRef(this.binding.stackId, this.binding.principalRef, ref), ...fields,
      ownerRevision: this.now(), decisionRef: SCOPE_DECISION_REF, revision: "1",
    };
    return { ...base, ...fields, status, ownerRevision: this.now(), revision: String(Number(existing?.revision ?? "0") + 1) };
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
