const D = {"adapterId":"observatory","place":{"type":"dome","schema":{"schemaId":"observatory.dome","version":"1.0.0"},"rows":[{"id":"dome-east","name":"East dome"},{"id":"dome-west","name":"West dome"}]},"item":{"type":"viewing","schema":{"schemaId":"observatory.viewing","version":"1.0.0"},"rows":[{"id":"viewing-1","name":"Saturn rings","place":"dome-east"},{"id":"viewing-2","name":"Lunar craters","place":"dome-east","note":"Clear sky needed."},{"id":"viewing-3","name":"Orion nebula","place":"dome-west"}]},"capabilityIds":{"placeList":"observatory.dome.list","search":"observatory.viewing.search","watch":"observatory.viewing.watch","get":"observatory.viewing.get","create":"observatory.viewing.book"},"writable":true,"variant":"valid","declaration":{"adapterId":"observatory","label":"Observatory","contractRange":"^1.0.0","schemas":[{"schemaId":"observatory.empty","version":"1.0.0","schema":{"type":"object","additionalProperties":false,"required":[],"properties":{}}},{"schemaId":"observatory.error","version":"1.0.0","schema":{"type":"object","additionalProperties":false,"required":["code","message"],"properties":{"code":{"type":"string","minLength":1},"message":{"type":"string","minLength":1}}}},{"schemaId":"observatory.dome","version":"1.0.0","schema":{"type":"object","additionalProperties":false,"required":["name"],"properties":{"name":{"type":"string","minLength":1}}}},{"schemaId":"observatory.dome.list.output","version":"1.0.0","schema":{"type":"object","additionalProperties":false,"required":["items"],"properties":{"items":{"type":"array","items":{"$ref":"urn:desk-schema:observatory.dome:1.0.0"}}}}},{"schemaId":"observatory.viewing","version":"1.0.0","schema":{"type":"object","additionalProperties":false,"required":["name","place"],"properties":{"name":{"type":"string","minLength":1,"title":"Name"},"place":{"type":"object","additionalProperties":false,"required":["adapterId","connectionId","objectType","canonicalId"],"properties":{"adapterId":{"type":"string","const":"observatory"},"connectionId":{"type":"string","minLength":1},"objectType":{"type":"string","const":"dome"},"canonicalId":{"type":"string","minLength":1}}},"note":{"type":"string","title":"Note"}}}},{"schemaId":"observatory.viewing.list.output","version":"1.0.0","schema":{"type":"object","additionalProperties":false,"required":["items"],"properties":{"items":{"type":"array","items":{"$ref":"urn:desk-schema:observatory.viewing:1.0.0"}}}}},{"schemaId":"observatory.find.input","version":"1.0.0","schema":{"type":"object","additionalProperties":false,"required":["text"],"properties":{"text":{"type":"string"}}}},{"schemaId":"observatory.get.input","version":"1.0.0","schema":{"type":"object","additionalProperties":false,"required":["canonicalId"],"properties":{"canonicalId":{"type":"string","minLength":1}}}},{"schemaId":"observatory.created","version":"1.0.0","schema":{"type":"object","additionalProperties":false,"required":["ref"],"properties":{"ref":{"type":"object","additionalProperties":false,"required":["adapterId","connectionId","objectType","canonicalId"],"properties":{"adapterId":{"type":"string","const":"observatory"},"connectionId":{"type":"string","minLength":1},"objectType":{"type":"string","const":"viewing"},"canonicalId":{"type":"string","minLength":1}}}}}}],"objectTypes":[{"objectType":"dome","label":"Dome","schemaRef":{"schemaId":"observatory.dome","version":"1.0.0"},"relationships":[]},{"objectType":"viewing","label":"Viewing","schemaRef":{"schemaId":"observatory.viewing","version":"1.0.0"},"relationships":[{"fieldPath":"/place","cardinality":"one","targetAdapterId":"observatory","targetObjectType":"dome"}]}],"capabilities":[{"capabilityId":"observatory.dome.list","label":"List domes","kind":"query","objectTypes":["dome"],"inputSchemaRef":{"schemaId":"observatory.empty","version":"1.0.0"},"outputSchemaRef":{"schemaId":"observatory.dome.list.output","version":"1.0.0"},"errorSchemaRef":{"schemaId":"observatory.error","version":"1.0.0"}},{"capabilityId":"observatory.viewing.search","label":"Find viewings","kind":"query","objectTypes":["viewing"],"inputSchemaRef":{"schemaId":"observatory.find.input","version":"1.0.0"},"outputSchemaRef":{"schemaId":"observatory.viewing.list.output","version":"1.0.0"},"errorSchemaRef":{"schemaId":"observatory.error","version":"1.0.0"}},{"capabilityId":"observatory.viewing.watch","label":"Watch viewings","kind":"observation","objectTypes":["viewing"],"inputSchemaRef":{"schemaId":"observatory.empty","version":"1.0.0"},"outputSchemaRef":{"schemaId":"observatory.viewing.list.output","version":"1.0.0"},"errorSchemaRef":{"schemaId":"observatory.error","version":"1.0.0"}},{"capabilityId":"observatory.viewing.book","label":"book a viewing","kind":"action","objectTypes":["viewing"],"inputSchemaRef":{"schemaId":"observatory.viewing","version":"1.0.0"},"outputSchemaRef":{"schemaId":"observatory.created","version":"1.0.0"},"errorSchemaRef":{"schemaId":"observatory.error","version":"1.0.0"}},{"capabilityId":"observatory.viewing.get","label":"Read one viewing","kind":"query","objectTypes":["viewing"],"inputSchemaRef":{"schemaId":"observatory.get.input","version":"1.0.0"},"outputSchemaRef":{"schemaId":"observatory.viewing","version":"1.0.0"},"errorSchemaRef":{"schemaId":"observatory.error","version":"1.0.0"}}]}};
const now = () => new Date().toISOString();
const ref = (connectionId, objectType, canonicalId) => ({ adapterId: D.adapterId, connectionId, objectType, canonicalId });
const rows = D.item.rows.map(row => ({ ...row }));
const itemValue = (row, connectionId) => ({ name: row.name, place: ref(connectionId, D.place.type, row.place), ...(row.note ? { note: row.note } : {}) });
const annotate = (pointer, objectRef, schemaRef, destination, position, evidenceId) => ({ pointer, ref: objectRef, schemaRef, destination, position, evidence: { evidenceId, revision: "1", observedAt: now() } });
const placeOf = (connectionId, row) => ref(connectionId, D.place.type, D.variant === "outside-destination" ? "elsewhere" : row.place);
const scoped = (destinations) => rows.filter(row => destinations.some(destination => destination.canonicalId === row.place));
const itemAnnotations = (page, connectionId, offset) => D.variant === "bad-annotation" ? [] : page.map((row, index) => annotate(`/items/${index}`, ref(connectionId, D.item.type, row.id), D.item.schema, placeOf(connectionId, row), offset + index, `${row.id}-evidence`));
function listPlaces(request) {
  const connectionId = request.destinations[0].connectionId;
  const places = D.place.rows;
  return { readVersion: "1.0.0", payload: { items: places.map(place => ({ name: place.name })) }, annotations: places.map((place, index) => annotate(`/items/${index}`, ref(connectionId, D.place.type, place.id), D.place.schema, ref(connectionId, D.place.type, place.id), index, `${place.id}-evidence`)), observedAt: now(), ordering: "provider", snapshot: { kind: "stable", id: "places" } };
}
function search(request) {
  const connectionId = request.destinations[0].connectionId;
  const matching = scoped(request.destinations);
  const offset = request.cursor === undefined ? 0 : Number(request.cursor);
  const page = matching.slice(offset, offset + request.limit);
  const next = offset + page.length;
  return { readVersion: "1.0.0", payload: { items: page.map(row => itemValue(row, connectionId)) }, annotations: itemAnnotations(page, connectionId, offset), observedAt: now(), ordering: "provider", snapshot: { kind: "stable", id: "items" }, ...(next < matching.length ? { cursor: String(next) } : {}) };
}
function getOne(request) {
  const connectionId = request.destinations[0].connectionId;
  const page = scoped(request.destinations).filter(row => row.id === request.input.canonicalId);
  return { readVersion: "1.0.0", payload: { items: page.map(row => itemValue(row, connectionId)) }, annotations: itemAnnotations(page, connectionId, 0), observedAt: now(), ordering: "provider", snapshot: { kind: "stable", id: "items" } };
}
const watch = {
  modes: ["poll"],
  fetch(request) {
    const connectionId = request.source.connectionId;
    const page = scoped(request.source.destinations).slice(0, 20);
    return { version: "1.0.0", payload: { items: page.map(row => itemValue(row, connectionId)) }, events: page.map((row, index) => ({ kind: "present", pointer: `/items/${index}`, ref: ref(connectionId, D.item.type, row.id), schemaRef: D.item.schema, destination: ref(connectionId, D.place.type, row.place), observedAt: now(), revision: "1", evidenceId: `${row.id}-observed` })), gap: false, coverage: "objects" };
  },
};
const supportFor = connection => ({ lifecycleVersion: "1.0.0", adapterId: D.adapterId, connectionId: connection.connectionId, capabilityId: D.capabilityIds.create, declarationId: `${D.adapterId}-support`, dedup: { kind: "none" }, operationLookup: "none", conditionalUpdate: "none", cancellation: "none" });
const connector = connection => ({
  kind: "action", adapterId: D.adapterId, connectionId: connection.connectionId, capabilityId: D.capabilityIds.create, writerOwner: `${D.adapterId}-owner`, support: supportFor(connection), readbackCapabilityId: D.capabilityIds.get,
  dispatch(request) {
    const id = `${D.item.type}-${rows.length + 1}`;
    rows.push({ id, name: request.snapshot.input.name, place: request.snapshot.input.place.canonicalId, ...(request.snapshot.input.note ? { note: request.snapshot.input.note } : {}) });
    const created = ref(connection.connectionId, D.item.type, id);
    return { lifecycleVersion: "1.0.0", operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest, resultId: `result-${id}`, reportedAt: now(), result: { kind: "succeeded", output: { ref: created }, evidence: { kind: "effect", evidenceId: `evidence-${id}`, observedAt: now(), ownerRequestId: request.ownerRequestId, receipt: { id }, refs: [created] } } };
  },
  readback(request) {
    const row = rows.find(candidate => candidate.id === request.ref.canonicalId);
    const envelope = { lifecycleVersion: "1.0.0", ref: request.ref, checkedAt: now(), provenance: { adapterId: D.adapterId, connectionId: connection.connectionId, evidenceId: `readback-${request.ref.canonicalId}` } };
    return row ? { ...envelope, result: { kind: "present", schemaRef: D.item.schema, value: itemValue(row, connection.connectionId), ownerRevision: "1", links: [] } } : { ...envelope, result: { kind: "unknown", reason: { code: `${D.adapterId}.unknown`, message: "The owner does not know this object." } } };
  },
});
export function createDeskAdapter(host) {

  if (D.writable) host.registerConnector(D.capabilityIds.create, connector);
  return { declaration: D.declaration, bindings: { handlers: { [D.capabilityIds.placeList]: listPlaces, [D.capabilityIds.search]: search, ...(D.writable ? { [D.capabilityIds.get]: getOne } : {}) }, observations: { [D.capabilityIds.watch]: watch } } };
}
