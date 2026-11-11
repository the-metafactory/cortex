import { randomUUID } from "node:crypto";
import type { ConnectionRecord, RestrictionRecord } from "../../../../conversations/authority-records";
import { authorityRig } from "../../../../conversations/authority-fixtures";
import { DomainAdapterRegistry } from "../../../../conversations/domain-adapters/registry";
import { fixtureBindings, objectSchema, referenceDeclaration, referenceSchema } from "../../../../conversations/domain-adapters/fixtures";
import { ReadBindingSchema } from "../../../../conversations/domain-adapters/reads/types";
import { controlledQueryClock } from "../../../../conversations/domain-adapters/reads/query-fixtures";
import type { QuerySource } from "../../../../conversations/domain-adapters/reads/query-types";
import type { ObservationBatch, ObservationMode } from "../../../../conversations/domain-adapters/reads/observation-types";
import type { Json } from "../../../../conversations/domain-adapters/operations/types";
import type { AdapterDeclaration, ObjectReference } from "../../../../conversations/domain-adapters/types";
import type { AdapterAttention } from "../adapter-items";
import type { DeskOptions } from "../compose";

export const ATTENTION_DESK: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", sources: [], areas: [{ id: "lab", label: "Lab", color: "#345678", repos: [], goals: [] }] };

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("The synthetic attention fixture is incomplete.");
  return value;
}

export interface AttentionOptions { rowCapabilities?: { granted: boolean }; owner?: string }

function syntheticAdapter(adapterId: string, rowCapability: boolean, owner?: string) {
  const declaration = JSON.parse(JSON.stringify(referenceDeclaration("observation")).replaceAll("reference-feed", adapterId)) as AdapterDeclaration;
  const capability = required(declaration.capabilities[0]);
  const schemaRef = { schemaId: `${adapterId}.object`, version: "1.0.0" };
  declaration.schemas.push({ ...schemaRef, schema: objectSchema({
    "display/data": objectSchema({
      "title~text": { type: "string" }, reason: { type: ["string", "number"] }, due: { type: ["string", "null"] },
      area: { anyOf: [referenceSchema(adapterId, "document"), { type: "null" }] }, url: { type: ["string", "null"] },
      owner: { type: "string" },
    }, ["title~text"]),
    score: { type: "number" }, urgency: { type: "string" }, attention: { type: "string" }, interrupt: { type: "boolean" }, notification: { type: "boolean" }, actions: { type: "array", items: { type: "string" } },
  }, ["display/data"]) as AdapterDeclaration["schemas"][number]["schema"] });
  required(declaration.objectTypes[0]).schemaRef = schemaRef;
  required(declaration.schemas.find(schema => schema.schemaId === capability.outputSchemaRef.schemaId)).schema = objectSchema({ items: { type: "array", items: { $ref: `urn:desk-schema:${schemaRef.schemaId}:1.0.0` } } }) as AdapterDeclaration["schemas"][number]["schema"];
  const binding = ReadBindingSchema.parse({
    version: "1.0.0", adapterId, capabilityId: capability.capabilityId, mode: "poll", objectType: "document", inputSchemaRef: capability.inputSchemaRef, outputSchemaRef: capability.outputSchemaRef, destinationType: "document",
    display: { title: "/display~1data/title~0text", due: "/display~1data/due", area: "/display~1data/area", url: "/display~1data/url" },
    attention: { pointer: "/display~1data/reason", ...(owner === undefined ? {} : { owner: "/display~1data/owner" }) },
    ...(rowCapability ? { capabilities: [{ capabilityId: `${adapterId}.complete`, label: "Complete" }] } : {}),
    observation: { modes: ["poll"], objectsPointer: "/items", resumable: false },
  });
  return { declaration, binding, schemaRef };
}

