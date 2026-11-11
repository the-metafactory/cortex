import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConversationHost, type ConversationHost } from "../host";
import type { AuthorityBindings, AuthorityMediator, HostContext, TrustedConnector, WriterLease } from "../authority";
import type { ConnectionRecord, PolicyInputs, PrincipalBinding, RestrictionRecord } from "../authority-records";
import { canonicalWire } from "./operations/validation";
import { syntheticWriterPlan, syntheticWriterSteps } from "./operations/writer-fixtures";
import { writerLease, type WriterBinding } from "./operations/writer-authority";
import type { OperationBridge } from "./operations/dispatch";
import type { OperationJournalStore } from "./operations/journal";
import type { OwnerSupport } from "./operations/types";
import { DomainAdapterRegistry } from "./registry";
import { ReadBindings } from "./reads/bindings";
import type { QueryFetchRequest, QueryPage } from "./reads/query-types";
import type { ReadBinding } from "./reads/types";
import type { AdapterBindings, AdapterDeclaration, ObjectReference } from "./types";
import type { DraftServiceDeps, DraftView, Lane, ModelOutput, ModelRequest, SourceItem } from "./drafting";
import type { startServer, StartServerOptions } from "../../surface/mc/server";
import { handleDeskDrafts } from "../../surface/mc/api/desk-drafts";
import { buildAllowedHostnames } from "../../surface/mc/api/mutation-guard";
import type { DeskDraftEditor } from "../../surface/mc/desk/draft-editor";
import { DESK_DRAFTS_PATH, type DraftConfirmation } from "../../surface/mc/desk/draft-editor-contract";
import type { OwnerDraftEntryOptions, OwnerDraftSession } from "../../surface/mc/desk/owner-draft-entry";


export type DraftServeOptions = Pick<StartServerOptions, "drafts">;

export interface DraftClient {
  call(method: string, path: string, body?: unknown): Promise<Response>;
  confirm(draft: Pick<DraftView["draft"], "draftId" | "revision">): Promise<DraftConfirmation>;
}

function draftClient(call: DraftClient["call"]): DraftClient {
  return {
    call,
    async confirm(draft) {
      const response = await call("POST", `${DESK_DRAFTS_PATH}/${draft.draftId}/confirm`, { revision: draft.revision });
      if (response.status !== 200) throw new Error(`Draft confirmation returned HTTP ${response.status}: ${await response.text()}`);
      const result = await response.json() as { confirmation: DraftConfirmation };
      return result.confirmation;
    },
  };
}

export type DraftEntryDeps = Omit<DraftServiceDeps, "destinations" | "bindings">;

export interface OwnerDraftBindingRig {
  readonly support: OwnerSupport;
  readonly writerBinding: WriterBinding;
  readonly connector: Pick<TrustedConnector, "writerOwner" | "support" | "dispatch" | "lookup">;
}

export interface OwnerDraftReadRig {
  readonly declaration: AdapterDeclaration;
  readonly bindings: AdapterBindings;
  readonly readBindings: readonly ReadBinding[];
  readonly query: (request: QueryFetchRequest) => Promise<QueryPage>;
  readonly destinations: () => QueryPage;
}

export interface DraftRigSetup {
  readonly host: ConversationHost;
  readonly deps: DraftEntryDeps;
  readonly options: OwnerDraftEntryOptions<OwnerDraftSession>;
}

export interface OwnerDraftTarget<Editor extends DeskDraftEditor> {
  readonly read: OwnerDraftReadRig;
  readonly destinationIds: string[];
  readonly destinationType: string;
  readonly sessionExtras: (destinations: ObjectReference[], read: OwnerDraftReadRig) => Record<string, unknown>;
  createBinding(journal: OperationJournalStore): OwnerDraftBindingRig;
  createEditor(setup: DraftRigSetup): Editor;
  serve(setup: DraftRigSetup, principal: string, serverOptions: DraftServeOptions): ReturnType<typeof startServer>;
  close(): Promise<void> | void;
}

