import { canonicalGraphRef, canonicalNodeId, formatGraphNodeRef, isBareGraphNode, formatGraphRepoRef, parseGraphNodeRef, parseGraphRepoRef, qualifiedNodeId } from "../../../common/graph-ref";
import { CommandTimeout, runCommand, type CommandResult } from "../../../surface/mc/desk/spawn";
import { isRecord, parseObjectReference, parseReadHandlerContext, readObservedAt, readPage, readSnapshotId, type Json, type QueryFetchRequest, type QueryPage, type QueryPageEntry, type ReadBinding } from "../reads/page-primitives";
import { adapterErrorSchema, objectSchema, schemaRef } from "../schema-primitives";
import { schemaKey } from "../schema-validation";
import type { AdapterBindings, AdapterDeclaration, ObjectReference } from "../types";
import { WORK_GRAPH_ADAPTER_ID as ADAPTER_ID, nullableReferenceSchema, referenceSchema, type GraphObjectType } from "./schema";
import { workGraphNodeCreateDeclaration } from "./node-binding";

const DEFAULT_TIMEOUT_MS = 8_000;
const NODE_PAGE_ITEMS = 1;
const REPOSITORY_SCHEMA_REF = schemaRef("work-graph.repository");
const NODE_SCHEMA_REF = schemaRef("work-graph.node");
const DESTINATIONS_INPUT_REF = schemaRef("work-graph.destinations.input");
const DESTINATIONS_OUTPUT_REF = schemaRef("work-graph.destinations.output");
const NODE_READ_INPUT_REF = schemaRef("work-graph.node.read.input");
const NODE_READ_OUTPUT_REF = schemaRef("work-graph.node.read.output");
const ERROR_REF = schemaRef("work-graph.error");

const REPOSITORY_VALUE_SCHEMA = objectSchema({ title: { type: "string", minLength: 1 } }, ["title"]);
const NODE_VALUE_SCHEMA = objectSchema({
  title: { type: "string", minLength: 1 },
  status: { type: "string", enum: ["open", "closed"] },
  kind: { type: ["string", "null"] },
  parent: nullableReferenceSchema("node"),
  url: { type: ["string", "null"] },
}, ["title"]);
const DESTINATIONS_INPUT_SCHEMA = objectSchema({}, []);
const DESTINATIONS_OUTPUT_SCHEMA = objectSchema({ items: { type: "array", items: { anyOf: [REPOSITORY_VALUE_SCHEMA, NODE_VALUE_SCHEMA] } } }, ["items"]);
const NODE_READ_INPUT_SCHEMA = objectSchema({ ref: referenceSchema("node") }, ["ref"]);
const NODE_READ_OUTPUT_SCHEMA = objectSchema({ items: { type: "array", items: { $ref: schemaKey(NODE_SCHEMA_REF) } } }, ["items"]);
const ERROR_SCHEMA = adapterErrorSchema(ADAPTER_ID);

export function workGraphReadDeclaration(): AdapterDeclaration {
  const creation = workGraphNodeCreateDeclaration();
  return {
    adapterId: ADAPTER_ID,
    label: "Work graph",
    contractRange: "^1.0.0",
    schemas: [
      ...creation.schemas,
      { ...REPOSITORY_SCHEMA_REF, schema: REPOSITORY_VALUE_SCHEMA },
      { ...NODE_SCHEMA_REF, schema: NODE_VALUE_SCHEMA },
      { ...DESTINATIONS_INPUT_REF, schema: DESTINATIONS_INPUT_SCHEMA },
      { ...DESTINATIONS_OUTPUT_REF, schema: DESTINATIONS_OUTPUT_SCHEMA },
      { ...NODE_READ_INPUT_REF, schema: NODE_READ_INPUT_SCHEMA },
      { ...NODE_READ_OUTPUT_REF, schema: NODE_READ_OUTPUT_SCHEMA },
      { ...ERROR_REF, schema: ERROR_SCHEMA },
    ],
    objectTypes: [
      ...creation.objectTypes.filter(object => object.objectType === "node-draft"),
      { objectType: "repository", label: "Repository", schemaRef: REPOSITORY_SCHEMA_REF, relationships: [] },
      { objectType: "map", label: "Map", schemaRef: NODE_SCHEMA_REF, relationships: [] },
      { objectType: "node", label: "Node", schemaRef: NODE_SCHEMA_REF, relationships: [{ fieldPath: "/parent", targetAdapterId: ADAPTER_ID, targetObjectType: "node", cardinality: "one" }] },
    ],
    capabilities: [
      ...creation.capabilities,
      { capabilityId: "work-graph.destinations", label: "List destinations", kind: "query", objectTypes: ["repository", "map", "node"], inputSchemaRef: DESTINATIONS_INPUT_REF, outputSchemaRef: DESTINATIONS_OUTPUT_REF, errorSchemaRef: ERROR_REF },
      { capabilityId: "work-graph.node.read", label: "Read node", kind: "query", objectTypes: ["node"], inputSchemaRef: NODE_READ_INPUT_REF, outputSchemaRef: NODE_READ_OUTPUT_REF, errorSchemaRef: ERROR_REF },
    ],
  };
}

