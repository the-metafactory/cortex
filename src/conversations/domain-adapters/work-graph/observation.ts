// glossary-ignore: node, owner
import { canonicalGraphRef, qualifiedNodeId } from "../../../common/graph-ref";
import { CommandTimeout, runCommand, type CommandResult } from "../../../surface/mc/common/spawn";
import { authorityHash } from "../../authority-records";
import { canonicalWire } from "../operations/validation";
import type { Json } from "../operations/types";
import { OBSERVATION_LIMITS, type ObservationBatch, type ObservationConnector, type ObservationEvent, type ObservationRequest } from "../reads/observation-types";
import { readObservedAt } from "../reads/page-primitives";
import { ReadBindingSchema, type ReadBinding } from "../reads/types";
import { objectSchema, schemaRef } from "../schema-primitives";
import { schemaKey } from "../schema-validation";
import type { AdapterBindings, AdapterDeclaration, ObjectReference } from "../types";
import { WORK_GRAPH_ADAPTER_ID as ADAPTER_ID, referenceSchema } from "./schema";
import { createWorkGraphReadAdapter, graphNodeRepository, workGraphOwnerGone, workGraphReadDeclaration, WORK_GRAPH_REQUEST_TIMEOUT_MS, type WorkGraphReadSource, type WorkGraphRunner } from "./read";

export const WORK_GRAPH_OBSERVATION_CAPABILITY_ID = "work-graph.node.observation";
export const WORK_GRAPH_LISTING_ORDERING = "work-graph.current-listing";

const NODE_SCHEMA_REF = schemaRef("work-graph.node");
const OBSERVATION_INPUT_REF = schemaRef("work-graph.node.observation.input");
const OBSERVATION_OUTPUT_REF = schemaRef("work-graph.node.observation.output");
const OBSERVATION_ERROR_REF = schemaRef("work-graph.error");
const DEFAULT_PAGE_ITEMS = Math.floor(OBSERVATION_LIMITS.batchItems / 2);
const LISTING_MAX_PAGE_ITEMS = 100;
const DELETION_PROBES = 5;

const failure = (code: string): never => { throw new Error(`work-graph.${code}`); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

interface ListingRow { readonly id: string; readonly title: string; readonly status: "open" | "closed"; readonly kind: string | null; readonly parent: { readonly id: string; readonly denied: boolean } | null; readonly url: string | null }
interface ListingPage { readonly rows: readonly ListingRow[]; readonly next: string | null }
interface ListingWindow { readonly rows: readonly ListingRow[]; readonly complete: boolean }

export interface WorkGraphObservationSource extends WorkGraphReadSource { readonly pageItems?: number }

export function workGraphObservationDeclaration(): AdapterDeclaration {
  const read = workGraphReadDeclaration();
  return {
    ...read,
    schemas: [
      ...read.schemas,
      { ...OBSERVATION_INPUT_REF, schema: objectSchema({ repository: referenceSchema("repository") }, ["repository"]) },
      { ...OBSERVATION_OUTPUT_REF, schema: objectSchema({ items: { type: "array", items: { $ref: schemaKey(NODE_SCHEMA_REF) } } }, ["items"]) },
    ],
    capabilities: [
      ...read.capabilities,
      { capabilityId: WORK_GRAPH_OBSERVATION_CAPABILITY_ID, label: "Observe nodes", kind: "observation", objectTypes: ["node"], inputSchemaRef: OBSERVATION_INPUT_REF, outputSchemaRef: OBSERVATION_OUTPUT_REF, errorSchemaRef: OBSERVATION_ERROR_REF },
    ],
  };
}

export function workGraphObservationBinding(): ReadBinding {
  return ReadBindingSchema.parse({
    version: "1.0.0", adapterId: ADAPTER_ID, capabilityId: WORK_GRAPH_OBSERVATION_CAPABILITY_ID, mode: "poll", objectType: "node",
    inputSchemaRef: OBSERVATION_INPUT_REF, outputSchemaRef: OBSERVATION_OUTPUT_REF, destinationType: "repository",
    display: { title: "/title", status: "/status", kind: "/kind", parent: "/parent", url: "/url" },
    observation: { modes: ["poll"], objectsPointer: "/items", resumable: false, ordering: WORK_GRAPH_LISTING_ORDERING },
  });
}

const authoritativeCurrentListing: NonNullable<ObservationConnector["ordering"]> = {
  id: WORK_GRAPH_LISTING_ORDERING,
  compare: (left, right) => left === right ? "same" : "newer",
};

/**
 * One poll reads the repository's current listing in bounded `soma graph list` pages and projects every row it read.
 * A row leaves the projection only on the owner's own not-found answer from `soma graph node`; absence from a page,
 * a truncated page walk and a failed verb leave it in place.
 */
export function createWorkGraphObservationConnector(source: WorkGraphObservationSource): ObservationConnector {
  const pageItems = Math.max(1, Math.min(source.pageItems ?? DEFAULT_PAGE_ITEMS, LISTING_MAX_PAGE_ITEMS));
  return { modes: ["poll"], ordering: authoritativeCurrentListing, fetch: (request, signal) => observe(source, pageItems, request, signal) };
}

export interface WorkGraphObservationAdapter {
  readonly declaration: AdapterDeclaration;
  readonly bindings: AdapterBindings;
  readonly readBindings: readonly ReadBinding[];
  readonly connector: ObservationConnector;
}

export function createWorkGraphObservationAdapter(source: WorkGraphObservationSource): WorkGraphObservationAdapter {
  const read = createWorkGraphReadAdapter(source);
  return {
    declaration: workGraphObservationDeclaration(),
    bindings: { handlers: read.bindings.handlers, observations: { [WORK_GRAPH_OBSERVATION_CAPABILITY_ID]: { modes: ["poll"], ordering: WORK_GRAPH_LISTING_ORDERING } } },
    readBindings: [...read.readBindings, workGraphObservationBinding()],
    connector: createWorkGraphObservationConnector(source),
  };
}

function listingRow(raw: unknown): ListingRow {
  if (!isRecord(raw) || !isRecord(raw.ref)) return failure("invalid_listing");
  const id = raw.ref.id;
  const title = raw.title;
  const status = raw.status;
  const kind = raw.kind;
  const url = raw.url;
  if (typeof id !== "string" || id.trim().length === 0) return failure("invalid_listing");
  if (typeof title !== "string" || title.length === 0) return failure("invalid_listing");
  if (status !== "open" && status !== "closed") return failure("invalid_listing");
  if (kind !== null && typeof kind !== "string") return failure("invalid_listing");
  if (url !== null && typeof url !== "string") return failure("invalid_listing");
  return { id, title, status, kind, url, parent: listingParent(raw.parent) };
}

function listingParent(raw: unknown): ListingRow["parent"] {
  if (raw === null) return null;
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.trim().length === 0) return failure("invalid_listing");
  return { id: raw.id, denied: raw.unavailable === true };
}

