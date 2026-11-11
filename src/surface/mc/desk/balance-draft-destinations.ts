import type { AuthorityMediator } from "../../../conversations/authority";
import { canonicalWire } from "../../../conversations/domain-adapters/operations/validation";
import type { DestinationMatch, DraftDestinations } from "../../../conversations/domain-adapters/drafting";
import type { QueryPage } from "../../../conversations/domain-adapters/reads/query-types";
import { readPointer } from "../../../conversations/domain-adapters/reads/query-validation";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import type { HostQueryRunner } from "./query-run";
import { destinationMatch, releasedObjects, type ReleasedObject } from "./work-released";

export const BALANCE_DESTINATIONS_CAPABILITY = "balance.destinations";
const PROJECT_LABEL_SEPARATOR = " / ";

export interface BalanceDraftReadSession extends HostQueryRunner {
  readonly areas: readonly ObjectReference[];
  readonly destinations: () => QueryPage | Promise<QueryPage>;
}

export interface BalanceDraftDestinationOptions {
  readonly connectionId: string;
  readonly authority: Pick<AuthorityMediator, "projectHostData" | "inspectHostRecords">;
  readonly session: (conversationId: string) => Promise<BalanceDraftReadSession | null>;
}

export interface BalanceDraftDestinations extends DraftDestinations {
  inArea(conversationId: string, area: ObjectReference, project: ObjectReference): Promise<boolean>;
}

type HostRecords = Awaited<ReturnType<AuthorityMediator["inspectHostRecords"]>>;

const match = destinationMatch;
const lower = (text: string): string => text.trim().toLocaleLowerCase();
const labelOf = (object: ReleasedObject): string => typeof object.value.label === "string" ? object.value.label : "";
const projectNames = (label: string): string[] => {
  const path = label.split(PROJECT_LABEL_SEPARATOR);
  return [path.slice(1).join(PROJECT_LABEL_SEPARATOR), path.at(-1) ?? ""].map(lower);
};

function activeRestriction(records: HostRecords, area: ObjectReference) {
  const restrictions = Object.values(records.records).flatMap(history => {
    const record = history.at(-1);
    return record?.kind === "restriction" && record.value.status === "active" && canonicalWire(record.value.source) === canonicalWire(area) ? [record.value] : [];
  });
  return restrictions.length === 1 ? restrictions[0] : undefined;
}

async function releasedDestinations(options: BalanceDraftDestinationOptions, session: BalanceDraftReadSession): Promise<ReleasedObject[]> {
  const records = await options.authority.inspectHostRecords();
  let page: Promise<QueryPage> | undefined;
  const projected = await Promise.all(session.areas.map(async area => {
    const restriction = activeRestriction(records, area);
    if (!restriction) return [];
    const projection = await options.authority.projectHostData(session.context, options.connectionId, session.sink, async () => {
      const current = await (page ??= Promise.resolve(session.destinations()));
      return { objects: current.annotations.filter(annotation => annotation.destination.canonicalId === area.canonicalId).map(annotation => ({ ref: annotation.ref, destination: annotation.destination, value: readPointer(current.payload, annotation.pointer) ?? null })) };
    }, [{ capabilityId: BALANCE_DESTINATIONS_CAPABILITY, destinations: [area], sources: [{ ref: area, restrictionRef: restriction.restrictionRef }], policy: "cloud" }]);
    return projection.kind === "released" ? releasedObjects(projection.value).filter(object => object.ref.adapterId === "balance" && object.ref.connectionId === options.connectionId) : [];
  }));
  return projected.flat();
}

function matchObject(objects: ReleasedObject[], objectType: "area" | "project", label: string): DestinationMatch {
  const wanted = lower(label);
  const candidates = objects.filter(object => object.ref.objectType === objectType);
  const exact = candidates.filter(object => object.ref.canonicalId === label.trim() || lower(labelOf(object)) === wanted);
  if (exact.length || objectType === "area") return match(exact.map(object => object.ref));
  return match(candidates.filter(object => projectNames(labelOf(object)).includes(wanted)).map(object => object.ref));
}

export function balanceDraftDestinations(options: BalanceDraftDestinationOptions): BalanceDraftDestinations {
  function batch(): BalanceDraftDestinations {
    const conversations = new Map<string, Promise<ReleasedObject[]>>();
    const released = (conversationId: string): Promise<ReleasedObject[]> => {
      const held = conversations.get(conversationId);
      if (held) return held;
      const prepared = options.session(conversationId).then(session => session ? releasedDestinations(options, session) : []);
      conversations.set(conversationId, prepared);
      return prepared;
    };
    return {
      async resolve(request) {
        if (request.connectionId !== options.connectionId || !request.conversationId || request.capabilityId !== BALANCE_DESTINATIONS_CAPABILITY || request.objectType !== "area" && request.objectType !== "project") return { kind: "unavailable" };
        const label = request.label.trim();
        if (!label) return { kind: "none" };
        const objects = await released(request.conversationId);
        return objects.length ? matchObject(objects, request.objectType, label) : { kind: "unavailable" };
      },
      async inArea(conversationId, area, project) {
        const found = (await released(conversationId)).find(object => canonicalWire(object.ref) === canonicalWire(project));
        return found !== undefined && canonicalWire(found.destination) === canonicalWire(area);
      },
    };
  }
  return { ...batch(), batch };
}