export interface OwnerDraftSpec<Editor extends DeskDraftEditor, Extra extends object> {
  readonly adapterId: string;
  readonly capabilityId: string;
  readonly title: string;
  readonly now: number;
  readonly connectorId: string;
  readonly discussion: string;
  readonly principal: string;
  readonly openTarget: (context: { root: string; connectionId: string; ref: (objectType: string, canonicalId: string) => ObjectReference }) => OwnerDraftTarget<Editor> | Promise<OwnerDraftTarget<Editor>>;
  readonly extend: (core: OwnerDraftCore<Editor>) => Extra;
}

export interface OwnerDraftState {
  sessionEnabled: boolean; sourceAvailable: boolean; output: ModelOutput; sourceRestrictionsAvailable: boolean;
  head: string; localOnly: boolean; lanes: Lane[]; requests: ModelRequest[]; modelFails: boolean; onGenerate: undefined | (() => Promise<void>);
  items: SourceItem[];
}

export interface OwnerDraftCore<Editor extends DeskDraftEditor> extends DraftClient {
  readonly root: string;
  readonly registry: DomainAdapterRegistry;
  readonly policy: PolicyInputs;
  readonly state: OwnerDraftState;
  readonly makeInput: { conversationId: string; entryId: string; capabilityId: string; connectionId: string };
  readonly connectionId: string;
  readonly principal: PrincipalBinding;
  readonly ref: (objectType: string, canonicalId: string) => ObjectReference;
  readonly target: OwnerDraftTarget<Editor>;
  readonly host: ConversationHost;
  readonly binding: OwnerDraftBindingRig;
  readonly journal: OperationJournalStore;
  readonly authority: AuthorityMediator;
  readonly bridge: OperationBridge;
  readonly editor: Editor;
  readonly session: (conversationId: string) => Promise<OwnerDraftSession | null>;
  readonly lease: WriterLease;
  reopen(): Promise<void>;
  restrict(canonicalId: string, patch: Partial<Pick<RestrictionRecord, "status" | "egress">>): Promise<void>;
  serve(serverOptions?: DraftServeOptions): ReturnType<typeof startServer> & DraftClient;
  close(): Promise<void>;
}

