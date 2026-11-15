import type { CapabilityMutationPolicy } from "../../authority";
import { mailReplyDraftScopeMatches } from "./reply-draft-contract";
export { MAIL_REPLY_DRAFT_CAPABILITY } from "./reply-draft-contract";

export const mailReplyDraftPolicy: CapabilityMutationPolicy = {
  scopeMatches: (snapshot, connection) => mailReplyDraftScopeMatches(snapshot, (connection.accountScope as { account?: unknown } | null)?.account),
  requiresExactConfirmation: conversationPolicy => conversationPolicy === "local",
};
