import type { DeskPush, DeskTransport, PushResult } from "./interrupt";
import { oneLine } from "./actions";
import { spawnWithStdin, type WriterRunner } from "./create";

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
      if (answer.delivered) return answer.messageId ? { status: "sent", ref: answer.messageId } : { status: "sent" };
      if (answer.code === "buffered") return { status: "buffered" };
      return { status: "failed", error: `Discord did not take the message (${answer.code}${answer.detail ? `: ${answer.detail}` : ""}).` };
    },
  };
}

export function commandTransport(argv: string[], timeoutMs: number, run: WriterRunner = spawnWithStdin): DeskTransport {
  return {
    id: "command",
    send: async (push): Promise<PushResult> => {
      const url = push.action ? safeUrl(push.action.url) : null;
      const stdin = JSON.stringify({ key: push.key, title: push.title, why: push.why, ...(push.action && url ? { action: { label: push.action.label, url } } : {}) });
      try {
        const result = await run(argv, stdin, timeoutMs);
        if (result.code === 0) return { status: "sent" };
        return { status: "failed", error: oneLine(result.stderr || result.stdout, `The transport command exited with code ${result.code}.`) };
      } catch (err) {
        return { status: "failed", error: `The transport command did not finish: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}
