import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DeskMailListing, DeskAdapterHost } from "../../../desk-sdk";
import { SourceCache, type DeskSourceConfig } from "../../../surface/mc/desk/sources/command";
import { resolveListedMail } from "../../../surface/mc/desk/mail-actions";
import type { AuthorityBindings, AuthorityMediator, HostContext, TrustedConnector } from "../../authority";
import { authorityHash, type ConnectionRecord, type PolicyInputs, type PrincipalBinding, type ReleaseSink } from "../../authority-records";
import { openConversationHost, type ConversationHost } from "../../host";
import type { Json } from "../operations/types";
import { canonicalWire } from "../operations/validation";
import { ReadBindings } from "../reads/bindings";
import type { QueryResult, QuerySource } from "../reads/query-types";
import type { ObjectReference } from "../types";
import type { DomainAdapterRegistry } from "../registry";
import { DeskPackageLoader } from "../package";
import { mailReadRestriction, type MailConnectionBinding } from "../mail-read";
import { withAdmittedCall } from "../package-backend";
import { deskFixturePackageId, deskFixtureSetup, deskTestWorkspace, writeDeskFixturePackage } from "./fixtures/package-fixtures";

const ADAPTER = "mail";
const CAPABILITY = "mail.listed.query";
const SOURCE = "source-example";
const OTHER_SOURCE = "source-other";
const ONE = "mail-connection-one";
const TWO = "mail-connection-two";
const ACCOUNT_ONE = "account-one";
const ACCOUNT_TWO = "account-two";
const SHARED_ID = "<shared@example.test>";
const BODY_CANARY = "BODY-CANARY-full-body-text";
const SECOND_PARAGRAPH = "SECOND-PARAGRAPH-CANARY";
const AT = "2026-11-14T08:00:00.000Z";
const LISTED_AT = Date.parse(AT);
const ref = (schemaId: string) => ({ schemaId, version: "1.0.0" });
const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, required, properties });
const mailbox = (connectionId: string): ObjectReference => ({ adapterId: ADAPTER, connectionId, objectType: "mailbox", canonicalId: "inbox" });

const declaration = {
  adapterId: ADAPTER,
  label: "Mail",
  contractRange: "^1.0.0",
  schemas: [
    { ...ref("mail.message"), schema: objectSchema({ messageId: { type: "string" }, account: { type: "string" }, from: { type: "string" }, subject: { type: "string" }, firstParagraph: { type: "string" } }, ["messageId", "account", "from", "subject", "firstParagraph"]) },
    { ...ref("mail.mailbox"), schema: objectSchema({ label: { type: "string" } }, ["label"]) },
    { ...ref("mail.listed.query.input"), schema: objectSchema({}, []) },
    { ...ref("mail.listed.query.output"), schema: objectSchema({ items: { type: "array", items: { $ref: "urn:desk-schema:mail.message:1.0.0" } }, health: { type: "string", enum: ["fresh", "stale"] } }, ["items", "health"]) },
    { ...ref("mail.error"), schema: { type: "object" } },
  ],
  objectTypes: [
    { objectType: "message", label: "Message", schemaRef: ref("mail.message"), relationships: [] },
    { objectType: "mailbox", label: "Mailbox", schemaRef: ref("mail.mailbox"), relationships: [] },
  ],
  capabilities: [
    { capabilityId: CAPABILITY, label: "Listed mail", kind: "query", objectTypes: ["message"], inputSchemaRef: ref("mail.listed.query.input"), outputSchemaRef: ref("mail.listed.query.output"), errorSchemaRef: ref("mail.error") },
  ],
};
const readBinding = { version: "1.0.0", adapterId: ADAPTER, capabilityId: CAPABILITY, mode: "query", objectType: "message", inputSchemaRef: ref("mail.listed.query.input"), outputSchemaRef: ref("mail.listed.query.output"), destinationType: "mailbox", display: { title: "/subject" }, query: { objectsPointer: "/items", aggregatePointers: ["/health"], ordering: "provider", stableSnapshot: true } };

