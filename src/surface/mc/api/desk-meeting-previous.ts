import type { Database } from "bun:sqlite";
import { z } from "zod";
import { failResponse } from "../desk/act-result";
import type { DeskRuntime } from "../desk/compose";
import { DESK_MEETING_PREVIOUS_PATH, type PreviousMeetingRelationship } from "../desk/meeting-brief-contract";
import { previousFault, resolveMeeting, type BriefDeps } from "../desk/meeting-brief";
import { clearPreviousRelation, setPreviousRelation } from "../desk/meeting-previous";
import { noStore } from "./desk-mail";

export { DESK_MEETING_PREVIOUS_PATH };

const EVENT_KEY = z.string().min(1).max(500);

const PreviousSchema = z.object({ event: EVENT_KEY, previousEvent: EVENT_KEY.nullable() }).strict();

const relationship = (event: string, previousEvent: string | null): Response => {
  const body: PreviousMeetingRelationship = previousEvent === null
    ? { ok: true, event, previousEvent, relation: null, message: "No previous meeting is set.", messagePhrase: { code: "brief.previous-cleared" } }
    : { ok: true, event, previousEvent, relation: "explicit", message: "The previous meeting is set.", messagePhrase: { code: "brief.previous-set" } };
  return Response.json(body, { headers: noStore });
};

export async function handleDeskMeetingPrevious(req: Request, db: Database, runtime: DeskRuntime | undefined, deps: BriefDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!runtime?.options?.enabled) return failResponse(409, "The Desk is turned off on this stack.");
  const parsed = PreviousSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return failResponse(400, "Setting a previous meeting needs an event key and a previous event key, or null to clear it.", { code: "brief.previous-invalid" });
  const { event, previousEvent } = parsed.data;
  const now = (deps.now ?? Date.now)();
  await runtime.sourceCache?.read(runtime.options.sources, now, true);
  const current = resolveMeeting(runtime, event);
  if (!current) return failResponse(404, "The Desk no longer sees that meeting.", { code: "brief.meeting-gone" });
  if (previousEvent === null) {
    clearPreviousRelation(db, event);
    return relationship(event, null);
  }
  const previous = resolveMeeting(runtime, previousEvent);
  const fault = previous ? previousFault(event, current, previousEvent, previous) : null;
  if (previousEvent === event) return failResponse(409, "A meeting cannot be its own previous meeting.", { code: "brief.previous-self" });
  if (!previous) return failResponse(409, "The Desk cannot read that previous meeting.", { code: "brief.previous-target-unavailable" });
  if (fault) return failResponse(409, "The previous meeting must start before this one.", { code: "brief.previous-not-earlier" });
  setPreviousRelation(db, { event, eventConnection: current.connection ?? "", previousEvent, previousConnection: previous.connection ?? "" }, now);
  return relationship(event, previousEvent);
}
