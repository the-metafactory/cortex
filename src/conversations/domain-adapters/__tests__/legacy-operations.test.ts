import { expect, test } from "bun:test";
import { defineDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { graphMarker } from "../../../surface/mc/desk/graph-conversation-writer";
import { operationUuid, studioRequestId } from "../../../surface/mc/desk/conversation-ids";
import { AT, attemptFixture, eventFixture, support, approvalFixture, registryFixture } from "../operations/fixtures";
import { importLegacyOperation, previewLegacyOperation, projectLegacyOperation, readOperationEvidence, UpgradeRequired } from "../operations/legacy";
import { OperationJournalStore } from "../operations/journal";
import { legacyContext, legacyFixture } from "../operations/legacy-fixtures";

import { journalStoreTestFixture } from "./journal-store";

const { hosts, open } = journalStoreTestFixture();
const ids = (id: string) => [operationUuid(id), studioRequestId(id), graphMarker(id)];

test("F1/F2/F3/F11/F12 import preserves actual legacy DTOs, owner identities and uncertainty across reopen", async () => {
  for (const state of ["created", "running", "uncertain", "failed", "proposed", "confirmed"] as const) {
    const host = await open();
    const source = legacyFixture(state);
    const before = JSON.stringify(source);
    const identity = ids(source.record.operationId);
    const preview = previewLegacyOperation(source, legacyContext(source));
    expect(await host.journal.read(source.record.operationId)).toBeNull();
    expect(preview.dispatchAllowed).toBe(false);
    const imported = await importLegacyOperation(host.journal, source, legacyContext(source), AT);
    expect(await importLegacyOperation(host.journal, source, legacyContext(source), AT)).toEqual(imported);
    expect(JSON.stringify(source)).toBe(before);
    expect(imported.retryBlocked).toBe(true);
    expect(imported.journal.state).toBe(state === "created" ? "succeeded" : "uncertain");
    expect(imported.journal.snapshot).toHaveProperty("kind", "legacy-unavailable");
    expect(imported.journal.events).toHaveLength(1);
    expect(imported.outbox).toEqual([]);
    await expect(host.journal.append(source.record.operationId, 1, eventFixture(2, { kind: "attempt-prepared", attempt: attemptFixture() }), { support })).rejects.toThrow();
    await host.close(); hosts.pop();
    const reopened = await open(host.dir);
    const stored = await reopened.journal.read(source.record.operationId);
    expect(stored).toEqual(imported);
    const evidence = readOperationEvidence(stored);
    expect(evidence.kind).toBe("legacy");
    if (evidence.kind !== "legacy") throw new Error("Legacy evidence required.");
    expect(evidence.source).toEqual(source);
    expect(ids(evidence.source.record.operationId)).toEqual(identity);
    expect(evidence.source.ownerReceipts).toEqual(source.ownerReceipts);
  }
});

test("F11 missing and ambiguous mappings, malformed identities, dropped receipts and negative readback never promote authority", async () => {
  const source = legacyFixture("failed");
  expect(previewLegacyOperation(source).issues).toContain("legacy_context_missing");
  expect(previewLegacyOperation(source, { ...legacyContext(source), fields: { title: "trimmed" } }).issues).toContain("legacy_fields_ambiguous");
  expect(previewLegacyOperation(source, { ...legacyContext(source), destinations: [{ adapterId: "balance", connectionId: "other", objectType: "area", canonicalId: "area-example" }] }).issues).toContain("legacy_destination_ambiguous");
  for (const readback of [null, { found: false }] as const) {
    const unknown = previewLegacyOperation({ ...source, ownerReceipts: [], readback, createResult: { state: "accepted" } }, legacyContext(source));
    expect(unknown.state).toBe("uncertain");
    expect(unknown.dispatchAllowed).toBe(false);
  }
  const completed = legacyFixture();
  completed.record.canonicalId = " ";
  expect(previewLegacyOperation(completed, JSON.parse(JSON.stringify({ ...legacyContext(completed), canonicalReference: undefined }))).issues).toContain("legacy_canonical_identity_invalid");
  completed.record.operationId = "replacement";
  expect(() => previewLegacyOperation(completed, JSON.parse(JSON.stringify({ ...legacyContext(completed), canonicalReference: undefined })))).toThrow();
});

test("source changes conflict without overwriting imported evidence, including mappings and owner receipts", async () => {
  const host = await open();
  const source = legacyFixture();
  const saved = await importLegacyOperation(host.journal, source, legacyContext(source), AT);
  for (const changed of [{ ...source, ownerReceipts: [] }, { ...source, proposal: { ...source.proposal, fields: { title: "changed" } } }]) {
    await expect(importLegacyOperation(host.journal, changed, legacyContext(changed), AT)).rejects.toThrow();
    expect(await host.journal.read(source.record.operationId)).toEqual(saved);
  }
  await expect(importLegacyOperation(host.journal, source, undefined, AT)).rejects.toThrow();
});

test("real durable transaction abort leaves raw proposal and receipt rows unchanged and importer can retry", async () => {
  const host = await open();
  const SourceDoc = defineDoc<{ raw: string }>({ kind: "synthetic.legacy.receipts", version: 1, scope: "session", initial: () => ({ raw: "" }), checkpointWhen: () => true });
  const source = legacyFixture();
  const raw = JSON.stringify(source);
  await host.engine.commit(async tx => { (await tx.doc(SourceDoc)).raw = raw; }, BACKGROUND_CONTEXT);
  const aborted = new OperationJournalStore({ snapshot: host.engine.snapshot.bind(host.engine), commit: (callback, context) => host.engine.commit(async tx => { await callback(tx); throw new Error("synthetic abort"); }, context) }, registryFixture());
  await expect(importLegacyOperation(aborted, source, legacyContext(source), AT)).rejects.toThrow("synthetic abort");
  expect(await host.journal.read(source.record.operationId)).toBeNull();
  expect((await host.engine.snapshot(SourceDoc, BACKGROUND_CONTEXT))?.raw).toBe(raw);
  await importLegacyOperation(host.journal, source, legacyContext(source), AT);
  expect((await host.engine.snapshot(SourceDoc, BACKGROUND_CONTEXT))?.raw).toBe(raw);
});

test("F15 readers preserve unknown raw formats and refuse unsafe DTO projections", async () => {
  const host = await open();
  const source = legacyFixture();
  const saved = await importLegacyOperation(host.journal, source, legacyContext(source), AT);
  expect(projectLegacyOperation(saved)).toEqual(source.record);
  const failed = legacyFixture("failed");
  const other = await open();
  const uncertain = await importLegacyOperation(other.journal, failed, legacyContext(failed), AT);
  expect(projectLegacyOperation(uncertain).state).toBe("uncertain");
  const lifecycle = await (await open()).journal.approve(approvalFixture());
  expect(readOperationEvidence(lifecycle).kind).toBe("lifecycle");
  expect(projectLegacyOperation(lifecycle, { owner: "balance-task", adapterId: "balance", connectionId: "connection-example", capabilityId: "balance.task.create" }).state).toBe("confirmed");
  for (const raw of [{ ...lifecycle, journal: { ...lifecycle.journal, lifecycleVersion: "2.0.0" } }, { ...lifecycle, journal: { ...lifecycle.journal, extra: true } }, { ...lifecycle, journal: { ...lifecycle.journal, links: { batchId: crypto.randomUUID(), itemId: "item" } } }, { ...lifecycle, journal: { ...lifecycle.journal, state: "cancelled" } }]) {
    const before = JSON.stringify(raw);
    expect(() => projectLegacyOperation(raw)).toThrow(UpgradeRequired);
    expect(JSON.stringify(raw)).toBe(before);
  }
});


test("F12 persisted owner request IDs preserve Balance, Studio, Flow and graph writer mappings", async () => {
  for (const owner of ["balance-task", "studio-note", "flow", "graph-node"] as const) {
    const host = await open();
    const source = legacyFixture();
    source.proposal.type = owner;
    source.record.owner = owner;
    const context = { ...legacyContext(source), owner };
    const imported = await importLegacyOperation(host.journal, source, context, AT);
    const expected = owner === "balance-task" ? operationUuid(source.record.operationId) : studioRequestId(source.record.operationId);
    expect(imported.journal.ownerRequestId).toBe(expected);
    if (owner === "graph-node") expect(`<!-- conversation-operation ${imported.journal.ownerRequestId} -->`).toBe(graphMarker(source.record.operationId));
    expect((await host.journal.read(source.record.operationId))?.journal.ownerRequestId).toBe(expected);
    expect((await importLegacyOperation(host.journal, source, context, AT)).journal.ownerRequestId).toBe(expected);
  }
});

test("legacy-only and preapproval projections require an upgraded reader rather than invite reconfirmation", async () => {
  expect(() => projectLegacyOperation(legacyFixture())).toThrow(UpgradeRequired);
  for (const state of ["proposed", "confirmed"] as const) {
    const host = await open();
    const source = legacyFixture(state);
    const imported = await importLegacyOperation(host.journal, source, legacyContext(source), AT);
    expect(() => projectLegacyOperation(imported)).toThrow(UpgradeRequired);
    const evidence = readOperationEvidence(imported);
    expect(evidence.kind === "legacy" ? evidence.source.record.state : null).toBe(state);
  }
});


test("F1 historical completed success survives missing or changed mapping context without execution eligibility", async () => {
  for (const edited of [false, true]) {
    const host = await open();
    const source = legacyFixture();
    if (edited) {
      source.proposal.revision++;
      source.proposal.fields.title = "Edited after completion";
    }
    const imported = await importLegacyOperation(host.journal, source, edited ? legacyContext(source) : undefined, AT);
    expect(imported.journal.state).toBe("succeeded");
    expect(imported.retryBlocked).toBe(true);
    expect(() => projectLegacyOperation(imported)).toThrow(UpgradeRequired);
    const evidence = readOperationEvidence(imported);
    expect(evidence.kind === "legacy" ? evidence.source.record.state : null).toBe("created");
    expect(evidence.kind === "legacy" ? evidence.issues.length : 0).toBeGreaterThan(0);
  }
});

test("lifecycle projection rejects an owner label forged onto a supported capability", async () => {
  const host = await open();
  const lifecycle = await host.journal.approve(approvalFixture());
  expect(() => projectLegacyOperation(lifecycle, { owner: "graph-node", adapterId: "balance", connectionId: "connection-example", capabilityId: "balance.task.create" })).toThrow(UpgradeRequired);
});
