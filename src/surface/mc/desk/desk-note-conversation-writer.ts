import type { OwnerWriter } from "../../../conversations/types";
import { deskConversationWriter, type DeskWriterDeps } from "./desk-conversation-writer";

export const DESK_NOTE_WITHHELD = "Notes go to the note writer set up on this stack, so the Desk does not keep them itself.";

export const deskNoteWriter = (deps: DeskWriterDeps): OwnerWriter => deskConversationWriter({
  kind: "note", objects: "Desk notes", keptOnDesk: true, fields: request => ({ text: request.fields.text ?? "" }),
}, deps);
