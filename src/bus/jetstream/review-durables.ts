/**
 * cortex#1503 — the review lane's JetStream durable names, stack-scoped.
 *
 * The review SUBJECTS already carry `{principal}.{stack}`
 * (`reviewScopePatterns`), so two stacks' durable filters are disjoint. The
 * durable NAMES did not: `cortex-review-consumer-{principal}-{agent}` was the
 * same string on every stack of a principal. Two stacks sharing one NATS
 * account then fought over one durable — each boot's cortex#1186 filter-drift
 * branch deleted and recreated it with its own filter, so the other stack's
 * requests matched nothing and `sage dispatch` timed out with no claim.
 *
 * The stack identity is joined as `{principal}_{stack}`. Principal and stack
 * slugs match `[a-z][a-z0-9]*(?:-[a-z0-9]+)*` — they may contain `-` but never
 * `_` — so `{principal}_{stack}` is unambiguous where `{principal}-{stack}`
 * is not (`a-b`/`c` vs `a`/`b-c`).
 *
 * `legacy` carries the pre-#1503 unscoped names so provisioning can migrate
 * (or deliberately leave alone) the durable a previous version created.
 */

/** Durable names for one review consumer kind: the current name plus its pre-#1503 predecessor. */
export interface ReviewDurableName {
  /** Stack-scoped durable this version provisions and binds. */
  durable: string;
  /** Pre-#1503 unscoped durable (`…-{principal}-{agent}`), migrated on first boot. */
  legacy: string;
}

/** The per-kind durable names for one reviewer agent on one stack. */
export interface ReviewDurableNames {
  /** Local-scope Offer consumer (`local.{p}.{s}.tasks.code-review.*`). */
  local: ReviewDurableName;
  /** CO-2 offering-scope consumer for a non-local scope token (`federated`/`public`). */
  offer: (scopeToken: string) => ReviewDurableName;
  /** cortex#686 federated Offer consumer. */
  federated: ReviewDurableName;
  /** cortex#725 federated Direct consumer. */
  federatedDirect: ReviewDurableName;
}

/** Build the stack-scoped review durable names (and their legacy predecessors). */
export function reviewDurableNames(
  principal: string,
  stack: string,
  agentId: string,
): ReviewDurableNames {
  const scoped = `${principal}_${stack}-${agentId}`;
  const unscoped = `${principal}-${agentId}`;
  const named = (prefix: string): ReviewDurableName => ({
    durable: `${prefix}${scoped}`,
    legacy: `${prefix}${unscoped}`,
  });
  return {
    local: named("cortex-review-consumer-"),
    offer: (scopeToken) => named(`cortex-review-consumer-offer-${scopeToken}-`),
    federated: named("cortex-review-consumer-federated-"),
    federatedDirect: named("cortex-review-consumer-federated-direct-"),
  };
}