function listingPageBody(raw: unknown): ListingPage {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return failure("invalid_listing");
  const next = raw.next;
  if (next !== null && (typeof next !== "string" || next.length === 0)) return failure("invalid_listing");
  return { rows: raw.nodes.map(row => listingRow(row)), next };
}

const somaArgv = (source: WorkGraphObservationSource, args: readonly string[]): string[] => [source.somaBin ?? "soma", ...args];
const runner = (source: WorkGraphObservationSource, signal: AbortSignal): WorkGraphRunner => source.run ?? ((argv, timeoutMs) => runCommand(argv, timeoutMs, undefined, undefined, false, { signal }));
const timeoutMs = (source: WorkGraphObservationSource): number => source.requestTimeoutMs ?? WORK_GRAPH_REQUEST_TIMEOUT_MS;

async function ownerCommand(source: WorkGraphObservationSource, argv: string[], signal: AbortSignal): Promise<CommandResult> {
  signal.throwIfAborted();
  try {
    return await runner(source, signal)(argv, timeoutMs(source));
  } catch (error) {
    return failure(error instanceof CommandTimeout || signal.aborted ? "owner_timeout" : "owner_unavailable");
  }
}

async function listingPage(source: WorkGraphObservationSource, repository: ObjectReference, cursor: string | undefined, limit: number, signal: AbortSignal): Promise<ListingPage> {
  const argv = somaArgv(source, ["graph", "list", "--repo", repository.canonicalId, "--state", "all", "--limit", String(limit), ...(cursor === undefined ? [] : ["--cursor", cursor]), "--read-repo", repository.canonicalId, "--json"]);
  const result = await ownerCommand(source, argv, signal);
  if (result.code !== 0) return failure("owner_unavailable");
  let body: unknown;
  try {
    body = JSON.parse(result.stdout) as unknown;
  } catch {
    return failure("invalid_listing");
  }
  return listingPageBody(body);
}

