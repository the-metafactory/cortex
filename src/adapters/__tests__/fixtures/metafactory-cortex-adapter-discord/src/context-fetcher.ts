/**
 * T-3.2: Context Fetcher
 * Fetches thread or channel history and formats for Claude.
 */

// cortex#1797 (S12) — fixture-local stand-in for discord.js; see
// discordjs-stub.ts's module doc. Only this import line deviates from the
// real bundle's byte-identical source.
import type { TextChannel, ThreadChannel, Message, Collection, Snowflake } from "./discordjs-stub";
import type { ContextMessage, ContextAttachment } from "@the-metafactory/cortex/surface-sdk";

/**
 * cortex#1797 (S12) — inlined verbatim from cortex's `src/common/types/context.ts`
 * (plugin-owned duplicate; not worth a cross-repo dependency for one pure
 * function). Byte-identical to the shared implementation.
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
      const attachments: ContextAttachment[] = Array.from(msg.attachments.values()).map((a) => ({
        name: a.name,
        url: a.url,
        contentType: a.contentType ?? "application/octet-stream",
        size: a.size,
      }));

      return {
        role: msg.author.id === botUserId ? "assistant" as const : "human" as const,
        author: msg.author.displayName,
        content: msg.content,
        timestamp: msg.createdAt.toISOString(),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
    });
}
