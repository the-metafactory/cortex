/**
 * T-5.1b: Mattermost Poller
 * Polls specific Mattermost channels for new posts containing the trigger word.
 * Uses GET /channels/{id}/posts?since= — works in private channels, DMs, and public channels.
 * No inbound network connection required.
 */

import type { BotConfig } from "../../common/types/config";
import { extractAfterTrigger, matchesTrigger, type MattermostInboundMessage } from "./server";
import { basename } from "path";

interface MattermostPost {
  id: string;
  create_at: number;
  user_id: string;
  channel_id: string;
  root_id: string;
  message: string;
  type: string;
  file_ids?: string[];
}

interface MattermostChannel {
  id: string;
  name: string;
  display_name: string;
}

interface MattermostUser {
  id: string;
  username: string;
}

async function fetchBotUserId(apiUrl: string, apiToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${apiUrl}/api/v4/users/me`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!res.ok) return null;
    const user = await res.json() as MattermostUser;
    return user.id;
  } catch {
    return null;
  }
}

/**
 * Fetch DM channels for the bot user.
 * Returns channel IDs for direct message conversations.
 */
async function fetchDMChannels(
  botUserId: string,
  apiUrl: string,
  apiToken: string
): Promise<string[]> {
  try {
    const res = await fetch(
      `${apiUrl}/api/v4/users/${botUserId}/channels`,
      { headers: { Authorization: `Bearer ${apiToken}` } }
    );
    if (!res.ok) return [];
    const channels = await res.json() as Array<{ id: string; type: string }>;
    return channels.filter((ch) => ch.type === "D").map((ch) => ch.id);
  } catch {
    return [];
  }
}

async function fetchChannelName(
  channelId: string,
  apiUrl: string,
  apiToken: string,
  cache: Map<string, string>
): Promise<string> {
  if (cache.has(channelId)) return cache.get(channelId)!;
  try {
    const res = await fetch(`${apiUrl}/api/v4/channels/${channelId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!res.ok) return "unknown";
    const ch = await res.json() as MattermostChannel;
    const name = ch.display_name || ch.name;
    cache.set(channelId, name);
    return name;
  } catch {
    return "unknown";
  }
}

async function fetchUserName(
  userId: string,
  apiUrl: string,
  apiToken: string,
  cache: Map<string, string>
): Promise<string> {
  if (cache.has(userId)) return cache.get(userId)!;
  try {
    const res = await fetch(`${apiUrl}/api/v4/users/${userId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!res.ok) return "unknown";
    const user = await res.json() as MattermostUser;
    cache.set(userId, user.username);
    return user.username;
  } catch {
    return "unknown";
  }
}

/**
 * Post a reply to a Mattermost channel (or thread).
 */
export async function postReply(
  channelId: string,
  message: string,
  rootId: string | undefined,
  apiUrl: string,
  apiToken: string
): Promise<string | null> {
  try {
    const body: Record<string, string> = {
      channel_id: channelId,
      message,
    };
    if (rootId) body.root_id = rootId;

    const res = await fetch(`${apiUrl}/api/v4/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`grove-bot: mattermost post failed: ${res.status} ${await res.text()}`);
      return null;
    }
    const created = await res.json() as Record<string, unknown>;
    return (created.id as string) ?? null;
  } catch (error) {
    console.error("grove-bot: mattermost post error:", error);
    return null;
  }
}

/**
 * Fetch new posts from a channel since a given timestamp.
 */
async function fetchChannelPostsSince(
  channelId: string,
  since: number,
  apiUrl: string,
  apiToken: string
): Promise<MattermostPost[]> {
  try {
    const res = await fetch(
      `${apiUrl}/api/v4/channels/${channelId}/posts?since=${since}`,
      { headers: { Authorization: `Bearer ${apiToken}` } }
    );
    if (!res.ok) return [];

    const data = await res.json() as { posts?: Record<string, MattermostPost> };
    const posts: MattermostPost[] = Object.values(data.posts || {});
    return posts.sort((a, b) => a.create_at - b.create_at);
  } catch {
    return [];
  }
}

/**
 * Fetch file metadata from Mattermost for attachment processing.
 * Returns AttachmentInfo-compatible objects.
 */
