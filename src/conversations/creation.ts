import { createHash } from "node:crypto";
import { z } from "zod";
import { CREATABLE_TYPES, CREATION_CATALOG, SUBJECT_FIELDS, UNAVAILABLE_TYPES, isCreatable, type CreatableType, type Egress, type FieldSpec, type FixedTerm } from "./catalog";
import { ConversationError, type ConversationHost } from "./host";
import { CREATION_KIND, GRANT_KIND, GRANT_SCOPES, PROPOSAL_KIND, TRANSPORTS, type CreateResult, type OperationRecord, type OwnerWriters } from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
export type GrantScope = (typeof GRANT_SCOPES)[number];

export type CapabilityStatus = "ready" | `blocked:${number}` | "unsupported";
export interface Capability { type: string; row: string; label: string; owner: string; status: CapabilityStatus; reason?: string; egress?: Egress; fields: FieldSpec[]; fixed: FixedTerm[] }
export interface Actor { principal: string; transport: (typeof TRANSPORTS)[number] }

const FieldsSchema = z.record(z.string().regex(/^[a-z]{1,40}$/), z.string().max(20_000)).refine(fields => Object.keys(fields).length <= 20);
export const ProposeSchema = z.object({
  proposalId: z.uuid(),
  type: z.string().trim().min(1).max(64).optional(),
  intent: z.string().trim().min(1).max(200).optional(),
  fields: FieldsSchema.default({}),
  entryId: z.string().trim().min(1).max(64).optional(),
}).strict();
export type Propose = z.infer<typeof ProposeSchema>;
export const ReviseSchema = z.object({
  revision: z.number().int().min(1),
  type: z.string().trim().min(1).max(64).optional(),
  fields: FieldsSchema.optional(),
  dismiss: z.literal(true).optional(),
}).strict();
export type Revise = z.infer<typeof ReviseSchema>;
export const ConfirmSchema = z.object({
  revision: z.number().int().min(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  grant: z.object({ scope: z.enum(GRANT_SCOPES).default("conversation") }).strict().optional(),
}).strict();
export type Confirm = z.infer<typeof ConfirmSchema>;

const ProposalSchema = z.object({
  proposalId: z.string(),
  conversationId: z.string(),
  type: z.enum(CREATABLE_TYPES).nullable(),
  intent: z.string().optional(),
  fields: z.record(z.string(), z.string()),
  revision: z.number().int(),
  entryId: z.string().nullable(),
  requestDigest: z.string(),
  dismissed: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Proposal = z.infer<typeof ProposalSchema>;
const GrantSchema = z.object({
  grantId: z.string(),
  type: z.enum(CREATABLE_TYPES),
  scope: z.enum(GRANT_SCOPES),
  conversationId: z.string(),
  principal: z.string(),
  operationId: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().optional(),
});
export type Grant = z.infer<typeof GrantSchema>;

export type Feedback = "choose" | "unavailable" | "proposed" | "accepted" | "created" | "failed" | "uncertain" | "dismissed";
export interface ProposalView {
  proposal: Omit<Proposal, "requestDigest">;
  digest: string;
  sentence: string;
  capability: Capability | null;
  missing: string[];
  refusal: string | null;
  feedback: Feedback;
  operation: OperationRecord | null;
  earlier: OperationRecord[];
}
export interface CreationView { proposals: ProposalView[]; grants: Grant[] }

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const clean = (fields: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.trim()] as const).filter(([, v]) => v.length > 0));
export const proposalDigest = (type: CreatableType | null, fields: Record<string, string>): string => sha256(canonical({ type, fields: clean(fields) }));
const conflict = (message: string): ConversationError => new ConversationError(409, message);

export function capabilities(writers: OwnerWriters): Capability[] {
  const creatable = CREATABLE_TYPES.map((type): Capability => capabilityOf(type, writers));
  const unavailable = UNAVAILABLE_TYPES.map((spec): Capability => ({ type: spec.type, row: spec.row, label: spec.label, owner: spec.owner, status: "unsupported", reason: spec.reason, fields: [], fixed: [] }));
  return [...creatable, ...unavailable];
}

function capabilityOf(type: CreatableType, writers: OwnerWriters): Capability {
  const spec = CREATION_CATALOG[type];
  const base = { type, row: spec.row, label: spec.label, owner: spec.owner, egress: spec.egress, fields: spec.fields, fixed: spec.fixed ?? [] };
  if (writers[type]) return { ...base, status: "ready" };
  const reason = type === "flow" ? "Pulse has no place to save a flow without running it yet." : `No ${spec.owner} writer is connected on this stack yet.`;
  return { ...base, status: `blocked:${spec.blockedBy}`, reason };
}

function unavailable(type: string): ConversationError {
  const known = UNAVAILABLE_TYPES.find(spec => spec.type === type);
  return conflict(known ? `${known.label} cannot be created from a conversation: ${known.reason}` : `"${type}" is not a type in the creation catalog. Choose one of the listed types.`);
}

function missingOf(type: CreatableType | null, fields: Record<string, string>): string[] {
  if (!type) return [];
  const present = clean(fields);
  return CREATION_CATALOG[type].fields.filter(f => f.required && !present[f.name]).map(f => f.label);
}

function onlyKnown(type: CreatableType, fields: Record<string, string>): Record<string, string> {
  const names = new Set(CREATION_CATALOG[type].fields.map(f => f.name));
  const unknown = Object.keys(fields).filter(name => !names.has(name));
  if (unknown.length > 0) throw new ConversationError(400, `${CREATION_CATALOG[type].label} has no field ${unknown.join(", ")}.`);
  return fields;
}

function sentence(proposal: Proposal): string {
  if (!proposal.type) return `Choose what to create${proposal.intent ? ` for “${proposal.intent}”` : ""} and where, before anything is proposed.`;
  const spec = CREATION_CATALOG[proposal.type];
  const fields = clean(proposal.fields);
  const subject = SUBJECT_FIELDS.map(name => fields[name]).find(Boolean) ?? "";
  const where = spec.fields.filter(f => f.destination && fields[f.name]).map(f => `${f.label.toLowerCase()} ${fields[f.name] ?? ""}`);
  const short = subject.length > 120 ? `${subject.slice(0, 119)}…` : subject;
  return `Create a ${spec.label.toLowerCase()}${short ? ` “${short}”` : ""}${where.length ? ` in ${where.join(", ")}` : ""}.`;
}

function egressRefusal(type: CreatableType | null, policy: "local" | "cloud"): ConversationError | null {
  if (!type || policy !== "local" || CREATION_CATALOG[type].egress !== "cloud") return null;
  return new ConversationError(403, `This conversation is local-only and a ${CREATION_CATALOG[type].label.toLowerCase()} leaves this machine, so it cannot be created from here. Nothing was created.`);
}

const isCurrent = (op: OperationRecord, proposal: Proposal): boolean => op.proposalId === proposal.proposalId && op.revision === proposal.revision;
const samePrincipal = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const applies = (grant: Grant, conversationId: string, principal: string, type: CreatableType): boolean =>
  !grant.revokedAt && grant.type === type && samePrincipal(grant.principal, principal) && (grant.scope === "global" || grant.conversationId === conversationId);

function typeOf(type: string | undefined): CreatableType | undefined {
  if (type === undefined) return undefined;
  if (!isCreatable(type)) throw unavailable(type);
  return type;
}

export interface CreationOptions { timeoutMs?: number; now?: () => Date }

const instances = new WeakMap<ConversationHost, ConversationCreation>();
export function creationFor(host: ConversationHost, options: CreationOptions = {}): ConversationCreation {
  const existing = instances.get(host);
  if (existing) return existing;
  const made = new ConversationCreation(host, options);
  instances.set(host, made);
  return made;
}

export class ConversationCreation {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(private readonly host: ConversationHost, options: CreationOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  capabilities(): Capability[] {
    return capabilities(this.host.writers);
  }

  private async serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.locks.set(key, next);
    try { return await next; }
    finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }

  private async gate(conversationId: string, actor: Actor, write: boolean): Promise<{ policy: "local" | "cloud" }> {
    const owner = await this.host.principalOf(conversationId);
    if (!samePrincipal(owner, actor.principal)) throw new ConversationError(403, "Only the principal who owns this conversation can review or confirm its proposals.");
    const meta = await this.host.meta(conversationId);
    if (actor.transport === "discord" && meta.policy === "local") throw new ConversationError(403, "This conversation is private to the web. Continue privately on the web; nothing was changed.");
    if (write && meta.state === "archived") throw conflict("This conversation is archived. Restore it to review proposals; nothing was changed.");
    return { policy: meta.policy };
  }

  private async proposalsOf(conversationId: string): Promise<Proposal[]> {
    return Object.values((await this.host.creation()).proposals)
      .filter(raw => raw && typeof raw === "object" && "conversationId" in raw && raw.conversationId === conversationId)
      .map(raw => ProposalSchema.parse(raw));
  }

  private async proposal(conversationId: string, proposalId: string): Promise<Proposal> {
    const raw = (await this.host.creation()).proposals[proposalId];
    const found = raw ? ProposalSchema.parse(raw) : null;
    if (found?.conversationId !== conversationId) throw new ConversationError(404, "That proposal is not part of this conversation.");
    return found;
  }

  private async currentOperation(proposal: Proposal): Promise<OperationRecord | undefined> {
    return (await this.host.operations(proposal.conversationId)).find(op => isCurrent(op, proposal));
  }

  async grants(principal: string): Promise<Grant[]> {
    return Object.values((await this.host.creation()).grants).map(raw => GrantSchema.parse(raw)).filter(g => samePrincipal(g.principal, principal)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async save(proposal: Proposal): Promise<void> {
    await this.host.changeCreation(() => ({ result: null, proposals: { [proposal.proposalId]: proposal } }));
  }

  private async view(proposal: Proposal, operations?: OperationRecord[], policy?: "local" | "cloud"): Promise<ProposalView> {
    const effective = policy ?? (await this.host.meta(proposal.conversationId)).policy;
    const mine = (operations ?? await this.host.operations(proposal.conversationId)).filter(op => op.proposalId === proposal.proposalId).sort((a, b) => a.revision - b.revision);
    const operation = mine.find(op => isCurrent(op, proposal)) ?? null;
    const capability = proposal.type ? capabilityOf(proposal.type, this.host.writers) : null;
    let feedback: Feedback;
    if (operation?.state === "created" || operation?.state === "failed" || operation?.state === "uncertain") feedback = operation.state;
    else if (operation && operation.state !== "proposed") feedback = "accepted";
    else if (proposal.dismissed) feedback = "dismissed";
    else if (!proposal.type) feedback = "choose";
    else feedback = capability?.status === "ready" ? "proposed" : "unavailable";
    const { requestDigest: _requestDigest, ...shown } = proposal;
    return { proposal: shown, digest: proposalDigest(proposal.type, proposal.fields), sentence: sentence(proposal), capability, missing: missingOf(proposal.type, proposal.fields), refusal: egressRefusal(proposal.type, effective)?.message ?? null, feedback, operation, earlier: mine.filter(op => op.revision !== proposal.revision) };
  }

  async list(conversationId: string, actor: Actor): Promise<CreationView> {
    const { policy } = await this.gate(conversationId, actor, false);
    const operations = await this.host.operations(conversationId);
    const mine = (await this.proposalsOf(conversationId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const proposals = await Promise.all(mine.map(p => this.view(p, operations, policy)));
    const grants = (await this.grants(actor.principal)).filter(g => g.scope === "global" || g.conversationId === conversationId);
    return { proposals: proposals.filter(v => v.feedback !== "dismissed"), grants };
  }

  async propose(conversationId: string, body: Propose, actor: Actor): Promise<{ view: ProposalView; duplicate: boolean }> {
    await this.gate(conversationId, actor, true);
    const type = typeOf(body.type) ?? null;
    const fields = type ? onlyKnown(type, body.fields) : body.fields;
    const requestDigest = sha256(canonical(body));
    return this.serial(conversationId, async () => {
      const raw = (await this.host.creation()).proposals[body.proposalId];
      if (raw) {
        const known = ProposalSchema.parse(raw);
        if (known.conversationId !== conversationId || known.requestDigest !== requestDigest) throw conflict("That proposal id was already used with a different proposal.");
        return { view: await this.view(known), duplicate: true };
      }
      const at = this.now().toISOString();
      const proposal: Proposal = { proposalId: body.proposalId, conversationId, type, ...(body.intent ? { intent: body.intent } : {}), fields, revision: 1, entryId: body.entryId ?? null, requestDigest, dismissed: false, createdAt: at, updatedAt: at };
      await this.save(proposal);
      await this.host.record(conversationId, `proposal:${proposal.proposalId}:1`, PROPOSAL_KIND, { proposalId: proposal.proposalId, revision: 1, type, fields, entryId: proposal.entryId });
      const grant = type ? (await this.grants(actor.principal)).find(g => applies(g, conversationId, actor.principal, type)) : undefined;
      const ready = type && capabilityOf(type, this.host.writers).status === "ready" && missingOf(type, fields).length === 0;
      if (grant && ready) {
        await this.host.settled();
        const egress = await this.egressRefusal(conversationId, proposal);
        if (!egress) await this.execute(proposal, { kind: "grant", grantId: grant.grantId, scope: grant.scope }, actor.principal);
      }
      return { view: await this.view(proposal), duplicate: false };
    });
  }

  async revise(conversationId: string, proposalId: string, body: Revise, actor: Actor): Promise<ProposalView> {
    await this.gate(conversationId, actor, true);
    const chosen = typeOf(body.type);
    return this.serial(conversationId, async () => {
      const proposal = await this.proposal(conversationId, proposalId);
      if (body.revision !== proposal.revision) throw conflict(`This proposal changed since you opened it; it is now revision ${proposal.revision}. Review it again.`);
      const current = await this.currentOperation(proposal);
      if (current?.state === "created") throw conflict("This proposal was already created. Propose again to create another.");
      if (current && current.state !== "failed" && current.state !== "proposed") throw conflict("The owner has not answered for this proposal yet. Check it before changing anything.");
      if (body.dismiss) {
        const dismissed = { ...proposal, dismissed: true, updatedAt: this.now().toISOString() };
        await this.save(dismissed);
        return this.view(dismissed);
      }
      const type = chosen ?? proposal.type;
      let fields = body.fields ?? proposal.fields;
      if (type && type !== proposal.type && body.fields === undefined) fields = Object.fromEntries(Object.entries(fields).filter(([name]) => CREATION_CATALOG[type].fields.some(f => f.name === name)));
      if (type) fields = onlyKnown(type, fields);
      const unchanged = type === proposal.type && proposalDigest(type, fields) === proposalDigest(proposal.type, proposal.fields);
      if (unchanged && current?.state !== "failed") return this.view(proposal);
      const revision = proposal.revision + 1;
      const next: Proposal = { ...proposal, type, fields, revision, dismissed: false, updatedAt: this.now().toISOString() };
      await this.save(next);
      await this.host.record(conversationId, `proposal:${proposalId}:${revision}`, PROPOSAL_KIND, { proposalId, revision, type, fields, entryId: proposal.entryId });
      return this.view(next);
    });
  }

  async confirm(conversationId: string, proposalId: string, body: Confirm, actor: Actor): Promise<ProposalView> {
    await this.gate(conversationId, actor, true);
    await this.host.settled();
    return this.serial(conversationId, async () => {
      const proposal = await this.proposal(conversationId, proposalId);
      const operations = (await this.host.operations(conversationId)).filter(op => op.proposalId === proposalId);
      const earlier = operations.find(op => op.revision === body.revision);
      if (earlier?.digest === body.digest && earlier.state !== "proposed" && earlier.state !== "confirmed") return this.view(proposal);
      if (body.revision !== proposal.revision) throw conflict(`This proposal changed since you reviewed it; it is now revision ${proposal.revision}. Nothing was created.`);
      if (body.digest !== proposalDigest(proposal.type, proposal.fields)) throw conflict("The proposal you confirmed differs from the saved one. Nothing was created; review it again.");
      if (proposal.dismissed) throw conflict("This proposal was dismissed. Nothing was created.");
      if (!proposal.type) throw conflict("Choose what to create and where first. Nothing was created.");
      const capability = capabilityOf(proposal.type, this.host.writers);
      if (capability.status !== "ready") throw conflict(`${capability.label} is unavailable here: ${capability.reason ?? capability.status}. Nothing was created.`);
      const missing = missingOf(proposal.type, proposal.fields);
      if (missing.length > 0) throw new ConversationError(400, `Fill in ${missing.join(", ")} first. Nothing was created.`);
      const egress = await this.egressRefusal(conversationId, proposal);
      if (egress) throw egress;
      const operation = await this.execute(proposal, { kind: "confirmation", transport: actor.transport }, actor.principal);
      if (body.grant && (operation?.state === "created" || operation?.state === "running")) await this.grant(proposal, proposal.type, body.grant.scope, operation.operationId, actor.principal);
      return this.view(proposal);
    });
  }

  private async egressRefusal(conversationId: string, proposal: Proposal): Promise<ConversationError | null> {
    return egressRefusal(proposal.type, (await this.host.meta(conversationId)).policy);
  }

  private async grant(proposal: Proposal, type: CreatableType, scope: GrantScope, operationId: string, principal: string): Promise<void> {
    const grantId = `grant-${sha256(operationId).slice(0, 32)}`;
    const created = await this.host.changeCreation(state => {
      if (state.grants[grantId]) return { result: false };
      const grant: Grant = { grantId, type, scope, conversationId: proposal.conversationId, principal, operationId, createdAt: this.now().toISOString() };
      return { result: true, grants: { [grantId]: grant } };
    });
    if (created) await this.host.record(proposal.conversationId, `grant:${grantId}`, GRANT_KIND, { grantId, type, scope, action: "granted" });
  }

  async revoke(grantId: string, actor: Actor): Promise<Grant> {
    const found = (await this.grants(actor.principal)).find(g => g.grantId === grantId);
    if (!found) throw new ConversationError(404, "That permission was not found.");
    await this.gate(found.conversationId, actor, false);
    if (found.revokedAt) return found;
    const revoked: Grant = { ...found, revokedAt: this.now().toISOString() };
    await this.host.changeCreation(() => ({ result: null, grants: { [grantId]: revoked } }));
    await this.host.record(found.conversationId, `grant:${grantId}:revoked`, GRANT_KIND, { grantId, type: found.type, scope: found.scope, action: "revoked" });
    return revoked;
  }

  async check(conversationId: string, proposalId: string, actor: Actor): Promise<ProposalView> {
    await this.gate(conversationId, actor, false);
    return this.serial(conversationId, async () => {
      const proposal = await this.proposal(conversationId, proposalId);
      const operation = await this.currentOperation(proposal);
      if (!operation || (operation.state !== "running" && operation.state !== "uncertain")) return this.view(proposal);
      const found = await this.host.readback(operation);
      if (found?.found) await this.created(proposal, operation, found.canonicalId, found.url, "Check found the object at the owner.");
      else if (found && operation.state === "uncertain") await this.host.transition(operation.operationId, "failed", { note: "Check found nothing at the owner. Change the proposal or confirm it again to try once more." });
      return this.view(proposal);
    });
  }

  private async execute(proposal: Proposal, authority: NonNullable<OperationRecord["authority"]>, principal: string): Promise<OperationRecord | null> {
    const type = proposal.type;
    if (!type) return null;
    const digest = proposalDigest(type, proposal.fields);
    let operation = await this.host.propose(proposal.conversationId, proposal.proposalId, proposal.revision, type, digest);
    if (operation.state !== "proposed" && operation.state !== "confirmed") return operation;
    if (authority.kind === "grant") {
      const still = (await this.grants(principal)).find(g => g.grantId === authority.grantId);
      if (!still || !applies(still, proposal.conversationId, principal, type)) return operation;
    }
    const latest = await this.proposal(proposal.conversationId, proposal.proposalId);
    if (latest.revision !== proposal.revision || proposalDigest(latest.type, latest.fields) !== digest) throw conflict("This proposal changed before it ran. Nothing was created.");
    const writer = this.host.writers[type];
    if (!writer) return operation;
    if (operation.state === "proposed") operation = await this.host.transition(operation.operationId, "confirmed", { authority, note: authority.kind === "grant" ? `standing ${authority.scope} permission` : `confirmed on ${authority.transport}` });
    operation = await this.host.transition(operation.operationId, "running");
    const controller = new AbortController();
    const { promise: timedOut, resolve } = Promise.withResolvers<"timeout">();
    const timer = setTimeout(() => { controller.abort(); resolve("timeout"); }, this.timeoutMs);
    let result: CreateResult | "timeout";
    try {
      result = await Promise.race([
        writer.create({ operationId: operation.operationId, type, fields: clean(proposal.fields), activation: "none", signal: controller.signal, provenance: { conversationId: proposal.conversationId, proposalId: proposal.proposalId, revision: proposal.revision, operationId: operation.operationId, entryId: proposal.entryId, link: `?desk=conversation&conversation=${proposal.conversationId}` } }),
        timedOut,
      ]);
    } catch (error) {
      return await this.host.transition(operation.operationId, "uncertain", { note: `The owner call failed without a result (${error instanceof Error ? error.message : String(error)}). It may have created the object; Check asks the owner.` });
    } finally { clearTimeout(timer); }
    if (result === "timeout") return this.host.transition(operation.operationId, "uncertain", { note: `The owner did not answer within ${Math.round(this.timeoutMs / 1000)} seconds. It may still create the object; Check asks the owner.` });
    if (result.state === "failed") return this.host.transition(operation.operationId, "failed", { note: result.error });
    if (result.state === "accepted") return operation;
    if (!result.canonicalId.trim()) return this.host.transition(operation.operationId, "uncertain", { note: "The owner answered without an id. Check asks the owner whether the object exists." });
    return this.created(proposal, operation, result.canonicalId, result.url, "The owner returned the created object.");
  }

  private async created(proposal: Proposal, operation: OperationRecord, canonicalId: string, url: string | undefined, note: string): Promise<OperationRecord> {
    const done = await this.host.transition(operation.operationId, "created", { canonicalId, ...(url ? { url } : {}), note });
    await this.host.record(proposal.conversationId, `created:${operation.operationId}`, CREATION_KIND, { operationId: operation.operationId, proposalId: proposal.proposalId, revision: proposal.revision, type: operation.owner, canonicalId, ...(url ? { url } : {}), entryId: proposal.entryId, authority: done.authority ?? null });
    return done;
  }
}
