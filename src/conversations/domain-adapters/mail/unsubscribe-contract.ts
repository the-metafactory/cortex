import { z } from "zod";
import { ObjectReferenceSchema, type AdapterDeclaration } from "../types";
import { objectReferenceSchema, objectSchema, schemaRef } from "../schema-primitives";
import { snapshotDigest } from "../operations/validation";
import type { ApprovedSnapshot, Provenance } from "../operations/types";
import { MAIL_MESSAGE_TYPE, mailAccountRef, mailMoveDeclaration } from "./move-contract";

export const MAIL_UNSUBSCRIBE_CAPABILITY = "mail.unsubscribe";
const HOST_MAX_LENGTH = 200;

const MessageRefSchema = ObjectReferenceSchema.refine(ref => ref.objectType === MAIL_MESSAGE_TYPE);

export const MailUnsubscribeInputSchema = z.object({ message: MessageRefSchema }).strict();
export type MailUnsubscribeInput = z.infer<typeof MailUnsubscribeInputSchema>;

export const MailUnsubscribeOutputSchema = z.object({ ref: MessageRefSchema, host: z.string().trim().min(1).max(HOST_MAX_LENGTH) }).strict();
export type MailUnsubscribeOutput = z.infer<typeof MailUnsubscribeOutputSchema>;

/** The declaration a Mail adapter publishes for one-click unsubscribe. The Cortex runtime registers it as the contract a fixture binding or a real adapter must meet. */
export function mailUnsubscribeDeclaration(adapterId: string): AdapterDeclaration {
  const base = mailMoveDeclaration(adapterId, []);
  const message = objectReferenceSchema(adapterId, MAIL_MESSAGE_TYPE);
  const input = schemaRef(`${MAIL_UNSUBSCRIBE_CAPABILITY}.input`);
  const output = schemaRef(`${adapterId}.mail.unsubscribe.output`);
  return {
    ...base,
    schemas: [...base.schemas,
      { ...input, schema: objectSchema({ message }, ["message"]) },
      { ...output, schema: objectSchema({ ref: message, host: { type: "string", minLength: 1, maxLength: HOST_MAX_LENGTH } }, ["ref", "host"]) },
    ],
    capabilities: [{ capabilityId: MAIL_UNSUBSCRIBE_CAPABILITY, label: "Unsubscribe", kind: "action", objectTypes: [MAIL_MESSAGE_TYPE], inputSchemaRef: input, outputSchemaRef: output, errorSchemaRef: schemaRef(`${adapterId}.mail.error`) }],
  };
}

export function mailUnsubscribeSnapshot(options: { adapterId: string; connectionId: string; account: string; input: MailUnsubscribeInput; provenance: Provenance }): ApprovedSnapshot {
  const input = MailUnsubscribeInputSchema.parse(options.input);
  if (input.message.adapterId !== options.adapterId || input.message.connectionId !== options.connectionId) throw new Error("The message does not belong to this Mail connection.");
  const parts = {
    provenance: options.provenance, adapterId: options.adapterId, connectionId: options.connectionId, capabilityId: MAIL_UNSUBSCRIBE_CAPABILITY,
    inputSchemaRef: schemaRef(`${MAIL_UNSUBSCRIBE_CAPABILITY}.input`), outputSchemaRef: schemaRef(`${options.adapterId}.mail.unsubscribe.output`), errorSchemaRef: schemaRef(`${options.adapterId}.mail.error`),
    input, destinations: [mailAccountRef(options.adapterId, options.connectionId, options.account)], target: input.message, sources: [], policy: "local" as const,
  };
  return { ...parts, digest: snapshotDigest(parts) };
}
