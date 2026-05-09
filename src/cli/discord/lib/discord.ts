/**
 * Discord operations — webhook posting and bot API reading.
 *
 * POST uses webhooks (fast, no bot token needed per-channel).
 * READ uses bot token (needed for fetching messages).
 */

const DISCORD_API = "https://discord.com/api/v10";

export interface PostResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface DiscordMessage {
  id: string;
  author: string;
  content: string;
  timestamp: string;
  threadId?: string;
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  parentId?: string;
}

export interface DiscordThread {
  id: string;
  name: string;
  messageCount: number;
  archived: boolean;
}

/**
 * Post a message via bot API.
 */
export async function postMessage(
  botToken: string,
  channelId: string,
  content: string
): Promise<PostResult> {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: `${res.status}: ${text}` };
  }

  const data = await res.json() as any;
  return { success: true, messageId: data.id };
}

/**
 * Resolve a channel name to its ID via bot API.
 */
export async function resolveChannelByName(
  botToken: string,
  guildId: string,
  name: string
): Promise<string | null> {
  const channels = await listChannels(botToken, guildId);
  const match = channels.find((c) => c.name === name);
  return match?.id ?? null;
}

/**
 * Read messages from a channel via bot API.
 */
export async function readMessages(
  botToken: string,
  channelId: string,
  limit = 10
): Promise<DiscordMessage[]> {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages?limit=${limit}`, {
    headers: { Authorization: `Bot ${botToken}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to read channel: ${res.status} ${await res.text()}`);
  }

  const messages = await res.json() as any[];
  return messages.reverse().map((m) => ({
    id: m.id,
    author: m.author.global_name ?? m.author.username,
    content: m.content,
    timestamp: m.timestamp,
    threadId: m.thread?.id,
  }));
}

/**
 * List channels in a guild via bot API.
 */
export async function listChannels(
  botToken: string,
  guildId: string
): Promise<DiscordChannel[]> {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${botToken}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to list channels: ${res.status} ${await res.text()}`);
  }

  const channels = await res.json() as any[];
  // Text channels (type 0) and announcement channels (type 5)
  return channels
    .filter((c) => c.type === 0 || c.type === 5)
    .map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parent_id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a thread name to its ID via bot API (case-insensitive substring match).
 */
export async function resolveThreadByName(
  botToken: string,
  guildId: string,
  name: string
): Promise<{ id: string; name: string } | null> {
  const threads = await listThreads(botToken, guildId);
  const lower = name.toLowerCase();
  // Exact match first, then substring
  const exact = threads.find((t) => t.name.toLowerCase() === lower);
  if (exact) return { id: exact.id, name: exact.name };
  const partial = threads.find((t) => t.name.toLowerCase().includes(lower));
  if (partial) return { id: partial.id, name: partial.name };
  return null;
}

/**
 * List active threads in a guild via bot API.
 */
export async function listThreads(
  botToken: string,
  guildId: string
): Promise<DiscordThread[]> {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/threads/active`, {
    headers: { Authorization: `Bot ${botToken}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to list threads: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as any;
  return (data.threads ?? []).map((t: any) => ({
    id: t.id,
    name: t.name,
    messageCount: t.message_count ?? 0,
    archived: t.thread_metadata?.archived ?? false,
  }));
}
