/**
 * The canonical derivation of a stack **slug** from a `stack.id`
 * (ADR-0004: "`stack.id`'s trailing segment is the single authority for the
 * stack slug"). Lifted from `stack-lib.ts`'s `stackIdTrailingSlug` (S2,
 * architecture-deepening epic #1514) so the real call sites import one
 * function instead of each carrying their own copy.
 *
 * Scope: this owns the *authoritative* trailing-segment rule, but not every
 * slug guess in the tree funnels through it yet. A few inline sites still
 * derive a slug with a divergent `?? "default"` / `?? agentId` fallback
 * (`stack-lib.ts` ~:635, `network.ts` ~:745 / ~:4022, `network-adapters.ts`
 * ~:864) and are intentionally left untouched in S2 — routing them here would
 * change behavior, not just structure. Route NEW call sites through this
 * function; consolidating the divergent-fallback sites is a separate,
 * behavior-affecting follow-up.
 *
 * The trailing-segment rule mirrors `plist-render.sh`'s `extract_stack_id_slug`
 * (the shell's last-slash parameter strip) — everything after the LAST `/`, or
 * the whole string when there is none. That cross-language parity is asserted here,
 * not yet pinned by a shell-invoking test: `scripts/lib/plist-render.sh` must be
 * kept in step with THIS function by hand (do not re-derive the logic there).
 */

/** The trailing `{slug}` segment of a `{principal}/{slug}` stack id. */
export function stackSlugFromStackId(stackId: string): string {
  const idx = stackId.lastIndexOf("/");
  return idx === -1 ? stackId : stackId.slice(idx + 1);
}
