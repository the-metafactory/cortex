import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConversationHost } from "../../host";
import { authorityHash, type ConnectionRecord, type PolicyInputs, type PrincipalBinding } from "../../authority-records";
import type { AuthorityBindings, TrustedConnector } from "../../authority";
import type { CreateRequest } from "../../types";
import { mailDraftWriter } from "../../../surface/mc/desk/mail-draft-conversation-writer";
import { HandledLedger } from "../../../surface/mc/desk/actions";
import type { ListedMail } from "../../../surface/mc/desk/mail-actions";
import type { DeskOptions } from "../../../surface/mc/desk/compose";
import { DomainAdapterRegistry } from "../registry";
import { fixtureBindings } from "../fixtures";
import { AT } from "../operations/fixtures";
import { OperationBridge } from "../operations/dispatch";
import { ownerResultKit, requestParts } from "../operations/owner-results";
import type { DispatchRequest, OwnerSupport } from "../operations/types";
import { writerLease } from "../operations/writer-authority";
import { syntheticWriterPlan, syntheticWriterSteps } from "../operations/writer-fixtures";
import { legacyFixture } from "../operations/legacy-fixtures";
import type { LegacyContext } from "../operations/legacy";
import { openFixtureAuthority } from "../operations/lifecycle-fixtures";
import { mailAccountRef } from "./move-contract";
import { createMailReplyDraftFacade, MAIL_REPLY_DRAFT_CAPABILITY, type MailReplyDraftConnection } from "./reply-draft-host";

import { mailReplyDraftDeclaration } from "./reply-draft-contract";

export const DRAFT_CONNECTION_ID = "mail-example";
export const DRAFT_ACCOUNT = "account-example";
export const DRAFT_MAIL: ListedMail = { kind: "mail", id: "message-example", account: DRAFT_ACCOUNT, sourceId: "source-example", from: { address: "sender@example.org" }, subject: "Example subject", receivedAt: "2026-11-01T00:00:00Z", unread: true };


export function mailDraftLegacyFixture(canonicalId = "draft-example") {
  const source = legacyFixture();
  source.proposal.type = "mail-draft";
  source.proposal.fields = { mail: "mail:message-example", body: "Original\nreply text" };
  source.record.owner = "mail-draft";
  source.record.canonicalId = canonicalId;
  delete source.record.url;
  source.createResult = { state: "created", canonicalId };
  source.readback = null;
  const mapping: LegacyContext = { owner: "mail-draft", adapterId: "mail", connectionId: DRAFT_CONNECTION_ID, capabilityId: MAIL_REPLY_DRAFT_CAPABILITY, fields: structuredClone(source.proposal.fields), destinations: [mailAccountRef("mail", DRAFT_CONNECTION_ID, DRAFT_ACCOUNT)], ...(canonicalId ? { canonicalReference: { adapterId: "mail", connectionId: DRAFT_CONNECTION_ID, objectType: "draft", canonicalId } } : {}) };
  return { source, mapping };
}

