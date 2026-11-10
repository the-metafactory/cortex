import { authorityRig } from "../../authority-fixtures";
import { DomainAdapterRegistry } from "../registry";
import { balanceDeclaration, fixtureBindings, objectRef, objectSchema } from "../fixtures";
import { ReadBindingSchema, type ReadBinding } from "./types";
import type { ObservationBatch, ObservationConnector, ObservationRequest, ObservationView } from "./observation-types";
import { controlledQueryClock, queryArea } from "./query-fixtures";
import type { QuerySource } from "./query-types";
import { AT } from "../operations/fixtures";

export const observationBinding = ReadBindingSchema.parse({ version: "1.0.0", adapterId: "balance", capabilityId: "balance.object.read", mode: "poll", objectType: "task", inputSchemaRef: { schemaId: "balance.task.create.input", version: "1.0.0" }, outputSchemaRef: { schemaId: "balance.observation.output", version: "1.0.0" }, destinationType: "area", display: { title: "/title" }, observation: { modes: ["poll", "subscription"], objectsPointer: "/items", resumable: true, ordering: "synthetic-integers" } });
export function observationRegistry() {
  const registry = new DomainAdapterRegistry();
  const declaration = balanceDeclaration();
  const creation = declaration.capabilities[0];
  if (!creation) throw new Error("Synthetic capability missing.");
  declaration.schemas.push({ ...observationBinding.outputSchemaRef, schema: objectSchema({ items: { type: "array", items: { $ref: "urn:desk-schema:balance.task.create.input:1.0.0" } } }) as (typeof declaration.schemas)[number]["schema"] });
  declaration.capabilities.push({ ...creation, kind: "observation", capabilityId: observationBinding.capabilityId, outputSchemaRef: observationBinding.outputSchemaRef });
  const registered = registry.register(declaration, fixtureBindings(declaration));
  if (!registered.ok) throw new Error(registered.error.code);
  return registry;
}
export function syntheticObservation(id = "task-example", title = "Synthetic task", revision = "1", evidenceId = "evidence-example"): ObservationBatch {
  return structuredClone({ version: "1.0.0", payload: { items: [{ title, area: queryArea }] }, events: [{ kind: "present", pointer: "/items/0", ref: objectRef("balance", "task", id), schemaRef: observationBinding.inputSchemaRef, destination: queryArea, observedAt: AT, revision, evidenceId }], gap: false, coverage: "objects", checkpoint: { cursor: "synthetic protected checkpoint", expiresAt: Date.parse(AT) + 86400000 } });
}
export function syntheticDeletion(id = "task-example", revision = "2"): ObservationBatch {
  return structuredClone({ version: "1.0.0", payload: { items: [] }, events: [{ kind: "deleted", ownerDeletion: true, ref: objectRef("balance", "task", id), schemaRef: observationBinding.inputSchemaRef, destination: queryArea, observedAt: AT, revision, evidenceId: `deletion-${id}` }], gap: false, coverage: "objects" });
}
export async function observationRig(binding: ReadBinding = observationBinding) {
  const time = controlledQueryClock();
  const requests: ObservationRequest[] = [];
  const hooks: { fetch(request: ObservationRequest, signal: AbortSignal): Promise<unknown> } = { fetch: () => Promise.resolve(syntheticObservation()) };
  const connector: ObservationConnector = { modes: ["poll", "subscription"], ...(binding.observation?.ordering ? { ordering: { id: binding.observation.ordering, compare(left: string, right: string) { const a = Number(left); const b = Number(right); return !Number.isSafeInteger(a) || !Number.isSafeInteger(b) ? "incomparable" : a < b ? "older" : a > b ? "newer" : "same"; } } } : {}), fetch(request, signal) { requests.push(request); return hooks.fetch(request, signal); } };
  const rig = await authorityRig({}, "local", { registry: observationRegistry(), binding, observation: connector });
  const source: QuerySource = { adapterId: "balance", connectionId: rig.connection.connectionId, capabilityId: binding.capabilityId, inputSchemaRef: binding.inputSchemaRef, destinations: [queryArea], input: { title: "Synthetic observation", area: queryArea } };
  return { rig, source, time, hooks, requests, get store() { return rig.host.readObservations(rig.registry, rig.bindings, time.clock); } };
}
export async function observationViews(item: Awaited<ReturnType<typeof observationRig>>, history = false): Promise<ObservationView[]> {
  const released = await item.store.read(item.rig.context, item.source, item.rig.sink, history);
  if (released.kind !== "released") throw new Error("Synthetic observations withheld.");
  return (released.value as unknown as { objects: ObservationView[] }).objects;
}
