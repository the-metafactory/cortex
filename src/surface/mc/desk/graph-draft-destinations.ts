import { canonicalGraphRef, isBareGraphNode, qualifiedNodeId } from "../../../common/graph-ref";
import type { AuthorityMediator } from "../../../conversations/authority";
import { canonicalWire } from "../../../conversations/domain-adapters/operations/validation";
import type { DraftDestinations, DestinationMatch } from "../../../conversations/domain-adapters/drafting";
import type { QueryPage } from "../../../conversations/domain-adapters/reads/query-types";
import { readPointer } from "../../../conversations/domain-adapters/reads/query-validation";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import { graphNodeRepository, workGraphReadBindings } from "../../../conversations/domain-adapters/work-graph/read";
import { runHostQuery, type HostQueryRunner } from "./query-run";
import { releasedObjects, type ReleasedObject } from "./work-released";

export interface GraphDraftReadSession extends HostQueryRunner {
  readonly repositories: readonly ObjectReference[];
  readonly destinations: () => QueryPage | Promise<QueryPage>;
}

export interface GraphDraftDestinationOptions {
  readonly connectionId: string;
  readonly authority: Pick<AuthorityMediator, "projectHostData" | "inspectHostRecords">;
  readonly session: (conversationId: string) => Promise<GraphDraftReadSession | null>;
}

const match = (refs: ObjectReference[]): DestinationMatch => {
  const unique = [...new Map(refs.map(ref => [JSON.stringify(ref), ref])).values()];
  const first = unique[0];
  return !first ? { kind: "none" } : unique.length === 1 ? { kind: "unique", ref: first } : { kind: "multiple", refs: unique };
};
const same = (left: string, right: string): boolean => canonicalGraphRef(left) === canonicalGraphRef(right);
const named = (object: ReleasedObject, label: string): boolean => same(object.ref.canonicalId, label) || typeof object.value.title === "string" && object.value.title.toLowerCase() === label.toLowerCase();

export function graphDraftDestinations(options: GraphDraftDestinationOptions): DraftDestinations {
  return {
    async resolve(request) {
      if (request.connectionId !== options.connectionId || !request.conversationId || request.capabilityId !== "work-graph.destinations" || !["repository", "node"].includes(request.objectType ?? "")) return { kind: "unavailable" };
      const session = await options.session(request.conversationId);
      if (!session) return { kind: "unavailable" };
      const query = async (capabilityId: string, destinations: ObjectReference[], ref?: ObjectReference): Promise<ReleasedObject[] | null> => {
        const binding = workGraphReadBindings.find(item => item.capabilityId === capabilityId);
        if (!binding) return null;
        const result = await runHostQuery(session, { adapterId: "work-graph", connectionId: options.connectionId, capabilityId, inputSchemaRef: binding.inputSchemaRef, destinations, input: ref ? { ref } : {} });
        if (result.result.status !== "ok" || result.result.restricted || result.released === undefined) return null;
        return releasedObjects(result.released).filter(object => object.ref.adapterId === "work-graph" && object.ref.connectionId === options.connectionId);
      };
      const objects: ReleasedObject[] = [];
      const records = await options.authority.inspectHostRecords();
      for (const repository of session.repositories) {
        const restrictions = Object.values(records.records).flatMap(history => {
          const record = history.at(-1);
          return record?.kind === "restriction" && record.value.status === "active" && canonicalWire(record.value.source) === canonicalWire(repository) ? [record.value] : [];
        });
        const restriction = restrictions[0];
        if (restrictions.length !== 1 || !restriction) continue;
        const projection = await options.authority.projectHostData(session.context, options.connectionId, session.sink, async () => {
          const page = await session.destinations();
          return { objects: page.annotations.filter(annotation => same(annotation.destination.canonicalId, repository.canonicalId)).map(annotation => ({ ref: annotation.ref, destination: annotation.destination, value: readPointer(page.payload, annotation.pointer) ?? null })) };
        }, [{ capabilityId: "work-graph.destinations", destinations: [repository], sources: [{ ref: repository, restrictionRef: restriction.restrictionRef }], policy: "cloud" }]);
        if (projection.kind === "released") objects.push(...releasedObjects(projection.value));
      }
      if (!objects.length) return { kind: "unavailable" };
      const label = request.label.trim();
      if (!label) return { kind: "none" };
      const repositories = objects.filter(object => object.ref.objectType === "repository");
      if (request.objectType === "repository") {
        const exact = repositories.filter(object => named(object, label));
        return match((exact.length ? exact : repositories.filter(object => object.ref.canonicalId.split("/").at(-1)?.toLowerCase() === label.toLowerCase())).map(object => object.ref));
      }
      const read = async (ref: ObjectReference): Promise<ReleasedObject | null> => {
        const repository = graphNodeRepository(ref.canonicalId);
        const destination = repositories.find(object => repository !== null && same(object.ref.canonicalId, repository));
        if (!destination) return null;
        const answer = await query("work-graph.node.read", [destination.ref], { ...ref, objectType: "node" });
        return answer?.find(object => object.ref.canonicalId === ref.canonicalId) ?? null;
      };
      const linked = objects.filter(object => object.ref.objectType === "map" || object.ref.objectType === "node");
      const exact = linked.filter(object => same(object.ref.canonicalId, label));
      if (exact.length) return match((await Promise.all(exact.map(object => read(object.ref)))).flatMap(object => object ? [object.ref] : []));
      const repository = graphNodeRepository(label);
      if (repository !== null || isBareGraphNode(label)) {
        const candidates = repositories.filter(object => repository === null || same(object.ref.canonicalId, repository)).map(object => ({ adapterId: "work-graph", connectionId: options.connectionId, objectType: "node", canonicalId: repository === null ? qualifiedNodeId(object.ref.canonicalId, label.replace(/^#/, "")) : label }));
        return match((await Promise.all(candidates.map(read))).flatMap(object => object ? [object.ref] : []));
      }
      const current = await Promise.all(linked.map(object => read(object.ref)));
      return match(current.flatMap((object, index) => {
        const link = linked[index];
        return object && (named(object, label) || link && named(link, label)) ? [object.ref] : [];
      }));
    },
  };
}
