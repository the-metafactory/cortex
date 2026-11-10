import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { defineDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { graphMarker } from "../../../surface/mc/desk/graph-conversation-writer";
import { operationUuid, studioRequestId } from "../../../surface/mc/desk/conversation-ids";
import { AT, attemptFixture, eventFixture, support, approvalFixture, registryFixture } from "../operations/fixtures";
import { importLegacyOperation, previewLegacyOperation, projectLegacyOperation, readOperationEvidence, UpgradeRequired } from "../operations/legacy";
import { OperationJournalStore } from "../operations/journal";
import { graphNodeLegacyContext, graphNodeLegacyFixture, legacyContext, legacyFixture } from "../operations/legacy-fixtures";
import { canonicalWire } from "../operations/validation";

import { expectLegacyReviewRequired, journalStoreTestFixture } from "./journal-store";

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
    const evidence = expectLegacyReviewRequired(imported);
    expect(evidence.kind === "legacy" ? evidence.source.record.state : null).toBe("created");
    expect(evidence.kind === "legacy" ? evidence.issues.length : 0).toBeGreaterThan(0);
  }
});

test("lifecycle projection rejects an owner label forged onto a supported capability", async () => {
  const host = await open();
  const lifecycle = await host.journal.approve(approvalFixture());
  expect(() => projectLegacyOperation(lifecycle, { owner: "graph-node", adapterId: "balance", connectionId: "connection-example", capabilityId: "balance.task.create" })).toThrow(UpgradeRequired);
});

test("legacy conversion rejects unsupported capabilities and mismatched destination and canonical references", async () => {
  const source = legacyFixture();
  const context = legacyContext(source);
  const area = context.destinations[0]!;
  const canonical = context.canonicalReference!;
  for (const mapping of [
    { ...context, capabilityId: "arbitrary.unsupported" },
    { ...context, owner: "graph-node" as const },
    { ...context, adapterId: "another-adapter" },
    { ...context, canonicalReference: { ...canonical, objectType: "project" } },
    { ...context, canonicalReference: { ...canonical, canonicalId: "different-task" } },
    { ...context, destinations: [{ ...area, objectType: "project" }] },
    { ...context, destinations: [{ ...area, canonicalId: "different-area" }] },
    { ...context, destinations: [] },
    { ...context, destinations: [area, { ...area, objectType: "project", canonicalId: "extra-project" }] },
    { ...context, destinations: [area, area] },
  ]) {
    const host = await open();
    const before = JSON.stringify(source);
    expect(previewLegacyOperation(source, mapping).issues.length).toBeGreaterThan(0);
    const imported = await importLegacyOperation(host.journal, source, mapping, AT);
    const evidence = expectLegacyReviewRequired(imported);
    expect(evidence.kind === "legacy" ? evidence.source : null).toEqual(source);
    expect(JSON.stringify(source)).toBe(before);
  }
});

test("Balance task conversion binds exact area and optional project fields without normalizing legacy edits", async () => {
  const source = legacyFixture();
  const identity = "3f2e4932-9a89-4f2a-8c1e-6c7e5c5f2a11";
  source.proposal.fields.project = identity;
  const context = legacyContext(source);
  const project = { ...context.destinations[0]!, objectType: "project", canonicalId: identity };
  const complete = { ...context, destinations: [project, ...context.destinations] };
  expect(previewLegacyOperation(source, context).issues.length).toBeGreaterThan(0);
  expect(previewLegacyOperation(source, complete).issues).toEqual([]);
  const host = await open();
  expect(projectLegacyOperation(await importLegacyOperation(host.journal, source, complete, AT))).toEqual(source.record);
  source.proposal.fields.project = ` ${identity} `;
  const ambiguous = { ...complete, fields: structuredClone(source.proposal.fields) };
  expect(previewLegacyOperation(source, ambiguous).issues.length).toBeGreaterThan(0);
});

test("a legacy project title is reported ambiguous and is never stored as a canonical identity", async () => {
  const source = legacyFixture();
  source.proposal.fields.project = "Glider";
  const context = legacyContext(source);
  const titled = { ...context.destinations[0]!, objectType: "project", canonicalId: "Glider" };
  const mapping = { ...context, destinations: [titled, ...context.destinations] };
  expect(previewLegacyOperation(source, mapping).issues).toContain("legacy_destination_ambiguous");
  const host = await open();
  const imported = await importLegacyOperation(host.journal, source, mapping, AT);
  const evidence = readOperationEvidence(imported);
  expect(evidence.kind).toBe("legacy");
  if (evidence.kind !== "legacy") throw new Error("Legacy evidence required.");
  expect(evidence.issues).toContain("legacy_destination_ambiguous");
  expect(evidence.context?.destinations.some(ref => ref.canonicalId === "Glider")).toBe(false);
  expect(evidence.source.proposal.fields.project).toBe("Glider");
  expect(evidence.source.ownerReceipts).toEqual(source.ownerReceipts);
  expect(() => projectLegacyOperation(imported)).toThrow(UpgradeRequired);
});