async function listingWindow(source: WorkGraphObservationSource, pageItems: number, repository: ObjectReference, limit: number, signal: AbortSignal): Promise<ListingWindow> {
  const rows: ListingRow[] = [];
  const seen = new Set<string>();
  const issued = new Set<string>();
  let cursor: string | undefined;
  const pages = Math.max(1, Math.ceil(limit / pageItems));
  for (let page = 0; page < pages; page++) {
    const size = Math.min(pageItems, limit - rows.length);
    if (size < 1) break;
    const read = await listingPage(source, repository, cursor, size, signal);
    if (read.rows.length > size) return failure("invalid_listing");
    for (const row of read.rows) {
      if (seen.has(row.id)) return failure("unstable_continuation");
      seen.add(row.id);
      rows.push(row);
    }
    if (read.next === null) return { rows, complete: true };
    if (read.next === cursor || issued.has(read.next)) return failure("unstable_continuation");
    issued.add(read.next);
    cursor = read.next;
  }
  return { rows, complete: false };
}

function observationRepository(source: WorkGraphObservationSource, request: ObservationRequest): ObjectReference {
  const [destination, ...rest] = request.source.destinations;
  if (rest.length > 0 || !destination) return failure("invalid_input");
  if (destination.adapterId !== ADAPTER_ID || destination.connectionId !== source.connectionId || destination.objectType !== "repository") return failure("invalid_input");
  if (!isRecord(request.source.input) || canonicalWire(request.source.input.repository) !== canonicalWire(destination)) return failure("invalid_input");
  if (!source.repositories().some(ref => canonicalGraphRef(ref) === canonicalGraphRef(destination.canonicalId))) return failure("destination_denied");
  return destination;
}

const nodeReference = (source: WorkGraphObservationSource, canonicalId: string): ObjectReference => ({ adapterId: ADAPTER_ID, connectionId: source.connectionId, objectType: "node", canonicalId });

function nodeValue(source: WorkGraphObservationSource, repository: ObjectReference, row: ListingRow): Json {
  const parent = row.parent === null || row.parent.denied ? null : nodeReference(source, qualifiedNodeId(repository.canonicalId, row.parent.id));
  return { title: row.title, status: row.status, kind: row.kind, parent, url: row.url };
}

function deletionCandidates(source: WorkGraphObservationSource, repository: ObjectReference, listed: ReadonlySet<string>): string[] {
  const wanted = canonicalGraphRef(repository.canonicalId);
  const candidates = (source.links?.() ?? []).flatMap(link => {
    const canonicalId = qualifiedNodeId(repository.canonicalId, link.id);
    const linked = graphNodeRepository(canonicalId);
    return linked !== null && canonicalGraphRef(linked) === wanted && !listed.has(canonicalId) ? [canonicalId] : [];
  });
  return [...new Set(candidates)];
}

async function ownerDeleted(source: WorkGraphObservationSource, repository: ObjectReference, canonicalId: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  try {
    const result = await runner(source, signal)(somaArgv(source, ["graph", "node", canonicalId, "--read-repo", repository.canonicalId, "--json"]), timeoutMs(source));
    return result.code !== 0 && workGraphOwnerGone(result, canonicalId);
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
}

async function observe(source: WorkGraphObservationSource, pageItems: number, request: ObservationRequest, signal: AbortSignal): Promise<ObservationBatch> {
  const repository = observationRepository(source, request);
  const observedAt = readObservedAt(source);
  const listing = await listingWindow(source, pageItems, repository, request.limit, signal);
  const events: ObservationEvent[] = [];
  const items: Json[] = [];
  const listed = new Set<string>();
  for (const row of listing.rows) {
    const canonicalId = qualifiedNodeId(repository.canonicalId, row.id);
    listed.add(canonicalId);
    const value = nodeValue(source, repository, row);
    const revision = authorityHash(value);
    items.push(value);
    events.push({ kind: "present", pointer: `/items/${items.length - 1}`, ref: nodeReference(source, canonicalId), schemaRef: NODE_SCHEMA_REF, destination: repository, observedAt, revision, evidenceId: `work-graph.node.${canonicalId}.${revision}` });
  }
  const probes = listing.complete ? deletionCandidates(source, repository, listed).slice(0, Math.max(0, Math.min(DELETION_PROBES, request.limit - events.length))) : [];
  const answers = await Promise.all(probes.map(async canonicalId => ({ canonicalId, deleted: await ownerDeleted(source, repository, canonicalId, signal) })));
  for (const { canonicalId, deleted } of answers) {
    if (!deleted) continue;
    events.push({ kind: "deleted", ownerDeletion: true, evidenceId: `work-graph.node.deleted.${canonicalId}`, ref: nodeReference(source, canonicalId), schemaRef: NODE_SCHEMA_REF, destination: repository, observedAt });
  }
  return { version: "1.0.0", payload: { items }, events, coverage: "objects", gap: false };
}
