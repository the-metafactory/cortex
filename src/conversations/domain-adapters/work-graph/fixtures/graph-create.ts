import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConversationHost } from "../../../host";
import type { AuthorityBindings, TrustedConnector } from "../../../authority";
import { canonicalWire } from "../../operations/validation";
import { syntheticWriterPlan, syntheticWriterSteps } from "../../operations/writer-fixtures";
import { writerLease } from "../../operations/writer-authority";
import { DomainAdapterRegistry } from "../../registry";
import { ReadBindings } from "../../reads/bindings";
import type { ModelOutput, ModelRequest, Lane, SourceItem } from "../../drafting";
import { createWorkGraphReadAdapter } from "../../work-graph/read";
import { createWorkGraphNodeBinding } from "../../work-graph/node-binding";
import type { ObjectReference } from "../../types";
import type { ConnectionRecord, PolicyInputs, PrincipalBinding, RestrictionRecord } from "../../../authority-records";
import { initDatabase } from "../../../../surface/mc/db/init";
import { setGraphRepositoryEnabled } from "../../../../surface/mc/desk/graph-repositories";
import { DEFAULT_CONFIG } from "../../../../surface/mc/config";
import { startServer } from "../../../../surface/mc/server";
import { deskGraphDraftEditor, type GraphDraftSetup } from "../../../../surface/mc/desk/graph-draft-entry";
import { graphDraftDestinations } from "../../../../surface/mc/desk/graph-draft-destinations";
import { handleDeskDrafts } from "../../../../surface/mc/api/desk-drafts";
import { buildAllowedHostnames } from "../../../../surface/mc/api/mutation-guard";
import { GRAPH_NODE_REPOSITORY, GRAPH_NODE_NOW, syntheticSoma } from "./synthetic-soma";

export const CREATE_REPOSITORY = GRAPH_NODE_REPOSITORY;
export const CREATE_OTHER_REPOSITORY = "github:github.com/other/desk";
export const CREATE_PARENT = "example/desk#12";
export const CREATE_MAP = `${CREATE_REPOSITORY}#10`;
const AT = new Date(GRAPH_NODE_NOW).toISOString();
const CAPABILITY = "work-graph.node.create";
export const GRAPH_DRAFT_DISCUSSION = "The importer can lose acceptance receipts on restart. Compare persisted receipts with canonical lookup, document crash cases and propose a regression test. File a research node under the lifecycle map; use checkpoint receipt-restart-evidence. Keep unknown dependencies absent and do not activate a writer.";