const backendSource = [
  "const seen = globalThis.__deskMailListings ??= [];",
  "export function createDeskAdapter(host) {",
  "  globalThis.__deskMailHost = host;",
  `  return { declaration: ${JSON.stringify(declaration)}, bindings: { observations: {}, handlers: { ${JSON.stringify(CAPABILITY)}: async request => {`,
  "    const destination = request.destinations[0];",
  "    const listing = await host.mail.listed({ adapterId: destination.adapterId, connectionId: globalThis.__deskMailReadOther ?? destination.connectionId });",
  "    seen.push(listing);",
  "    if (!listing) throw new Error('mail.not_a_mail_connection');",
  "    const items = listing.mail.map(mail => ({ messageId: mail.ref.messageId, account: mail.account, from: mail.from.address, subject: mail.subject, firstParagraph: mail.firstParagraph ?? '' }));",
  `    const observedAt = listing.health.state === "fresh" ? listing.health.listedAt : ${JSON.stringify(AT)};`,
  "    return { readVersion: '1.0.0', payload: { items, health: listing.health.state }, observedAt, ordering: 'provider', snapshot: { kind: 'stable', id: `${listing.health.state}:${items.length}` },",
  `      annotations: items.map((item, position) => ({ pointer: '/items/' + position, ref: { adapterId: ${JSON.stringify(ADAPTER)}, connectionId: listing.connection.connectionId, objectType: 'message', canonicalId: item.messageId }, schemaRef: ${JSON.stringify(ref("mail.message"))}, destination, position, evidence: { evidenceId: 'mail:' + item.messageId, revision: '1', observedAt } })) };`,
  "  } } } };",
  "}",
].join("\n");

const listed = (id: string, account: string | undefined, subject: string, extra: Record<string, unknown> = {}) => ({
  kind: "mail", id, from: { name: "Sender Example", address: "sender@example.test" }, subject, receivedAt: AT, unread: true,
  firstParagraph: `\n  \nOpening line of ${subject}.\n\n${SECOND_PARAGRAPH} ${BODY_CANARY}`, ...(account === undefined ? {} : { account }), ...extra,
});
const sourceOutput: Record<string, unknown> = {
  [SOURCE]: { items: [
    listed("<one@example.test>", ACCOUNT_ONE, "Subject for account one", { body: BODY_CANARY, html: `<p>${BODY_CANARY}</p>` }),
    listed(SHARED_ID, ACCOUNT_ONE, "Shared subject seen by account one"),
    listed(SHARED_ID, ACCOUNT_TWO, "Shared subject seen by account two"),
    listed("<orphan@example.test>", undefined, "Subject with no account"),
  ] },
  [OTHER_SOURCE]: { items: [listed("<elsewhere@example.test>", ACCOUNT_ONE, "Subject from another source")] },
};
const SOURCES: DeskSourceConfig[] = [OTHER_SOURCE, SOURCE].map(id => ({ id, command: [id], everySeconds: 60, timeoutSeconds: 5 }));

const workspace = deskTestWorkspace("cortex-desk-mail-read");
const closers: (() => Promise<void>)[] = [];
const provider = { calls: 0, failing: false };
const seenListings = (): (DeskMailListing | null)[] => (globalThis as { __deskMailListings?: (DeskMailListing | null)[] }).__deskMailListings ?? [];
const packageHost = (): DeskAdapterHost => {
  const host = (globalThis as { __deskMailHost?: DeskAdapterHost }).__deskMailHost;
  if (!host) throw new Error("The fixture adapter did not receive a host.");
  return host;
};

beforeEach(() => {
  provider.calls = 0;
  provider.failing = false;
  Object.assign(globalThis, { __deskMailListings: [], __deskMailHost: undefined, __deskMailReadOther: undefined });
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await workspace.cleanup();
});

