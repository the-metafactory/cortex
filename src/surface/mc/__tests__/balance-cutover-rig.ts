import type { Database } from "bun:sqlite";
import { DomainAdapterRegistry } from "../../../conversations/domain-adapters/registry";
import type { AdapterDeclaration } from "../../../conversations/domain-adapters/types";
import type { WriterAuthority, WriterCutoverSteps, WriterPlan, WriterRecord } from "../../../conversations/domain-adapters/operations/writer-authority";
import { balanceTaskState } from "../../../conversations/domain-adapters/__tests__/fixtures/balance-task-fixtures";
import { HandledLedger } from "../desk/actions";
import { saveBalanceState } from "../desk/balance-store";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import type { ProposalView } from "../../../conversations/creation";
import type { conversationWriterRig } from "./conversation-writer-rig";

type WriterRig = ReturnType<typeof conversationWriterRig>;

export async function openBalanceCutoverBase<Reply extends { proposal: ProposalView; conversation: { id: string } }>(writerRig: WriterRig, desk: DeskOptions, declaration: AdapterDeclaration) {
  const db: Database = writerRig.database();
  saveBalanceState(db, balanceTaskState());
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options: desk };
  const opened = await writerRig.open<Reply>(db, runtime);
  const registry = new DomainAdapterRegistry();
  const registered = registry.register(declaration, { handlers: {}, observations: {} });
  if (!registered.ok) throw new Error(registered.error.code);
  const journal = opened.host.lifecycleJournal(registry);
  const writers = opened.host.lifecycleWriters();
  return { db, opened, journal, writers };
}

export const cutoverRunner = (writers: WriterAuthority) => async (steps: WriterCutoverSteps, plan: WriterPlan): Promise<WriterRecord> => {
  const begun = await writers.begin(plan, 0);
  return writers.resume(begun.bindingKey, steps);
};
