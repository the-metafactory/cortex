import { objectReferenceSchema, objectSchema, schemaRef } from "../schema-primitives";
import type { AdapterDeclaration, CapabilityDeclaration, ObjectReference } from "../types";
import { canonicalWire, snapshotDigest } from "../operations/validation";
import type { ApprovedSnapshot, Provenance } from "../operations/types";
import { mailMoveDeclaration } from "./move-contract";
export const MAIL_REPLY_DRAFT_CAPABILITY = "mail.reply-draft.create";

export const MAX_REPLY_CHARS = 20_000;

/** The existing reply-draft wire contract, shared by the host and external Mail adapters. */
export function mailReplyDraftDeclaration(adapterId = "mail"): AdapterDeclaration {
  const declaration = mailMoveDeclaration(adapterId, []);
  const input = schemaRef(`${MAIL_REPLY_DRAFT_CAPABILITY}.input`);
  const output = schemaRef(`${MAIL_REPLY_DRAFT_CAPABILITY}.output`);
  declaration.schemas.push(
    { ...input, schema: objectSchema({ message: objectReferenceSchema(adapterId, "message"), body: { type: "string", minLength: 1, maxLength: MAX_REPLY_CHARS } }, ["message", "body"]) },
    { ...output, schema: objectSchema({ ref: objectReferenceSchema(adapterId, "draft") }, ["ref"]) },
  );
  declaration.capabilities.push({ capabilityId: MAIL_REPLY_DRAFT_CAPABILITY, label: "Save reply draft", kind: "action", objectTypes: ["message"], inputSchemaRef: input, outputSchemaRef: output, errorSchemaRef: schemaRef(`${adapterId}.mail.error`) });
  return declaration;
}

/** Builds the exact message/account approval shape without trimming the reply text. */
export function mailReplyDraftSnapshot(options: {
  adapterId: string; connectionId: string; account: ObjectReference; message: ObjectReference; body: string;
  provenance: Provenance; policy?: "local" | "cloud"; capability?: CapabilityDeclaration;
}): ApprovedSnapshot {
  const capability = options.capability ?? mailReplyDraftDeclaration(options.adapterId).capabilities[0];
  if (capability?.kind !== "action" || capability.capabilityId !== MAIL_REPLY_DRAFT_CAPABILITY) throw new Error("This connection does not offer reply drafts.");
  const parts = {
    provenance: options.provenance, adapterId: options.adapterId, connectionId: options.connectionId, capabilityId: MAIL_REPLY_DRAFT_CAPABILITY,
    inputSchemaRef: capability.inputSchemaRef, outputSchemaRef: capability.outputSchemaRef, errorSchemaRef: capability.errorSchemaRef,
    input: { message: options.message, body: options.body }, target: options.message, destinations: [options.account], policy: options.policy ?? "local", sources: [],
  };
  const snapshot: ApprovedSnapshot = { ...parts, digest: snapshotDigest(parts) };
  if (!mailReplyDraftScopeMatches(snapshot, options.account.canonicalId) || options.body.length > MAX_REPLY_CHARS) throw new Error("The reply text or Mail scope is invalid.");
  return snapshot;
}

export function mailReplyDraftScopeMatches(snapshot: ApprovedSnapshot, account: unknown): boolean {
  const input = snapshot.input;
  if (typeof input !== "object" || input === null || Array.isArray(input) || typeof account !== "string" || !account) return false;
  const message = snapshot.target;
  const destination = snapshot.destinations[0];
  return message?.objectType === "message" && message.adapterId === snapshot.adapterId && message.connectionId === snapshot.connectionId && input.message !== undefined && canonicalWire(input.message) === canonicalWire(message) && typeof input.body === "string" && input.body.trim().length > 0 && snapshot.destinations.length === 1 && destination?.objectType === "account" && destination.adapterId === snapshot.adapterId && destination.connectionId === snapshot.connectionId && destination.canonicalId === account;
}