async function listedSources(): Promise<SourceCache> {
  const cache = new SourceCache(argv => {
    provider.calls++;
    if (provider.failing) return Promise.reject(new Error("synthetic provider failure"));
    return Promise.resolve(JSON.stringify(sourceOutput[argv[0] ?? ""]));
  });
  await cache.read(SOURCES, LISTED_AT);
  return cache;
}

async function failNextListing(cache: SourceCache): Promise<void> {
  provider.failing = true;
  const reread = new Promise<void>(resolve => {
    const poll = (): void => { if (cache.cached().every(reading => reading.error !== null)) resolve(); else setTimeout(poll, 1); };
    void cache.read(SOURCES, LISTED_AT + 3_600_000);
    poll();
  });
  await reread;
}

async function loadMailAdapter(cache: SourceCache, bindings: MailConnectionBinding[]): Promise<DeskPackageLoader> {
  const pkg = writeDeskFixturePackage(join(workspace.tempDir("package"), ADAPTER), { adapterId: ADAPTER, declaration, readBindings: [readBinding], draftingBindings: [], setup: deskFixtureSetup(ADAPTER), backendSource });
  const { store } = await workspace.openStore();
  const loader = new DeskPackageLoader({ bundledPackages: [pkg.dir], store, mail: { connections: () => bindings, listings: () => cache.cached() } });
  const activated = await loader.activate(deskFixturePackageId(ADAPTER));
  if (!activated.ok) throw new Error(`${activated.error.code}: ${activated.error.message}`);
  return loader;
}

interface Reader { context: HostContext; sink: ReleaseSink; sends: Json[] }
interface MailRig { host: ConversationHost; service: AuthorityMediator; registry: DomainAdapterRegistry; bindings: AuthorityBindings; local: Reader; cloud: Reader }

