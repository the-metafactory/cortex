import { z } from "zod";
import { ObjectReferenceSchema, type AdapterDeclaration, type ObjectReference } from "../types";
import { adapterErrorSchema, objectReferenceSchema, objectSchema, schemaRef } from "../schema-primitives";
import { snapshotDigest } from "../operations/validation";
import type { ApprovedSnapshot, Provenance } from "../operations/types";

export const MAIL_MOVE_CAPABILITY = "mail.move";
export const MAIL_TRASH_CAPABILITY = "mail.trash";
export const MAIL_RESTORE_CAPABILITY = "mail.restore";
export const MAIL_MOVE_CAPABILITIES = [MAIL_MOVE_CAPABILITY, MAIL_TRASH_CAPABILITY, MAIL_RESTORE_CAPABILITY] as const;

export type MailMoveAction = "move" | "trash" | "restore";
export const MAIL_MOVE_TARGETS = ["archive", "junk"] as const;
export type MailMoveTarget = (typeof MAIL_MOVE_TARGETS)[number];

export const MAIL_ACTION_CAPABILITY: Record<MailMoveAction, string> = { move: MAIL_MOVE_CAPABILITY, trash: MAIL_TRASH_CAPABILITY, restore: MAIL_RESTORE_CAPABILITY };

export const MAIL_MESSAGE_TYPE = "message";
export const MAIL_ACCOUNT_TYPE = "account";

export const MAIL_REFUSAL = { missing: "message_missing", denied: "account_denied", location: "location_conflict", unavailable: "unavailable" } as const;
export const mailErrorCode = (adapterId: string, reason: keyof typeof MAIL_REFUSAL): string => `${adapterId}.${MAIL_REFUSAL[reason]}`;

const folderName = z.string().trim().min(1).max(200);
const MessageRefSchema = ObjectReferenceSchema.refine(ref => ref.objectType === MAIL_MESSAGE_TYPE);
export const MailMoveInputSchema = z.object({ message: MessageRefSchema, target: z.enum(MAIL_MOVE_TARGETS) }).strict();
export const MailTrashInputSchema = z.object({ message: MessageRefSchema }).strict();
export const MailRestoreInputSchema = z.object({ message: MessageRefSchema, from: folderName }).strict();
export const MailMoveOutputSchema = z.object({ ref: MessageRefSchema, folder: folderName }).strict();
export type MailMoveOutput = z.infer<typeof MailMoveOutputSchema>;

const INPUT_SCHEMAS = {
  move: z.object({ message: MessageRefSchema, target: z.enum(MAIL_MOVE_TARGETS) }).strict(),
  trash: MailTrashInputSchema,
  restore: MailRestoreInputSchema,
} as const;

const LABELS: Record<MailMoveAction, string> = { move: "Move mail", trash: "Move mail to Trash", restore: "Move mail back" };

/** The declaration a Mail adapter publishes for the move verbs. The Cortex runtime registers it as the contract a fixture binding or a real adapter must meet. */
export function mailMoveDeclaration(adapterId: string, only: readonly MailMoveAction[] = ["move", "trash", "restore"]): AdapterDeclaration {
  const message = objectReferenceSchema(adapterId, MAIL_MESSAGE_TYPE);
  const folder = { type: "string", minLength: 1, maxLength: 200 };
  const inputs: Record<MailMoveAction, ReturnType<typeof objectSchema>> = {
    move: objectSchema({ message, target: { type: "string", enum: [...MAIL_MOVE_TARGETS] } }, ["message", "target"]),
    trash: objectSchema({ message }, ["message"]),
    restore: objectSchema({ message, from: folder }, ["message", "from"]),
  };
  const errorRef = schemaRef(`${adapterId}.mail.error`);
  const schemas: AdapterDeclaration["schemas"] = [
    { ...errorRef, schema: adapterErrorSchema(adapterId) },
    { ...schemaRef(`${adapterId}.mail.message`), schema: message },
    { ...schemaRef(`${adapterId}.mail.account`), schema: objectReferenceSchema(adapterId, MAIL_ACCOUNT_TYPE) },
    { ...schemaRef(`${adapterId}.mail.move.output`), schema: objectSchema({ ref: message, folder }, ["ref", "folder"]) },
  ];
  const capabilities: AdapterDeclaration["capabilities"] = [];
  for (const action of only) {
    const id = MAIL_ACTION_CAPABILITY[action];
    schemas.push({ ...schemaRef(`${id}.input`), schema: inputs[action] });
    capabilities.push({ capabilityId: id, label: LABELS[action], kind: "action", objectTypes: [MAIL_MESSAGE_TYPE], inputSchemaRef: schemaRef(`${id}.input`), outputSchemaRef: schemaRef(`${adapterId}.mail.move.output`), errorSchemaRef: errorRef });
  }
  return {
    adapterId, label: "Mail", contractRange: "^1.0.0", schemas,
    objectTypes: [
      { objectType: MAIL_MESSAGE_TYPE, label: "Message", schemaRef: schemaRef(`${adapterId}.mail.message`), relationships: [] },
      { objectType: MAIL_ACCOUNT_TYPE, label: "Account", schemaRef: schemaRef(`${adapterId}.mail.account`), relationships: [] },
    ],
    capabilities,
  };
}

export const mailAccountRef = (adapterId: string, connectionId: string, account: string): ObjectReference => ({ adapterId, connectionId, objectType: MAIL_ACCOUNT_TYPE, canonicalId: account });
export const mailMessageRef = (adapterId: string, connectionId: string, messageId: string): ObjectReference => ({ adapterId, connectionId, objectType: MAIL_MESSAGE_TYPE, canonicalId: messageId });

export type MailMoveInput = { action: "move"; message: ObjectReference; target: MailMoveTarget } | { action: "trash"; message: ObjectReference } | { action: "restore"; message: ObjectReference; from: string };

export function mailMoveSnapshot(options: { adapterId: string; connectionId: string; account: ObjectReference; input: MailMoveInput; provenance: Provenance; policy?: "local" | "cloud" }): ApprovedSnapshot {
  const { input, adapterId, connectionId } = options;
  const capabilityId = MAIL_ACTION_CAPABILITY[input.action];
  const body = input.action === "move" ? INPUT_SCHEMAS.move.parse({ message: input.message, target: input.target }) : input.action === "trash" ? INPUT_SCHEMAS.trash.parse({ message: input.message }) : INPUT_SCHEMAS.restore.parse({ message: input.message, from: input.from });
  if (options.account.adapterId !== adapterId || options.account.connectionId !== connectionId || options.account.objectType !== MAIL_ACCOUNT_TYPE) throw new Error("The account does not belong to this Mail connection.");
  if (input.message.adapterId !== adapterId || input.message.connectionId !== connectionId) throw new Error("The message does not belong to this Mail connection.");
  const parts = {
    provenance: options.provenance, adapterId, connectionId, capabilityId,
    inputSchemaRef: schemaRef(`${capabilityId}.input`), outputSchemaRef: schemaRef(`${adapterId}.mail.move.output`), errorSchemaRef: schemaRef(`${adapterId}.mail.error`),
    input: body, destinations: [options.account], target: input.message, sources: [], policy: options.policy ?? "local",
  };
  return { ...parts, digest: snapshotDigest(parts) };
}
