// glossary-ignore: node, owner
import { randomUUID } from "node:crypto";
import { authorityRig } from "../../../authority-fixtures";
import type { ReleaseProjection } from "../../../authority";
import type { RestrictionRecord } from "../../../authority-records";
import type { Json } from "../../operations/types";
import { AT, registryFixture } from "../../operations/fixtures";
import { controlledQueryClock } from "../../reads/query-fixtures";
import type { QuerySource } from "../../reads/query-types";
import type { ObservationView } from "../../reads/observation-types";
import type { ObservationStore } from "../../reads/observations";
import type { ReadBinding } from "../../reads/types";
import { createWorkGraphObservationAdapter, WORK_GRAPH_OBSERVATION_CAPABILITY_ID, type WorkGraphObservationAdapter } from "../../work-graph/observation";
import type { GraphConversationLink, WorkGraphRunner } from "../../work-graph/read";
import { graphRef } from "./graph-read-fixtures";
import { installReadBindings } from "./read-binding-rig";

export const OBSERVED = "github:github.com/the-metafactory/cortex";
export const OBSERVED_NODE = `${OBSERVED}#3348`;
export const OBSERVED_NODE_TWO = `${OBSERVED}#3349`;
export const OBSERVED_NODE_THREE = `${OBSERVED}#3350`;
export const OBSERVED_PARENT = `${OBSERVED}#3293`;
export const OBSERVED_OTHER = "github:github.com/the-metafactory/other";

export interface SyntheticListingRow {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "closed";
  readonly kind: string | null;
  readonly parent: { readonly id: string; readonly unavailable?: true } | null;
  readonly url: string | null;
}

export const syntheticRow = (id: string, title: string, status: "open" | "closed" = "open", parent: string | null = null): SyntheticListingRow => ({
  id, title, status, kind: status === "open" ? "build" : "research", parent: parent === null ? null : { id: parent }, url: `https://example.invalid/${id}`,
});

export const syntheticListing = (): SyntheticListingRow[] => [syntheticRow("3348", "Observe graph nodes", "open", "3293"), syntheticRow("3349", "Persist observations"), syntheticRow("3350", "Read the graph picker", "closed")];

export interface SyntheticGraph {
  readonly listings: Map<string, SyntheticListingRow[]>;
  readonly present: Set<string>;
  readonly calls: { argv: string[][] };
  fail: string | null;
  probeFail: string | null;
  corrupt: string | null;
  repeatCursor: boolean;
  run: WorkGraphRunner;
  listing(repository: string): SyntheticListingRow[];
  replace(repository: string, rows: readonly SyntheticListingRow[]): void;
  forget(canonicalId: string): void;
}

export function syntheticGraph(): SyntheticGraph {
  const listings = new Map<string, SyntheticListingRow[]>([[OBSERVED, syntheticListing()]]);
  const present = new Set<string>(syntheticListing().map(row => `${OBSERVED}#${row.id}`));
  const calls = { argv: [] as string[][] };
  const state = { fail: null as string | null, probeFail: null as string | null, corrupt: null as string | null, repeatCursor: false };
  const listing = (repository: string): SyntheticListingRow[] => listings.get(repository) ?? [];
  const answer = (argv: string[]): { code: number; signal: null; stdout: string; stderr: string } => {
    calls.argv.push(argv);
    if (state.fail !== null) return { code: 1, signal: null, stdout: "", stderr: state.fail };
    const fail = (stderr: string) => ({ code: 1, signal: null, stdout: "", stderr });
    const option = (name: string): string | undefined => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
    if (state.corrupt !== null) return { code: 0, signal: null, stdout: state.corrupt, stderr: "" };
    if (argv[2] === "list") {
      const repository = option("--repo") ?? "";
      const limit = Number(option("--limit") ?? "0");
      const cursor = option("--cursor");
      const offset = cursor === undefined ? 0 : Number(cursor.replace(/^after:/, ""));
      if (!Number.isSafeInteger(offset) || offset < 0) return fail("the cursor is not one this verb issued");
      const rows = listing(repository);
      const nodes = rows.slice(offset, offset + limit).map(row => ({ ref: { id: row.id }, title: row.title, status: row.status, kind: row.kind, parent: row.parent, url: row.url }));
      const next = offset + nodes.length < rows.length ? `after:${state.repeatCursor ? offset : offset + nodes.length}` : null;
      return { code: 0, signal: null, stdout: JSON.stringify({ nodes, next }), stderr: "" };
    }
    if (argv[2] === "node") {
      if (state.probeFail !== null) return fail(state.probeFail);
      const canonicalId = argv[3] ?? "";
      if (!present.has(canonicalId)) return fail(`node ${canonicalId} not found`);
      const repository = option("--read-repo") ?? "";
      const found = listing(repository).find(candidate => `${repository}#${candidate.id}` === canonicalId) ?? syntheticRow(canonicalId.slice(canonicalId.lastIndexOf("#") + 1), "Unlisted node");
      return { code: 0, signal: null, stdout: JSON.stringify({ repo: repository, ref: { id: found.id }, status: found.status, url: found.url, node: { title: found.title, kind: found.kind }, parent: found.parent }), stderr: "" };
    }
    return { code: 2, signal: null, stdout: "", stderr: "unsupported synthetic verb" };
  };
  return {
    listings, present, calls,
    get fail() { return state.fail; },
    set fail(value: string | null) { state.fail = value; },
    get probeFail() { return state.probeFail; },
    set probeFail(value: string | null) { state.probeFail = value; },
    get corrupt() { return state.corrupt; },
    set corrupt(value: string | null) { state.corrupt = value; },
    get repeatCursor() { return state.repeatCursor; },
    set repeatCursor(value: boolean) { state.repeatCursor = value; },
    run: (argv, _timeoutMs) => Promise.resolve(answer(argv)),
    listing,
    replace(repository, rows) { listings.set(repository, [...rows]); },
    forget(canonicalId) { present.delete(canonicalId); },
  };
}