export async function openOwnerDraftRig<Editor extends DeskDraftEditor, Extra extends object>(spec: OwnerDraftSpec<Editor, Extra>, fixture: { discussion?: string } = {}): Promise<OwnerDraftCore<Editor> & Extra> {
  const at = new Date(spec.now).toISOString();
  const root = await mkdtemp(join(tmpdir(), "desk-draft-rig-"));
  const openHost = async () => {
    const status = await openConversationHost({ dir: join(root, "host"), stack: "test", label: "test", expectedLabel: "test", lanes: {}, turns: request => Promise.resolve({ text: "Synthetic", session: request.session, resumed: false }), now: () => new Date(at) });
    if (status.state !== "ready") throw new Error(status.reason);
    return status.host;
  };
  let host = await openHost();
  const connectionId = randomUUID();
  const principal: PrincipalBinding = { version: 1, status: "active", principalRef: randomUUID(), principal: spec.principal, stack: "test", identityBindingRevision: "1" };
  const conversation = await host.create({ title: spec.title, policy: "cloud", links: [], origin: { kind: "web" } }, principal.principal, { entries: fixture.discussion ? [{ kind: "synthetic-discussion", data: {}, messages: [{ role: "user", text: fixture.discussion, at: spec.now }] }] : [] });
  const entryId = fixture.discussion ? (await host.entries(conversation.id, 100, undefined)).entries.find(entry => entry.role === "user")?.id : "entry-example";
  if (!entryId) throw new Error("Synthetic discussion entry missing");
  const ref = (objectType: string, canonicalId: string): ObjectReference => ({ adapterId: spec.adapterId, connectionId, objectType, canonicalId });
  const target = await spec.openTarget({ root, connectionId, ref });
  const { read } = target;
  const refs = () => target.destinationIds.map(id => ref(target.destinationType, id));
  const registry = new DomainAdapterRegistry();
  const registered = registry.register(read.declaration, read.bindings);
  if (!registered.ok) throw new Error(JSON.stringify(registered.error));
  let journal = host.lifecycleJournal(registry);
  let binding = target.createBinding(journal);
  const writer = await host.lifecycleWriters().begin(syntheticWriterPlan(binding.writerBinding), 0);
  const lease = writerLease(await host.lifecycleWriters().resume(writer.bindingKey, syntheticWriterSteps()));
  const connection: ConnectionRecord = { version: 1, status: "active", connectionId, adapterId: spec.adapterId, principalRef: principal.principalRef, connectionRevision: "1", credentialHandle: "synthetic-credential", accountScope: { resource: "synthetic-account" }, readCapabilityIds: [...read.readBindings.map(item => item.capabilityId), spec.capabilityId], writeCapabilityIds: [spec.capabilityId], readDestinations: refs(), writeDestinations: refs(), connectorId: spec.connectorId, executionBindingRef: binding.support.declarationId, registryRevision: "registry-1" };
  const policy: PolicyInputs = { version: 1, contextRevision: "1", areaId: "synthetic", conversationPolicy: "cloud", tool: {}, communication: {}, link: {}, work: {}, history: {}, registryRevision: "registry-1", executionBindingRevision: binding.support.declarationId, operationVisible: true, readsAllowed: true, writesAllowed: true, releaseAllowed: true, allowedAudiences: ["web", "discord", "model", "view"] };
  const readBindings = new ReadBindings(registry);
  for (const item of read.readBindings) {
    const installed = readBindings.register(item, connection);
    if (!installed.ok) throw new Error(installed.error.code);
  }
  const state: OwnerDraftState = { sessionEnabled: true, sourceAvailable: true, output: { fields: [] }, sourceRestrictionsAvailable: true,
    head: "1", localOnly: false, lanes: ["cloud"], requests: [], modelFails: false, onGenerate: undefined,
    items: [{ id: "turn-example", kind: "turn", revision: "1", digest: "synthetic-digest", restriction: "cloud", text: fixture.discussion ?? spec.discussion, at }],
  };
  const sinks = new Map([[canonicalWire({ kind: "web", conversationId: conversation.id }), () => Promise.resolve()]]);
  const trustedConnector = (): TrustedConnector => ({ ...binding.connector, authorizeConnection: () => Promise.resolve({ version: 1, available: true, revision: "1" }), query: request => read.query(request) });
  const connectors = new Map<string, TrustedConnector>([[connection.connectorId, trustedConnector()]]);
  const bindings: AuthorityBindings = {
    currentRevision: () => JSON.stringify({ connection, policy, sessionEnabled: state.sessionEnabled }),
    authenticate: sessionRef => Promise.resolve(sessionRef === "draft-session" && state.sessionEnabled ? { principal: principal.principal, stack: "test", conversationId: conversation.id, authenticatedSessionRef: sessionRef, transport: "web", audience: "web", expiresAt: "2026-12-01T00:00:00.000Z", maintenance: false } : null),
    policy: () => Promise.resolve(policy),
    writer: supplied => Promise.resolve(canonicalWire(supplied) === canonicalWire(lease)),
    restrictions: new Map([["draft-restriction", record => Promise.resolve(record)]]),
    connectors,
    sinks, readBindings,
  };
  let authority = host.lifecycleAuthority(registry, bindings);
  await authority.publishHostRecord({ kind: "principal", value: principal }, 0);
  await authority.publishHostRecord({ kind: "connection", value: connection }, 0);
  const restrictions: RestrictionRecord[] = [];
  for (const destination of refs()) {
    const restriction: RestrictionRecord = { version: 1, status: "active", restrictionRef: randomUUID(), source: destination, ownerRevision: "1", decisionRef: "synthetic-scope", audiences: ["web", "discord", "model", "view"], egress: "cloud", readScope: [principal.principalRef], resolverBinding: "draft-restriction", revision: "1" };
    restrictions.push(restriction);
    await authority.publishHostRecord({ kind: "restriction", value: restriction }, 0);
  }
  let bridge = host.lifecycleBridge(registry, bindings, () => binding.support);
  if (!await bridge.activate(binding.writerBinding, lease)) throw new Error("Synthetic writer not active");
  let runner = host.readQueries(registry, bindings);
  const session = async (conversationId: string): Promise<OwnerDraftSession | null> => {
    if (conversationId !== conversation.id) return null;
    const context: HostContext | null = await authority.authenticate("draft-session");
    return context ? { context, runner, sink: { kind: "web" as const, conversationId }, lease, principal: principal.principal, ...target.sessionExtras(refs(), read) } : null;
  };
  const sourceRestriction = restrictions[0];
  if (!sourceRestriction) throw new Error("Synthetic source restriction missing");
  const deps: DraftEntryDeps = { registry,
    sources: { capture: () => Promise.resolve({ boundary: { entryId, revision: state.head }, items: state.items.map(item => ({ ...item, restriction: state.localOnly ? "local" as const : item.restriction })), unavailable: 0 }), head: () => Promise.resolve(state.head) },
    policy: { revision: () => Promise.resolve("1"), readable: () => Promise.resolve(state.sourceAvailable), releasable: (_ids, lane) => Promise.resolve(state.sourceAvailable && (!state.localOnly || lane === "local")) },
    model: { lanes: () => Promise.resolve(state.lanes), generate: async request => { state.requests.push(request); await state.onGenerate?.(); if (state.modelFails) throw new Error("Synthetic model unavailable"); return { modelId: "synthetic-model", output: state.output }; } },
    now: () => new Date(at), timeZone: "Europe/Zurich",
  };
  let options: OwnerDraftEntryOptions<OwnerDraftSession> = { connectionId, audience: "cloud", authority, bridge, session, sourceRestrictions: () => Promise.resolve(state.sourceRestrictionsAvailable ? [{ ref: sourceRestriction.source, restrictionRef: sourceRestriction.restrictionRef }] : null) };
  let editor = target.createEditor({ host, deps, options });
  const servers: ReturnType<typeof startServer>[] = [];
  const core: OwnerDraftCore<Editor> = {
    root, registry, policy, state, makeInput: { conversationId: conversation.id, entryId, capabilityId: spec.capabilityId, connectionId }, connectionId, principal, ref, target, session, lease,
    get host() { return host; }, get binding() { return binding; }, get journal() { return journal; }, get authority() { return authority; }, get bridge() { return bridge; }, get editor() { return editor; },
    async reopen() {
      await bridge.settled();
      await host.close();
      host = await openHost();
      journal = host.lifecycleJournal(registry);
      binding = target.createBinding(journal);
      connectors.set(connection.connectorId, trustedConnector());
      authority = host.lifecycleAuthority(registry, bindings);
      bridge = host.lifecycleBridge(registry, bindings, () => binding.support);
      runner = host.readQueries(registry, bindings);
      options = { ...options, authority, bridge };
      editor = target.createEditor({ host, deps, options });
    },
    async restrict(canonicalId, patch) {
      const restriction = restrictions.find(item => item.source.canonicalId === canonicalId);
      if (!restriction) throw new Error("Synthetic restriction missing");
      await authority.publishHostRecord({ kind: "restriction", value: { ...restriction, ...patch, revision: "2" } }, 1);
    },
    serve(serverOptions = {}) {
      const server = target.serve({ host, deps, options }, principal.principal, serverOptions);
      servers.push(server);
      return {
        ...server,
        ...draftClient((method, path, body) => fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })),
      };
    },
    ...draftClient(async (method, path, body) => {
      const req = new Request(`http://127.0.0.1:8767${path}`, { method, headers: { host: "127.0.0.1:8767", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return handleDeskDrafts(req, new URL(req.url), { isLoopback: true, listenPort: 8767, principals: new Set(), localPrincipal: principal.principal, allowedHostnames: buildAllowedHostnames("127.0.0.1") }, () => editor);
    }),
    async close() { for (const server of servers) server.stop(true); await bridge.settled(); await host.close(); await target.close(); await rm(root, { recursive: true, force: true }); },
  };
  return Object.assign(core, spec.extend(core));
}
