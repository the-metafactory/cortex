/**
 * T-3.4: Response Poster
 * Posts responses to Discord, splitting long messages.
 */

import type { TextChannel, ThreadChannel } from "discord.js";
import { retryWithBackoff, type RetryOptions } from "./retry";

export const DISCORD_MAX_LENGTH = 2000;

/**
 * Decode HTML entities (both named and numeric) to Unicode characters.
 * Discord uses plain UTF-8 text, not HTML, so entities like &#233; need to be decoded.
 */
export function decodeHtmlEntities(text: string): string {
  return text
    // Decode numeric entities (&#233; → é, &#x00E9; → é)
    .replace(/&#(\d+);/g, (match: string, dec: string) => {
      const codePoint = parseInt(dec, 10);
      // Valid Unicode: 0 to 0x10FFFF (1114111)
      if (codePoint < 0 || codePoint > 0x10FFFF) {
        return match; // Leave invalid entities unchanged
      }
      return String.fromCodePoint(codePoint);
    })
    .replace(/&#x([0-9A-Fa-f]+);/g, (match: string, hex: string) => {
      const codePoint = parseInt(hex, 16);
      if (codePoint < 0 || codePoint > 0x10FFFF) {
        return match; // Leave invalid entities unchanged
      }
      return String.fromCodePoint(codePoint);
    })
    // Decode common named entities
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&"); // Must be last to avoid double-decoding
}

/**
 * Split a message into chunks that fit Discord's 2000 char limit.
 * Prefers splitting at newlines.
 */
export function splitMessage(content: string): string[] {
  if (content.length <= DISCORD_MAX_LENGTH) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point (newline within the limit)
    let splitAt = remaining.lastIndexOf("\n", DISCORD_MAX_LENGTH);
    if (splitAt <= 0 || splitAt < DISCORD_MAX_LENGTH * 0.5) {
      // No good newline — split at limit
      splitAt = DISCORD_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  return chunks;
}

/**
 * Post a response to a Discord channel, splitting if needed.
 * Optionally attaches files to the last chunk.
 *
 * Each `channel.send` is wrapped in retry-with-jittered-backoff to absorb
 * transient Discord 5xx and network blips during partial outages. discord.js
 * already queues 429s internally; 4xx app-level errors (DiscordAPIError) are
 * not retried so genuinely-broken targets still fail fast.
 */
export async function postToDiscord(
  channel: TextChannel | ThreadChannel,
  content: string,
  files?: { attachment: Buffer | string; name: string }[],
  retryOptions?: RetryOptions
): Promise<void> {
  const decoded = decodeHtmlEntities(content);
  const chunks = splitMessage(decoded);
  for (let i = 0; i < chunks.length; i++) {
    if (!chunks[i]?.trim()) continue;
    const isLast = i === chunks.length - 1;
    await retryWithBackoff(
      () =>
        channel.send({
          content: chunks[i],
          files: isLast && files ? files : undefined,
        }),
      {
        onRetry: (attempt, err, delayMs) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `discord-response-poster: send retry #${attempt} for channel ${channel.id} in ${delayMs.toFixed(0)}ms (${msg})`
          );
        },
        ...retryOptions,
      }
    );
  }
}
