import { randomUUID } from "node:crypto";
import { authorityRig } from "../../../authority-fixtures";
import type { RestrictionRecord } from "../../../authority-records";
import { registryFixture } from "../../operations/fixtures";
import type { QueryFetchRequest, QueryPage, QueryResult } from "../../reads/query-types";
import type { QueryRunner } from "../../reads/query";
import type { ReadBinding } from "../../reads/types";
import type { Json } from "../../operations/types";
import type { ObjectReference } from "../../types";
import { createWorkGraphReadAdapter, type GraphConversationLink, type WorkGraphReadAdapter, type WorkGraphRunner } from "../../work-graph/read";
import { installReadBindings } from "./read-binding-rig";

export const CORTEX = "github:github.com/the-metafactory/cortex";
export const CRISIS = "gitlab:gitlab.example.org/claw/crisis-simulator";
export const UNTICKED = "github:github.com/the-metafactory/other";
export const REPOSITORIES = [CORTEX, CRISIS] as const;
export const CORTEX_MAP = `${CORTEX}#3000`;
export const CORTEX_NODE = "the-metafactory/cortex#3348";
export const CLOSED_NODE = `${CORTEX}#3350`;
export const CRISIS_NODE = `${CRISIS}#12`;
export const MISSING_NODE = `${CORTEX}#9999`;

export const graphRef = (connectionId: string, objectType: "repository" | "map" | "node", canonicalId: string): ObjectReference => ({ adapterId: "work-graph", connectionId, objectType, canonicalId });

export const GRAPH_NODE_BODIES: Readonly<Record<string, unknown>> = {
  [`${CORTEX}#3348`]: { repo: CORTEX, ref: { id: "3348" }, status: "open", url: "https://github.com/the-metafactory/cortex/issues/3348", node: { title: "Read graph destinations and nodes", kind: "build" }, parent: { id: "3293" } },
  [CORTEX_MAP]: { repo: CORTEX, ref: { id: "3000" }, status: "open", url: "https://github.com/the-metafactory/cortex/issues/3000", node: { title: "Desk adapters map", kind: "map" }, parent: null },
  [`${CORTEX}#3350`]: { repo: CORTEX, ref: { id: "3350" }, status: "closed", url: "https://github.com/the-metafactory/cortex/issues/3350", node: { title: "Publish graph repository ticks", kind: "build" }, parent: { id: "3293" } },
  [`${CRISIS}#12`]: { repo: CRISIS, ref: { id: "claw/crisis-simulator#12" }, status: "open", url: "https://gitlab.example.org/claw/crisis-simulator/-/issues/12", node: { title: "Crisis simulator short", kind: "task" }, parent: null },
};

const answer = (argv: string[]): { code: number; signal: null; stdout: string; stderr: string } => {
  const target = argv[3] ?? "";
  const body = GRAPH_NODE_BODIES[target];
  if (body) return { code: 0, signal: null, stdout: JSON.stringify(body), stderr: "" };
  if (target === `${CORTEX}#9998`) return { code: 2, signal: null, stdout: "", stderr: "soma could not reach the graph owner" };
  return { code: 1, signal: null, stdout: "", stderr: `node ${target} not found` };
};

export function releasedObjects(value: Json | undefined): { ref: ObjectReference; value: Record<string, unknown> }[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("released value is not an object");
  const held = (value as { objects?: unknown }).objects;
  if (!Array.isArray(held)) throw new Error("released value has no objects");
  return held as { ref: ObjectReference; value: Record<string, unknown> }[];
}

export interface GraphReadStep {
  readonly result: QueryResult;
  readonly released: Json | undefined;
  readonly argv: string[][];
  readonly request: Awaited<ReturnType<QueryRunner["create"]>>;
}

export interface GraphReadRig {
  readonly connectionId: string;
  readonly adapter: WorkGraphReadAdapter;
  readonly runner: QueryRunner;
  readonly rig: Awaited<ReturnType<typeof authorityRig>>;
  readonly destinationsBinding: ReadBinding;
  readonly nodeReadBinding: ReadBinding;
  readonly calls: { argv: string[][] };
  destinations(): Promise<QueryPage>;
  node(canonicalId: string, destinations?: readonly ObjectReference[]): Promise<GraphReadStep>;
  allow(repository: string): Promise<void>;
  untick(repository: string): Promise<void>;
  close(): Promise<void>;
}