export interface GraphObservationRig {
  readonly rig: Awaited<ReturnType<typeof authorityRig>>;
  readonly graph: SyntheticGraph;
  readonly adapter: WorkGraphObservationAdapter;
  readonly binding: ReadBinding;
  readonly source: QuerySource;
  readonly repository: ReturnType<typeof graphRef>;
  readonly time: ReturnType<typeof controlledQueryClock>;
  readonly links: GraphConversationLink[];
  readonly connectionId: string;
  get store(): ObservationStore;
  check(): Promise<{ status: string; changed: number; quarantined: number }>;
  read(history?: boolean): Promise<ReleaseProjection<Json>>;
  views(history?: boolean): Promise<ObservationView[]>;
  fetch(): Promise<unknown>;
  untick(repository?: string): Promise<void>;
  close(): Promise<void>;
}

export interface GraphObservationRigOptions {
  readonly pageItems?: number;
  readonly somaBin?: string;
  readonly run?: WorkGraphRunner;
}

export async function openGraphObservationRig(started = syntheticGraph(), options: GraphObservationRigOptions = {}): Promise<GraphObservationRig> {
  const graph = started;
  const time = controlledQueryClock();
  const ticked = [OBSERVED];
  const links: GraphConversationLink[] = [];
  let connectionId = "";
  const adapter = createWorkGraphObservationAdapter({
    get connectionId() { return connectionId; },
    repositories: () => ticked,
    links: () => links,
    now: () => new Date(AT),
    ...(options.pageItems === undefined ? {} : { pageItems: options.pageItems }),
    ...(options.somaBin === undefined ? { run: options.run ?? graph.run } : { somaBin: options.somaBin }),
  });
  const registry = registryFixture();
  const registered = registry.register(adapter.declaration, adapter.bindings);
  if (!registered.ok) throw new Error(registered.error.code);
  const binding = adapter.readBindings.find(candidate => candidate.capabilityId === WORK_GRAPH_OBSERVATION_CAPABILITY_ID);
  if (!binding) throw new Error("the work-graph observation binding is missing");
  const rig = await authorityRig({}, "local", { registry, adapterId: "work-graph", binding, capabilityIds: [WORK_GRAPH_OBSERVATION_CAPABILITY_ID], observation: adapter.connector });
  connectionId = rig.connection.connectionId;
  installReadBindings(registry, rig.bindings, "work-graph", connectionId, adapter.readBindings);
  const repository = graphRef(connectionId, "repository", OBSERVED);
  const restrictionRefs = new Map<string, string>();
  const restriction = (ref: string, revision: string, status: RestrictionRecord["status"]): RestrictionRecord => ({
    version: 1, status, restrictionRef: restrictionRefs.get(ref) ?? randomUUID(), ownerRevision: revision, decisionRef: "graph-observation-fixture", revision,
    source: graphRef(connectionId, "repository", ref), audiences: ["web", "discord", "model", "view"], egress: "cloud",
    readScope: [rig.principal.principalRef], resolverBinding: "synthetic-restriction-resolver",
  });
  let revision = 2;
  const publishScope = async (repositories: readonly string[]): Promise<void> => {
    Object.assign(rig.connection, { adapterId: "work-graph", connectionRevision: String(revision), readCapabilityIds: adapter.readBindings.map(candidate => candidate.capabilityId), readDestinations: repositories.map(ref => graphRef(connectionId, "repository", ref)) });
    await rig.service.publishHostRecord({ kind: "connection", value: rig.connection }, revision - 1);
    revision++;
  };
  restrictionRefs.set(OBSERVED, randomUUID());
  await publishScope(ticked);
  await rig.service.publishHostRecord({ kind: "restriction", value: restriction(OBSERVED, "1", "active") }, 0);
  const source: QuerySource = { adapterId: "work-graph", connectionId, capabilityId: WORK_GRAPH_OBSERVATION_CAPABILITY_ID, inputSchemaRef: binding.inputSchemaRef, destinations: [repository], input: { repository } };
  const store = (): ObservationStore => rig.host.readObservations(registry, rig.bindings, time.clock);
  return {
    rig, graph, adapter, binding, source, repository, time, links,
    get connectionId() { return connectionId; },
    get store() { return store(); },
    check: () => store().check(rig.context, source, rig.sink, "poll"),
    read: (history = false) => store().read(rig.context, source, rig.sink, history),
    async views(history = false) {
      const released = await store().read(rig.context, source, rig.sink, history);
      if (released.kind !== "released") throw new Error("graph observations withheld");
      return (released.value as unknown as { objects: ObservationView[] }).objects;
    },
    fetch: () => adapter.connector.fetch({ source, mode: "poll", limit: 20 }, new AbortController().signal),
    async untick(ref = OBSERVED) {
      const held = restrictionRefs.get(ref);
      if (held === undefined) throw new Error("graph observation repository was never ticked");
      const revoked: RestrictionRecord = { ...restriction(ref, "2", "revoked"), restrictionRef: held };
      await rig.service.publishHostRecord({ kind: "restriction", value: revoked }, 1);
      ticked.splice(0, ticked.length, ...ticked.filter(candidate => candidate !== ref));
      await publishScope(ticked);
    },
    close: () => rig.close(),
  };
}
