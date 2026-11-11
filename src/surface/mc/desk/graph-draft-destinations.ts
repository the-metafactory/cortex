import { canonicalGraphRef, isBareGraphNode, qualifiedNodeId } from "../../../common/graph-ref";
import type { AuthorityMediator } from "../../../conversations/authority";
import { canonicalWire } from "../../../conversations/domain-adapters/operations/validation";
import type { DestinationMatch, DraftDestinations } from "../../../conversations/domain-adapters/drafting";
import type { QueryPage } from "../../../conversations/domain-adapters/reads/query-types";
import { readPointer } from "../../../conversations/domain-adapters/reads/query-validation";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import { graphNodeRepository, workGraphReadBindings } from "../../../conversations/domain-adapters/work-graph/read";
import { runHostQuery, type HostQueryRunner } from "./query-run";
import { destinationMatch, releasedObjects, type ReleasedObject } from "./work-released";

export interface GraphDraftReadSession extends HostQueryRunner {
  readonly repositories: readonly ObjectReference[];
  readonly destinations: () => QueryPage | Promise<QueryPage>;
}

export interface GraphDraftDestinationOptions {
  readonly connectionId: string;
  readonly authority: Pick<AuthorityMediator, "projectHostData" | "inspectHostRecords">;
  readonly session: (conversationId: string) => Promise<GraphDraftReadSession | null>;
}

type HostRecords = Awaited<ReturnType<AuthorityMediator["inspectHostRecords"]>>;
type NodeReader = (ref: ObjectReference) => Promise<ReleasedObject | null>;
interface ReleasedDestinations { objects: ReleasedObject[]; read: NodeReader }

const same = (left: string, right: string): boolean => canonicalGraphRef(left) === canonicalGraphRef(right);
const named = (object: ReleasedObject, label: string): boolean => same(object.ref.canonicalId, label) || typeof object.value.title === "string" && object.value.title.toLowerCase() === label.toLowerCase();

function activeRestriction(records: HostRecords, repository: ObjectReference) {
  const restrictions = Object.values(records.records).flatMap(history => {
    const record = history.at(-1);
    return record?.kind === "restriction" && record.value.status === "active" && canonicalWire(record.value.source) === canonicalWire(repository) ? [record.value] : [];
  });
  return restrictions.length === 1 ? restrictions[0] : undefined;
}

async function releasedDestinations(options: GraphDraftDestinationOptions, session: GraphDraftReadSession): Promise<ReleasedObject[]> {
  const records = await options.authority.inspectHostRecords();
  let page: Promise<QueryPage> | undefined;
  const projected = await Promise.all(session.repositories.map(async repository => {
    const restriction = activeRestriction(records, repository);
    if (!restriction) return [];
    const projection = await options.authority.projectHostData(session.context, options.connectionId, session.sink, async () => {
      const current = await (page ??= Promise.resolve(session.destinations()));
      return { objects: current.annotations.filter(annotation => same(annotation.destination.canonicalId, repository.canonicalId)).map(annotation => ({ ref: annotation.ref, destination: annotation.destination, value: readPointer(current.payload, annotation.pointer) ?? null })) };
    }, [{ capabilityId: "work-graph.destinations", destinations: [repository], sources: [{ ref: repository, restrictionRef: restriction.restrictionRef }], policy: "cloud" }]);
    return projection.kind === "released" ? releasedObjects(projection.value).filter(object => object.ref.adapterId === "work-graph" && object.ref.connectionId === options.connectionId) : [];
  }));
  return projected.flat();
}

function matchRepository(objects: ReleasedObject[], label: string): DestinationMatch {
  const repositories = objects.filter(object => object.ref.objectType === "repository");
  const exact = repositories.filter(object => named(object, label));
  return destinationMatch((exact.length ? exact : repositories.filter(object => object.ref.canonicalId.split("/").at(-1)?.toLowerCase() === label.toLowerCase())).map(object => object.ref));
}

