import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainAdapterRegistry } from "../registry";
import { fixtureBindings } from "../fixtures";
import { AT, authority, attemptFixture, eventFixture, openJournalFixture, support } from "../operations/fixtures";
import type { Authority, DispatchRequest, OwnerResult } from "../operations/types";
import { MailInvitationHost, type InvitationHostOptions } from "./invitation-host";
import { INVITATION_CAPABILITIES, INVITATION_REPLIES, InvitationInputSchema, mailInvitationDeclaration, type InvitationAction } from "./invitation-contract";

export const invitationProvenance = { conversationId: "mail", proposalId: "invitation", revision: 1, entryId: null, link: "?desk=mail" };
export const invitationSelection = { messageId: "message-example", invitationId: "invitation-example", expectedRevision: "1" };

export async function openInvitationFixture(actions: readonly InvitationAction[] = [...INVITATION_REPLIES, "remove", "restore"]) {
  const registry = new DomainAdapterRegistry();
  const declaration = mailInvitationDeclaration("mail", actions);
  const registration = registry.register(declaration, fixtureBindings(declaration));
  if (!registration.ok) throw new Error(registration.error.message);
  const dir = await mkdtemp(join(tmpdir(), "desk-invitation-"));
  let store = await openJournalFixture(join(dir, "journal.sqlite"), registry);
  const ids: string[] = [];
  const compensation = new Map<string, string[]>();
  const calls: DispatchRequest[] = [];
  const grants: { id: string; capabilityIds: readonly string[] }[] = [];
  const refreshes: string[] = [];
  const owner = { revision: "1", reply: "" as string, removed: false, notifications: 0, missing: false, denied: false, uncertain: false };
  let clock = Date.parse(AT) + 1000;
  let denyApproval = false;
  let denyGrant = false;
  const connectionId = "fixture-connection";
  const index: InvitationHostOptions["index"] = {
    add: (id, original) => { ids.push(id); if (original) compensation.set(original, [...compensation.get(original) ?? [], id]); return Promise.resolve(); },
    list: () => Promise.resolve([...ids]), compensations: id => Promise.resolve([...compensation.get(id) ?? []]),
  };

  function binding(request: DispatchRequest): OwnerResult["result"] {
    calls.push(request);
    const input = InvitationInputSchema.parse(request.snapshot.input);
    const evidence = { kind: "no-effect" as const, evidenceId: randomUUID(), observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { changed: false }, final: true as const };
    if (owner.denied || request.snapshot.destinations[0]?.canonicalId !== "account-example") return { kind: "failed", error: { code: "mail.account_denied", message: "The account is denied." }, evidence };
    if (owner.missing) return { kind: "failed", error: { code: "mail.message_missing", message: "The invitation is missing." }, evidence };
    if (owner.uncertain) return { kind: "uncertain", error: { code: "mail.uncertain", message: "The provider outcome is unknown." } };
    if (owner.revision !== input.expectedRevision) return { kind: "conflict", error: { code: "mail.invitation_changed", message: "The invitation changed. Read it again before acting." }, currentOwnerRevision: owner.revision, evidence };
    const action = (Object.keys(INVITATION_CAPABILITIES) as InvitationAction[]).find(action => INVITATION_CAPABILITIES[action] === request.snapshot.capabilityId);
    if (!action) throw new Error("The fixture received an undeclared invitation action.");
    if (action === "remove") {
      if (owner.reply !== "decline" || owner.removed) return { kind: "failed", error: { code: "mail.not_declined", message: "Only a current declined invitation can be removed." }, evidence };
      owner.removed = true;
    } else if (action === "restore") owner.removed = false;
    else { owner.reply = action; owner.notifications++; }
    owner.revision = String(Number(owner.revision) + 1);
    return { kind: "succeeded", output: { ref: input.invitation, revision: owner.revision }, evidence: { kind: "effect", evidenceId: randomUUID(), observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { action }, refs: [input.invitation], ownerRevision: owner.revision } };
  }

  const options: InvitationHostOptions = {
    adapterId: "mail", connectionId, account: "account-example", get journal() { return store.journal; }, index,
    capability: id => registry.capability(id), now: () => clock,
    refreshInvitation: selection => { refreshes.push(selection.invitationId); return Promise.resolve(); },
    authority: {
      findGrant: id => Promise.resolve(grants.find(grant => grant.capabilityIds.includes(id))?.id ?? null),
      grant: capabilityIds => { if (denyGrant) return Promise.resolve(null); const id = randomUUID(); grants.push({ id, capabilityIds: [...capabilityIds] }); return Promise.resolve(id); },
      approve: async (input, grantId) => {
        if (denyApproval) return { kind: "denied", reason: { code: "authority_denied", message: "The host denied this operation." } };
        const approved: Authority = { ...authority, basis: grantId ? { kind: "grant", grantId, grantRevision: "1" } : authority.basis };
        await store.journal.approve({ ...input, authority: approved, at: AT });
        return { kind: "allowed", authority: approved };
      },
    },
    dispatch: async operationId => {
      const stored = await store.journal.read(operationId);
      if (!stored || "kind" in stored.journal.snapshot) throw new Error("Expected an approved invitation operation.");
      const approved = stored.journal.events[0]?.event;
      if (approved?.kind !== "approved") throw new Error("Expected authority evidence.");
      const attempt = { ...attemptFixture(), authority: approved.authority };
      const ownerSupport = { ...support, adapterId: options.adapterId, connectionId, capabilityId: stored.journal.snapshot.capabilityId, conditionalUpdate: "owner-enforced" as const };
      const prepared = await store.journal.append(operationId, stored.revision, eventFixture(2, { kind: "attempt-prepared", attempt }), { support: ownerSupport });
      const request: DispatchRequest = { lifecycleVersion: "1.0.0", operationId, attemptId: attempt.attemptId, idempotencyKey: stored.journal.idempotencyKey, ownerRequestId: stored.journal.ownerRequestId, snapshot: stored.journal.snapshot, authority: attempt.authority, supportDeclarationId: support.declarationId, deadlineAt: attempt.deadlineAt };
      await store.journal.receive(operationId, prepared.revision, { lifecycleVersion: "1.0.0", operationId, attemptId: attempt.attemptId, snapshotDigest: request.snapshot.digest, resultId: randomUUID(), reportedAt: AT, result: binding(request) }, AT);
    },
  };
  return {
    host: new MailInvitationHost(options), options, owner, calls, grants, ids, refreshes,
    journal: () => store.journal,
    advance: (ms: number) => { clock += ms; },
    denyApproval: () => { denyApproval = true; }, denyGrant: () => { denyGrant = true; },
    revoke: () => { grants.splice(0); },
    reopen: async () => { await store.close(); store = await openJournalFixture(join(dir, "journal.sqlite"), registry); },
    close: async () => { await store.close(); await rm(dir, { recursive: true, force: true }); },
  };
}