export async function fetchMattermostFileInfos(
  fileIds: string[],
  apiUrl: string,
  apiToken: string
): Promise<Array<{ originalName: string; url: string; contentType: string; size: number; source: "mattermost" }>> {
  const results: Array<{ originalName: string; url: string; contentType: string; size: number; source: "mattermost" }> = [];

  for (const fileId of fileIds) {
    try {
      const res = await fetch(`${apiUrl}/api/v4/files/${fileId}/info`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (!res.ok) continue;

      const info = await res.json() as { name?: string; mime_type?: string; size?: number };
      results.push({
        originalName: info.name ?? "unknown",
        url: `${apiUrl}/api/v4/files/${fileId}`,
        contentType: info.mime_type ?? "application/octet-stream",
        size: info.size ?? 0,
        source: "mattermost",
      });
    } catch (err) {
      console.warn("grove-bot: mattermost-poller: failed to fetch file info:", fileId, err instanceof Error ? err.message : err);
    }
  }

  return results;
}

/**
 * Upload a file to Mattermost and return the file ID.
 */
export async function uploadMattermostFile(
  filePath: string,
  channelId: string,
  apiUrl: string,
  apiToken: string
): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    const formData = new FormData();
    formData.append("files", file, basename(filePath));
    formData.append("channel_id", channelId);

    const res = await fetch(`${apiUrl}/api/v4/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: formData,
    });

    if (!res.ok) return null;
    const data = await res.json() as { file_infos?: Array<{ id: string }> };
    return data.file_infos?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Post a reply with file attachments to Mattermost.
 */
export async function postReplyWithFiles(
  channelId: string,
  message: string,
  rootId: string | undefined,
  filePaths: string[],
  apiUrl: string,
  apiToken: string
): Promise<string | null> {
  // Upload files first
  const fileIds: string[] = [];
  for (const fp of filePaths) {
    const fileId = await uploadMattermostFile(fp, channelId, apiUrl, apiToken);
    if (fileId) fileIds.push(fileId);
  }

  try {
    const body: Record<string, unknown> = {
      channel_id: channelId,
      message,
      file_ids: fileIds.length > 0 ? fileIds : undefined,
    };
    if (rootId) body.root_id = rootId;

    const res = await fetch(`${apiUrl}/api/v4/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`grove-bot: mattermost post with files failed: ${res.status}`);
      return null;
    }
    const created = await res.json() as Record<string, unknown>;
    return (created.id as string) ?? null;
  } catch (error) {
    console.error("grove-bot: mattermost post with files error:", error);
    return null;
  }
}

export interface MattermostPollerOptions {
  config: BotConfig;
  onMessage: (msg: MattermostInboundMessage) => Promise<string>;
  pollIntervalMs?: number;
}

/**
 * Create a Mattermost poller that watches configured channels for trigger-word posts.
 * Uses per-channel GET with `since` parameter — works in private channels and DMs.
 */
