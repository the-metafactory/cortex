import type { CreateRequest, OwnerWriter, ReadbackResult } from "../../../conversations/types";
import { studioRequestId } from "../../../conversations/conversation-ids";
import { deskConversationWriter, deskWriterOwner, type DeskWriterDeps } from "./desk-conversation-writer";
import type { DeskOptions } from "./compose";

export const TANA_OWNER = "tana";
const MAYBE_CREATED = /may have been created/i;

export const tanaNoteReady = (desk: DeskOptions | undefined): boolean => deskWriterOwner(desk, "note") === TANA_OWNER;

const noteFields = (request: CreateRequest): { text: string } => ({ text: request.fields.text ?? "" });
const afterRefusal = (_: CreateRequest, error: string): Promise<ReadbackResult> => Promise.resolve(MAYBE_CREATED.test(error) ? null : { found: false });

export function tanaNoteWriter(deps: DeskWriterDeps): OwnerWriter {
  const writer = deskConversationWriter({
    kind: "note",
    objects: "Tana notes",
    destination: { flag: "--target", field: "target", noun: "Tana notes", fallback: "the Tana inbox", verb: "adds" },
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
