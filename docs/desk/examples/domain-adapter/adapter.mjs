import { declaration } from "./definition.mjs";

const now = () => new Date().toISOString();
const schemaRef = name => ({ schemaId: `archive.${name}`, version: "1.0.0" });
const ref = (connectionId, objectType, canonicalId) => ({ adapterId: "archive", connectionId, objectType, canonicalId });
const seedRecords = () => new Map(["Index", "Ledger", "Register"].map((title, index) => [`record-${index + 1}`, { title, shelf: "main" }]));
const annotation = ({ connectionId, objectType, id, destination, index, position, revision }) => ({
  pointer: `/items/${index}`, ref: ref(connectionId, objectType, id), schemaRef: schemaRef(objectType), destination, position,
  evidence: { evidenceId: `read-${objectType}-${id}-${revision}`, revision, observedAt: now() },
});

export function createDeskAdapter(host) {
  const connections = new Map();
  const connectionState = connectionId => {
    if (!connections.has(connectionId)) connections.set(connectionId, { records: seedRecords(), snapshots: new Map(), cursors: new Map(), revision: 1, created: 3, issued: 0 });
    return connections.get(connectionId);
  };
  const value = (record, connectionId) => ({ title: record.title, shelf: ref(connectionId, "shelf", record.shelf) });
  const scoped = (state, destinations) => [...state.records].filter(([, record]) => destinations.some(destination => destination.canonicalId === record.shelf && destination.objectType === "shelf"));
  const listShelves = request => {
    const connectionId = request.destinations[0].connectionId;
    const shelf = ref(connectionId, "shelf", "main");
    return { readVersion: "1.0.0", payload: { items: [{ title: "Main shelf" }] }, annotations: [annotation({ connectionId, objectType: "shelf", id: "main", destination: shelf, index: 0, position: 0, revision: "1" })], observedAt: now(), ordering: "provider", snapshot: { kind: "stable", id: "shelves-1" } };
  };
  const listRecords = request => {
    const connectionId = request.destinations[0].connectionId;
    const state = connectionState(connectionId);
    const resumed = request.cursor === undefined ? undefined : state.cursors.get(String(request.cursor));
    if (resumed === undefined && request.cursor !== undefined) throw new Error("Unknown archive cursor");
    const snapshotId = resumed === undefined ? `records-${++state.issued}` : resumed.snapshotId;
    if (resumed === undefined) state.snapshots.set(snapshotId, scoped(state, request.destinations).map(([id]) => id));
    const rows = state.snapshots.get(snapshotId) ?? [];
    const offset = resumed === undefined ? 0 : resumed.offset;
    const page = rows.slice(offset, offset + request.limit).map(id => [id, state.records.get(id)]);
    const next = offset + page.length;
    const cursor = next < rows.length ? `page-${++state.issued}` : undefined;
    if (cursor !== undefined) state.cursors.set(cursor, { snapshotId, offset: next });
    return {
      readVersion: "1.0.0",
      payload: { items: page.map(([, record]) => value(record, connectionId)) },
      annotations: page.map(([id, record], index) => ({ ...annotation({ connectionId, objectType: "record", id, destination: ref(connectionId, "shelf", record.shelf), index, position: offset + index, revision: String(state.revision) }) })),
      observedAt: now(), ordering: "provider", snapshot: { kind: "stable", id: snapshotId }, ...(cursor === undefined ? {} : { cursor }),
    };
  };
  host.registerConnector("archive.record.create", connection => ({
    kind: "action", ...connection, capabilityId: "archive.record.create", writerOwner: "archive-owner",
    support: { lifecycleVersion: "1.0.0", ...connection, capabilityId: "archive.record.create", declarationId: "archive-support-1", dedup: { kind: "none" }, operationLookup: "none", conditionalUpdate: "none", cancellation: "none" },
    readbackCapabilityId: "archive.record.list",
    dispatch(request, signal) {
      signal.throwIfAborted();
      const state = connectionState(connection.connectionId);
      const input = request.snapshot.input;
      if (input.shelf.adapterId !== connection.adapterId || input.shelf.connectionId !== connection.connectionId || input.shelf.objectType !== "shelf" || input.shelf.canonicalId !== "main") throw new Error("Unknown archive shelf");
      const id = `record-${++state.created}`;
      state.records.set(id, { title: input.title, shelf: input.shelf.canonicalId });
      state.revision += 1;
      const created = ref(connection.connectionId, "record", id);
      return { lifecycleVersion: "1.0.0", operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest, resultId: `created-${id}`, reportedAt: now(), result: { kind: "succeeded", output: { ref: created }, evidence: { kind: "effect", evidenceId: `effect-${id}`, observedAt: now(), ownerRequestId: request.ownerRequestId, receipt: { id }, refs: [created] } } };
    },
    readback(request, signal) {
      signal.throwIfAborted();
      const state = request.ref.connectionId === connection.connectionId ? connectionState(request.ref.connectionId) : undefined;
      const record = state?.records.get(request.ref.canonicalId);
      const envelope = { lifecycleVersion: "1.0.0", ref: request.ref, checkedAt: now(), provenance: { ...connection, evidenceId: `readback-${request.ref.connectionId}-${request.ref.canonicalId}` } };
      if (state === undefined || record === undefined) return { ...envelope, result: { kind: "unknown", reason: { code: "archive.unknown", message: "The owner cannot find this record." } } };
      return { ...envelope, result: { kind: "present", schemaRef: schemaRef("record"), value: value(record, request.ref.connectionId), ownerRevision: String(state.revision), links: [] } };
    },
  }));
  return { declaration, bindings: {
    handlers: { "archive.shelf.list": listShelves, "archive.record.list": listRecords },
    observations: { "archive.record.watch": { modes: ["poll"], fetch(request, signal) {
      signal.throwIfAborted();
      const connectionId = request.source.connectionId;
      const state = connectionState(connectionId);
      const page = scoped(state, request.source.destinations);
      return { version: "1.0.0", payload: { items: page.map(([, record]) => value(record, connectionId)) }, events: page.map(([id, record], index) => ({ kind: "present", pointer: `/items/${index}`, ref: ref(connectionId, "record", id), schemaRef: schemaRef("record"), destination: ref(connectionId, "shelf", record.shelf), observedAt: now(), revision: String(state.revision), evidenceId: `observed-${id}-${state.revision}` })), gap: false, coverage: "objects" };
    } } },
  } };
}