export const workGraphReadBindings: readonly ReadBinding[] = [
  { version: "1.0.0", adapterId: ADAPTER_ID, capabilityId: "work-graph.destinations", mode: "destinations", objectType: "repository", inputSchemaRef: DESTINATIONS_INPUT_REF, outputSchemaRef: DESTINATIONS_OUTPUT_REF, display: { title: "/title" } },
  {
    version: "1.0.0", adapterId: ADAPTER_ID, capabilityId: "work-graph.node.read", mode: "query", objectType: "node", inputSchemaRef: NODE_READ_INPUT_REF, outputSchemaRef: NODE_READ_OUTPUT_REF, destinationType: "repository",
    display: { title: "/title", status: "/status", kind: "/kind", parent: "/parent", url: "/url" },
    query: { objectsPointer: "/items", ordering: "provider", stableSnapshot: true, limits: { items: NODE_PAGE_ITEMS } },
  },
];

export { canonicalGraphRef };

export type WorkGraphRunner = (argv: string[], timeoutMs: number) => Promise<CommandResult>;

export interface GraphConversationLink {
  readonly owner: "graph-node" | "graph-map";
  readonly id: string;
  readonly title?: string;
}

export interface WorkGraphReadSource {
  readonly connectionId: string;
  readonly repositories: () => readonly string[];
  readonly links?: () => readonly GraphConversationLink[];
  readonly run?: WorkGraphRunner;
  readonly somaBin?: string;
  readonly now?: () => Date;
  readonly requestTimeoutMs?: number;
}

export interface WorkGraphReadAdapter {
  readonly declaration: AdapterDeclaration;
  readonly bindings: AdapterBindings;
  readonly readBindings: readonly ReadBinding[];
  readonly query: (request: QueryFetchRequest) => Promise<QueryPage>;
  readonly destinations: () => QueryPage;
}

interface NodeTarget { readonly canonicalId: string; readonly repository: string; readonly full: string }

