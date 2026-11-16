import { z } from "zod";
import { INTERRUPT_REASON_CODES } from "../surface/mc/desk/types";

const mailReference = z.object({ action: z.string(), account: z.string(), messageId: z.string() });
const moveTarget = z.enum(["archive", "junk", "trash"]);

export const MailMoveCommandRequestSchema = mailReference.extend({ action: z.literal("move"), target: moveTarget });
export const MailRestoreCommandRequestSchema = mailReference.extend({ action: z.literal("restore"), from: moveTarget });
export const MailTrashCommandRequestSchema = mailReference.extend({ action: z.literal("trash") });
export const MailLocateCommandRequestSchema = mailReference.extend({ action: z.literal("locate") });
export const MailDraftCommandRequestSchema = mailReference.extend({ action: z.literal("draft"), to: z.string(), subject: z.string(), body: z.string() });
export const MailReportCommandRequestSchema = mailReference.extend({ action: z.literal("report"), to: z.string().optional() });
export const MailInvitationReplyCommandRequestSchema = mailReference.extend({ action: z.literal("invite-reply"), uid: z.string(), reply: z.enum(["accept", "decline"]), requestId: z.string() });

function commandJson(output: unknown): unknown {
  if (typeof output !== "string") return output;
  try {
    return JSON.parse(output) as unknown;
  } catch (_err) {
    return null;
  }
}

const optionalMessage = z.string().catch("");
const optionalFolder = z.string().trim().transform(folder => folder ? folder.slice(0, 200) : null).catch(null);

export const MailMoveCommandResultSchema = z.preprocess(commandJson, z.object({ message: optionalMessage, folder: optionalFolder }).catch({ message: "", folder: null }));
export const MailRestoreCommandResultSchema = MailMoveCommandResultSchema;
export const MailTrashCommandResultSchema = MailMoveCommandResultSchema;
export const MailLocateCommandResultSchema = z.preprocess(commandJson, z.object({ place: z.enum(["inbox", "archive", "junk", "trash", "gone"]), folder: optionalFolder, unread: z.unknown().transform(unread => unread === true) }));
export const MailDraftCommandResultSchema = z.preprocess(commandJson, z.object({ id: z.string().trim().catch("") }).catch({ id: "" }));
export const MailReportCommandResultSchema = z.preprocess(commandJson, z.object({ message: optionalMessage }).catch({ message: "" }));
export const MailInvitationReplyCommandResultSchema = z.preprocess(commandJson, z.object({ message: z.string().max(300).refine(message => message.trim().length > 0).catch("") }).catch({ message: "" }));

export const PushCommandRequestSchema = z.object({
  key: z.string(),
  title: z.string(),
  why: z.string(),
  action: z.object({ label: z.string(), url: z.url().refine(url => /^https?:/.test(url) && !/[\s<>]/.test(url)) }).optional(),
  reason: z.object({
    code: z.enum(INTERRUPT_REASON_CODES),
    phrase: z.object({ code: z.enum(INTERRUPT_REASON_CODES), params: z.record(z.string(), z.unknown()).optional() }),
    target: z.string().optional(),
    eventKey: z.string().optional(),
    dueAt: z.string().optional(),
  }).optional(),
  held: z.object({ eventKey: z.string(), title: z.string(), until: z.number() }).optional(),
});
