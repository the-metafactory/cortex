import type { FenceGate } from "../../../../conversations/domain-adapters/operations/triggers";
import type { Database } from "bun:sqlite";
import type { OutlineNode } from "../../../../balance";
import type { AuthorityCheck, HostContext } from "../../../../conversations/authority";
import { BALANCE_TASK_CONTRACT, type BalanceTaskBinding, type BalanceTaskCreateInput, type BalanceTaskReview } from "../../../../conversations/domain-adapters/balance/task-binding";
import { importLegacyOperation, previewLegacyOperation, readLegacyImportWatermark } from "../../../../conversations/domain-adapters/operations/legacy";
import { legacyContext, legacyFixture } from "../../../../conversations/domain-adapters/operations/legacy-fixtures";
import { AT } from "../../../../conversations/domain-adapters/operations/fixtures";
import { OperationBridge } from "../../../../conversations/domain-adapters/operations/dispatch";
import type { OperationJournalStore } from "../../../../conversations/domain-adapters/operations/journal";
import { syntheticWriterPlan, syntheticWriterSteps } from "../../../../conversations/domain-adapters/operations/writer-fixtures";
import type { WriterCutoverSteps, WriterPlan } from "../../../../conversations/domain-adapters/operations/writer-authority";
import type { WriterAuthority } from "../../../../conversations/domain-adapters/operations/writer-authority";
import type { LegacyContext, LegacySource } from "../../../../conversations/domain-adapters/operations/legacy";
import { BALANCE_TASK_CONNECTION, BALANCE_TASK_NOW, balanceTaskAuthority } from "../../../../conversations/domain-adapters/__tests__/fixtures/balance-task-fixtures";
import { balanceCreateRoute, createBalanceLifecycleWriter } from "../balance-create-cutover";
import { createBalanceBinding, type BalanceCreateContract } from "../../../../conversations/domain-adapters/balance/create-binding";
import { BALANCE_PROJECT_CONTRACT } from "../../../../conversations/domain-adapters/balance/project-binding";
import type { BalanceTaskCutover, BalanceTaskCutoverActive } from "../balance-task-cutover";
import type { DeskItem } from "../types";
import type { DeskOptions } from "../compose";
import { loadBalanceState } from "../balance-store";

export const BALANCE_CUTOVER_STACK = "test";
export const BALANCE_CUTOVER_BINDING = { stack: BALANCE_CUTOVER_STACK, owner: "balance-task", adapterId: "balance", connectionId: BALANCE_TASK_CONNECTION, capabilityId: "balance.task.create" } as const;

export interface BalanceCutoverFixtureOptions {
  db: Database;
  desk: () => DeskOptions;
  journal: OperationJournalStore;
  writers: WriterAuthority;
  fences?: FenceGate;
  contract?: BalanceCreateContract<BalanceTaskCreateInput, BalanceTaskReview>;
  stack?: string;
  now?: () => number;
}

export interface BalanceCutoverFixture {
  readonly bridge: OperationBridge;
  readonly cutover: BalanceTaskCutover;
  binding(): BalanceTaskBinding | undefined;
}

export function balanceCutoverFixture(options: BalanceCutoverFixtureOptions): BalanceCutoverFixture {
  const contract = options.contract ?? BALANCE_TASK_CONTRACT;
  const stack = options.stack ?? BALANCE_CUTOVER_STACK;
  const now = options.now ?? (() => BALANCE_TASK_NOW);
  let binding: BalanceTaskBinding | undefined;
  const bridge = new OperationBridge({
    journal: options.journal,
    fences: options.fences,
    authority: {
      preflight: () => Promise.resolve({ kind: "allowed" as const }),
      async dispatch(_context, request) {
        const connector = binding?.connector.dispatch;
        if (!connector) throw new Error("the cutover connector was not built before dispatch");
        const response = await connector(request, new AbortController().signal);
        const stored = await options.journal.read(request.operationId);
        if (!stored) throw new Error("the cutover operation vanished before its evidence");
        await options.journal.receive(request.operationId, stored.revision, response, new Date(now() + 1_000).toISOString());
        return { kind: "admitted" as const };
      },
      cancel: () => Promise.resolve({ kind: "denied" as const, reason: { code: "authority_denied", message: "Cancellation is not declared." }, recovery: "reauthorize" as const }),
    },
    writers: { current: (lease, value) => options.writers.current(lease, value), legacyAllowed: (value, qualified) => options.writers.legacyAllowed(value, qualified) },
    supportFor: () => binding?.support,
    now: () => new Date(now()),
  });
  const cutover: BalanceTaskCutover = {
    route: () => balanceCreateRoute(options.writers, stack, contract.owner),
    writer: () => createBalanceLifecycleWriter({
      stack, db: options.db, desk: options.desk, areas: () => options.desk().areas, journal: options.journal, bridge, writers: options.writers,
      supportDeclarationId: contract.support(BALANCE_TASK_CONNECTION).declarationId,
      context: () => Promise.resolve({} as HostContext),
      approve: (_context, input): Promise<AuthorityCheck> => Promise.resolve({ kind: "allowed", authority: { ...balanceTaskAuthority, decisionRef: input.operationId } }),
      binding: (active: BalanceTaskCutoverActive) => {
        binding = createBalanceBinding({ stack, connectionId: active.connectionId, db: options.db, desk: options.desk, areas: () => options.desk().areas, journal: options.journal, now }, contract);
        return binding;
      },
      now,
    }, contract),
  };
  return { bridge, cutover, binding: () => binding };
}

