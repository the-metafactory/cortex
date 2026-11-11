import { z } from "zod";
import type { AuthorityBindings, HostContext } from "../../authority";
import type { Actor, Grant, GrantScope, Proposal } from "../../creation";
import { GrantSchema, ProposalSchema } from "../../creation";
import type { CreationLifecycle } from "../../creation-lifecycle";
import type { ConversationHost } from "../../host";
import type { CreateRequest, CreateResult } from "../../types";
import { studioRequestId } from "../../conversation-ids";
import type { DomainAdapterRegistry } from "../registry";
import { importLegacyOperation, previewLegacyOperation, readLegacyImportWatermark, readOperationEvidence, type LegacyContext, type LegacySource } from "../operations/legacy";
import { ownerResultKit, resultsOf } from "../operations/owner-results";
import { writerBindingKey, writerLease, type WriterCutoverSteps, type WriterPlan } from "../operations/writer-authority";
import { canonicalWire } from "../operations/validation";
import type { Json } from "../operations/types";
import { flowSaveApprovedSnapshot, type FlowSaveBinding } from "./save-binding";

export interface FlowCutoverOptions {
  host: ConversationHost;
  registry: DomainAdapterRegistry;
  bindings: AuthorityBindings;
  binding: FlowSaveBinding;
  openSession(actor: Actor, conversationId: string): Promise<{ context: HostContext; close(): void }>;
}

const CAPABILITY = "flow.saved.create";
const foundSchema = z.object({ found: z.literal(true), canonicalId: z.string(), url: z.string().optional() });
const denied = (): never => { throw new Error("Flow saving is disabled. Complete the explicit verified cutover and review permission again."); };
const stoppedWaiting = (signal: AbortSignal): boolean => signal.aborted;

