import type { DeskPush, DeskTransport, PushResult } from "./interrupt";

export type NotifyAnswer = { delivered: true; messageId?: string } | { delivered: false; code: string; detail?: string };

const escapeMarkdown = (text: string): string => text.replace(/[\\*_~`|>[\]()]/g, "\\$&");

function safeUrl(raw: string): string | null {
  if (/[\s<>]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function pushText(push: DeskPush): string {
  const lines = [`**${escapeMarkdown(push.title)}**`, escapeMarkdown(push.why)];
  const url = push.action ? safeUrl(push.action.url) : null;
  if (push.action && url) lines.push(`${escapeMarkdown(push.action.label)}: <${url}>`);
  return lines.join("\n");
}

export function discordTransport(notify: (text: string) => Promise<NotifyAnswer>): DeskTransport {
  return {
    id: "discord",
    send: async (push): Promise<PushResult> => {
      const answer = await notify(pushText(push));
      if (answer.delivered) return answer.messageId ? { ok: true, ref: answer.messageId } : { ok: true };
      return { ok: false, error: `Discord did not take the message (${answer.code}${answer.detail ? `: ${answer.detail}` : ""}).` };
    },
  };
}