async function openMailRig(loader: DeskPackageLoader, mail: MailConnectionBinding[]): Promise<MailRig> {
  const dir = workspace.tempDir("rig");
  const registry = loader.registry();
  const readBindings = new ReadBindings(registry);
  const principal: PrincipalBinding = { version: 1, principalRef: randomUUID(), principal: "principal-example", stack: "mail-test", identityBindingRevision: "1", status: "active" };
  const connectors = new Map<string, TrustedConnector>();
  const connections: ConnectionRecord[] = mail.map(binding => {
    const built = loader.trustedConnector(ADAPTER, { adapterId: ADAPTER, connectionId: binding.connectionId }, { authorizeConnection: () => Promise.resolve({ version: 1, available: true, revision: "mail-credential-1" }) });
    if (!built.ok) throw new Error(built.error.code);
    const connectorId = `connector-${binding.connectionId}`;
    connectors.set(connectorId, built.value.connector);
    const registered = readBindings.register(readBinding, { adapterId: ADAPTER, connectionId: binding.connectionId, readCapabilityIds: [CAPABILITY] });
    if (!registered.ok) throw new Error(registered.error.code);
    return {
      version: 1, status: "active", connectionId: binding.connectionId, adapterId: ADAPTER, principalRef: principal.principalRef, connectionRevision: "1", credentialHandle: "synthetic-credential-handle",
      accountScope: { source: binding.sourceId, account: binding.account }, readCapabilityIds: [CAPABILITY], writeCapabilityIds: [], readDestinations: [mailbox(binding.connectionId)], writeDestinations: [],
      connectorId, executionBindingRef: built.value.connector.support.declarationId, registryRevision: "registry-1",
    };
  });
  const executionBindingRevision = connections[0]?.executionBindingRef ?? "";
  const conversations = { local: "", cloud: "" };
  const policyOf = (conversationId: string): PolicyInputs => ({
    version: 1, contextRevision: "context-1", conversationPolicy: conversationId === conversations.cloud ? "cloud" : "local", tool: {}, communication: {}, link: {}, work: {}, history: {},
    registryRevision: "registry-1", executionBindingRevision, operationVisible: true, readsAllowed: true, writesAllowed: false, releaseAllowed: true, allowedAudiences: ["web"],
  });
  const sinks = new Map<string, (value: Json) => Promise<void>>();
  const bindings: AuthorityBindings = {
    currentRevision: () => authorityHash({ connections: mail }),
    authenticate: sessionRef => {
      const conversationId = sessionRef === "local-session" ? conversations.local : sessionRef === "cloud-session" ? conversations.cloud : null;
      return Promise.resolve(conversationId ? { principal: principal.principal, stack: principal.stack, conversationId, authenticatedSessionRef: sessionRef, transport: "web", audience: "web", expiresAt: "2099-01-01T00:00:00.000Z", maintenance: false } : null);
    },
    policy: binding => Promise.resolve(policyOf(binding.conversationId)),
    writer: () => Promise.resolve(false),
    restrictions: new Map([["mail-restriction-resolver", record => Promise.resolve(record)]]),
    connectors, sinks, readBindings,
  };
  const status = await openConversationHost({ dir, stack: principal.stack, label: principal.stack, expectedLabel: principal.stack, lanes: {}, turns: request => Promise.resolve({ text: "synthetic", session: request.session, resumed: false }), now: () => new Date(AT) });
  if (status.state !== "ready") throw new Error(status.reason);
  const host = status.host;
  closers.push(() => host.close());
  const readers: Record<"local" | "cloud", { sink: ReleaseSink; sends: Json[] }> = { local: { sink: { kind: "web", conversationId: "" }, sends: [] }, cloud: { sink: { kind: "web", conversationId: "" }, sends: [] } };
  for (const policy of ["local", "cloud"] as const) {
    const conversation = await host.create({ title: `Mail ${policy}`, policy, links: [], origin: { kind: "web" } }, principal.principal);
    conversations[policy] = conversation.id;
    const held = readers[policy];
    held.sink = { kind: "web", conversationId: conversation.id };
    sinks.set(canonicalWire(held.sink), value => { held.sends.push(value); return Promise.resolve(); });
  }
  const service = host.lifecycleAuthority(registry, bindings);
  await service.publishHostRecord({ kind: "principal", value: principal }, 0);
  for (const connection of connections) await service.publishHostRecord({ kind: "connection", value: connection }, 0);
  for (const binding of mail) {
    const restriction = mailReadRestriction(binding, mailbox(binding.connectionId), { version: 1, status: "active", restrictionRef: randomUUID(), ownerRevision: "mail-owner-1", decisionRef: "mail-provenance", audiences: ["web"], readScope: [principal.principalRef], resolverBinding: "mail-restriction-resolver", revision: "1" });
    await service.publishHostRecord({ kind: "restriction", value: restriction }, 0);
  }
  const reader = async (policy: "local" | "cloud"): Promise<Reader> => {
    const context = await service.authenticate(`${policy}-session`);
    if (!context) throw new Error(`The ${policy} session was refused.`);
    return { context, ...readers[policy] };
  };
  return { host, service, registry, bindings, local: await reader("local"), cloud: await reader("cloud") };
}

const sourceFor = (connectionId: string): QuerySource => ({ adapterId: ADAPTER, connectionId, capabilityId: CAPABILITY, inputSchemaRef: readBinding.inputSchemaRef, destinations: [mailbox(connectionId)], input: {} });

async function query(rig: MailRig, reader: Reader, connectionIds: string[]): Promise<QueryResult> {
  const runner = rig.host.readQueries(rig.registry, rig.bindings);
  const request = await runner.create(reader.context, connectionIds.map(sourceFor), reader.sink);
  return runner.run(reader.context, request, reader.sink);
}

const bindingOne: MailConnectionBinding = { adapterId: ADAPTER, connectionId: ONE, sourceId: SOURCE, account: ACCOUNT_ONE };
const bindingTwo: MailConnectionBinding = { adapterId: ADAPTER, connectionId: TWO, sourceId: SOURCE, account: ACCOUNT_TWO };
const released = (reader: Reader): string => JSON.stringify(reader.sends);
const listedIn = (connectionId: string, target = connectionId): Promise<DeskMailListing | null> =>
  withAdmittedCall({ adapterId: ADAPTER, connectionId }, () => packageHost().mail.listed({ adapterId: ADAPTER, connectionId: target }));

