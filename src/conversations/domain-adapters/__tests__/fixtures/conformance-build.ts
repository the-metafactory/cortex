import { createHash } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ConformanceDomain {
  adapterId: string;
  label: string;
  place: { type: string; label: string; rows: { id: string; name: string }[] };
  item: { type: string; label: string; verb: string; rows: { id: string; name: string; place: string; note?: string }[] };
  writable: boolean;
}

export type ConformanceVariant =
  | "valid"
  | "throws"
  | "mismatch"
  | "bad-annotation"
  | "outside-destination"
  | "digest"
  | "format"
  | "symlink"
  | "token-only"
  | "broker-only";

export const CONFORMANCE_DOMAINS: Record<string, ConformanceDomain> = {
  greenhouse: {
    adapterId: "greenhouse", label: "Greenhouse",
    place: { type: "bench", label: "Bench", rows: [{ id: "bench-north", name: "North bench" }, { id: "bench-south", name: "South bench" }] },
    item: {
      type: "seedling", label: "Seedling", verb: "sow",
      rows: [
        { id: "seedling-1", name: "Basil", place: "bench-north", note: "Sown in spring." },
        { id: "seedling-2", name: "Chard", place: "bench-north" },
        { id: "seedling-3", name: "Dill", place: "bench-south" },
      ],
    },
    writable: true,
  },
  observatory: {
    adapterId: "observatory", label: "Observatory",
    place: { type: "dome", label: "Dome", rows: [{ id: "dome-east", name: "East dome" }, { id: "dome-west", name: "West dome" }] },
    item: {
      type: "viewing", label: "Viewing", verb: "book",
      rows: [
        { id: "viewing-1", name: "Saturn rings", place: "dome-east" },
        { id: "viewing-2", name: "Lunar craters", place: "dome-east", note: "Clear sky needed." },
        { id: "viewing-3", name: "Orion nebula", place: "dome-west" },
      ],
    },
    writable: true,
  },
  tideway: {
    adapterId: "tideway", label: "Tideway",
    place: { type: "estuary", label: "Estuary", rows: [{ id: "estuary-inner", name: "Inner estuary" }, { id: "estuary-outer", name: "Outer estuary" }] },
    item: {
      type: "gauge", label: "Gauge", verb: "read",
      rows: [
        { id: "gauge-1", name: "Spring tide mark", place: "estuary-inner" },
        { id: "gauge-2", name: "Neap tide mark", place: "estuary-inner" },
        { id: "gauge-3", name: "Storm surge mark", place: "estuary-outer" },
      ],
    },
    writable: false,
  },
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const ref = (schemaId: string) => ({ schemaId, version: "1.0.0" });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", additionalProperties: false, required, properties });
const text = { type: "string", minLength: 1 };

function ids(domain: ConformanceDomain) {
  const a = domain.adapterId;
  const item = domain.item.type;
  const place = domain.place.type;
  return {
    placeList: `${a}.${place}.list`, search: `${a}.${item}.search`, watch: `${a}.${item}.watch`, get: `${a}.${item}.get`, create: `${a}.${item}.${domain.item.verb}`,
    schemas: { empty: `${a}.empty`, error: `${a}.error`, place: `${a}.${place}`, placeOut: `${a}.${place}.list.output`, item: `${a}.${item}`, itemOut: `${a}.${item}.list.output`, find: `${a}.find.input`, getIn: `${a}.get.input`, created: `${a}.created` },
  };
}

function reference(domain: ConformanceDomain, objectType: string) {
  return object({ adapterId: { type: "string", const: domain.adapterId }, connectionId: text, objectType: { type: "string", const: objectType }, canonicalId: text }, ["adapterId", "connectionId", "objectType", "canonicalId"]);
}

export function conformanceDeclaration(domain: ConformanceDomain, label = domain.label) {
  const { schemas, ...capabilityIds } = ids(domain);
  const urn = (schemaId: string) => ({ $ref: `urn:desk-schema:${schemaId}:1.0.0` });
  const capability = (capabilityId: string, name: string, kind: string, objectTypes: string[], input: string, output: string) => ({
    capabilityId, label: name, kind, objectTypes, inputSchemaRef: ref(input), outputSchemaRef: ref(output), errorSchemaRef: ref(schemas.error),
  });
  const capabilities = [
    capability(capabilityIds.placeList, `List ${domain.place.label.toLowerCase()}s`, "query", [domain.place.type], schemas.empty, schemas.placeOut),
    capability(capabilityIds.search, `Find ${domain.item.label.toLowerCase()}s`, "query", [domain.item.type], schemas.find, schemas.itemOut),
    capability(capabilityIds.watch, `Watch ${domain.item.label.toLowerCase()}s`, "observation", [domain.item.type], schemas.empty, schemas.itemOut),
    ...(domain.writable ? [
      capability(capabilityIds.create, `${domain.item.verb} a ${domain.item.label.toLowerCase()}`, "action", [domain.item.type], schemas.item, schemas.created),
      capability(capabilityIds.get, `Read one ${domain.item.label.toLowerCase()}`, "query", [domain.item.type], schemas.getIn, schemas.item),
    ] : []),
  ];
  return {
    adapterId: domain.adapterId, label, contractRange: "^1.0.0",
    schemas: [
      { ...ref(schemas.empty), schema: object({}) },
      { ...ref(schemas.error), schema: object({ code: text, message: text }, ["code", "message"]) },
      { ...ref(schemas.place), schema: object({ name: text }, ["name"]) },
      { ...ref(schemas.placeOut), schema: object({ items: { type: "array", items: urn(schemas.place) } }, ["items"]) },
      { ...ref(schemas.item), schema: object({ name: { ...text, title: "Name" }, place: reference(domain, domain.place.type), note: { type: "string", title: "Note" } }, ["name", "place"]) },
      { ...ref(schemas.itemOut), schema: object({ items: { type: "array", items: urn(schemas.item) } }, ["items"]) },
      { ...ref(schemas.find), schema: object({ text: { type: "string" } }, ["text"]) },
      { ...ref(schemas.getIn), schema: object({ canonicalId: text }, ["canonicalId"]) },
      { ...ref(schemas.created), schema: object({ ref: reference(domain, domain.item.type) }, ["ref"]) },
    ],
    objectTypes: [
      { objectType: domain.place.type, label: domain.place.label, schemaRef: ref(schemas.place), relationships: [] },
      { objectType: domain.item.type, label: domain.item.label, schemaRef: ref(schemas.item), relationships: [{ fieldPath: "/place", cardinality: "one", targetAdapterId: domain.adapterId, targetObjectType: domain.place.type }] },
    ],
    capabilities,
  };
}

function readBindings(domain: ConformanceDomain) {
  const { schemas, ...capabilityIds } = ids(domain);
  const base = { version: "1.0.0", adapterId: domain.adapterId };
  return [
    { ...base, capabilityId: capabilityIds.placeList, mode: "destinations", objectType: domain.place.type, inputSchemaRef: ref(schemas.empty), outputSchemaRef: ref(schemas.placeOut), display: { title: "/name" } },
    { ...base, capabilityId: capabilityIds.search, mode: "query", objectType: domain.item.type, inputSchemaRef: ref(schemas.find), outputSchemaRef: ref(schemas.itemOut), textPointer: "/text", destinationType: domain.place.type, display: { title: "/name" }, query: { objectsPointer: "/items", ordering: "provider", stableSnapshot: true, limits: { items: 2 } } },
    { ...base, capabilityId: capabilityIds.watch, mode: "poll", objectType: domain.item.type, inputSchemaRef: ref(schemas.empty), outputSchemaRef: ref(schemas.itemOut), destinationType: domain.place.type, display: { title: "/name" }, observation: { modes: ["poll"], objectsPointer: "/items", resumable: false } },
  ];
}

function draftingBindings(domain: ConformanceDomain) {
  const { schemas, ...capabilityIds } = ids(domain);
  if (!domain.writable) return [];
  return [{
    bindingVersion: "1.0.0", adapterId: domain.adapterId, capabilityId: capabilityIds.create, inputSchemaRef: ref(schemas.item),
    guidance: { guidanceId: `${domain.adapterId}.guidance`, version: "1.0.0", instructions: `Draft a ${domain.item.label.toLowerCase()} from the conversation.` },
    fieldHints: [{ pointer: "/name", role: "title" }, { pointer: "/place", role: "destination", resolveWith: capabilityIds.placeList }, { pointer: "/note", role: "detail", widget: "long" }],
  }];
}

function setup(domain: ConformanceDomain, variant: ConformanceVariant) {
  const authMethods = variant === "token-only" ? [{ kind: "token", slots: [{ name: "token", label: "Access token", required: true }] }]
    : variant === "broker-only" ? [{ kind: "broker", brokerId: "synthetic-broker" }]
    : [{ kind: "local" }];
  return {
    version: "1.0.0",
    schemas: [
      { schemaId: `${domain.adapterId}.setup.configuration`, version: "1.0.0", schema: object({ workspace: { type: "string" } }) },
      { schemaId: `${domain.adapterId}.setup.account`, version: "1.0.0", schema: object({ account: { type: "string" } }) },
    ],
    configurationSchemaRef: ref(`${domain.adapterId}.setup.configuration`),
    accountScopeSchemaRef: ref(`${domain.adapterId}.setup.account`),
    authMethods,
  };
}

export function conformanceBackend(domain: ConformanceDomain, variant: ConformanceVariant): string {
  const { schemas, ...capabilityIds } = ids(domain);
  const config = {
    adapterId: domain.adapterId, place: { type: domain.place.type, schema: ref(schemas.place), rows: domain.place.rows },
    item: { type: domain.item.type, schema: ref(schemas.item), rows: domain.item.rows }, capabilityIds, writable: domain.writable, variant,
    declaration: conformanceDeclaration(domain, variant === "mismatch" ? `${domain.label} (changed)` : domain.label),
  };
  return [
    `const D = ${JSON.stringify(config)};`,
    "const now = () => new Date().toISOString();",
    "const ref = (connectionId, objectType, canonicalId) => ({ adapterId: D.adapterId, connectionId, objectType, canonicalId });",
    "const rows = D.item.rows.map(row => ({ ...row }));",
    "const itemValue = (row, connectionId) => ({ name: row.name, place: ref(connectionId, D.place.type, row.place), ...(row.note ? { note: row.note } : {}) });",
    "const annotate = (pointer, objectRef, schemaRef, destination, position, evidenceId) => ({ pointer, ref: objectRef, schemaRef, destination, position, evidence: { evidenceId, revision: \"1\", observedAt: now() } });",
    "const placeOf = (connectionId, row) => ref(connectionId, D.place.type, D.variant === \"outside-destination\" ? \"elsewhere\" : row.place);",
    "const scoped = (destinations) => rows.filter(row => destinations.some(destination => destination.canonicalId === row.place));",
    "const itemAnnotations = (page, connectionId, offset) => D.variant === \"bad-annotation\" ? [] : page.map((row, index) => annotate(`/items/${index}`, ref(connectionId, D.item.type, row.id), D.item.schema, placeOf(connectionId, row), offset + index, `${row.id}-evidence`));",
    "function listPlaces(request) {",
    "  const connectionId = request.destinations[0].connectionId;",
    "  const places = D.place.rows;",
    "  return { readVersion: \"1.0.0\", payload: { items: places.map(place => ({ name: place.name })) }, annotations: places.map((place, index) => annotate(`/items/${index}`, ref(connectionId, D.place.type, place.id), D.place.schema, ref(connectionId, D.place.type, place.id), index, `${place.id}-evidence`)), observedAt: now(), ordering: \"provider\", snapshot: { kind: \"stable\", id: \"places\" } };",
    "}",
    "function search(request) {",
    "  const connectionId = request.destinations[0].connectionId;",
    "  const matching = scoped(request.destinations);",
    "  const offset = request.cursor === undefined ? 0 : Number(request.cursor);",
    "  const page = matching.slice(offset, offset + request.limit);",
    "  const next = offset + page.length;",
    "  return { readVersion: \"1.0.0\", payload: { items: page.map(row => itemValue(row, connectionId)) }, annotations: itemAnnotations(page, connectionId, offset), observedAt: now(), ordering: \"provider\", snapshot: { kind: \"stable\", id: \"items\" }, ...(next < matching.length ? { cursor: String(next) } : {}) };",
    "}",
    "function getOne(request) {",
    "  const connectionId = request.destinations[0].connectionId;",
    "  const page = scoped(request.destinations).filter(row => row.id === request.input.canonicalId);",
    "  return { readVersion: \"1.0.0\", payload: { items: page.map(row => itemValue(row, connectionId)) }, annotations: itemAnnotations(page, connectionId, 0), observedAt: now(), ordering: \"provider\", snapshot: { kind: \"stable\", id: \"items\" } };",
    "}",
    "const watch = {",
    "  modes: [\"poll\"],",
    "  fetch(request) {",
    "    const connectionId = request.source.connectionId;",
    "    const page = scoped(request.source.destinations).slice(0, 20);",
    "    return { version: \"1.0.0\", payload: { items: page.map(row => itemValue(row, connectionId)) }, events: page.map((row, index) => ({ kind: \"present\", pointer: `/items/${index}`, ref: ref(connectionId, D.item.type, row.id), schemaRef: D.item.schema, destination: ref(connectionId, D.place.type, row.place), observedAt: now(), revision: \"1\", evidenceId: `${row.id}-observed` })), gap: false, coverage: \"objects\" };",
    "  },",
    "};",
    "const supportFor = connection => ({ lifecycleVersion: \"1.0.0\", adapterId: D.adapterId, connectionId: connection.connectionId, capabilityId: D.capabilityIds.create, declarationId: `${D.adapterId}-support`, dedup: { kind: \"none\" }, operationLookup: \"none\", conditionalUpdate: \"none\", cancellation: \"none\" });",
    "const connector = connection => ({",
    "  kind: \"action\", adapterId: D.adapterId, connectionId: connection.connectionId, capabilityId: D.capabilityIds.create, writerOwner: `${D.adapterId}-owner`, support: supportFor(connection), readbackCapabilityId: D.capabilityIds.get,",
    "  dispatch(request) {",
    "    const id = `${D.item.type}-${rows.length + 1}`;",
    "    rows.push({ id, name: request.snapshot.input.name, place: request.snapshot.input.place.canonicalId, ...(request.snapshot.input.note ? { note: request.snapshot.input.note } : {}) });",
    "    const created = ref(connection.connectionId, D.item.type, id);",
    "    return { lifecycleVersion: \"1.0.0\", operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest, resultId: `result-${id}`, reportedAt: now(), result: { kind: \"succeeded\", output: { ref: created }, evidence: { kind: \"effect\", evidenceId: `evidence-${id}`, observedAt: now(), ownerRequestId: request.ownerRequestId, receipt: { id }, refs: [created] } } };",
    "  },",
    "  readback(request) {",
    "    const row = rows.find(candidate => candidate.id === request.ref.canonicalId);",
    "    const envelope = { lifecycleVersion: \"1.0.0\", ref: request.ref, checkedAt: now(), provenance: { adapterId: D.adapterId, connectionId: connection.connectionId, evidenceId: `readback-${request.ref.canonicalId}` } };",
    "    return row ? { ...envelope, result: { kind: \"present\", schemaRef: D.item.schema, value: itemValue(row, connection.connectionId), ownerRevision: \"1\", links: [] } } : { ...envelope, result: { kind: \"unknown\", reason: { code: `${D.adapterId}.unknown`, message: \"The owner does not know this object.\" } } };",
    "  },",
    "});",
    "export function createDeskAdapter(host) {",
    variant === "throws" ? "  throw new Error(\"synthetic adapter creation failure\");" : "",
    "  if (D.writable) host.registerConnector(D.capabilityIds.create, connector);",
    "  return { declaration: D.declaration, bindings: { handlers: { [D.capabilityIds.placeList]: listPlaces, [D.capabilityIds.search]: search, ...(D.writable ? { [D.capabilityIds.get]: getOne } : {}) }, observations: { [D.capabilityIds.watch]: watch } } };",
    "}",
    "",
  ].join("\n");
}

export interface BuiltPackage { dir: string; manifest: Record<string, unknown> }

export function writeConformancePackage(dir: string, domain: ConformanceDomain, variant: ConformanceVariant = "valid"): BuiltPackage {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const source = conformanceBackend(domain, variant);
  const backendPath = join(dir, "backend.mjs");
  writeFileSync(backendPath, source);
  const manifest = {
    format: variant === "format" ? "desk-adapter-package/2" : "desk-adapter-package/1",
    packageId: `synthetic.${domain.adapterId}`, packageVersion: "1.0.0", deskSdkRange: "^1.0.0", domainContractVersion: "1.0.0",
    backend: { entry: "backend.mjs", sha256: variant === "digest" ? "0".repeat(64) : sha256(source) },
    declaration: conformanceDeclaration(domain), draftingBindings: draftingBindings(domain), readBindings: readBindings(domain), setup: setup(domain, variant),
  };
  writeFileSync(join(dir, "desk-adapter.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (variant === "symlink") {
    rmSync(backendPath);
    symlinkSync("/etc/hosts", backendPath);
  }
  return { dir, manifest };
}

export const CONFORMANCE_PACKAGES: Record<string, { domain: string; variant: ConformanceVariant }> = {
  greenhouse: { domain: "greenhouse", variant: "valid" },
  observatory: { domain: "observatory", variant: "valid" },
  tideway: { domain: "tideway", variant: "valid" },
  "broken-digest": { domain: "greenhouse", variant: "digest" },
  "broken-format": { domain: "greenhouse", variant: "format" },
  "broken-symlink": { domain: "greenhouse", variant: "symlink" },
  "broken-throws": { domain: "greenhouse", variant: "throws" },
  "broken-mismatch": { domain: "greenhouse", variant: "mismatch" },
  "bad-annotation": { domain: "greenhouse", variant: "bad-annotation" },
  "outside-destination": { domain: "greenhouse", variant: "outside-destination" },
  "token-only": { domain: "greenhouse", variant: "token-only" },
  "broker-only": { domain: "greenhouse", variant: "broker-only" },
};

export function conformanceDomain(name: string): ConformanceDomain {
  const domain = CONFORMANCE_DOMAINS[name];
  if (!domain) throw new Error(`Unknown conformance domain: ${name}`);
  return domain;
}

export function writeConformancePackages(root: string): void {
  for (const [name, spec] of Object.entries(CONFORMANCE_PACKAGES)) writeConformancePackage(join(root, name), conformanceDomain(spec.domain), spec.variant);
}

export const CONFORMANCE_PACKAGES_ROOT = join(dirname(import.meta.path), "conformance-packages");

if (import.meta.main) writeConformancePackages(CONFORMANCE_PACKAGES_ROOT);
