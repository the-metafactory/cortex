import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { createArcFileSecretStore } from "../../../common/config/desk-credential-arc-file-store";
import type { SetupPrincipal } from "../../../common/config/desk-credential-broker";
import type { AuthenticatedBinding, AuthorityBindings, TrustedConnector } from "../../../conversations/authority";
import { authorityHash, type ReleaseSink, type RestrictionRecord } from "../../../conversations/authority-records";
import type { SetupCatalogEntry } from "../../../conversations/connection-setup";
import { createBalanceReadAdapter, balanceReadBindings } from "../../../conversations/domain-adapters/balance/read";
import { BALANCE_TASK_OBSERVATION_CAPABILITY_ID, balanceTaskObservationBinding, createBalanceObservationAdapter } from "../../../conversations/domain-adapters/balance/observation";
import { DomainAdapterRegistry } from "../../../conversations/domain-adapters/registry";
import { ReadBindings } from "../../../conversations/domain-adapters/reads/bindings";
import type { Json } from "../../../conversations/domain-adapters/operations/types";
import type { QuerySource } from "../../../conversations/domain-adapters/reads/query-types";
import type { ConversationHost } from "../../../conversations/host";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import { loadBalanceState } from "./balance-store";
import { createBalanceDayReader, releasedObservationViews, type BalanceDayProjection } from "./balance-day";
import type { DeskOptions } from "./compose";

const REVISION = "balance-read-1";
const CONNECTOR = "balance-local-read";
const RESOLVER = "balance-local-area";
const CAPABILITIES = new Set(["balance.destinations", "balance.task.read"]);
const OBSERVATION = BALANCE_TASK_OBSERVATION_CAPABILITY_ID;
const READ_LABELS: Record<string, string> = { "balance.destinations": "List destinations", "balance.task.read": "Read tasks", [OBSERVATION]: "Observe tasks" };
const READ_BINDINGS = [...balanceReadBindings, balanceTaskObservationBinding()];
const expiry = (): string => new Date(Date.now() + 60_000).toISOString();

export interface BalanceConnectionDeps {
  host: ConversationHost;
  db: Database;
  desk(): DeskOptions | undefined;
  stack: string;
  isPrincipal(principal: string): boolean;
  secretRoot: string;
}
export interface BalanceBrowserRead {
  conversationId: string;
  connectionId: string;
  capabilityId: "balance.destinations" | "balance.task.read";
  input: Json;
  destinations: ObjectReference[];
}

export function balanceSetupCatalog(deps: Pick<BalanceConnectionDeps, "desk" | "stack">): SetupCatalogEntry[] {
  if (!deps.desk()?.enabled) return [];
  return [{
    packageId: "balance", label: "Balance", setup: { packageId: "balance", setupSchemaId: "balance-local", version: "1.0.0", authKind: "local", slots: [] },
    connectorId: CONNECTOR, executionBindingRef: REVISION, registryRevision: REVISION,
    scopeFields: [], fixedScope: { stack: deps.stack },
    capabilities: READ_BINDINGS.filter(binding => CAPABILITIES.has(binding.capabilityId) || binding.capabilityId === OBSERVATION).map(binding => ({ capabilityId: binding.capabilityId, label: READ_LABELS[binding.capabilityId] ?? binding.capabilityId, access: "read" })),
    destinations: (deps.desk()?.areas ?? []).map(area => ({ ref: { adapterId: "balance", connectionId: "balance", objectType: "area", canonicalId: area.id }, label: area.label })),
    connectionScopedDestinations: true,
  }];
}

