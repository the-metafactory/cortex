import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AuthorityBindings, AuthorityMediator, HostContext, TrustedConnector, WriterLease } from "../../../src/conversations/authority";
import { authorityHash, type ConnectionRecord, type PolicyInputs, type PrincipalBinding, type ReleaseSink, type RestrictionRecord } from "../../../src/conversations/authority-records";
import { openConversationHost, type ConversationHost } from "../../../src/conversations/host";
import { writerLease } from "../../../src/conversations/domain-adapters/operations/writer-authority";
import { syntheticWriterPlan, syntheticWriterSteps } from "../../../src/conversations/domain-adapters/operations/writer-fixtures";
import { canonicalWire } from "../../../src/conversations/domain-adapters/operations/validation";
import type { Json } from "../../../src/conversations/domain-adapters/operations/types";
import { ReadBindings } from "../../../src/conversations/domain-adapters/reads/bindings";
import type { DomainAdapterRegistry } from "../../../src/conversations/domain-adapters/registry";
import type { ObjectReference } from "../../../src/conversations/domain-adapters/types";

export const SYNTHETIC_CREDENTIAL_HANDLE = "conformance-credential-handle";
const SESSION = "conformance-session";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
export const STACK = "conformance";

export class ConformanceRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ConformanceRefusal";
  }
}

export interface ConformanceRigInput {
  dir: string;
  registry: DomainAdapterRegistry;
  connector: TrustedConnector;
  adapterId: string;
  connectionId: string;
  readBindings: readonly unknown[];
  readCapabilityIds: readonly string[];
  writeCapabilityIds: readonly string[];
  writerCapabilityId: string;
  destinations: readonly ObjectReference[];
}

function registerReadBindings(input: ConformanceRigInput): ReadBindings {
  const bindings = new ReadBindings(input.registry);
  for (const raw of input.readBindings) {
    const registered = bindings.register(raw, { adapterId: input.adapterId, connectionId: input.connectionId, readCapabilityIds: input.readCapabilityIds });
    if (!registered.ok) throw new ConformanceRefusal(registered.error.code, registered.error.message);
  }
  return bindings;
}

