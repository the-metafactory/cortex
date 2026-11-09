import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type JsonObject, type Session } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { ArcSecretStore } from "./desk-credential-arc-file-store";

export type { ArcSecretStore } from "./desk-credential-arc-file-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SLOT = /^[a-z][a-z0-9-]{0,31}$/;
const REFERENCE_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_SECRET_CHARS = 8192;
const SLOT_KINDS = ["token", "api-key"] as const;
const AUTH_KINDS = ["local", "token", "oauth"] as const;

const slug = z.string().regex(SLUG);
const uuid = z.string().regex(UUID);
const SetupDescriptorSchema = z.object({
  packageId: slug,
  setupSchemaId: slug,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  authKind: z.string().min(1).max(32),
  broker: slug.optional(),
  slots: z.array(z.object({ slot: z.string().regex(SLOT), kind: z.enum(SLOT_KINDS) }).strict()).max(16),
}).strict();
export type SetupDescriptor = z.infer<typeof SetupDescriptorSchema>;

const SlotRecordSchema = z.object({ slot: z.string(), mode: z.enum(["unset", "secret", "reference"]), identity: z.string(), handle: z.string(), reference: z.string().optional(), state: z.enum(["pending", "written"]) }).strict();
const HeadSchema = z.object({ connectionId: uuid, principalRef: uuid, stack: slug, packageId: slug, connectionRevision: z.string(), credentialHandle: z.string(), slotHandles: z.record(z.string(), z.string()), previousRevision: z.string().nullable() }).strict();
export type ConnectionHead = z.infer<typeof HeadSchema>;
const SetupRecordSchema = z.object({
  requestId: uuid, principalRef: uuid, stack: slug, connectionId: uuid, credentialRevision: z.string(),
  packageId: slug, setupSchemaId: slug, version: z.string(), authKind: z.string(), descriptorDigest: z.string(),
  status: z.enum(["staged", "incomplete", "ready", "committed"]), reason: z.string().optional(),
  slots: z.array(SlotRecordSchema), head: HeadSchema.nullable(),
}).strict();
type SetupRecord = z.infer<typeof SetupRecordSchema>;
const ConnectionStateSchema = z.object({ principalRef: uuid, stack: slug, packageId: slug, nextRevision: z.number().int().positive(), active: z.string().nullable(), pending: z.string().nullable() }).strict();
const StateSchema = z.object({
  version: z.literal(1),
  setups: z.record(z.string(), SetupRecordSchema),
  connections: z.record(z.string(), ConnectionStateSchema),
  secrets: z.record(z.string(), z.object({ mapping: z.string(), requestId: uuid }).strict()),
  references: z.record(z.string(), z.object({ principalRef: uuid, name: z.string() }).strict()),
}).strict();
type State = z.infer<typeof StateSchema>;
const initialState = (): State => ({ version: 1, setups: {}, connections: {}, secrets: {}, references: {} });
const CredentialSetupDoc = defineDoc<{ state: JsonObject }>({ kind: "cortex.desk-credential-setup", version: 1, scope: "session", initial: () => ({ state: initialState() }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50 });

export type SetupFailureCode =
  | "unauthenticated" | "unknown_setup" | "unknown_request" | "cross_principal" | "invalid_input" | "slot_collision" | "identity_collision"
  | "unrelated_secret" | "setup_in_progress" | "schema_changed" | "reference_not_authorized";
export class CredentialSetupError extends Error {
  constructor(readonly code: SetupFailureCode) { super(`Credential setup refused: ${code}.`); this.name = "CredentialSetupError"; }
}

export type SetupReason = "store_unavailable" | "store_write_failed" | "missing_input" | "commit_failed" | "oauth_broker_unavailable" | "auth_kind_unavailable" | "reference_missing";
export interface SlotStatus { slot: string; presence: "present" | "missing" }
export interface SetupResult { status: "active" | "incomplete" | "unavailable"; requestId: string; connectionId: string; connectionRevision: string; reason?: SetupReason; slots: SlotStatus[] }
export type SlotInput = { token: string } | { reference: string };

export interface SetupPrincipal { principalRef: string; principal: string; stack: string; expiresAt: string }
export interface SetupContext { readonly __setupContext: never }
export interface ReferenceGate { authorized(principalRef: string, name: string): boolean; present(name: string): boolean }
export interface DeskCredentialBrokerDeps {
  store: ArcSecretStore;
  authenticate(sessionRef: string): Promise<SetupPrincipal | null>;
  publishConnection(head: ConnectionHead): Promise<void>;
  references?: ReferenceGate;
  approvedBrokers?: ReadonlySet<string>;
  now?: () => Date;
  newId?: () => string;
}

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const mappingKey = (principalRef: string, stack: string, connectionId: string, credentialRevision: string, slot: string): string => JSON.stringify([principalRef, stack, connectionId, credentialRevision, slot]);
const identityOf = (mapping: string): string => `DESK_${sha(["identity", mapping]).slice(0, 48).toUpperCase()}`;
const handleOf = (mapping: string): string => `cred-${sha(["handle", mapping]).slice(0, 32)}`;
const asJson = (state: State): JsonObject => JSON.parse(JSON.stringify(state)) as JsonObject;
const digestOf = (descriptor: SetupDescriptor): string => sha(descriptor);

export class DeskCredentialBroker {
  private readonly descriptors = new Map<string, SetupDescriptor>();
  private readonly contexts = new WeakMap<object, { sessionRef: string; principal: SetupPrincipal }>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly engine: Pick<Session, "commit" | "snapshot">, private readonly deps: DeskCredentialBrokerDeps, private readonly hostContext: Context = BACKGROUND_CONTEXT) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  registerSetup(raw: SetupDescriptor): void {
    const descriptor = SetupDescriptorSchema.parse(raw);
    const slots = descriptor.slots.map(item => item.slot.normalize("NFKC").toLowerCase());
    if (new Set(slots).size !== slots.length || slots.some((slot, i) => slot !== descriptor.slots[i]?.slot)) throw new CredentialSetupError("slot_collision");
    const key = `${descriptor.packageId}\u0000${descriptor.setupSchemaId}\u0000${descriptor.version}`;
    const prior = this.descriptors.get(key);
    if (prior && digestOf(prior) !== digestOf(descriptor)) throw new CredentialSetupError("schema_changed");
    this.descriptors.set(key, Object.freeze(structuredClone(descriptor)));
  }

  async authenticate(sessionRef: string): Promise<SetupContext | null> {
    const principal = await this.deps.authenticate(sessionRef);
    if (!principal) return null;
    const checked = this.checkPrincipal(principal);
    const context = Object.freeze({}) as SetupContext;
    this.contexts.set(context, { sessionRef, principal: checked });
    return context;
  }

  begin(context: SetupContext, ref: { packageId: string; setupSchemaId: string; version: string }, connectionId?: string): Promise<SetupResult> {
    return this.serial(async () => {
      const principal = await this.bound(context);
      const descriptor = this.descriptors.get(`${ref.packageId}\u0000${ref.setupSchemaId}\u0000${ref.version}`);
      if (!descriptor) throw new CredentialSetupError("unknown_setup");
      if (connectionId !== undefined && !UUID.test(connectionId)) throw new CredentialSetupError("invalid_input");
      const state = await this.load();
      const existing = connectionId ? state.connections[connectionId] : undefined;
      if (connectionId && (existing?.principalRef !== principal.principalRef || existing.stack !== principal.stack || existing.packageId !== descriptor.packageId)) throw new CredentialSetupError(existing ? "cross_principal" : "invalid_input");
      if (existing?.pending) {
        const pending = state.setups[existing.pending];
        if (pending?.setupSchemaId === descriptor.setupSchemaId && pending.version === descriptor.version) return this.result(pending, state, this.unavailable(descriptor));
        throw new CredentialSetupError("setup_in_progress");
      }
      const unavailable = this.unavailable(descriptor);
      const id = connectionId ?? this.newId();
      const requestId = this.newId();
      if (!UUID.test(id) || !UUID.test(requestId)) throw new CredentialSetupError("invalid_input");
      const revision = existing?.nextRevision ?? 1;
      const credentialRevision = String(revision);
      const slots = descriptor.slots.map(item => {
        const mapping = mappingKey(principal.principalRef, principal.stack, id, credentialRevision, item.slot);
        return { slot: item.slot, mode: "unset" as const, identity: identityOf(mapping), handle: handleOf(mapping), state: "pending" as const, mapping };
      });
      const record: SetupRecord = SetupRecordSchema.parse({
        requestId, principalRef: principal.principalRef, stack: principal.stack, connectionId: id, credentialRevision,
        packageId: descriptor.packageId, setupSchemaId: descriptor.setupSchemaId, version: descriptor.version, authKind: descriptor.authKind,
        descriptorDigest: digestOf(descriptor), status: unavailable ? "incomplete" : "staged", ...(unavailable ? { reason: unavailable } : {}),
        slots: slots.map(({ mapping: _mapping, ...rest }) => rest), head: null,
      });
      await this.mutate(next => {
        for (const slot of slots) {
          const owner = next.secrets[slot.identity];
          if (owner && owner.mapping !== slot.mapping) throw new CredentialSetupError("identity_collision");
          if (Object.keys(next.secrets).some(known => known.toLowerCase() === slot.identity.toLowerCase() && known !== slot.identity)) throw new CredentialSetupError("identity_collision");
          next.secrets[slot.identity] = { mapping: slot.mapping, requestId };
        }
        next.setups[requestId] = record;
        next.connections[id] = { principalRef: principal.principalRef, stack: principal.stack, packageId: descriptor.packageId, nextRevision: revision + 1, active: existing?.active ?? null, pending: requestId };
      });
      return this.result(record, await this.load(), unavailable);
    });
  }

  provision(context: SetupContext, requestId: string, inputs: Readonly<Record<string, SlotInput>> = {}): Promise<SetupResult> {
    return this.serial(async () => {
      const principal = await this.bound(context);
      let state = await this.load();
      const setup = this.owned(state, principal, requestId);
      if (setup.status === "committed") return this.result(setup, state);
      const descriptor = this.descriptors.get(`${setup.packageId}\u0000${setup.setupSchemaId}\u0000${setup.version}`);
      if (!descriptor || digestOf(descriptor) !== setup.descriptorDigest) throw new CredentialSetupError("schema_changed");
      const unavailable = this.unavailable(descriptor);
      if (unavailable) return this.result(setup, state, unavailable);
      this.checkInputs(descriptor, inputs);

      if (setup.status !== "ready") {
        await this.choose(setup, principal, inputs);
        state = await this.load();
        const chosen = this.owned(state, principal, requestId);
        if (chosen.slots.some(slot => slot.mode === "unset")) return this.settle(chosen, "incomplete", "missing_input");
        const referenceProblem = this.resolveReferences(chosen, state);
        if (referenceProblem) return this.settle(chosen, "incomplete", referenceProblem);
        if (chosen.slots.some(slot => slot.mode === "secret" && slot.state === "pending")) {
          if (!await this.safely(() => this.deps.store.available(), false)) return this.settle(chosen, "incomplete", "store_unavailable");
          for (const slot of chosen.slots.filter(item => item.mode === "secret" && item.state === "pending")) {
            const written = await this.writeSlot(chosen, slot.slot, inputs);
            if (written !== true) return this.settle(await this.reload(requestId), "incomplete", written);
          }
        }
        await this.stageHead(requestId);
      }
      return this.publish(requestId);
    });
  }

  async status(context: SetupContext, connectionId: string): Promise<SetupResult | null> {
    return this.serial(async () => {
      const principal = await this.bound(context);
      const state = await this.load();
      const connection = state.connections[connectionId];
      if (!connection) return null;
      if (connection.principalRef !== principal.principalRef || connection.stack !== principal.stack) throw new CredentialSetupError("cross_principal");
      const setup = connection.active ?? connection.pending;
      return setup ? this.result(requireSetup(state, setup), state) : null;
    });
  }

  advanceRevision(context: SetupContext, connectionId: string): Promise<SetupResult> {
    return this.serial(async () => {
      const principal = await this.bound(context);
      const state = await this.load();
      const connection = state.connections[connectionId];
      if (connection?.principalRef !== principal.principalRef || connection.stack !== principal.stack) throw new CredentialSetupError("cross_principal");
      if (connection.pending || !connection.active) throw new CredentialSetupError("setup_in_progress");
      const active = requireSetup(state, connection.active);
      if (!active.head) throw new CredentialSetupError("unknown_request");
      const revision = connection.nextRevision;
      const requestId = this.newId();
      const head: ConnectionHead = { ...active.head, connectionRevision: String(revision), previousRevision: active.head.connectionRevision };
      const record: SetupRecord = SetupRecordSchema.parse({ ...active, requestId, status: "ready", head, credentialRevision: active.credentialRevision });
      await this.mutate(next => {
        next.setups[requestId] = record;
        next.connections[connectionId] = { ...connection, nextRevision: revision + 1, pending: requestId };
      });
      return this.publish(requestId);
    });
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch((_err: unknown) => undefined);
    return next;
  }

  private checkPrincipal(principal: SetupPrincipal): SetupPrincipal {
    if (!UUID.test(principal.principalRef) || !SLUG.test(principal.stack) || !principal.principal) throw new CredentialSetupError("unauthenticated");
    return principal;
  }

  private async bound(context: SetupContext): Promise<SetupPrincipal> {
    const held = this.contexts.get(context);
    if (!held) throw new CredentialSetupError("unauthenticated");
    const current = await this.deps.authenticate(held.sessionRef);
    if (!current || Date.parse(current.expiresAt) <= this.now().getTime()) throw new CredentialSetupError("unauthenticated");
    const checked = this.checkPrincipal(current);
    if (checked.principalRef !== held.principal.principalRef || checked.stack !== held.principal.stack) throw new CredentialSetupError("unauthenticated");
    return checked;
  }

  private unavailable(descriptor: SetupDescriptor): SetupReason | undefined {
    if (!(AUTH_KINDS as readonly string[]).includes(descriptor.authKind)) return "auth_kind_unavailable";
    if (descriptor.authKind === "oauth" && !(descriptor.broker && this.deps.approvedBrokers?.has(descriptor.broker))) return "oauth_broker_unavailable";
    return undefined;
  }

  private owned(state: State, principal: SetupPrincipal, requestId: string): SetupRecord {
    const setup = state.setups[requestId];
    if (!setup) throw new CredentialSetupError("unknown_request");
    if (setup.principalRef !== principal.principalRef || setup.stack !== principal.stack) throw new CredentialSetupError("cross_principal");
    return setup;
  }

  private checkInputs(descriptor: SetupDescriptor, inputs: Readonly<Record<string, SlotInput>>): void {
    const known = new Set(descriptor.slots.map(item => item.slot));
    const normalized = Object.keys(inputs).map(key => key.normalize("NFKC").toLowerCase());
    if (new Set(normalized).size !== normalized.length) throw new CredentialSetupError("slot_collision");
    if (Object.keys(inputs).some(key => !known.has(key))) throw new CredentialSetupError("invalid_input");
    const references = Object.values(inputs).flatMap(input => "reference" in input ? [input.reference] : []);
    if (new Set(references).size !== references.length) throw new CredentialSetupError("slot_collision");
    for (const input of Object.values(inputs)) {
      if ("token" in input ? !input.token || input.token.length > MAX_SECRET_CHARS : !REFERENCE_NAME.test(input.reference)) throw new CredentialSetupError("invalid_input");
    }
  }

  private async choose(setup: SetupRecord, principal: SetupPrincipal, inputs: Readonly<Record<string, SlotInput>>): Promise<void> {
    const gate = this.deps.references;
    for (const input of Object.values(inputs)) {
      if ("reference" in input && !gate?.authorized(principal.principalRef, input.reference)) throw new CredentialSetupError("reference_not_authorized");
    }
    await this.mutate(state => {
      const record = requireSetup(state, setup.requestId);
      for (const item of record.slots) {
        const input = inputs[item.slot];
        if (!input || item.mode !== "unset") continue;
        if ("token" in input) { item.mode = "secret"; continue; }
        const opaque = `ref-${sha(["reference", record.principalRef, input.reference]).slice(0, 32)}`;
        state.references[opaque] = { principalRef: record.principalRef, name: input.reference };
        item.mode = "reference";
        item.reference = opaque;
        item.state = "written";
      }
      record.status = "staged";
      delete record.reason;
    });
  }

  private resolveReferences(setup: SetupRecord, state: State): SetupReason | undefined {
    for (const slot of setup.slots.filter(item => item.mode === "reference")) {
      const name = slot.reference ? state.references[slot.reference]?.name : undefined;
      if (!name || !this.deps.references?.present(name)) return "reference_missing";
    }
    return undefined;
  }

  private async writeSlot(setup: SetupRecord, slot: string, inputs: Readonly<Record<string, SlotInput>>): Promise<true | SetupReason> {
    const record = requireSlot(setup, slot);
    const input = inputs[slot];
    if (!input || !("token" in input)) return "missing_input";
    const state = await this.load();
    const owner = state.secrets[record.identity];
    if (owner?.requestId !== setup.requestId) throw new CredentialSetupError("unrelated_secret");
    let outcome: "created" | "exists";
    try { outcome = await this.deps.store.writeIfAbsent(record.identity, input.token); }
    catch (_err) { return "store_write_failed"; }
    if (outcome === "exists" && !await this.safely(() => this.deps.store.matches(record.identity, input.token), false)) throw new CredentialSetupError("unrelated_secret");
    await this.mutate(next => {
      const target = requireSlot(requireSetup(next, setup.requestId), slot);
      target.state = "written";
    });
    return true;
  }

  private async stageHead(requestId: string): Promise<void> {
    await this.mutate(state => {
      const setup = requireSetup(state, requestId);
      const connection = state.connections[setup.connectionId];
      const active = connection?.active ? state.setups[connection.active]?.head : null;
      const slotHandles = Object.fromEntries(setup.slots.map(item => [item.slot, item.handle]));
      setup.head = HeadSchema.parse({
        connectionId: setup.connectionId, principalRef: setup.principalRef, stack: setup.stack, packageId: setup.packageId,
        connectionRevision: setup.credentialRevision, credentialHandle: `cred-${sha(["head", setup.connectionId, setup.credentialRevision, slotHandles]).slice(0, 32)}`,
        slotHandles, previousRevision: active?.connectionRevision ?? null,
      });
      setup.status = "ready";
      delete setup.reason;
    });
  }

  private async publish(requestId: string): Promise<SetupResult> {
    const state = await this.load();
    const setup = requireSetup(state, requestId);
    if (!setup.head) throw new CredentialSetupError("unknown_request");
    try { await this.deps.publishConnection(structuredClone(setup.head)); }
    catch (_err) { return this.result(setup, state, "commit_failed"); }
    await this.mutate(next => {
      const record = requireSetup(next, requestId);
      record.status = "committed";
      const connection = next.connections[record.connectionId];
      if (connection) { connection.active = requestId; connection.pending = null; }
    });
    return this.result(await this.reload(requestId), await this.load());
  }

  private async settle(setup: SetupRecord, status: "incomplete", reason: SetupReason): Promise<SetupResult> {
    await this.mutate(state => { const record = requireSetup(state, setup.requestId); record.status = status; record.reason = reason; });
    return this.result(await this.reload(setup.requestId), await this.load(), reason);
  }

  private async reload(requestId: string): Promise<SetupRecord> { return requireSetup(await this.load(), requestId); }

  private async safely<T>(run: () => Promise<T>, fallback: T): Promise<T> {
    try { return await run(); } catch (_err) { return fallback; }
  }

  private async result(setup: SetupRecord, state: State, reason?: SetupReason): Promise<SetupResult> {
    const unavailable = reason === "oauth_broker_unavailable" || reason === "auth_kind_unavailable";
    const committed = setup.status === "committed";
    const slots: SlotStatus[] = [];
    for (const item of setup.slots) {
      const name = item.reference ? state.references[item.reference]?.name : undefined;
      const present = item.mode === "reference" ? Boolean(name && this.deps.references?.present(name)) : item.state === "written" && await this.safely(() => this.deps.store.present(item.identity), false);
      slots.push({ slot: item.slot, presence: present ? "present" : "missing" });
    }
    const why = reason ?? (committed ? undefined : (setup.reason as SetupReason | undefined));
    return { status: committed ? "active" : unavailable ? "unavailable" : "incomplete", requestId: setup.requestId, connectionId: setup.connectionId, connectionRevision: setup.head?.connectionRevision ?? setup.credentialRevision, ...(why ? { reason: why } : {}), slots };
  }

  private async load(): Promise<State> {
    const doc = await this.engine.snapshot(CredentialSetupDoc, this.hostContext);
    return StateSchema.parse(doc?.state ?? initialState());
  }

  private async mutate(change: (state: State) => void): Promise<void> {
    await this.engine.commit(async tx => {
      const doc = await tx.doc(CredentialSetupDoc);
      const state = StateSchema.parse(doc.state);
      change(state);
      doc.state = asJson(StateSchema.parse(state));
    }, this.hostContext);
  }
}

function requireSetup(state: State, requestId: string): SetupRecord {
  const setup = state.setups[requestId];
  if (!setup) throw new CredentialSetupError("unknown_request");
  return setup;
}
function requireSlot(setup: SetupRecord, slot: string): SetupRecord["slots"][number] {
  const found = setup.slots.find(item => item.slot === slot);
  if (!found) throw new CredentialSetupError("invalid_input");
  return found;
}
