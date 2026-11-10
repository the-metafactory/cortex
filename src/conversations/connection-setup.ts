import { z } from "zod";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type JsonObject, type Session } from "@earendil-works/pi-durable";
import type { AuthorityMediator } from "./authority";
import { ConnectionRecordSchema, type ConnectionRecord } from "./authority-records";
import { CredentialSetupError, type DeskCredentialBroker, type SetupContext, type SetupDescriptor, type SetupPrincipal, type SetupReason, type SlotInput, type SlotStatus } from "../common/config/desk-credential-broker";
import { ObjectReferenceSchema, type ObjectReference } from "./domain-adapters/types";
import { canonicalWire } from "./domain-adapters/operations/validation";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FIELD = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_SCOPE_CHARS = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SetupCatalogEntry {
  packageId: string;
  label: string;
  setup: SetupDescriptor;
  connectorId: string;
  executionBindingRef: string;
  registryRevision: string;
  scopeFields: { name: string; label: string }[];
  capabilities: { capabilityId: string; label: string; access: "read" | "write" }[];
  destinations: { ref: ObjectReference; label: string }[];
}

export type ConnectionState = "discovered" | "incomplete" | "disabled" | "enabled" | "unavailable";
export type SetupUnavailableReason = SetupReason | "package_missing";

export interface ConnectionView {
  connectionId: string;
  packageId: string;
  state: ConnectionState;
  reason?: SetupUnavailableReason;
  revision: number;
  scope: Record<string, string>;
  readCapabilityIds: string[];
  writeCapabilityIds: string[];
  readDestinations: ObjectReference[];
  writeDestinations: ObjectReference[];
  slots: SlotStatus[];
  publishedRevision: string | null;
}

export interface PackageForm {
  packageId: string;
  label: string;
  authKind: string;
  unavailableReason?: SetupReason;
  slots: SetupDescriptor["slots"];
  scopeFields: SetupCatalogEntry["scopeFields"];
  capabilities: SetupCatalogEntry["capabilities"];
  destinations: SetupCatalogEntry["destinations"];
  references: string[];
}

export type ConnectionFailureCode =
  | "unauthenticated" | "cross_principal" | "unknown_package" | "unknown_connection" | "stale_head"
  | "invalid_scope" | "invalid_capability" | "invalid_destination" | "setup_incomplete" | "package_unavailable" | "authority_changed";
export class ConnectionSetupError extends Error {
  constructor(readonly code: ConnectionFailureCode | CredentialSetupError["code"]) { super(`Connection setup refused: ${code}.`); this.name = "ConnectionSetupError"; }
}

