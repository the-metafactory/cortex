import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { openConversationHost } from "../../../host";
import { ConversationCreation, type Actor, type ProposalView } from "../../../creation";
import type { AuthenticatedBinding, AuthorityBindings } from "../../../authority";
import type { PolicyInputs } from "../../../authority-records";
import { DomainAdapterRegistry } from "../../registry";
import { createFlowSaveBinding, flowSaveDeclaration, FLOW_SAVE_SUPPORT_ID } from "../../flow/save-binding";
import { createFlowCutover } from "../../flow/cutover";
import { syntheticWriterPlan, syntheticWriterSteps } from "../../operations/writer-fixtures";
import { conversationSources } from "../../../../surface/mc/desk/conversation-sources";
import { initDatabase } from "../../../../surface/mc/db/init";
import type { DeskOptions } from "../../../../surface/mc/desk/compose";
import { flowSaveDefinition, flowSaveRequest, openFlowSaveRig, FLOW_SAVE_NOW } from "./flow-save-fixtures";

export const flowCutoverConfirm = (view: ProposalView) => ({ revision: view.proposal.revision, digest: view.digest });

export async function openFlowCutoverRig() {
  const pulse = await openFlowSaveRig();
  const open = () => openConversationHost({ dir: join(pulse.dir, "host"), stack: "test", label: "synthetic-flow-cutover", expectedLabel: "synthetic-flow-cutover", lanes: { local: { provider: "test", model: "test" } }, turns: request => Promise.resolve({ text: "synthetic", session: request.session, resumed: false }), now: () => new Date(FLOW_SAVE_NOW) });
  const status = await open();
  if (status.state !== "ready") throw new Error(status.reason);
  let host = status.host;
  const db = initDatabase(":memory:");
  const registry = new DomainAdapterRegistry();
  const registered = registry.register(flowSaveDeclaration(), { handlers: {}, observations: {} });
  if (!registered.ok) throw new Error(registered.error.code);
  const journal = host.lifecycleJournal(registry);
  const hooks: { afterSave?: () => Promise<void> } = {};
  const run: typeof pulse.run = async (argv, stdin, timeout) => {
    const result = await pulse.run(argv, stdin, timeout);
    if (argv.includes("save")) await hooks.afterSave?.();
    return result;
  };
  const binding = createFlowSaveBinding({ stack: "test", connectionId: "flow-example", flows: () => ({ pulse: pulse.pulse }), journal, run, now: () => FLOW_SAVE_NOW });
  const principal = { version: 1 as const, status: "active" as const, principalRef: randomUUID(), principal: "principal-example", stack: "test", identityBindingRevision: "1" };
  const destination = { adapterId: "flow", connectionId: "flow-example", objectType: "stack", canonicalId: "test" };
  const connection = { version: 1 as const, status: "active" as "active" | "revoked", connectionId: "flow-example", adapterId: "flow", principalRef: principal.principalRef, connectionRevision: "1", credentialHandle: "local-pulse", accountScope: { stack: "test" }, readCapabilityIds: ["flow.saved.create"], writeCapabilityIds: ["flow.saved.create"], readDestinations: [destination], writeDestinations: [destination], connectorId: "flow-example", executionBindingRef: FLOW_SAVE_SUPPORT_ID, registryRevision: "flow-1" };
  const sessions = new Map<string, AuthenticatedBinding>();
  const policy: PolicyInputs = { version: 1, contextRevision: "1", conversationPolicy: "local", tool: {}, communication: {}, link: {}, work: {}, history: {}, registryRevision: "flow-1", executionBindingRevision: FLOW_SAVE_SUPPORT_ID, operationVisible: true, readsAllowed: true, writesAllowed: true, releaseAllowed: true, allowedAudiences: ["web"] };
  const bindings: AuthorityBindings = {
    currentRevision: () => JSON.stringify({ policy, connection }),
    authenticate: id => Promise.resolve(sessions.get(id) ?? null),
    policy: () => Promise.resolve(policy),
    writer: (lease, snapshot) => host.lifecycleWriters().admits(lease, "test", "flow", snapshot),
    restrictions: new Map(), sinks: new Map(),
    connectors: new Map([["flow-example", { ...binding.connector, authorizeConnection: current => Promise.resolve({ version: 1 as const, available: current.status === "active" && current.accountScope.stack === "test", revision: current.connectionRevision }) }]]),
  };
  const authority = host.lifecycleAuthority(registry, bindings);
  await authority.publishHostRecord({ kind: "principal", value: principal }, 0);
  await authority.publishHostRecord({ kind: "connection", value: connection }, 0);
  const cutover = createFlowCutover({ host, registry, bindings, binding, async openSession(actor, conversationId) {
    assert.equal(actor.principal, principal.principal);
    await host.meta(conversationId);
    const id = randomUUID();
    sessions.set(id, { principal: actor.principal, stack: "test", conversationId, authenticatedSessionRef: id, transport: actor.transport, audience: actor.transport, expiresAt: "2026-12-01T00:00:00Z", maintenance: false });
    const unregister = authority.registerReleaseSink({ kind: "web", conversationId }, () => Promise.resolve());
    const context = await authority.authenticate(id);
    if (!context) throw new Error("Synthetic principal session was refused.");
    return { context, close() { sessions.delete(id); unregister(); } };
  } });
  const desk: DeskOptions = { enabled: true, displayName: "Synthetic", topN: 5, rangerUrl: "", areas: [], sources: [], flows: { pulse: pulse.pulse } };
  const sources = () => conversationSources({ db, desk: () => desk, runFlow: pulse.run, flowCutover: cutover.lifecycle });
  await host.attachSources(sources());
  const creation = new ConversationCreation(host, { now: () => new Date(FLOW_SAVE_NOW) });
  const actor: Actor = { principal: principal.principal, transport: "web" };
  const conversation = await host.create({ title: "Synthetic Flow cutover", policy: "local", links: [], origin: { kind: "web" } }, actor.principal);
  const id = conversation.id;
  const propose = async (name: string, type = "flow") => (await creation.propose(id, { proposalId: randomUUID(), type, fields: type === "flow" ? { name, definition: flowSaveDefinition(name) } : { text: name } }, actor)).view;
  const confirm = (view: ProposalView, standing = false) => creation.confirm(id, view.proposal.proposalId, { ...flowCutoverConfirm(view), ...(standing ? { grant: { scope: "conversation" as const } } : {}) }, actor);
  const seed = async () => {
    const saved = await confirm(await propose("F_LEGACY_SAVED"));
    const pending = await propose("F_LEGACY_PROPOSAL");
    const draft = await creation.revise(id, pending.proposal.proposalId, { revision: 1, fields: { name: "F_LEGACY_EDITED", definition: flowSaveDefinition("F_LEGACY_EDITED") } }, actor);
    const uncertain = await propose("F_LEGACY_RUNNING");
    let running = await host.propose(id, uncertain.proposal.proposalId, 1, "flow", uncertain.digest);
    running = await host.transition(running.operationId, "confirmed", { authority: { kind: "confirmation", transport: "web" } });
    running = await host.transition(running.operationId, "running");
    const legacy = flowSaveRequest(uncertain.proposal.proposalId, uncertain.proposal.fields);
    legacy.operationId = running.operationId;
    legacy.provenance = { ...legacy.provenance, operationId: running.operationId, conversationId: id, proposalId: uncertain.proposal.proposalId, link: `?desk=conversation&conversation=${id}` };
    await sources().writers?.flow?.create(legacy);
    const grantId = `grant-${"0".repeat(32)}`;
    await host.changeCreation(() => ({ result: null, grants: { [grantId]: { grantId, type: "flow", scope: "global", conversationId: id, principal: actor.principal, operationId: saved.operation?.operationId ?? "", createdAt: new Date(FLOW_SAVE_NOW).toISOString() } } }));
    return { saved, draft, running, grantId };
  };
  const plan = async () => ({ ...syntheticWriterPlan(binding.writerBinding), ...await cutover.inventory() });
  return { pulse, get host() { return host; }, db, registry, binding, authority, connection, policy, cutover, sources, creation, actor, id, desk, propose, confirm, seed, plan, hooks, steps: syntheticWriterSteps,
    async downgrade() {
      await host.close();
      const status = await open();
      if (status.state !== "ready") throw new Error(status.reason);
      host = status.host;
      await host.attachSources(conversationSources({ db, desk: () => desk, runFlow: pulse.run }));
      return host;
    },
    async close() { await host.close(); db.close(); await pulse.close(); },
  };
}
