import { randomUUID } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DomainAdapterRegistry } from "../registry";
import { balanceDeclaration, fixtureBindings, objectRef } from "../fixtures";
import { OperationJournalStore, type Approval } from "./journal";
import type { Attempt, Authority, JournalEvent, OwnerResult, OwnerSupport } from "./types";
import { snapshotDigest } from "./validation";

export const AT = "2026-11-01T00:00:00.000Z";
export const authority: Authority = { principalRef: "principal-example", basis: { kind: "confirmation", confirmationId: "confirmation-example", transport: "web" }, connectionRevision: "connection-revision", policyRevision: "policy-revision", decisionRef: "decision-example", authorizedAt: AT };
export const support: OwnerSupport = { lifecycleVersion: "1.0.0", adapterId: "balance", connectionId: "connection-example", capabilityId: "balance.task.create", declarationId: "support-example", dedup: { kind: "none" }, operationLookup: "none", conditionalUpdate: "none", cancellation: "none" };
export function registryFixture(): DomainAdapterRegistry {
  const registry = new DomainAdapterRegistry();
  const declaration = balanceDeclaration();
  const registered = registry.register(declaration, fixtureBindings(declaration));
  if (!registered.ok) throw new Error(registered.error.code);
  return registry;
}
export function approvalFixture(operationId = "conversation-example:proposal-example:1"): Approval {
  const snapshot = {
    provenance: { conversationId: "conversation-example", proposalId: "proposal-example", revision: 1, entryId: null, link: "?desk=conversation&conversation=conversation-example" },
    adapterId: "balance", connectionId: "connection-example", capabilityId: "balance.task.create",
    inputSchemaRef: { schemaId: "balance.task.create.input", version: "1.0.0" }, outputSchemaRef: { schemaId: "balance.task.create.output", version: "1.0.0" }, errorSchemaRef: { schemaId: "balance.error", version: "1.0.0" },
    input: { area: objectRef("balance", "area", "area-example"), title: "Synthetic task" }, destinations: [objectRef("balance", "area", "area-example")], sources: [], policy: "local" as const,
  };
  return { operationId, idempotencyKey: operationId, ownerRequestId: "request-example", snapshot: { ...snapshot, digest: snapshotDigest(snapshot) }, authority, at: AT };
}
export function attemptFixture(): Attempt { return { attemptId: randomUUID(), number: 1, kind: "initial", preparedAt: AT, deadlineAt: "2026-11-01T00:00:30.000Z", authority, supportDeclarationId: support.declarationId }; }
export function eventFixture(sequence: number, event: JournalEvent["event"], at = AT): JournalEvent { return { sequence, eventId: randomUUID(), at, event }; }
export function resultFixture(approval: Approval, attempt: Attempt, kind: "accepted" | "succeeded" = "accepted"): OwnerResult {
  return { lifecycleVersion: "1.0.0", operationId: approval.operationId, attemptId: attempt.attemptId, snapshotDigest: approval.snapshot.digest, resultId: `result-${kind}`, reportedAt: AT,
    result: kind === "accepted" ? { kind, ownerRequestId: approval.ownerRequestId, receipt: { ticket: "ticket-example", nested: [false, null, 1] } } : { kind, output: { ref: objectRef("balance", "task", "task-example") }, evidence: { kind: "effect", evidenceId: "evidence-example", observedAt: AT, ownerRequestId: approval.ownerRequestId, receipt: { committed: true }, refs: [objectRef("balance", "task", "task-example")] } },
  };
}
export async function openJournalFixture(path: string): Promise<{ engine: Harness; journal: OperationJournalStore; close: () => Promise<void> }> {
  const engine = await Harness.open(await openNodeSqliteStorage(path), { registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
  return { engine, journal: new OperationJournalStore(engine, registryFixture()), close: () => engine.close(BACKGROUND_CONTEXT) };
}

export async function prepareOperationFixture(journal: OperationJournalStore) {
  const approval = approvalFixture();
  const attempt = attemptFixture();
  await journal.approve(approval);
  const stored = await journal.append(approval.operationId, 1, eventFixture(2, { kind: "attempt-prepared", attempt }), { support });
  return { approval, attempt, stored };
}