const refs = z.array(ObjectReferenceSchema);
const ConfigSchema = z.object({
  connectionId: z.string().regex(UUID), principalRef: z.string().regex(UUID), stack: z.string(), packageId: z.string(),
  setupSchemaId: z.string(), setupVersion: z.string(), requestId: z.string().regex(UUID), revision: z.number().int().positive(),
  scope: z.record(z.string(), z.string()), readCapabilityIds: z.array(z.string()), writeCapabilityIds: z.array(z.string()),
  readDestinations: refs, writeDestinations: refs,
  head: z.object({ credentialHandle: z.string(), connectionRevision: z.string() }).strict().nullable(),
}).strict();
type Config = z.infer<typeof ConfigSchema>;
const StateSchema = z.object({ version: z.literal(1), connections: z.record(z.string(), ConfigSchema) }).strict();
type State = z.infer<typeof StateSchema>;
const ConnectionSetupDoc = defineDoc<{ state: JsonObject }>({ kind: "cortex.desk-connection-setup", version: 1, scope: "session", initial: () => ({ state: { version: 1, connections: {} } }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50 });

export interface ConnectionSetupInput {
  packageId: string;
  connectionId?: string;
  expectedRevision?: number;
  scope: Record<string, string>;
  readCapabilityIds: string[];
  writeCapabilityIds: string[];
  readDestinations: ObjectReference[];
  writeDestinations: ObjectReference[];
  inputs?: Readonly<Record<string, SlotInput>>;
}

export interface ConnectionSetupDeps {
  stack: string;
  catalog(): readonly SetupCatalogEntry[];
  principalFor(principal: string, stack: string): Promise<SetupPrincipal | null>;
  references(principalRef: string): string[];
  closeBridges(connectionId: string): Promise<void>;
  approvedBrokers?: ReadonlySet<string>;
}

const sameRefs = (left: ObjectReference[], right: ObjectReference[]): boolean => canonicalWire([...left.map(canonicalWire)].sort()) === canonicalWire([...right.map(canonicalWire)].sort());
const unique = <T>(items: T[], key: (item: T) => string): boolean => new Set(items.map(key)).size === items.length;

export class ConnectionSetupService {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly engine: Pick<Session, "commit" | "snapshot">,
    private readonly broker: DeskCredentialBroker,
    private readonly authority: Pick<AuthorityMediator, "inspectHostRecords" | "publishHostRecord">,
    private readonly deps: ConnectionSetupDeps,
    private readonly hostContext: Context = BACKGROUND_CONTEXT,
  ) {}

  registerCatalog(): void {
    for (const entry of this.deps.catalog()) {
      if (!ID.test(entry.packageId) || entry.scopeFields.length === 0 || !entry.scopeFields.every(field => FIELD.test(field.name))) throw new ConnectionSetupError("unknown_package");
      this.broker.registerSetup(entry.setup);
    }
  }

  forms(principal: string): Promise<PackageForm[]> {
    return this.serial(async () => {
      const bound = await this.principalOf(principal);
      const names = this.deps.references(bound.principalRef);
      return this.deps.catalog().map(entry => {
        const unavailable = this.unavailableReason(entry.setup);
        return { packageId: entry.packageId, label: entry.label, authKind: entry.setup.authKind, ...(unavailable ? { unavailableReason: unavailable } : {}), slots: entry.setup.slots, scopeFields: entry.scopeFields, capabilities: entry.capabilities, destinations: entry.destinations, references: names };
      });
    });
  }

  list(principal: string): Promise<ConnectionView[]> {
    return this.serial(async () => {
      const bound = await this.principalOf(principal);
      const context = await this.context(principal);
      const state = await this.load();
      const views: ConnectionView[] = [];
      for (const config of Object.values(state.connections)) {
        if (config.principalRef === bound.principalRef && config.stack === bound.stack) views.push(await this.view(context, config));
      }
      return views;
    });
  }

  configure(principal: string, input: ConnectionSetupInput): Promise<ConnectionView> {
    return this.serial(async () => {
      const bound = await this.principalOf(principal);
      const entry = this.entry(input.packageId);
      this.checkSelection(entry, input);
      const existing = input.connectionId ? this.ownedConfig(await this.load(), bound, input.connectionId) : undefined;
      if (existing) {
        if (existing.packageId !== entry.packageId) throw new ConnectionSetupError("unknown_package");
        if (input.expectedRevision !== existing.revision) throw new ConnectionSetupError("stale_head");
      } else if (input.connectionId) throw new ConnectionSetupError("unknown_connection");
      const context = await this.context(principal);
      const changed = existing ? this.selectionChanged(existing, input) || Object.keys(input.inputs ?? {}).length > 0 : false;
      if (existing && changed) await this.fence(existing.connectionId);

      const hasInputs = Object.keys(input.inputs ?? {}).length > 0;
      const active = existing ? await this.isActive(context, existing) : false;
      let requestId = existing?.requestId;
      let connectionId = existing?.connectionId;
      if (!existing || (active && hasInputs)) {
        const begun = await this.broker.begin(context, { packageId: entry.setup.packageId, setupSchemaId: entry.setup.setupSchemaId, version: entry.setup.version }, existing?.connectionId);
        requestId = begun.requestId;
        connectionId = begun.connectionId;
      }
      if (!requestId || !connectionId) throw new ConnectionSetupError("unknown_connection");
      const config = await this.store(bound, entry, connectionId, requestId, input, existing);
      if (!active || hasInputs) await this.broker.provision(context, requestId, input.inputs ?? {});
      return this.view(context, (await this.load()).connections[config.connectionId] ?? config);
    });
  }

  resume(principal: string, connectionId: string, expectedRevision: number, inputs: Readonly<Record<string, SlotInput>> = {}): Promise<ConnectionView> {
    return this.serial(async () => {
      const { config, context } = await this.claim(principal, connectionId, expectedRevision);
      this.entry(config.packageId);
      await this.broker.provision(context, config.requestId, inputs);
      return this.view(context, (await this.load()).connections[connectionId] ?? config);
    });
  }

  enable(principal: string, connectionId: string, expectedRevision: number): Promise<ConnectionView> {
    return this.serial(async () => {
      const { bound, config, context } = await this.claim(principal, connectionId, expectedRevision);
      const entry = this.entry(config.packageId);
      if (this.unavailableReason(entry.setup)) throw new ConnectionSetupError("package_unavailable");
      const status = await this.broker.status(context, connectionId);
      if (status?.status !== "active" || !config.head) throw new ConnectionSetupError("setup_incomplete");
      const authority = await this.authority.inspectHostRecords();
      const key = `connection:${connectionId}`;
      const head = authority.heads[key] ?? 0;
      const latest = authority.records[key]?.at(-1);
      const record = this.record(config, entry, bound, head + 1, "active");
      if (latest?.kind === "connection" && latest.value.status === "active" && sameConnection(latest.value, record)) return this.view(context, config);
      try { await this.authority.publishHostRecord({ kind: "connection", value: record }, head); }
      catch (_err) { throw new ConnectionSetupError("authority_changed"); }
      return this.view(context, await this.bump(config.connectionId));
    });
  }

  disable(principal: string, connectionId: string, expectedRevision: number): Promise<ConnectionView> {
    return this.serial(async () => {
      const { context } = await this.claim(principal, connectionId, expectedRevision);
      await this.fence(connectionId);
      return this.view(context, await this.bump(connectionId));
    });
  }

  private async claim(principal: string, connectionId: string, expectedRevision: number): Promise<{ bound: SetupPrincipal; config: Config; context: SetupContext }> {
    const bound = await this.principalOf(principal);
    const config = this.ownedConfig(await this.load(), bound, connectionId);
    if (config.revision !== expectedRevision) throw new ConnectionSetupError("stale_head");
    return { bound, config, context: await this.context(principal) };
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private entry(packageId: string): SetupCatalogEntry {
    const found = this.deps.catalog().find(item => item.packageId === packageId);
    if (!found) throw new ConnectionSetupError("unknown_package");
    return found;
  }

  private unavailableReason(descriptor: SetupDescriptor): SetupReason | undefined {
    if (!["local", "token", "oauth"].includes(descriptor.authKind)) return "auth_kind_unavailable";
    if (descriptor.authKind === "oauth" && !(descriptor.broker && this.deps.approvedBrokers?.has(descriptor.broker))) return "oauth_broker_unavailable";
    return undefined;
  }

  private async principalOf(principal: string): Promise<SetupPrincipal> {
    const found = await this.deps.principalFor(principal, this.deps.stack);
    if (found?.stack !== this.deps.stack) throw new ConnectionSetupError("unauthenticated");
    return found;
  }

  private async context(principal: string): Promise<SetupContext> {
    const context = await this.broker.authenticate(principal);
    if (!context) throw new ConnectionSetupError("unauthenticated");
    return context;
  }

  private ownedConfig(state: State, principal: SetupPrincipal, connectionId: string): Config {
    const found = state.connections[connectionId];
    if (!found) throw new ConnectionSetupError("unknown_connection");
    if (found.principalRef !== principal.principalRef || found.stack !== principal.stack) throw new ConnectionSetupError("cross_principal");
    return found;
  }

  private checkSelection(entry: SetupCatalogEntry, input: ConnectionSetupInput): void {
    const allowed = new Set(entry.scopeFields.map(field => field.name));
    const keys = Object.keys(input.scope);
    if (keys.length !== allowed.size || keys.some(key => !allowed.has(key))) throw new ConnectionSetupError("invalid_scope");
    if (Object.values(input.scope).some(value => value.trim() === "" || value.length > MAX_SCOPE_CHARS)) throw new ConnectionSetupError("invalid_scope");
    const caps = (access: "read" | "write") => new Set(entry.capabilities.filter(item => item.access === access).map(item => item.capabilityId));
    if (!input.readCapabilityIds.every(id => caps("read").has(id)) || !input.writeCapabilityIds.every(id => caps("write").has(id))) throw new ConnectionSetupError("invalid_capability");
    if (!unique(input.readCapabilityIds, id => id) || !unique(input.writeCapabilityIds, id => id)) throw new ConnectionSetupError("invalid_capability");
    const known = new Set(entry.destinations.map(item => canonicalWire(item.ref)));
    for (const list of [input.readDestinations, input.writeDestinations]) {
      if (!list.every(ref => known.has(canonicalWire(ref))) || !unique(list, canonicalWire)) throw new ConnectionSetupError("invalid_destination");
    }
    if ((input.readCapabilityIds.length > 0) !== (input.readDestinations.length > 0) || (input.writeCapabilityIds.length > 0) !== (input.writeDestinations.length > 0)) throw new ConnectionSetupError("invalid_destination");
  }

  private selectionChanged(config: Config, input: ConnectionSetupInput): boolean {
    return canonicalWire(config.scope) !== canonicalWire(input.scope)
      || canonicalWire([...config.readCapabilityIds].sort()) !== canonicalWire([...input.readCapabilityIds].sort())
      || canonicalWire([...config.writeCapabilityIds].sort()) !== canonicalWire([...input.writeCapabilityIds].sort())
      || !sameRefs(config.readDestinations, input.readDestinations) || !sameRefs(config.writeDestinations, input.writeDestinations);
  }

  private async isActive(context: SetupContext, config: Config): Promise<boolean> {
    const status = await this.broker.status(context, config.connectionId);
    return status?.status === "active" && status.requestId === config.requestId;
  }

  private async fence(connectionId: string): Promise<void> {
    const authority = await this.authority.inspectHostRecords();
    const key = `connection:${connectionId}`;
    const latest = authority.records[key]?.at(-1);
    if (latest?.kind === "connection" && latest.value.status === "active") {
      const head = authority.heads[key] ?? 0;
      try { await this.authority.publishHostRecord({ kind: "connection", value: { ...latest.value, status: "revoked", connectionRevision: String(head + 1) } }, head); }
      catch (_err) { throw new ConnectionSetupError("authority_changed"); }
    }
    await this.deps.closeBridges(connectionId);
  }

  private record(config: Config, entry: SetupCatalogEntry, principal: SetupPrincipal, revision: number, status: "active" | "revoked"): ConnectionRecord {
    if (!config.head) throw new ConnectionSetupError("setup_incomplete");
    return ConnectionRecordSchema.parse({
      version: 1, status, connectionId: config.connectionId, adapterId: entry.packageId, principalRef: principal.principalRef, connectionRevision: String(revision),
      credentialHandle: config.head.credentialHandle, accountScope: config.scope, readCapabilityIds: config.readCapabilityIds, writeCapabilityIds: config.writeCapabilityIds,
      readDestinations: config.readDestinations, writeDestinations: config.writeDestinations, connectorId: entry.connectorId, executionBindingRef: entry.executionBindingRef, registryRevision: entry.registryRevision,
    });
  }

  private async store(principal: SetupPrincipal, entry: SetupCatalogEntry, connectionId: string, requestId: string, input: ConnectionSetupInput, existing: Config | undefined): Promise<Config> {
    const config: Config = ConfigSchema.parse({
      connectionId, principalRef: principal.principalRef, stack: principal.stack, packageId: entry.packageId, setupSchemaId: entry.setup.setupSchemaId, setupVersion: entry.setup.version,
      requestId, revision: (existing?.revision ?? 0) + 1, scope: input.scope, readCapabilityIds: input.readCapabilityIds, writeCapabilityIds: input.writeCapabilityIds,
      readDestinations: input.readDestinations, writeDestinations: input.writeDestinations, head: existing?.requestId === requestId ? existing.head : null,
    });
    await this.mutate(state => { state.connections[connectionId] = config; });
    return config;
  }

  recordHead(head: { connectionId: string; credentialHandle: string; connectionRevision: string }): Promise<void> {
    return this.mutate(state => {
      const config = state.connections[head.connectionId];
      if (config) config.head = { credentialHandle: head.credentialHandle, connectionRevision: head.connectionRevision };
    });
  }

  private async bump(connectionId: string): Promise<Config> {
    await this.mutate(state => { const config = state.connections[connectionId]; if (config) config.revision += 1; });
    const config = (await this.load()).connections[connectionId];
    if (!config) throw new ConnectionSetupError("unknown_connection");
    return config;
  }

  private async view(context: SetupContext, config: Config): Promise<ConnectionView> {
    const status = await this.broker.status(context, config.connectionId);
    const entry = this.deps.catalog().find(item => item.packageId === config.packageId);
    const authority = await this.authority.inspectHostRecords();
    const latest = authority.records[`connection:${config.connectionId}`]?.at(-1);
    const live = latest?.kind === "connection" ? latest.value : undefined;
    const active = status?.status === "active" && config.head !== null;
    const published = live?.status === "active" && live.credentialHandle === config.head?.credentialHandle;
    const mechanismMissing = status?.reason === "oauth_broker_unavailable" || status?.reason === "auth_kind_unavailable";
    let state: ConnectionState = !active ? (mechanismMissing ? "unavailable" : "incomplete") : published ? "enabled" : "disabled";
    let reason: SetupUnavailableReason | undefined = status?.reason;
    if (!entry) { state = "unavailable"; reason = "package_missing"; }
    return {
      connectionId: config.connectionId, packageId: config.packageId, state, ...(reason ? { reason } : {}), revision: config.revision, scope: config.scope,
      readCapabilityIds: config.readCapabilityIds, writeCapabilityIds: config.writeCapabilityIds, readDestinations: config.readDestinations, writeDestinations: config.writeDestinations,
      slots: status?.slots ?? [], publishedRevision: live ? live.connectionRevision : null,
    };
  }

  private async load(): Promise<State> {
    const doc = await this.engine.snapshot(ConnectionSetupDoc, this.hostContext);
    return StateSchema.parse(doc?.state ?? { version: 1, connections: {} });
  }

  private async mutate(change: (state: State) => void): Promise<void> {
    await this.engine.commit(async tx => {
      const doc = await tx.doc(ConnectionSetupDoc);
      const state = StateSchema.parse(doc.state);
      change(state);
      doc.state = JSON.parse(JSON.stringify(StateSchema.parse(state))) as JsonObject;
    }, this.hostContext);
  }
}

function sameConnection(left: ConnectionRecord, right: ConnectionRecord): boolean {
  const strip = ({ connectionRevision: _revision, status: _status, ...rest }: ConnectionRecord) => rest;
  return canonicalWire(strip(left)) === canonicalWire(strip(right));
}
