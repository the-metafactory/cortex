import { syntheticWriterPlan, syntheticWriterSteps } from "./domain-adapters/operations/writer-fixtures";
import { writerLease } from "./domain-adapters/operations/writer-authority";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConversationHost, type ConversationHost, type HostOptions } from "./host";
import { authorityHash } from "./authority-records";
import { type AuthorityBindings, type WriterLease } from "./authority";
import type { ConnectionRecord, PolicyInputs, PrincipalBinding, ReleaseSink, RestrictionRecord } from "./authority-records";
import { AT, approvalFixture, eventFixture, registryFixture, resultFixture, support } from "./domain-adapters/operations/fixtures";
import type { Attempt, CancelRequest, DispatchRequest, Json } from "./domain-adapters/operations/types";
import { snapshotDigest, canonicalWire } from "./domain-adapters/operations/validation";

function requireValue<T>(value: T | null | undefined): T { if (value === null || value === undefined) throw new Error("Synthetic authority fixture is incomplete."); return value; }

export async function authorityRig(extra: Partial<HostOptions> = {}, conversationPolicy: "local" | "cloud" = "local") {
  const dir = await mkdtemp(join(tmpdir(), "host-authority-"));
  const registry = registryFixture();
  const principal: PrincipalBinding = { version: 1, principalRef: randomUUID(), principal: "principal-example", stack: "test", identityBindingRevision: "1", status: "active" };
  const approval = approvalFixture();
  const connection: ConnectionRecord = { version: 1, status: "active", connectionId: approval.snapshot.connectionId, adapterId: "balance", principalRef: principal.principalRef, connectionRevision: "1", credentialHandle: "synthetic-credential-handle", accountScope: { account: "synthetic-account", resource: "area-example" }, readCapabilityIds: [approval.snapshot.capabilityId, "balance.object.read"], writeCapabilityIds: [approval.snapshot.capabilityId], readDestinations: approval.snapshot.destinations, writeDestinations: approval.snapshot.destinations, connectorId: "synthetic-connector", executionBindingRef: support.declarationId, registryRevision: "registry-1" };
  const policy: PolicyInputs = { version: 1, contextRevision: "context-1", areaId: "area-example", conversationPolicy, tool: {}, communication: {}, link: {}, work: {}, history: {}, registryRevision: "registry-1", executionBindingRevision: support.declarationId, operationVisible: true, readsAllowed: true, writesAllowed: true, releaseAllowed: true, allowedAudiences: ["web", "discord", "model", "view"] };
  const objectRestriction: RestrictionRecord = { version: 1, status: "active", restrictionRef: randomUUID(), source: requireValue(approval.snapshot.destinations[0]), ownerRevision: "synthetic-owner-1", decisionRef: "synthetic-object-provenance", audiences: ["web", "discord", "model", "view"], egress: "cloud", readScope: [principal.principalRef], resolverBinding: "synthetic-restriction-resolver", revision: "1" };
  const lease: WriterLease = { bindingKey: "synthetic-binding", epoch: 1, instanceId: "synthetic-instance", supervisorReceiptRef: "synthetic-supervisor" };
  const calls = { dispatch: 0, cancel: 0, lookup: 0, readback: 0, sends: [] as Json[], signals: [] as AbortSignal[] };
  const hooks: { policy?: () => Promise<void>; dispatch?: (request: DispatchRequest) => Promise<unknown>; sink?: () => Promise<void>; lookup?: () => Promise<unknown>; readback?: () => Promise<unknown>; cancel?: (request: CancelRequest) => Promise<unknown>; writer?: () => Promise<boolean>; restriction?: (record: RestrictionRecord) => Promise<RestrictionRecord | null>; sessionEnabled?: boolean; credentialsAvailable?: boolean } = {};
  let conversationId = "";
  let attempt: Attempt | undefined;
  const sinks = new Map<string, (value: Json) => Promise<void>>();
  const bindings: AuthorityBindings = {
    currentRevision: () => authorityHash({ policy, sessionEnabled: hooks.sessionEnabled ?? true, credentialsAvailable: hooks.credentialsAvailable ?? true, lease }),
    authenticate: sessionRef => Promise.resolve(hooks.sessionEnabled === false ? null : sessionRef === "authenticated-session" ? { principal: principal.principal, stack: principal.stack, conversationId, authenticatedSessionRef: sessionRef, transport: "web", audience: "web", expiresAt: "2026-12-01T00:00:00.000Z", maintenance: false } : sessionRef === "discord-session" ? { principal: principal.principal, stack: principal.stack, conversationId, authenticatedSessionRef: sessionRef, transport: "discord", audience: "discord", expiresAt: "2026-12-01T00:00:00.000Z", maintenance: false } : sessionRef === "model-session" ? { principal: principal.principal, stack: principal.stack, conversationId, authenticatedSessionRef: sessionRef, transport: "web", audience: "model", route: "cloud", expiresAt: "2026-12-01T00:00:00.000Z", maintenance: false } : null),
    policy: async () => { await hooks.policy?.(); return structuredClone(policy); },
    writer: async checked => hooks.writer ? hooks.writer() : canonicalWire(checked) === canonicalWire(lease),
    restrictions: new Map([["synthetic-restriction-resolver", record => hooks.restriction ? hooks.restriction(record) : Promise.resolve(record)]]),
    connectors: new Map([[connection.connectorId, { writerOwner: "synthetic-owner", authorizeConnection: current => Promise.resolve({ version: 1, available: hooks.credentialsAvailable !== false && current.credentialHandle === "synthetic-credential-handle" && canonicalWire(current.accountScope) === canonicalWire({ account: "synthetic-account", resource: "area-example" }), revision: "synthetic-credential-1" }), support: { ...support, cancellation: "best-effort", operationLookup: "historical" },
      dispatch: async (request, signal) => { calls.dispatch++; calls.signals.push(signal); return hooks.dispatch ? hooks.dispatch(request) : resultFixture({ ...approval, authority: request.authority }, requireValue(attempt), "succeeded"); },
      cancel: (request, signal) => { calls.cancel++; calls.signals.push(signal); return hooks.cancel ? hooks.cancel(request) : Promise.resolve(resultFixture(approval, requireValue(attempt), "succeeded")); },
      lookup: async () => { calls.lookup++; return hooks.lookup ? hooks.lookup() : { lifecycleVersion: "1.0.0", operationId: approval.operationId, checkedAt: AT, result: { kind: "unknown", reason: { code: "synthetic_unknown", message: "No historical evidence." } } }; },
      readbackCapabilityId: "balance.object.read", readback: async request => { calls.readback++; return hooks.readback ? hooks.readback() : { lifecycleVersion: "1.0.0", ref: request.ref, checkedAt: AT, provenance: { adapterId: "balance", connectionId: connection.connectionId, evidenceId: "synthetic-read" }, result: { kind: "unknown", reason: { code: "synthetic_unknown", message: "Current object unknown." } } }; },
    }]]), sinks,
  };
  async function open(): Promise<ConversationHost> {
    const status = await openConversationHost({ dir, stack: "test", label: "test", expectedLabel: "test", lanes: {}, turns: request => Promise.resolve({ text: "synthetic", session: request.session, resumed: false }), now: () => new Date(AT), ...extra });
    if (status.state !== "ready") throw new Error(status.reason);
    return status.host;
  }
  let host = await open();
  const conversation = await host.create({ title: "Synthetic authority", policy: conversationPolicy, links: [], origin: { kind: "web" } }, principal.principal);
  conversationId = conversation.id;
  approval.operationId = `${conversationId}:proposal-example:1`;
  approval.idempotencyKey = approval.operationId;
  approval.snapshot.provenance.conversationId = conversationId;
  approval.snapshot.digest = snapshotDigest(approval.snapshot);
  const sink: ReleaseSink = { kind: "web", conversationId };
  for (const item of [sink, { kind: "discord" as const, conversationId }, { kind: "model" as const, conversationId, route: "cloud" }]) sinks.set(canonicalWire(item), async value => { calls.sends.push(value); await hooks.sink?.(); });
  const writerPlan = syntheticWriterPlan({ stack: principal.stack, owner: "synthetic-owner", adapterId: approval.snapshot.adapterId, connectionId: approval.snapshot.connectionId, capabilityId: approval.snapshot.capabilityId });
  const writer = await host.lifecycleWriters().begin(writerPlan, 0);
  Object.assign(lease, writerLease(await host.lifecycleWriters().resume(writer.bindingKey, syntheticWriterSteps())));
  let service = host.lifecycleAuthority(registry, bindings);
  await service.publishHostRecord({ kind: "principal", value: principal }, 0);
  await service.publishHostRecord({ kind: "connection", value: connection }, 0);
  await service.publishHostRecord({ kind: "restriction", value: objectRestriction }, 0);
  let context = requireValue(await service.authenticate("authenticated-session"));
  const input = () => ({ operationId: approval.operationId, idempotencyKey: approval.idempotencyKey, ownerRequestId: approval.ownerRequestId, snapshot: approval.snapshot });
  const rig = {
    get host() { return host; }, get service() { return service; }, get context() { return context; }, registry, principal, connection, objectRestriction, approval, policy, lease, calls, hooks, sink, dir, bindings,
    confirm: () => service.confirm(context, input()),
    input,
    async prepare() {
      const result = await rig.confirm();
      if (result.kind !== "allowed") throw new Error("Synthetic confirmation denied.");
      approval.authority = result.authority;
      attempt = { attemptId: randomUUID(), number: 1, kind: "initial", preparedAt: AT, deadlineAt: "2026-11-01T00:00:30.000Z", authority: result.authority, supportDeclarationId: support.declarationId };
      const journal = host.lifecycleJournal(registry);
      const stored = await journal.read(approval.operationId);
      await journal.append(approval.operationId, requireValue(stored).revision, eventFixture(2, { kind: "attempt-prepared", attempt }), { support });
      return { lifecycleVersion: "1.0.0" as const, operationId: approval.operationId, attemptId: attempt.attemptId, idempotencyKey: approval.idempotencyKey, ownerRequestId: approval.ownerRequestId, snapshot: approval.snapshot, authority: result.authority, supportDeclarationId: support.declarationId, deadlineAt: attempt.deadlineAt };
    },
    async revokeConnection() { connection.connectionRevision = String(Number(connection.connectionRevision) + 1); connection.status = "revoked"; await service.publishHostRecord({ kind: "connection", value: connection }, Number(connection.connectionRevision) - 1); },
    async reopen() { await host.close(); host = await open(); service = host.lifecycleAuthority(registry, bindings); context = requireValue(await service.authenticate("authenticated-session")); },
    async close() { await host.close(); await rm(dir, { recursive: true, force: true }); },
  };
  return rig;
}
