import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { DeskRuntime } from "../desk/compose";
import { linkToMeeting, meetingTarget, taskSubject, undoAttach, type LinkSubject } from "../desk/links";
import { readingEvents } from "../desk/mail-snooze";
import { readMyDay } from "../desk/my-day";
import { listOpenNotes } from "../desk/notes";
import { STUDIO_SLUG } from "../desk/studio/format";
import { oneLine } from "../desk/studio/edit";
import { withSyncedBalance } from "../desk/studio-my-day";
import { fail, noStore, undoAttachDeps } from "./desk-mail";

const SubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), id: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("thread"), slug: z.string().regex(STUDIO_SLUG) }).strict(),
  z.object({ kind: z.literal("note"), id: z.number().int().positive() }).strict(),
]);

const LinksRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("link"), requestId: z.uuid(), from: SubjectSchema, to: z.object({ kind: z.literal("meeting"), event: z.string().min(1).max(1000) }).strict() }).strict(),
  z.object({ op: z.literal("unlink"), link: z.string().min(1).max(64) }).strict(),
]);

type Subject = z.infer<typeof SubjectSchema>;

export interface DeskLinksDeps {
  now?: () => number;
  newId?: () => string;
}

const GONE = "That task, thread or note no longer exists.";

async function subjectOf(db: Database, runtime: DeskRuntime, from: Subject, now: number): Promise<LinkSubject | null> {
  const desk = runtime.options;
  if (!desk) return null;
  if (from.kind === "note") {
    const note = listOpenNotes(db).find((n) => n.id === from.id);
    return note ? { kind: "note", key: `note:${note.id}`, title: oneLine(note.text).slice(0, 300), mail: null } : null;
  }
  return withSyncedBalance(db, desk, now, (source, studio) => {
    if (from.kind === "task") return taskSubject(readMyDay(db, desk, now, source), from.id);
    const thread = studio ? [...studio.active, ...studio.parked, ...studio.closed].find((t) => t.slug === from.slug) : undefined;
    return thread ? { kind: "thread", key: `thread:${thread.slug}`, title: oneLine(thread.question).slice(0, 300), mail: null } : null;
  });
}

/**
 * POST {op: "link", requestId, from: {kind: "task", id} | {kind: "thread", slug} | {kind: "note", id}, to: {kind: "meeting", event}}
 * links a task, Studio thread or note to a meeting the Desk lists, past or upcoming; {op: "unlink", link} ends it. A mail is
 * linked through {action: "attach"} on /api/desk/mail, and both undo doors end the same link.
 */
export async function handleDeskLinks(req: Request, db: Database, runtime: DeskRuntime | undefined, deps: DeskLinksDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!runtime?.options?.enabled) return fail(409, "The Desk is turned off on this stack.");
  const parsed = LinksRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "A link needs a subject, a meeting and a request id.");
  const body = parsed.data;
  const now = (deps.now ?? Date.now)();
  const readings = runtime.sourceCache?.cached() ?? [];
  const result = body.op === "unlink"
    ? await undoAttach(db, body.link, undoAttachDeps(db, runtime, now))
    : await link(db, runtime, body.from, body.to.event, { now, readings, newId: deps.newId ?? (() => crypto.randomUUID()), requestId: body.requestId });
  return result.ok ? Response.json(result, { headers: noStore }) : fail(result.status, result.error);
}

async function link(db: Database, runtime: DeskRuntime, from: Subject, event: string, ctx: { now: number; readings: Parameters<typeof readingEvents>[0]; newId: () => string; requestId: string }) {
  const subject = await subjectOf(db, runtime, from, ctx.now);
  if (!subject) return { ok: false as const, status: 404, error: GONE };
  const target = meetingTarget(readingEvents(ctx.readings), event, false, ctx.now);
  if (typeof target === "string") return { ok: false as const, status: 409, error: target };
  return linkToMeeting(db, subject, target, { id: ctx.newId(), requestId: ctx.requestId, origin: "desk", now: ctx.now });
}