export async function openGraphReadRig(): Promise<GraphReadRig> {
  const calls = { argv: [] as string[][] };
  const repositories: string[] = [...REPOSITORIES];
  const links: GraphConversationLink[] = [
    { owner: "graph-map", id: CORTEX_MAP },
    { owner: "graph-node", id: CORTEX_NODE },
    { owner: "graph-node", id: CRISIS_NODE },
    { owner: "graph-node", id: `${UNTICKED}#7` },
  ];
  let connectionId = "";
  const run: WorkGraphRunner = (argv, _timeoutMs) => { calls.argv.push(argv); return Promise.resolve(answer(argv)); };
  const adapter = createWorkGraphReadAdapter({
    get connectionId() { return connectionId; },
    repositories: () => repositories,
    links: () => links,
    run,
    now: () => new Date("2026-11-10T00:00:00.000Z"),
  });
  const registry = registryFixture();
  const registered = registry.register(adapter.declaration, adapter.bindings);
  if (!registered.ok) throw new Error(registered.error.code);
  const balanceQuery = { version: "1.0.0", adapterId: "balance", capabilityId: "balance.object.read", mode: "query", objectType: "task", inputSchemaRef: { schemaId: "balance.task.create.input", version: "1.0.0" }, outputSchemaRef: { schemaId: "balance.task.create.output", version: "1.0.0" }, destinationType: "area", display: { title: "/title" } };
  const rig = await authorityRig({}, "local", { registry, binding: balanceQuery, capabilityIds: adapter.readBindings.map(binding => binding.capabilityId) });
  connectionId = rig.connection.connectionId;
  const [destinationsBinding, nodeReadBinding] = adapter.readBindings;
  if (!destinationsBinding || !nodeReadBinding) throw new Error("graph binding fixture incomplete");
  installReadBindings(registry, rig.bindings, "work-graph", connectionId, adapter.readBindings);
  const restriction = (repository: string, revision: string, status: RestrictionRecord["status"], restrictionRef: string): RestrictionRecord => ({
    version: 1, status, restrictionRef, ownerRevision: revision, decisionRef: "graph-read-fixture", revision,
    source: graphRef(connectionId, "repository", repository), audiences: ["web", "discord", "model", "view"], egress: "cloud",
    readScope: [rig.principal.principalRef], resolverBinding: "synthetic-restriction-resolver",
  });
  const restrictionRefs = new Map(repositories.map(repository => [repository, randomUUID()]));
  const connectionRevision = (revision: string, destinations: readonly string[]) => ({ ...rig.connection, adapterId: "work-graph", connectionRevision: revision, readCapabilityIds: adapter.readBindings.map(binding => binding.capabilityId), readDestinations: destinations.map(repository => graphRef(connectionId, "repository", repository)) });
  let revision = 2;
  const publishScope = async (repositoriesNow: readonly string[]): Promise<void> => {
    const value = connectionRevision(String(revision), repositoriesNow);
    Object.assign(rig.connection, value);
    await rig.service.publishHostRecord({ kind: "connection", value }, revision - 1);
    revision++;
  };
  await publishScope(repositories);
  for (const repository of repositories) {
    const record = restriction(repository, "1", "active", restrictionRefs.get(repository) ?? randomUUID());
    await rig.service.publishHostRecord({ kind: "restriction", value: record }, 0);
  }
  rig.hooks.query = (request: QueryFetchRequest) => adapter.query(request);
  const runner = rig.host.readQueries(registry, rig.bindings);
  const runStep = async (capabilityId: string, input: Json, destinations: readonly ObjectReference[], binding: ReadBinding): Promise<GraphReadStep> => {
    const previous = rig.calls.sends.length;
    const argv = calls.argv.length;
    const request = await runner.create(rig.context, [{ adapterId: "work-graph", connectionId, capabilityId, inputSchemaRef: binding.inputSchemaRef, destinations: [...destinations], input }], rig.sink);
    const result = await runner.run(rig.context, request, rig.sink);
    const released = rig.calls.sends.length > previous ? rig.calls.sends[rig.calls.sends.length - 1] : undefined;
    return { result, released, argv: calls.argv.slice(argv), request };
  };
  return {
    connectionId,
    adapter,
    runner,
    rig,
    destinationsBinding,
    nodeReadBinding,
    calls,
    async destinations() {
      const handler = adapter.bindings.handlers["work-graph.destinations"];
      if (!handler) throw new Error("graph destinations handler missing");
      return await Promise.resolve(handler({}, {})) as QueryPage;
    },
    node(canonicalId, destinations = [graphRef(connectionId, "repository", CORTEX)]) {
      return runStep("work-graph.node.read", { ref: graphRef(connectionId, "node", canonicalId) }, destinations, nodeReadBinding);
    },
    async allow(repository) {
      if (repositories.includes(repository)) return;
      repositories.push(repository);
      const restrictionRef = randomUUID();
      restrictionRefs.set(repository, restrictionRef);
      await rig.service.publishHostRecord({ kind: "restriction", value: restriction(repository, "1", "active", restrictionRef) }, 0);
      await publishScope(repositories);
    },
    async untick(repository) {
      const restrictionRef = restrictionRefs.get(repository);
      if (!restrictionRef) throw new Error("graph repository fixture missing");
      await rig.service.publishHostRecord({ kind: "restriction", value: restriction(repository, "2", "revoked", restrictionRef) }, 1);
      const remaining = repositories.filter(candidate => candidate !== repository);
      repositories.splice(0, repositories.length, ...remaining);
      await publishScope(remaining);
    },
    async close() {
      await rig.close();
    },
  };
}

export function trackGraphRigs(): { open: () => Promise<GraphReadRig>; closeAll: () => Promise<void> } {
  const opened: GraphReadRig[] = [];
  return {
    open: async () => { const rig = await openGraphReadRig(); opened.push(rig); return rig; },
    closeAll: async () => { await Promise.all(opened.splice(0).map(rig => rig.close())); },
  };
}
