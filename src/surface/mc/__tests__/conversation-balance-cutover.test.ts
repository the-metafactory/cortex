import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { findNode, type OutlineNode } from "../../../balance";
import { balanceTaskCreateBindings, balanceTaskCreateDeclaration } from "../../../conversations/domain-adapters/balance/task-binding";
import { readLegacyImportWatermark, readOperationEvidence } from "../../../conversations/domain-adapters/operations/legacy";
import { DomainAdapterRegistry } from "../../../conversations/domain-adapters/registry";
import type { WriterCutoverSteps, WriterPlan, WriterRecord } from "../../../conversations/domain-adapters/operations/writer-authority";
import type { Grant, ProposalView } from "../../../conversations/creation";
import { BALANCE_TASK_CONNECTION, balanceTaskState, taskFields } from "../../../conversations/domain-adapters/__tests__/fixtures/balance-task-fixtures";
import { HandledLedger } from "../desk/actions";
import { loadBalanceState, saveBalanceState } from "../desk/balance-store";
import { balanceTaskRoute } from "../desk/balance-task-cutover";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { conversationSources, operationUuid } from "../desk/conversation-sources";
import { balanceCutoverFixture, balanceTasks, legacyInFlightCutover } from "../desk/fixtures/balance-cutover";
import { loadMeta } from "../desk/my-day";
import { conversationWriterRig } from "./conversation-writer-rig";

const writerRig = conversationWriterRig("conversation-balance-cutover-", "ai.meta-factory.cortex.balance-cutover-test");

interface Reply { ok: boolean; error: string; proposal: ProposalView; conversation: { id: string } }

const AREA = "area-example";

function deskOptions(): DeskOptions {
  return { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [{ id: AREA, label: "Lab", color: "", repos: [], goals: [], policy: "local" }, { id: "area-home", label: "Home", color: "", repos: [], goals: [] }], sources: [] };
}

async function openRig() {
  const db = writerRig.database();
  saveBalanceState(db, balanceTaskState());
  const desk = deskOptions();
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options: desk };
  const opened = await writerRig.open<Reply>(db, runtime);
  const registry = new DomainAdapterRegistry();
  const registered = registry.register(balanceTaskCreateDeclaration(), balanceTaskCreateBindings());
  if (!registered.ok) throw new Error(registered.error.code);
  const journal = opened.host.lifecycleJournal(registry);
  const writers = opened.host.lifecycleWriters();
  const fixture = balanceCutoverFixture({ db, desk: () => desk, journal, writers });
  await opened.host.attachSources(conversationSources({ db, desk: () => desk, balanceTaskCutover: () => fixture.cutover }));
  const conversationId = await opened.start("Cutover conversation");
  const tasks = (title: string): OutlineNode[] => balanceTasks(db, title);
  const receipts = () => loadMeta(db).receipts;
  const unwrap = (reply: { body: Reply }): ProposalView => reply.body.proposal;
  const propose = async (fields: Record<string, string>): Promise<ProposalView> => unwrap(await opened.call("POST", `/api/conversations/${conversationId}/proposals`, { proposalId: randomUUID(), type: "balance-task", fields }));
  const revise = async (view: ProposalView, fields: Record<string, string>): Promise<ProposalView> => unwrap(await opened.call("PATCH", `/api/conversations/${conversationId}/proposals/${view.proposal.proposalId}`, { revision: view.proposal.revision, fields }));
  const confirm = async (view: ProposalView, extra: Record<string, unknown> = {}) => opened.call("POST", `/api/conversations/${conversationId}/proposals/${view.proposal.proposalId}/confirm`, { revision: view.proposal.revision, digest: view.digest, ...extra });
  const list = async (): Promise<{ proposals: ProposalView[]; grants: Grant[] }> => (await opened.call("GET", `/api/conversations/${conversationId}/proposals`)).body as unknown as { proposals: ProposalView[]; grants: Grant[] };
  const runCutover = async (steps: WriterCutoverSteps, plan: WriterPlan): Promise<WriterRecord> => {
    const begun = await writers.begin(plan, 0);
    return writers.resume(begun.bindingKey, steps);
  };
  return { db, desk, host: opened.host, conversationId, journal, writers, propose, revise, confirm, list, tasks, receipts, runCutover, unwrap };
}