export function createMattermostPoller(options: MattermostPollerOptions): { stop: () => void } {
  const { config, onMessage } = options;
  const mm = config.mattermost[0]; // Instance-scoped config (adapters pass scoped config)
  const pollIntervalMs = options.pollIntervalMs ?? mm?.pollIntervalMs ?? 3000;
  const apiUrl = mm?.apiUrl ?? "";
  const apiToken = mm?.apiToken ?? "";
  const triggerWord = mm?.triggerWord ?? config.agent.name;
  const configuredChannels = mm?.channels ?? [];
  const allowedUsers = mm?.allowedUsers ?? [];

  let lastCheckTime = Date.now();
  let botUserId: string | null = null;
  let dmChannelIds: string[] = [];
  let dmRefreshCount = 0;
  let running = true;
  const processedPosts = new Set<string>();
  const processingPosts = new Set<string>();
  // Track posts we create (our replies) so we don't respond to ourselves
  const ourPostIds = new Set<string>();
  const channelCache = new Map<string, string>();
  const userCache = new Map<string, string>();

  const poll = async () => {
    if (!running) return;

    try {
      // Get bot user ID and DM channels on first poll (and refresh DMs every ~60s)
      if (!botUserId) {
        botUserId = await fetchBotUserId(apiUrl, apiToken);
        if (!botUserId) {
          console.error("grove-bot: mattermost couldn't fetch bot user ID — check apiToken");
          return;
        }
        console.log(`grove-bot: mattermost bot user ID: ${botUserId}`);
      }

      // Refresh DM channels periodically (every ~20 polls)
      if (dmRefreshCount % 20 === 0) {
        dmChannelIds = await fetchDMChannels(botUserId, apiUrl, apiToken);
        if (dmRefreshCount === 0 && dmChannelIds.length > 0) {
          console.log(`grove-bot: mattermost found ${dmChannelIds.length} DM channel(s)`);
        }
      }
      dmRefreshCount++;

      // Combine configured channels + DM channels
      const allChannels = [...configuredChannels, ...dmChannelIds];
      if (allChannels.length === 0) return;

      // Poll each channel
      for (const channelId of allChannels) {
        const isDM = dmChannelIds.includes(channelId);
        const posts = await fetchChannelPostsSince(channelId, lastCheckTime, apiUrl, apiToken);

        for (const post of posts) {
          // Skip already processed, our own replies
          if (processedPosts.has(post.id) || processingPosts.has(post.id)) continue;
          if (ourPostIds.has(post.id)) continue;
          // Skip bot's own messages
          if (post.user_id === botUserId) continue;
          // DMs don't need trigger word — the user is talking directly to the bot
          if (!isDM && !matchesTrigger(post.message, triggerWord)) continue;
          if (allowedUsers.length > 0 && !allowedUsers.includes(post.user_id)) {
            processedPosts.add(post.id);
            const replyId = await postReply(
              post.channel_id,
              "Sorry, I'm only configured to respond to my operator. Please reach out to them if you need my help.",
              post.root_id || post.id,
              apiUrl,
              apiToken
            );
            if (replyId) ourPostIds.add(replyId);
            continue;
          }

          processingPosts.add(post.id);
          processedPosts.add(post.id);

          const channelName = await fetchChannelName(post.channel_id, apiUrl, apiToken, channelCache);
          const userName = await fetchUserName(post.user_id, apiUrl, apiToken, userCache);
          const content = isDM ? post.message.trim() : extractAfterTrigger(post.message, triggerWord);

          console.log(`grove-bot: mattermost inbound from ${userName} ${isDM ? "[DM]" : `in #${channelName}`}: ${content.slice(0, 100)}`);

          const msg: MattermostInboundMessage = {
            channelId: post.channel_id,
            channelName,
            postId: post.id,
            rootId: post.root_id || post.id,
            userId: post.user_id,
            userName,
            content,
            triggerWord,
            timestamp: post.create_at,
            fileIds: post.file_ids && post.file_ids.length > 0 ? post.file_ids : undefined,
          };

          try {
            const response = await onMessage(msg);
            if (response) {
              const replyId = await postReply(post.channel_id, response, msg.rootId, apiUrl, apiToken);
              if (replyId) ourPostIds.add(replyId);
              console.log(`grove-bot: mattermost replied in #${channelName}`);
            }
          } catch (error) {
            console.error(`grove-bot: mattermost handler error:`, error);
            const errReplyId = await postReply(
              post.channel_id,
              "Sorry, I encountered an error processing your request.",
              msg.rootId,
              apiUrl,
              apiToken
            );
            if (errReplyId) ourPostIds.add(errReplyId);
          } finally {
            processingPosts.delete(post.id);
          }
        }
      }

      lastCheckTime = Date.now();
    } catch (error) {
      console.error("grove-bot: mattermost poll error:", error);
    }
  };

  // Trim processedPosts set periodically
  const trimInterval = setInterval(() => {
    if (processedPosts.size > 1000) {
      const arr = Array.from(processedPosts);
      arr.splice(0, arr.length - 500).forEach((id) => processedPosts.delete(id));
    }
  }, 60_000);

  const interval = setInterval(poll, pollIntervalMs);
  poll(); // First poll immediately

  console.log(`grove-bot: mattermost polling ${configuredChannels.length} channel(s) + DMs every ${pollIntervalMs / 1000}s for "${triggerWord}"`);

  return {
    stop: () => {
      running = false;
      clearInterval(interval);
      clearInterval(trimInterval);
    },
  };
}
