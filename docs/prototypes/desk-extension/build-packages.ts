import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const out = join(here, "packages");
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const ref = (schemaId: string) => ({ schemaId, version: "1.0.0" });
const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const text = { type: "string", minLength: 1 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ $schema: DIALECT, type: "object", properties, required, additionalProperties: false });
const reference = (adapterId: string, objectType: string, title?: string) => ({ ...object({ adapterId: { type: "string", const: adapterId }, connectionId: text, objectType: { type: "string", const: objectType }, canonicalId: text }), ...(title ? { title } : {}) });

interface Spec {
  dir: string; adapterId: string; label: string; objectType: string; objectLabel: string;
  properties: Record<string, unknown>; required: string[];
  hints?: { pointer: string; role: "title" | "summary" | "destination" | "detail"; widget?: "long" }[];
  destination?: { field: string; type: string; label: string; places: { id: string; name: string }[] };
  textFields: string[]; displayTitle: string; displaySummary?: string; attention?: Record<string, string>;
  seed: Record<string, unknown>[]; extraObservation?: { type: string; label: string; properties: Record<string, unknown>; seed: Record<string, unknown>[] };
  action?: boolean; ui?: string; ignoresScope?: boolean; packageId?: string; lieAboutDeclaration?: boolean; mutate?: (manifest: Record<string, any>) => void; backendSuffix?: string;
}

