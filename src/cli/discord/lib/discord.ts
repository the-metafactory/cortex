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

// =============================================================================
// Discord API response shapes — narrowest projections this module reads.
// Discord's full schema is huge; only field cortex actually accesses lives
// here. Any future field need extends the interface, not loosens the type.
// =============================================================================

interface DiscordApiUser {
  global_name?: string | null;
  username: string;
}

interface DiscordApiMessage {
  id: string;
  author: DiscordApiUser;
  content: string;
  timestamp: string;
  thread?: { id: string };
}

interface DiscordApiMessageCreated {
  id: string;
}

interface DiscordApiChannel {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
}

interface DiscordApiThread {
  id: string;
  name: string;
  message_count?: number;
  thread_metadata?: { archived?: boolean };
}

interface DiscordApiActiveThreadsResponse {
  threads?: DiscordApiThread[];
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

  const data = (await res.json()) as DiscordApiMessageCreated;
  return { success: true, messageId: data.id };
}

/** One attachment, already read into memory. The CLI owns the file read +
 *  existence check; this module owns the wire format, so the builder stays a
 *  pure function (testable without fs or a token). */
export interface AttachmentInput {
  filename: string;
  /** ArrayBuffer-backed (not Shared) so it appends to a Blob without a copy. */
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * Build the `multipart/form-data` body for an attachment post (Discord v10:
 * https://discord.com/developers/docs/reference#uploading-files).
 *
 * Pure — no I/O. The form carries a `payload_json` part (message fields plus an
 * `attachments` array that references each file by index) and one `files[n]`
 * part per attachment. Do NOT set a Content-Type header when sending this:
 * fetch derives the multipart boundary from the FormData itself.
 */
export function buildAttachmentForm(content: string, files: AttachmentInput[]): FormData {
  const form = new FormData();
  const payload = {
    content,
    // Discord references uploaded files by the same index used in files[n].
    attachments: files.map((f, i) => ({ id: i, filename: f.filename })),
  };
  form.append("payload_json", JSON.stringify(payload));
  files.forEach((f, i) => {
    // Blob accepts the Uint8Array view directly — no copy (sage cortex#1031).
    form.append(`files[${i}]`, new Blob([f.bytes]), f.filename);
  });
  return form;
}

/**
 * Post a message with one or more file attachments via bot API.
 * `content` may be empty when at least one file is present (Discord allows a
 * file-only message). Same `PostResult` contract as `postMessage`.
 */
export async function postMessageWithFiles(
  botToken: string,
  channelId: string,
  content: string,
  files: AttachmentInput[]
): Promise<PostResult> {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    // No Content-Type — fetch sets multipart/form-data + boundary from the body.
    headers: { Authorization: `Bot ${botToken}` },
    body: buildAttachmentForm(content, files),
  });

  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: `${res.status}: ${text}` };
  }

  const data = (await res.json()) as DiscordApiMessageCreated;
  return { success: true, messageId: data.id };
}

export interface CreateThreadResult {
  success: boolean;
  threadId?: string;
  error?: string;
}

/**
 * Create a public thread from an existing message.
 * Discord: POST /channels/{channelId}/messages/{messageId}/threads
 */
export async function createThreadFromMessage(
  botToken: string,
  channelId: string,
  messageId: string,
  name: string,
  autoArchiveMinutes: 60 | 1440 | 4320 | 10080 = 10080
): Promise<CreateThreadResult> {
  // Discord caps thread names at 100 characters
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}/threads`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: name.slice(0, 100), auto_archive_duration: autoArchiveMinutes }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: `${res.status}: ${text}` };
  }

  const data = (await res.json()) as { id: string };
  return { success: true, threadId: data.id };
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

  const messages = (await res.json()) as DiscordApiMessage[];
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

  const channels = (await res.json()) as DiscordApiChannel[];
  // Text channels (type 0) and announcement channels (type 5)
  return channels
    .filter((c) => c.type === 0 || c.type === 5)
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      parentId: c.parent_id ?? undefined,
    }))
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

  const data = (await res.json()) as DiscordApiActiveThreadsResponse;
  return (data.threads ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    messageCount: t.message_count ?? 0,
    archived: t.thread_metadata?.archived ?? false,
  }));
}
