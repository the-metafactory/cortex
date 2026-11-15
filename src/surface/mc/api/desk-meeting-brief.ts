import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { DeskRuntime } from "../desk/compose";
import { DESK_MEETING_BRIEF_PATH, REFRESH_REQUIRED, type BriefRefreshRequired } from "../desk/meeting-brief-contract";
import { briefOf, dropPrepared, gatherEvidence, readPrepared, resolveMeeting, storePrepared, type BriefDeps } from "../desk/meeting-brief";
import { fail, noStore } from "./desk-mail";

export { DESK_MEETING_BRIEF_PATH };

const EVENT_KEY = z.string().min(1).max(500);

const PrepareSchema = z.object({ event: EVENT_KEY, refresh: z.boolean().optional() }).strict();

const GONE = "The Desk no longer sees that meeting.";
const NOT_PREPARED = "No brief is prepared for that meeting. Prepare it first.";
const STALE = "The meeting or its linked material changed since this brief was prepared. Refresh it.";

const refreshRequired = (): Response => {
  const body: BriefRefreshRequired = { ok: false, error: STALE, code: REFRESH_REQUIRED };
  return Response.json({ ...body, messagePhrase: { code: "brief.refresh-required" } }, { status: 409, headers: noStore });
};

async function prepare(req: Request, db: Database, runtime: DeskRuntime, deps: BriefDeps): Promise<Response> {
  const parsed = PrepareSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "A brief needs the event key of a meeting, and refresh may only be true or false.");
  const { event, refresh } = parsed.data;
  const current = await currentEvidence(db, runtime, event, deps);
  if (!current) return fail(404, GONE);
  const stored = readPrepared(db, event);
  if (stored?.revision === current.evidence.revision && refresh !== true) return Response.json(stored, { headers: noStore });
  const now = (deps.now ?? Date.now)();
  const brief = briefOf(event, current.evidence, now);
  storePrepared(db, brief, now);
  return Response.json(brief, { headers: noStore });
}

async function read(url: URL, db: Database, runtime: DeskRuntime, deps: BriefDeps): Promise<Response> {
  const event = EVENT_KEY.safeParse(url.searchParams.get("event"));
  if (!event.success) return fail(400, "An event key is required.");
  const current = await currentEvidence(db, runtime, event.data, deps);
  if (!current) return fail(404, GONE);
  const stored = readPrepared(db, event.data);
  if (!stored) return fail(404, NOT_PREPARED);
  return stored.revision === current.evidence.revision ? Response.json(stored, { headers: noStore }) : refreshRequired();
}

async function currentEvidence(db: Database, runtime: DeskRuntime, event: string, deps: BriefDeps) {
  await runtime.sourceCache?.read(runtime.options?.sources ?? [], (deps.now ?? Date.now)(), true);
  const meeting = resolveMeeting(runtime, event);
  if (!meeting) {
    dropPrepared(db, event);
    return null;
  }
  return { meeting, evidence: await gatherEvidence(db, runtime, event, meeting, deps) };
}

export async function handleDeskMeetingBrief(req: Request, db: Database, runtime: DeskRuntime | undefined, deps: BriefDeps = {}): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  if (!runtime?.options?.enabled) return fail(409, "The Desk is turned off on this stack.");
  return req.method === "POST" ? prepare(req, db, runtime, deps) : read(new URL(req.url), db, runtime, deps);
}