test("unsupported owner conversions retain evidence and request identities without a legacy DTO projection", async () => {
  const source = legacyFixture();
  source.record.owner = "studio-note";
  source.proposal.type = "studio-note";
  const context = { ...legacyContext(source), owner: "studio-note" as const, adapterId: "studio", capabilityId: "studio.note.create" };
  expect(previewLegacyOperation(source, context).issues).toContain("legacy_capability_mapping_unsupported");
  const host = await open();
  const imported = await importLegacyOperation(host.journal, source, context, AT);
  expect(imported.journal.ownerRequestId).toBe(studioRequestId(source.record.operationId));
  expect(imported.journal.state).toBe("succeeded");
  expect(() => projectLegacyOperation(imported)).toThrow(UpgradeRequired);
  expect(readOperationEvidence(imported)).toMatchObject({ kind: "legacy", source });
});

test("readers revalidate persisted mappings whose old import marker did not report conversion issues", async () => {
  const source = legacyFixture();
  const context = { ...legacyContext(source), capabilityId: "arbitrary.unsupported" };
  const host = await open();
  const imported = await importLegacyOperation(host.journal, source, context, AT);
  const event = imported.journal.events[0]!.event;
  if (event.kind !== "legacy-import") throw new Error("Legacy import event required.");
  const rawRecord = z.json().parse({ source, context, issues: [] });
  event.rawRecord = rawRecord;
  event.sourceDigest = createHash("sha256").update(canonicalWire(rawRecord)).digest("hex");
  expect(readOperationEvidence(imported)).toMatchObject({ kind: "legacy", issues: ["legacy_capability_mapping_unsupported"] });
  expect(() => projectLegacyOperation(imported)).toThrow(UpgradeRequired);
  expect(event.rawRecord).toEqual(rawRecord);
});

test("graph-node history maps with the studio request id, keeps the canonical id exactly and resolves a bare parent only against its repository", async () => {
  for (const parent of ["12", "#12", "example/desk#12", "github:github.com/example/desk#12"]) {
    const host = await open();
    const source = graphNodeLegacyFixture({ parent });
    const context = graphNodeLegacyContext(source);
    expect(previewLegacyOperation(source, context).issues).toEqual([]);
    const imported = await importLegacyOperation(host.journal, source, context, AT);
    expect(imported.journal.ownerRequestId).toBe(studioRequestId(source.record.operationId));
    expect(imported.journal.state).toBe("succeeded");
    expect(projectLegacyOperation(imported)).toEqual(source.record);
    expect(projectLegacyOperation(imported).canonicalId).toBe("example/desk#40");
  }
});

test("graph-node history that cannot be mapped exactly is legacy_destination_ambiguous", async () => {
  const base = graphNodeLegacyFixture();
  const ambiguous = (source: ReturnType<typeof graphNodeLegacyFixture>, context = graphNodeLegacyContext(source)) => previewLegacyOperation(source, context).issues;
  expect(ambiguous(graphNodeLegacyFixture({ parent: "other/repo#12" }))).toContain("legacy_destination_ambiguous");
  expect(ambiguous(graphNodeLegacyFixture({ parent: "--repo" }))).toContain("legacy_destination_ambiguous");
  expect(ambiguous(graphNodeLegacyFixture({ parent: " 12 " }))).toContain("legacy_destination_ambiguous");
  expect(ambiguous(graphNodeLegacyFixture({ parent: "" }))).toContain("legacy_destination_ambiguous");
  expect(ambiguous(base, { ...graphNodeLegacyContext(base), destinations: [] })).toContain("legacy_destination_ambiguous");
  const other = { ...graphNodeLegacyContext(base).destinations[0]!, canonicalId: "github:github.com/example/other" };
  expect(ambiguous(base, { ...graphNodeLegacyContext(base), destinations: [other] })).toContain("legacy_destination_ambiguous");
  expect(ambiguous(base, { ...graphNodeLegacyContext(base), canonicalReference: { ...graphNodeLegacyContext(base).canonicalReference!, canonicalId: "example/desk#41" } })).toContain("legacy_canonical_mapping_unsupported");
});
