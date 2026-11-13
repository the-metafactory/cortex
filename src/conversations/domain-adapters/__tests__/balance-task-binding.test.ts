import { afterEach, describe, expect, test } from "bun:test";
import { findNode } from "../../../balance";
import { operationUuid } from "../../conversation-ids";
import { STALE_OUTLINE } from "../../../surface/mc/desk/balance-outline";
import type { OperationRecord } from "../../types";
import { objectRef } from "../fixtures";
import { balanceTaskCreateOutcome, balanceTaskLegacyResult, reviewBalanceTask, type BalanceTaskBinding } from "../balance/task-binding";
import type { OwnerResult } from "../operations/types";
import { BALANCE_TASK_CONNECTION, BALANCE_TASK_NOW, CONVERSATION, approveBalanceTask, balanceTaskAuthority, createTaskRequest, operationId, openBalanceTaskRig, taskFields, type BalanceTaskRig } from "./fixtures/balance-task-fixtures";

const rigs: BalanceTaskRig[] = [];
async function open(): Promise<BalanceTaskRig> {
  const rig = await openBalanceTaskRig();
  rigs.push(rig);
  return rig;
}
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });

const area = objectRef("balance", "area", "area-example");
const project = (id: string) => objectRef("balance", "project", id);
async function dispatchRequest(rig: BalanceTaskRig, operationIdValue: string): Promise<Parameters<BalanceTaskBinding["dispatch"]>[0]> {
  const stored = await rig.journal.read(operationIdValue);
  if (!stored || "kind" in stored.journal.snapshot) throw new Error("Expected an approved snapshot.");
  const prepared = stored.journal.events.find(entry => entry.event.kind === "attempt-prepared");
  return {
    lifecycleVersion: "1.0.0" as const,
    operationId: operationIdValue,
    attemptId: prepared?.event.kind === "attempt-prepared" ? prepared.event.attempt.attemptId : crypto.randomUUID(),
    idempotencyKey: operationIdValue,
    ownerRequestId: operationUuid(operationIdValue),
    snapshot: stored.journal.snapshot,
    authority: balanceTaskAuthority,
    supportDeclarationId: rig.binding().support.declarationId,
    deadlineAt: new Date(BALANCE_TASK_NOW + 120_000).toISOString(),
  };
}

