import { randomUUID } from "node:crypto";
import type { OperationJournalStore, StoredOperation } from "../operations/journal";
import type { ApprovedSnapshot, OperationJournal, OwnerResult } from "../operations/types";
import type { BoundaryError, CapabilityDiscovery } from "../types";
import type { OperationIndex } from "./legacy-move";
import type { ApprovalDecision, MailMoveAuthority } from "./move-host";

export interface MailHostOptions {
  adapterId: string;
  connectionId: string;
  account: string;
  journal: OperationJournalStore;
  index: OperationIndex;
  authority: MailMoveAuthority;
  capability(capabilityId: string): CapabilityDiscovery;
  dispatch(operationId: string): Promise<unknown>;
  now?: () => number;
}

export async function dispatchMailOperation(options: MailHostOptions, snapshot: ApprovedSnapshot, operationId: string, grantId: string | null, compensates?: string): Promise<ApprovalDecision> {
  const decision = await options.authority.approve({ operationId, idempotencyKey: operationId, ownerRequestId: randomUUID(), snapshot, ...(compensates ? { links: { compensatesOperationId: compensates } } : {}) }, grantId);
  if (decision.kind === "allowed") {
    await options.index.add(operationId, compensates);
    await options.dispatch(operationId);
  }
  return decision;
}

export const ownerResults = (journal: OperationJournal): OwnerResult["result"][] =>
  journal.events.flatMap(entry => entry.event.kind === "owner-result" ? [entry.event.response.result] : entry.event.kind === "reconciliation" && entry.event.lookup.result.kind === "known" ? [entry.event.lookup.result.response.result] : []);

export async function loadOperations(options: Pick<MailHostOptions, "journal">, ids: readonly string[]): Promise<StoredOperation[]> {
  const stored = await Promise.all(ids.map(id => options.journal.read(id)));
  return stored.filter((item): item is StoredOperation => item !== null);
}

/** True when a stored lifecycle operation belongs to this connection and account. */
export function ownsMailOperation(options: Pick<MailHostOptions, "adapterId" | "connectionId" | "account">, snapshot: StoredOperation["journal"]["snapshot"]): snapshot is Exclude<StoredOperation["journal"]["snapshot"], { kind: string }> {
  return !("kind" in snapshot) && snapshot.adapterId === options.adapterId && snapshot.connectionId === options.connectionId && snapshot.destinations[0]?.canonicalId === options.account;
}

export type SettledMailOperation<Receipt> = { kind: "denied"; reason: BoundaryError } | { kind: "receipt"; receipt: Receipt };

/** Approves and dispatches one operation, then reads its receipt back from the journal. */
export async function settleMailOperation<Receipt>(options: MailHostOptions, snapshot: ApprovedSnapshot, operationId: string, grantId: string | null, read: (operationId: string) => Promise<Receipt | null>, compensates?: string): Promise<SettledMailOperation<Receipt>> {
  const decision = await dispatchMailOperation(options, snapshot, operationId, grantId, compensates);
  if (decision.kind === "denied") return { kind: "denied", reason: decision.reason };
  const receipt = await read(operationId);
  return receipt ? { kind: "receipt", receipt } : { kind: "denied", reason: { code: "mail.receipt_missing", message: "The attempt left no journal record." } };
}

export function mailCapabilityDeclared(options: Pick<MailHostOptions, "adapterId" | "capability">, capabilityId: string): boolean {
  const found = options.capability(capabilityId);
  return found.support === "declared" && found.adapterId === options.adapterId && found.availability.state === "available";
}