export function createBalanceConnection(deps: BalanceConnectionDeps) {
  const { host } = deps;
  let observationConnectionId = "balance";
  const balanceSource = { get connectionId() { return observationConnectionId; }, state: () => loadBalanceState(deps.db), areas: () => deps.desk()?.enabled ? deps.desk()?.areas ?? [] : [] };
  const adapterFor = (connectionId: string) => createBalanceReadAdapter({ connectionId, state: balanceSource.state, areas: balanceSource.areas });
  const observation = createBalanceObservationAdapter(balanceSource);
  const registry = new DomainAdapterRegistry();
  const registered = registry.register(observation.declaration, observation.bindings);
  if (!registered.ok) throw new Error(registered.error.code);
  const readBindings = new ReadBindings(registry);
  const sessions = new Map<string, AuthenticatedBinding>();
  const connector: TrustedConnector = {
    writerOwner: "balance",
    support: { lifecycleVersion: "1.0.0", adapterId: "balance", connectionId: "balance", capabilityId: "balance.task.read", declarationId: REVISION, dedup: { kind: "none" }, operationLookup: "none", conditionalUpdate: "none", cancellation: "none" },
    dispatch: () => Promise.reject(new Error("Balance connection is read-only.")),
    observation: observation.connector,
    async authorizeConnection(connection) {
      const principal = await principalForRef(connection.principalRef);
      const context = principal ? await broker.authenticate(principal.principal) : null;
      const status = context ? await broker.status(context, connection.connectionId) : null;
      return { version: 1, available: deps.desk()?.enabled === true && connection.adapterId === "balance" && connection.executionBindingRef === REVISION && connection.registryRevision === REVISION && authorityHash(connection.accountScope) === authorityHash({ stack: deps.stack }) && status?.status === "active", revision: status?.connectionRevision ?? "unavailable" };
    },
    query: request => {
      const connectionId = request.destinations[0]?.connectionId;
      if (!connectionId || !CAPABILITIES.has(request.capabilityId)) return Promise.reject(new Error("Balance read scope is unavailable."));
      return adapterFor(connectionId).query(request);
    },
  };
  const bindings: AuthorityBindings = {
    currentRevision: () => authorityHash({ desk: deps.desk()?.enabled ?? false, areas: deps.desk()?.areas ?? [], stack: deps.stack }),
    authenticate: ref => Promise.resolve(sessions.get(ref) ?? null),
    policy: binding => Promise.resolve({ version: 1, contextRevision: REVISION, conversationPolicy: "local", tool: null, communication: null, link: null, work: null, history: null, registryRevision: REVISION, executionBindingRevision: REVISION, operationVisible: deps.isPrincipal(binding.principal), readsAllowed: deps.desk()?.enabled === true, writesAllowed: false, releaseAllowed: deps.isPrincipal(binding.principal), allowedAudiences: ["web"] }),
    writer: () => Promise.resolve(false),
    connectors: new Map([[CONNECTOR, connector]]), sinks: new Map(), readBindings,
    restrictions: new Map([[RESOLVER, record => Promise.resolve(currentArea(record) ? record : null)]]),
  };
  const authority = host.lifecycleAuthority(registry, bindings);
  const runner = host.readQueries(registry, bindings);
  const principalForRef = async (ref: string): Promise<SetupPrincipal | null> => {
    const record = (await authority.inspectHostRecords()).records[`principal:${ref}`]?.at(-1);
    return record?.kind === "principal" && record.value.status === "active" && record.value.stack === deps.stack && deps.isPrincipal(record.value.principal) ? { ...record.value, expiresAt: expiry() } : null;
  };
  const principalFor = async (principal: string, stack: string): Promise<SetupPrincipal | null> => {
    if (stack !== deps.stack || !deps.isPrincipal(principal)) return null;
    const records = await authority.inspectHostRecords();
    const matches = Object.values(records.records).flatMap(values => { const record = values.at(-1); return record?.kind === "principal" && record.value.principal === principal && record.value.stack === stack ? [record.value] : []; });
    if (matches.length > 1 || matches[0]?.status === "revoked") return null;
    const found = matches[0];
    if (found) return { ...found, expiresAt: expiry() };
    const value = { version: 1 as const, status: "active" as const, principalRef: randomUUID(), principal, stack, identityBindingRevision: "1" };
    await authority.publishHostRecord({ kind: "principal", value }, 0);
    return { ...value, expiresAt: expiry() };
  };
  const broker = host.credentialBroker({ store: createArcFileSecretStore({ configRoot: deps.secretRoot }), authenticate: principal => principalFor(principal, deps.stack), publishConnection: head => setup.recordHead(head) });
  const setup = host.connectionSetup(broker, authority, { stack: deps.stack, catalog: () => balanceSetupCatalog(deps), principalFor, references: () => [], closeBridges: () => Promise.resolve() });
  setup.registerCatalog();
  const currentArea = (record: RestrictionRecord): boolean => deps.desk()?.enabled === true && record.source.adapterId === "balance" && record.source.objectType === "area" && (deps.desk()?.areas ?? []).some(area => area.id === record.source.canonicalId);
  const connected = new Set<string>();
  let tail: Promise<unknown> = Promise.resolve();
  const prepare = (principal: string, connectionId: string) => {
    const work = tail.then(async () => {
      const connection = (await setup.list(principal)).find(item => item.connectionId === connectionId && item.packageId === "balance");
      if (connection?.state !== "enabled") return null;
      observationConnectionId = connectionId;
      if (!connected.has(connectionId)) {
        for (const binding of READ_BINDINGS.filter(item => CAPABILITIES.has(item.capabilityId) || item.capabilityId === OBSERVATION)) {
          const result = readBindings.register(binding, { adapterId: "balance", connectionId, readCapabilityIds: [...CAPABILITIES, OBSERVATION] });
          if (!result.ok) throw new Error(result.error.code);
        }
        connected.add(connectionId);
      }
      const owner = await principalFor(principal, deps.stack);
      if (!owner) return null;
      const state = await authority.inspectHostRecords();
      for (const destination of connection.readDestinations) {
        const exists = Object.values(state.records).some(values => { const record = values.at(-1); return record?.kind === "restriction" && authorityHash(record.value.source) === authorityHash(destination); });
        if (!exists) await authority.publishHostRecord({ kind: "restriction", value: { version: 1, status: "active", restrictionRef: randomUUID(), source: destination, ownerRevision: REVISION, decisionRef: REVISION, audiences: ["web"], egress: "local", readScope: [owner.principalRef], resolverBinding: RESOLVER, revision: "1" } }, 0);
      }
      return connection;
    });
    tail = work.then(() => undefined, () => undefined);
    return work;
  };
  const reads = new Map<string, Promise<unknown>>();
  const observationConversations = new Map<string, Promise<string>>();
  const dayConversation = (principal: string): Promise<string> => {
    const held = observationConversations.get(principal);
    if (held) return held;
    const created = host.create({ title: "Balance observation", policy: "local", links: [], origin: { kind: "web" } }, principal, { key: `desk:balance-observations:${principal}`, state: "archived" }).then(meta => meta.id);
    observationConversations.set(principal, created);
    return created;
  };
  const activePrincipal = async (): Promise<string | null> => {
    const state = await authority.inspectHostRecords();
    const active = Object.values(state.records).flatMap(values => {
      const record = values.at(-1);
      return record?.kind === "principal" && record.value.status === "active" && record.value.stack === deps.stack && deps.isPrincipal(record.value.principal) ? [record.value.principal] : [];
    });
    const distinct = [...new Set(active)];
    return distinct.length === 1 ? distinct[0] ?? null : null;
  };
  const observationProjection = async (refresh: boolean): Promise<BalanceDayProjection | null> => {
    if (deps.desk()?.enabled !== true) return null;
    const principal = await activePrincipal();
    if (!principal) return null;
    const connection = (await setup.list(principal)).find(item => item.packageId === "balance" && item.state === "enabled");
    if (!connection) return null;
    const prepared = await prepare(principal, connection.connectionId);
    if (!prepared) return null;
    const configured = new Set((deps.desk()?.areas ?? []).map(area => area.id));
    const destinations = connection.readDestinations.filter(destination => destination.adapterId === "balance" && destination.objectType === "area" && configured.has(destination.canonicalId));
    if (destinations.length === 0) return null;
    const conversationId = await dayConversation(principal);
    const sessionRef = randomUUID();
    const sink: ReleaseSink = { kind: "web", conversationId };
    const unregister = authority.registerReleaseSink(sink, () => Promise.resolve());
    sessions.set(sessionRef, { principal, stack: deps.stack, conversationId, authenticatedSessionRef: sessionRef, transport: "web", audience: "web", expiresAt: expiry(), maintenance: false });
    try {
      const context = await authority.authenticate(sessionRef);
      if (!context) return null;
      const binding = balanceTaskObservationBinding();
      const source: QuerySource = { adapterId: "balance", connectionId: connection.connectionId, capabilityId: OBSERVATION, inputSchemaRef: binding.inputSchemaRef, destinations, input: {} };
      const store = host.readObservations(registry, bindings);
      const reader = createBalanceDayReader({
        check: mode => store.check(context, source, sink, mode),
        async views() {
          const released = await store.read(context, source, sink);
          return released.kind === "released" ? releasedObservationViews(released.value) : null;
        },
      });
      return await reader.projection(refresh);
    } catch (error) {
      process.stderr.write(`[desk-balance-observation] ${error instanceof Error ? error.message : "failed"}\n`);
      return null;
    } finally {
      sessions.delete(sessionRef);
      unregister();
    }
  };
  return {
    setup,
    day: { projection: (refresh = false) => observationProjection(refresh) },
    read(principal: string, request: BalanceBrowserRead, signal?: AbortSignal) {
      const prior = reads.get(request.conversationId)?.then(() => undefined, () => undefined) ?? Promise.resolve();
      const work = prior.then(async () => {
        if (!deps.isPrincipal(principal) || await host.principalOf(request.conversationId) !== principal) return null;
        const connection = await prepare(principal, request.connectionId);
        const binding = balanceReadBindings.find(item => item.capabilityId === request.capabilityId);
        if (!connection || !binding) return null;
        const sessionRef = randomUUID();
        const sink: ReleaseSink = { kind: "web", conversationId: request.conversationId };
        const released: Json[] = [];
        const unregister = authority.registerReleaseSink(sink, value => { released.push(value); return Promise.resolve(); });
        sessions.set(sessionRef, { principal, stack: deps.stack, conversationId: request.conversationId, authenticatedSessionRef: sessionRef, transport: "web", audience: "web", expiresAt: expiry(), maintenance: false });
        try {
          const context = await authority.authenticate(sessionRef);
          if (!context) return null;
          const source: QuerySource = { adapterId: "balance", connectionId: request.connectionId, capabilityId: request.capabilityId, inputSchemaRef: binding.inputSchemaRef, destinations: request.destinations, input: request.input };
          const created = await runner.create(context, [source], sink);
          const invocation = runner.invocation();
          let result = await runner.run(context, created, sink, invocation, signal);
          while (result.continuation && result.groups.every(group => group.status === "ok") && released.length < 3) result = await runner.run(context, { ...created, continuation: result.continuation }, sink, invocation, signal);
          if (result.continuation) {
            await runner.cancel(created.queryId);
            const { continuation: _continuation, ...bounded } = result;
            result = { ...bounded, status: "partial", restartRequired: true };
          }
          return { result, pages: released };
        } finally { sessions.delete(sessionRef); unregister(); }
      });
      reads.set(request.conversationId, work);
      void work.finally(() => { if (reads.get(request.conversationId) === work) reads.delete(request.conversationId); }).catch(() => { process.stderr.write("[desk-balance-read] request failed\n"); });
      return work;
    },
  };
}
export type BalanceConnection = ReturnType<typeof createBalanceConnection>;
