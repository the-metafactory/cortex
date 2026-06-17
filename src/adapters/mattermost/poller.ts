/**
 * T-5.1b: Mattermost Poller
 * Polls specific Mattermost channels for new posts containing the trigger word.
 * Uses GET /channels/{id}/posts?since= — works in private channels, DMs, and public channels.
 * No inbound network connection required.
 */

import type { MattermostPresence } from "../../common/types/cortex-config";
import { extractAfterTrigger, matchesTrigger, type MattermostInboundMessage } from "./server";
import { fetchBotUserId as fetchBotUserIdShared } from "./bot-user";
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

/**
 * MIG-7.2c-mattermost: graceful-degradation wrapper around the shared
 * `fetchBotUserId` helper. The poller's contract is that startup keeps
 * polling even if `/users/me` is briefly unreachable — null tells the
 * poll loop to retry next tick rather than die outright. The shared
 * helper's 10s default `AbortSignal.timeout` applies, which matches the
 * poll cadence well enough; if the poller ever needs a different timeout
 * profile, pass `{ timeoutMs }` through here.
 */
async function fetchBotUserId(apiUrl: string, apiToken: string): Promise<string | null> {
  try {
    return await fetchBotUserIdShared(apiUrl, apiToken);
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
    const channels = await res.json() as { id: string; type: string }[];
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
  const cached = cache.get(channelId);
  if (cached !== undefined) return cached;
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
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;
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

// Mattermost save-layer ceiling: the v4 API validates MaxPostSize (16383) but
// the DB SAVE 500s ("app.post.save.app_error") well below that — ~4000 chars
// (binary-searched against securechat-test). A long single post (a composed
// flow's YAML, a big advisory, multi-line step output) is therefore DROPPED
// with a 500 unless we chunk under the ceiling. Chunk into a root post + thread
// replies so the content survives. Mirrors A_FETCH/A_NOTIFY's measured limits.
const MM_MAX_CHARS = 3800;
const MM_MAX_BYTES = 15000;
const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

/** Strip control chars Postgres/Mattermost reject at save time (keep \n, \t). */
export function sanitizeForMattermost(message: string): string {
  // eslint-disable-next-line no-control-regex
  return message.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Split a message into chunks under both char and byte ceilings, preferring line boundaries. */
export function splitForMattermost(message: string): string[] {
  const fits = (s: string): boolean => s.length <= MM_MAX_CHARS && utf8Len(s) <= MM_MAX_BYTES;
  if (fits(message)) return [message];
  const chunks: string[] = [];
  let current = "";
  for (const line of message.split("\n")) {
    // Hard-slice a single oversized line (the byte check keeps multibyte slices safe).
    const pieces: string[] = [];
    let rest = line;
    while (!fits(rest)) {
      let cut = Math.min(rest.length, MM_MAX_CHARS);
      while (cut > 1 && !fits(rest.slice(0, cut))) cut = Math.floor(cut / 2);
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    pieces.push(rest);
    for (const piece of pieces) {
      const candidate = current ? `${current}\n${piece}` : piece;
      if (current && !fits(candidate)) {
        chunks.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [message];
}

/** POST one chunk; returns the created post id (or null on failure). */
async function postOne(
  channelId: string,
  message: string,
  rootId: string | undefined,
  apiUrl: string,
  apiToken: string,
): Promise<string | null> {
  const body: Record<string, string> = { channel_id: channelId, message };
  if (rootId) body.root_id = rootId;
  const res = await fetch(`${apiUrl}/api/v4/posts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`mattermost-poller: post failed: ${res.status} ${await res.text()}`);
    return null;
  }
  const created = (await res.json()) as Record<string, unknown>;
  return typeof created.id === "string" ? created.id : null;
}

/**
 * Post a reply to a Mattermost channel (or thread). A message over the MM
 * save-layer ceiling is split into a root post + thread replies (so a long
 * flow YAML / advisory is never dropped with a 500); returns the ROOT post id.
 */
export async function postReply(
  channelId: string,
  message: string,
  rootId: string | undefined,
  apiUrl: string,
  apiToken: string
): Promise<string | null> {
  try {
    const chunks = splitForMattermost(sanitizeForMattermost(message));
    // The chunks after the first reply into the thread; if the caller gave a
    // rootId, everything stays in that thread, otherwise the first post becomes
    // the thread root.
    let thread = rootId;
    let firstId: string | null = null;
    for (const [i, chunk] of chunks.entries()) {
      const id = await postOne(channelId, chunk, thread, apiUrl, apiToken);
      if (i === 0) {
        firstId = id;
        if (thread === undefined && id) thread = id; // root the thread at chunk 1
      }
    }
    return firstId;
  } catch (error) {
    console.error("mattermost-poller: post error:", error);
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
    const posts: MattermostPost[] = Object.values(data.posts ?? {});
    return posts.sort((a, b) => a.create_at - b.create_at);
  } catch {
    return [];
  }
}

/**
 * Fetch file metadata from Mattermost for attachment processing.
 * Returns AttachmentInfo-compatible objects.
 */
interface MattermostFileInfo {
  originalName: string;
  url: string;
  contentType: string;
  size: number;
  source: "mattermost";
  /** Base64 file bytes, INLINED for text-like files under the cap. Mattermost
   *  file URLs need the bot's Bearer token to download — the brain (and pulse's
   *  A_INGEST_ATTACHMENT) can't auth, so the adapter (which HAS the token)
   *  fetches the bytes here and ships them inline. Discord uses public CDN URLs
   *  and never needs this. */
  content?: string;
}

/** Text-like by MIME or extension — only these are worth inlining for IOC work. */
function isInlineableText(name: string, mime: string): boolean {
  const m = mime.toLowerCase();
  if (m.startsWith("text/") || m === "message/rfc822" || m === "application/json") return true;
  return /\.(eml|txt|csv|log|json|md|ics)$/i.test(name);
}

/** Cap on inlined file bytes — keeps the brain task envelope well under NATS limits. */
const MAX_INLINE_BYTES = 512 * 1024;

export async function fetchMattermostFileInfos(
  fileIds: string[],
  apiUrl: string,
  apiToken: string
): Promise<MattermostFileInfo[]> {
  const results: MattermostFileInfo[] = [];

  for (const fileId of fileIds) {
    try {
      const res = await fetch(`${apiUrl}/api/v4/files/${fileId}/info`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (!res.ok) continue;

      const info = await res.json() as { name?: string; mime_type?: string; size?: number };
      const name = info.name ?? "unknown";
      const contentType = info.mime_type ?? "application/octet-stream";
      const size = info.size ?? 0;

      // Inline text-like bytes (authenticated fetch) so the brain doesn't have
      // to — a failed inline is non-fatal (the URL still travels as a fallback).
      let content: string | undefined;
      if (isInlineableText(name, contentType) && size > 0 && size <= MAX_INLINE_BYTES) {
        try {
          const fres = await fetch(`${apiUrl}/api/v4/files/${fileId}`, {
            headers: { Authorization: `Bearer ${apiToken}` },
          });
          if (fres.ok) {
            content = Buffer.from(new Uint8Array(await fres.arrayBuffer())).toString("base64");
          } else {
            console.warn(`mattermost-poller: file fetch ${fileId} → HTTP ${fres.status} (will ship URL only)`);
          }
        } catch (err) {
          console.warn("mattermost-poller: file byte fetch failed:", fileId, err instanceof Error ? err.message : err);
        }
      }

      results.push({
        originalName: name,
        url: `${apiUrl}/api/v4/files/${fileId}`,
        contentType,
        size,
        source: "mattermost",
        ...(content !== undefined && { content }),
      });
    } catch (err) {
      console.warn("mattermost-poller: failed to fetch file info:", fileId, err instanceof Error ? err.message : err);
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
    const data = await res.json() as { file_infos?: { id: string }[] };
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
      console.error(`mattermost-poller: post with files failed: ${res.status}`);
      return null;
    }
    const created = await res.json() as Record<string, unknown>;
    return typeof created.id === "string" ? created.id : null;
  } catch (error) {
    console.error("mattermost-poller: post with files error:", error);
    return null;
  }
}

export interface MattermostPollerOptions {
  /** Parent agent's logical id. Used as the default trigger-word when
   *  `presence.triggerWord` is unset — matches the legacy `agent.name`
   *  fallback. */
  agentName: string;
  /** This adapter's MattermostPresence (apiUrl, apiToken, channels,
   *  pollIntervalMs, allowedUsers, triggerWord, …). */
  presence: MattermostPresence;
  onMessage: (msg: MattermostInboundMessage) => Promise<string>;
  pollIntervalMs?: number;
}

/**
 * Create a Mattermost poller that watches configured channels for trigger-word posts.
 * Uses per-channel GET with `since` parameter — works in private channels and DMs.
 */
export function createMattermostPoller(options: MattermostPollerOptions): { stop: () => void } {
  const { agentName, presence, onMessage } = options;
  // pollIntervalMs/channels/allowedUsers have schema defaults; apiUrl /
  // apiToken / triggerWord are genuinely optional.
  const pollIntervalMs = options.pollIntervalMs ?? presence.pollIntervalMs;
  const apiUrl = presence.apiUrl ?? "";
  const apiToken = presence.apiToken ?? "";
  const triggerWord = presence.triggerWord ?? agentName;
  const configuredChannels = presence.channels;
  const allowedUsers = presence.allowedUsers;

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
          console.error("mattermost-poller: couldn't fetch bot user ID — check apiToken");
          return;
        }
        console.log(`mattermost-poller: bot user ID: ${botUserId}`);
      }

      // Refresh DM channels periodically (every ~20 polls)
      if (dmRefreshCount % 20 === 0) {
        dmChannelIds = await fetchDMChannels(botUserId, apiUrl, apiToken);
        if (dmRefreshCount === 0 && dmChannelIds.length > 0) {
          console.log(`mattermost-poller: found ${dmChannelIds.length} DM channel(s)`);
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
              "Sorry, I'm only configured to respond to my principal. Please reach out to them if you need my help.",
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

          console.log(`mattermost-poller: inbound from ${userName} ${isDM ? "[DM]" : `in #${channelName}`}: ${content.slice(0, 100)}`);

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
              console.log(`mattermost-poller: replied in #${channelName}`);
            }
          } catch (error) {
            console.error(`mattermost-poller: handler error:`, error);
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
      console.error("mattermost-poller: poll error:", error);
    }
  };

  // Trim processedPosts set periodically
  const trimInterval = setInterval(() => {
    if (processedPosts.size > 1000) {
      const arr = Array.from(processedPosts);
      arr.splice(0, arr.length - 500).forEach((id) => processedPosts.delete(id));
    }
  }, 60_000);

  const interval = setInterval(() => { void poll(); }, pollIntervalMs);
  void poll(); // First poll immediately

  console.log(`mattermost-poller: polling ${configuredChannels.length} channel(s) + DMs every ${pollIntervalMs / 1000}s for "${triggerWord}"`);

  return {
    stop: () => {
      running = false;
      clearInterval(interval);
      clearInterval(trimInterval);
    },
  };
}
