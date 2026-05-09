/**
 * T-3.2: Context Fetcher
 * Fetches thread or channel history and formats for Claude.
 */

import type { TextChannel, ThreadChannel, Message, Collection, Snowflake } from "discord.js";
import type { ContextMessage, ContextAttachment } from "../../common/types/context";
import { formatContextForClaude } from "../../common/types/context";

/**
 * Fetch context messages from a thread or channel.
 */
export async function fetchContext(
  channel: TextChannel | ThreadChannel,
  depth: number,
  botUserId?: string
): Promise<{ messages: ContextMessage[]; formatted: string }> {
  const fetched = await channel.messages.fetch({ limit: depth });
  const messages = messagesToContext(fetched, botUserId);
  return {
    messages,
    formatted: formatContextForClaude(messages),
  };
}

function messagesToContext(
  fetched: Collection<Snowflake, Message>,
  botUserId?: string
): ContextMessage[] {
  return Array.from(fetched.values())
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((msg) => {
      const attachments: ContextAttachment[] = msg.attachments
        ? Array.from(msg.attachments.values()).map((a) => ({
            name: a.name ?? "unknown",
            url: a.url,
            contentType: a.contentType ?? "application/octet-stream",
            size: a.size ?? 0,
          }))
        : [];

      return {
        role: msg.author.id === botUserId ? "assistant" as const : "human" as const,
        author: msg.author.displayName ?? msg.author.username,
        content: msg.content,
        timestamp: msg.createdAt.toISOString(),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
    });
}
