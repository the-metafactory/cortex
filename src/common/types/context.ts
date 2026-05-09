/**
 * T-1.2: Message Context Types
 */

export interface MessageContext {
  source: "discord" | "mattermost";
  channelId: string;
  threadId?: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
  history: ContextMessage[];
}

export interface ContextAttachment {
  name: string;
  url: string;
  contentType: string;
  size: number;
}

export interface ContextMessage {
  role: "human" | "assistant";
  author: string;
  content: string;
  timestamp: string;
  attachments?: ContextAttachment[];
}

export const POSTABLE_EVENTS = [
  "agent.task.started",
  "agent.task.completed",
  "agent.task.failed",
  "tool.file.changed",
  "tool.agent.spawned",
  "tool.todo.updated",
] as const;

export function formatContextForClaude(messages: ContextMessage[]): string {
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