describe("the inactive Balance task execution binding", () => {
  test("declares request-id dedup and receipt lookup, and no conditional update, cancellation or compensation", async () => {
    const rig = await open();
    const binding = rig.binding();
    expect(binding.declaration.capabilities.map(capability => [capability.capabilityId, capability.kind])).toEqual([["balance.task.create", "action"]]);
    expect(binding.bindings).toEqual({ handlers: {}, observations: {} });
    expect(binding.support).toMatchObject({ capabilityId: "balance.task.create", operationLookup: "historical", conditionalUpdate: "none", cancellation: "none" });
    expect(binding.support.dedup).toMatchObject({ kind: "guaranteed", scope: "connection-capability", bindsSnapshot: true, concurrent: true });
    expect(binding.support).not.toHaveProperty("compensationCapabilityId");
  });

  test("a validated snapshot becomes one legacy owner call with converted references and a task reference", async () => {
    const rig = await open();
    const op = operationId("proposal-example");
    const outcome = await rig.facade().create(createTaskRequest(taskFields({ project: " kite ", title: "Fold a kite", note: "Use paper", due: "2026-12-01" }), op), balanceTaskAuthority, rig.lifecycle());
    expect(outcome.kind).toBe("dispatched");
    const task = rig.tasks("Fold a kite")[0];
    if (!task) throw new Error("Expected one created task.");
    expect(task).toMatchObject({ title: "Fold a kite", note: "Use paper", dueDate: "2026-12-01", effort: 1 });
    expect(findNode(rig.state().outline, "studio-thread:kite")?.children.map(child => child.id)).toEqual([task.id]);
    if (outcome.kind !== "dispatched") throw new Error("Expected a dispatched outcome.");
    expect(outcome.result).toEqual({ state: "created", canonicalId: task.id });
    expect(outcome.stored?.journal.state).toBe("succeeded");
    const attempts = outcome.stored?.journal.events.filter(entry => entry.event.kind === "attempt-prepared") ?? [];
    const results = outcome.stored?.journal.events.filter(entry => entry.event.kind === "owner-result") ?? [];
    expect(attempts).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.event.kind === "owner-result" && results[0].event.response.result.kind === "succeeded" && results[0].event.response.result.evidence.refs[0]).toEqual(objectRef("balance", "task", task?.id ?? ""));
    expect(rig.receipts()).toHaveLength(1);
    expect(rig.receipts()[0]).toMatchObject({ id: operationUuid(op), outlineId: task.id });
  });

  test("a repeat dispatch adds no second task, attempt or receipt", async () => {
    const rig = await open();
    const op = operationId("repeat");
    await rig.facade().create(createTaskRequest(taskFields({ title: "Only once" }), op), balanceTaskAuthority, rig.lifecycle());
    const again = await rig.lifecycle().dispatch(op);
    expect(again.kind).toBe("not-dispatchable");
    expect(rig.tasks("Only once")).toHaveLength(1);
    expect(rig.receipts()).toHaveLength(1);
    const stored = await rig.journal.read(op);
    expect(stored?.journal.events.filter(entry => entry.event.kind === "attempt-prepared")).toHaveLength(1);
    expect(stored?.journal.events.filter(entry => entry.event.kind === "owner-result")).toHaveLength(1);
  });

  test("an owner-level redispatch of one request id creates one task and one receipt", async () => {
    const rig = await open();
    const op = operationId("owner-dedup");
    await approveBalanceTask(rig, op, { area, title: "One effect only" });
    expect(await rig.lifecycle().activate()).toBe(true);
    expect((await rig.lifecycle().dispatch(op)).kind).toBe("settled");
    const request = await dispatchRequest(rig, op);
    const canonical = (response: OwnerResult): string | undefined => response.result.kind === "succeeded" ? response.result.evidence.refs[0]?.canonicalId : undefined;
    const first = await rig.binding().dispatch(request);
    const again = await rig.binding().dispatch({ ...request, attemptId: crypto.randomUUID() });
    expect([first.result.kind, again.result.kind]).toEqual(["succeeded", "succeeded"]);
    expect(canonical(again)).toBe(canonical(first));
    expect(rig.tasks("One effect only")).toHaveLength(1);
    expect(rig.receipts().filter(receipt => receipt.id === operationUuid(op))).toHaveLength(1);
    expect(rig.receipts()).toHaveLength(1);
  });

  test("an invalid legacy field refuses instead of throwing from create", async () => {
    const rig = await open();
    const invalidDue = await rig.facade().create(createTaskRequest(taskFields({ title: "Invalid due", due: "tomorrow" }), operationId("invalid-due")), balanceTaskAuthority, rig.lifecycle());
    expect(invalidDue).toMatchObject({ kind: "refused", result: { state: "failed" } });
    const longTitle = await rig.facade().create(createTaskRequest(taskFields({ title: "x".repeat(301) }), operationId("invalid-title")), balanceTaskAuthority, rig.lifecycle());
    expect(longTitle).toMatchObject({ kind: "refused", result: { state: "failed" } });
    expect(rig.tasks("Invalid due")).toHaveLength(0);
    expect(rig.receipts()).toHaveLength(0);
    expect(await rig.journal.read(operationId("invalid-due"))).toBeNull();
    expect(await rig.journal.read(operationId("invalid-title"))).toBeNull();
  });

  test("a misrouted or unparsable snapshot is refused before the owner is called", async () => {
    const rig = await open();
    const op = operationId("misrouted");
    await approveBalanceTask(rig, op, { area, title: "Misrouted" });
    const request = await dispatchRequest(rig, op);
    const otherConnection = { ...request.snapshot, connectionId: "connection-other" };
    const otherCapability = { ...request.snapshot, capabilityId: "balance.task.query" };
    const unparsable = { ...request.snapshot, input: { area, title: "Unparsable", due: "tomorrow" } };
    for (const snapshot of [otherConnection, otherCapability, unparsable]) {
      const response = await rig.binding().dispatch({ ...request, snapshot });
      expect(response.result.kind).toBe("failed");
      expect(response.result.kind === "failed" && response.result.evidence).toMatchObject({ kind: "no-effect", final: true });
    }
    expect(rig.tasks("Misrouted")).toHaveLength(0);
    expect(rig.receipts()).toHaveLength(0);
  });

  test("a refusal inside the owner path is a final no-effect result and keeps the draft", async () => {
    const rig = await open();
    const op = operationId("refusal");
    await approveBalanceTask(rig, op, { area, project: project("studio-thread:missing"), title: "Refused task" });
    expect(await rig.lifecycle().activate()).toBe(true);
    expect((await rig.lifecycle().dispatch(op)).kind).toBe("settled");
    const stored = await rig.journal.read(op);
    expect(stored?.journal.state).toBe("failed");
    const failure = stored?.journal.events.find(entry => entry.event.kind === "owner-result" && entry.event.response.result.kind === "failed");
    expect(failure?.event.kind === "owner-result" && failure.event.response.result.kind === "failed" ? failure.event.response.result.evidence : null).toMatchObject({ kind: "no-effect", final: true, receipt: { refused: true, draftKept: true } });
    expect(failure?.event.kind === "owner-result" && balanceTaskCreateOutcome(failure.event.response)).toBe("refused");
    expect(balanceTaskLegacyResult(stored ?? null).state).toBe("failed");
    expect(rig.tasks("Refused task")).toHaveLength(0);
    expect(rig.receipts()).toHaveLength(0);
  });

  test("a stale outline retries once, then refuses with no task and no receipt", async () => {
    const rig = await open();
    const real = rig.writer();
    let calls = 0;
    rig.setOwner({ create: request => { calls++; return calls === 1 ? Promise.reject(new Error(STALE_OUTLINE)) : real.create(request); }, readback: real.readback });
    const first = await rig.facade().create(createTaskRequest(taskFields({ title: "After the first stale" }), operationId("stale-once")), balanceTaskAuthority, rig.lifecycle());
    expect(calls).toBe(2);
    expect(first.kind === "dispatched" && first.result.state).toBe("created");
    expect(rig.tasks("After the first stale")).toHaveLength(1);

    let retries = 0;
    rig.setOwner({ create: () => { retries++; return Promise.reject(new Error(STALE_OUTLINE)); }, readback: real.readback });
    const refused = await rig.facade().create(createTaskRequest(taskFields({ title: "Always stale" }), operationId("stale-twice")), balanceTaskAuthority, rig.lifecycle());
    expect(retries).toBe(2);
    expect(refused.kind === "dispatched" && refused.result).toEqual({ state: "failed", error: STALE_OUTLINE });
    expect(rig.tasks("Always stale")).toHaveLength(0);
    expect(rig.receipts()).toHaveLength(1);
  });

  test("a different owner exception leaves the operation uncertain and lookup reads the receipt after deletion", async () => {
    const rig = await open();
    const real = rig.writer();
    rig.setOwner({ create: async request => { await real.create(request); throw new TypeError("connection reset after write"); }, readback: real.readback });
    const op = operationId("crash");
    const outcome = await rig.facade().create(createTaskRequest(taskFields({ title: "Weigh the glider" }), op), balanceTaskAuthority, rig.lifecycle());
    expect(outcome.kind === "dispatched" && outcome.result.state).toBe("accepted");
    const stored = await rig.journal.read(op);
    expect(stored?.journal.state).toBe("uncertain");
    const [task] = rig.tasks("Weigh the glider");
    if (!task) throw new Error("Expected the owner to create the task before the failed reply.");
    const lookup = await rig.binding().lookup({ lifecycleVersion: "1.0.0", operationId: op, ownerRequestId: operationUuid(op) });
    expect(lookup.result.kind).toBe("known");
    expect(lookup.result.kind === "known" && lookup.result.response.result.kind === "succeeded" && lookup.result.response.result.evidence.refs[0]?.canonicalId).toBe(task.id);
    const operation: OperationRecord = { operationId: op, conversationId: CONVERSATION, proposalId: "crash", revision: 1, owner: "balance-task", state: "uncertain", history: [] };
    expect(await rig.binding().readback(operation)).toEqual({ found: true, canonicalId: task.id });
    rig.removeTask(task.id);
    const deleted = await rig.binding().lookup({ lifecycleVersion: "1.0.0", operationId: op, ownerRequestId: operationUuid(op) });
    expect(deleted.result.kind).toBe("known");
    expect(deleted.result.kind === "known" && deleted.result.response.result.kind === "succeeded" && deleted.result.response.result.evidence.refs[0]?.canonicalId).toBe(task.id);
    expect(await rig.binding().readback(operation)).toEqual({ found: false });
  });

  test("review resolves a unique title and asks for a choice on an ambiguous one without rewriting stored fields", async () => {
    const rig = await open();
    const beforeState = JSON.stringify(rig.state());
    const beforeMeta = JSON.stringify(rig.receipts());
    const uniqueFields = taskFields({ project: " kite ", title: "Fold a kite" });
    const unique = reviewBalanceTask(uniqueFields, rig.state(), rig.areas, BALANCE_TASK_CONNECTION);
    expect(unique.kind).toBe("resolved");
    expect(unique.kind === "resolved" && unique.requiresFreshApproval).toBe(true);
    expect(unique.kind === "resolved" && unique.input.project).toEqual(project("studio-thread:kite"));
    expect(uniqueFields).toEqual(taskFields({ project: " kite ", title: "Fold a kite" }));
    const ambiguousFields = taskFields({ project: "glider", title: "Ambiguous" });
    const ambiguous = reviewBalanceTask(ambiguousFields, rig.state(), rig.areas, BALANCE_TASK_CONNECTION);
    expect(ambiguous.kind).toBe("choice");
    expect(ambiguous.kind === "choice" && ambiguous.options.map(option => option.id).sort()).toEqual(["studio-thread:glider", "studio-thread:glider-two"]);
    expect(ambiguousFields).toEqual(taskFields({ project: "glider", title: "Ambiguous" }));
    expect(JSON.stringify(rig.state())).toBe(beforeState);
    expect(JSON.stringify(rig.receipts())).toBe(beforeMeta);
  });
});
