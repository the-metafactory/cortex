import { z } from "zod";
import { CORRECTION_MOVES } from "../../../surface/mc/desk/mail-correction-schema";
import { MAIL_CORRECTIONS } from "../../../surface/mc/desk/mail-action-schema";
import { SNOOZE_TIMES } from "../../../surface/mc/desk/mail-snooze-schema";
import { WAITING_OPS } from "../../../surface/mc/desk/mail-waiting-schema";
import { ObjectReferenceSchema, type AdapterDeclaration } from "../types";
import { adapterErrorSchema, objectReferenceSchema, objectSchema, schemaRef } from "../schema-primitives";
import { snapshotDigest } from "../operations/validation";
import type { ApprovedSnapshot, Provenance } from "../operations/types";
import { mailAccountRef, mailMoveDeclaration } from "./move-contract";

const message = ObjectReferenceSchema.refine(ref => ref.objectType === "message");
const DATE_LENGTH = 10;
const TEXT_LENGTH = 1000;
const ADDRESS_MIN_LENGTH = 3;
const ADDRESS_MAX_LENGTH = 320;
const snooze = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(SNOOZE_TIMES) }).strict(),
  z.object({ kind: z.literal("date"), date: z.string().max(DATE_LENGTH) }).strict(),
  z.object({ kind: z.literal("meeting"), event: z.string().min(1).max(TEXT_LENGTH) }).strict(),
  z.object({ kind: z.literal("person"), address: z.string().min(ADDRESS_MIN_LENGTH).max(ADDRESS_MAX_LENGTH) }).strict(),
]);

export const MailJudgementInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("unimportant"), message }).strict(),
  z.object({ action: z.literal("block-domain"), message }).strict(),
  z.object({ action: z.literal("correct"), message, said: z.enum(MAIL_CORRECTIONS) }).strict(),
  z.object({ action: z.literal("not-phishing"), message }).strict(),
  z.object({ action: z.literal("snooze"), message, until: snooze }).strict(),
  z.object({ action: z.literal("snooze-cancel"), message }).strict(),
  z.object({ action: z.literal("waiting"), message, op: z.enum(WAITING_OPS) }).strict(),
  z.object({ action: z.literal("undo"), message, operationId: z.string().min(1).max(TEXT_LENGTH) }).strict(),
]);
export type MailJudgementInput = z.infer<typeof MailJudgementInputSchema>;
export type MailJudgementAction = MailJudgementInput["action"];
export const MAIL_JUDGEMENT_ACTIONS: readonly MailJudgementAction[] = ["unimportant", "block-domain", "correct", "not-phishing", "snooze", "snooze-cancel", "waiting", "undo"];
export const judgementCapability = (action: MailJudgementAction): string => `mail.judgement.${action}`;
export const MailJudgementOutputSchema = z.object({ ref: message, message: z.string().min(1), undo: z.boolean() }).strict();
export type MailJudgementOutput = z.infer<typeof MailJudgementOutputSchema>;
export const judgementHasUndo = (input: MailJudgementInput): boolean => input.action !== "undo" && (input.action !== "correct" || Boolean(CORRECTION_MOVES[input.said]));

export function mailJudgementDeclaration(adapterId: string): AdapterDeclaration {
  const base = mailMoveDeclaration(adapterId, []);
  const ref = objectReferenceSchema(adapterId, "message");
  const fields = {
    message: ref,
    said: { type: "string", enum: [...MAIL_CORRECTIONS] },
    op: { type: "string", enum: [...WAITING_OPS] },
    operationId: { type: "string", minLength: 1, maxLength: TEXT_LENGTH },
    until: { oneOf: [
      objectSchema({ kind: { type: "string", enum: [...SNOOZE_TIMES] } }, ["kind"]),
      objectSchema({ kind: { const: "date" }, date: { type: "string", maxLength: DATE_LENGTH } }, ["kind", "date"]),
      objectSchema({ kind: { const: "meeting" }, event: { type: "string", minLength: 1, maxLength: TEXT_LENGTH } }, ["kind", "event"]),
      objectSchema({ kind: { const: "person" }, address: { type: "string", minLength: ADDRESS_MIN_LENGTH, maxLength: ADDRESS_MAX_LENGTH } }, ["kind", "address"]),
    ] },
  };
  const extra: Partial<Record<MailJudgementAction, keyof typeof fields>> = { correct: "said", snooze: "until", waiting: "op", undo: "operationId" };
  const outputSchemaRef = schemaRef(`${adapterId}.mail.judgement.output`);
  const errorSchemaRef = schemaRef(`${adapterId}.mail.judgement.error`);
  return {
    ...base,
    schemas: [...base.schemas,
      { ...outputSchemaRef, schema: objectSchema({ ref, message: { type: "string", minLength: 1 }, undo: { type: "boolean" } }, ["ref", "message", "undo"]) },
      { ...errorSchemaRef, schema: adapterErrorSchema(adapterId) },
      ...MAIL_JUDGEMENT_ACTIONS.map(action => {
        const field = extra[action];
        return { ...schemaRef(`${judgementCapability(action)}.input`), schema: objectSchema({ action: { const: action }, message: ref, ...(field ? { [field]: fields[field] } : {}) }, ["action", "message", ...(field ? [field] : [])]) };
      }),
    ],
    capabilities: MAIL_JUDGEMENT_ACTIONS.map(action => ({ capabilityId: judgementCapability(action), label: `Mail: ${action}`, kind: "action", objectTypes: ["message"], inputSchemaRef: schemaRef(`${judgementCapability(action)}.input`), outputSchemaRef, errorSchemaRef })),
  };
}

export function mailJudgementSnapshot(options: { adapterId: string; connectionId: string; account: string; input: MailJudgementInput; provenance: Provenance }): ApprovedSnapshot {
  const input = MailJudgementInputSchema.parse(options.input);
  if (input.message.adapterId !== options.adapterId || input.message.connectionId !== options.connectionId) throw new Error("The message does not belong to this Mail connection.");
  const capabilityId = judgementCapability(input.action);
  const parts = { adapterId: options.adapterId, connectionId: options.connectionId, capabilityId, inputSchemaRef: schemaRef(`${capabilityId}.input`), outputSchemaRef: schemaRef(`${options.adapterId}.mail.judgement.output`), errorSchemaRef: schemaRef(`${options.adapterId}.mail.judgement.error`), input, target: input.message, destinations: [mailAccountRef(options.adapterId, options.connectionId, options.account)], sources: [], policy: "local" as const, provenance: options.provenance };
  return { ...parts, digest: snapshotDigest(parts) };
}