export const balanceProjectCutoverFixture = (options: BalanceCutoverFixtureOptions): BalanceCutoverFixture => balanceCutoverFixture({ ...options, contract: BALANCE_PROJECT_CONTRACT });

export interface InFlightLegacyCutover {
  readonly source: LegacySource;
  readonly context: LegacyContext;
  readonly plan: WriterPlan;
  readonly steps: WriterCutoverSteps;
}

export function legacyInFlightCutover(journal: OperationJournalStore, options: { stack?: string; kind?: "task" | "project"; sources?: LegacySource[] } = {}): InFlightLegacyCutover {
  const source = legacyFixture("running");
  source.proposal.proposalId = "proposal-in-flight";
  source.record.proposalId = "proposal-in-flight";
  source.record.operationId = "conversation-example:proposal-in-flight:1";
  const kind = options.kind ?? "task";
  source.proposal.type = `balance-${kind}`;
  source.record.owner = `balance-${kind}`;
  const binding = { ...BALANCE_CUTOVER_BINDING, owner: `balance-${kind}`, capabilityId: `balance.${kind}.create` } as const;
  const mapping = (item: LegacySource): LegacyContext => ({ ...legacyContext(item), owner: binding.owner, capabilityId: binding.capabilityId, ...(item.record.canonicalId ? { canonicalReference: { adapterId: "balance", connectionId: BALANCE_TASK_CONNECTION, objectType: kind, canonicalId: item.record.canonicalId } } : {}) });
  const context = mapping(source);
  const sources = [source, ...(options.sources ?? [])].map(item => ({ source: item, context: mapping(item) }));
  const plan: WriterPlan = { ...syntheticWriterPlan({ ...binding, stack: options.stack ?? BALANCE_CUTOVER_STACK }), knownCalls: [source.record.operationId], sources: sources.map(item => ({ operationId: item.source.record.operationId, sourceDigest: previewLegacyOperation(item.source, item.context).sourceDigest })) };
  const steps: WriterCutoverSteps = {
    ...syntheticWriterSteps(),
    async drain() {
      await importLegacyOperation(journal, source, context, AT);
      return { drained: [], uncertain: [source.record.operationId] };
    },
    async import() {
      for (const item of sources) await importLegacyOperation(journal, item.source, item.context, AT);
      return readLegacyImportWatermark(journal, plan.sources);
    },
    watermark: () => readLegacyImportWatermark(journal, plan.sources),
  };
  return { source, context, plan, steps };
}

export function balanceTasks(db: Database, title: string): OutlineNode[] {
  const state = loadBalanceState(db);
  if (!state) throw new Error("the temporary Balance store has no outline");
  const found: OutlineNode[] = [];
  const visit = (node: OutlineNode): void => { if (node.title === title) found.push(node); node.children.forEach(visit); };
  visit(state.outline);
  return found;
}

export const BALANCE_CUTOVER_INBOX_ITEM: DeskItem = { key: "sensor:cutover-example", kind: "sensor", source: "synthetic", area: "area-example", urgency: "today", title: "Native Inbox beside the adapter card", why: "Disposable cutover probe", score: 1, actions: [], detail: { summary: "Synthetic item", history: [], refs: [], links: [] } };