/** Opens the production host over a synthetic local stack, and can reopen it over the same store to model a restart. */
export async function openConformanceRig(input: ConformanceRigInput) {
  const dir = await mkdtemp(join(input.dir, "rig-"));
  const readBindings = registerReadBindings(input);
  const principal: PrincipalBinding = { version: 1, principalRef: randomUUID(), principal: "conformance-principal", stack: STACK, identityBindingRevision: "1", status: "active" };
  const connection: ConnectionRecord = {
    version: 1, status: "active", connectionId: input.connectionId, adapterId: input.adapterId, principalRef: principal.principalRef, connectionRevision: "1",
    credentialHandle: SYNTHETIC_CREDENTIAL_HANDLE, accountScope: { account: "conformance-account", resource: "conformance-resource" },
    readCapabilityIds: [...input.readCapabilityIds], writeCapabilityIds: [...input.writeCapabilityIds], readDestinations: [...input.destinations], writeDestinations: [...input.destinations],
    connectorId: "conformance-connector", executionBindingRef: input.connector.support.declarationId, registryRevision: "registry-1",
  };
  const policy: PolicyInputs = {
    version: 1, contextRevision: "context-1", areaId: "conformance-area", conversationPolicy: "local", tool: {}, communication: {}, link: {}, work: {}, history: {},
    registryRevision: "registry-1", executionBindingRevision: input.connector.support.declarationId, operationVisible: true, readsAllowed: true, writesAllowed: true, releaseAllowed: true,
    allowedAudiences: ["web", "discord", "model", "view"],
  };
  const restrictions: RestrictionRecord[] = input.destinations.map(source => ({
    version: 1, status: "active", restrictionRef: randomUUID(), source, ownerRevision: "conformance-owner-1", decisionRef: "conformance-provenance", audiences: ["web", "discord", "model", "view"],
    egress: "cloud", readScope: [principal.principalRef], resolverBinding: "conformance-restriction-resolver", revision: "1",
  }));
  const lease: WriterLease = { bindingKey: "conformance-binding", epoch: 1, instanceId: "conformance-instance", supervisorReceiptRef: "conformance-supervisor" };
  const sends: Json[] = [];
  const sinks = new Map<string, (value: Json) => Promise<void>>();
  let conversationId = "";
  let sink: ReleaseSink = { kind: "web", conversationId };
  const bindings: AuthorityBindings = {
    currentRevision: () => authorityHash({ policy, lease }),
    authenticate: sessionRef => Promise.resolve(sessionRef === SESSION ? { principal: principal.principal, stack: principal.stack, conversationId, authenticatedSessionRef: sessionRef, transport: "web", audience: "web", expiresAt: FAR_FUTURE, maintenance: false } : null),
    policy: () => Promise.resolve(structuredClone(policy)),
    writer: checked => Promise.resolve(canonicalWire(checked) === canonicalWire(lease)),
    restrictions: new Map([["conformance-restriction-resolver", record => Promise.resolve(record)]]),
    connectors: new Map([[connection.connectorId, input.connector]]),
    sinks,
    readBindings,
  };
  const plan = syntheticWriterPlan({ stack: STACK, owner: input.connector.writerOwner, adapterId: input.adapterId, connectionId: input.connectionId, capabilityId: input.writerCapabilityId });
  const opened: { host: ConversationHost | null; service: AuthorityMediator | null; context: HostContext | null } = { host: null, service: null, context: null };
  const host = (): ConversationHost => { if (!opened.host) throw new ConformanceRefusal("host_unavailable", "The conformance host is closed."); return opened.host; };
  const service = () => { if (!opened.service) throw new ConformanceRefusal("host_unavailable", "The conformance authority is unavailable."); return opened.service; };
  const context = () => { if (!opened.context) throw new ConformanceRefusal("host_unavailable", "The conformance session is unavailable."); return opened.context; };
  async function boot(initial: boolean): Promise<void> {
    const status = await openConversationHost({ dir, stack: STACK, label: STACK, expectedLabel: STACK, lanes: {}, turns: request => Promise.resolve({ text: "conformance", session: request.session, resumed: false }), now: () => new Date() });
    if (status.state !== "ready") throw new ConformanceRefusal("host_unavailable", status.reason);
    opened.host = status.host;
    if (initial) {
      const conversation = await status.host.create({ title: "Conformance", policy: "local", links: [], origin: { kind: "web" } }, principal.principal);
      conversationId = conversation.id;
      sink = { kind: "web", conversationId };
      sinks.set(canonicalWire(sink), value => { sends.push(value); return Promise.resolve(); });
    }
    const writer = await status.host.lifecycleWriters().begin(plan, 0);
    Object.assign(lease, writerLease(await status.host.lifecycleWriters().resume(writer.bindingKey, syntheticWriterSteps())));
    opened.service = status.host.lifecycleAuthority(input.registry, bindings);
    if (initial) {
      await opened.service.publishHostRecord({ kind: "principal", value: principal }, 0);
      await opened.service.publishHostRecord({ kind: "connection", value: connection }, 0);
      for (const restriction of restrictions) await opened.service.publishHostRecord({ kind: "restriction", value: restriction }, 0);
    }
    opened.context = await opened.service.authenticate(SESSION);
    if (!opened.context) throw new ConformanceRefusal("host_unavailable", "The host refused the synthetic session.");
  }
  await boot(true);
  return {
    get host() { return host(); },
    get service() { return service(); },
    get context() { return context(); },
    get sink() { return sink; },
    get conversationId() { return conversationId; },
    lease, sends, bindings, connection, registry: input.registry,
    async revokeConnection(): Promise<void> {
      const revision = Number(connection.connectionRevision);
      connection.connectionRevision = String(revision + 1);
      connection.status = "revoked";
      await service().publishHostRecord({ kind: "connection", value: connection }, revision);
    },
    async reopen(): Promise<void> {
      await host().close();
      opened.host = null;
      opened.service = null;
      opened.context = null;
      await boot(false);
    },
    async close() {
      await opened.host?.close();
      opened.host = null;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export type ConformanceRig = Awaited<ReturnType<typeof openConformanceRig>>;
