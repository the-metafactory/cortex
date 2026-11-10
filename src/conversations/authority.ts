import { acceptsReadObject } from "./domain-adapters/reads/bindings";
import { validateObservationBatch, type ObservationBasis, type ObservationConnector, type ObservationRequest, type ObservationRow, type ObservationView } from "./domain-adapters/reads/observation-types";
import { QuerySourceSchema, type QueryDispatch, type QueryFetchRequest } from "./domain-adapters/reads/query-types";
import { validateQueryPage, type ValidatedQueryPage } from "./domain-adapters/reads/query-validation";
import { WriterAuthority } from "./domain-adapters/operations/writer-authority";
import { AuthorityPublication } from "./authority-publication";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Context } from "@earendil-works/chord";
import type { Session, Tx } from "@earendil-works/pi-durable";
import type { DomainAdapterRegistry } from "./domain-adapters/registry";
import { ReadAdmissionRequestSchema, ReadPageSchema, type ReadBinding, type ReadPage, type ReadRequest } from "./domain-adapters/reads/types";
import type { ReadBindings } from "./domain-adapters/reads/bindings";
import { ObjectReferenceSchema, type BoundaryError, type ObjectReference } from "./domain-adapters/types";
import { CancelRequestSchema, DispatchRequestSchema, ObjectReadbackSchema, OperationLookupSchema, OwnerResultSchema, OwnerSupportSchema, parseWire, type ApprovedSnapshot, type Authority, type CancelRequest, type DispatchRequest, type Json, type LookupRequest, type OwnerSupport, type ReadbackRequest } from "./domain-adapters/operations/types";
import { canonicalWire, validateSnapshot, validateResultPayload } from "./domain-adapters/operations/validation";
import { OperationJournalStore, type Approval, type StoredOperation } from "./domain-adapters/operations/journal";
import { fenceTargetOf, type FenceGate } from "./domain-adapters/operations/triggers";
import type { DiagnosticRecorder } from "./domain-adapters/diagnostics";
import { AuthorityDoc, AuthorityStateSchema, ConfirmationRecordSchema, HostRecordSchema, PolicyInputsSchema, ReleaseSinkSchema, authorityHash, authorityJson, exactReferences, recordId, recordRevision, type AuthorityState, type ConfirmationRecord, type ConnectionRecord, type DecisionRecord, type GrantRecord, type HostRecord, type PolicyInputs, type PrincipalBinding, type ReleaseSink, type RestrictionRecord } from "./authority-records";

const AuthenticatedBindingSchema = z.object({ principal: z.string().min(1), stack: z.string().min(1), conversationId: z.string().min(1), authenticatedSessionRef: z.string().min(1), transport: z.enum(["web", "discord"]), audience: z.enum(["web", "discord", "model", "view"]), route: z.string().optional(), viewId: z.string().optional(), expiresAt: z.iso.datetime(), maintenance: z.boolean() }).strict();
export type AuthenticatedBinding = z.infer<typeof AuthenticatedBindingSchema>;
declare const hostContext: unique symbol;
export interface HostContext { readonly [hostContext]: true }
export interface WriterLease { bindingKey: string; epoch: number; instanceId: string; supervisorReceiptRef: string }
export interface Denial { kind: "denied"; reason: BoundaryError; recovery: "authenticate" | "review-again" | "reauthorize" | "use-private-web" | "retry-later" | "operator-cutover" }
export type AuthorityCheck = { kind: "allowed"; authority: Authority } | Denial;
export type ReleaseProjection<T> = { kind: "released"; value: T; decisionRef: string } | { kind: "withheld"; reason: BoundaryError; recovery: Denial["recovery"] };
export interface TrustedConnector {
  observation?: ObservationConnector;
  writerOwner: string;
  authorizeConnection(connection: ConnectionRecord): Promise<{ version: 1; available: boolean; revision: string }>;
  support: OwnerSupport;
  dispatch(request: DispatchRequest, signal: AbortSignal): Promise<unknown>;
  cancel?(request: CancelRequest, signal: AbortSignal): Promise<unknown>;
  lookup?(request: LookupRequest, signal: AbortSignal): Promise<unknown>;
  readbackCapabilityId?: string;
  readback?(request: ReadbackRequest, signal: AbortSignal): Promise<unknown>;
  read?(request: ReadRequest, signal: AbortSignal): Promise<unknown>;
  query?(request: QueryFetchRequest, signal: AbortSignal): Promise<unknown>;
}
export interface AuthorityBindings {
  currentRevision(): string;
  authenticate(sessionRef: string): Promise<AuthenticatedBinding | null>;
  policy(binding: AuthenticatedBinding): Promise<PolicyInputs>;
  writer(lease: WriterLease, snapshot: ApprovedSnapshot): Promise<boolean>;
  restrictions: ReadonlyMap<string, (record: RestrictionRecord) => Promise<RestrictionRecord | null>>;
  connectors: ReadonlyMap<string, TrustedConnector>;
  sinks: ReadonlyMap<string, (value: Json) => Promise<void>>;
  readBindings?: ReadBindings;
}
export interface HostPolicyState { principal: string; stack: string; policy: "local" | "cloud"; tool: Json; communication: Json; link: Json; work: Json; history: Json }
export interface ObservedRead { projection: ReleaseProjection<Json>; called: boolean; value?: Json }
export type { LookupRequest, ReadbackRequest };
const LookupRequestSchema = z.object({ lifecycleVersion: z.literal("1.0.0"), operationId: z.string().min(1), ownerRequestId: z.string().min(1) }).strict();
const ReadbackRequestSchema = z.object({ lifecycleVersion: z.literal("1.0.0"), ref: ObjectReferenceSchema }).strict();
const LeaseSchema = z.object({ bindingKey: z.string().min(1), epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), instanceId: z.string().min(1), supervisorReceiptRef: z.string().min(1) }).strict();
const RowCapabilityRequestSchema = z.object({ adapterId: z.string().min(1), connectionId: z.string().min(1), capabilityId: z.string().min(1), destinations: z.array(ObjectReferenceSchema).min(1) }).strict();
const denied = (recovery: Denial["recovery"] = "reauthorize"): Denial => ({ kind: "denied", reason: { code: "authority_denied", message: "The current host authority does not permit this action." }, recovery });
const withheld = (known = false): ReleaseProjection<never> => ({ kind: "withheld", reason: { code: known ? "release_withheld" : "not_found", message: known ? "This result is withheld under current access. Continue in private web." : "The requested result is unavailable." }, recovery: known ? "use-private-web" : "reauthorize" });
const INVALID_READBACK_IS_NOT_RELEASABLE = false;
const json = (value: unknown): Json => parseWire(z.json(), value);
const withinLimits = (allowed: ObjectReference[], requested: ObjectReference[]): boolean => new Set(requested.map(canonicalWire)).size === requested.length && requested.every(ref => allowed.some(item => canonicalWire(item) === canonicalWire(ref)));
const accountBinding = (connection: ConnectionRecord): string => authorityHash({ principalRef: connection.principalRef, adapterId: connection.adapterId, connectionId: connection.connectionId, accountScope: connection.accountScope, credentialHandle: connection.credentialHandle, connectorId: connection.connectorId });
function headRecord(state: AuthorityState, kind: "principal", id: string): PrincipalBinding | undefined;
function headRecord(state: AuthorityState, kind: "connection", id: string): ConnectionRecord | undefined;
function headRecord(state: AuthorityState, kind: "grant", id: string): GrantRecord | undefined;
function headRecord(state: AuthorityState, kind: "restriction", id: string): RestrictionRecord | undefined;
function headRecord(state: AuthorityState, kind: HostRecord["kind"], id: string): HostRecord["value"] | undefined {
  const record = state.records[`${kind}:${id}`]?.at(-1);
  return record?.kind === kind ? record.value : undefined;
}
interface ReadOptions { ref?: ObjectReference; validate?: (value: Json) => boolean; observed?: ObservedRead; signal?: AbortSignal; scopes?: ReadScope[] }
export type ReadScope = Pick<ApprovedSnapshot, "capabilityId" | "destinations"> & Partial<Pick<ApprovedSnapshot, "sources" | "policy">>
type HostScope = Required<ReadScope>
const hostScopesOf = (scopes: readonly ReadScope[] = []): HostScope[] => scopes.map(scope => ({ capabilityId: scope.capabilityId, destinations: scope.destinations, sources: scope.sources ?? [], policy: scope.policy ?? "local" }))
interface Resolved { binding: AuthenticatedBinding; principal: PrincipalBinding; connection: ConnectionRecord; restrictions: RestrictionRecord[]; policy: PolicyInputs; vector: Json; policyRevision: string; revision: string; heads: Record<string, number> }
interface Basis { kind: "confirmation"; confirmationId: string } 
interface GrantBasis { kind: "grant"; grantId: string }
type ApprovalInput = Omit<Approval, "authority" | "at">;
export interface AuthorityCollaborators { fences?: FenceGate; diagnostics?: DiagnosticRecorder }