export async function openMailReplyDraftRig(conversationPolicy: "local" | "cloud" = "local") {
  const dir = await mkdtemp(join(tmpdir(), "mail-reply-draft-"));
  const registry = new DomainAdapterRegistry();
  const declaration = mailReplyDraftDeclaration();
  const registered = registry.register(declaration, fixtureBindings(declaration));
  if (!registered.ok) throw new Error(registered.error.code);
  const open = async () => {
    const opened = await openConversationHost({ dir, stack: "test", label: "test", expectedLabel: "test", lanes: {}, turns: request => Promise.resolve({ text: "fixture", session: request.session, resumed: false }), now: () => new Date(AT) });
    if (opened.state !== "ready") throw new Error(opened.reason);
    return opened.host;
  };
  let host = await open();
  const principal: PrincipalBinding = { version: 1, status: "active", principalRef: randomUUID(), principal: "principal-example", stack: "test", identityBindingRevision: "1" };
  const conversation = await host.create({ title: "Fixture reply", policy: conversationPolicy, links: [], origin: { kind: "web" } }, principal.principal);
  const destination = mailAccountRef("mail", DRAFT_CONNECTION_ID, DRAFT_ACCOUNT);
  const support: OwnerSupport = { lifecycleVersion: "1.0.0", adapterId: "mail", connectionId: DRAFT_CONNECTION_ID, capabilityId: MAIL_REPLY_DRAFT_CAPABILITY, declarationId: "mail-draft-fixture-v1", dedup: { kind: "none" }, operationLookup: "none", conditionalUpdate: "none", cancellation: "none" };
  const connection: ConnectionRecord = { version: 1, status: "active", connectionId: DRAFT_CONNECTION_ID, adapterId: "mail", principalRef: principal.principalRef, connectionRevision: "1", credentialHandle: "fixture-credential", accountScope: { account: DRAFT_ACCOUNT }, readCapabilityIds: [MAIL_REPLY_DRAFT_CAPABILITY], writeCapabilityIds: [MAIL_REPLY_DRAFT_CAPABILITY], readDestinations: [destination], writeDestinations: [destination], connectorId: "fixture-mail", executionBindingRef: support.declarationId, registryRevision: "fixture-registry" };
  const policy: PolicyInputs = { version: 1, contextRevision: "1", conversationPolicy, tool: {}, communication: {}, link: {}, work: {}, history: {}, registryRevision: connection.registryRevision, executionBindingRevision: support.declarationId, operationVisible: true, readsAllowed: true, writesAllowed: true, releaseAllowed: true, allowedAudiences: ["web"] };
  const writerBinding = { stack: "test", owner: "mail-draft", adapterId: "mail", connectionId: DRAFT_CONNECTION_ID, capabilityId: MAIL_REPLY_DRAFT_CAPABILITY };
  const writers = host.lifecycleWriters();
  const planned = await writers.begin(syntheticWriterPlan(writerBinding), 0);
  const lease = writerLease(await writers.resume(planned.bindingKey, syntheticWriterSteps()));
  const calls: DispatchRequest[] = [];
  const nativeCalls: { argv: string[]; stdin: string }[] = [];
  const kit = ownerResultKit("mail");
  const connector: TrustedConnector = {
    writerOwner: "mail-draft", support,
    authorizeConnection: () => Promise.resolve({ version: 1, available: true, revision: "1" }),
    dispatch: request => {
      calls.push(request);
      return Promise.resolve(kit.succeeded(requestParts(request), { adapterId: "mail", connectionId: DRAFT_CONNECTION_ID, objectType: "draft", canonicalId: "draft-example" }, { account: DRAFT_ACCOUNT, id: "draft-example" }, AT));
    },
  };
  const bindings: AuthorityBindings = {
    currentRevision: () => authorityHash({ policy, connection }),
    authenticate: sessionRef => Promise.resolve(sessionRef === "fixture-session" ? { principal: principal.principal, stack: principal.stack, conversationId: conversation.id, authenticatedSessionRef: sessionRef, transport: "web", audience: "web", expiresAt: "2026-12-01T00:00:00Z", maintenance: false } : null),
    policy: () => Promise.resolve(policy), writer: () => Promise.resolve(true),
    restrictions: new Map(), connectors: new Map([[connection.connectorId, connector]]), sinks: new Map(),
  };
  const authority = await openFixtureAuthority(host, registry, bindings, principal, connection);
  const context = await authority.authenticate("fixture-session");
  if (!context) throw new Error("Fixture authentication required.");
  const journal = host.lifecycleJournal(registry);
  const bridge = new OperationBridge({ journal, authority, writers, supportFor: () => support, now: () => new Date(AT) });
  if (!await bridge.activate(writerBinding, lease)) throw new Error("Fixture lifecycle activation required.");
  const listed = { ...DRAFT_MAIL };
  const lookupMail = () => ({ ok: true as const, mail: listed });
  const native = mailDraftWriter({ desk: () => ({ enabled: true, mailActions: { draft: ["fixture-native-draft"], timeoutSeconds: 5 } }) as DeskOptions, lookupMail, ledger: new HandledLedger(), run: (argv, stdin) => { nativeCalls.push({ argv, stdin }); return Promise.resolve({ code: 0, stdout: JSON.stringify({ id: "native-draft" }), stderr: "" }); } });
  const capability = declaration.capabilities[0];
  if (!capability) throw new Error("Fixture draft capability required.");
  const facadeConnection: MailReplyDraftConnection = { adapterId: "mail", connectionId: DRAFT_CONNECTION_ID, account: DRAFT_ACCOUNT, sourceId: DRAFT_MAIL.sourceId, capability };
  const facade = (active?: boolean, overrides: Partial<MailReplyDraftConnection> = {}) => createMailReplyDraftFacade({ native, connection: { ...facadeConnection, ...overrides }, journal, lookupMail, policy: () => Promise.resolve(conversationPolicy), authority, context, lifecycle: { dispatch: id => bridge.dispatch(context, id, lease) }, ...(active === undefined ? {} : { active }) });
  const request = (proposalId = "reply", body = "  Exact\nreply text  "): CreateRequest => { const operationId = `${conversation.id}:${proposalId}:1`; return { operationId, type: "mail-draft", fields: { mail: `mail:${listed.id}`, body }, activation: "none", provenance: { operationId, conversationId: conversation.id, proposalId, revision: 1, entryId: null, link: "?desk=conversation" }, signal: new AbortController().signal }; };
  return {
    registry, authority, context, journal, bridge, lease, connection, facadeConnection, policy, calls, nativeCalls, listed, facade, request,
    async reopen() { await host.close(); host = await open(); return { journal: host.lifecycleJournal(registry), authority: host.lifecycleAuthority(registry, bindings) }; },
    async close() { await host.close(); await rm(dir, { recursive: true, force: true }); },
  };
}
