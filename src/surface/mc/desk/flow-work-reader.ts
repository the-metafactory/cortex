import { flowQuerySource } from "../../../conversations/domain-adapters/flow/queries";
import { flowName } from "../../../conversations/domain-adapters/flow/schema";
import { QUERY_LIMITS } from "../../../conversations/domain-adapters/reads/query-types";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import { SEARCH_MAX_LIMIT, SEARCH_MAX_OFFSET, type WorkObject, type WorkPage, type WorkRead, type WorkReader } from "../../../conversations/tools/work-context";
import type { Policy } from "../../../conversations/types";
import { runCreatedHostQuery, runHostQuery, type HostQueryRunner } from "./query-run";
import { observedAtOf, releasedObjects, type ReleasedObject } from "./work-released";

export interface FlowWorkRunner extends HostQueryRunner {
  readonly destination: ObjectReference;
  readonly policy: () => Policy;
}

export const FLOW_SEARCH_MAX_SCANNED = Math.ceil((SEARCH_MAX_OFFSET + SEARCH_MAX_LIMIT + 1) / QUERY_LIMITS.pageItems) * QUERY_LIMITS.pageItems;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const toObject = (config: FlowWorkRunner, object: ReleasedObject): WorkObject => ({
  kind: "flow", id: object.ref.canonicalId, title: text(object.value.name), status: "saved",
  summary: text(object.value.yaml), policy: config.policy(), area: null,
  url: "?routines=flows", observedAt: observedAtOf(object, Date.now()),
});
const objectsOf = (config: FlowWorkRunner, released: Parameters<typeof releasedObjects>[0] | undefined): ReleasedObject[] => released === undefined ? [] : releasedObjects(released).filter(object =>
  object.ref.adapterId === "flow" && object.ref.connectionId === config.destination.connectionId && object.ref.objectType === "saved"
);

export function flowWorkReaders(config: FlowWorkRunner): { flow: WorkReader } {
  const read = async (id: string): Promise<WorkRead> => {
    if (!flowName.safeParse(id).success) return { state: "unavailable", reason: "unavailable" };
    const run = await runHostQuery(config, flowQuerySource(config.destination.connectionId, config.destination, "flow.saved.read", id));
    if (run.result.restricted || run.result.status === "denied") return { state: "unavailable", reason: "unauthorized" };
    if (run.result.status === "ok" && run.released !== undefined && run.result.noMatch) return { state: "unavailable", reason: "not-found" };
    const object = objectsOf(config, run.released).find(candidate => candidate.ref.canonicalId === id);
    return run.result.status === "ok" && object ? { state: "available", object: toObject(config, object) } : { state: "unavailable", reason: "unavailable" };
  };
  const search = async (needle: string, limit: number, offset: number): Promise<WorkPage> => {
    const request = await config.runner.create(config.context, [flowQuerySource(config.destination.connectionId, config.destination, "flow.saved.query")], config.sink);
    const items: WorkObject[] = [];
    const wanted = needle.trim().toLowerCase();
    let continuation: string | undefined;
    let scanned = 0;
    for (;;) {
      const run = await runCreatedHostQuery(config, { ...request, ...(continuation ? { continuation } : {}) });
      if (run.result.restricted || run.result.status === "denied") return { items: [], more: false, status: "denied", restricted: true, noMatch: false };
      if (run.result.status !== "ok" && run.result.status !== "partial" || run.released === undefined) return { items: [], more: false, status: "unavailable", noMatch: false };
      const objects = objectsOf(config, run.released);
      scanned += objects.length;
      items.push(...objects.filter(object => object.ref.canonicalId.toLowerCase().includes(wanted)).map(object => toObject(config, object)));
      continuation = run.result.continuation;
      const more = continuation !== undefined;
      const bounded = scanned >= FLOW_SEARCH_MAX_SCANNED;
      if (!more || items.length > offset + limit || bounded || objects.length === 0) {
        const incomplete = more || run.result.status === "partial";
        return {
          items: items.slice(offset, offset + limit), more: more || items.length > offset + limit,
          status: incomplete ? "partial" : "ok", coverage: incomplete ? "more" : "exhausted", noMatch: !incomplete && items.length === 0,
          ...(bounded && more ? { coverageLimit: `Search inspected at most ${FLOW_SEARCH_MAX_SCANNED} saved Flows in provider order.` } : {}),
        };
      }
    }
  };
  return { flow: { search, read } };
}