const str = (value: unknown): string | null => typeof value === "string" ? value : null;
const failure = (code: string): never => { throw new Error(`work-graph.${code}`); };
const reference = (connectionId: string, objectType: GraphObjectType, canonicalId: string): ObjectReference => ({ adapterId: ADAPTER_ID, connectionId, objectType, canonicalId });
const parseReference = (value: unknown): ObjectReference => parseObjectReference(value, failure);
const observedAt = readObservedAt;
const snapshotId = (scope: string, content: Json): string => readSnapshotId("work-graph", scope, content);
const isBareNode = isBareGraphNode;
const NODE_TAIL = /^(.+?)([#&])([1-9]\d*)$/;
const GITHUB_RELATIVE_NODE = /^([\w.-]+\/[\w.-]+)([#&])([1-9]\d*)$/;

const isOwnRepository = (source: WorkGraphReadSource, value: ObjectReference): boolean =>
  value.adapterId === ADAPTER_ID && value.connectionId === source.connectionId && value.objectType === "repository";

const requestedRepositories = (source: WorkGraphReadSource, destinations: readonly ObjectReference[]): ObjectReference[] =>
  destinations.filter(destination => isOwnRepository(source, destination));

const isTicked = (source: WorkGraphReadSource, canonicalId: string): boolean => {
  const wanted = canonicalGraphRef(canonicalId);
  return source.repositories().some(repository => canonicalGraphRef(repository) === wanted);
};

const parseHandlerContext = (raw: unknown) => parseReadHandlerContext(raw, NODE_PAGE_ITEMS, failure);

function parseNodeRead(input: unknown, source: WorkGraphReadSource): ObjectReference {
  if (!isRecord(input)) return failure("invalid_input");
  const parsed = parseReference(input.ref);
  if (parsed.adapterId !== ADAPTER_ID || parsed.objectType !== "node" || parsed.connectionId !== source.connectionId) return failure("invalid_input");
  return parsed;
}

function nodeTarget(canonicalId: string, source: WorkGraphReadSource, destinations: readonly ObjectReference[]): NodeTarget {
  const text = canonicalId.trim();
  const full = parseGraphNodeRef(text);
  if (full) return { canonicalId: text, repository: formatGraphRepoRef(full.repo), full: formatGraphNodeRef(full) };
  const relative = GITHUB_RELATIVE_NODE.exec(text);
  if (relative?.[2] === "#") {
    const repository = `github:github.com/${relative[1]}`;
    return { canonicalId: text, repository, full: `${repository}#${relative[3] ?? failure("invalid_input")}` };
  }
  if (!isBareNode(text)) return failure("invalid_input");
  const repositories = requestedRepositories(source, destinations);
  if (repositories.length !== 1) return failure("invalid_input");
  const repository = repositories[0]?.canonicalId ?? "";
  const parsed = parseGraphRepoRef(repository);
  if (!parsed) return failure("invalid_input");
  const formatted = formatGraphRepoRef(parsed);
  return { canonicalId: text, repository: formatted, full: `${formatted}#${text.replace(/^#/, "")}` };
}

/** The repository a full or GitHub-relative work-graph reference names, in the stored `github:github.com/…` form; null for a bare number or anything unparseable. */
export function graphNodeRepository(value: string): string | null {
  const text = value.trim();
  const full = parseGraphNodeRef(text);
  if (full) return formatGraphRepoRef(full.repo);
  const relative = GITHUB_RELATIVE_NODE.exec(text);
  return relative?.[2] === "#" ? `github:github.com/${relative[1]}` : null;
}

function destinationFor(source: WorkGraphReadSource, destinations: readonly ObjectReference[], repository: string): ObjectReference | null {
  const wanted = canonicalGraphRef(repository);
  return destinations.find(destination => isOwnRepository(source, destination) && canonicalGraphRef(destination.canonicalId) === wanted && isTicked(source, destination.canonicalId)) ?? null;
}

function repositoryOf(value: string): string | null {
  const match = NODE_TAIL.exec(value.trim());
  return match?.[1] ?? null;
}

function linkedPageEntry(source: WorkGraphReadSource, link: GraphConversationLink, repositories: readonly string[]): QueryPageEntry | null {
  const repository = repositoryOf(link.id);
  if (repository === null) return null;
  const wanted = canonicalGraphRef(repository);
  const destination = repositories.find(candidate => canonicalGraphRef(candidate) === wanted);
  if (destination === undefined) return null;
  const objectType = link.owner === "graph-map" ? "map" : "node";
  return {
    ref: reference(source.connectionId, objectType, link.id),
    schemaRef: NODE_SCHEMA_REF,
    destination: reference(source.connectionId, "repository", destination),
    evidenceId: `work-graph.link.${objectType}.${link.id}`,
    value: { title: link.title ?? link.id },
  };
}

function destinationsPage(source: WorkGraphReadSource): QueryPage {
  const repositories = [...new Set(source.repositories())];
  const entries: QueryPageEntry[] = repositories.map(repository => ({
    ref: reference(source.connectionId, "repository", repository),
    schemaRef: REPOSITORY_SCHEMA_REF,
    destination: reference(source.connectionId, "repository", repository),
    evidenceId: `work-graph.repository.${repository}`,
    value: { title: canonicalGraphRef(repository) },
  }));
  const seen = new Set<string>();
  for (const link of source.links?.() ?? []) {
    const entry = linkedPageEntry(source, link, repositories);
    if (!entry) continue;
    const key = `${entry.ref.objectType}:${entry.ref.canonicalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return readPage(entries, snapshotId("destinations", { connectionId: source.connectionId, entries: entries.map(entry => entry.ref) }), observedAt(source));
}

function ownerFailure(result: CommandResult): string {
  return /not found|no such|could not resolve|HTTP 404|HTTP 410/i.test(`${result.stderr}\n${result.stdout}`) ? "node_unavailable" : "owner_unavailable";
}

async function ownerNode(source: WorkGraphReadSource, argv: string[]): Promise<Record<string, unknown>> {
  let result: CommandResult;
  try {
    result = await (source.run ?? ((command, timeoutMs) => runCommand(command, timeoutMs)))(argv, source.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (error) {
    return failure(error instanceof CommandTimeout ? "owner_timeout" : "owner_unavailable");
  }
  if (result.code !== 0) return failure(ownerFailure(result));
  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return failure("node_unavailable");
  }
  return isRecord(body) ? body : failure("node_unavailable");
}

function nodeValue(source: WorkGraphReadSource, target: NodeTarget, body: Record<string, unknown>): Json {
  const node = isRecord(body.node) ? body.node : failure("node_unavailable");
  const ownerRef = isRecord(body.ref) ? body.ref : failure("owner_identity_mismatch");
  const ownerId = str(ownerRef.id);
  const repository = str(body.repo);
  const parsed = parseGraphNodeRef(target.full);
  if (!parsed) return failure("invalid_input");
  if (repository === null || canonicalGraphRef(repository) !== canonicalGraphRef(target.repository)) return failure("owner_identity_mismatch");
  if (ownerId === null || ownerId !== canonicalNodeId(parsed)) return failure("owner_identity_mismatch");
  const status = body.status;
  if (status !== "open" && status !== "closed") return failure("node_unavailable");
  const title = str(node.title);
  if (title === null || title.length === 0) return failure("node_unavailable");
  const repositoryRef = formatGraphRepoRef(parsed.repo);
  const parentId = isRecord(body.parent) ? str(body.parent.id) : null;
  return {
    title,
    status,
    kind: str(node.kind),
    parent: parentId === null ? null : reference(source.connectionId, "node", qualifiedNodeId(repositoryRef, parentId)),
    url: str(body.url),
  };
}

async function nodeReadPage(source: WorkGraphReadSource, input: unknown, destinations: readonly ObjectReference[], limit: number): Promise<QueryPage> {
  const parsed = parseNodeRead(input, source);
  if (limit < 1) return failure("invalid_input");
  const target = nodeTarget(parsed.canonicalId, source, destinations);
  const destination = destinationFor(source, destinations, target.repository);
  if (!destination) return failure("destination_denied");
  const body = await ownerNode(source, [source.somaBin ?? "soma", "graph", "node", target.full, "--read-repo", destination.canonicalId, "--json"]);
  const value = nodeValue(source, target, body);
  const entry: QueryPageEntry = {
    ref: reference(source.connectionId, "node", parsed.canonicalId),
    schemaRef: NODE_SCHEMA_REF,
    destination,
    evidenceId: `work-graph.node.${canonicalGraphRef(target.full)}`,
    value,
  };
  return readPage([entry], snapshotId("node.read", { connectionId: source.connectionId, ref: parsed.canonicalId, value }), observedAt(source));
}

export function createWorkGraphReadAdapter(source: WorkGraphReadSource): WorkGraphReadAdapter {
  const query = async (request: QueryFetchRequest): Promise<QueryPage> => {
    if (request.capabilityId === "work-graph.destinations") return destinationsPage(source);
    if (request.capabilityId === "work-graph.node.read") return nodeReadPage(source, request.input, request.destinations, request.limit);
    throw new Error("work-graph.unknown_capability");
  };
  const handlers: AdapterBindings["handlers"] = {
    "work-graph.destinations": input => {
      if (!isRecord(input) || Object.keys(input).length > 0) return failure("invalid_input");
      return destinationsPage(source);
    },
    "work-graph.node.read": (input, context) => {
      const checked = parseHandlerContext(context);
      return nodeReadPage(source, input, checked.destinations, checked.limit);
    },
  };
  return {
    declaration: workGraphReadDeclaration(),
    bindings: { handlers, observations: {} },
    readBindings: workGraphReadBindings,
    query,
    destinations: () => destinationsPage(source),
  };
}