describe("Balance task creation after the per-binding cutover", () => {
  test("an existing proposal keeps its identity and edits, the saved task keeps its receipt, and a repeated approval creates one task", async () => {
    const rig = await openRig();
    const created = rig.unwrap(await rig.confirm(await rig.propose(taskFields({ title: "Before the cutover" }))));
    expect(created.feedback).toBe("created");
    const operation = created.operation!;
    const [saved] = rig.tasks("Before the cutover");
    expect(saved).toBeDefined();
    expect(operation.canonicalId).toBe(saved?.id);
    const receipt = rig.receipts().find(item => item.id === operationUuid(operation.operationId));
    expect(receipt?.outlineId).toBe(saved?.id);

    const draft = await rig.propose(taskFields({ title: "Draft before the cutover" }));
    const edited = await rig.revise(draft, taskFields({ title: "Edited before the cutover", note: "Kept through cutover" }));

    await rig.runCutover(legacyInFlightCutover(rig.journal).steps, legacyInFlightCutover(rig.journal).plan);
    const afterCutover = await rig.list();
    expect(afterCutover.proposals.find(item => item.proposal.proposalId === created.proposal.proposalId)?.feedback).toBe("created");
    const keptEdited = afterCutover.proposals.find(item => item.proposal.proposalId === edited.proposal.proposalId);
    expect(keptEdited?.proposal.revision).toBe(edited.proposal.revision);
    expect(keptEdited?.proposal.fields).toEqual(edited.proposal.fields);
    expect(keptEdited?.feedback).toBe("proposed");
    expect(rig.tasks("Before the cutover")).toHaveLength(1);
    expect(rig.receipts().find(item => item.id === operationUuid(operation.operationId))).toEqual(receipt);

    const confirmedAgain = rig.unwrap(await rig.confirm(keptEdited!));
    expect(confirmedAgain.feedback).toBe("created");
    const [task] = rig.tasks("Edited before the cutover");
    expect(task?.note).toBe("Kept through cutover");
    const repeated = rig.unwrap(await rig.confirm(confirmedAgain));
    expect(repeated.operation?.canonicalId).toBe(confirmedAgain.operation?.canonicalId);
    expect(rig.tasks("Edited before the cutover")).toHaveLength(1);
  });

  test("an operation running at cutover imports uncertain without retry, and only the lifecycle writer creates afterwards", async () => {
    const rig = await openRig();
    const inFlight = legacyInFlightCutover(rig.journal);
    const active = await rig.runCutover(inFlight.steps, inFlight.plan);
    expect(active.phase).toBe("active");
    const imported = await rig.journal.read(inFlight.source.record.operationId);
    expect(imported?.journal.state).toBe("uncertain");
    expect(imported?.retryBlocked).toBe(true);
    const evidence = readOperationEvidence(imported);
    expect(evidence.kind).toBe("legacy");
    expect(evidence.kind === "legacy" && evidence.retryAllowed).toBe(false);
    expect(evidence.kind === "legacy" && evidence.dispatchAllowed).toBe(false);
    expect(await rig.writers.legacyAllowed({ stack: "test", owner: "balance-task", adapterId: "balance", connectionId: BALANCE_TASK_CONNECTION, capabilityId: "balance.task.create" }, true)).toBe(false);
    expect(await rig.writers.legacyOwnerAllowed("test", "balance-task")).toBe(false);

    const created = rig.unwrap(await rig.confirm(await rig.propose(taskFields({ title: "After the cutover" }))));
    expect(created.feedback).toBe("created");
    const [task] = rig.tasks("After the cutover");
    expect(task?.id).toBe(created.operation?.canonicalId);
    const operationId = created.operation?.operationId ?? "";
    expect(rig.receipts().some(item => item.id === operationUuid(operationId))).toBe(true);
    const stored = await rig.journal.read(operationId);
    expect(stored?.journal.state).toBe("succeeded");
    expect(stored?.journal.events.filter(entry => entry.event.kind === "attempt-prepared")).toHaveLength(1);
  });

  test("a standing grant lapses visibly at cutover, asks once, and the renewed grant binds connection and destination", async () => {
    const rig = await openRig();
    const standing = await rig.propose(taskFields({ title: "Under the old grant" }));
    expect(rig.unwrap(await rig.confirm(standing, { grant: { scope: "conversation" } })).feedback).toBe("created");
    const old = (await rig.list()).grants.find(grant => grant.type === "balance-task");
    expect(old).toBeDefined();
    expect(old?.connectionId).toBeUndefined();
    expect(old?.renewal).toBeUndefined();

    await rig.runCutover(legacyInFlightCutover(rig.journal).steps, legacyInFlightCutover(rig.journal).plan);
    const lapsed = (await rig.list()).grants.find(grant => grant.grantId === old?.grantId);
    expect(lapsed?.renewal?.reason).toContain("Confirm one creation again");
    expect(lapsed?.supersededAt).toBeUndefined();

    const asks = await rig.propose(taskFields({ title: "Asks once after cutover" }));
    expect(asks.feedback).toBe("proposed");
    expect(rig.tasks("Asks once after cutover")).toHaveLength(0);

    const renewed = rig.unwrap(await rig.confirm(asks, { grant: { scope: "conversation" } }));
    expect(renewed.feedback).toBe("created");
    const [task] = rig.tasks("Asks once after cutover");
    expect(task?.id).toBe(renewed.operation?.canonicalId);
    const grants = (await rig.list()).grants.filter(grant => grant.type === "balance-task");
    const fresh = grants.find(grant => grant.grantId !== old?.grantId);
    expect(fresh?.connectionId).toBe(BALANCE_TASK_CONNECTION);
    expect(fresh?.destinations).toEqual([{ objectType: "area", canonicalId: AREA }]);
    expect(grants.find(grant => grant.grantId === old?.grantId)?.supersededAt).toBeDefined();
  });

  test("a removed area denies approval with nothing created, and a read-only downgrade keeps the sidecar evidence", async () => {
    const rig = await openRig();
    const inFlight = legacyInFlightCutover(rig.journal);
    const active = await rig.runCutover(inFlight.steps, inFlight.plan);
    const before = rig.receipts().length;
    rig.desk.areas = rig.desk.areas.filter(area => area.id !== AREA);
    const denied = rig.unwrap(await rig.confirm(await rig.propose(taskFields({ title: "Into a removed area" }))));
    expect(denied.feedback).toBe("failed");
    expect(denied.operation?.history.at(-1)?.detail).toContain("not a configured area");
    expect(rig.tasks("Into a removed area")).toHaveLength(0);
    expect(rig.receipts().length).toBe(before);
    expect(findNode(loadBalanceState(rig.db)!.outline, `area:${AREA}`)).not.toBeNull();

    const retired = await rig.writers.begin({ ...inFlight.plan, cutoverId: "read-only-downgrade" }, active.revision);
    expect(retired.phase).toBe("disabled");
    expect((await balanceTaskRoute(rig.writers, "test")).kind).toBe("disabled");
    const afterDowngrade = rig.unwrap(await rig.confirm(await rig.propose(taskFields({ title: "After the downgrade" }))));
    expect(afterDowngrade.feedback).toBe("failed");
    expect(afterDowngrade.operation?.history.at(-1)?.detail).toContain("cutover has not completed");
    expect(rig.tasks("After the downgrade")).toHaveLength(0);
    const evidence = readOperationEvidence(await rig.journal.read(inFlight.source.record.operationId));
    expect(evidence.kind).toBe("legacy");
    expect(evidence.kind === "legacy" && evidence.retryAllowed).toBe(false);
    expect(await readLegacyImportWatermark(rig.journal, inFlight.plan.sources)).toBeDefined();
  });
});
