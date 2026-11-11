import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createDeskAdapter } from "./backend.mjs";

const manifest = JSON.parse(await readFile(`${import.meta.dir}/desk-adapter.json`, "utf8"));
assert.equal(createHash("sha256").update(await readFile(`${import.meta.dir}/backend.mjs`)).digest("hex"), manifest.backend.sha256);
const connectors = new Map();
const instance = createDeskAdapter({ sdkVersion: "1.2.0", registerConnector: (id, factory) => connectors.set(id, factory) });
assert.deepEqual(instance.declaration, manifest.declaration);
const adapterId = "kiln-studio";
const connectionId = "author-local-connection";
const signal = new AbortController().signal;
const root = { adapterId, connectionId, objectType: "root", canonicalId: "studio" };
const base = { readVersion: "1.0.0", queryId: "local-query", input: {}, limit: 2 };
const destinationsPage = instance.bindings.handlers["kiln-studio.kiln.list"]({ ...base, capabilityId: "kiln-studio.kiln.list", destinations: [root] }, signal);
const destinations = destinationsPage.annotations.map(annotation => annotation.ref);
assert.equal(destinations.length, 2);
const query = { ...base, capabilityId: "kiln-studio.firing.list", destinations };
const first = instance.bindings.handlers[query.capabilityId](query, signal);
assert.equal(first.payload.items.length, 2);
assert.ok(first.cursor);
const connector = connectors.get("kiln-studio.firing.create")({ adapterId, connectionId });
const input = { batchName: "Author inspection batch", programme: "glaze-6", loadNotes: "Test record only.", kiln: destinations.find(destination => destination.canonicalId === "amber") };
const request = {
  lifecycleVersion: "1.0.0", operationId: "local-operation", attemptId: "local-attempt", idempotencyKey: "local-no-guarantee", ownerRequestId: "local-owner-request",
  snapshot: { adapterId, connectionId, capabilityId: "kiln-studio.firing.create", inputSchemaRef: { schemaId: "kiln-studio.firing", version: "1.0.0" }, outputSchemaRef: { schemaId: "kiln-studio.created", version: "1.0.0" }, errorSchemaRef: { schemaId: "kiln-studio.error", version: "1.0.0" }, input, destinations: [input.kiln], sources: [], policy: "local", digest: "author-test-digest", provenance: { conversationId: "local-conversation", proposalId: "local-proposal", revision: 1, entryId: null, link: "local-inspection" } },
  authority: { principalRef: "local-author", basis: { kind: "confirmation", confirmationId: "local-confirmation", transport: "web" }, connectionRevision: "1", policyRevision: "1", decisionRef: "local-decision", authorizedAt: new Date().toISOString() },
  supportDeclarationId: connector.support.declarationId, deadlineAt: new Date(Date.now() + 10000).toISOString(),
};
const result = connector.dispatch(request, signal);
assert.equal(result.result.kind, "succeeded");
assert.equal(result.operationId, request.operationId);
assert.equal(result.attemptId, request.attemptId);
assert.equal(result.snapshotDigest, request.snapshot.digest);
assert.equal(result.result.evidence.ownerRequestId, request.ownerRequestId);
const second = instance.bindings.handlers[query.capabilityId]({ ...query, cursor: first.cursor }, signal);
assert.equal(second.snapshot.id, first.snapshot.id);
assert.equal(second.payload.items.length, 2);
assert.equal(second.cursor, undefined);
assert.ok(!second.annotations.some(annotation => annotation.ref.canonicalId === result.result.output.ref.canonicalId));
const readback = connector.readback({ lifecycleVersion: "1.0.0", ref: result.result.output.ref }, signal);
assert.equal(readback.result.kind, "present");
assert.deepEqual(readback.result.value, input);
const observed = instance.bindings.observations["kiln-studio.firing.watch"].fetch({ source: { adapterId, connectionId, capabilityId: "kiln-studio.firing.watch", inputSchemaRef: { schemaId: "kiln-studio.empty", version: "1.0.0" }, input: {}, destinations }, mode: "poll", limit: 20 }, signal);
assert.equal(observed.events.length, 5);
assert.ok(observed.events.every(event => destinations.some(destination => JSON.stringify(destination) === JSON.stringify(event.destination))));
const aborted = new AbortController();
aborted.abort();
assert.throws(() => instance.bindings.handlers[query.capabilityId](query, aborted.signal));
const otherConnection = "author-other-connection";
const otherKiln = { ...input.kiln, connectionId: otherConnection };
const other = instance.bindings.handlers[query.capabilityId]({ ...query, destinations: [otherKiln] }, signal);
assert.equal(other.payload.items.length, 2);
assert.ok(other.annotations.every(annotation => annotation.ref.connectionId === otherConnection));
const report = { status: "passed", checks: ["backend digest", "manifest/factory declaration equality", "two kiln destinations", "four seed firings across two query pages", "stable snapshot across creation", "dispatch correlation and evidence", "canonical readback", "poll observation after creation", "abort signal", "connection isolation"], hostConformanceRun: false };
await writeFile(`${import.meta.dir}/LOCAL-VERIFICATION.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
