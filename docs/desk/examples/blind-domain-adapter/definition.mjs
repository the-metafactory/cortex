export const adapterId = "kiln-studio";
export const version = "1.0.0";
export const schemaRef = name => ({ schemaId: `${adapterId}.${name}`, version });
const text = { type: "string", minLength: 1, maxLength: 500 };
const object = properties => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const reference = object({ adapterId: { type: "string", const: adapterId }, connectionId: text, objectType: { type: "string", const: "kiln" }, canonicalId: text });
const schemas = {
  empty: object({}),
  error: object({ code: text, message: text }),
  kiln: object({ name: text, chamberLitres: { type: "integer", minimum: 1 } }),
  firing: object({
    batchName: { ...text, default: "Community mugs" },
    programme: { type: "string", enum: ["bisque-04", "glaze-6"], default: "glaze-6" },
    loadNotes: { ...text, default: "Keep handles clear of kiln furniture." },
    kiln: reference,
  }),
  kilns: object({ items: { type: "array", items: { $ref: "urn:desk-schema:kiln-studio.kiln:1.0.0" } } }),
  firings: object({ items: { type: "array", items: { $ref: "urn:desk-schema:kiln-studio.firing:1.0.0" } } }),
  created: object({ ref: object({ ...reference.properties, objectType: { type: "string", const: "firing" } }) }),
};
const capability = (name, kind, objectType, input, output) => ({ capabilityId: `${adapterId}.${name}`, label: name, kind, objectTypes: [objectType], inputSchemaRef: schemaRef(input), outputSchemaRef: schemaRef(output), errorSchemaRef: schemaRef("error") });
export const declaration = {
  adapterId, label: "Ceramic kiln studio", contractRange: "^1.0.0",
  schemas: Object.entries(schemas).map(([name, schema]) => ({ ...schemaRef(name), schema: { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema } })),
  objectTypes: [
    { objectType: "kiln", label: "Kiln", schemaRef: schemaRef("kiln"), relationships: [] },
    { objectType: "firing", label: "Firing", schemaRef: schemaRef("firing"), relationships: [{ fieldPath: "/kiln", cardinality: "one", targetAdapterId: adapterId, targetObjectType: "kiln" }] },
  ],
  capabilities: [
    capability("kiln.list", "query", "kiln", "empty", "kilns"),
    capability("firing.list", "query", "firing", "empty", "firings"),
    capability("firing.watch", "observation", "firing", "empty", "firings"),
    capability("firing.create", "action", "firing", "firing", "created"),
  ],
};
const read = (name, mode, objectType, output, title) => ({ version, adapterId, capabilityId: `${adapterId}.${name}`, mode, objectType, inputSchemaRef: schemaRef("empty"), outputSchemaRef: schemaRef(output), display: { title } });
export const readBindings = [
  read("kiln.list", "destinations", "kiln", "kilns", "/name"),
  { ...read("firing.list", "query", "firing", "firings", "/batchName"), destinationType: "kiln", query: { objectsPointer: "/items", ordering: "provider", stableSnapshot: true, limits: { items: 2 } } },
  { ...read("firing.watch", "poll", "firing", "firings", "/batchName"), destinationType: "kiln", observation: { modes: ["poll"], objectsPointer: "/items", resumable: false } },
];
export const draftingBindings = [{
  bindingVersion: version, adapterId, capabilityId: "kiln-studio.firing.create", inputSchemaRef: schemaRef("firing"),
  guidance: { guidanceId: "kiln-studio.firing.guidance", version, instructions: "Draft a ceramic firing record from the conversation. Ask which kiln to use. Record the batch name, choose bisque-04 or glaze-6, and describe the load. This records a plan and does not operate kiln hardware." },
  fieldHints: [
    { pointer: "/batchName", role: "title" },
    { pointer: "/programme", role: "summary" },
    { pointer: "/loadNotes", role: "detail", widget: "long" },
    { pointer: "/kiln", role: "destination", resolveWith: "kiln-studio.kiln.list" },
  ],
}];
export const setup = {
  version, schemas: [{ schemaId: "kiln-studio.settings", version, schema: { $schema: "https://json-schema.org/draft/2020-12/schema", ...object({}) } }],
  configurationSchemaRef: { schemaId: "kiln-studio.settings", version }, accountScopeSchemaRef: { schemaId: "kiln-studio.settings", version }, authMethods: [{ kind: "local" }],
};
