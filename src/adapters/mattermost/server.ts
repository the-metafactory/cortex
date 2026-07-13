/**
 * T-5.1: Mattermost Webhook Server
 * Receives outgoing webhook POSTs from Mattermost, extracts messages.
 */

import type { Server } from "bun";

/**
 * cortex#1796 (S11, ADR-0024 D5 extraction lane) — the minimal config shape
 * `createMattermostServer` actually reads (`config.mattermost[0]`'s
 * `callbackPort`/`triggerWord`, `config.agent.name`), narrowed from cortex's
 * full `AgentConfig` (`common/types/config.ts`) the same way `AdapterAgentIdentity`
 * narrowed `Agent` in the web bundle (cortex#1794 S9b). NOTE: this function
 * is currently DEAD CODE in cortex's own production wiring (no call site
 * outside this module — verified via repo-wide grep) — the webhook-callback
 * transport was superseded by the poller (`poller.ts`). Kept + narrowed
 * rather than deleted so this extraction stays a pure relocation, not a
 * behavior change; a real cortex `AgentConfig` still satisfies this shape
 * structurally, so nothing outside this plugin needs to change if a future
 * caller ever wires it back up.
 */
export interface MattermostServerConfigShape {
  readonly mattermost: readonly {
    readonly callbackPort?: number;
    readonly triggerWord?: string;
  }[];
  readonly agent: { readonly name: string };
}

/**
 * Mattermost outgoing webhook payload.
 * See: https://developers.mattermost.com/integrate/webhooks/outgoing/
 */
export interface MattermostWebhookPayload {
  token: string;
  team_id: string;
  team_domain: string;
  channel_id: string;
  channel_name: string;
  timestamp: number;
  user_id: string;
  user_name: string;
  post_id: string;
  text: string;
  trigger_word: string;
  file_ids?: string;
}

export interface MattermostInboundMessage {
  channelId: string;
  channelName: string;
  postId: string;
  /** Thread root ID: post.root_id if in a thread, otherwise post.id */
  rootId: string;
  userId: string;
  userName: string;
  content: string;
  triggerWord: string;
  timestamp: number;
  /** Mattermost file IDs attached to this post */
  fileIds?: string[];
}

/**
 * Check if a message contains the trigger word (at start, as @mention, or standalone).
 */
export function matchesTrigger(text: string, triggerWord: string): boolean {
  const lower = text.toLowerCase();
  const trigger = triggerWord.toLowerCase();
  // Starts with trigger word
  if (lower.startsWith(trigger)) return true;
  // Contains @trigger
  if (lower.includes(`@${trigger}`)) return true;
  return false;
}

/**
 * Extract the user's message after the trigger word.
 */
export function extractAfterTrigger(text: string, triggerWord: string): string {
  const lower = text.toLowerCase();
  const trigger = triggerWord.toLowerCase();

  // "ivy do something" → "do something"
  if (lower.startsWith(trigger)) {
    return text.slice(triggerWord.length).trim();
  }

  // "hello @ivy do something" → "hello do something"
  const atPattern = new RegExp(`@${trigger}`, "gi");
  return text.replace(atPattern, "").replace(/\s+/g, " ").trim();
}

/**
 * Parse and validate a Mattermost outgoing webhook payload.
 */
export function parseWebhookPayload(
  body: Record<string, unknown>
): MattermostWebhookPayload | null {
  if (
    typeof body.token !== "string" ||
    typeof body.text !== "string" ||
    typeof body.user_name !== "string" ||
    typeof body.channel_id !== "string"
  ) {
    return null;
  }

  return body as unknown as MattermostWebhookPayload;
}

/**
 * Create a Mattermost webhook callback server.
 * Returns a Bun server and a cleanup function.
 */
export function createMattermostServer(
  config: MattermostServerConfigShape,
  onMessage: (msg: MattermostInboundMessage) => Promise<string>
): { server: Server<unknown>; stop: () => void } {
  const mm = config.mattermost[0]; // Instance-scoped config
  const port = mm?.callbackPort ?? 8080;
  const triggerWord = mm?.triggerWord ?? config.agent.name;

  const server = Bun.serve({
    port,
    async fetch(req) {
      // Health check
      if (req.method === "GET") {
        return new Response(JSON.stringify({ status: "ok", agent: config.agent.name }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      try {
        const body = await req.json() as Record<string, unknown>;
        const payload = parseWebhookPayload(body);

        if (!payload) {
          return new Response(JSON.stringify({ text: "Invalid webhook payload" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Extract message content after trigger word
        const content = extractAfterTrigger(payload.text, triggerWord);

        const msg: MattermostInboundMessage = {
          channelId: payload.channel_id,
          channelName: payload.channel_name,
          postId: payload.post_id,
          rootId: payload.post_id, // Webhook doesn't provide root_id; use post_id
          userId: payload.user_id,
          userName: payload.user_name,
          content,
          triggerWord,
          timestamp: payload.timestamp,
        };

        console.log(`mattermost-server: inbound from ${msg.userName} in #${msg.channelName}: ${content.slice(0, 100)}`);

        // Invoke handler and return response
        const response = await onMessage(msg);

        return new Response(JSON.stringify({ text: response }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("mattermost-server: webhook error:", error);
        return new Response(
          JSON.stringify({ text: "An error occurred processing your request." }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    },
  });

  console.log(`mattermost-server: webhook server listening on port ${port}`);

  return {
    server,
    stop: () => { void server.stop(); },
  };
}
