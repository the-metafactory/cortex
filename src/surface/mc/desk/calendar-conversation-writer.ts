import type { Database } from "bun:sqlite";
import type { CreateRequest, CreateResult, OwnerWriter } from "../../../conversations/types";
import { FIELD_SCHEMAS, validateCard } from "./ask";
import type { DeskOptions } from "./compose";
import { studioRequestId } from "./conversation-ids";
import { createFromCard, spawnWithStdin, type WriterRunner } from "./create";

export interface CalendarWriterDeps {
  db: Database;
  desk: () => DeskOptions | undefined;
  run?: WriterRunner;
  now?: () => number;
}

const NOTHING = "Nothing was created.";
const failed = (sentence: string): CreateResult => ({ state: "failed", error: `${sentence.trim().replace(/[.\s]+$/, "")}. ${NOTHING}` });
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const NOTES_MAX = FIELD_SCHEMAS.calendar.shape.notes.unwrap().maxLength ?? Number.POSITIVE_INFINITY;

export const calendarArgv = (desk: DeskOptions | undefined): string[] | undefined => desk?.enabled && desk.ask?.writers.calendar?.length ? desk.ask.writers.calendar : undefined;

export function writerCalendar(argv: readonly string[]): string | undefined {
  const at = argv.indexOf("--calendar");
  return at >= 0 ? argv[at + 1] : undefined;
}

function instant(name: string, value: string | undefined): number | string {
  const at = value && ISO_TIME.exec(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : `The ${name} is not an ISO 8601 date and time such as 2027-01-06T09:00:00+01:00`;
}

function eventFields(request: CreateRequest): { title: string; start: string; end: string; notes: string } | string {
  const { fields, provenance } = request;
  const start = instant("start", fields.start);
  if (typeof start === "string") return start;
  const end = instant("end", fields.end);
  if (typeof end === "string") return end;
  if (end <= start) return "The end must come after the start";
  const origin = `From Ivy conversation ${provenance.conversationId}, operation ${request.operationId}.`;
  const notes = fields.notes ? `${fields.notes}\n\n${origin}` : origin;
  if (notes.length > NOTES_MAX) return `Calendar notes take up to ${NOTES_MAX - origin.length - 2} characters here`;
  return { title: fields.title ?? "", start: new Date(start).toISOString(), end: new Date(end).toISOString(), notes };
}

export function calendarWriter(deps: CalendarWriterDeps): OwnerWriter {
  const create = async (request: CreateRequest): Promise<CreateResult> => {
    const desk = deps.desk();
    const argv = calendarArgv(desk);
    if (!desk || !argv) return failed("Calendar events are not set up on this stack");
    const destination = writerCalendar(argv);
    const asked = request.fields.calendar ?? "";
    if (asked && asked !== destination) return failed(`This stack saves events only to ${destination ?? "the default calendar"}`);
    const fields = eventFields(request);
    if (typeof fields === "string") return failed(fields);
    const card = validateCard("calendar", fields);
    if (typeof card === "string") return failed(card);
    if (request.signal.aborted) throw new Error("The conversation stopped waiting before the calendar writer was called.");
    const saved = await createFromCard(card, { requestId: studioRequestId(request.operationId), writers: { calendar: argv }, run: deps.run ?? spawnWithStdin, db: deps.db, now: (deps.now ?? Date.now)(), timeoutMs: (desk.ask?.timeoutSeconds ?? 30) * 1000 });
    if (saved.ok) return { state: "created", canonicalId: saved.id };
    if (saved.uncertain) throw new Error(saved.error);
    return failed(saved.error);
  };
  return { create, readback: () => Promise.resolve(null) };
}
