import { z } from "zod";
import { mailAccountRef, mailMessageRef } from "./move-contract";
import { ObjectReferenceSchema, type AdapterDeclaration, type ObjectReference } from "../types";
import { adapterErrorSchema, objectReferenceSchema, objectSchema, schemaRef } from "../schema-primitives";
import { snapshotDigest } from "../operations/validation";
import type { ApprovedSnapshot, Provenance } from "../operations/types";

export const INVITATION_REPLIES = ["accept", "decline", "tentative"] as const;
export type InvitationReply = (typeof INVITATION_REPLIES)[number];
export type InvitationAction = InvitationReply | "remove" | "restore";
export const INVITATION_CAPABILITIES: Record<InvitationAction, string> = {
  accept: "mail.invitation.accept", decline: "mail.invitation.decline", tentative: "mail.invitation.tentative",
  remove: "mail.invitation.remove", restore: "mail.invitation.restore",
};
export const invitationActionFor = (capabilityId: string): InvitationAction | undefined => (Object.keys(INVITATION_CAPABILITIES) as InvitationAction[]).find(action => INVITATION_CAPABILITIES[action] === capabilityId);
export const INVITATION_LABELS: Record<InvitationAction, string> = {
  accept: "Accept", decline: "Decline", tentative: "Tentative", remove: "Remove declined invitation", restore: "Restore declined invitation",
};
export const INVITATION_NOTIFICATION_WARNING = "Replies notify the organizer. Undo cannot retract that notification.";
export const INVITATION_NO_UNDO = "No Undo is available for an invitation reply; the organizer's notification cannot be retracted.";
const invitationRef = (adapterId: string, connectionId: string, canonicalId: string): ObjectReference => ({ adapterId, connectionId, objectType: "invitation", canonicalId });
const revision = z.string().min(1).max(500);
const invitation = ObjectReferenceSchema.refine(ref => ref.objectType === "invitation");
export const InvitationInputSchema = z.object({ message: ObjectReferenceSchema.refine(ref => ref.objectType === "message"), invitation, expectedRevision: revision }).strict();
export const InvitationOutputSchema = z.object({ ref: invitation, revision }).strict();
export type InvitationInput = z.infer<typeof InvitationInputSchema>;

function invitationSchemaRefs(adapterId: string) {
  return {
    inputSchemaRef: schemaRef(`${adapterId}.mail.invitation.input`),
    outputSchemaRef: schemaRef(`${adapterId}.mail.invitation.output`),
    errorSchemaRef: schemaRef(`${adapterId}.mail.error`),
  };
}

export function mailInvitationDeclaration(adapterId: string, actions: readonly InvitationAction[] = [...INVITATION_REPLIES, "remove", "restore"]): AdapterDeclaration {
  const message = objectReferenceSchema(adapterId, "message");
  const ref = objectReferenceSchema(adapterId, "invitation");
  const revisionSchema = { type: "string", minLength: 1, maxLength: 500 };
  const refs = invitationSchemaRefs(adapterId);
  const types = { message, invitation: ref, account: objectReferenceSchema(adapterId, "account") };
  return {
    adapterId, label: "Mail invitations", contractRange: "^1.0.0",
    schemas: [
      ...Object.entries(types).map(([type, schema]) => ({ ...schemaRef(`${adapterId}.mail.${type}`), schema })),
      { ...refs.inputSchemaRef, schema: objectSchema({ message, invitation: ref, expectedRevision: revisionSchema }, ["message", "invitation", "expectedRevision"]) },
      { ...refs.outputSchemaRef, schema: objectSchema({ ref, revision: revisionSchema }, ["ref", "revision"]) },
      { ...refs.errorSchemaRef, schema: adapterErrorSchema(adapterId) },
    ],
    objectTypes: Object.keys(types).map(objectType => ({ objectType, label: objectType, schemaRef: schemaRef(`${adapterId}.mail.${objectType}`), relationships: [] })),
    capabilities: actions.map(action => ({ capabilityId: INVITATION_CAPABILITIES[action], label: INVITATION_LABELS[action], kind: "action", objectTypes: ["invitation"], ...refs })),
  };
}

export function mailInvitationSnapshot(options: { adapterId: string; connectionId: string; account: string; action: InvitationAction; messageId: string; invitationId: string; expectedRevision: string; provenance: Provenance }): ApprovedSnapshot {
  const { adapterId, connectionId, action, messageId, invitationId, expectedRevision, provenance } = options;
  const input = InvitationInputSchema.parse({ message: mailMessageRef(adapterId, connectionId, messageId), invitation: invitationRef(adapterId, connectionId, invitationId), expectedRevision });
  const parts = {
    adapterId, connectionId, capabilityId: INVITATION_CAPABILITIES[action], provenance, input,
    ...invitationSchemaRefs(adapterId),
    destinations: [mailAccountRef(adapterId, connectionId, options.account)], target: input.invitation, expectedOwnerRevision: expectedRevision, sources: [], policy: "local" as const,
  };
  return { ...parts, digest: snapshotDigest(parts) };
}
