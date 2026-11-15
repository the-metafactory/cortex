import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AT, openJournalFixture } from "../operations/fixtures";
import type { DispatchRequest, OwnerResult } from "../operations/types";
import { MAIL_RESTORE_CAPABILITY } from "./move-contract";
import { createOperationIndex, deliver, fixtureAuthority, prepareDispatch, registerFixtureDeclaration } from "./host-fixtures";
import { MAIL_REPORT_CAPABILITY, MAIL_REPORT_KINDS, mailReportDeclaration, type MailReportKind } from "./report-contract";
import { MailReportHost, type ReportOutcome } from "./report-host";

export const REPORT_BINDING = { adapterId: "mail", connectionId: "mail-example", account: "account-example" };
export const REPORT_PROVENANCE = { conversationId: "conversation-example", proposalId: "mail-report", revision: 1, entryId: null, link: "?desk=mail" };
export const reportReceipt = (outcome: ReportOutcome) => {
  if (outcome.kind !== "receipt") throw new Error(`Expected a report receipt, got ${outcome.kind}.`);
  return outcome.receipt;
};

type Choice = "always" | "once" | "cancel";

const refused = (request: DispatchRequest, code: string, message: string): OwnerResult["result"] => ({ kind: "failed", error: { code, message }, evidence: { kind: "no-effect", evidenceId: `no-effect:${request.attemptId}`, observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { refused: true }, final: true } });

export async function openMailReportRig(options: { kinds?: readonly MailReportKind[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "mail-report-"));
  const registry = registerFixtureDeclaration(mailReportDeclaration("mail", options.kinds ?? MAIL_REPORT_KINDS));
  let fixture = await openJournalFixture(join(directory, "journal.sqlite"), registry);
  const now = Date.parse(AT);
  const folders = new Map([["message-example", "INBOX"]]);
  const submitted: { messageId: string; kind: string }[] = [];
  const drafts: string[] = [];
  let denied = false;
  const auth = fixtureAuthority(() => fixture.journal, () => now, () => denied);
  const calls: DispatchRequest[] = [];
  const index = createOperationIndex();
  const binding = (request: DispatchRequest): OwnerResult["result"] => {
    const { message, from } = request.snapshot.input as { message: { canonicalId: string }; from?: string };
    const id = message.canonicalId;
    const ref = { adapterId: REPORT_BINDING.adapterId, connectionId: REPORT_BINDING.connectionId, objectType: "message", canonicalId: id };
    if (request.snapshot.destinations[0]?.canonicalId !== REPORT_BINDING.account) return refused(request, "mail.account_denied", "This account is not available to the connection.");
    const current = folders.get(id);
    if (current === undefined) return refused(request, "mail.message_missing", "The message no longer exists.");
    const capabilityId = request.snapshot.capabilityId;
    if (capabilityId === MAIL_RESTORE_CAPABILITY) {
      if (current !== from) return { kind: "conflict", error: { code: "mail.location_conflict", message: `The message is now in ${current}, not ${from}.` }, currentOwnerRevision: current, evidence: { kind: "no-effect", evidenceId: `conflict:${request.attemptId}`, observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { current }, final: true } };
      folders.set(id, "INBOX");
    } else if (capabilityId === MAIL_REPORT_CAPABILITY.draft) {
      drafts.push(id);
      return { kind: "succeeded", output: { ref, folder: "Drafts" }, evidence: { kind: "effect", evidenceId: `effect:${request.attemptId}`, observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { drafted: id }, refs: [ref] } };
    } else {
      submitted.push({ messageId: id, kind: capabilityId === MAIL_REPORT_CAPABILITY.phishing ? "phishing" : "spam" });
      folders.set(id, "Junk");
    }
    const folder = folders.get(id) ?? "INBOX";
    return { kind: "succeeded", output: { ref, folder }, evidence: { kind: "effect", evidenceId: `effect:${request.attemptId}`, observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { moved: folder }, refs: [ref] } };
  };
  const dispatch = async (operationId: string): Promise<void> => {
    const prepared = await prepareDispatch(fixture.journal, operationId, { connectionId: REPORT_BINDING.connectionId, declarationId: "mail-report-owner", expected: "a report", now });
    calls.push(prepared.request);
    await deliver(fixture.journal, prepared, binding(prepared.request));
  };
  const makeHost = (account: string, clock: () => number = () => now) => new MailReportHost({ ...REPORT_BINDING, account, journal: fixture.journal, index, authority: auth.port, capability: id => registry.capability(id), dispatch, now: clock });
  let clock = () => now;
  let host = makeHost(REPORT_BINDING.account);
  return {
    get host() { return host; }, get journal() { return fixture.journal; },
    folders, submitted, drafts, grants: auth.grants, approvals: auth.approvals, calls, operations: index.operations,
    press(kind: MailReportKind, messageId: string, choice?: Choice) { return host.press(kind, messageId, REPORT_PROVENANCE, choice); },
    pressAs(account: string, kind: MailReportKind, messageId: string, choice?: Choice) { return makeHost(account).press(kind, messageId, REPORT_PROVENANCE, choice); },
    undo(operationId: string) { return host.undo(operationId, REPORT_PROVENANCE); },
    moveElsewhere(id: string, folder: string) { folders.set(id, folder); },
    removeMessage(id: string) { folders.delete(id); },
    advance(ms: number) { const at = now + ms; clock = () => at; host = makeHost(REPORT_BINDING.account, clock); },
    deny() { denied = true; }, allow() { denied = false; },
    async reopen() { await fixture.close(); fixture = await openJournalFixture(join(directory, "journal.sqlite"), registry); host = makeHost(REPORT_BINDING.account, clock); },
    async close() { await fixture.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