async function readNode(options: GraphDraftDestinationOptions, session: GraphDraftReadSession, objects: ReleasedObject[], ref: ObjectReference): Promise<ReleasedObject | null> {
  const repository = graphNodeRepository(ref.canonicalId);
  const destination = objects.find(object => object.ref.objectType === "repository" && repository !== null && same(object.ref.canonicalId, repository));
  const binding = workGraphReadBindings.find(item => item.capabilityId === "work-graph.node.read");
  if (!destination || !binding) return null;
  const result = await runHostQuery(session, { adapterId: "work-graph", connectionId: options.connectionId, capabilityId: binding.capabilityId, inputSchemaRef: binding.inputSchemaRef, destinations: [destination.ref], input: { ref: { ...ref, objectType: "node" } } });
  if (result.result.status !== "ok" || result.result.restricted || result.released === undefined) return null;
  return releasedObjects(result.released).find(object => object.ref.adapterId === "work-graph" && object.ref.connectionId === options.connectionId && object.ref.canonicalId === ref.canonicalId) ?? null;
}

async function matchNode(options: GraphDraftDestinationOptions, objects: ReleasedObject[], label: string, read: NodeReader): Promise<DestinationMatch> {
  const linked = objects.filter(object => object.ref.objectType === "map" || object.ref.objectType === "node");
  const exact = linked.filter(object => same(object.ref.canonicalId, label));
  if (exact.length) return destinationMatch((await Promise.all(exact.map(object => read(object.ref)))).flatMap(object => object ? [object.ref] : []));
  const repository = graphNodeRepository(label);
  if (repository !== null || isBareGraphNode(label)) {
    const candidates = objects.filter(object => object.ref.objectType === "repository" && (repository === null || same(object.ref.canonicalId, repository))).map(object => ({ adapterId: "work-graph", connectionId: options.connectionId, objectType: "node", canonicalId: repository === null ? qualifiedNodeId(object.ref.canonicalId, label.replace(/^#/, "")) : label }));
    return destinationMatch((await Promise.all(candidates.map(read))).flatMap(object => object ? [object.ref] : []));
  }
  const current = await Promise.all(linked.map(object => read(object.ref)));
  return destinationMatch(current.flatMap((object, index) => {
    const link = linked[index];
    return object && (named(object, label) || link && named(link, label)) ? [object.ref] : [];
  }));
}

export function graphDraftDestinations(options: GraphDraftDestinationOptions): DraftDestinations & { batch(): DraftDestinations } {
  function batch(): DraftDestinations {
    const conversations = new Map<string, Promise<ReleasedDestinations | null>>();
    async function prepare(conversationId: string): Promise<ReleasedDestinations | null> {
      const session = await options.session(conversationId);
      if (!session) return null;
      const objects = await releasedDestinations(options, session);
      const reads = new Map<string, Promise<ReleasedObject | null>>();
      const read: NodeReader = ref => {
        const key = ref.canonicalId;
        const cached = reads.get(key);
        if (cached) return cached;
        const current = readNode(options, session, objects, ref);
        reads.set(key, current);
        return current;
      };
      return { objects, read };
    }
    return {
      async resolve(request) {
        if (request.connectionId !== options.connectionId || !request.conversationId || request.capabilityId !== "work-graph.destinations" || !["repository", "node"].includes(request.objectType ?? "")) return { kind: "unavailable" };
        const label = request.label.trim();
        if (!label) return { kind: "none" };
        if (!conversations.has(request.conversationId)) conversations.set(request.conversationId, prepare(request.conversationId));
        const current = await conversations.get(request.conversationId);
        if (!current?.objects.length) return { kind: "unavailable" };
        return request.objectType === "repository" ? matchRepository(current.objects, label) : matchNode(options, current.objects, label, current.read);
      },
    };
  }
  return { batch, resolve: request => batch().resolve(request) };
}
