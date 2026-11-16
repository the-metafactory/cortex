import { z } from "zod";
import type { Database } from "bun:sqlite";
import { answer, failResponse } from "../desk/act-result";
import type { DeskRuntime } from "../desk/compose";
import { resolveListedMail } from "../desk/mail-actions";
import { cancelSnooze, readSnooze, snoozeMail } from "../desk/mail-snooze";
import { SnoozeChoiceSchema } from "./desk-mail-choice";

export const DEFER_ACTIONS = ["defer", "defer.cancel"] as const;

const DeferRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal(DEFER_ACTIONS[0]), key: z.string().min(1).max(1000), until: SnoozeChoiceSchema }).strict(),
  z.object({ action: z.literal(DEFER_ACTIONS[1]), key: z.string().min(1).max(1000) }).strict(),
]);

export async function handleDeskItemsDefer(req: Request, db: Database, runtime: DeskRuntime | undefined): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!runtime?.options?.enabled) return failResponse(409, "The Desk is turned off on this stack.");
  const parsed = DeferRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return failResponse(400, "A defer action, item key and valid until choice are required.");
  const body = parsed.data;
  const kind = body.key.includes(":") ? body.key.split(":", 1)[0] : "unknown";
  if (kind !== "mail") return failResponse(400, `The Desk cannot defer items of kind ${kind}. Only mail is supported.`);
  const messageId = body.key.slice("mail:".length);
  if (body.action === "defer.cancel") {
    const row = readSnooze(db, messageId);
    if (!row || row.kind === "hidden" || row.state !== "snoozed") return failResponse(400, "The Desk has no deferred item of kind mail with this key.");
    return answer(cancelSnooze(db, messageId));
  }
  const readings = runtime.sourceCache?.cached() ?? [];
  const listed = resolveListedMail(readings, body.key);
  if (!listed.ok) return failResponse(listed.reason === "unlisted" ? 400 : 409, listed.error);
  return answer(snoozeMail(db, listed.mail, body.until, { now: (runtime.now ?? Date.now)(), readings }));
}
