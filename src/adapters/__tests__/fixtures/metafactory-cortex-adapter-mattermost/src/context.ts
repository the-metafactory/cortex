/**
 * T-5.2: Mattermost Context Fetcher
 * Fetches thread context from Mattermost REST API for multi-turn conversations.
 */

import type { MattermostPresence } from "./schema";
import type { ContextMessage } from "@the-metafactory/cortex/surface-sdk";

/**
 * cortex#1796 (S11, ADR-0024 D5 extraction lane) — inlined verbatim from
 * cortex core's `src/common/types/context.ts` (a small, self-contained pure
 * function — same duplication tradeoff as this directory's
 * `envelope-renderer.ts`). The original stays in `common/types/context.ts`
 * for its other two in-tree consumers (`prompt-builder.ts`,
 * `discord/context-fetcher.ts`), which this plugin never touches.
 */
function formatContextForClaude(messages: ContextMessage[]): string {
  if (messages.length === 0) return "";

  return messages
    .map((m) => {
      const tag = m.role === "human" ? "user_message" : "assistant_message";
      let body = m.content;
      if (m.attachments && m.attachments.length > 0) {
        const attachList = m.attachments.map((a) => `[attachment: ${a.name} (${a.contentType})]`).join(", ");
        body += `\n${attachList}`;
      }
      return `<${tag} author="${m.author}" timestamp="${m.timestamp}">\n${body}\n</${tag}>`;
    })
    .join("\n\n");
}

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
  const cached = userCache.get(userId);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(`${apiUrl}/api/v4/users/${userId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!res.ok) return "unknown";

    const user = await res.json() as MattermostUser;
    // `||` preserves empty-string fallthrough to next field; `??` would
    // not. Mattermost returns "" for omitted optional fields.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
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
  opts: { agentName: string; presence: MattermostPresence },
  botUserId?: string
): Promise<{ messages: ContextMessage[]; formatted: string }> {
  const apiUrl = opts.presence.apiUrl;
  const apiToken = opts.presence.apiToken;

  if (!apiUrl || !apiToken) {
    return { messages: [], formatted: "" };
  }

  const userCache = new Map<string, string>();
  const agentName = opts.agentName;

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
      if (!p?.message) continue;
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