const HOST_DATA_SUBJECT = "host-data";

export class AuthorityMediator {
  private readonly contexts = new WeakMap<HostContext, AuthenticatedBinding>();
  private readonly connectors: Map<string, TrustedConnector>;
  private readonly sinks: Map<string, (value: Json) => Promise<void>>;
  private readonly active = new Map<string, { controller: AbortController; heads: Set<string> }>();
  private readonly journal: OperationJournalStore;

  constructor(private readonly engine: Pick<Session, "commit" | "snapshot">, private readonly registry: DomainAdapterRegistry, private readonly bindings: AuthorityBindings, private readonly hostPolicy: (id: string) => Promise<HostPolicyState>, private readonly context: Context, private readonly now: () => Date, private readonly publication: AuthorityPublication, private readonly hostRevision: () => string, private readonly writers: WriterAuthority, private readonly collaborators: AuthorityCollaborators = {}) {
    this.journal = new OperationJournalStore(engine, registry, context, collaborators.fences, collaborators.diagnostics);
    this.connectors = new Map([...bindings.connectors].map(([key, connector]) => [key, Object.freeze({
      ...(connector.observation ? { observation: Object.freeze({ ...connector.observation, fetch: connector.observation.fetch.bind(connector.observation) }) } : {}),
      writerOwner: connector.writerOwner, support: parseWire(OwnerSupportSchema, connector.support), authorizeConnection: connector.authorizeConnection.bind(connector), dispatch: connector.dispatch.bind(connector),
      ...(connector.cancel ? { cancel: connector.cancel.bind(connector) } : {}), ...(connector.lookup ? { lookup: connector.lookup.bind(connector) } : {}), ...(connector.query ? { query: connector.query.bind(connector) } : {}), ...(connector.read ? { read: connector.read.bind(connector) } : {}), ...(connector.readback ? { readback: connector.readback.bind(connector), readbackCapabilityId: connector.readbackCapabilityId } : {}),
    })]));
    this.sinks = new Map(bindings.sinks);
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> { return this.publication.run(run); }

  private async state(): Promise<AuthorityState> {
    const stored = await this.engine.snapshot(AuthorityDoc, this.context);
    return AuthorityStateSchema.parse(stored?.state ?? { version: 1, records: {}, heads: {}, confirmations: [], decisions: [], policies: [], admissions: [], outbox: {}, evidence: {} });
  }

  private async commit<T>(run: (state: AuthorityState, tx: Tx) => Promise<T> | T): Promise<T> {
    return this.engine.commit(async tx => {
      const doc = await tx.doc(AuthorityDoc);
      const state = AuthorityStateSchema.parse(doc.state);
      const result = await run(state, tx);
      doc.state = authorityJson(AuthorityStateSchema.parse(state));
      return result;
    }, this.context);
  }

  inspectHostRecords(): Promise<AuthorityState> { return this.state(); }

  registerReleaseSink(raw: ReleaseSink, send: (value: Json) => Promise<void>): () => void {
    const key = canonicalWire(parseWire(ReleaseSinkSchema, raw));
    if (this.sinks.has(key)) throw new Error("Release sink is already registered.");
    this.sinks.set(key, send);
    return () => { if (this.sinks.get(key) === send) this.sinks.delete(key); };
  }

  async publishHostRecord(raw: HostRecord, expectedRevision: number): Promise<void> {
    const record = parseWire(HostRecordSchema, raw);
    await this.publication.publish(async () => {
      const key = `${record.kind}:${recordId(record)}`;
      await this.commit(state => {
        if ((state.heads[key] ?? 0) !== expectedRevision || recordRevision(record) !== String(expectedRevision + 1)) throw new Error("Authority head changed.");
        const prior = state.records[key]?.at(-1);
        if (record.kind === "principal" && prior?.kind === "principal" && (record.value.principal !== prior.value.principal || record.value.stack !== prior.value.stack)) throw new Error("Principal identity cannot be reassigned.");
        state.records[key] = [...(state.records[key] ?? []), record];
        state.heads[key] = expectedRevision + 1;
      });
      for (const active of this.active.values()) if (active.heads.has(key)) active.controller.abort();
    });
  }

  async authenticate(sessionRef: string): Promise<HostContext | null> {
    const raw = await this.bindings.authenticate(sessionRef);
    if (!raw) return null;
    const binding = parseWire(AuthenticatedBindingSchema, raw);
    const context = Object.freeze({}) as HostContext;
    this.contexts.set(context, binding);
    return context;
  }

  private bound(context: HostContext): AuthenticatedBinding {
    const binding = this.contexts.get(context);
    if (!binding || Date.parse(binding.expiresAt) <= this.now().getTime()) throw new Error("Host authentication is unavailable.");
    return binding;
  }

  private currentRevision(): string {
    const revision = this.bindings.currentRevision();
    if (typeof revision !== "string" || !revision) throw new Error("Current host policy publication is unavailable.");
    return authorityHash({ revision, host: this.hostRevision(), publication: this.publication.head });
  }

  private async resolve(context: HostContext, connectionId: string, snapshot?: ApprovedSnapshot, readRef?: ObjectReference, readRestrictionRef?: string, hostScopes: readonly HostScope[] = []): Promise<Resolved> {
    const revision = this.currentRevision();
    const binding = this.bound(context);
    const authenticated = await this.bindings.authenticate(binding.authenticatedSessionRef);
    if (!authenticated || canonicalWire(parseWire(AuthenticatedBindingSchema, authenticated)) !== canonicalWire(binding)) throw new Error("Authenticated session changed.");
    const state = await this.state();
    const principals = Object.values(state.records).map(values => values.at(-1)).filter(record => record?.kind === "principal" && record.value.principal === binding.principal && record.value.stack === binding.stack && record.value.status === "active");
    if (principals.length !== 1 || principals[0]?.kind !== "principal") throw new Error("Principal binding is unavailable.");
    const principal = principals[0].value;
    const connection = headRecord(state, "connection", connectionId);
    if (connection?.status !== "active" || connection.principalRef !== principal.principalRef || !this.connectors.has(connection.connectorId) || !connection.credentialHandle) throw new Error("Connection binding is unavailable.");
    const connector = this.connectors.get(connection.connectorId);
    if (!connector?.authorizeConnection) throw new Error("Current credential resolution is unavailable.");
    const connectorAdmission = parseWire(z.object({ version: z.literal(1), available: z.boolean(), revision: z.string().min(1) }).strict(), await connector.authorizeConnection(structuredClone(connection)));
    if (!connectorAdmission.available) throw new Error("Current credential or account scope is unavailable.");
    const host = await this.hostPolicy(binding.conversationId);
    if (host.principal !== principal.principal || host.stack !== principal.stack) throw new Error("Conversation identity mismatch.");
    if (snapshot && (snapshot.provenance.conversationId !== binding.conversationId || snapshot.connectionId !== connectionId || snapshot.adapterId !== connection.adapterId)) throw new Error("Snapshot binding mismatch.");
    const sources = [...(snapshot?.sources ?? []), ...hostScopes.flatMap(scope => scope.sources)];
    if (readRef) {
      const records = Object.values(state.records).map(values => values.at(-1)).filter(record => record?.kind === "restriction" && canonicalWire(record.value.source) === canonicalWire(readRef));
      if (records.length !== 1 || records[0]?.kind !== "restriction" || readRestrictionRef !== undefined && records[0].value.restrictionRef !== readRestrictionRef) throw new Error("Current object provenance is unavailable.");
      sources.push({ ref: readRef, restrictionRef: records[0].value.restrictionRef });
    }
    const restrictions = await Promise.all(sources.map(async source => {
      const record = headRecord(state, "restriction", source.restrictionRef);
      if (record?.status !== "active" || canonicalWire(record.source) !== canonicalWire(source.ref) || !record.readScope.includes(principal.principalRef) || !record.resolverBinding) throw new Error("Source provenance is unavailable.");
      const resolver = this.bindings.restrictions.get(record.resolverBinding);
      if (!resolver || canonicalWire(await resolver(structuredClone(record))) !== canonicalWire(record)) throw new Error("Current source restriction is unavailable.");
      return record;
    }));
    const configured = parseWire(PolicyInputsSchema, await this.bindings.policy(binding));
    const policy: PolicyInputs = { ...configured, conversationPolicy: host.policy === "local" || configured.conversationPolicy === "local" ? "local" : "cloud" };
    if (policy.registryRevision !== connection.registryRevision || policy.executionBindingRevision !== connection.executionBindingRef) throw new Error("Execution declaration changed.");
    const heads = Object.fromEntries([`principal:${principal.principalRef}`, `connection:${connectionId}`, ...restrictions.map(record => `restriction:${record.restrictionRef}`)].map(key => [key, state.heads[key] ?? 0]));
    if (revision !== this.currentRevision()) throw new Error("Host policy changed during resolution.");
    const vector = json({ revision, identityBindingRevision: principal.identityBindingRevision, binding, snapshotDigest: snapshot?.digest ?? null, principal, connection, grantHeads: Object.fromEntries(Object.entries(state.heads).filter(([key]) => key.startsWith("grant:"))), context: policy, connectorAdmission, host, restrictions, heads });
    return { binding, principal, connection, restrictions, policy, vector, policyRevision: authorityHash(vector), revision, heads };
  }

  private async recordDenied(context: HostContext, purpose: string, reference: string, recovery: Denial["recovery"] = "reauthorize"): Promise<Denial> {
    const binding = this.contexts.get(context);
    if (binding) await this.commit(state => {
      const principal = Object.values(state.records).map(records => records.at(-1)).find(record => record?.kind === "principal" && record.value.principal === binding.principal && record.value.stack === binding.stack);
      if (principal?.kind !== "principal") return;
      state.decisions.push({ decisionRef: randomUUID(), principalRef: principal.value.principalRef, purpose, reference, basis: null, heads: { ...state.heads }, audience: binding.audience, allowed: false, reasonCode: "authority_denied", authorizedAt: this.now().toISOString(), policyRevision: authorityHash({ heads: state.heads, resolution: "denied" }) });
    });
    return denied(recovery);
  }

  private readable(resolved: Resolved, snapshot?: ReadScope, scopes: ReadScope[] = []): boolean {
    const inScope = (scope: ReadScope): boolean => resolved.connection.readCapabilityIds.includes(scope.capabilityId) && withinLimits(resolved.connection.readDestinations, scope.destinations);
    return resolved.policy.operationVisible && resolved.policy.readsAllowed && (!snapshot || inScope(snapshot)) && scopes.every(inScope);
  }

  private basis(state: AuthorityState, resolved: Resolved, operationId: string, snapshot: ApprovedSnapshot, basis: Basis | GrantBasis, purpose: "mutation" | "cancellation", cancelId?: string): Authority["basis"] {
    if (basis.kind === "confirmation") {
      const record = state.confirmations.find(item => item.confirmationId === basis.confirmationId);
      if (record?.status !== "active" || record.purpose !== purpose || record.cancelId !== cancelId || record.principalRef !== resolved.principal.principalRef || record.operationId !== operationId || record.digest !== snapshot.digest || record.proposalRevision !== snapshot.provenance.revision || record.connectionId !== snapshot.connectionId || record.capabilityId !== snapshot.capabilityId || !exactReferences(record.destinations, snapshot.destinations) || canonicalWire(record.target ?? null) !== canonicalWire(snapshot.target ?? null) || canonicalWire(record.restrictionRefs) !== canonicalWire(snapshot.sources.map(source => source.restrictionRef)) || record.accountBindingDigest !== accountBinding(resolved.connection)) throw new Error("Confirmation does not bind this operation.");
      return { kind: "confirmation", confirmationId: record.confirmationId, transport: record.transport };
    }
    const grant = headRecord(state, "grant", basis.grantId);
    if (grant?.status !== "active" || grant.principalRef !== resolved.principal.principalRef || !this.grantMatches(grant, resolved, snapshot, purpose)) throw new Error("Grant does not bind this operation.");
    resolved.heads[`grant:${grant.grantId}`] = Number(grant.grantRevision);
    return { kind: "grant", grantId: grant.grantId, grantRevision: grant.grantRevision };
  }

  private grantMatches(grant: GrantRecord, resolved: Resolved, snapshot: ApprovedSnapshot, purpose: "mutation" | "cancellation"): boolean {
    const c = grant.constraints;
    const selector = c.context;
    return c.adapterId === snapshot.adapterId && c.connectionId === snapshot.connectionId && grant.purpose === purpose && c.capabilityIds.includes(snapshot.capabilityId) && exactReferences(c.destinations, snapshot.destinations) && canonicalWire(c.target ?? null) === canonicalWire(snapshot.target ?? null) && (selector.kind === "principal" || selector.kind === "conversation" && selector.conversationId === resolved.binding.conversationId || selector.kind === "area" && resolved.policy.areaId !== undefined && selector.areaId === resolved.policy.areaId) && !(c.sourceReleaseCeiling === "local" && snapshot.policy === "cloud");
  }

  private canMutate(resolved: Resolved, snapshot: ApprovedSnapshot): boolean {
    return !resolved.binding.maintenance && resolved.policy.operationVisible && resolved.policy.readsAllowed && resolved.policy.writesAllowed && resolved.connection.writeCapabilityIds.includes(snapshot.capabilityId) && withinLimits(resolved.connection.writeDestinations, snapshot.destinations) && !(snapshot.policy === "cloud" && (resolved.policy.conversationPolicy === "local" || resolved.restrictions.some(record => record.egress === "local")));
  }

  private decision(state: AuthorityState, resolved: Resolved, purpose: string, reference: string, basis: Json, snapshot?: ApprovedSnapshot): DecisionRecord {
    const record: DecisionRecord = { decisionRef: randomUUID(), principalRef: resolved.principal.principalRef, purpose, reference, ...(snapshot ? { snapshotDigest: snapshot.digest } : {}), basis, heads: { ...resolved.heads }, audience: resolved.binding.audience, allowed: true, reasonCode: "allowed", authorizedAt: this.now().toISOString(), policyRevision: resolved.policyRevision };
    state.decisions.push(record);
    if (!state.policies.some(policy => policy.policyRevision === resolved.policyRevision)) state.policies.push({ policyRevision: resolved.policyRevision, input: resolved.vector, allowed: true, reasonCode: "allowed" });
    return record;
  }

  private authority(resolved: Resolved, basis: Authority["basis"], decision: DecisionRecord): Authority {
    return { principalRef: resolved.principal.principalRef, basis, connectionRevision: resolved.connection.connectionRevision, policyRevision: decision.policyRevision, decisionRef: decision.decisionRef, authorizedAt: decision.authorizedAt };
  }

  async confirm(context: HostContext, approval: ApprovalInput): Promise<AuthorityCheck> {
    return this.approve(context, approval, undefined);
  }

  async approveGrant(context: HostContext, approval: ApprovalInput, grantId: string): Promise<AuthorityCheck> {
    return this.approve(context, approval, grantId);
  }

  private async approve(context: HostContext, input: ApprovalInput, grantId: string | undefined): Promise<AuthorityCheck> {
    try {
      const snapshot = validateSnapshot(this.registry, input.snapshot);
      return await this.exclusive(async () => {
        const resolved = await this.resolve(context, snapshot.connectionId, snapshot);
        if (!this.canMutate(resolved, snapshot)) return this.recordDenied(context, "approve", input.operationId);
        const priorJournal = await this.journal.read(input.operationId);
        return this.commit(async (state, tx) => {
          const prior = state.decisions.find(item => item.purpose === "approve" && item.reference === input.operationId && item.snapshotDigest === snapshot.digest && item.principalRef === resolved.principal.principalRef);
          if (priorJournal && !prior) return denied("review-again");
          if (prior && priorJournal) {
            const event = priorJournal.journal.events[0];
            if (event?.event.kind !== "approved" || grantId && (event.event.authority.basis.kind !== "grant" || event.event.authority.basis.grantId !== grantId)) return denied("review-again");
            const approvedAuthority = event.event.authority;
            const approvedConnection = state.records[`connection:${snapshot.connectionId}`]?.find(record => record.kind === "connection" && record.value.connectionRevision === approvedAuthority.connectionRevision);
            if (approvedConnection?.kind !== "connection" || accountBinding(approvedConnection.value) !== accountBinding(resolved.connection)) return denied("review-again");
            if (canonicalWire(this.basis(state, resolved, input.operationId, snapshot, event.event.authority.basis, "mutation")) !== canonicalWire(event.event.authority.basis)) return denied("review-again");
            if (canonicalWire(priorJournal.journal.snapshot) !== canonicalWire(snapshot) || priorJournal.journal.ownerRequestId !== input.ownerRequestId || priorJournal.journal.idempotencyKey !== input.idempotencyKey) return denied("review-again");
            return { kind: "allowed" as const, authority: event.event.authority };
          }
          const basis = grantId ? { kind: "grant" as const, grantId } : { kind: "confirmation" as const, confirmationId: randomUUID() };
          if (basis.kind === "confirmation") state.confirmations.push(this.confirmation(resolved, input.operationId, snapshot, basis.confirmationId, "mutation"));
          const boundBasis = this.basis(state, resolved, input.operationId, snapshot, basis, "mutation");
          const decision = this.decision(state, resolved, "approve", input.operationId, json(boundBasis), snapshot);
          const authority = this.authority(resolved, boundBasis, decision);
          await this.journal.approveInTransaction(tx, { ...input, snapshot, authority, at: decision.authorizedAt });
          return { kind: "allowed" as const, authority };
        });
      });
    } catch (error) { return this.recordDenied(context, "approve", input.operationId, error instanceof Error ? "review-again" : "retry-later"); }
  }

  private confirmation(resolved: Resolved, operationId: string, snapshot: ApprovedSnapshot, confirmationId: string, purpose: "mutation" | "cancellation", cancelId?: string): ConfirmationRecord {
    return ConfirmationRecordSchema.parse({ version: 1, status: "active", confirmationId, principalRef: resolved.principal.principalRef, authenticatedSessionRef: resolved.binding.authenticatedSessionRef, transport: resolved.binding.transport, operationId, digest: snapshot.digest, proposalRevision: snapshot.provenance.revision, connectionId: snapshot.connectionId, capabilityId: snapshot.capabilityId, destinations: snapshot.destinations, ...(snapshot.target ? { target: snapshot.target } : {}), restrictionRefs: snapshot.sources.map(source => source.restrictionRef), confirmedAt: this.now().toISOString(), purpose, ...(cancelId ? { cancelId } : {}), accountBindingDigest: accountBinding(resolved.connection) });
  }

  confirmCancellation(context: HostContext, operationId: string, cancelId: string): Promise<AuthorityCheck> {
    return this.cancellationApproval(context, operationId, cancelId);
  }

  approveCancellationGrant(context: HostContext, operationId: string, cancelId: string, grantId: string): Promise<AuthorityCheck> {
    return this.cancellationApproval(context, operationId, cancelId, grantId);
  }

  private async cancellationApproval(context: HostContext, operationId: string, cancelId: string, grantId?: string): Promise<AuthorityCheck> {
    try {
      return await this.exclusive(async () => {
        const stored = await this.journal.read(operationId);
        if (!stored || "kind" in stored.journal.snapshot) return denied("review-again");
        const snapshot = stored.journal.snapshot;
        const resolved = await this.resolve(context, snapshot.connectionId, snapshot);
        if (!this.canMutate(resolved, snapshot) || resolved.binding.maintenance) return denied();
        return this.commit(state => {
          const confirmation = state.confirmations.find(item => item.purpose === "cancellation" && item.operationId === operationId && item.cancelId === cancelId && item.principalRef === resolved.principal.principalRef && item.status === "active") ?? this.confirmation(resolved, operationId, snapshot, randomUUID(), "cancellation", cancelId);
          if (!grantId && !state.confirmations.includes(confirmation)) state.confirmations.push(confirmation);
          const basis = this.basis(state, resolved, operationId, snapshot, grantId ? { kind: "grant", grantId } : { kind: "confirmation", confirmationId: confirmation.confirmationId }, "cancellation", cancelId);
          return { kind: "allowed" as const, authority: this.authority(resolved, basis, this.decision(state, resolved, "cancel-approve", `${operationId}:${cancelId}`, json(basis), snapshot)) };
        });
      });
    } catch (error) { return error instanceof Error ? denied() : denied("retry-later"); }
  }

  private async mutationCheck(context: HostContext, stored: StoredOperation, supplied: Authority, purpose: "mutation" | "cancellation", cancelId?: string): Promise<Resolved> {
    if ("kind" in stored.journal.snapshot) throw new Error("Legacy authority is insufficient.");
    const snapshot = validateSnapshot(this.registry, stored.journal.snapshot);
    const resolved = await this.resolve(context, snapshot.connectionId, snapshot);
    if (!this.canMutate(resolved, snapshot)) throw new Error("Current write policy denies.");
    const state = await this.state();
    const decision = state.decisions.find(item => item.decisionRef === supplied.decisionRef);
    if (!decision || !decision.allowed || decision.principalRef !== resolved.principal.principalRef || decision.snapshotDigest !== snapshot.digest || decision.reference !== (purpose === "cancellation" ? `${stored.journal.operationId}:${cancelId}` : stored.journal.operationId) || supplied.principalRef !== resolved.principal.principalRef || decision.policyRevision !== supplied.policyRevision || decision.authorizedAt !== supplied.authorizedAt || canonicalWire(decision.basis) !== canonicalWire(supplied.basis)) throw new Error("Authority is not a protected host decision.");
    const oldConnection = state.records[`connection:${snapshot.connectionId}`]?.find(record => record.kind === "connection" && record.value.connectionRevision === supplied.connectionRevision);
    if (oldConnection?.kind !== "connection" || accountBinding(oldConnection.value) !== accountBinding(resolved.connection)) throw new Error("Connection account binding changed.");
    const basis = this.basis(state, resolved, stored.journal.operationId, snapshot, supplied.basis, purpose, cancelId);
    if (canonicalWire(basis) !== canonicalWire(supplied.basis)) throw new Error("Grant revision changed.");
    return resolved;
  }

  async preflight(context: HostContext, operationId: string, supplied: Authority, lease: WriterLease, purpose: "mutation" | "cancellation", cancelId?: string): Promise<{ kind: "allowed" } | Denial> {
    try {
      const checkedLease = parseWire(LeaseSchema, lease);
      const stored = await this.journal.read(operationId);
      if (!stored || "kind" in stored.journal.snapshot) return denied("review-again");
      const snapshot = stored.journal.snapshot;
      const resolved = await this.mutationCheck(context, stored, supplied, purpose, cancelId);
      if (!await this.bindings.writer(checkedLease, snapshot)) return denied("operator-cutover");
      const connector = this.connectors.get(resolved.connection.connectorId);
      const bound = connector?.support.adapterId === snapshot.adapterId && connector.support.connectionId === snapshot.connectionId && connector.support.capabilityId === snapshot.capabilityId && connector.support.declarationId === resolved.connection.executionBindingRef;
      return bound ? { kind: "allowed" } : denied();
    } catch (error) { return denied(error instanceof Error ? "review-again" : "retry-later"); }
  }

  async dispatch(context: HostContext, raw: DispatchRequest, lease: WriterLease): Promise<{ kind: "admitted" } | Denial> {
    return this.invokeMutation(context, raw, lease, "dispatch");
  }

  async cancel(context: HostContext, raw: CancelRequest, lease: WriterLease): Promise<{ kind: "admitted" } | Denial> {
    return this.invokeMutation(context, raw, lease, "cancel");
  }

  private async invokeMutation(context: HostContext, raw: DispatchRequest | CancelRequest, lease: WriterLease, kind: "dispatch" | "cancel"): Promise<{ kind: "admitted" } | Denial> {
    let entered: { pending: Promise<unknown>; controller: AbortController; operationId: string; key: string } | undefined;
    try {
      const request = kind === "dispatch" ? parseWire(DispatchRequestSchema, raw) : parseWire(CancelRequestSchema, raw);
      const checkedLease = parseWire(LeaseSchema, lease);
      const prepared = await this.journal.read(request.operationId);
      if (!prepared) return denied("review-again");
      await this.mutationCheck(context, prepared, request.authority, kind === "dispatch" ? "mutation" : "cancellation", "cancelId" in request ? request.cancelId : undefined);
      const outcome = await this.exclusive(async () => {
        const publicationHead = this.publication.head;
        const stored = await this.journal.read(request.operationId);
        if (!stored || "kind" in stored.journal.snapshot) return denied("review-again");
        const snapshot = stored.journal.snapshot;
        const resolved = await this.mutationCheck(context, stored, request.authority, kind === "dispatch" ? "mutation" : "cancellation", "cancelId" in request ? request.cancelId : undefined);
        if (!await this.bindings.writer(checkedLease, snapshot)) return denied("operator-cutover");
        const connector = this.connectors.get(resolved.connection.connectorId);
        if (connector?.support.adapterId !== snapshot.adapterId || connector.support.connectionId !== snapshot.connectionId || connector.support.capabilityId !== snapshot.capabilityId || connector.support.declarationId !== resolved.connection.executionBindingRef) return denied();
        const key = kind === "dispatch" && "attemptId" in request ? `${request.operationId}:${request.attemptId}` : `${request.operationId}:${"cancelId" in request ? request.cancelId : ""}:cancel`;
        if (kind === "dispatch") {
          if (!("attemptId" in request) || stored.journal.state !== "dispatching" || stored.journal.idempotencyKey !== request.idempotencyKey || stored.journal.ownerRequestId !== request.ownerRequestId || canonicalWire(snapshot) !== canonicalWire(request.snapshot)) return denied("review-again");
          const attempt = stored.journal.events.findLast(item => item.event.kind === "attempt-prepared");
          if (attempt?.event.kind !== "attempt-prepared" || attempt.event.attempt.attemptId !== request.attemptId || canonicalWire(attempt.event.attempt.authority) !== canonicalWire(request.authority) || attempt.event.attempt.supportDeclarationId !== request.supportDeclarationId || attempt.event.attempt.deadlineAt !== request.deadlineAt || Date.parse(request.deadlineAt) <= this.now().getTime()) return denied("review-again");
        } else if (!connector.cancel || connector.support.cancellation === "none" || !["dispatching", "pending", "uncertain"].includes(stored.journal.state)) return denied();
        const decision = await this.commit(state => {
          if (state.admissions.some(item => item.key === key)) return null;
          const decision = this.decision(state, resolved, kind, request.operationId, json(request.authority.basis), snapshot);
          state.admissions.push({ key, operationId: request.operationId, kind, authority: json(this.authority(resolved, request.authority.basis, decision)), lease: json(checkedLease), at: decision.authorizedAt });
          return decision;
        });
        if (!decision) return denied("review-again");
        if (!await this.bindings.writer(checkedLease, snapshot)) return denied("operator-cutover");
        const final = await this.resolve(context, snapshot.connectionId, snapshot);
        if (publicationHead !== this.publication.head || final.revision !== this.currentRevision() || final.policyRevision !== resolved.policyRevision || !this.canMutate(final, snapshot)) return denied();
        if (!await this.writers.admits(checkedLease, final.principal.stack, connector.writerOwner, snapshot) || publicationHead !== this.publication.head) return denied("operator-cutover");
        const cancel = connector.cancel?.bind(connector);
        const controller = new AbortController();
        this.active.set(key, { controller, heads: new Set(Object.keys(resolved.heads)) });
        let pending: Promise<unknown>;
        try { pending = "attemptId" in request ? connector.dispatch(request, controller.signal) : cancel ? cancel(request, controller.signal) : Promise.reject(new Error("Cancellation binding unavailable.")); }
        catch (error) { pending = Promise.reject(error instanceof Error ? error : new Error("Connector failed during admission.")); }
        entered = { pending, controller, operationId: request.operationId, key };
        return { kind: "admitted" as const };
      });
      if (entered) {
        try { await this.ingestLateEvidence(entered.operationId, await entered.pending); }
        catch (error) {
          await this.retainUnknown(entered.operationId, error instanceof Error ? "Owner result is unavailable after admission." : "Owner result could not be recorded.");
        } finally { this.active.delete(entered.key); }
      }
      return outcome.kind === "denied" ? await this.recordDenied(context, kind, request.operationId, outcome.recovery) : outcome;
    } catch (error) { return this.recordDenied(context, kind, "operation-unavailable", error instanceof Error ? "review-again" : "retry-later"); }
  }

  private async retainUnknown(operationId: string, message: string): Promise<void> {
    await this.exclusive(async () => {
      const stored = await this.journal.read(operationId);
      const attempt = stored?.journal.events.findLast(item => item.event.kind === "attempt-prepared");
      if (!stored || attempt?.event.kind !== "attempt-prepared" || !["dispatching", "pending"].includes(stored.journal.state)) return;
      await this.journal.append(operationId, stored.revision, { sequence: stored.journal.sequence + 1, eventId: randomUUID(), at: this.now().toISOString(), event: { kind: "wait-expired", attemptId: attempt.event.attempt.attemptId, reason: { code: "outcome_unavailable", message } } });
      if (!("kind" in stored.journal.snapshot)) await this.collaborators.fences?.trigger({ kind: "adapter_crash", target: fenceTargetOf(stored.journal.snapshot), evidence: { operationId, detail: message } });
    });
  }

  async admitRowCapability(context: HostContext, raw: unknown): Promise<{ kind: "allowed" } | Denial> {
    try {
      const request = parseWire(RowCapabilityRequestSchema, raw);
      const resolved = await this.resolve(context, request.connectionId);
      if (resolved.connection.adapterId === request.adapterId && this.writable(resolved, request)) return { kind: "allowed" };
      return await this.recordDenied(context, "row-capability", `${request.connectionId}:${request.capabilityId}`);
    } catch {
      return await this.recordDenied(context, "row-capability", "row-capability");
    }
  }

  private writable(resolved: Resolved, request: z.infer<typeof RowCapabilityRequestSchema>): boolean {
    return !resolved.binding.maintenance && resolved.policy.operationVisible && resolved.policy.writesAllowed && resolved.connection.writeCapabilityIds.includes(request.capabilityId) && withinLimits(resolved.connection.writeDestinations, request.destinations);
  }

  async connectorEntry(context: HostContext, snapshot: ApprovedSnapshot): Promise<{ kind: "allowed" } | { kind: "denied"; reason: BoundaryError }> {
    try {
      const resolved = await this.resolve(context, snapshot.connectionId, snapshot);
      if (!withinLimits(resolved.connection.writeDestinations, snapshot.destinations)) return { kind: "denied", reason: { code: "destination_denied", message: "The destination is no longer in the write scope." } };
      return { kind: "allowed" };
    } catch { return { kind: "denied", reason: { code: "connector_entry_unavailable", message: "The connector entry could not resolve the destination." } }; }
  }

  async ingestLateEvidence(operationId: string, raw: unknown): Promise<string> {
    return this.exclusive(async () => {
      const stored = await this.journal.read(operationId);
      if (!stored || "kind" in stored.journal.snapshot) throw new Error("Operation evidence requires lifecycle provenance.");
      const snapshot = stored.journal.snapshot;
      const ingested = await this.journal.receive(operationId, stored.revision, raw, this.now().toISOString());
      const releasable = OwnerResultSchema.safeParse(raw).success && ingested.quarantine.length === stored.quarantine.length;
      return this.commit(state => {
        const reference = randomUUID();
        state.evidence[reference] = { operationId, connectionId: snapshot.connectionId, snapshot: json(snapshot), value: json(raw), releasable, accountBindingDigest: accountBinding((() => {
          const approval = stored.journal.events.find(entry => entry.event.kind === "approved");
          const revision = approval?.event.kind === "approved" ? approval.event.authority.connectionRevision : "";
          const record = state.records[`connection:${snapshot.connectionId}`]?.find(item => item.kind === "connection" && item.value.connectionRevision === revision);
          if (record?.kind !== "connection") throw new Error("Evidence account provenance is unavailable.");
          return record.value;
        })()) };
        return reference;
      });
    });
  }

  private sinkAllowed(resolved: Resolved, snapshot: ApprovedSnapshot | undefined, sink: ReleaseSink, hostScopes: readonly HostScope[] = []): boolean {
    const anyLocal = snapshot?.policy === "local" || hostScopes.some(scope => scope.policy === "local");
    const b = resolved.binding;
    return !b.maintenance && sink.kind === b.audience && sink.conversationId === b.conversationId && (sink.kind !== "model" || sink.route === b.route) && (sink.kind !== "view" || sink.viewId === b.viewId) && resolved.policy.releaseAllowed && resolved.policy.allowedAudiences.includes(sink.kind) && this.readable(resolved, snapshot, [...hostScopes]) && resolved.restrictions.every(record => record.audiences.includes(sink.kind)) && !(resolved.restrictions.some(record => record.egress === "local") && resolved.policy.conversationPolicy === "cloud") && !((resolved.policy.conversationPolicy === "local" || anyLocal || resolved.restrictions.some(record => record.egress === "local")) && (sink.kind === "discord" || sink.kind === "model" && sink.route !== "local"));
  }

  async release(context: HostContext, evidenceRef: string, rawSink: ReleaseSink): Promise<ReleaseProjection<Json>> {
    let pending: Promise<void> | undefined;
    try {
      const sink = parseWire(ReleaseSinkSchema, rawSink);
      const outcome = await this.exclusive(async () => {
        const publicationHead = this.publication.head;
        const state = await this.state();
        const evidence = state.evidence[evidenceRef];
        if (!evidence?.releasable || evidence.readRef && !evidence.readRestrictionRef) return withheld();
        const snapshot = evidence.snapshot ? validateSnapshot(this.registry, evidence.snapshot) : undefined;
        const resolved = await this.resolve(context, evidence.connectionId, snapshot, evidence.readRef, evidence.readRestrictionRef, evidence.hostScopes);
        if (accountBinding(resolved.connection) !== evidence.accountBindingDigest || evidence.readRef && !this.readbackAllowed(resolved, evidence.readRef) || !this.sinkAllowed(resolved, snapshot, sink, evidence.hostScopes)) return withheld(resolved.policy.operationVisible);
        const send = this.sinks.get(canonicalWire(sink));
        if (!send) return withheld(resolved.policy.operationVisible);
        const decision = await this.commit(state => this.decision(state, resolved, "release", evidenceRef, json({ kind: "read" }), snapshot));
        const final = await this.resolve(context, evidence.connectionId, snapshot, evidence.readRef, evidence.readRestrictionRef, evidence.hostScopes);
        if (publicationHead !== this.publication.head || final.revision !== this.currentRevision() || final.policyRevision !== resolved.policyRevision || evidence.readRef && !this.readbackAllowed(final, evidence.readRef) || !this.sinkAllowed(final, snapshot, sink, evidence.hostScopes)) return withheld(final.policy.operationVisible);
        pending = send(structuredClone(evidence.value));
        return { kind: "released" as const, value: structuredClone(evidence.value), decisionRef: decision.decisionRef };
      });
      if (pending) await pending;
      if (outcome.kind === "withheld") await this.recordDenied(context, "release", evidenceRef);
      return outcome;
    } catch (error) { return error instanceof Error ? withheld() : withheld(); }
  }

  async queueRelease(context: HostContext, evidenceRef: string, rawSink: ReleaseSink): Promise<{ kind: "queued"; outboxRef: string } | Denial> {
    try {
      const sink = parseWire(ReleaseSinkSchema, rawSink);
      return await this.exclusive(async () => {
        const state = await this.state();
        const evidence = state.evidence[evidenceRef];
        if (!evidence || !evidence.releasable || evidence.readRef && !evidence.readRestrictionRef || !this.sinks.has(canonicalWire(sink))) return denied();
        const snapshot = evidence.snapshot ? validateSnapshot(this.registry, evidence.snapshot) : undefined;
        const resolved = await this.resolve(context, evidence.connectionId, snapshot, evidence.readRef, evidence.readRestrictionRef);
        if (!resolved.policy.operationVisible || sink.conversationId !== resolved.binding.conversationId) return denied();
        return this.commit(state => {
          const existing = Object.entries(state.outbox).find(([_key, item]) => item.evidenceRef === evidenceRef && canonicalWire(item.sink) === canonicalWire(sink));
          const outboxRef = existing?.[0] ?? randomUUID();
          state.outbox[outboxRef] ??= { evidenceRef, sink, state: "pending" };
          return { kind: "queued" as const, outboxRef };
        });
      });
    } catch (error) { return this.recordDenied(context, "queue-release", evidenceRef, error instanceof Error ? "reauthorize" : "retry-later"); }
  }

  async deliver(context: HostContext, outboxRef: string): Promise<ReleaseProjection<Json>> {
    const queued = await this.exclusive(() => this.commit(state => {
      const item = state.outbox[outboxRef];
      if (item?.state !== "pending") return null;
      item.state = "sending";
      return structuredClone(item);
    }));
    if (!queued) return withheld();
    const projection = await this.release(context, queued.evidenceRef, queued.sink);
    await this.exclusive(() => this.commit(state => {
      const item = state.outbox[outboxRef];
      if (item) item.state = projection.kind === "released" ? "sent" : "pending";
    }));
    return projection;
  }

  async lookup(context: HostContext, raw: LookupRequest, sink: ReleaseSink): Promise<ReleaseProjection<Json>> {
    return (await this.lookupObserved(context, raw, sink)).projection;
  }

  async lookupObserved(context: HostContext, raw: LookupRequest, sink: ReleaseSink, signal: AbortSignal = new AbortController().signal): Promise<ObservedRead> {
    const observed: ObservedRead = { projection: withheld(), called: false };
    try {
      const request = parseWire(LookupRequestSchema, raw);
      const stored = await this.journal.read(request.operationId);
      if (stored?.journal.ownerRequestId !== request.ownerRequestId || "kind" in stored.journal.snapshot) return observed;
      const snapshot = stored.journal.snapshot;
      observed.projection = await this.read(context, snapshot.connectionId, snapshot, sink, connector => {
        if (!connector.lookup || connector.support.operationLookup !== "historical") throw new Error("Historical lookup unavailable.");
        return connector.lookup(request, signal).then(raw => {
          const result = parseWire(OperationLookupSchema, raw);
          if (result.operationId !== request.operationId || result.result.kind === "known" && (result.result.response.operationId !== request.operationId || result.result.response.snapshotDigest !== snapshot.digest)) throw new Error("Lookup identity mismatch.");
          if (result.result.kind === "known") {
            validateResultPayload(this.registry, snapshot, result.result.response);
            const ownerRequestId = "evidence" in result.result.response.result ? result.result.response.result.evidence.ownerRequestId : result.result.response.result.ownerRequestId;
            if (ownerRequestId !== undefined && ownerRequestId !== request.ownerRequestId) throw new Error("Lookup owner identity mismatch.");
          } else if (result.result.kind === "no-effect" && result.result.evidence.ownerRequestId !== request.ownerRequestId) throw new Error("Lookup owner identity mismatch.");
          return json(result);
        });
      }, { observed, signal });
      return observed;
    } catch { observed.projection = withheld(); return observed; }
  }

  async projectHostData(context: HostContext, connectionId: string, sink: ReleaseSink, derive: () => Promise<Json>, scopes: ReadScope[] = []): Promise<ReleaseProjection<Json>> {
    try { return await this.read(context, connectionId, undefined, sink, () => derive(), { scopes }); }
    catch { return withheld(); }
  }

  private readScopeFor(state: AuthorityState, destinations: ObjectReference[]): HostScope | null {
    const sources: HostScope["sources"] = [];
    for (const destination of destinations) {
      const matches = this.restrictionsFor(state, destination).filter(record => record.status === "active");
      const only = matches[0];
      if (matches.length !== 1 || !only) return null;
      sources.push({ ref: destination, restrictionRef: only.restrictionRef });
    }
    return { capabilityId: "", destinations, sources, policy: "cloud" };
  }

  private restrictionIndex(state: AuthorityState): Map<string, RestrictionRecord[]> {
    const index = new Map<string, RestrictionRecord[]>();
    for (const values of Object.values(state.records)) {
      const record = values.at(-1);
      if (record?.kind !== "restriction") continue;
      const key = canonicalWire(record.value.source);
      index.set(key, [...index.get(key) ?? [], record.value]);
    }
    return index;
  }

  private restrictionsFor(state: AuthorityState, source: ObjectReference): RestrictionRecord[] {
    return this.restrictionIndex(state).get(canonicalWire(source)) ?? [];
  }

  private async objectReleasable(resolved: Resolved, binding: ReadBinding, scope: HostScope, sink: ReleaseSink, object: ReadPage["objects"][number], index: Map<string, RestrictionRecord[]>, metadataOnly = false): Promise<boolean> {
    const { ref, destination } = object;
    if (ref.adapterId !== binding.adapterId || ref.connectionId !== resolved.connection.connectionId || !acceptsReadObject(this.registry, binding, ref.objectType)) return false;
    if (binding.destinationType !== undefined && (destination?.objectType !== binding.destinationType)) return false;
    if (!destination || !withinLimits(scope.destinations, [destination])) return false;
    if (!metadataOnly && !this.registry.validateObject(binding.adapterId, ref.objectType, object.schemaRef, object.value).ok) return false;
    const own = index.get(canonicalWire(ref)) ?? [];
    if (own.length === 0) return true;
    const record = own[0];
    if (own.length !== 1 || record?.status !== "active" || !record.readScope.includes(resolved.principal.principalRef) || !record.resolverBinding) return false;
    const resolver = this.bindings.restrictions.get(record.resolverBinding);
    if (!resolver || canonicalWire(await resolver(structuredClone(record))) !== canonicalWire(record)) return false;
    const localOnly = record.egress === "local" && (resolved.policy.conversationPolicy === "cloud" || sink.kind === "discord" || sink.kind === "model" && sink.route !== "local");
    return record.audiences.includes(sink.kind) && !localOnly;
  }

  private queryHeadOf(resolved: Resolved, binding: ReadBinding | undefined, state: AuthorityState): string {
    const current = binding ? this.bindings.readBindings?.lookup(binding.adapterId, resolved.connection.connectionId, binding.capabilityId) : undefined;
    const { revision: _publicationRevision, ...vector } = resolved.vector as Record<string, Json>;
    return authorityHash({ vector, currentPolicy: this.bindings.currentRevision(), binding: current?.state === "available" ? current.binding : null, heads: state.heads, capability: binding ? this.registry.capability(binding.capabilityId) : null });
  }

  private queryCurrent(query: QueryDispatch | undefined, resolved: Resolved, binding: ReadBinding, state: AuthorityState): boolean {
    return !query || query.head === this.queryHeadOf(resolved, binding, state);
  }

  async queryHead(context: HostContext, raw: unknown, rawSink: ReleaseSink): Promise<{ head: string; binding?: ReadBinding } | null> {
    try {
      const source = QuerySourceSchema.parse(raw);
      const sink = parseWire(ReleaseSinkSchema, rawSink);
      return await this.exclusive(async () => {
        const state = await this.state();
        const lookup = this.bindings.readBindings?.lookup(source.adapterId, source.connectionId, source.capabilityId);
        const found = this.readScopeFor(state, source.destinations);
        if (!found) return null;
        const scope = { ...found, capabilityId: source.capabilityId };
        const resolved = await this.resolve(context, source.connectionId, undefined, undefined, undefined, [scope]);
        if (resolved.connection.adapterId !== source.adapterId || !this.readable(resolved, undefined, [scope]) || !this.sinkAllowed(resolved, undefined, sink, [scope]) || !this.sinks.has(canonicalWire(sink))) return null;
        if (lookup?.state !== "available" || (lookup.binding.mode !== "query" && lookup.binding.mode !== "destinations") || !lookup.binding.query || !this.connectors.get(resolved.connection.connectorId)?.query) return { head: this.queryHeadOf(resolved, undefined, state) };
        if (canonicalWire(source.inputSchemaRef) !== canonicalWire(lookup.binding.inputSchemaRef)) return null;
        if (!this.registry.validateInput({ capabilityId: source.capabilityId, inputSchemaRef: source.inputSchemaRef, input: source.input }, null).ok) return null;
        return { head: this.queryHeadOf(resolved, lookup.binding, state), binding: lookup.binding };
      });
    } catch { return null; }
  }

  private async observationAccess(context: HostContext, raw: unknown, rawSink: ReleaseSink) {
    const source = QuerySourceSchema.parse(raw);
    const sink = parseWire(ReleaseSinkSchema, rawSink);
    const state = await this.state();
    const found = this.readScopeFor(state, source.destinations);
    if (!found) throw new Error("observation_scope_denied");
    const scope = { ...found, capabilityId: source.capabilityId };
    const resolved = await this.resolve(context, source.connectionId, undefined, undefined, undefined, [scope]);
    const lookup = this.bindings.readBindings?.lookup(source.adapterId, source.connectionId, source.capabilityId);
    const connector = this.connectors.get(resolved.connection.connectorId)?.observation;
    if (lookup?.state !== "available" || !connector) throw new Error("observation_denied");
    const bindingMatches = resolved.connection.adapterId === source.adapterId && !!lookup.binding.observation && canonicalWire(lookup.binding.inputSchemaRef) === canonicalWire(source.inputSchemaRef);
    const sinkPermitted = this.readable(resolved, undefined, [scope]) && this.sinkAllowed(resolved, undefined, sink, [scope]) && this.sinks.has(canonicalWire(sink));
    const inputValid = this.registry.validateInput({ capabilityId: source.capabilityId, inputSchemaRef: source.inputSchemaRef, input: source.input }, null).ok;
    if (!(bindingMatches && sinkPermitted && inputValid)) throw new Error("observation_denied");
    const basis: ObservationBasis = { head: this.queryHeadOf(resolved, lookup.binding, state), identity: authorityHash({ account: accountBinding(resolved.connection), connectionRevision: resolved.connection.connectionRevision, binding: lookup.binding, source }), binding: lookup.binding };
    return { source, sink, state, scope, resolved, connector, basis };
  }

  async observationHead(context: HostContext, source: unknown, sink: ReleaseSink): Promise<ObservationBasis | null> {
    try { return await this.exclusive(async () => (await this.observationAccess(context, source, sink)).basis); }
    catch { return null; }
  }

  async admitObservation<T>(context: HostContext, request: ObservationRequest, sink: ReleaseSink, expected: ObservationBasis, signal: AbortSignal, consume: (validated: ReturnType<typeof validateObservationBatch>, basis: ObservationBasis, connector: ObservationConnector) => Promise<T>): Promise<{ kind: "accepted"; value: T } | { kind: "denied" }> {
    const isAborted = (): boolean => signal.aborted;
    const admitted = await this.exclusive(async () => {
      const publicationHead = this.publication.head;
      const access = await this.observationAccess(context, request.source, sink);
      const policy = access.basis.binding.observation;
      const mode = request.mode === "subscription" ? "subscription" : "poll";
      if (!policy?.modes.includes(mode) || !access.connector.modes.includes(mode) || policy.ordering !== access.connector.ordering?.id || isAborted() || access.basis.head !== expected.head) throw new Error("observation_binding_changed");
      const final = await this.observationAccess(context, request.source, sink);
      if (publicationHead !== this.publication.head || final.basis.head !== access.basis.head || isAborted()) throw new Error("observation_admission_changed");
      return { pending: final.connector.fetch(structuredClone(request), signal), basis: final.basis };
    });
    const raw = await admitted.pending;
    if (isAborted()) return { kind: "denied" };
    const validated = validateObservationBatch(this.registry, admitted.basis.binding, request.source, raw);
    return this.exclusive(async () => {
      const publicationHead = this.publication.head;
      const access = await this.observationAccess(context, request.source, sink);
      if (access.basis.head !== admitted.basis.head || isAborted()) return { kind: "denied" };
      const index = this.restrictionIndex(access.state);
      for (const event of validated.events) {
        const object = { ref: event.ref, schemaRef: event.schemaRef, destination: event.destination, value: event.value ?? null };
        if (!await this.objectReleasable(access.resolved, access.basis.binding, access.scope, access.sink, object, index, event.kind === "deleted")) return { kind: "denied" };
      }
      const final = await this.observationAccess(context, request.source, sink);
      if (publicationHead !== this.publication.head || final.basis.head !== access.basis.head || isAborted()) return { kind: "denied" };
      return { kind: "accepted", value: await consume(validated, final.basis, final.connector) };
    });
  }

  async releaseObservations(context: HostContext, source: unknown, sink: ReleaseSink, load: () => Promise<{ row: ObservationRow; view: ObservationView; expiresAt: number }[]>, now: () => number): Promise<ReleaseProjection<Json>> {
    try {
      let send: Promise<void> | undefined;
      const result = await this.exclusive(async () => {
        const publicationHead = this.publication.head;
        const access = await this.observationAccess(context, source, sink);
        const rows = await load();
        const index = this.restrictionIndex(access.state);
        for (const { row } of rows) {
          if (row.identity !== access.basis.identity || !await this.objectReleasable(access.resolved, access.basis.binding, access.scope, access.sink, { ref: row.ref, schemaRef: row.schemaRef, destination: row.destination, value: row.value ?? null }, index, row.kind === "deleted")) return withheld();
        }
        const final = await this.observationAccess(context, source, sink);
        if (publicationHead !== this.publication.head || final.basis.head !== access.basis.head) return withheld();
        if (rows.some(({ row, expiresAt }) => row.kind === "present" && now() >= expiresAt)) return withheld();
        const value = json({ objects: rows.map(item => item.view), untrusted: true, sources: access.scope.sources });
        const sender = this.sinks.get(canonicalWire(access.sink));
        if (!sender) return withheld();
        send = sender(structuredClone(value));
        return { kind: "released" as const, value, decisionRef: randomUUID() };
      });
      if (send) await send;
      return result;
    } catch { return withheld(); }
  }

  async admitRead(context: HostContext, raw: unknown, rawSink: ReleaseSink, signal?: AbortSignal): Promise<ReleaseProjection<Json>> {
    return (await this.admittedPage(context, raw, rawSink, signal)).projection;
  }

  async admitQueryPage(context: HostContext, query: QueryDispatch, sink: ReleaseSink, signal: AbortSignal) {
    const { connectionId, capabilityId, destinations, input } = query.source;
    return this.admittedPage(context, { connectionId, capabilityId, destinations, input }, sink, signal, query);
  }

  private async admittedPage(context: HostContext, raw: unknown, rawSink: ReleaseSink, signal?: AbortSignal, query?: QueryDispatch): Promise<{ projection: ReleaseProjection<Json>; protectedPage?: ValidatedQueryPage; failure?: "unavailable" }> {
    const controller = new AbortController();
    const key = randomUUID();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const isAborted = (): boolean => combined.aborted;
    try {
      const sink = parseWire(ReleaseSinkSchema, rawSink);
      const request = parseWire(ReadAdmissionRequestSchema, raw);
      const subject = authorityHash({ capabilityId: request.capabilityId, destinations: request.destinations });
      const outcome = await this.exclusive(async (): Promise<ReleaseProjection<Json> | { pending: Promise<unknown>; plan: { binding: ReadBinding; scope: HostScope; connectionId: string; sink: ReleaseSink } }> => {
        const publicationHead = this.publication.head;
        const state = await this.state();
        const connection = headRecord(state, "connection", request.connectionId);
        const lookup = connection ? this.bindings.readBindings?.lookup(connection.adapterId, request.connectionId, request.capabilityId) : undefined;
        if (lookup?.state !== "available" || lookup.binding.mode === "destinations" && !query) return withheld();
        const found = this.readScopeFor(state, request.destinations);
        if (!found) return withheld();
        const scope: HostScope = { ...found, capabilityId: request.capabilityId };
        const admit = (resolved: Resolved): boolean => this.readable(resolved, undefined, [scope]) && this.sinkAllowed(resolved, undefined, sink, [scope]);
        const resolved = await this.resolve(context, request.connectionId, undefined, undefined, undefined, [scope]);
        const connector = this.connectors.get(resolved.connection.connectorId);
        const checked = this.registry.validateInput({ capabilityId: request.capabilityId, inputSchemaRef: lookup.binding.inputSchemaRef, input: request.input }, null);
        if (!admit(resolved) || !connector || (query ? typeof connector.query !== "function" : typeof connector.read !== "function") || !checked.ok || isAborted()) return withheld();
        if (query && (!lookup.binding.query || query.source.adapterId !== lookup.binding.adapterId || canonicalWire(query.source.inputSchemaRef) !== canonicalWire(lookup.binding.inputSchemaRef) || !this.queryCurrent(query, resolved, lookup.binding, state))) return withheld();
        await this.commit(next => this.decision(next, resolved, "read", subject, json({ kind: "read" })));
        const final = await this.resolve(context, request.connectionId, undefined, undefined, undefined, [scope]);
        if (publicationHead !== this.publication.head || final.revision !== this.currentRevision() || final.policyRevision !== resolved.policyRevision || !admit(final) || isAborted() || !this.queryCurrent(query, final, lookup.binding, state)) return withheld();
        this.active.set(key, { controller, heads: new Set(Object.keys(resolved.heads)) });
        let pending: Promise<unknown>;
        try {
          if (query && connector.query) pending = connector.query({ readVersion: "1.0.0", queryId: query.queryId, capabilityId: request.capabilityId, input: request.input, destinations: request.destinations, limit: query.limit, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) }, combined);
          else if (!query && connector.read) pending = connector.read({ lifecycleVersion: "1.0.0", capabilityId: request.capabilityId, destinations: request.destinations, input: request.input }, combined);
          else throw new Error("Trusted read connector is unavailable.");
        }
        catch (error) { pending = Promise.reject(error instanceof Error ? error : new Error("Connector failed during admission.")); }
        return { pending, plan: { binding: lookup.binding, scope, connectionId: request.connectionId, sink } };
      });
      if (!("plan" in outcome)) { await this.recordDenied(context, "read", subject); return { projection: outcome }; }
      const { pending, plan: admitted } = outcome;
      let page: ReadPage;
      let protectedPage: ValidatedQueryPage | undefined;
      try {
        const rawPage = await pending;
        if (isAborted()) return { projection: withheld() };
        if (query) { protectedPage = validateQueryPage(this.registry, admitted.binding, query, rawPage); page = { objects: protectedPage.objects }; }
        else page = parseWire(ReadPageSchema, rawPage);
      }
      catch { return { projection: withheld(), failure: "unavailable" }; }
      finally { this.active.delete(key); }
      if (isAborted()) return { projection: withheld() };
      let send: Promise<void> | undefined;
      const released = await this.exclusive(async () => {
        const publicationHead = this.publication.head;
        const state = await this.state();
        const resolved = await this.resolve(context, admitted.connectionId, undefined, undefined, undefined, [admitted.scope]);
        if (!this.readable(resolved, undefined, [admitted.scope]) || !this.sinkAllowed(resolved, undefined, admitted.sink, [admitted.scope])) return withheld();
        const sender = this.sinks.get(canonicalWire(admitted.sink));
        if (!sender || isAborted() || !this.queryCurrent(query, resolved, admitted.binding, state)) return withheld();
        const kept: ReadPage["objects"] = [];
        const index = this.restrictionIndex(state);
        for (const object of page.objects) {
          if (await this.objectReleasable(resolved, admitted.binding, admitted.scope, admitted.sink, object, index)) kept.push(object);
          else if (query) return withheld();
        }
        const decision = await this.commit(next => this.decision(next, resolved, "release", subject, json({ kind: "read" })));
        const final = await this.resolve(context, admitted.connectionId, undefined, undefined, undefined, [admitted.scope]);
        if (publicationHead !== this.publication.head || final.revision !== this.currentRevision() || final.policyRevision !== resolved.policyRevision || !this.sinkAllowed(final, undefined, admitted.sink, [admitted.scope]) || isAborted() || !this.queryCurrent(query, final, admitted.binding, state)) return withheld();
        const value = protectedPage ? json({ ...protectedPage.released as Record<string, Json>, sources: admitted.scope.sources }) : json({ objects: kept });
        send = sender(structuredClone(value));
        return { kind: "released" as const, value, decisionRef: decision.decisionRef };
      });
      if (send) await send;
      if (released.kind === "withheld") await this.recordDenied(context, "release", subject);
      return { projection: released, ...(released.kind === "released" && protectedPage ? { protectedPage } : {}) };
    } catch { return { projection: withheld() }; }
    finally { this.active.delete(key); }
  }

