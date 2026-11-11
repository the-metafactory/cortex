import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(new URL("./desk-adapter.json", import.meta.url), "utf8"));
const adapterId = manifest.declaration.adapterId;
const OWNER = {"objectType":"repair","destination":{"field":"bench","type":"bench","places":[{"id":"bench-1","name":"Bench 1"},{"id":"bench-2","name":"Bench 2"}]},"textFields":["fault","detail"],"seed":[{"id":"r1","place":"bench-1","fault":"Bench grinder overheats","detail":"Runs hot after ten minutes.","severity":"medium","neededBy":"in-days:2","hours":1.5,"parts":["bearing"]}],"extra":{"type":"part","label":"part","properties":{"name":{"type":"string","minLength":1,"title":"Name"},"inStock":{"type":"boolean","title":"In stock"}},"seed":[{"id":"s1","name":"Spare bearing","inStock":true}]},"ignoresScope":false,"lie":false};
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
    if (/\bfail\b/i.test(JSON.stringify(request.snapshot.input))) return { ...base, result: { kind: "failed", error: { code: adapterId + ".refused", message: "The owner refused this." }, evidence: { kind: "no-effect", evidenceId: crypto.randomUUID(), observedAt: new Date().toISOString(), ownerRequestId: request.ownerRequestId, receipt: {}, final: true } } };
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
