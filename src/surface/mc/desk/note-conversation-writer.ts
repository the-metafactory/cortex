import type { CreateRequest, OwnerType, OwnerWriter, ReadbackResult } from "../../../conversations/types";
import { studioRequestId } from "../../../conversations/conversation-ids";
import { deskConversationWriter, deskWriterOwner, type DeskWriterDeps } from "./desk-conversation-writer";
import type { DeskOptions } from "./compose";

interface NoteLabels { objects: string; noun: string; fallback: string }
const DEFAULT_NOTE_LABELS: NoteLabels = { objects: "notes", noun: "notes", fallback: "the inbox" };
const noteLabels = (desk: DeskOptions | undefined): NoteLabels => ({ ...DEFAULT_NOTE_LABELS, ...desk?.ask?.writerLabels?.note });
const MAYBE_CREATED = /may have been created/i;

const NOTE_CATALOG_SLOT: OwnerType = "tana-note";

export const noteWriterKey = (desk: DeskOptions | undefined): OwnerType | undefined => (deskWriterOwner(desk, "note") ? NOTE_CATALOG_SLOT : undefined);

const noteFields = (request: CreateRequest): { text: string } => ({ text: request.fields.text ?? "" });
const afterRefusal = (_: CreateRequest, error: string): Promise<ReadbackResult> => Promise.resolve(MAYBE_CREATED.test(error) ? null : { found: false });

export function noteWriter(deps: DeskWriterDeps): OwnerWriter {
  const { objects, noun, fallback } = noteLabels(deps.desk());
  const writer = deskConversationWriter({
    kind: "note",
    objects,
    destination: { flag: "--target", field: "target", noun, fallback, verb: "adds" },
    fields: noteFields,
    afterRefusal,
  }, deps);
  return {
    ...writer,
    create: async request => {
      const result = await writer.create(request);
      return result.state === "created" && result.canonicalId === studioRequestId(request.operationId) ? { state: "created", canonicalId: "" } : result;
    },
  };
}