  private readbackAllowed(resolved: Resolved, ref: ObjectReference): boolean {
    const connector = this.connectors.get(resolved.connection.connectorId);
    const capability = connector?.readbackCapabilityId ? this.registry.capability(connector.readbackCapabilityId) : undefined;
    return ref.adapterId === resolved.connection.adapterId && ref.connectionId === resolved.connection.connectionId && withinLimits(resolved.connection.readDestinations, [ref]) && capability?.support === "declared" && capability.adapterId === ref.adapterId && capability.capability.kind === "query" && capability.capability.objectTypes.includes(ref.objectType) && resolved.connection.readCapabilityIds.includes(capability.capability.capabilityId);
  }

  async readback(context: HostContext, raw: ReadbackRequest, sink: ReleaseSink): Promise<ReleaseProjection<Json>> {
    return (await this.readbackObserved(context, raw, sink)).projection;
  }

  async readbackObserved(context: HostContext, raw: ReadbackRequest, sink: ReleaseSink, signal: AbortSignal = new AbortController().signal): Promise<ObservedRead> {
    const observed: ObservedRead = { projection: withheld(), called: false };
    try {
      const request = parseWire(ReadbackRequestSchema, raw);
      observed.projection = await this.read(context, request.ref.connectionId, undefined, sink, connector => {
        if (!connector.readback) throw new Error("Object readback unavailable.");
        return connector.readback(request, signal).then(json);
      }, { signal, observed, ref: request.ref, validate: value => {
        const result = parseWire(ObjectReadbackSchema, value);
        if (canonicalWire(result.ref) !== canonicalWire(request.ref) || result.provenance.adapterId !== request.ref.adapterId || result.provenance.connectionId !== request.ref.connectionId) return false;
        return result.result.kind !== "present" || this.registry.validateObject(request.ref.adapterId, request.ref.objectType, result.result.schemaRef, result.result.value).ok;
      } });
      return observed;
    } catch { observed.projection = withheld(); return observed; }
  }

