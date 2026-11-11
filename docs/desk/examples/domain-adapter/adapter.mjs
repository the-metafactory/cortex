import { declaration } from "./definition.mjs";

const now = () => new Date().toISOString();
const schemaRef = name => ({ schemaId: `archive.${name}`, version: "1.0.0" });
const ref = (connectionId, objectType, canonicalId) => ({ adapterId: "archive", connectionId, objectType, canonicalId });

export function createDeskAdapter(host) {
  const records = new Map(["Index", "Ledger", "Register"].map((title, index) => [`record-${index + 1}`, { title, shelf: "main" }]));
  const value = (record, connectionId) => ({ title: record.title, shelf: ref(connectionId, "shelf", record.shelf) });
  const scoped = destinations => [...records].filter(([, record]) => destinations.some(destination => destination.canonicalId === record.shelf && destination.objectType === "shelf"));
  const annotation = (connectionId, id, index, destination, objectType) => ({ pointer: `/items/${index}`, ref: ref(connectionId, objectType, id), schemaRef: schemaRef(objectType), destination, position: index, evidence: { evidenceId: `read-${id}`, revision: "1", observedAt: now() } });
  const listShelves = request => {
    const connectionId = request.destinations[0].connectionId;
    const shelf = ref(connectionId, "shelf", "main");
    return { readVersion: "1.0.0", payload: { items: [{ title: "Main shelf" }] }, annotations: [annotation(connectionId, "main", 0, shelf, "shelf")], observedAt: now(), ordering: "provider", snapshot: { kind: "stable", id: "shelves-1" } };
  };
  const listRecords = request => {
    const connectionId = request.destinations[0].connectionId;
    const matching = scoped(request.destinations);
    const offset = Number(request.cursor ?? 0);
    const page = matching.slice(offset, offset + request.limit);
    const next = offset + page.length;
    return { readVersion: "1.0.0", payload: { items: page.map(([, record]) => value(record, connectionId)) }, annotations: page.map(([id, record], index) => ({ ...annotation(connectionId, id, index, ref(connectionId, "shelf", record.shelf), "record"), position: offset + index })), observedAt: now(), ordering: "provider", snapshot: { kind: "stable", id: `records-${records.size}` }, ...(next < matching.length ? { cursor: String(next) } : {}) };
  };
  host.registerConnector("archive.record.create", connection => ({
    kind: "action", ...connection, capabilityId: "archive.record.create", writerOwner: "archive-owner",
    support: { lifecycleVersion: "1.0.0", ...connection, capabilityId: "archive.record.create", declarationId: "archive-support-1", dedup: { kind: "none" }, operationLookup: "none", conditionalUpdate: "none", cancellation: "none" },
    readbackCapabilityId: "archive.record.list",
    dispatch(request, signal) {
      signal.throwIfAborted();
      const input = request.snapshot.input;
      if (input.shelf.adapterId !== connection.adapterId || input.shelf.connectionId !== connection.connectionId || input.shelf.objectType !== "shelf" || input.shelf.canonicalId !== "main") throw new Error("Unknown archive shelf");
      const id = `record-${records.size + 1}`;
      records.set(id, { title: input.title, shelf: input.shelf.canonicalId });
      const created = ref(connection.connectionId, "record", id);
      return { lifecycleVersion: "1.0.0", operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest, resultId: `created-${id}`, reportedAt: now(), result: { kind: "succeeded", output: { ref: created }, evidence: { kind: "effect", evidenceId: `effect-${id}`, observedAt: now(), ownerRequestId: request.ownerRequestId, receipt: { id }, refs: [created] } } };
    },
    readback(request, signal) {
      signal.throwIfAborted();
      const record = records.get(request.ref.canonicalId);
      const envelope = { lifecycleVersion: "1.0.0", ref: request.ref, checkedAt: now(), provenance: { ...connection, evidenceId: `readback-${request.ref.canonicalId}` } };
      return record ? { ...envelope, result: { kind: "present", schemaRef: schemaRef("record"), value: value(record, connection.connectionId), ownerRevision: "1", links: [] } } : { ...envelope, result: { kind: "unknown", reason: { code: "archive.unknown", message: "The owner cannot find this record." } } };
    },
  }));
  return { declaration, bindings: {
    handlers: { "archive.shelf.list": listShelves, "archive.record.list": listRecords },
    observations: { "archive.record.watch": { modes: ["poll"], fetch(request, signal) {
      signal.throwIfAborted();
      const connectionId = request.source.connectionId;
      const page = scoped(request.source.destinations);
      return { version: "1.0.0", payload: { items: page.map(([, record]) => value(record, connectionId)) }, events: page.map(([id, record], index) => ({ kind: "present", pointer: `/items/${index}`, ref: ref(connectionId, "record", id), schemaRef: schemaRef("record"), destination: ref(connectionId, "shelf", record.shelf), observedAt: now(), revision: "1", evidenceId: `observed-${id}` })), gap: false, coverage: "objects" };
    } } },
  } };
}
