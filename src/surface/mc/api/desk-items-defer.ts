import { z } from "zod";
import type { Database } from "bun:sqlite";
import { answer, failResponse } from "../desk/act-result";
import { composeCurrentDay, type DeskRuntime, type DeskVigilSource } from "../desk/compose";
import { cancelItemDefer, deferItem, deferRefusal, isDeferrableKind, isRefusedKind, ONLY_MAIL_WAITS_FOR_A_PERSON } from "../desk/item-defer";
import { resolveListedMail } from "../desk/mail-actions";
import { cancelSnooze, readingEvents, readSnooze, snoozeMail } from "../desk/mail-snooze";
import { SnoozeChoiceSchema } from "./desk-mail-choice";

export const DEFER_ACTIONS = ["defer", "defer.cancel"] as const;

const DeferRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal(DEFER_ACTIONS[0]), key: z.string().min(1).max(1000), until: SnoozeChoiceSchema }).strict(),
  z.object({ action: z.literal(DEFER_ACTIONS[1]), key: z.string().min(1).max(1000) }).strict(),
]);

export async function handleDeskItemsDefer(req: Request, db: Database, runtime: DeskRuntime | undefined, vigil?: DeskVigilSource): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!runtime?.options?.enabled) return failResponse(409, "The Desk is turned off on this stack.");
  const parsed = DeferRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return failResponse(400, "A defer action, item key and valid until choice are required.");
  const body = parsed.data;
  if (!body.key.startsWith("mail:")) return deferWorkItem(body, db, runtime, vigil);
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

async function deferWorkItem(body: z.infer<typeof DeferRequestSchema>, db: Database, runtime: DeskRuntime, vigil: DeskVigilSource | undefined): Promise<Response> {
  if (body.action === "defer.cancel") {
    const cancelled = cancelItemDefer(db, body.key);
    return cancelled ? answer({ ok: true, ...cancelled }) : failResponse(400, "The Desk has no deferred item with this key.");
  }
  const now = (runtime.now ?? Date.now)();
  const desk = runtime.options;
  if (!desk) return failResponse(409, "The Desk is turned off on this stack.");
  const named = body.key.includes(":") ? body.key.split(":", 1)[0] ?? "unknown" : "unknown";
  if (isRefusedKind(named)) return failResponse(400, deferRefusal(named));
  const item = (await composeCurrentDay(db, runtime, desk, vigil, now)).items.find((entry) => entry.key === body.key);
  if (!item) return failResponse(400, `The Desk does not list an item of kind ${named} with this key.`);
  if (!isDeferrableKind(item.kind)) return failResponse(400, deferRefusal(item.kind));
  if (body.until.kind === "person") return failResponse(400, ONLY_MAIL_WAITS_FOR_A_PERSON);
  const deferred = deferItem(db, item, body.until, { now, events: readingEvents(runtime.sourceCache?.cached() ?? []) });
  return deferred.ok ? answer(deferred) : failResponse(deferred.status, deferred.error);
}
