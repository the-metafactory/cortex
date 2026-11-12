import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { findNode, type AppState, type OutlineNode } from "../../../../balance";
import { leaf, outlineState, removeOutlineNode } from "./balance-shared";
import type { HostContext, WriterLease } from "../../../authority";
import type { OwnerWriter } from "../../../types";
import { operationUuid } from "../../../conversation-ids";
import type { Authority, Provenance } from "../../operations/types";
import { initDatabase } from "../../../../surface/mc/db/init";
import { loadBalanceState, saveBalanceState } from "../../../../surface/mc/desk/balance-store";
import { balanceWriter } from "../../../../surface/mc/desk/balance-conversation-writer";
import type { DeskOptions } from "../../../../surface/mc/desk/compose";
import { loadMeta } from "../../../../surface/mc/desk/my-day";
import type { DeskArea } from "../../../../surface/mc/desk/types";
import { DomainAdapterRegistry } from "../../registry";
import type { OperationBridge } from "../../operations/dispatch";
import type { OperationJournalStore } from "../../operations/journal";
import { confirmationAuthority, lifecycleRig, openJournal } from "./lifecycle-rig";
import { balanceTaskApprovedSnapshot, balanceTaskCreateBindings, balanceTaskCreateDeclaration, createBalanceTaskBinding, createBalanceTaskFacade, type BalanceTaskBinding, type BalanceTaskCreateInput, type BalanceTaskFacade, type BalanceTaskFields } from "../../balance/task-binding";

export const BALANCE_TASK_CONNECTION = "connection-example";
export const BALANCE_TASK_STACK = "test";
export const BALANCE_TASK_NOW = Date.parse("2026-11-01T12:00:00.000Z");
export const CONVERSATION = "conversation-example";

export const balanceTaskAuthority: Authority = confirmationAuthority(BALANCE_TASK_NOW);

export const taskFields = (overrides: Partial<BalanceTaskFields> = {}): BalanceTaskFields => ({ area: "area-example", title: "Probe task", ...overrides });

export function balanceTaskState(): AppState {
  return outlineState([
    {
      id: "area:area-example", title: "Lab", weight: 60, ordering: "parallel", children: [
        { id: "studio-thread:glider", title: "Glider", weight: 50, ordering: "parallel", children: [leaf("task-wing", "Cut the wing")] },
        { id: "studio-thread:glider-two", title: "Glider", weight: 50, ordering: "parallel", children: [leaf("task-nose", "Tape the nose")] },
        { id: "studio-thread:kite", title: "Kite", weight: 50, ordering: "parallel", children: [] },
      ],
    },
    { id: "area:area-home", title: "Home", weight: 40, ordering: "parallel", children: [] },
  ]);
}

export interface BalanceTaskRig {
  readonly dir: string;
  readonly db: Database;
  readonly options: DeskOptions;
  readonly areas: DeskArea[];
  readonly registry: DomainAdapterRegistry;
  readonly journal: OperationJournalStore;
  readonly bridge: OperationBridge;
  readonly lease: WriterLease;
  readonly context: HostContext;
  binding(): BalanceTaskBinding;
  facade(): BalanceTaskFacade;
  lifecycle(): { activate(): Promise<boolean>; dispatch(operationId: string): Promise<Awaited<ReturnType<OperationBridge["dispatch"]>>> };
  writer(): Pick<OwnerWriter, "create" | "readback">;
  setOwner(writer: Pick<OwnerWriter, "create" | "readback">): void;
  state(): AppState;
  save(state: AppState): void;
  receipts(): ReturnType<typeof loadMeta>["receipts"];
  tasks(title: string): OutlineNode[];
  node(id: string): OutlineNode | undefined;
  removeTask(id: string): void;
  close(): Promise<void>;
}

export function operationId(name: string): string {
  return `${CONVERSATION}:${name}:1`;
}

function balanceTaskProvenance(operationIdValue: string): Provenance {
  const proposalId = operationIdValue.split(":")[1] ?? "proposal-example";
  return { conversationId: CONVERSATION, proposalId, revision: 1, entryId: null, link: `?desk=conversation&conversation=${CONVERSATION}` };
}

