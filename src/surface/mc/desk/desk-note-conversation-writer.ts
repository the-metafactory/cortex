import type { OwnerWriter } from "../../../conversations/types";
import { deskConversationWriter, type DeskWriterDeps } from "./desk-conversation-writer";

export const deskNoteWriter = (deps: DeskWriterDeps): OwnerWriter => deskConversationWriter({
  kind: "note", objects: "Desk notes", keptOnDesk: true, fields: request => ({ text: request.fields.text ?? "" }),
}, deps);
