import type { Json } from "../../../conversations/domain-adapters/operations/types";
import { readPointer } from "../../../conversations/domain-adapters/reads/query-validation";
import type { QueryPage } from "../../../conversations/domain-adapters/reads/query-types";
import type { ReadBinding } from "../../../conversations/domain-adapters/reads/types";
import type { ObjectReference, SchemaRef } from "../../../conversations/domain-adapters/types";
import type { BalanceSurfaceDestinations, BalanceSurfaceFacts, BalanceSurfaceTask } from "./balance-surface-schema";
import { runHostQuery, type HostQueryRun, type HostQueryRunner } from "./query-run";
import { objectReference, releasedObjects } from "./work-released";

const BALANCE = "balance";
const TASK_READ = "balance.task.read";

export interface BalanceSurfaceSource {
  readonly connectionId: string;
  readonly enabled: () => boolean;
  readonly destinations: () => QueryPage | Promise<QueryPage>;
  readonly readTask: (request: { input: Json; destinations: readonly ObjectReference[] }) => Promise<HostQueryRun>;
  readonly display: ReadBinding["display"];
}
export type BalanceSurfaceAccess = () => BalanceSurfaceReader | null;

export interface BalanceSurfaceReader {
  destinations(): Promise<BalanceSurfaceDestinations>;
  task(ref: string, area: string | undefined): Promise<BalanceSurfaceTask>;
}
export interface BalanceSurfaceRunner extends HostQueryRunner {
  readonly connectionId: string;
  readonly inputSchemaRef: SchemaRef;
}

export function balanceSurfaceRun(config: BalanceSurfaceRunner): BalanceSurfaceSource["readTask"] {
  return request => runHostQuery(config, {
    adapterId: BALANCE,
    connectionId: config.connectionId,
    capabilityId: TASK_READ,
    inputSchemaRef: config.inputSchemaRef,
    destinations: [...request.destinations],
    input: request.input,
  });
}

type Listed = Extract<BalanceSurfaceDestinations, { enabled: true }>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: Json | undefined): string | null => typeof value === "string" && value.length > 0 ? value : null;
const pointed = (value: Json, pointer: string | undefined): string | null => pointer === undefined ? null : text(readPointer(value, pointer));
const areaReference = (connectionId: string, canonicalId: string): ObjectReference => ({ adapterId: BALANCE, connectionId, objectType: "area", canonicalId });

function pageEntries(page: QueryPage): { id: string; objectType: string; destination: string; label: string }[] {
  const items = isRecord(page.payload) && Array.isArray(page.payload.items) ? page.payload.items : [];
  return page.annotations.map((annotation, index) => {
    const item = items[index];
    const label = isRecord(item) ? text(item.label) : null;
    return { id: annotation.ref.canonicalId, objectType: annotation.ref.objectType, destination: annotation.destination.canonicalId, label: label ?? annotation.ref.canonicalId };
  });
}

const pathOf = (label: string, area: string | null): string[] => {
  const trimmed = area !== null && label.startsWith(`${area} / `) ? label.slice(area.length + 3) : label;
  return trimmed.split(" / ");
};

function factsOf(value: Json, display: ReadBinding["display"], choices: Listed): BalanceSurfaceFacts | null {
  const title = pointed(value, display.title);
  if (title === null) return null;
  const areaRef = objectReference(readPointer(value, display.area ?? "/area"));
  const area = areaRef === null ? undefined : choices.areas.find(candidate => candidate.ref === areaRef.canonicalId);
  const projectRef = objectReference(readPointer(value, "/project"));
  const project = projectRef === null ? undefined : choices.projects.find(candidate => candidate.ref === projectRef.canonicalId);
  const effort = readPointer(value, "/effort");
  return {
    title,
    due: pointed(value, display.due),
    area: area?.label ?? null,
    project: project === undefined ? null : pathOf(project.label, area?.label ?? null).join(" / "),
    note: pointed(value, "/note"),
    effort: typeof effort === "number" ? effort : null,
  };
}

export function createBalanceSurfaceReader(source: BalanceSurfaceSource): BalanceSurfaceReader {
  const listed = async (): Promise<Listed> => {
    const entries = pageEntries(await source.destinations());
    return {
      enabled: true,
      areas: entries.filter(entry => entry.objectType === "area").map(entry => ({ ref: entry.id, label: entry.label })),
      projects: entries.filter(entry => entry.objectType === "project").map(entry => ({ ref: entry.id, label: entry.label, area: entry.destination })),
    };
  };
  const read = async (ref: string, area: string | undefined): Promise<BalanceSurfaceTask & { enabled: true }> => {
    const wanted = ref.trim();
    const owned = (area ?? "").trim();
    if (wanted.length === 0 || owned.length === 0) return { enabled: true, state: "unavailable" };
    const choices = await listed();
    if (!choices.areas.some(candidate => candidate.ref === owned)) return { enabled: true, state: "withheld" };
    const run = await source.readTask({
      input: { ref: { adapterId: BALANCE, connectionId: source.connectionId, objectType: "task", canonicalId: wanted } },
      destinations: [areaReference(source.connectionId, owned)],
    });
    if (run.result.status === "denied" || run.result.restricted) return { enabled: true, state: "withheld" };
    const object = run.result.status === "ok" ? releasedObjects(run.released ?? {}).find(entry => entry.ref.objectType === "task" && entry.ref.canonicalId === wanted) : undefined;
    const facts = object === undefined ? null : factsOf(object.value as Json, source.display, choices);
    return facts === null ? { enabled: true, state: "unavailable" } : { enabled: true, state: "available", ...facts };
  };
  return {
    async destinations() {
      if (!source.enabled()) return { enabled: false };
      return await listed();
    },
    async task(ref, area) {
      if (!source.enabled()) return { enabled: false };
      return await read(ref, area).catch((): BalanceSurfaceTask => ({ enabled: true, state: "unavailable" }));
    },
  };
}
