import type { Actor, Grant, GrantScope, Proposal } from "./creation";
import type { CreateRequest, CreateResult, OperationRecord, ReadbackResult } from "./types";

export interface CreationLifecycle {
  started(): Promise<boolean>;
  reviewRevision(): Promise<string>;
  grantView(grant: Grant): Promise<Grant>;
  grant(proposal: Proposal, scope: GrantScope, actor: Actor): Promise<NonNullable<Grant["binding"]>>;
  revoke(grant: Grant, actor: Actor): Promise<void>;
  create(request: CreateRequest, authority: NonNullable<OperationRecord["authority"]>, actor: Actor, reviewRevision?: string): Promise<CreateResult>;
  check(operation: OperationRecord, actor: Actor): Promise<ReadbackResult>;
}
