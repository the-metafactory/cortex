import type { ApprovedSnapshot } from "../operations/types";
import { canonicalWire } from "../operations/validation";
import type { CapabilityMutationPolicy } from "../../authority";

export const MAIL_REPLY_DRAFT_CAPABILITY = "mail.reply-draft.create";

export const mailReplyDraftPolicy: CapabilityMutationPolicy = {
  scopeMatches: (snapshot, connection) => mailReplyDraftScopeMatches(snapshot, (connection.accountScope as { account?: unknown } | null)?.account),
  requiresExactConfirmation: conversationPolicy => conversationPolicy === "local",
};

export function mailReplyDraftScopeMatches(snapshot: ApprovedSnapshot, account: unknown): boolean {
  const input = snapshot.input;
  if (typeof input !== "object" || input === null || Array.isArray(input) || typeof account !== "string" || !account) return false;
  const message = snapshot.target;
  const destination = snapshot.destinations[0];
  return message?.objectType === "message" && message.adapterId === snapshot.adapterId && message.connectionId === snapshot.connectionId && input.message !== undefined && canonicalWire(input.message) === canonicalWire(message) && typeof input.body === "string" && input.body.trim().length > 0 && snapshot.destinations.length === 1 && destination?.objectType === "account" && destination.adapterId === snapshot.adapterId && destination.connectionId === snapshot.connectionId && destination.canonicalId === account;
}
