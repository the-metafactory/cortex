import assert from "node:assert/strict";
import { withTempHome } from "./probe-temp-home";
import { STALE_OUTLINE } from "../src/surface/mc/desk/balance-outline";
import { operationUuid } from "../src/conversations/conversation-ids";
import { balanceTaskLegacyResult } from "../src/conversations/domain-adapters/balance/task-binding";
import { approveBalanceTask, balanceTaskAuthority, createTaskRequest, operationId, openBalanceTaskRig, taskFields } from "../src/conversations/domain-adapters/__tests__/fixtures/balance-task-fixtures";
import { objectRef } from "../src/conversations/domain-adapters/fixtures";

await withTempHome(async () => {
  const rig = await openBalanceTaskRig();
  try {
    const createId = operationId("probe-create");
    const created = await rig.facade().create(createTaskRequest(taskFields({ project: " kite ", title: "Probe create", note: "From the probe", due: "2026-12-24" }), createId), balanceTaskAuthority, rig.lifecycle());
    assert.equal(created.kind, "dispatched");
    assert.equal(created.kind === "dispatched" && created.result.state, "created");
    const [task] = rig.tasks("Probe create");
    assert.ok(task);
    assert.equal(task.note, "From the probe");
    assert.equal(task.dueDate, "2026-12-24");
    assert.ok(rig.node("studio-thread:kite")?.children.some(child => child.id === task.id));
    assert.deepEqual(rig.receipts().map(receipt => receipt.outlineId), [task.id]);
    assert.equal(rig.receipts()[0]?.id, operationUuid(createId));
    const firstStored = await rig.journal.read(createId);
    assert.equal(firstStored?.journal.state, "succeeded");
    assert.equal(firstStored?.journal.events.filter(entry => entry.event.kind === "attempt-prepared").length, 1);
    assert.equal(firstStored?.journal.events.filter(entry => entry.event.kind === "owner-result").length, 1);
    console.log("create: one legacy owner call, one task and one receipt");

    assert.equal((await rig.lifecycle().dispatch(createId)).kind, "not-dispatchable");
    assert.equal(rig.tasks("Probe create").length, 1);
    assert.equal(rig.receipts().length, 1);
    const repeated = await rig.journal.read(createId);
    assert.equal(repeated?.journal.events.filter(entry => entry.event.kind === "attempt-prepared").length, 1);
    console.log("repeat: no second task, attempt or receipt");

    const approved = await rig.journal.read(createId);
    assert.ok(approved && !("kind" in approved.journal.snapshot));
    const prepared = approved.journal.events.find(entry => entry.event.kind === "attempt-prepared");
    assert.ok(prepared?.event.kind === "attempt-prepared");
    const redispatch = await rig.binding().dispatch({
      lifecycleVersion: "1.0.0",
      operationId: createId,
      attemptId: crypto.randomUUID(),
      idempotencyKey: createId,
      ownerRequestId: operationUuid(createId),
      snapshot: approved.journal.snapshot,
      authority: balanceTaskAuthority,
      supportDeclarationId: rig.binding().support.declarationId,
      deadlineAt: prepared.event.attempt.deadlineAt,
    });
    assert.equal(redispatch.result.kind === "succeeded" && redispatch.result.evidence.refs[0]?.canonicalId, task.id);
    assert.equal(rig.tasks("Probe create").length, 1);
    assert.equal(rig.receipts().length, 1);
    console.log("request-id redispatch: the owner receipt returns the same task and adds no effect");

    const refusalId = operationId("probe-refusal");
    await approveBalanceTask(rig, refusalId, { area: objectRef("balance", "area", "area-example"), project: objectRef("balance", "project", "studio-thread:missing"), title: "Probe refusal" });
    assert.equal(await rig.lifecycle().activate(), true);
    assert.equal((await rig.lifecycle().dispatch(refusalId)).kind, "settled");
    const refused = await rig.journal.read(refusalId);
    assert.equal(refused?.journal.state, "failed");
    assert.equal(balanceTaskLegacyResult(refused ?? null).state, "failed");
    const failure = refused?.journal.events.find(entry => entry.event.kind === "owner-result" && entry.event.response.result.kind === "failed");
    assert.equal(failure?.event.kind === "owner-result" && failure.event.response.result.kind === "failed" && failure.event.response.result.evidence.final, true);
    assert.equal(rig.tasks("Probe refusal").length, 0);
    assert.equal(rig.receipts().length, 1);
    console.log("refusal: final no-effect receipt, no task and no new receipt");

    const real = rig.writer();
    let attempts = 0;
    rig.setOwner({ create: request => { attempts++; return attempts === 1 ? Promise.reject(new Error(STALE_OUTLINE)) : real.create(request); }, readback: real.readback });
    const staleId = operationId("probe-stale");
    const stale = await rig.facade().create(createTaskRequest(taskFields({ title: "Probe stale retry" }), staleId), balanceTaskAuthority, rig.lifecycle());
    assert.equal(attempts, 2);
    assert.equal(stale.kind === "dispatched" && stale.result.state, "created");
    assert.equal(rig.tasks("Probe stale retry").length, 1);
    assert.equal(rig.receipts().length, 2);
    console.log("stale outline: one retry created one task and one receipt");

    let refusedAttempts = 0;
    rig.setOwner({ create: () => { refusedAttempts++; return Promise.reject(new Error(STALE_OUTLINE)); }, readback: real.readback });
    const staleRefusalId = operationId("probe-stale-refused");
    const staleRefusal = await rig.facade().create(createTaskRequest(taskFields({ title: "Probe stale refused" }), staleRefusalId), balanceTaskAuthority, rig.lifecycle());
    assert.equal(refusedAttempts, 2);
    assert.equal(staleRefusal.kind === "dispatched" && staleRefusal.result.state, "failed");
    assert.equal(rig.tasks("Probe stale refused").length, 0);
    assert.equal(rig.receipts().length, 2);
    console.log("stale outline again: refused after one retry, draft kept and no receipt");

    rig.setOwner({ create: async request => { await real.create(request); throw new TypeError("connection reset after write"); }, readback: real.readback });
    const crashId = operationId("probe-crash");
    const crash = await rig.facade().create(createTaskRequest(taskFields({ title: "Probe crash" }), crashId), balanceTaskAuthority, rig.lifecycle());
    assert.equal(crash.kind === "dispatched" && crash.result.state, "accepted");
    const crashed = await rig.journal.read(crashId);
    assert.equal(crashed?.journal.state, "uncertain");
    const [crashTask] = rig.tasks("Probe crash");
    assert.ok(crashTask);
    assert.equal(rig.receipts().length, 3);
    const lookup = await rig.binding().lookup({ lifecycleVersion: "1.0.0", operationId: crashId, ownerRequestId: operationUuid(crashId) });
    assert.equal(lookup.result.kind === "known" && lookup.result.response.result.kind === "succeeded" && lookup.result.response.result.evidence.refs[0]?.canonicalId, crashTask.id);
    console.log("simulated crash: uncertain, and lookup reads the receipt");

    rig.removeTask(crashTask.id);
    const deleted = await rig.binding().lookup({ lifecycleVersion: "1.0.0", operationId: crashId, ownerRequestId: operationUuid(crashId) });
    assert.equal(deleted.result.kind === "known" && deleted.result.response.result.kind === "succeeded" && deleted.result.response.result.evidence.refs[0]?.canonicalId, crashTask.id);
    const readback = await rig.binding().readback({ operationId: crashId, conversationId: "conversation-example", proposalId: "probe-crash", revision: 1, owner: "balance-task", state: "uncertain", history: [] });
    assert.deepEqual(readback, { found: false });
    console.log("deleted task: the historic create is still found and current availability is absent");

    const totalTasks = ["Probe create", "Probe stale retry", "Probe crash"].reduce((sum, title) => sum + rig.tasks(title).length, 0);
    assert.equal(totalTasks, 2);
    assert.deepEqual(rig.receipts().map(receipt => receipt.id), [operationUuid(createId), operationUuid(staleId), operationUuid(crashId)]);
    console.log(JSON.stringify({ creates: 2, refusals: 2, receipts: rig.receipts().length, temporaryStore: true, productionInactive: true }));
  } finally {
    await rig.close();
  }
});
