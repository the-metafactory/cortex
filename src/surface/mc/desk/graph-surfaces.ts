// glossary-ignore: host, owner
import type { Json } from "../../../conversations/domain-adapters/operations/types";
import { readPointer } from "../../../conversations/domain-adapters/reads/query-validation";
import type { QueryPage } from "../../../conversations/domain-adapters/reads/query-types";
import type { ReadBinding } from "../../../conversations/domain-adapters/reads/types";
import type { ObjectReference, SchemaRef } from "../../../conversations/domain-adapters/types";
import { canonicalGraphRef } from "../../../common/graph-ref";
import { graphNodeRepository } from "../../../conversations/domain-adapters/work-graph/read";
import { runHostQuery, type HostQueryRun, type HostQueryRunner } from "./query-run";
import type { GraphSurfaceCard, GraphSurfaceDestinations, GraphSurfaceFacts } from "./graph-surface-schema";

const WORK_GRAPH = "work-graph";
const READ_FAILED_IS_UNAVAILABLE: GraphSurfaceCard = { enabled: true, state: "unavailable" };
const NODE_READ = "work-graph.node.read";

export interface GraphSurfaceSource {
  readonly connectionId: string;
  readonly enabled: () => boolean;
  readonly destinations: () => QueryPage | Promise<QueryPage>;
  readonly readNode: (request: { input: Json; destinations: readonly ObjectReference[] }) => Promise<HostQueryRun>;
  readonly display: ReadBinding["display"];
}
export type GraphSurfaceAccess = () => GraphSurfaceReader | null;

export interface GraphSurfaceReader {
  destinations(): Promise<GraphSurfaceDestinations>;
  node(ref: string, repository?: string): Promise<GraphSurfaceCard>;
}
export interface GraphSurfaceRunner extends HostQueryRunner {
  readonly connectionId: string;
  readonly inputSchemaRef: SchemaRef;
}

export function graphSurfaceRun(config: GraphSurfaceRunner): GraphSurfaceSource["readNode"] {
  return request => runHostQuery(config, {
    adapterId: WORK_GRAPH,
    connectionId: config.connectionId,
    capabilityId: NODE_READ,
    inputSchemaRef: config.inputSchemaRef,
    destinations: [...request.destinations],
    input: request.input,
  });
}

interface Released { ref: ObjectReference; value: Json }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function releasedObjects(released: Json | undefined): Released[] {
  const held = isRecord(released) ? released.objects : undefined;
  if (!Array.isArray(held)) return [];
  return held.flatMap(entry => isRecord(entry) && isRecord(entry.ref) && entry.value !== undefined ? [{ ref: entry.ref as unknown as ObjectReference, value: entry.value }] : []);
}

const text = (value: Json | undefined): string | null => typeof value === "string" ? value : null;

function pointed(value: Json, pointer: string | undefined): string | null {
  return pointer === undefined ? null : text(readPointer(value, pointer));
}

function factsOf(value: Json, display: ReadBinding["display"]): GraphSurfaceFacts | null {
  const title = pointed(value, display.title);
  return title === null || title.length === 0 ? null : { title, status: pointed(value, display.status), kind: pointed(value, display.kind), url: pointed(value, display.url) };
}

function pageEntries(page: QueryPage): { ref: ObjectReference; title: string; destination: ObjectReference }[] {
  const items = isRecord(page.payload) && Array.isArray(page.payload.items) ? page.payload.items : [];
  return page.annotations.flatMap((annotation, index) => {
    const item = items[index];
    const title = isRecord(item) && typeof item.title === "string" ? item.title : annotation.ref.canonicalId;
    return [{ ref: annotation.ref, title, destination: annotation.destination }];
  });
}

export function createGraphSurfaceReader(source: GraphSurfaceSource): GraphSurfaceReader {
  const listed = async (): Promise<GraphSurfaceDestinations & { enabled: true }> => {
    const entries = pageEntries(await source.destinations());
    return {
      enabled: true,
      repositories: entries.filter(entry => entry.ref.objectType === "repository").map(entry => ({ ref: entry.ref.canonicalId, label: entry.title })),
      parents: entries.flatMap(entry => entry.ref.objectType === "map" || entry.ref.objectType === "node" ? [{ ref: entry.ref.canonicalId, label: entry.title, kind: entry.ref.objectType, repository: entry.destination.canonicalId }] : []),
    };
  };
  const read = async (ref: string, repository: string | undefined): Promise<GraphSurfaceCard & { enabled: true }> => {
    const text = ref.trim();
    const owning = graphNodeRepository(text) ?? (repository ? repository.trim() : null);
    if (owning === null) return { enabled: true, state: "unavailable" };
    const wanted = canonicalGraphRef(owning);
    const ticked = (await listed()).repositories.find(candidate => canonicalGraphRef(candidate.ref) === wanted);
    if (!ticked) return { enabled: true, state: "withheld" };
    const run = await source.readNode({
      input: { ref: { adapterId: WORK_GRAPH, connectionId: source.connectionId, objectType: "node", canonicalId: text } },
      destinations: [{ adapterId: WORK_GRAPH, connectionId: source.connectionId, objectType: "repository", canonicalId: ticked.ref }],
    });
    if (run.result.status === "denied" || run.result.restricted) return { enabled: true, state: "withheld" };
    const object = run.result.status === "ok" ? releasedObjects(run.released).find(entry => entry.ref.objectType === "node" && entry.ref.canonicalId === text) : undefined;
    const facts = object ? factsOf(object.value, source.display) : null;
    return facts ? { enabled: true, state: "available", ...facts } : { enabled: true, state: "unavailable" };
  };
  return {
    async destinations() {
      if (!source.enabled()) return { enabled: false };
      return await listed();
    },
    async node(ref, repository) {
      if (!source.enabled()) return { enabled: false };
      return await read(ref, repository).catch((): GraphSurfaceCard => READ_FAILED_IS_UNAVAILABLE);
    },
  };
}
