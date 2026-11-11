const adapterId = "archive";
const version = "1.0.0";
const schemaRef = name => ({ schemaId: `${adapterId}.${name}`, version });
const string = { type: "string", minLength: 1 };
const object = properties => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const reference = object({ adapterId: { const: adapterId, type: "string" }, connectionId: string, objectType: { const: "shelf", type: "string" }, canonicalId: string });
const schemas = {
  empty: object({}),
  error: object({ code: string, message: string }),
  shelf: object({ title: string }),
  record: object({ title: string, shelf: reference }),
  shelves: object({ items: { type: "array", items: { $ref: "urn:desk-schema:archive.shelf:1.0.0" } } }),
  records: object({ items: { type: "array", items: { $ref: "urn:desk-schema:archive.record:1.0.0" } } }),
  created: object({ ref: object({ ...reference.properties, objectType: { type: "string", const: "record" } }) }),
};
const capability = (name, kind, objectType, input, output) => ({ capabilityId: `${adapterId}.${name}`, label: name, kind, objectTypes: [objectType], inputSchemaRef: schemaRef(input), outputSchemaRef: schemaRef(output), errorSchemaRef: schemaRef("error") });

export const declaration = {
  adapterId, label: "Archive", contractRange: "^1.0.0",
  schemas: Object.entries(schemas).map(([name, schema]) => ({ ...schemaRef(name), schema })),
  objectTypes: [
    { objectType: "shelf", label: "Shelf", schemaRef: schemaRef("shelf"), relationships: [] },
    { objectType: "record", label: "Record", schemaRef: schemaRef("record"), relationships: [{ fieldPath: "/shelf", cardinality: "one", targetAdapterId: adapterId, targetObjectType: "shelf" }] },
  ],
  capabilities: [
    capability("shelf.list", "query", "shelf", "empty", "shelves"),
    capability("record.list", "query", "record", "empty", "records"),
    capability("record.watch", "observation", "record", "empty", "records"),
    capability("record.create", "action", "record", "record", "created"),
  ],
};
const read = (name, mode, objectType, output) => ({ version, adapterId, capabilityId: `${adapterId}.${name}`, mode, objectType, inputSchemaRef: schemaRef("empty"), outputSchemaRef: schemaRef(output), display: { title: "/title" } });
export const readBindings = [
  read("shelf.list", "destinations", "shelf", "shelves"),
  { ...read("record.list", "query", "record", "records"), destinationType: "shelf", query: { objectsPointer: "/items", ordering: "provider", stableSnapshot: true, limits: { items: 2 } } },
  { ...read("record.watch", "poll", "record", "records"), destinationType: "shelf", observation: { modes: ["poll"], objectsPointer: "/items", resumable: false } },
];
export const draftingBindings = [{
  bindingVersion: version, adapterId, capabilityId: "archive.record.create", inputSchemaRef: schemaRef("record"),
  guidance: { guidanceId: "archive.record.guidance", version, instructions: "Draft an archive record from the conversation. Ask which shelf to use." },
  fieldHints: [{ pointer: "/title", role: "title" }, { pointer: "/shelf", role: "destination", resolveWith: "archive.shelf.list" }],
}];
export const setup = {
  version, schemas: [{ schemaId: "archive.settings", version, schema: object({}) }],
  configurationSchemaRef: { schemaId: "archive.settings", version }, accountScopeSchemaRef: { schemaId: "archive.settings", version },
  authMethods: [{ kind: "local" }],
};
