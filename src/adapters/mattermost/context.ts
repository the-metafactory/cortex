/**
 * T-5.2: Mattermost Context Fetcher
 * Fetches thread context from Mattermost REST API for multi-turn conversations.
 */

import type { BotConfig } from "../../common/types/config";
import type { ContextMessage } from "../../common/types/context";
import { formatContextForClaude } from "../../common/types/context";

export interface MattermostPost {
  id: string;
  create_at: number;
  update_at: number;
  user_id: string;
  channel_id: string;
  root_id: string;
  message: string;
  type: string;
  props?: Record<string, unknown>;
  metadata?: {
    username?: string;
  };
}

interface MattermostPostsResponse {
  order: string[];
  posts: Record<string, MattermostPost>;
}

interface MattermostUser {
  id: string;
  username: string;
  nickname?: string;
  first_name?: string;
  last_name?: string;
}

/**
 * Fetch a user's display name from the Mattermost API.
 * Falls back to "unknown" on error.
 */
async function fetchUserName(
  userId: string,
  apiUrl: string,
  apiToken: string,
  userCache: Map<string, string>
): Promise<string> {
  if (userCache.has(userId)) return userCache.get(userId)!;

  try {
    const res = await fetch(`${apiUrl}/api/v4/users/${userId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!res.ok) return "unknown";

    const user = await res.json() as MattermostUser;
    const name = user.nickname || user.username || `${user.first_name} ${user.last_name}`.trim() || "unknown";
    userCache.set(userId, name);
    return name;
  } catch {
    return "unknown";
  }
}

/**
 * Fetch thread context for a Mattermost post.
 * If the post is in a thread, fetches the full thread. Otherwise fetches recent channel posts.
 */
export async function fetchMattermostContext(
  postId: string,
  channelId: string,
  config: BotConfig,
  botUserId?: string
): Promise<{ messages: ContextMessage[]; formatted: string }> {
  const mm = config.mattermost[0]; // Instance-scoped config
  const apiUrl = mm?.apiUrl;
  const apiToken = mm?.apiToken;

  if (!apiUrl || !apiToken) {
    return { messages: [], formatted: "" };
  }

  const userCache = new Map<string, string>();
  const agentName = config.agent.name;

  try {
    // Try to get the post first to check if it's in a thread
    const postRes = await fetch(`${apiUrl}/api/v4/posts/${postId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!postRes.ok) {
      console.error(`mattermost-context: API error fetching post: ${postRes.status}`);
      return { messages: [], formatted: "" };
    }

    const post = await postRes.json() as MattermostPost;
    const rootId = post.root_id || post.id;

    // Fetch thread posts
    let postsResponse: MattermostPostsResponse;

    if (post.root_id) {
      // It's a reply — fetch the thread
      const threadRes = await fetch(`${apiUrl}/api/v4/posts/${rootId}/thread`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });

      if (!threadRes.ok) {
        return { messages: [], formatted: "" };
      }

      postsResponse = await threadRes.json() as MattermostPostsResponse;
    } else {
      // It's a top-level post — fetch recent channel posts for context
      const channelRes = await fetch(
        `${apiUrl}/api/v4/channels/${channelId}/posts?per_page=10`,
        { headers: { Authorization: `Bearer ${apiToken}` } }
      );

      if (!channelRes.ok) {
        return { messages: [], formatted: "" };
      }

      postsResponse = await channelRes.json() as MattermostPostsResponse;
    }

    // Convert to ContextMessage format, ordered chronologically
    const messages: ContextMessage[] = [];

    for (const id of postsResponse.order.slice().reverse()) {
      const p = postsResponse.posts[id];
      if (!p || !p.message) continue;
      // Skip the triggering post itself — it'll be the prompt
      if (p.id === postId) continue;

      const userName = await fetchUserName(p.user_id, apiUrl, apiToken, userCache);
      const isAssistant = botUserId ? p.user_id === botUserId : userName === agentName;

      messages.push({
        role: isAssistant ? "assistant" : "human",
        author: userName,
        content: p.message,
        timestamp: new Date(p.create_at).toISOString(),
      });
    }

    return {
      messages,
      formatted: formatContextForClaude(messages),
    };
  } catch (error) {
    console.error("mattermost-context: fetch error:", error);
    return { messages: [], formatted: "" };
  }
}
