/**
 * The single TS authority for deriving a stack **slug** from a `stack.id`
 * (ADR-0004: "`stack.id`'s trailing segment is the single authority for the
 * stack slug"). Lifted from `stack-lib.ts`'s `stackIdTrailingSlug` (S2,
 * architecture-deepening epic #1514) so the real call sites import one
 * function instead of each carrying their own copy.
 *
 * Byte-for-byte replica of the trailing-segment step inside
 * `plist-render.sh`'s `extract_stack_id_slug` (the shell `id##` pattern strip
 * on the last slash) — take everything after the LAST `/`, or the whole
 * string when there is none. `scripts/lib/plist-render.sh`'s
 * `extract_stack_id_slug` mirrors THIS function; the shell script itself is
 * not edited here (do not re-derive this logic there).
 */

/** The trailing `{slug}` segment of a `{principal}/{slug}` stack id. */
export function stackSlugFromStackId(stackId: string): string {
  const idx = stackId.lastIndexOf("/");
  return idx === -1 ? stackId : stackId.slice(idx + 1);
}