export async function openGraphCreateRig(fixture: { discussion?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "desk-graph-create-"));
  const db = initDatabase(join(root, "desk.sqlite"));
  const openHost = async () => {
    const status = await openConversationHost({ dir: join(root, "host"), stack: "test", label: "test", expectedLabel: "test", lanes: {}, turns: request => Promise.resolve({ text: "Synthetic", session: request.session, resumed: false }), now: () => new Date(AT) });
    if (status.state !== "ready") throw new Error(status.reason);
    return status.host;
  };
  let host = await openHost();
  const connectionId = randomUUID();
  const principal: PrincipalBinding = { version: 1, status: "active", principalRef: randomUUID(), principal: "local", stack: "test", identityBindingRevision: "1" };
  const conversation = await host.create({ title: "Graph creation", policy: "cloud", links: [], origin: { kind: "web" } }, principal.principal, { entries: fixture.discussion ? [{ kind: "synthetic-discussion", data: {}, messages: [{ role: "user", text: fixture.discussion, at: GRAPH_NODE_NOW }] }] : [] });
  const entryId = fixture.discussion ? (await host.entries(conversation.id, 100, undefined)).entries.find(entry => entry.role === "user")?.id : "entry-example";
  if (!entryId) throw new Error("Synthetic discussion entry missing");
  const repositories = [CREATE_REPOSITORY, CREATE_OTHER_REPOSITORY];
  const ref = (objectType: string, canonicalId: string): ObjectReference => ({ adapterId: "work-graph", connectionId, objectType, canonicalId });
  const refs = () => repositories.map(repository => ref("repository", repository));
  for (const repository of repositories) setGraphRepositoryEnabled(db, repository, true, GRAPH_NODE_NOW);
  const soma = syntheticSoma();
  const reads: string[][] = [];
  const read = createWorkGraphReadAdapter({ connectionId, repositories: () => repositories, links: () => [{ owner: "graph-map", id: CREATE_MAP, title: "Lifecycle map" }, { owner: "graph-node", id: CREATE_PARENT, title: "Shared title" }, { owner: "graph-node", id: `${CREATE_OTHER_REPOSITORY}#13`, title: "Shared title" }], now: () => new Date(AT), run: argv => {
    reads.push(argv);
    const target = argv[3];
    const data = target === `${CREATE_REPOSITORY}#10` ? { repository: CREATE_REPOSITORY, id: "10", title: "Lifecycle map" } : target === `${CREATE_REPOSITORY}#12` ? { repository: CREATE_REPOSITORY, id: "12", title: "Shared title" } : target === `${CREATE_OTHER_REPOSITORY}#13` ? { repository: CREATE_OTHER_REPOSITORY, id: "13", title: "Shared title" } : target === `${CREATE_REPOSITORY}#14` ? { repository: CREATE_REPOSITORY, id: "14", title: "Exact unlinked node" } : null;
    return Promise.resolve(data ? { code: 0, signal: null, stderr: "", stdout: JSON.stringify({ repo: data.repository, ref: { id: data.id }, status: "open", node: { title: data.title }, parent: null }) } : { code: 1, signal: null, stderr: "not found", stdout: "" });
  } });
  const registry = new DomainAdapterRegistry();
  const registered = registry.register(read.declaration, read.bindings);
  if (!registered.ok) throw new Error(JSON.stringify(registered.error));
  let journal = host.lifecycleJournal(registry);
  const createBinding = () => createWorkGraphNodeBinding({ stack: "test", connectionId, db, desk: () => ({ enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], somaBin: "/synthetic/soma" }), journal, run: soma.run, now: () => GRAPH_NODE_NOW });
  let binding = createBinding();
  const writer = await host.lifecycleWriters().begin(syntheticWriterPlan(binding.writerBinding), 0);
  const lease = writerLease(await host.lifecycleWriters().resume(writer.bindingKey, syntheticWriterSteps()));
  const connection: ConnectionRecord = { version: 1, status: "active", connectionId, adapterId: "work-graph", principalRef: principal.principalRef, connectionRevision: "1", credentialHandle: "synthetic-credential", accountScope: { resource: "synthetic-graph" }, readCapabilityIds: [...read.readBindings.map(item => item.capabilityId), CAPABILITY], writeCapabilityIds: [CAPABILITY], readDestinations: refs(), writeDestinations: refs(), connectorId: "synthetic-graph", executionBindingRef: binding.support.declarationId, registryRevision: "registry-1" };
  const policy: PolicyInputs = { version: 1, contextRevision: "1", areaId: "graph", conversationPolicy: "cloud", tool: {}, communication: {}, link: {}, work: {}, history: {}, registryRevision: "registry-1", executionBindingRevision: binding.support.declarationId, operationVisible: true, readsAllowed: true, writesAllowed: true, releaseAllowed: true, allowedAudiences: ["web", "discord", "model", "view"] };
  const readBindings = new ReadBindings(registry);
  for (const item of read.readBindings) {
    const installed = readBindings.register(item, connection);
    if (!installed.ok) throw new Error(installed.error.code);
  }
  const state = { sessionEnabled: true, sourceAvailable: true, output: { fields: [] } as ModelOutput, sourceRestrictionsAvailable: true,
    head: "1", localOnly: false, lanes: ["cloud"] as Lane[], requests: [] as ModelRequest[], modelFails: false, onGenerate: undefined as undefined | (() => Promise<void>),
    items: [{ id: "turn-example", kind: "turn", revision: "1", digest: "synthetic-digest", restriction: "cloud", text: fixture.discussion ?? GRAPH_DRAFT_DISCUSSION, at: AT }] as SourceItem[],
  };
  const sinks = new Map([[canonicalWire({ kind: "web", conversationId: conversation.id }), () => Promise.resolve()]]);
  const connectors = new Map<string, TrustedConnector>([[connection.connectorId, { ...binding.connector, authorizeConnection: () => Promise.resolve({ version: 1, available: true, revision: "1" }), query: request => read.query(request) }]]);
  const bindings: AuthorityBindings = {
    currentRevision: () => JSON.stringify({ connection, policy, sessionEnabled: state.sessionEnabled }),
    authenticate: sessionRef => Promise.resolve(sessionRef === "graph-session" && state.sessionEnabled ? { principal: principal.principal, stack: "test", conversationId: conversation.id, authenticatedSessionRef: sessionRef, transport: "web", audience: "web", expiresAt: "2026-12-01T00:00:00.000Z", maintenance: false } : null),
    policy: () => Promise.resolve(policy),
    writer: supplied => Promise.resolve(canonicalWire(supplied) === canonicalWire(lease)),
    restrictions: new Map([["graph-restriction", record => Promise.resolve(record)]]),
    connectors,
    sinks, readBindings,
  };
  let authority = host.lifecycleAuthority(registry, bindings);
  await authority.publishHostRecord({ kind: "principal", value: principal }, 0);
  await authority.publishHostRecord({ kind: "connection", value: connection }, 0);
  const restrictions: RestrictionRecord[] = [];
  for (const repository of repositories) {
    const restriction: RestrictionRecord = { version: 1, status: "active", restrictionRef: randomUUID(), source: ref("repository", repository), ownerRevision: "1", decisionRef: "synthetic-scope", audiences: ["web", "discord", "model", "view"], egress: "cloud", readScope: [principal.principalRef], resolverBinding: "graph-restriction", revision: "1" };
    restrictions.push(restriction);
    await authority.publishHostRecord({ kind: "restriction", value: restriction }, 0);
  }
  let bridge = host.lifecycleBridge(registry, bindings, () => binding.support);
  if (!await bridge.activate(binding.writerBinding, lease)) throw new Error("Synthetic graph writer not active");
  let runner = host.readQueries(registry, bindings);
  const session = async (conversationId: string) => {
    if (conversationId !== conversation.id) return null;
    const context = await authority.authenticate("graph-session");
    return context ? { context, runner, sink: { kind: "web" as const, conversationId }, repositories: refs(), destinations: read.destinations, lease, principal: principal.principal } : null;
  };
  const sourceRestriction = restrictions[0];
  if (!sourceRestriction) throw new Error("Synthetic source restriction missing");
  const deps: GraphDraftSetup["deps"] = { registry,
    sources: { capture: () => Promise.resolve({ boundary: { entryId, revision: state.head }, items: state.items.map(item => ({ ...item, restriction: state.localOnly ? "local" as const : item.restriction })), unavailable: 0 }), head: () => Promise.resolve(state.head) },
    policy: { revision: () => Promise.resolve("1"), readable: () => Promise.resolve(state.sourceAvailable), releasable: (_ids, lane) => Promise.resolve(state.sourceAvailable && (!state.localOnly || lane === "local")) },
    model: { lanes: () => Promise.resolve(state.lanes), generate: async request => { state.requests.push(request); await state.onGenerate?.(); if (state.modelFails) throw new Error("Synthetic model unavailable"); return { modelId: "synthetic-model", output: state.output }; } },
    now: () => new Date(AT),
  };
  let options: GraphDraftSetup["options"] = { connectionId, audience: "cloud", authority, bridge, session, sourceRestrictions: () => Promise.resolve(state.sourceRestrictionsAvailable ? [{ ref: ref("repository", CREATE_REPOSITORY), restrictionRef: sourceRestriction.restrictionRef }] : null) };
  let editor = deskGraphDraftEditor(host, deps, options);
  const destinations = graphDraftDestinations({ connectionId, session, authority });
  const servers: ReturnType<typeof startServer>[] = [];
  const makeInput = { conversationId: conversation.id, entryId, capabilityId: CAPABILITY, connectionId };
  const restrictRepository = async (repository: string, patch: Partial<Pick<RestrictionRecord, "status" | "egress">>) => {
    const restriction = restrictions.find(item => item.source.canonicalId === repository);
    if (!restriction) throw new Error("Synthetic restriction missing");
    await authority.publishHostRecord({ kind: "restriction", value: { ...restriction, ...patch, revision: "2" } }, 1);
  };
  return {
    root, db, registry, read, policy, state, soma, reads, destinations, makeInput, connectionId, principal, ref,
    get host() { return host; }, get binding() { return binding; }, get journal() { return journal; }, get authority() { return authority; }, get bridge() { return bridge; }, get editor() { return editor; },
    async reopen() {
      await bridge.settled();
      await host.close();
      host = await openHost();
      journal = host.lifecycleJournal(registry);
      binding = createBinding();
      connectors.set(connection.connectorId, { ...binding.connector, authorizeConnection: () => Promise.resolve({ version: 1, available: true, revision: "1" }), query: request => read.query(request) });
      authority = host.lifecycleAuthority(registry, bindings);
      bridge = host.lifecycleBridge(registry, bindings, () => binding.support);
      runner = host.readQueries(registry, bindings);
      options = { ...options, authority, bridge };
      editor = deskGraphDraftEditor(host, deps, options);
    },
    resolve: (label: string, objectType = "node") => destinations.resolve({ capabilityId: "work-graph.destinations", connectionId, conversationId: conversation.id, objectType, label }),
    localRepository: (repository: string) => restrictRepository(repository, { egress: "local" }),
    async untick(repository: string) {
      const index = repositories.indexOf(repository);
      if (index < 0) throw new Error("Synthetic repository missing");
      await restrictRepository(repository, { status: "revoked" });
      repositories.splice(index, 1);
      setGraphRepositoryEnabled(db, repository, false, GRAPH_NODE_NOW);
    },
    serve() {
      const server = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { ...DEFAULT_CONFIG.governance, principals: [], localPrincipal: principal.principal } }, db, { graphDrafts: { host, deps, options } });
      servers.push(server);
      return {
        ...server,
        call: (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      };
    },
    async call(method: string, path: string, body?: unknown) {
      const req = new Request(`http://127.0.0.1:8767${path}`, { method, headers: { host: "127.0.0.1:8767", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return handleDeskDrafts(req, new URL(req.url), { isLoopback: true, listenPort: 8767, principals: new Set(), localPrincipal: principal.principal, allowedHostnames: buildAllowedHostnames("127.0.0.1") }, () => editor);
    },
    async close() { for (const server of servers) server.stop(true); await bridge.settled(); await host.close(); db.close(); await rm(root, { recursive: true, force: true }); },
  };
}

export const graphCreateOutput = (parent = "Lifecycle map"): ModelOutput => ({ fields: [
  { pointer: "/repository", labels: [CREATE_REPOSITORY], citations: ["turn-example"] },
  { pointer: "/parent", labels: [parent], citations: ["turn-example"] },
  { pointer: "/title", value: "Verify graph creation", citations: ["turn-example"] },
  { pointer: "/checkpoint", value: "graph-create-probe", citations: ["turn-example"] },
] });

export const graphDiscussionOutput = (includeAcceptanceCrash = false): ModelOutput => ({ fields: [
  ...graphCreateOutput().fields.filter(field => field.pointer !== "/title" && field.pointer !== "/checkpoint"),
  { pointer: "/title", value: "Investigate receipt preservation across restart", citations: ["turn-example"] },
  { pointer: "/body", value: `Problem: the importer can lose acceptance receipts on restart. Intended result: compare persisted receipts with canonical lookup, document crash cases and propose a regression test. Evidence: the discussion reports receipt loss; the crash cases still need investigation. Constraints: retain canonical operation identity, leave unknown dependencies absent and keep writer activation gated.${includeAcceptanceCrash ? " Include a crash immediately after acceptance." : ""}`, citations: ["turn-example", ...(includeAcceptanceCrash ? ["outcome-example"] : [])] },
  { pointer: "/checkpoint", value: "receipt-restart-evidence", citations: ["turn-example"] },
  { pointer: "/kind", value: "research", citations: ["turn-example"] },
] });