export async function attentionRig(policy: "local" | "cloud" = "local", options: AttentionOptions = {}) {
  const rowCapability = options.rowCapabilities !== undefined;
  const adapters = [syntheticAdapter("synthetic-one", rowCapability, options.owner), syntheticAdapter("synthetic-two", rowCapability, options.owner)];
  const registry = new DomainAdapterRegistry();
  for (const adapter of adapters) {
    const result = registry.register(adapter.declaration, fixtureBindings(adapter.declaration));
    if (!result.ok) throw new Error(result.error.code);
  }
  const time = controlledQueryClock();
  const batches = new Map<string, ObservationBatch>();
  let fetches = 0;
  const connector = { modes: ["poll"] as const, fetch(request: { source: QuerySource }) { fetches++; return Promise.resolve(batches.get(request.source.adapterId)); } };
  const first = required(adapters[0]);
  const rig = await authorityRig({}, policy, { registry, binding: first.binding, adapterId: first.binding.adapterId, capabilityIds: [first.binding.capabilityId], observation: connector });
  const sources: QuerySource[] = [];
  const connections: ConnectionRecord[] = [];
  const restrictions: RestrictionRecord[] = [];
  for (const [index, adapter] of adapters.entries()) {
    const connectionId = index === 0 ? rig.connection.connectionId : "synthetic-second-connection";
    const destination: ObjectReference = { adapterId: adapter.binding.adapterId, connectionId, objectType: "document", canonicalId: "lab" };
    const writeCapabilityIds = options.rowCapabilities?.granted === true ? [`${adapter.binding.adapterId}.complete`] : [];
    const connection = { ...rig.connection, connectionId, adapterId: adapter.binding.adapterId, readCapabilityIds: [adapter.binding.capabilityId], readDestinations: [destination], writeCapabilityIds, writeDestinations: writeCapabilityIds.length > 0 ? [destination] : [], connectionRevision: index === 0 ? "2" : "1" };
    connections.push(connection);
    await rig.service.publishHostRecord({ kind: "connection", value: connection }, index === 0 ? 1 : 0);
    const restriction = { ...rig.objectRestriction, restrictionRef: randomUUID(), source: destination };
    restrictions.push(restriction);
    await rig.service.publishHostRecord({ kind: "restriction", value: restriction }, 0);
    if (index > 0) {
      const result = rig.readBindings.register(adapter.binding, { adapterId: adapter.binding.adapterId, connectionId, readCapabilityIds: connection.readCapabilityIds });
      if (!result.ok) throw new Error(result.error.code);
    }
    sources.push({ adapterId: adapter.binding.adapterId, connectionId, capabilityId: adapter.binding.capabilityId, inputSchemaRef: adapter.binding.inputSchemaRef, destinations: [destination], input: {} });
  }
  const store = rig.host.readObservations(registry, rig.bindings, time.clock);
  const feature: AdapterAttention = { enabled: true, store, bindings: rig.readBindings, context: rig.context, sink: rig.sink, sources };
  const batch = (index: number, objects: Json[], offset = 0): ObservationBatch => {
    const source = required(sources[index]);
    return { version: "1.0.0", payload: { items: objects }, events: objects.map((_value, item) => ({ kind: "present", pointer: `/items/${item}`, ref: { adapterId: source.adapterId, connectionId: source.connectionId, objectType: "document", canonicalId: `item-${item + offset}` }, schemaRef: required(adapters[index]).schemaRef, destination: required(source.destinations[0]), observedAt: new Date(time.clock.now()).toISOString(), revision: "1" })), gap: false, coverage: "objects" };
  };
  const value = (index: number, title = "Synthetic review", due: string | null = "2026-11-01"): Json => ({ "display/data": { "title~text": title, reason: "Review the synthetic observation.", due, area: required(required(sources[index]).destinations[0]), url: "https://example.test/synthetic", ...(options.owner === undefined ? {} : { owner: options.owner }) } });
  async function ingest(index: number, objects: Json[] = [value(index)], mode: ObservationMode = "resync", offset = 0) {
    const source = required(sources[index]);
    batches.set(source.adapterId, batch(index, objects, offset));
    return store.check(rig.context, source, rig.sink, mode);
  }
  async function revoke(index = 0) {
    const connection = required(connections[index]);
    const revision = Number(connection.connectionRevision);
    connection.connectionRevision = String(revision + 1);
    connection.readCapabilityIds = [];
    await rig.service.publishHostRecord({ kind: "connection", value: connection }, revision);
  }
  async function remove(index = 0) {
    const source = required(sources[index]);
    const deletion = batch(index, [value(index)]);
    const event = required(deletion.events[0]);
    deletion.payload = { items: [] };
    deletion.events = [{ kind: "deleted", ownerDeletion: true, evidenceId: "synthetic-owner-deletion", ref: event.ref, schemaRef: event.schemaRef, destination: event.destination, observedAt: event.observedAt, revision: "2" }];
    batches.set(source.adapterId, deletion);
    return store.check(rig.context, source, rig.sink);
  }
  return { rig, time, store, feature, sources, adapters, restrictions, ingest, revoke, remove, value, capabilityOf: (index = 0) => `${required(adapters[index]).binding.adapterId}.complete`, get fetches() { return fetches; } };
}
