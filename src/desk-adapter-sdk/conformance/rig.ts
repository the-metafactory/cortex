import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AuthorityBindings, AuthorityMediator, HostContext, TrustedConnector, WriterLease } from "../../conversations/authority";
import { authorityHash, type ConnectionRecord, type PolicyInputs, type PrincipalBinding, type ReleaseSink, type RestrictionRecord } from "../../conversations/authority-records";
import { openConversationHost, type ConversationHost } from "../../conversations/host";
import { writerLease } from "../../conversations/domain-adapters/operations/writer-authority";
import { syntheticWriterPlan, syntheticWriterSteps } from "../../conversations/domain-adapters/operations/writer-fixtures";
import { canonicalWire } from "../../conversations/domain-adapters/operations/validation";
import type { Json } from "../../conversations/domain-adapters/operations/types";
import { mailReadRestriction, type MailConnectionBinding } from "../../conversations/domain-adapters/mail-read";
import { ReadBindings } from "../../conversations/domain-adapters/reads/bindings";
import type { DomainAdapterRegistry } from "../../conversations/domain-adapters/registry";
import type { ObjectReference } from "../../conversations/domain-adapters/types";

export const SYNTHETIC_CREDENTIAL_HANDLE = "conformance-credential-handle";
const SESSION = "conformance-session";
const CLOUD_SESSION = "conformance-cloud-session";
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
  mailBinding?: MailConnectionBinding;
}

function registerReadBindings(input: ConformanceRigInput): ReadBindings {
  const bindings = new ReadBindings(input.registry);
  for (const raw of input.readBindings) {
    const registered = bindings.register(raw, { adapterId: input.adapterId, connectionId: input.connectionId, readCapabilityIds: input.readCapabilityIds });
    if (!registered.ok) throw new ConformanceRefusal(registered.error.code, registered.error.message);
  }
  return bindings;
}

/** Opens the production Cortex runtime over a synthetic local stack, and can reopen it over the same store to model a restart. */
export async function openConformanceRig(input: ConformanceRigInput): Promise<ConformanceRig> {
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
  const restrictions: RestrictionRecord[] = input.destinations.map(source => {
    const metadata: Omit<RestrictionRecord, "source" | "egress"> = {
      version: 1, status: "active", restrictionRef: randomUUID(), ownerRevision: "conformance-owner-1", decisionRef: "conformance-provenance", audiences: ["web", "discord", "model", "view"],
      readScope: [principal.principalRef], resolverBinding: "conformance-restriction-resolver", revision: "1",
    };
    return input.mailBinding ? mailReadRestriction(input.mailBinding, source, metadata) : { ...metadata, source, egress: "cloud" };
  });
  const lease: WriterLease = { bindingKey: "conformance-binding", epoch: 1, instanceId: "conformance-instance", supervisorReceiptRef: "conformance-supervisor" };
  const sends: Json[] = [];
  const sinks = new Map<string, (value: Json) => Promise<void>>();
  let conversationId = "";
  let sink: ReleaseSink = { kind: "web", conversationId };
  const cloud: { conversationId: string; sink: ReleaseSink; sends: Json[]; context: HostContext | null } = { conversationId: "", sink: { kind: "web", conversationId: "" }, sends: [], context: null };
  const sessionOf = (sessionRef: string): string | null => (sessionRef === SESSION ? conversationId : sessionRef === CLOUD_SESSION && cloud.conversationId !== "" ? cloud.conversationId : null);
  const bindings: AuthorityBindings = {
    currentRevision: () => authorityHash({ policy, lease }),
    authenticate: sessionRef => {
      const conversation = sessionOf(sessionRef);
      return Promise.resolve(conversation === null ? null : { principal: principal.principal, stack: principal.stack, conversationId: conversation, authenticatedSessionRef: sessionRef, transport: "web", audience: "web", expiresAt: FAR_FUTURE, maintenance: false });
    },
    policy: binding => Promise.resolve({ ...structuredClone(policy), conversationPolicy: cloud.conversationId !== "" && binding.conversationId === cloud.conversationId ? "cloud" : "local" }),
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
      if (input.mailBinding) {
        const reader = await status.host.create({ title: "Conformance cloud reader", policy: "cloud", links: [], origin: { kind: "web" } }, principal.principal);
        cloud.conversationId = reader.id;
        cloud.sink = { kind: "web", conversationId: reader.id };
        sinks.set(canonicalWire(cloud.sink), value => { cloud.sends.push(value); return Promise.resolve(); });
      }
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
    cloud.context = cloud.conversationId === "" ? null : await opened.service.authenticate(CLOUD_SESSION);
    if (cloud.conversationId !== "" && !cloud.context) throw new ConformanceRefusal("host_unavailable", "The host refused the synthetic cloud session.");
  }
  await boot(true);
  return {
    get host() { return host(); },
    get service() { return service(); },
    get context() { return context(); },
    get sink() { return sink; },
    get conversationId() { return conversationId; },
    get cloudReader() { return cloud.context ? { context: cloud.context, sink: cloud.sink, sends: cloud.sends } : null; },
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

/** A reader in a cloud-policy conversation. The rig opens one only for a run with a Mail binding. */
export interface CloudReader {
  context: HostContext;
  sink: ReleaseSink;
  sends: Json[];
}

export interface ConformanceRig {
  readonly host: ConversationHost;
  readonly service: AuthorityMediator;
  readonly context: HostContext;
  readonly sink: ReleaseSink;
  readonly conversationId: string;
  readonly cloudReader: CloudReader | null;
  lease: WriterLease;
  sends: Json[];
  bindings: AuthorityBindings;
  connection: ConnectionRecord;
  registry: DomainAdapterRegistry;
  revokeConnection(): Promise<void>;
  reopen(): Promise<void>;
  close(): Promise<void>;
}
