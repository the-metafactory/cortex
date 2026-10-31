import type { DeskPush, DeskTransport, PushResult } from "./interrupt";

export type NotifyAnswer = { delivered: true; messageId?: string } | { delivered: false; code: string; detail?: string };

const escapeMarkdown = (text: string): string => text.replace(/[\\*_~`|>[\]()]/g, "\\$&");

export function pushText(push: DeskPush): string {
  const lines = [`**${escapeMarkdown(push.title)}**`, escapeMarkdown(push.why)];
  if (push.action) lines.push(`${push.action.label}: <${push.action.url}>`);
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
