import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AT, openJournalFixture } from "../operations/fixtures";
import type { DispatchRequest, OwnerResult } from "../operations/types";
import type { OperationIndex } from "./legacy-move";
import { mailMoveDeclaration } from "./move-contract";
import { deliver, fixtureAuthority, prepareDispatch, registerFixtureDeclaration } from "./host-fixtures";
import { mailUnsubscribeDeclaration } from "./unsubscribe-contract";
import { MailUnsubscribeHost, type UnsubscribeOutcome } from "./unsubscribe-host";

export const UNSUBSCRIBE_BINDING = { adapterId: "mail", connectionId: "mail-example", account: "account-example" };
export const UNSUBSCRIBE_PROVENANCE = { conversationId: "conversation-example", proposalId: "mail-unsubscribe", revision: 1, entryId: null, link: "?desk=mail" };
export const unsubscribeMessage = (canonicalId = "message-example") => ({ adapterId: UNSUBSCRIBE_BINDING.adapterId, connectionId: UNSUBSCRIBE_BINDING.connectionId, objectType: "message", canonicalId });
export const unsubscribeReceipt = (outcome: UnsubscribeOutcome) => {
  if (outcome.kind !== "receipt") throw new Error(`Expected an unsubscribe receipt, got ${outcome.kind}.`);
  return outcome.receipt;
};

const noEffect = (request: DispatchRequest, code: string, message: string): OwnerResult["result"] => ({ kind: "failed", error: { code, message }, evidence: { kind: "no-effect", evidenceId: `no-effect:${request.attemptId}`, observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { refused: true }, final: true } });

export async function openMailUnsubscribeRig(options: { declaresUnsubscribe?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "mail-unsubscribe-"));
  const registry = registerFixtureDeclaration(options.declaresUnsubscribe === false ? mailMoveDeclaration("mail", []) : mailUnsubscribeDeclaration("mail"));
  let fixture = await openJournalFixture(join(directory, "journal.sqlite"), registry);
  const now = Date.parse(AT);
  const lists = new Map([["message-example", "list.example.org"]]);
  const posts: string[] = [];
  let denied = false;
  const auth = fixtureAuthority(() => fixture.journal, () => now, () => denied);
  const calls: DispatchRequest[] = [];
  const ids: string[] = [];
  const index: OperationIndex = {
    add(id) { if (!ids.includes(id)) ids.push(id); return Promise.resolve(); },
    list() { return Promise.resolve([...ids]); },
    compensations() { return Promise.resolve([]); },
  };
  const binding = (request: DispatchRequest): OwnerResult["result"] => {
    const input = request.snapshot.input as { message: { canonicalId: string } };
    const id = input.message.canonicalId;
    if (request.snapshot.destinations[0]?.canonicalId !== UNSUBSCRIBE_BINDING.account) return noEffect(request, "mail.account_denied", "This account is not available to the connection.");
    const host = lists.get(id);
    if (!host) return noEffect(request, "mail.message_missing", "The message no longer exists.");
    posts.push(host);
    const message = { adapterId: UNSUBSCRIBE_BINDING.adapterId, connectionId: UNSUBSCRIBE_BINDING.connectionId, objectType: "message", canonicalId: id };
    return { kind: "succeeded", output: { ref: message, host }, evidence: { kind: "effect", evidenceId: `effect:${request.attemptId}`, observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { unsubscribed: host }, refs: [message] } };
  };
  const dispatch = async (operationId: string): Promise<void> => {
    const prepared = await prepareDispatch(fixture.journal, operationId, { connectionId: UNSUBSCRIBE_BINDING.connectionId, declarationId: "mail-unsubscribe-owner", expected: "an unsubscribe", now });
    calls.push(prepared.request);
    await deliver(fixture.journal, prepared, binding(prepared.request));
  };
  const makeHost = (account: string) => new MailUnsubscribeHost({ ...UNSUBSCRIBE_BINDING, account, journal: fixture.journal, index, authority: auth.port, capability: id => registry.capability(id), dispatch, now: () => now });
  let host = makeHost(UNSUBSCRIBE_BINDING.account);
  const pressWith = (target: MailUnsubscribeHost, messageId: string, choice?: "always" | "once" | "cancel") => target.press({ message: unsubscribeMessage(messageId) }, UNSUBSCRIBE_PROVENANCE, choice);
  return {
    get host() { return host; }, get journal() { return fixture.journal; },
    lists, posts, grants: auth.grants, approvals: auth.approvals, calls, index, ids,
    press(messageId: string, choice?: "always" | "once" | "cancel") { return pressWith(host, messageId, choice); },
    pressAs(account: string, messageId: string, choice?: "always" | "once" | "cancel") { return pressWith(makeHost(account), messageId, choice); },
    removeMessage(id: string) { lists.delete(id); },
    deny() { denied = true; }, allow() { denied = false; },
    async reopen() { await fixture.close(); fixture = await openJournalFixture(join(directory, "journal.sqlite"), registry); host = makeHost(UNSUBSCRIBE_BINDING.account); },
    async close() { await fixture.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
