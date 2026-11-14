import type { OperationJournal, OwnerResult } from "../operations/types";
import type { ReceiptState } from "./move-host";

const FAILURE_STATES: Readonly<Record<string, ReceiptState>> = { vip_refused: "refused", message_missing: "missing", account_denied: "denied" };

export function receiptState(journal: OperationJournal, result: OwnerResult["result"] | undefined, succeeded: boolean): ReceiptState {
  if (journal.state === "succeeded" && succeeded) return "done";
  if (result?.kind === "failed") return FAILURE_STATES[result.error.code.split(".").at(-1) ?? ""] ?? "failed";
  if (result?.kind === "conflict") return "conflict";
  if (journal.events.some(entry => entry.event.kind === "local-outcome")) return "refused";
  if (["confirmed", "dispatching", "pending"].includes(journal.state)) return "pending";
  return "uncertain";
}

export interface ReceiptWording {
  running: string;
  unconfirmed: string;
}

export function receiptMessage(journal: OperationJournal, result: OwnerResult["result"] | undefined, success: { message: string } | null, state: ReceiptState, wording: ReceiptWording): string {
  if (success) return success.message;
  if (result && "error" in result) return result.error.message;
  const local = journal.events.findLast(entry => entry.event.kind === "local-outcome");
  if (local?.event.kind === "local-outcome") return local.event.reason.message;
  return state === "pending" ? wording.running : wording.unconfirmed;
}
