import type { CreateRequest, OwnerWriter } from "../../../conversations/types";
import { FIELD_SCHEMAS } from "./ask";
import { deskConversationWriter, instant, type DeskWriterDeps } from "./desk-conversation-writer";

const NOTES_MAX = FIELD_SCHEMAS.calendar.shape.notes.unwrap().maxLength ?? Number.POSITIVE_INFINITY;

function eventFields(request: CreateRequest): { title: string; start: string; end: string; notes: string } | string {
  const { fields, provenance } = request;
  const start = instant("start", fields.start);
  if (typeof start === "string") return start;
  const end = instant("end", fields.end);
  if (typeof end === "string") return end;
  if (end <= start) return "The end must come after the start";
  const origin = `From conversation ${provenance.conversationId}, operation ${request.operationId}.`;
  const notes = fields.notes ? `${fields.notes}\n\n${origin}` : origin;
  if (notes.length > NOTES_MAX) return `Calendar notes take up to ${NOTES_MAX - origin.length - 2} characters here`;
  return { title: fields.title ?? "", start: new Date(start).toISOString(), end: new Date(end).toISOString(), notes };
}

export const calendarWriter = (deps: DeskWriterDeps): OwnerWriter => deskConversationWriter({
  kind: "calendar", objects: "Calendar events", destination: { flag: "--calendar", field: "calendar", noun: "events", fallback: "the default calendar" }, fields: eventFields,
}, deps);
