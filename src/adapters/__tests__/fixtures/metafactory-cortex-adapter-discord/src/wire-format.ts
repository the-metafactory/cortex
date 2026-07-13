/**
 * cortex#120 — Inbound wire-format parser.
 *
 * The Discord channel routing SOP (CLAUDE.md `## Discord Channel Routing`)
 * says agents should auto-create `{repo}/pr/<N>` threads when a review
 * request lands in a channel with no existing thread. The wire format is:
 *
 *     <@!?botId> review <repo-short>#<N> [...]
 *
 * This module is a pure parser — no discord.js or runtime deps — so it
 * can be unit-tested without spinning up an adapter.
 *
 * Scope: ONLY the `review` verb for v1. Other verbs (`work-on`, `ship`,
 * `babysit`) are explicitly deferred to a follow-up PR per the issue
 * acceptance criteria.
 *
 * The regex requires a leading `<@mention>` so we don't auto-thread on
 * casual messages like "what's the status on review cortex#118?". The
 * @-mention is the principal's explicit "this is for the bot" signal.
 *
 * Repo-short charset: lower-case ASCII letter to start, then letters /
 * digits / underscore / hyphen. Matches the GitHub repo-name policy that
 * cortex's `github.repos` config carries (e.g. `meta-factory`, `myelin`,
 * `cortex`).
 */

/** Parsed wire format. Currently only `review` is supported. */
export interface ReviewWireFormat {
  kind: "review";
  /** Discord snowflake of the @-mentioned bot. */
  botId: string;
  /** Short repo name from `<repo>#<N>` — e.g. `cortex`, `meta-factory`. */
  repo: string;
  /** PR number (kept as string so leading zeros / large numbers are
   *  preserved verbatim; callers convert as needed). */
  prNumber: string;
}

/**
 * Pattern: leading optional whitespace, `<@!?botId>`, mandatory whitespace,
 * the verb `review` (case-insensitive), mandatory whitespace, then
 * `<repo-short>#<N>` with a word boundary after the digits.
 *
 * `<@!123>` and `<@123>` are both valid Discord mention encodings — the
 * `!` form was used for "nickname mention" historically and Discord still
 * emits it; clients accept either. We accept both via `<@!?...>`.
 *
 * Why `\s+` between `<@id>` and `review`: Discord clients always emit a
 * space between the mention and the next word; not requiring whitespace
 * would false-match `<@123>review` glued together which doesn't occur in
 * practice and looks like a bot. `\s+` keeps the parse predictable.
 *
 * Why the `[a-z][a-z0-9_-]+` repo charset: matches the GitHub repo-name
 * rules cortex already encodes in `github.repos` lookups. Underscores
 * appear in some metafactory repos (e.g. `signal_collector`). Tightening
 * the charset prevents matching `review @foo#1` or other shapes that
 * could otherwise be parsed.
 */
const REVIEW_PATTERN =
  /^\s*<@!?(\d+)>\s+[Rr][Ee][Vv][Ii][Ee][Ww]\s+([a-z][a-z0-9_-]+)#(\d+)\b/;

/**
 * Parse a raw Discord message body for the review wire format.
 *
 * Returns the parsed format on match, or `null` if the message doesn't
 * match the wire-format shape. The caller is responsible for further
 * gating (e.g. "is the mentioned bot id ME?") because this module is
 * platform-agnostic and doesn't know which adapter is asking.
 *
 * Whitespace handling: leading whitespace is tolerated (the regex
 * anchors with `^\s*`). Trailing content after `<repo>#<N>` is allowed
 * and not captured — principals frequently follow the verb-target pair
 * with a comment ("review cortex#118 -- focus on the dispatch path"),
 * so we accept arbitrary tail content.
 */
export function parseReviewWireFormat(content: string): ReviewWireFormat | null {
  const match = REVIEW_PATTERN.exec(content);
  if (!match) return null;
  const [, botId, repo, prNumber] = match;
  if (!botId || !repo || !prNumber) return null;
  return {
    kind: "review",
    botId,
    repo,
    prNumber,
  };
}

/**
 * Build the canonical thread name for a review wire format.
 *
 * Naming convention is per the cortex CLAUDE.md SOP:
 *
 *     {repo}/pr/<N>          — e.g. cortex/pr/118
 *
 * NOT `PR #<N>` (which is JC's Ivy stack's convention; cortex picks the
 * SOP form so multi-repo guilds disambiguate cleanly:
 * `cortex/pr/118` vs `arc/pr/139` vs `myelin/pr/92`).
 *
 * Exported so the adapter and tests share the exact formatter; if the
 * convention ever changes (e.g. a future iteration adds a guild prefix),
 * every callsite updates in lockstep.
 */
export function reviewThreadName(parsed: ReviewWireFormat): string {
  return `${parsed.repo}/pr/${parsed.prNumber}`;
}