function backend(spec: Spec): string {
  const owner = { objectType: spec.objectType, destination: spec.destination ? { field: spec.destination.field, type: spec.destination.type, places: spec.destination.places } : null, textFields: spec.textFields, seed: spec.seed, extra: spec.extraObservation ?? null, ignoresScope: !!spec.ignoresScope, lie: !!spec.lieAboutDeclaration };
  return `import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(new URL("./desk-adapter.json", import.meta.url), "utf8"));
const adapterId = manifest.declaration.adapterId;
const OWNER = ${JSON.stringify(owner)};
const PAGE = 2;
const created = new Map();
const refOf = (connectionId, objectType, canonicalId) => ({ adapterId, connectionId, objectType, canonicalId });
const pinOf = type => manifest.declaration.objectTypes.find(entry => entry.objectType === type).schemaRef;
const inDays = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const resolve = (row, connectionId) => {
  const { id, place, ...fields } = row;
  const out = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === "string" && value.startsWith("in-days:") ? inDays(Number(value.slice(8))) : value]));
  if (OWNER.destination) out[OWNER.destination.field] = refOf(connectionId, OWNER.destination.type, place);
  return out;
};
const page = (rows, type, context, start, size) => {
  const slice = rows.slice(start, start + size);
  return { payload: { items: slice.map(row => type === OWNER.objectType ? resolve(row, context.connectionId) : (({ id, ...rest }) => rest)(row)) }, annotations: slice.map((row, index) => ({ pointer: "/items/" + index, ref: refOf(context.connectionId, type, row.id), objectSchemaRef: pinOf(type), ownerRevision: "r1", ...(type === OWNER.objectType && OWNER.destination ? { destination: refOf(context.connectionId, OWNER.destination.type, row.place) } : {}) })), ...(start + size < rows.length ? { continuation: "cursor-" + (start + size) } : {}), observedAt: new Date().toISOString(), consistency: "best-effort" };
};
const inScope = (rows, context) => OWNER.destination && !OWNER.ignoresScope ? rows.filter(row => context.destinations.some(place => place.canonicalId === row.place)) : rows;
const all = () => [...OWNER.seed, ...created.values()];
const support = connection => ({ lifecycleVersion: "1.0.0", adapterId, connectionId: connection.connectionId, capabilityId: adapterId + "." + OWNER.objectType + ".create", declarationId: adapterId + "-support-1", dedup: { kind: "guaranteed", scope: "connection-capability", retentionMs: 86400000, bindsSnapshot: true, concurrent: true }, operationLookup: "none", conditionalUpdate: "none", cancellation: "none" });
const connector = connection => ({
  support: support(connection),
  readbackCapabilityId: adapterId + "." + OWNER.objectType + ".search",
  async dispatch(request) {
    const base = { lifecycleVersion: "1.0.0", operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest, resultId: crypto.randomUUID(), reportedAt: new Date().toISOString() };
    if (/\\bfail\\b/i.test(JSON.stringify(request.snapshot.input))) return { ...base, result: { kind: "failed", error: { code: adapterId + ".refused", message: "The owner refused this." }, evidence: { kind: "no-effect", evidenceId: crypto.randomUUID(), observedAt: new Date().toISOString(), ownerRequestId: request.ownerRequestId, receipt: {}, final: true } } };
    const id = "made-" + request.idempotencyKey;
    if (!created.has(id)) { const { [OWNER.destination?.field ?? ""]: place, ...fields } = request.snapshot.input; created.set(id, { id, ...fields, ...(place ? { place: place.canonicalId } : {}) }); }
    const objectRef = refOf(connection.connectionId, OWNER.objectType, id);
    return { ...base, result: { kind: "succeeded", output: { ref: objectRef, revision: "r1" }, evidence: { kind: "effect", evidenceId: crypto.randomUUID(), observedAt: new Date().toISOString(), ownerRequestId: request.ownerRequestId, receipt: { id }, refs: [objectRef], ownerRevision: "r1" } } };
  },
  async readback(request) {
    const row = created.get(request.ref.canonicalId) ?? all().find(entry => entry.id === request.ref.canonicalId);
    const base = { lifecycleVersion: "1.0.0", ref: request.ref, checkedAt: new Date().toISOString(), provenance: { adapterId, connectionId: connection.connectionId, evidenceId: crypto.randomUUID() } };
    return row ? { ...base, result: { kind: "present", schemaRef: pinOf(OWNER.objectType), value: resolve(row, connection.connectionId), ownerRevision: "r1", links: [] } } : { ...base, result: { kind: "unknown", reason: { code: adapterId + ".unknown", message: "Not known to the owner." } } };
  },
});
export function createDeskAdapter(host) {
  const search = (rows, type) => (input, context) => {
    const needle = String(input.text ?? "").toLowerCase();
    const matched = (type === OWNER.objectType ? inScope(rows(), context) : rows()).filter(row => !needle || JSON.stringify(row).toLowerCase().includes(needle));
    const start = context.continuation ? Number(context.continuation.slice(7)) : 0;
    return page(matched, type, context, start, PAGE);
  };
  const handlers = { [adapterId + "." + OWNER.objectType + ".search"]: search(all, OWNER.objectType) };
  const observations = { [adapterId + "." + OWNER.objectType + ".observe"]: { poll: context => page(inScope(OWNER.seed, context), OWNER.objectType, context, 0, 20) } };
  if (OWNER.destination) handlers[adapterId + "." + OWNER.destination.type + ".list"] = (_input, context) => page(OWNER.destination.places, OWNER.destination.type, context, 0, 20);
  if (OWNER.extra) { handlers[adapterId + "." + OWNER.extra.type + ".search"] = search(() => OWNER.extra.seed, OWNER.extra.type); observations[adapterId + "." + OWNER.extra.type + ".observe"] = { poll: context => page(OWNER.extra.seed, OWNER.extra.type, context, 0, 20) }; }
  const actionId = adapterId + "." + OWNER.objectType + ".create";
  if (manifest.declaration.capabilities.some(entry => entry.capabilityId === actionId)) {
    handlers[actionId] = () => { throw new Error("Actions run through the registered connector."); };
    host.registerConnector(actionId, connector);
  }
  return { declaration: OWNER.lie ? { ...manifest.declaration, label: "Something else" } : manifest.declaration, bindings: { handlers, observations } };
}
${spec.backendSuffix ?? ""}`;
}

