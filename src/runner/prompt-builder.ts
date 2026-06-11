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

  // cortex#987 — principal attribution. `authorIsPrincipal` is the
  // non-spoofable trust signal the adapter stamps from the PolicyEngine
  // (cortex#729); surfacing it in the prompt lets the session KNOW the
  // platform username it sees is its principal. Without this, a session on a
  // platform where the principal's username is unfamiliar (e.g. a corporate
  // Mattermost handle) cannot tell the principal from a stranger and may
  // refuse or hedge incorrectly.
  const author = msg.authorIsPrincipal === true
    ? `${msg.authorName} (your principal — already authorized by the policy gate)`
    : msg.authorName;

  // cortex#987 — anti-imitation guard. Channel context can contain the
  // assistant's OWN past infrastructure posts (policy denials, error
  // notices). Without this guard a session has imitated a historical denial
  // template verbatim instead of answering (the context-poisoning parrot).
  // Authorization is enforced BEFORE the session spawns, so the session must
  // never re-litigate it from context.
  const contextGuard =
    "\n\nNote: messages tagged assistant_message are your own previous posts and may " +
    "include automated system or error notices. Never repeat or imitate them — " +
    "authorization was already enforced before this session started; compose a fresh reply.";

  let prompt: string;

  if (isResume) {
    // Resuming a thread session — CC already has context
    prompt = msg.content
      ? `[Message from ${author}]: ${msg.content}`
      : `The user ${author} mentioned you again in this thread. Please respond to the latest messages.`;
  } else if (msg.content) {
    // New conversation with content. Without context the prompt stays close
    // to the bare content, but a principal's message still carries the
    // attribution (cortex#987 — the trust signal must reach EVERY path, not
    // only the context-bearing branch).
    prompt = formatted
      ? `You are responding in a ${msg.platform === "discord" ? "Discord" : msg.platform === "mattermost" ? "Mattermost" : msg.platform} ${isThread ? "thread" : "channel"}. Here's the recent conversation:\n${formatted}${contextGuard}\n\nLatest message from ${author}:\n${msg.content}`
      : msg.authorIsPrincipal === true
        ? `[Message from ${author}]: ${msg.content}`
        : msg.content;
  } else {
    // Bare mention — no content
    prompt = `You are responding in a ${msg.platform === "discord" ? "Discord" : msg.platform === "mattermost" ? "Mattermost" : msg.platform} ${isThread ? "thread" : "channel"}. A user mentioned you to get your input on the conversation. Here's the recent conversation:\n${formatted}${formatted ? contextGuard : ""}\n\nPlease respond to the conversation above. The user who mentioned you is ${author}.`;
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