export function createTaskRequest(fields: BalanceTaskFields, operationIdValue = operationId("proposal-example")): Parameters<BalanceTaskFacade["create"]>[0] {
  return { operationId: operationIdValue, type: "balance-task", fields, activation: "none", provenance: { ...balanceTaskProvenance(operationIdValue), operationId: operationIdValue }, signal: new AbortController().signal };
}

export async function approveBalanceTask(rig: BalanceTaskRig, operationIdValue: string, input: BalanceTaskCreateInput): Promise<void> {
  const snapshot = balanceTaskApprovedSnapshot({ connectionId: BALANCE_TASK_CONNECTION, provenance: balanceTaskProvenance(operationIdValue), input });
  await rig.journal.approve({ operationId: operationIdValue, idempotencyKey: operationIdValue, ownerRequestId: operationUuid(operationIdValue), snapshot, authority: balanceTaskAuthority, at: new Date(BALANCE_TASK_NOW).toISOString() });
}

export async function openBalanceTaskRig(): Promise<BalanceTaskRig> {
  const dir = await mkdtemp(join(tmpdir(), "balance-task-binding-"));
  const db = initDatabase(join(dir, "desk.sqlite"));
  saveBalanceState(db, balanceTaskState());
  const areas = [{ id: "area-example", label: "Lab", color: "#2563eb", repos: [], goals: [] }, { id: "area-home", label: "Home", color: "#059669", repos: [], goals: [] }];
  const options: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas, sources: [] };
  const registry = new DomainAdapterRegistry();
  const declaration = balanceTaskCreateDeclaration();
  const registered = registry.register(declaration, balanceTaskCreateBindings());
  if (!registered.ok) throw new Error(registered.error.code);
  const { journal, closeEngine } = await openJournal(dir, registry);
  const baseWriter = balanceWriter("task", { db, desk: () => options, now: () => BALANCE_TASK_NOW });
  const build = (owner: Pick<OwnerWriter, "create" | "readback">): { binding: BalanceTaskBinding; facade: BalanceTaskFacade } => {
    const binding = createBalanceTaskBinding({ stack: BALANCE_TASK_STACK, connectionId: BALANCE_TASK_CONNECTION, db, desk: () => options, areas: () => areas, journal, now: () => BALANCE_TASK_NOW, owner });
    return { binding, facade: createBalanceTaskFacade({ binding, journal, areas: () => areas, state: () => loadBalanceState(db), now: () => BALANCE_TASK_NOW }) };
  };
  let current = build(baseWriter);
  const live = (): BalanceTaskBinding => current.binding;
  const { context, lease, bridge, lifecycle } = lifecycleRig({ journal, live, now: BALANCE_TASK_NOW, label: "Balance task" });
  const stored = (): AppState => {
    const state = loadBalanceState(db);
    if (!state) throw new Error("Balance task fixture state is missing.");
    return state;
  };
  const save = (state: AppState): void => { saveBalanceState(db, state); };
  const tasks = (title: string): OutlineNode[] => {
    const found: OutlineNode[] = [];
    const visit = (node: OutlineNode): void => { if (node.title === title) found.push(node); node.children.forEach(visit); };
    visit(stored().outline);
    return found;
  };
  return {
    dir,
    db,
    options,
    areas,
    registry,
    journal,
    bridge,
    lease,
    context,
    binding: live,
    facade: () => current.facade,
    lifecycle,
    writer: () => baseWriter,
    setOwner(owner) {
      current = build(owner);
    },
    state: stored,
    save,
    receipts: () => loadMeta(db).receipts,
    tasks,
    node: id => findNode(stored().outline, id) ?? undefined,
    removeTask(id) {
      const state = stored();
      if (!removeOutlineNode(state.outline, id)) throw new Error(`Balance task fixture node missing: ${id}`);
      save(state);
    },
    async close() {
      db.close();
      await closeEngine();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
