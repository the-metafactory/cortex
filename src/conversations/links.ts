import type { ProposalView } from "./creation";

export function proposalLinks(view: ProposalView) {
  const { proposal, operation } = view;
  const balance = proposal.type === "balance-task" || proposal.type === "balance-project" || proposal.type === "balance-inbox-task";
  return {
    conversation: `?desk=conversation&conversation=${proposal.conversationId}`,
    entry: proposal.entryId ? `/api/conversations/${proposal.conversationId}/entries/${encodeURIComponent(proposal.entryId)}` : null,
    object: operation?.url ?? (balance && operation?.canonicalId ? `?desk=balance&balance-item=${encodeURIComponent(operation.canonicalId)}` : null),
  };
}
