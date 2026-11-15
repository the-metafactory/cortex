import { z } from "zod";
import type { ApprovedSnapshot, Provenance } from "../operations/types";
import { snapshotDigest } from "../operations/validation";
import { objectSchema, objectReferenceSchema, schemaRef } from "../schema-primitives";
import { MAIL_MESSAGE_TYPE, mailAccountRef, mailMoveDeclaration } from "./move-contract";
import { ObjectReferenceSchema, type AdapterDeclaration } from "../types";

export const MAIL_REPORT_KINDS = ["draft", "spam", "phishing"] as const;
export type MailReportKind = (typeof MAIL_REPORT_KINDS)[number];
export const MAIL_PROVIDER_REPORT_KINDS = ["spam", "phishing"] as const;
export type MailProviderReportKind = (typeof MAIL_PROVIDER_REPORT_KINDS)[number];

export const MAIL_REPORT_CAPABILITY: Readonly<Record<MailReportKind, string>> = { draft: "mail.report.draft", spam: "mail.report.spam", phishing: "mail.report.phishing" };
const FOLDER_MAX_LENGTH = 200;

export const isProviderReport = (kind: MailReportKind): kind is MailProviderReportKind => kind !== "draft";

const MessageRefSchema = ObjectReferenceSchema.refine(ref => ref.objectType === MAIL_MESSAGE_TYPE);

export const MailReportInputSchema = z.object({ message: MessageRefSchema }).strict();
export type MailReportInput = z.infer<typeof MailReportInputSchema>;

export const MailReportOutputSchema = z.object({ ref: MessageRefSchema, folder: z.string().trim().min(1).max(FOLDER_MAX_LENGTH) }).strict();
export type MailReportOutput = z.infer<typeof MailReportOutputSchema>;

const LABELS: Record<MailReportKind, string> = { draft: "Draft a report", spam: "Report as spam", phishing: "Report as phishing" };

/** The declaration a Mail adapter publishes for the report kinds. Provider reports need restore too, because Undo moves the mail back. */
export function mailReportDeclaration(adapterId: string, kinds: readonly MailReportKind[] = MAIL_REPORT_KINDS): AdapterDeclaration {
  const base = mailMoveDeclaration(adapterId, ["restore"]);
  const message = objectReferenceSchema(adapterId, MAIL_MESSAGE_TYPE);
  const output = schemaRef(`${adapterId}.mail.report.output`);
  const schemas: AdapterDeclaration["schemas"] = [
    ...base.schemas,
    { ...output, schema: objectSchema({ ref: message, folder: { type: "string", minLength: 1, maxLength: FOLDER_MAX_LENGTH } }, ["ref", "folder"]) },
  ];
  const capabilities: AdapterDeclaration["capabilities"] = [...base.capabilities];
  for (const kind of kinds) {
    const id = MAIL_REPORT_CAPABILITY[kind];
    schemas.push({ ...schemaRef(`${id}.input`), schema: objectSchema({ message }, ["message"]) });
    capabilities.push({ capabilityId: id, label: LABELS[kind], kind: "action", objectTypes: [MAIL_MESSAGE_TYPE], inputSchemaRef: schemaRef(`${id}.input`), outputSchemaRef: output, errorSchemaRef: schemaRef(`${adapterId}.mail.error`) });
  }
  return { ...base, schemas, capabilities };
}

export function mailReportSnapshot(options: { adapterId: string; connectionId: string; account: string; kind: MailReportKind; input: MailReportInput; provenance: Provenance }): ApprovedSnapshot {
  const input = MailReportInputSchema.parse(options.input);
  if (input.message.adapterId !== options.adapterId || input.message.connectionId !== options.connectionId) throw new Error("The message does not belong to this Mail connection.");
  const capabilityId = MAIL_REPORT_CAPABILITY[options.kind];
  const parts = {
    provenance: options.provenance, adapterId: options.adapterId, connectionId: options.connectionId, capabilityId,
    inputSchemaRef: schemaRef(`${capabilityId}.input`), outputSchemaRef: schemaRef(`${options.adapterId}.mail.report.output`), errorSchemaRef: schemaRef(`${options.adapterId}.mail.error`),
    input, destinations: [mailAccountRef(options.adapterId, options.connectionId, options.account)], target: input.message, sources: [], policy: "local" as const,
  };
  return { ...parts, digest: snapshotDigest(parts) };
}