async function openListedRig(mail: MailConnectionBinding[] = [bindingOne, bindingTwo]): Promise<{ cache: SourceCache; rig: MailRig }> {
  const cache = await listedSources();
  const loader = await loadMailAdapter(cache, mail);
  return { cache, rig: await openMailRig(loader, mail) };
}

describe("the Desk adapter host's Mail read bridge", () => {
  test("supplies only the mail its source listed for that connection, with the connection's account and no body", async () => {
    const { cache, rig } = await openListedRig();

    const result = await query(rig, rig.local, [ONE]);

    expect(result.status).toBe("ok");
    const [listing] = seenListings();
    expect(listing?.connection).toEqual({ adapterId: ADAPTER, connectionId: ONE });
    expect(listing?.account).toBe(ACCOUNT_ONE);
    expect(listing?.health).toEqual({ state: "fresh", listedAt: AT });
    expect(listing?.mail.map(mail => mail.ref)).toEqual([{ connection: ONE, messageId: "<one@example.test>" }, { connection: ONE, messageId: SHARED_ID }]);
    expect(listing?.mail.every(mail => mail.account === ACCOUNT_ONE)).toBe(true);
    expect(listing?.mail[0]?.firstParagraph).toBe("Opening line of Subject for account one.");
    const handed = JSON.stringify(listing);
    for (const absent of [BODY_CANARY, SECOND_PARAGRAPH, "Subject from another source", "Subject with no account", "Shared subject seen by account two", "body", "html"]) expect(handed).not.toContain(absent);
    expect(released(rig.local)).toContain("Subject for account one");
    expect(released(rig.local)).not.toContain(BODY_CANARY);
  });

  test("does not supply listed mail that names no account", async () => {
    const cache = await listedSources();
    const unbound = await loadMailAdapter(cache, [{ ...bindingOne, account: "" }]);
    expect(await listedIn(ONE)).toBeNull();
    await unbound.disable(ADAPTER);

    await loadMailAdapter(cache, [bindingOne, bindingTwo]);
    const lists = await Promise.all([ONE, TWO].map(connectionId => listedIn(connectionId)));
    const ids = lists.flatMap(listing => listing?.mail.map(mail => mail.ref.messageId) ?? []);
    expect(ids).not.toContain("<orphan@example.test>");
    expect(cache.cached().find(reading => reading.id === SOURCE)?.mail.some(mail => mail.id === "<orphan@example.test>" && mail.account === undefined)).toBe(true);
  });

  test("supplies the same Message-ID under two connections as two separate entries", async () => {
    const { cache, rig } = await openListedRig();

    const result = await query(rig, rig.local, [ONE, TWO]);

    expect(result.status).toBe("ok");
    expect(result.groups.map(group => group.source.connectionId).sort()).toEqual([ONE, TWO]);
    const shared = seenListings().flatMap(listing => listing?.mail.filter(mail => mail.ref.messageId === SHARED_ID) ?? []);
    expect(shared.map(mail => [mail.ref.connection, mail.account, mail.subject]).sort()).toEqual([
      [ONE, ACCOUNT_ONE, "Shared subject seen by account one"],
      [TWO, ACCOUNT_TWO, "Shared subject seen by account two"],
    ]);
    expect(released(rig.local)).toContain("Shared subject seen by account one");
    expect(released(rig.local)).toContain("Shared subject seen by account two");
  });

  test("treats a connection with no explicit policy as local and denies a cloud reader with no name or count", async () => {
    const { rig } = await openListedRig([bindingOne, { ...bindingTwo, dataPolicy: "cloud" }]);

    const denied = await query(rig, rig.cloud, [ONE]);

    expect(denied).toEqual({ readVersion: "1.0.0", queryId: denied.queryId, status: "denied", groups: [], restricted: true, noMatch: false });
    expect(seenListings()).toHaveLength(0);
    expect(rig.cloud.sends).toHaveLength(0);
    const explicit = await query(rig, rig.cloud, [TWO]);
    expect(explicit.status).toBe("ok");
    expect(released(rig.cloud)).toContain("Shared subject seen by account two");
  });

  test("reports a connection stale on a provider failure and reports nothing deleted", async () => {
    const { cache, rig } = await openListedRig();
    const before = await listedIn(ONE);

    await failNextListing(cache);
    const result = await query(rig, rig.local, [ONE]);

    expect(result.status).toBe("ok");
    const after = seenListings().at(-1);
    expect(after?.health).toEqual({ state: "stale", code: "provider_failure" });
    expect(after?.mail).toEqual(before?.mail ?? []);
    expect(JSON.stringify(after)).not.toContain("synthetic provider failure");
    expect(released(rig.local)).toContain("\"stale\"");
  });

  test("reports a connection whose source has not listed yet as stale with no mail", async () => {
    const empty = new SourceCache(() => Promise.resolve("{}"));
    await loadMailAdapter(empty, [bindingOne]);
    expect(await listedIn(ONE)).toEqual({ connection: { adapterId: ADAPTER, connectionId: ONE }, account: ACCOUNT_ONE, health: { state: "stale", code: "not_listed" }, mail: [] });
  });

  test("serves no connection of another adapter and refuses once the generation is disabled", async () => {
    const cache = await listedSources();
    const loader = await loadMailAdapter(cache, [bindingOne, { ...bindingTwo, adapterId: "other-adapter" }]);
    const host = packageHost();
    expect(await withAdmittedCall({ adapterId: "other-adapter", connectionId: TWO }, () => host.mail.listed({ adapterId: "other-adapter", connectionId: TWO }))).toBeNull();
    expect(await listedIn(TWO)).toBeNull();
    expect(host.sdkVersion).toBe("1.5.0");

    await loader.disable(ADAPTER);

    await expect(listedIn(ONE)).rejects.toMatchObject({ error: { code: "adapter_unavailable" } });
  });

  test("serves a connection's mail only inside a call admitted for that same connection", async () => {
    const { rig } = await openListedRig([bindingOne, { ...bindingTwo, dataPolicy: "cloud" }]);
    await expect(packageHost().mail.listed({ adapterId: ADAPTER, connectionId: ONE })).rejects.toMatchObject({ error: { code: "mail_read_unadmitted" } });
    await expect(listedIn(TWO, ONE)).rejects.toMatchObject({ error: { code: "mail_read_unadmitted" } });
    Object.assign(globalThis, { __deskMailReadOther: ONE });

    const result = await query(rig, rig.cloud, [TWO]);

    expect(result.status).toBe("unavailable");
    expect(seenListings()).toHaveLength(0);
    expect(rig.cloud.sends).toHaveLength(0);
  });

  test("leaves the native Mail listing unchanged and runs no provider call", async () => {
    const cache = await listedSources();
    const native = structuredClone(cache.cached());
    const lookup = resolveListedMail(cache.cached(), `mail:${SHARED_ID}`);
    const callsBefore = provider.calls;
    const loader = await loadMailAdapter(cache, [bindingOne, bindingTwo]);
    const rig = await openMailRig(loader, [bindingOne, bindingTwo]);

    await query(rig, rig.local, [ONE, TWO]);
    const listing = await listedIn(ONE);
    const first = listing?.mail[0] as { subject: string } | undefined;
    if (first) first.subject = "changed by the adapter";

    expect(provider.calls).toBe(callsBefore);
    expect(cache.cached()).toEqual(native);
    expect(resolveListedMail(cache.cached(), `mail:${SHARED_ID}`)).toEqual(lookup);
  });
});
