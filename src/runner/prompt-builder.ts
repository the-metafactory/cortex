/**
 * F-007: Prompt builder
 *
 * Constructs prompts for Claude Code invocations, combining message content,
 * conversation context, attachment info, and security preamble.
 * Extracted from the grove-v2 bot entrypoint to be shared across all platform adapters.
 */

import type { InboundMessage } from "../adapters/types";
import type { ContextMessage } from "../common/types/context";
import { formatContextForClaude } from "../common/types/context";

export interface PromptBuildOpts {
  /** The inbound message */
  msg: InboundMessage;
  /** Conversation history (empty for first message or bare mention) */
  context: ContextMessage[];
  /** Whether this is resuming an existing CC session */
  isResume: boolean;
  /** Additional prompt text from attachment processing */
  attachmentPrompt: string;
  /** Security preamble to prepend */
  securityPreamble: string;
}

/**
 * Build a prompt for Claude Code invocation.
 *
 * Resume path: Just the new message with author attribution.
 * New conversation: Full context header + formatted history + latest message.
 * Bare mention (no content): "A user mentioned you" with context.
 */
export function buildPrompt(opts: PromptBuildOpts): string {
  const { msg, context, isResume, attachmentPrompt, securityPreamble } = opts;
  const formatted = formatContextForClaude(context);
  const isThread = !!msg.threadId;

  let prompt: string;

  if (isResume) {
    // Resuming a thread session — CC already has context
    prompt = msg.content
      ? `[Message from ${msg.authorName}]: ${msg.content}`
      : `The user ${msg.authorName} mentioned you again in this thread. Please respond to the latest messages.`;
  } else if (msg.content) {
    // New conversation with content
    prompt = formatted
      ? `You are responding in a ${msg.platform === "discord" ? "Discord" : msg.platform === "mattermost" ? "Mattermost" : msg.platform} ${isThread ? "thread" : "channel"}. Here's the recent conversation:\n${formatted}\n\nLatest message from ${msg.authorName}:\n${msg.content}`
      : msg.content;
  } else {
    // Bare mention — no content
    prompt = `You are responding in a ${msg.platform === "discord" ? "Discord" : msg.platform === "mattermost" ? "Mattermost" : msg.platform} ${isThread ? "thread" : "channel"}. A user mentioned you to get your input on the conversation. Here's the recent conversation:\n${formatted}\n\nPlease respond to the conversation above. The user who mentioned you is ${msg.authorName}.`;
  }

  // Append attachment context
  if (attachmentPrompt) {
    prompt += attachmentPrompt;
  }

  // Prepend security preamble
  if (securityPreamble) {
    prompt = securityPreamble + prompt;
  }

  return prompt;
}