  private async read(context: HostContext, connectionId: string, snapshot: ApprovedSnapshot | undefined, sink: ReleaseSink, fetch: (connector: TrustedConnector) => Promise<Json>, { ref, validate, observed, signal, scopes }: ReadOptions = {}): Promise<ReleaseProjection<Json>> {
    const hostScopes = hostScopesOf(scopes);
    let pending: Promise<Json> | undefined;
    let readAccount: string | undefined;
    let readRestrictionRef: string | undefined;
    const outcome = await this.exclusive(async () => {
      const publicationHead = this.publication.head;
      const resolved = await this.resolve(context, connectionId, snapshot, ref, undefined, hostScopes);
      if (!this.readable(resolved, snapshot, scopes) || ref && (!this.readbackAllowed(resolved, ref) || !this.sinkAllowed(resolved, snapshot, sink))) return withheld(resolved.policy.operationVisible);
      const connector = this.connectors.get(resolved.connection.connectorId);
      if (!connector) return withheld();
      await this.commit(state => this.decision(state, resolved, "read", snapshot?.digest ?? (ref ? canonicalWire(ref) : HOST_DATA_SUBJECT), json({ kind: "read" }), snapshot));
      const final = await this.resolve(context, connectionId, snapshot, ref, undefined, hostScopes);
      if (publicationHead !== this.publication.head || final.revision !== this.currentRevision() || final.policyRevision !== resolved.policyRevision || ref && (!this.readbackAllowed(final, ref) || !this.sinkAllowed(final, snapshot, sink)) || !this.readable(final, snapshot, scopes)) return withheld(final.policy.operationVisible);
      readAccount = accountBinding(final.connection);
      readRestrictionRef = ref ? final.restrictions.find(record => canonicalWire(record.source) === canonicalWire(ref))?.restrictionRef : undefined;
      if (ref && !readRestrictionRef) return withheld();
      pending = fetch(connector);
      if (observed) observed.called = true;
      return null;
    });
    if (outcome) { await this.recordDenied(context, "read", snapshot?.digest ?? "object-read"); return outcome; }
    if (!pending || !readAccount) return withheld();
    const accountBindingDigest = readAccount;
    const value = await pending;
    if (observed) observed.value = value;
    let releasable = true;
    try { releasable = validate?.(value) ?? true; }
    catch { releasable = INVALID_READBACK_IS_NOT_RELEASABLE; }
    const reference = await this.exclusive(() => this.commit(state => {
      const reference = randomUUID();
      state.evidence[reference] = { connectionId, snapshot: snapshot ? json(snapshot) : null, value, releasable, accountBindingDigest, ...(ref ? { readRef: ref, readRestrictionRef } : {}), ...(hostScopes.length ? { hostScopes: json(hostScopes) as never } : {}) };
      return reference;
    }));
    if (signal?.aborted) return withheld();
    return this.release(context, reference, sink);
  }
}
