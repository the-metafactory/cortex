import type { ActContext, ActPlan, ActRefusal } from "./acts";
import { appendEntry, appendLog, safeBody } from "./edit";
import { localDate } from "./labels";

export const CONVERSATION_NOTE_KINDS = ["note", "idea", "stand"] as const;
export type ConversationNoteKind = (typeof CONVERSATION_NOTE_KINDS)[number];

export interface ConversationNote {
  thread: string;
  kind: ConversationNoteKind;
  text: string;
  via: string;
}

const refused = (error: string): ActRefusal => ({ status: 409, error });

export function planConversationNote(ctx: ActContext, note: ConversationNote): ActPlan | ActRefusal {
  const thread = [...ctx.view.active, ...ctx.view.parked].find(t => t.slug === note.thread);
  const file = ctx.files.threads.find(f => f.path === thread?.path);
  if (!thread || !file) return refused(`No open thread is called ${note.thread}.`);
  const at = new Date(ctx.now);
  while (thread.notes.some(n => Date.parse(n.at) === at.getTime())) at.setMilliseconds(at.getMilliseconds() + 1);
  const entry = [`### ${at.toISOString()}`, "trigger: Ivy conversation", `model: ${thread.policy}`, `kind: ${note.kind}`, `status: ${note.kind === "note" ? "kept" : "open"}`, "", ...safeBody(note.text)];
  const added = appendEntry(file.text, "notes", "Ivy's notes", entry);
  const text = added === null ? null : appendLog(added, localDate(ctx.now), `Added ${ctx.assistantName}'s ${note.kind} ${note.via}`);
  if (text === null) return refused(`${file.path} has a layout the Studio cannot edit.`);
  return { writes: [{ path: file.path, text }], removes: [], subject: `Add ${ctx.assistantName}'s ${note.kind} to ${thread.slug} from a conversation`, message: `${ctx.assistantName}'s ${note.kind} is in the thread.` };
}