function build(spec: Spec): void {
  const { adapterId, objectType } = spec;
  const dir = join(out, spec.dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const objectId = `${adapterId}.${objectType}`;
  const errorId = `${adapterId}.error`;
  const listOf = (schemaId: string) => object({ items: { type: "array", items: { $ref: `urn:desk-schema:${encodeURIComponent(schemaId)}:1.0.0` } } });
  const schemas: Record<string, unknown>[] = [
    { ...ref(objectId), schema: object(spec.properties, spec.required) },
    { ...ref(errorId), schema: object({ code: { type: "string", minLength: 1 }, message: text }) },
    { ...ref(`${objectId}.empty`), schema: object({}) },
    { ...ref(`${objectId}.search.input`), schema: object({ text: { type: "string" } }) },
    { ...ref(`${objectId}.list`), schema: listOf(objectId) },
  ];
  const objectTypes: Record<string, unknown>[] = [{ objectType, label: spec.objectLabel, schemaRef: ref(objectId), relationships: spec.destination ? [{ fieldPath: `/${spec.destination.field}`, targetAdapterId: adapterId, targetObjectType: spec.destination.type, cardinality: "one" }] : [] }];
  const capability = (suffix: string, label: string, kind: string, type: string, input: string, output: string) => ({ capabilityId: `${adapterId}.${suffix}`, label, kind, objectTypes: [type], inputSchemaRef: ref(input), outputSchemaRef: ref(output), errorSchemaRef: ref(errorId) });
  const capabilities: Record<string, unknown>[] = [
    capability(`${objectType}.search`, `Search ${spec.objectLabel}`, "query", objectType, `${objectId}.search.input`, `${objectId}.list`),
    capability(`${objectType}.observe`, `Watch ${spec.objectLabel}`, "observation", objectType, `${objectId}.empty`, `${objectId}.list`),
  ];
  const destinationType = spec.destination?.type;
  const readBindings: Record<string, unknown>[] = [
    { version: "1.0.0", adapterId, capabilityId: `${adapterId}.${objectType}.search`, mode: "query", objectType, inputSchemaRef: ref(`${objectId}.search.input`), outputSchemaRef: ref(`${objectId}.list`), textPointer: "/text", ...(destinationType ? { destinationType } : {}), display: { title: spec.displayTitle, ...(spec.displaySummary ? { summary: spec.displaySummary } : {}) } },
    { version: "1.0.0", adapterId, capabilityId: `${adapterId}.${objectType}.observe`, mode: "poll", objectType, inputSchemaRef: ref(`${objectId}.empty`), outputSchemaRef: ref(`${objectId}.list`), ...(destinationType ? { destinationType } : {}), display: { title: spec.displayTitle }, ...(spec.attention ? { attention: spec.attention } : {}) },
  ];
  if (spec.destination) {
    const placeId = `${adapterId}.${spec.destination.type}`;
    schemas.push({ ...ref(placeId), schema: object({ name: text }) }, { ...ref(`${placeId}.list`), schema: listOf(placeId) });
    objectTypes.push({ objectType: spec.destination.type, label: spec.destination.label, schemaRef: ref(placeId), relationships: [] });
    capabilities.push(capability(`${spec.destination.type}.list`, `List ${spec.destination.label}`, "query", spec.destination.type, `${objectId}.empty`, `${placeId}.list`));
    readBindings.push({ version: "1.0.0", adapterId, capabilityId: `${adapterId}.${spec.destination.type}.list`, mode: "destinations", objectType: spec.destination.type, inputSchemaRef: ref(`${objectId}.empty`), outputSchemaRef: ref(`${placeId}.list`), display: { title: "/name" } });
  }
  if (spec.extraObservation) {
    const extraId = `${adapterId}.${spec.extraObservation.type}`;
    schemas.push({ ...ref(extraId), schema: object(spec.extraObservation.properties) }, { ...ref(`${extraId}.list`), schema: listOf(extraId) });
    objectTypes.push({ objectType: spec.extraObservation.type, label: spec.extraObservation.label, schemaRef: ref(extraId), relationships: [] });
    capabilities.push(capability(`${spec.extraObservation.type}.observe`, `Watch ${spec.extraObservation.label}`, "observation", spec.extraObservation.type, `${objectId}.empty`, `${extraId}.list`), capability(`${spec.extraObservation.type}.search`, `Search ${spec.extraObservation.label}`, "query", spec.extraObservation.type, `${objectId}.search.input`, `${extraId}.list`));
    readBindings.push({ version: "1.0.0", adapterId, capabilityId: `${extraId}.observe`, mode: "poll", objectType: spec.extraObservation.type, inputSchemaRef: ref(`${objectId}.empty`), outputSchemaRef: ref(`${extraId}.list`), display: { title: "/name" } }, { version: "1.0.0", adapterId, capabilityId: `${extraId}.search`, mode: "query", objectType: spec.extraObservation.type, inputSchemaRef: ref(`${objectId}.search.input`), outputSchemaRef: ref(`${extraId}.list`), textPointer: "/text", display: { title: "/name" } });
  }
  const draftingBindings: Record<string, unknown>[] = [];
  if (spec.action) {
    const outputId = `${objectId}.created`;
    schemas.push({ ...ref(outputId), schema: object({ ref: reference(adapterId, objectType), revision: text }) });
    capabilities.push(capability(`${objectType}.create`, `Make ${spec.objectLabel}`, "action", objectType, objectId, outputId));
    if (spec.hints) draftingBindings.push({ version: "1.0.0", adapterId, capabilityId: `${adapterId}.${objectType}.create`, inputSchemaRef: ref(objectId), guidanceId: `${adapterId}.guidance`, guidanceVersion: "1.0.0", instruction: `Prepare a ${spec.objectLabel} from the discussion.`, fieldHints: spec.hints.map(hint => ({ ...hint, ...(hint.role === "destination" && spec.destination ? { resolveWith: `${adapterId}.${spec.destination.type}.list` } : {}) })) });
  }
  const backendSource = backend(spec);
  writeFileSync(join(dir, "backend.mjs"), backendSource);
  const manifest: Record<string, any> = {
    format: "desk-adapter-package/1", packageId: spec.packageId ?? `sample/${spec.dir}`, packageVersion: "1.0.0", deskSdkRange: "^1.0.0", domainContractVersion: "1.0.0",
    backend: { entry: "backend.mjs", sha256: sha(backendSource) },
    declaration: { adapterId, label: spec.label, contractRange: "^1.0.0", schemas, objectTypes, capabilities }, draftingBindings, readBindings,
    setup: { version: "1.0.0", schemas: [{ ...ref(`${adapterId}.config`), schema: object({}) }, { ...ref(`${adapterId}.account`), schema: object({ account: text }) }], configurationSchemaRef: ref(`${adapterId}.config`), accountScopeSchemaRef: ref(`${adapterId}.account`), authMethods: [{ kind: "local" }] },
  };
  if (spec.ui) {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${spec.label}</title></head><body><main aria-live="polite"></main><script src="view.js"></script></body></html>`;
    const script = readFileSync(join(here, "views", spec.ui), "utf8");
    writeFileSync(join(dir, "view.html"), html);
    writeFileSync(join(dir, "view.js"), script);
    manifest.ui = { protocolVersion: "1.0.0", entry: "view.html", files: [{ path: "view.html", sha256: sha(html), mediaType: "text/html" }, { path: "view.js", sha256: sha(script), mediaType: "text/javascript" }], views: [{ objectType, view: "result" }] };
  }
  spec.mutate?.(manifest);
  writeFileSync(join(dir, "desk-adapter.json"), `${JSON.stringify(manifest, null, 1)}\n`);
}

const reading: Spec = {
  dir: "reading-list", adapterId: "sample.reading", label: "Reading list", objectType: "article", objectLabel: "article",
  properties: { title: { ...text, title: "Title" }, summary: { type: "string", title: "Why keep it" }, shelf: reference("sample.reading", "shelf", "Shelf"), rating: { type: "string", enum: ["skim", "read", "reread"], title: "Worth" }, revisit: { type: "string", format: "date", title: "Revisit" }, tags: { type: "array", items: { type: "string" }, title: "Tags" } },
  required: ["title", "shelf"],
  hints: [{ pointer: "/title", role: "title" }, { pointer: "/summary", role: "summary", widget: "long" }, { pointer: "/shelf", role: "destination" }],
  destination: { field: "shelf", type: "shelf", label: "shelf", places: [{ id: "shelf-work", name: "Work" }, { id: "shelf-private", name: "Private" }] },
  textFields: ["title", "summary"], displayTitle: "/title", displaySummary: "/summary",
  attention: { title: "/title", why: "/summary", due: "/revisit" },
  seed: [
    { id: "a1", place: "shelf-work", title: "Receipts that survive a crash", summary: "How an owner lookup settles an unknown outcome.", rating: "reread", revisit: "in-days:1", tags: ["reliability"] },
    { id: "a2", place: "shelf-work", title: "Crash-only software revisited", summary: "Restart as the only recovery path.", rating: "read", tags: ["reliability"] },
    { id: "a3", place: "shelf-work", title: "Idempotency keys in practice", summary: "Where crash retries duplicate work.", rating: "skim", tags: ["api"] },
    { id: "a4", place: "shelf-private", title: "A private crash diary", summary: "This belongs on a shelf the connection may lose.", rating: "skim", revisit: "in-days:1", tags: ["personal"] },
  ],
  action: true, ui: "reading-view.js", ignoresScope: true,
};

const registered: Record<string, Spec> = { "reading-list": reading };
const only = process.argv.slice(2);
if (existsSync(join(here, "more-packages.ts"))) {
  const more = await import(join(here, "more-packages.ts")) as { specs(reference: (adapterId: string, objectType: string, title?: string) => unknown, text: unknown, reading: Spec): Spec[]; finish?(out: string): void };
  for (const spec of more.specs(reference, text, reading)) registered[spec.dir] = spec;
  rmSync(out, { recursive: true, force: true });
  for (const spec of Object.values(registered)) if (!only.length || only.includes(spec.dir)) build(spec);
  more.finish?.(out);
  cpSync(join(here, "blind-packages/plant-care"), join(out, "plant-care"), { recursive: true });
} else {
  rmSync(out, { recursive: true, force: true });
  for (const spec of Object.values(registered)) build(spec);
}
