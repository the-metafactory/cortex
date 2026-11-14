import { randomUUID } from "node:crypto";
import { authority, attemptFixture, eventFixture } from "../operations/fixtures";
import type { OperationJournalStore } from "../operations/journal";
import type { DispatchRequest, OwnerSupport } from "../operations/types";
import type { MailMoveAuthority } from "./move-host";

export interface FixtureGrant {
  id: string;
  capabilities: readonly string[];
}

export interface FixtureAuthority {
  grants: FixtureGrant[];
  approvals: (string | null)[];
  port: MailMoveAuthority;
}

/** A synthetic authority port: grants and approvals are recorded, and `denied` revokes every later approval. */
export function fixtureAuthority(journal: () => OperationJournalStore, now: () => number, denied: () => boolean = () => false): FixtureAuthority {
  const grants: FixtureGrant[] = [];
  const approvals: (string | null)[] = [];
  const port: MailMoveAuthority = {
    findGrant(capability) { return Promise.resolve(grants.find(grant => grant.capabilities.includes(capability))?.id ?? null); },
    grant(capabilities) { const id = randomUUID(); grants.push({ id, capabilities }); return Promise.resolve(id); },
    async approve(input, grantId) {
      if (denied()) return { kind: "denied", reason: { code: "authority_denied", message: "Permission revoked." } };
      approvals.push(grantId);
      const approved = { ...authority, basis: grantId ? { kind: "grant" as const, grantId, grantRevision: "1" } : authority.basis };
      await journal().approve({ ...input, authority: approved, at: new Date(now()).toISOString() });
      return { kind: "allowed", authority: approved };
    },
  };
  return { grants, approvals, port };
}

export interface PreparedDispatch {
  request: DispatchRequest;
  support: OwnerSupport;
  at: string;
  revision: number;
}

/** Reads one approved operation, appends its first attempt and returns the exact dispatch request the binding must answer. */
export async function prepareDispatch(journal: OperationJournalStore, operationId: string, options: { connectionId: string; declarationId: string; expected: string; now: number }): Promise<PreparedDispatch> {
  const stored = await journal.read(operationId);
  if (!stored || "kind" in stored.journal.snapshot) throw new Error(`Expected ${options.expected} snapshot.`);
  const approved = stored.journal.events[0]?.event;
  if (approved?.kind !== "approved") throw new Error("Expected approval evidence.");
  const support: OwnerSupport = { lifecycleVersion: "1.0.0", adapterId: "mail", connectionId: options.connectionId, capabilityId: stored.journal.snapshot.capabilityId, declarationId: options.declarationId, dedup: { kind: "guaranteed", scope: "connection-capability", retentionMs: 604800000, bindsSnapshot: true, concurrent: true }, operationLookup: "none", conditionalUpdate: "none", cancellation: "none" };
  const at = new Date(options.now).toISOString();
  const attempt = { ...attemptFixture(), authority: approved.authority, supportDeclarationId: support.declarationId, preparedAt: at, deadlineAt: new Date(options.now + 30_000).toISOString(), dedupValidUntil: new Date(options.now + 604800000).toISOString() };
  const prepared = await journal.append(operationId, stored.revision, eventFixture(2, { kind: "attempt-prepared", attempt }, at), { support });
  const request: DispatchRequest = { lifecycleVersion: "1.0.0", operationId, attemptId: attempt.attemptId, idempotencyKey: stored.journal.idempotencyKey, ownerRequestId: stored.journal.ownerRequestId, snapshot: stored.journal.snapshot, authority: approved.authority, supportDeclarationId: support.declarationId, deadlineAt: attempt.deadlineAt };
  return { request, support, at, revision: prepared.revision };
}
