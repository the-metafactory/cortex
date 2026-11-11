import { adapterId, declaration, schemaRef } from "./definition.mjs";

const now = () => new Date().toISOString();
const ref = (connectionId, objectType, canonicalId) => ({ adapterId, connectionId, objectType, canonicalId });
const sameRef = (left, right) => left.adapterId === right.adapterId && left.connectionId === right.connectionId && left.objectType === right.objectType && left.canonicalId === right.canonicalId;
const kilns = new Map([
  ["amber", { name: "Amber electric kiln", chamberLitres: 120 }],
  ["cobalt", { name: "Cobalt test kiln", chamberLitres: 45 }],
]);
const pageLimit = (requested, maximum = 2) => {
  if (!Number.isInteger(requested) || requested < 1) throw new Error("A positive integer page limit is required");
  return Math.min(requested, maximum);
};
const connectionFor = destinations => {
  const ids = new Set(destinations.map(destination => destination.connectionId));
  if (ids.size !== 1 || destinations.some(destination => destination.adapterId !== adapterId)) throw new Error("One kiln studio connection is required");
  return ids.values().next().value;
};

export function createDeskAdapter(host) {
  const owners = new Map();
  const cursors = new Map();
  let sequence = 0;
  const ownerFor = connectionId => {
    if (!owners.has(connectionId)) owners.set(connectionId, {
      revision: 1,
      nextId: 5,
      records: new Map([
        ["firing-1", { batchName: "Porcelain breakfast bowls", programme: "bisque-04", loadNotes: "Place bowls on the lower shelves.", kiln: "amber" }],
        ["firing-2", { batchName: "Celadon tea cups", programme: "glaze-6", loadNotes: "Leave space around glazed rims.", kiln: "amber" }],
        ["firing-3", { batchName: "Terracotta planters", programme: "bisque-04", loadNotes: "Load the largest pots first.", kiln: "amber" }],
        ["firing-4", { batchName: "Small glaze test tiles", programme: "glaze-6", loadNotes: "Use numbered test stands.", kiln: "cobalt" }],
      ]),
    });
    return owners.get(connectionId);
  };
  const value = (record, connectionId) => ({ batchName: record.batchName, programme: record.programme, loadNotes: record.loadNotes, kiln: ref(connectionId, "kiln", record.kiln) });
  const scoped = (connectionId, destinations) => [...ownerFor(connectionId).records].filter(([, record]) => destinations.some(destination => sameRef(destination, ref(connectionId, "kiln", record.kiln))));
  const annotation = (connectionId, objectType, id, destination, index, position, revision, observedAt) => ({ pointer: `/items/${index}`, ref: ref(connectionId, objectType, id), schemaRef: schemaRef(objectType), destination, position, evidence: { evidenceId: `read-${objectType}-${id}-${revision}`, revision, observedAt } });
  const scopeKey = request => JSON.stringify([request.capabilityId, request.destinations.map(destination => JSON.stringify([destination.adapterId, destination.connectionId, destination.objectType, destination.canonicalId])).sort()]);
  const queryPage = (request, signal, objectType, rows, revision) => {
    signal.throwIfAborted();
    const key = scopeKey(request);
    let saved;
    if (request.cursor !== undefined) {
      saved = cursors.get(request.cursor);
      if (!saved || saved.key !== key) throw new Error("Unknown cursor or changed destination scope");
    } else saved = { key, rows, revision, offset: 0, snapshotId: `kiln-snapshot-${++sequence}`, observedAt: now() };
    const page = saved.rows.slice(saved.offset, saved.offset + pageLimit(request.limit));
    const next = saved.offset + page.length;
    let cursor;
    if (next < saved.rows.length) {
      cursor = `kiln-page-${++sequence}`;
      cursors.set(cursor, { ...saved, offset: next });
    }
    return {
      readVersion: "1.0.0", payload: { items: page.map(row => row.value) },
      annotations: page.map((row, index) => annotation(row.connectionId, objectType, row.id, row.destination, index, saved.offset + index, saved.revision, saved.observedAt)),
      observedAt: saved.observedAt, ordering: "provider", snapshot: { kind: "stable", id: saved.snapshotId }, ...(cursor ? { cursor } : {}),
    };
  };
  const listKilns = (request, signal) => {
    signal.throwIfAborted();
    const connectionId = connectionFor(request.destinations);
    const rows = [...kilns].map(([id, kiln]) => ({ id, connectionId, value: { ...kiln }, destination: ref(connectionId, "kiln", id) }));
    return queryPage(request, signal, "kiln", rows, "1");
  };
  const listFirings = (request, signal) => {
    signal.throwIfAborted();
    const connectionId = connectionFor(request.destinations);
    const rows = scoped(connectionId, request.destinations).map(([id, record]) => ({ id, connectionId, value: value(record, connectionId), destination: ref(connectionId, "kiln", record.kiln) }));
    return queryPage(request, signal, "firing", rows, String(ownerFor(connectionId).revision));
  };
  host.registerConnector("kiln-studio.firing.create", connection => ({
    kind: "action", ...connection, capabilityId: "kiln-studio.firing.create", writerOwner: "ceramic-studio-local-owner",
    support: { lifecycleVersion: "1.0.0", ...connection, capabilityId: "kiln-studio.firing.create", declarationId: "kiln-studio-create-support-1", dedup: { kind: "none" }, operationLookup: "none", conditionalUpdate: "none", cancellation: "none" },
    readbackCapabilityId: "kiln-studio.firing.list",
    dispatch(request, signal) {
      signal.throwIfAborted();
      const input = request.snapshot.input;
      const destination = input.kiln;
      if (request.snapshot.adapterId !== connection.adapterId || request.snapshot.connectionId !== connection.connectionId || request.snapshot.capabilityId !== "kiln-studio.firing.create" || destination.adapterId !== adapterId || destination.connectionId !== connection.connectionId || destination.objectType !== "kiln" || !kilns.has(destination.canonicalId) || !request.snapshot.destinations.some(admitted => sameRef(admitted, destination))) throw new Error("The firing kiln must be an authorized destination in this connection");
      const owner = ownerFor(connection.connectionId);
      const id = `firing-${owner.nextId++}`;
      owner.records.set(id, { batchName: input.batchName, programme: input.programme, loadNotes: input.loadNotes, kiln: destination.canonicalId });
      owner.revision++;
      const created = ref(connection.connectionId, "firing", id);
      const observedAt = now();
      return {
        lifecycleVersion: "1.0.0", operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest, resultId: `created-${id}-${owner.revision}`, reportedAt: observedAt,
        result: { kind: "succeeded", output: { ref: created }, evidence: { kind: "effect", evidenceId: `effect-${id}-${owner.revision}`, observedAt, ownerRequestId: request.ownerRequestId, ownerRevision: String(owner.revision), receipt: { firingId: id }, refs: [created] } },
      };
    },
    readback(request, signal) {
      signal.throwIfAborted();
      const requested = request.ref;
      const owner = ownerFor(connection.connectionId);
      const record = requested.adapterId === connection.adapterId && requested.connectionId === connection.connectionId && requested.objectType === "firing" ? owner.records.get(requested.canonicalId) : undefined;
      const envelope = { lifecycleVersion: "1.0.0", ref: requested, checkedAt: now(), provenance: { ...connection, evidenceId: `readback-${requested.canonicalId}-${owner.revision}` } };
      return record
        ? { ...envelope, result: { kind: "present", schemaRef: schemaRef("firing"), value: value(record, connection.connectionId), ownerRevision: String(owner.revision), links: [] } }
        : { ...envelope, result: { kind: "unknown", reason: { code: "kiln-studio.unknown-firing", message: "No current firing record has this reference in this connection." } } };
    },
  }));
  return { declaration, bindings: {
    handlers: { "kiln-studio.kiln.list": listKilns, "kiln-studio.firing.list": listFirings },
    observations: { "kiln-studio.firing.watch": { modes: ["poll"], fetch(request, signal) {
      signal.throwIfAborted();
      const connectionId = request.source.connectionId;
      if (request.source.adapterId !== adapterId || request.source.destinations.some(destination => destination.adapterId !== adapterId || destination.connectionId !== connectionId)) throw new Error("Observation destinations must belong to the source connection");
      const rows = scoped(connectionId, request.source.destinations).slice(0, pageLimit(request.limit, 20));
      const observedAt = now();
      const revision = String(ownerFor(connectionId).revision);
      return { version: "1.0.0", payload: { items: rows.map(([, record]) => value(record, connectionId)) }, events: rows.map(([id, record], index) => ({ kind: "present", pointer: `/items/${index}`, ref: ref(connectionId, "firing", id), schemaRef: schemaRef("firing"), destination: ref(connectionId, "kiln", record.kiln), observedAt, revision, evidenceId: `observed-${id}-${revision}` })), gap: false, coverage: "objects" };
    } } },
  } };
}
