import { randomUUID } from "node:crypto";
import type { OperationJournalStore } from "../operations/journal";
import type { ApprovedSnapshot } from "../operations/types";
import type { CapabilityDiscovery } from "../types";
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
