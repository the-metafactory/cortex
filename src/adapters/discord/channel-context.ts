/**
 * G-204c: Channel & Thread Context Routing
 * Maps Discord channel/thread names to GitHub repos and entities.
 * Channel naming IS the config — no bot.yaml changes needed.
 *
 * Convention:
 *   #grove (channel)                → repo: the-metafactory/grove
 *     └── grove/issue/43 (thread)   → issue #43
 *     └── grove/pr/45 (thread)      → PR #45
 *     └── grove/g-204 (thread)      → feature G-204
 */

export interface ChannelContext {
  /** Full repo name, e.g. "the-metafactory/grove" */
  repo: string | null;
  /** Short repo name, e.g. "grove" */
  repoShort: string | null;
  /** Entity type resolved from thread name */
  entityType: "issue" | "pr" | "feature" | null;
  /** Entity reference, e.g. "43", "45", "g-204" */
  entityRef: string | null;
}

/**
 * Resolve a Discord channel + thread name to a repo/entity context.
 *
 * @param channelName - Discord channel name (e.g. "grove")
 * @param threadName - Discord thread name (e.g. "grove/issue/43"), or null
 * @param repos - Configured repo list in "owner/repo" format
 */
export function resolveChannelContext(
  channelName: string,
  threadName: string | null,
  repos: string[],
): ChannelContext {
  const empty: ChannelContext = { repo: null, repoShort: null, entityType: null, entityRef: null };

  if (!repos || repos.length === 0) return empty;

  for (const fullRepo of repos) {
    const short = fullRepo.split("/").pop()!;
    if (channelName !== short) continue;

    if (!threadName) {
      return { repo: fullRepo, repoShort: short, entityType: null, entityRef: null };
    }

    // Parse thread name: grove/issue/43, grove/pr/45, grove/g-204
    const prefix = `${short}/`;
    if (!threadName.startsWith(prefix)) {
      return { repo: fullRepo, repoShort: short, entityType: null, entityRef: null };
    }

    const rest = threadName.slice(prefix.length);

    const issueMatch = rest.match(/^issue\/(\d+)$/);
    if (issueMatch) {
      return { repo: fullRepo, repoShort: short, entityType: "issue", entityRef: issueMatch[1] ?? null };
    }

    const prMatch = rest.match(/^pr\/(\d+)$/);
    if (prMatch) {
      return { repo: fullRepo, repoShort: short, entityType: "pr", entityRef: prMatch[1] ?? null };
    }

    // Feature ID patterns: g-204, f-007, i-400, dd-49
    const featureMatch = rest.match(/^(g|f|i|dd)-(\d+)$/i);
    if (featureMatch) {
      return { repo: fullRepo, repoShort: short, entityType: "feature", entityRef: rest };
    }

    // Free-form thread under the repo channel — repo-scoped, no entity
    return { repo: fullRepo, repoShort: short, entityType: null, entityRef: null };
  }

  return empty;
}

/**
 * Resolve a GROVE_CHANNEL value (from PAI sessions) to a repo context.
 * Same logic as channel name resolution — if the channel name matches
 * a repo short name, it's scoped to that repo.
 */
export function resolveGroveChannel(
  groveChannel: string,
  repos: string[],
): ChannelContext {
  return resolveChannelContext(groveChannel, null, repos);
}
