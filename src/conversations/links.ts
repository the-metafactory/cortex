import { hasBalanceLink } from "./catalog";
import type { ProposalView } from "./creation";

export function proposalLinks(view: ProposalView) {
  const { proposal, operation } = view;
  return {
    conversation: `?desk=conversation&conversation=${proposal.conversationId}`,
    entry: proposal.entryId ? `/api/conversations/${proposal.conversationId}/entries/${encodeURIComponent(proposal.entryId)}` : null,
    object: operation?.url ?? (hasBalanceLink(proposal.type) && operation?.canonicalId ? `?desk=balance&balance-item=${encodeURIComponent(operation.canonicalId)}` : null),
  };
}
