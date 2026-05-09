/** Default agent branch patterns */
export const DEFAULT_BRANCH_PATTERNS = [/^feat\/(g|f|i)-\d+/];

/** Default commit trailer for agent detection */
export const DEFAULT_COMMIT_TRAILER = "Co-Authored-By: Claude";

/** Default comment patterns for agent detection */
export const DEFAULT_COMMENT_PATTERNS = [/^Starting:/, /^Completed:/];

/** Check if a branch name matches agent patterns */
export function hasBranchMatch(
  branch: string | undefined,
  patterns: RegExp[] = DEFAULT_BRANCH_PATTERNS,
): boolean {
  if (!branch) return false;
  return patterns.some((re) => re.test(branch));
}

/** Check if text contains agent trailer string */
export function hasTrailerMatch(
  text: string,
  trailers: string[] = [DEFAULT_COMMIT_TRAILER],
): boolean {
  return trailers.some((trailer) => text.includes(trailer));
}

/** Check if comment body matches agent patterns */
export function hasCommentMatch(
  body: string,
  patterns: RegExp[] = DEFAULT_COMMENT_PATTERNS,
): boolean {
  return patterns.some((re) => re.test(body));
}
