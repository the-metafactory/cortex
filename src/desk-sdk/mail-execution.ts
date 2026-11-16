import type { DeskAdapterConnection } from "./index";
import type { ApprovedSnapshot, LookupRequest } from "../conversations/domain-adapters/operations/types";

export type DeskMailExecutionMethod = "draft" | "lookup" | "move" | "restore" | "lookupMove" | "unsubscribe" | "lookupUnsubscribe" | "report" | "lookupReport" | "invitationReply" | "invitationRemove" | "invitationRestore" | "lookupInvitation";

export interface DeskMailExecutionConnection {
  readonly version: number;
  readonly methods: readonly DeskMailExecutionMethod[];
}

export interface DeskMailOperationContext {
  readonly operationId: string;
  readonly attemptId: string;
  readonly ownerRequestId: string;
  readonly snapshotDigest: string;
  readonly snapshot: ApprovedSnapshot;
}

export interface DeskMailExecutionBridge {
  connection(connection: DeskAdapterConnection): DeskMailExecutionConnection | null;
  invoke(connection: DeskAdapterConnection, method: DeskMailExecutionMethod, input: unknown): Promise<unknown>;
  lookupContext(connection: DeskAdapterConnection, request: LookupRequest): Promise<DeskMailOperationContext>;
}
