import type { HostContext } from "../../../conversations/authority";
import type { ReleaseSink } from "../../../conversations/authority-records";
import type { QueryRunner } from "../../../conversations/domain-adapters/reads/query";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import { canonicalGraphRef, graphNodeRepository, workGraphReadBindings, type GraphConversationLink } from "../../../conversations/domain-adapters/work-graph/read";
import type { WorkObject, WorkPage, WorkRead, WorkReader } from "../../../conversations/tools/work-context";
import type { Policy } from "../../../conversations/types";
import { runHostQuery } from "./query-run";
import { observedAtOf, releasedObjects, type QueryRun, type ReleasedObject } from "./work-released";

export interface GraphWorkRepository {
  readonly id: string;
  readonly policy: Policy;
}
export interface GraphNodeRequest {
  readonly ref: ObjectReference;
  readonly destination: ObjectReference;
}
export interface GraphWorkQuery {
  readonly connectionId: string;
  readonly repositories: () => readonly GraphWorkRepository[];
  readonly links: () => readonly GraphConversationLink[];
  readonly run: (request: GraphNodeRequest) => Promise<QueryRun>;
}
export interface GraphWorkRunner {
  readonly connectionId: string;
  readonly repositories: () => readonly GraphWorkRepository[];
  readonly links: () => readonly GraphConversationLink[];
  readonly runner: Pick<QueryRunner, "create" | "run">;
  readonly context: HostContext;
  readonly sink: ReleaseSink;
}

export const GRAPH_SEARCH_COVERAGE_LIMIT = "Searches only the maps and nodes linked to this conversation. No list verb is bound yet, so other nodes in a ticked repository are read only by exact reference.";
export const LINKED_READ_CONCURRENCY = 5;
const NODE_READ = "work-graph.node.read";
const NODE_READ_BINDING = workGraphReadBindings.find(binding => binding.capabilityId === NODE_READ);
const reference = (connectionId: string, objectType: "repository" | "node", canonicalId: string): ObjectReference => ({ adapterId: "work-graph", connectionId, objectType, canonicalId });
const text = (value: unknown): string => typeof value === "string" ? value : "";

export function graphWorkQuery(config: GraphWorkRunner): GraphWorkQuery {
  return {
    connectionId: config.connectionId,
    repositories: config.repositories,
    links: config.links,
    run: async request => {
      if (!NODE_READ_BINDING) throw new Error("work-graph.node.read binding missing");
      return runHostQuery(config, {
        adapterId: "work-graph",
        connectionId: config.connectionId,
        capabilityId: NODE_READ,
        inputSchemaRef: NODE_READ_BINDING.inputSchemaRef,
        destinations: [request.destination],
        input: { ref: request.ref },
      });
    },
  };
}

export type Releasable = (object: WorkObject) => boolean;
const policyOf = (query: GraphWorkQuery, repository: string): Policy | null => {
  const wanted = canonicalGraphRef(repository);
  return query.repositories().find(candidate => canonicalGraphRef(candidate.id) === wanted)?.policy ?? null;
};
const toObject = (query: GraphWorkQuery, object: ReleasedObject, repository: string, at: number): WorkObject => {
  const parent = object.value.parent;
  const parentId = typeof parent === "object" && parent !== null && !Array.isArray(parent) ? text((parent as Record<string, unknown>).canonicalId) : "";
  const facts = [text(object.value.kind) && `Kind: ${text(object.value.kind)}`, parentId && `Parent: ${parentId}`].filter(Boolean);
  return {
    kind: "graph-node", id: object.ref.canonicalId, title: text(object.value.title), status: text(object.value.status), summary: facts.join("\n"),
    policy: policyOf(query, repository) ?? "local", area: canonicalGraphRef(repository), url: text(object.value.url), observedAt: observedAtOf(object, at),
  };
};

type NodeOutcome = { readonly state: "available"; readonly object: WorkObject } | { readonly state: "denied" } | { readonly state: "unavailable" };
const readNode = async (query: GraphWorkQuery, id: string): Promise<NodeOutcome> => {
  const repository = graphNodeRepository(id);
  if (repository === null) return { state: "unavailable" };
  const run = await query.run({ ref: reference(query.connectionId, "node", id), destination: reference(query.connectionId, "repository", repository) });
  if (run.result.status === "denied" || run.result.restricted) return { state: "denied" };
  const object = run.released === undefined ? undefined : releasedObjects(run.released).find(entry => entry.ref.objectType === "node" && entry.ref.canonicalId === id);
  return run.result.status === "ok" && object ? { state: "available", object: toObject(query, object, repository, Date.now()) } : { state: "unavailable" };
};

const linkedIds = (query: GraphWorkQuery): string[] => {
  const ticked = new Set(query.repositories().map(repository => canonicalGraphRef(repository.id)));
  const ids = query.links().flatMap(link => {
    const repository = graphNodeRepository(link.id);
    return repository !== null && ticked.has(canonicalGraphRef(repository)) ? [link.id] : [];
  });
  return [...new Set(ids)];
};
const matches = (object: WorkObject, needle: string): boolean => {
  const wanted = needle.trim().toLowerCase();
  return wanted === "" || [object.title, object.id, object.status, object.summary].some(field => field.toLowerCase().includes(wanted));
};

const searchLinked = async (query: GraphWorkQuery, releasable: Releasable, needle: string, limit: number, offset: number): Promise<WorkPage> => {
  const ids = linkedIds(query);
  const hits: WorkObject[] = [];
  const wanted = offset + limit + 1;
  let answered = 0;
  let missing = 0;
  let denied = 0;
  for (let start = 0; start < ids.length && hits.length < wanted; start += LINKED_READ_CONCURRENCY) {
    const outcomes = await Promise.all(ids.slice(start, start + LINKED_READ_CONCURRENCY).map(id => readNode(query, id)));
    for (const outcome of outcomes) {
      if (outcome.state === "denied") denied++;
      else if (outcome.state === "unavailable") missing++;
      else {
        answered++;
        if (releasable(outcome.object) && matches(outcome.object, needle)) hits.push(outcome.object);
      }
    }
  }
  const items = hits.slice(offset, offset + limit);
  const unanswered = ids.length > 0 && answered === 0 && missing > 0;
  const restricted = denied > 0;
  return {
    items,
    more: hits.length > offset + limit,
    noMatch: !unanswered && !restricted && hits.length === 0,
    restricted,
    status: unanswered ? "unavailable" : restricted && items.length === 0 ? "denied" : missing > 0 || restricted ? "partial" : "ok",
    ...(unanswered ? { reason: "The owning system could not answer for the linked graph nodes." } : {}),
    coverageLimit: GRAPH_SEARCH_COVERAGE_LIMIT,
  };
};

export function graphWorkReaders(query: GraphWorkQuery, releasable: Releasable = () => true): { "graph-node": WorkReader } {
  const read = async (id: string): Promise<WorkRead> => {
    const outcome = await readNode(query, id);
    return outcome.state === "available" ? outcome : { state: "unavailable", reason: outcome.state === "denied" ? "unauthorized" : "unavailable" };
  };
  return { "graph-node": { search: (needle, limit, offset) => searchLinked(query, releasable, needle, limit, offset), read } };
}