export function createFlowCutover(options: FlowCutoverOptions) {
  const { host, registry, bindings, binding } = options;
  const journal = host.lifecycleJournal(registry);
  const authority = host.lifecycleAuthority(registry, bindings);
  const writers = host.lifecycleWriters();
  const key = writerBindingKey(binding.writerBinding);
  const bridge = host.lifecycleBridge(registry, bindings, snapshot => snapshot.adapterId === "flow" && snapshot.connectionId === binding.support.connectionId && snapshot.capabilityId === CAPABILITY ? binding.support : undefined);
  const reconciler = host.lifecycleReconciler(registry, bindings, bridge, () => binding.support);
  const destination = { adapterId: "flow", connectionId: binding.support.connectionId, objectType: "stack", canonicalId: binding.writerBinding.stack };
  const scope = { capabilityId: CAPABILITY, destinations: [destination], policy: "local" as const, sources: [] };
  const snapshotOf = (request: Pick<CreateRequest, "fields" | "provenance">) => {
    const { operationId: _operationId, ...provenance } = request.provenance;
    return flowSaveApprovedSnapshot({ connectionId: binding.support.connectionId, stack: binding.writerBinding.stack, provenance, input: { stack: destination, name: request.fields.name ?? "", definition: request.fields.definition ?? "" } });
  };
  const mapping = (source: LegacySource): LegacyContext => ({ owner: "flow", adapterId: "flow", connectionId: destination.connectionId, capabilityId: CAPABILITY, fields: source.proposal.fields, destinations: [destination], ...(source.record.canonicalId ? { canonicalReference: { ...destination, objectType: "saved", canonicalId: source.record.canonicalId } } : {}) });
  const releaseResult = async (context: HostContext, operationId: string, actor: Actor): Promise<CreateResult> => {
    const stored = await journal.read(operationId);
    if (!stored || "kind" in stored.journal.snapshot) return denied();
    const response = resultsOf(stored).at(-1);
    if (!response) return { state: "accepted" };
    const reference = await authority.ingestLateEvidence(operationId, response);
    const released = await authority.release(context, reference, { kind: actor.transport, conversationId: stored.journal.snapshot.provenance.conversationId });
    if (released.kind !== "released") return { state: "accepted" };
    if (stored.journal.state === "uncertain") throw new Error("Pulse has not confirmed the save. Check by its original request ID; retry is disabled.");
    return ownerResultKit("flow").legacyResult(stored, "Flow");
  };

  const lifecycle: CreationLifecycle = {
    async started() { return await writers.read(key) !== null; },
    async reviewRevision() {
      const record = await writers.read(key);
      return canonicalWire(record ? { cutoverId: record.plan.cutoverId, epoch: record.epoch, instanceId: record.instanceId } : null);
    },
    async grantViews(grants) {
      const { records } = await authority.inspectHostRecords();
      return grants.map(grant => {
        const sameBinding = grant.binding?.adapterId === "flow" && grant.binding.connectionId === destination.connectionId && grant.binding.capabilityId === CAPABILITY;
        const record = sameBinding ? records[`grant:${grant.binding?.grantId ?? ""}`]?.at(-1) : undefined;
        return { ...grant, renewalRequired: record?.kind !== "grant" || record.value.status !== "active" };
      });
    },
    async grant(proposal: Proposal, scope: GrantScope, actor: Actor) {
      const session = await options.openSession(actor, proposal.conversationId);
      try {
        const operationId = `${proposal.conversationId}:${proposal.proposalId}:${proposal.revision}`;
        const grantId = await authority.grantApprovedOperation(session.context, operationId, scope);
        if (!grantId) return null;
        return { adapterId: "flow", connectionId: destination.connectionId, capabilityId: CAPABILITY, grantId };
      } finally { session.close(); }
    },
    async revoke(grant: Grant, actor: Actor) {
      if (!grant.binding) return;
      const session = await options.openSession(actor, grant.conversationId);
      try { await authority.revokeCreationGrant(session.context, grant.binding.grantId); }
      finally { session.close(); }
    },
    async create(request, basis, actor, reviewRevision) {
      const record = await writers.read(key);
      if (request.type !== "flow" || record?.phase !== "active" || stoppedWaiting(request.signal) || basis.kind === "confirmation" && reviewRevision !== await lifecycle.reviewRevision()) return { state: "failed", error: "Flow saving is disabled or its writer changed. Review the proposal again after the verified cutover." };
      const session = await options.openSession(actor, request.provenance.conversationId);
      try {
        const snapshot = snapshotOf(request);
        const approval = { operationId: request.operationId, ownerRequestId: studioRequestId(request.operationId), idempotencyKey: request.operationId, snapshot };
        const parsed = basis.kind === "grant" ? GrantSchema.safeParse((await host.creation()).grants[basis.grantId]) : null;
        const grant = parsed?.success ? parsed.data : undefined;
        const checked = basis.kind === "confirmation" ? await authority.confirm(session.context, approval) : grant?.binding && !(await lifecycle.grantViews([grant]))[0]?.renewalRequired ? await authority.approveGrant(session.context, approval, grant.binding.grantId) : null;
        if (checked?.kind !== "allowed") return { state: "failed", error: "Current permission does not allow saving this Flow. Review the connection and approve again." };
        const lease = writerLease(record);
        if (!await bridge.activate(binding.writerBinding, lease)) return denied();
        if (stoppedWaiting(request.signal)) return { state: "failed", error: "The conversation stopped waiting before Pulse was called." };
        const result = await bridge.dispatch(session.context, request.operationId, lease);
        if (result.kind === "refused") return { state: "failed", error: result.reason.message };
        return await releaseResult(session.context, request.operationId, actor);
      } finally { session.close(); }
    },
    async check(operation, actor) {
      const session = await options.openSession(actor, operation.conversationId);
      try {
        const stored = await journal.read(operation.operationId);
        if (!stored) return null;
        const evidence = readOperationEvidence(stored);
        if (evidence.kind === "legacy") {
          if (evidence.issues.length || evidence.context?.connectionId !== destination.connectionId || canonicalWire(evidence.context.destinations) !== canonicalWire([destination]) || evidence.source.record.conversationId !== operation.conversationId || evidence.lifecycle.journal.ownerRequestId !== studioRequestId(operation.operationId)) return null;
          const released = await authority.projectHostData(session.context, destination.connectionId, { kind: actor.transport, conversationId: operation.conversationId }, async () => {
            const found = await binding.lookupLegacy(operation.operationId);
            return found?.found ? found : null;
          }, [scope]);
          const found = released.kind === "released" ? foundSchema.safeParse(released.value) : null;
          return found?.success ? found.data : null;
        }
        const leaseRecord = await writers.read(key);
        if (!leaseRecord) return null;
        if (stored.journal.state === "uncertain") await reconciler.check(session.context, operation.operationId, { kind: actor.transport, conversationId: operation.conversationId });
        if ((await journal.read(operation.operationId))?.journal.state !== "succeeded") return null;
        const result = await releaseResult(session.context, operation.operationId, actor);
        return result.state === "created" ? { found: true, canonicalId: result.canonicalId, ...(result.url ? { url: result.url } : {}) } : null;
      } finally { session.close(); }
    },
  };

  const receiptsFor = async (conversationId: string, operationId: string): Promise<Json[]> => {
    const receipts: Json[] = [];
    let cursor: string | undefined;
    do {
      const page = await host.entries(conversationId, 200, cursor);
      for (const entry of page.entries) {
        const data = entry.data;
        if (typeof data === "object" && data !== null && "operationId" in data && data.operationId === operationId) receipts.push(JSON.parse(JSON.stringify(entry)) as Json);
      }
      cursor = page.next;
    } while (cursor);
    return receipts;
  };

  const inventory = async (): Promise<LegacySource[]> => {
    const proposals = (await host.creation()).proposals;
    const sources: LegacySource[] = [];
    for (const record of (await host.operations()).filter(record => record.owner === "flow" && record.state !== "proposed" && record.state !== "confirmed").sort((a, b) => a.operationId.localeCompare(b.operationId))) {
      const imported = await journal.read(record.operationId);
      if (imported) {
        const evidence = readOperationEvidence(imported);
        if (evidence.kind === "legacy") sources.push(evidence.source);
        continue;
      }
      sources.push({ proposal: ProposalSchema.parse(proposals[record.proposalId]), record, ownerReceipts: await receiptsFor(record.conversationId, record.operationId) });
    }
    return sources;
  };
  const importSources = (sources: LegacySource[]) => sources.map(source => ({ operationId: source.record.operationId, sourceDigest: previewLegacyOperation(source, mapping(source)).sourceDigest }));

  return {
    lifecycle, bridge, journal,
    async inventory() {
      const sources = await inventory();
      return { sources: importSources(sources), knownCalls: sources.filter(source => source.record.state === "running").map(source => source.record.operationId) };
    },
    async cutover(plan: WriterPlan, steps: Pick<WriterCutoverSteps, "disable" | "stop" | "verify" | "prepare" | "enable">, expectedRevision: number) {
      if (canonicalWire(plan.binding) !== canonicalWire(binding.writerBinding)) throw new Error("The cutover plan belongs to another Flow binding.");
      const started = await writers.begin(plan, expectedRevision);
      if (started.phase === "active") return started;
      const sources = await inventory();
      if (canonicalWire(importSources(sources)) !== canonicalWire(plan.sources)) throw new Error("Legacy Flow inventory changed; mutation remains disabled.");
      if (canonicalWire(sources.filter(source => source.record.state === "running").map(source => source.record.operationId)) !== canonicalWire(plan.knownCalls)) throw new Error("The in-flight Flow inventory is incomplete; mutation remains disabled.");
      const result = await writers.resume(started.bindingKey, {
        ...steps,
        drain: () => Promise.resolve({ drained: [], uncertain: plan.knownCalls }),
        async import() {
          for (const source of sources) await importLegacyOperation(journal, source, mapping(source), new Date().toISOString());
          return readLegacyImportWatermark(journal, plan.sources);
        },
        watermark: () => readLegacyImportWatermark(journal, plan.sources),
      });
      for (const source of sources) if (source.record.state === "running" && (await host.operations(source.record.conversationId)).find(record => record.operationId === source.record.operationId)?.state === "running") await host.transition(source.record.operationId, "uncertain", { note: "Imported at Flow cutover without retry permission. Check uses the original request ID." });
      return result;
    },
  };
}
