import type { AdapterBindings, AdapterDeclaration, ObjectReference } from "./types";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
export const objectRef = (adapterId: string, objectType: string, canonicalId: string): ObjectReference => ({ adapterId, connectionId: "connection-example", objectType, canonicalId });
const text = { type: "string", minLength: 1 };
export const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({ $schema: DIALECT, type: "object", properties, required, additionalProperties: false });
export const referenceSchema = (adapterId: string, objectType: string): Record<string, unknown> => objectSchema({ adapterId: { type: "string", const: adapterId }, connectionId: text, objectType: { type: "string", const: objectType }, canonicalId: text });
const ref = (schemaId: string) => ({ schemaId, version: "1.0.0" });

function declaration(adapterId: string, capabilityId: string, kind: "action" | "query" | "observation", properties: Record<string, unknown>, required: string[], objectType: string): AdapterDeclaration {
  const inputId = `${capabilityId}.input`;
  const outputId = `${capabilityId}.output`;
  const errorId = `${adapterId}.error`;
  return {
    adapterId, label: adapterId, contractRange: "^1.0.0",
    schemas: [
      { ...ref(inputId), schema: objectSchema(properties, required) as AdapterDeclaration["schemas"][number]["schema"] },
      { ...ref(outputId), schema: objectSchema({ ref: referenceSchema(adapterId, objectType), url: { type: "string", format: "uri" } }, ["ref"]) as AdapterDeclaration["schemas"][number]["schema"] },
      { ...ref(errorId), schema: objectSchema({ code: { type: "string", pattern: `^${adapterId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\..+$` }, message: text, issues: { type: "array", items: objectSchema({ path: { type: "string" }, code: text, message: text }) } }, ["code", "message"]) as AdapterDeclaration["schemas"][number]["schema"] },
    ],
    objectTypes: [{ objectType, label: objectType, schemaRef: ref(inputId), relationships: [] }],
    capabilities: [{ capabilityId, label: capabilityId, kind, objectTypes: [objectType], inputSchemaRef: ref(inputId), outputSchemaRef: ref(outputId), errorSchemaRef: ref(errorId) }],
  };
}

export function balanceDeclaration(): AdapterDeclaration {
  const result = declaration("balance", "balance.task.create", "action", {
    area: referenceSchema("balance", "area"), project: referenceSchema("balance", "project"), title: text,
    note: { type: "string" }, due: { type: "string", format: "date" }, done: { type: "boolean" }, estimate: { type: "number" }, tags: { type: "array", items: { type: "string" } }, priority: { type: "string", default: "normal" },
  }, ["area", "title"], "task");
  const task = result.objectTypes[0];
  if (!task) throw new Error("Task fixture must declare its object type.");
  task.relationships = ["area", "project"].map(target => ({ fieldPath: `/${target}`, targetAdapterId: "balance", targetObjectType: target, cardinality: "one" }));
  for (const type of ["area", "project"]) {
    const schemaId = `balance.${type}`;
    result.schemas.push({ ...ref(schemaId), schema: referenceSchema("balance", type) as AdapterDeclaration["schemas"][number]["schema"] });
    result.objectTypes.push({ objectType: type, label: type, schemaRef: ref(schemaId), relationships: [] });
  }
  return result;
}

export function graphDeclaration(): AdapterDeclaration {
  const result = declaration("work-graph", "work-graph.node.create", "action", { repository: text, parent: referenceSchema("work-graph", "node"), title: text, checkpoint: text, body: { type: "string" }, dependencies: { type: "array", items: referenceSchema("work-graph", "node") } }, ["repository", "parent", "title", "checkpoint"], "node");
  const node = result.objectTypes[0];
  if (!node) throw new Error("Graph fixture must declare a node.");
  node.relationships = [{ fieldPath: "/parent", targetAdapterId: "work-graph", targetObjectType: "node", cardinality: "one" }, { fieldPath: "/dependencies", targetAdapterId: "work-graph", targetObjectType: "node", cardinality: "many" }];
  return result;
}

export function referenceDeclaration(kind: "query" | "observation"): AdapterDeclaration {
  const adapterId = kind === "query" ? "reference-library" : "reference-feed";
  return declaration(adapterId, `${adapterId}.document.${kind === "query" ? "get" : "observe"}`, kind, kind === "query" ? { ref: referenceSchema(adapterId, "document") } : {}, kind === "query" ? ["ref"] : [], "document");
}

export function fixtureBindings(adapter: AdapterDeclaration): AdapterBindings {
  return {
    handlers: Object.fromEntries(adapter.capabilities.filter(capability => capability.kind === "query").map(capability => [capability.capabilityId, () => { throw new Error("Synthetic handlers must not execute."); }])),
    observations: Object.fromEntries(adapter.capabilities.filter(capability => capability.kind === "observation").map(capability => [capability.capabilityId, { fixture: true }])),
  };
}
