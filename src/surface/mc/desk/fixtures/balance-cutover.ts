import type { Database } from "bun:sqlite";
import type { OutlineNode } from "../../../../balance";
import type { AuthorityCheck, HostContext } from "../../../../conversations/authority";
import { BALANCE_TASK_CREATE_SUPPORT_ID, createBalanceTaskBinding, type BalanceTaskBinding } from "../../../../conversations/domain-adapters/balance/task-binding";
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
import { balanceTaskRoute, createBalanceTaskLifecycleWriter, type BalanceTaskCutover, type BalanceTaskCutoverActive } from "../balance-task-cutover";
import type { DeskOptions } from "../compose";
import { loadBalanceState } from "../balance-store";

export const BALANCE_CUTOVER_STACK = "test";
export const BALANCE_CUTOVER_BINDING = { stack: BALANCE_CUTOVER_STACK, owner: "balance-task", adapterId: "balance", connectionId: BALANCE_TASK_CONNECTION, capabilityId: "balance.task.create" } as const;

export interface BalanceCutoverFixtureOptions {
  db: Database;
  desk: () => DeskOptions;
  journal: OperationJournalStore;
  writers: WriterAuthority;
  stack?: string;
  now?: () => number;
}

export interface BalanceCutoverFixture {
  readonly bridge: OperationBridge;
  readonly cutover: BalanceTaskCutover;
  binding(): BalanceTaskBinding | undefined;
}

export function balanceCutoverFixture(options: BalanceCutoverFixtureOptions): BalanceCutoverFixture {
  const stack = options.stack ?? BALANCE_CUTOVER_STACK;
  const now = options.now ?? (() => BALANCE_TASK_NOW);
  let binding: BalanceTaskBinding | undefined;
  const bridge = new OperationBridge({
    journal: options.journal,
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
    route: () => balanceTaskRoute(options.writers, stack),
    writer: () => createBalanceTaskLifecycleWriter({
      stack, db: options.db, desk: options.desk, areas: () => options.desk().areas, journal: options.journal, bridge, writers: options.writers,
      supportDeclarationId: BALANCE_TASK_CREATE_SUPPORT_ID,
      context: () => Promise.resolve({} as HostContext),
      approve: (_context, input): Promise<AuthorityCheck> => Promise.resolve({ kind: "allowed", authority: { ...balanceTaskAuthority, decisionRef: input.operationId } }),
      binding: (active: BalanceTaskCutoverActive) => {
        binding = createBalanceTaskBinding({ stack, connectionId: active.connectionId, db: options.db, desk: options.desk, areas: () => options.desk().areas, journal: options.journal, now });
        return binding;
      },
      now,
    }),
  };
  return { bridge, cutover, binding: () => binding };
}

export interface InFlightLegacyCutover {
  readonly source: LegacySource;
  readonly context: LegacyContext;
  readonly plan: WriterPlan;
  readonly steps: WriterCutoverSteps;
}

export function legacyInFlightCutover(journal: OperationJournalStore, options: { stack?: string } = {}): InFlightLegacyCutover {
  const source = legacyFixture("running");
  source.proposal.proposalId = "proposal-in-flight";
  source.record.proposalId = "proposal-in-flight";
  source.record.operationId = "conversation-example:proposal-in-flight:1";
  const context = legacyContext(source);
  const preview = previewLegacyOperation(source, context);
  const plan: WriterPlan = { ...syntheticWriterPlan({ ...BALANCE_CUTOVER_BINDING, stack: options.stack ?? BALANCE_CUTOVER_STACK }), knownCalls: [source.record.operationId], sources: [{ operationId: source.record.operationId, sourceDigest: preview.sourceDigest }] };
  const steps: WriterCutoverSteps = {
    ...syntheticWriterSteps(),
    async drain() {
      await importLegacyOperation(journal, source, context, AT);
      return { drained: [], uncertain: [source.record.operationId] };
    },
    async import() {
      await importLegacyOperation(journal, source, context, AT);
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
