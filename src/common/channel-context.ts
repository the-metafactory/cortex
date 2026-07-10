/**
 * G-204c: Channel & Thread Context Routing
 * Maps surface channel/thread names to GitHub repos and entities.
 * Channel naming IS the config — no bot.yaml changes needed.
 *
 * Platform-neutral: every surface that follows the channel-routing SOP
 * (Discord, Mattermost, Slack, PAI sessions) resolves through here.
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
 * Resolve a surface channel + thread name to a repo/entity context.
 *
 * @param channelName - Surface channel name (e.g. "grove")
 * @param threadName - Surface thread name (e.g. "grove/issue/43"), or null
 * @param repos - Configured repo list in "owner/repo" format
 */
export function resolveChannelContext(
  channelName: string,
  threadName: string | null,
  repos: string[],
): ChannelContext {
  const empty: ChannelContext = { repo: null, repoShort: null, entityType: null, entityRef: null };

  if (repos.length === 0) return empty;

  for (const fullRepo of repos) {
    const short = fullRepo.split("/").pop() ?? fullRepo;
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

    const issueMatch = /^issue\/(\d+)$/.exec(rest);
    if (issueMatch) {
      return { repo: fullRepo, repoShort: short, entityType: "issue", entityRef: issueMatch[1] ?? null };
    }

    const prMatch = /^pr\/(\d+)$/.exec(rest);
    if (prMatch) {
      return { repo: fullRepo, repoShort: short, entityType: "pr", entityRef: prMatch[1] ?? null };
    }

    // Feature ID patterns: g-204, f-007, i-400, dd-49
    const featureMatch = /^(g|f|i|dd)-(\d+)$/i.exec(rest);
    if (featureMatch) {
      return { repo: fullRepo, repoShort: short, entityType: "feature", entityRef: rest };
    }

    // Free-form thread under the repo channel — repo-scoped, no entity
    return { repo: fullRepo, repoShort: short, entityType: null, entityRef: null };
  }

  return empty;
}

/**
 * Resolve a CORTEX_CHANNEL value (from PAI sessions) to a repo context.
 * (The legacy GROVE_CHANNEL name is accepted by the EventLogger shim
 * until MIG-8; CORTEX_CHANNEL is canonical.)
 * Same logic as channel name resolution — if the channel name matches
 * a repo short name, it's scoped to that repo.
 */
export function resolveSurfaceChannel(
  channel: string,
  repos: string[],
): ChannelContext {
  return resolveChannelContext(channel, null, repos);
}
