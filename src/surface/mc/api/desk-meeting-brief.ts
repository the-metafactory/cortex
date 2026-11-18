import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { DeskRuntime } from "../desk/compose";
import { DESK_MEETING_BRIEF_PATH, REFRESH_REQUIRED, type BriefRefreshRequired } from "../desk/meeting-brief-contract";
import { briefOf, dropPrepared, gatherEvidence, readPrepared, resolveMeeting, storePrepared, type BriefDeps } from "../desk/meeting-brief";
import { currentSynthesis, decideSynthesis, queueSynthesis, synthesisModel } from "../desk/meeting-brief-synthesis";
import { fail, noStore } from "./desk-mail";

export { DESK_MEETING_BRIEF_PATH };

const EVENT_KEY = z.string().min(1).max(500);

const PrepareSchema = z.object({ event: EVENT_KEY, refresh: z.boolean().optional() }).strict();

const GONE = "The Desk no longer sees that meeting.";
const NOT_PREPARED = "No brief is prepared for that meeting. Prepare it first.";
const STALE = "The meeting or its linked material changed since this brief was prepared. Refresh it.";
const UNREADABLE_BODY_FAILS_THE_SCHEMA = null;
const FAILURE_REACHES_THE_CALLER_THROUGH_TURN = undefined;

const refreshRequired = (): Response => {
  const body: BriefRefreshRequired = { ok: false, error: STALE, code: REFRESH_REQUIRED };
  return Response.json({ ...body, messagePhrase: { code: "brief.refresh-required" } }, { status: 409, headers: noStore });
};

async function prepare(req: Request, db: Database, runtime: DeskRuntime, deps: BriefDeps): Promise<Response> {
  const parsed = PrepareSchema.safeParse(await req.json().catch(() => UNREADABLE_BODY_FAILS_THE_SCHEMA));
  if (!parsed.success) return fail(400, "A brief needs the event key of a meeting, and refresh may only be true or false.");
  const { event, refresh } = parsed.data;
  const current = await currentEvidence(db, runtime, event, deps);
  if (!current) return fail(404, GONE);
  const stored = readPrepared(db, event);
  const now = (deps.now ?? Date.now)();
  const reuse = stored?.revision === current.evidence.revision && refresh !== true;
  const brief = reuse ? stored : briefOf(event, current.evidence, now);
  if (!reuse) storePrepared(db, brief, now);
  const synthesis = queueSynthesis(db, runtime, event, decideSynthesis(runtime, current.evidence), { refresh: refresh === true, model: deps.synthesisModel ?? synthesisModel, now: deps.now ?? Date.now });
  return Response.json({ ...brief, synthesis }, { headers: noStore });
}

async function read(url: URL, db: Database, runtime: DeskRuntime, deps: BriefDeps): Promise<Response> {
  const event = EVENT_KEY.safeParse(url.searchParams.get("event"));
  if (!event.success) return fail(400, "An event key is required.");
  const current = await currentEvidence(db, runtime, event.data, deps);
  if (!current) return fail(404, GONE);
  const stored = readPrepared(db, event.data);
  if (!stored) return fail(404, NOT_PREPARED);
  if (stored.revision !== current.evidence.revision) return refreshRequired();
  const synthesis = currentSynthesis(db, event.data, decideSynthesis(runtime, current.evidence), (deps.now ?? Date.now)());
  return Response.json({ ...stored, synthesis }, { headers: noStore });
}

const gathering = new WeakMap<Database, Promise<unknown>>();

async function currentEvidence(db: Database, runtime: DeskRuntime, event: string, deps: BriefDeps) {
  await runtime.sourceCache?.read(runtime.options?.sources ?? [], (deps.now ?? Date.now)(), true);
  const turn = (gathering.get(db) ?? Promise.resolve()).then(() => gatherCurrent(db, runtime, event, deps));
  gathering.set(db, turn.catch(() => FAILURE_REACHES_THE_CALLER_THROUGH_TURN));
  return turn;
}

async function gatherCurrent(db: Database, runtime: DeskRuntime, event: string, deps: BriefDeps) {
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
