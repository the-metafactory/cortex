import { afterEach, describe, expect, test } from "bun:test";
import { BALANCE_PROJECT_CONTRACT, balanceProjectApprovedSnapshot, parseBalanceProjectInput } from "../balance/project-binding";
import { STALE_OUTLINE } from "../../../surface/mc/desk/balance-outline";
import { operationUuid } from "../../conversation-ids";
import type { DispatchRequest } from "../operations/types";
import { objectRef } from "../fixtures";
import { BALANCE_TASK_CONNECTION, BALANCE_TASK_NOW, balanceTaskAuthority, createTaskRequest, openBalanceTaskRig, operationId, taskFields, type BalanceTaskRig } from "./fixtures/balance-task-fixtures";

const rigs: BalanceTaskRig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
async function open() {
  const rig = await openBalanceTaskRig(BALANCE_PROJECT_CONTRACT);
  rigs.push(rig);
  return rig;
}
const create = (rig: BalanceTaskRig, title: string, name: string) => rig.facade().create({ ...createTaskRequest(taskFields({ title, note: "Preserved edit" }), operationId(name)), type: "balance-project" }, balanceTaskAuthority, rig.lifecycle());
const record = (op: string) => ({ operationId: op, conversationId: "conversation-example", proposalId: op.split(":")[1]!, revision: 1, owner: "balance-project" as const, state: "uncertain" as const, history: [] });
async function request(rig: BalanceTaskRig, name: string, input: unknown): Promise<DispatchRequest> {
  const operation = operationId(name);
  const snapshot = balanceProjectApprovedSnapshot({ connectionId: BALANCE_TASK_CONNECTION, provenance: { conversationId: "conversation-example", proposalId: name, revision: 1, entryId: null, link: "?desk=conversation&conversation=conversation-example" }, input: parseBalanceProjectInput(input, BALANCE_TASK_CONNECTION) });
  return { lifecycleVersion: "1.0.0", operationId: operation, attemptId: crypto.randomUUID(), idempotencyKey: operation, ownerRequestId: operationUuid(operation), snapshot, authority: balanceTaskAuthority, supportDeclarationId: rig.binding().support.declarationId, deadlineAt: new Date(BALANCE_TASK_NOW + 120_000).toISOString() };
}

describe("Balance project lifecycle binding", () => {
  test("accepts only its area, title and optional note and publishes project evidence", async () => {
    const rig = await open();
    const area = objectRef("balance", "area", "area-example");
    for (const input of [{ title: "No area" }, { area }, { area, title: "Invalid", due: "2026-12-01" }, { area: { ...area, connectionId: "another" }, title: "Wrong connection" }]) expect(() => parseBalanceProjectInput(input, BALANCE_TASK_CONNECTION)).toThrow();
    expect(rig.binding().support).toMatchObject({ capabilityId: "balance.project.create", operationLookup: "historical", dedup: { concurrent: true, bindsSnapshot: true } });
    const result = await create(rig, "One project", "one");
    expect(result.kind === "dispatched" && result.result).toMatchObject({ state: "created" });
    const project = rig.tasks("One project")[0]!;
    expect(project).toMatchObject({ done: true, children: [], note: "Preserved edit" });
    const stored = await rig.journal.read(operationId("one"));
    const evidence = stored?.journal.events.find(entry => entry.event.kind === "owner-result");
    expect(evidence?.event.kind === "owner-result" && evidence.event.response.result).toMatchObject({ kind: "succeeded", evidence: { refs: [objectRef("balance", "project", project.id)] } });
    const repeat = await create(rig, "One project", "one");
    expect(repeat.kind === "dispatched" && repeat.result).toMatchObject({ state: "created", canonicalId: project.id });
    expect(rig.tasks("One project")).toHaveLength(1);
    expect(rig.receipts()).toHaveLength(1);
  });

  test("refuses a removed area and malformed or misrouted snapshots before calling the owner", async () => {
    const rig = await open();
    let calls = 0;
    rig.setOwner({ create: () => { calls++; return Promise.resolve({ state: "created", canonicalId: "project:unexpected" }); }, readback: () => Promise.resolve(null) });
    const valid = await request(rig, "invalid", { area: objectRef("balance", "area", "area-example"), title: "A project" });
    for (const snapshot of [{ ...valid.snapshot, capabilityId: "balance.task.create" }, { ...valid.snapshot, connectionId: "another" }, { ...valid.snapshot, input: { title: "Missing area" } }]) expect((await rig.binding().dispatch({ ...valid, snapshot })).result.kind).toBe("failed");
    rig.areas.splice(0, rig.areas.length);
    expect(await create(rig, "Removed area", "removed")).toMatchObject({ kind: "refused", reason: expect.stringContaining("not a configured area") });
    expect(calls).toBe(0);
    expect(rig.receipts()).toHaveLength(0);
  });

  test("retries a stale outline once and records final no-effect on repeated staleness or refusal", async () => {
    const rig = await open();
    const owner = rig.writer();
    let calls = 0;
    rig.setOwner({ create: input => ++calls === 1 ? Promise.reject(new Error(STALE_OUTLINE)) : owner.create(input), readback: owner.readback });
    expect((await create(rig, "After stale", "stale-once")).result.state).toBe("created");
    expect(calls).toBe(2);
    calls = 0;
    rig.setOwner({ create: () => { calls++; return Promise.reject(new Error(STALE_OUTLINE)); }, readback: owner.readback });
    expect((await create(rig, "Always stale", "stale-twice")).result).toEqual({ state: "failed", error: STALE_OUTLINE });
    expect(calls).toBe(2);
    expect((await rig.journal.read(operationId("stale-twice")))?.journal.state).toBe("failed");
    rig.setOwner({ create: () => Promise.resolve({ state: "failed", error: "Owner refused" }), readback: owner.readback });
    expect((await create(rig, "Refused", "refused")).result).toEqual({ state: "failed", error: "Owner refused" });
    expect(rig.receipts()).toHaveLength(1);
  });

  test("unknown results never retry; historic success survives removal while current readback reports missing", async () => {
    const rig = await open();
    const owner = rig.writer();
    let calls = 0;
    rig.setOwner({ create: async input => { calls++; await owner.create(input); throw new TypeError("reply lost after write"); }, readback: owner.readback });
    const op = operationId("unknown");
    expect((await create(rig, "Unknown project", "unknown")).result.state).toBe("accepted");
    expect((await rig.journal.read(op))?.journal.state).toBe("uncertain");
    await rig.lifecycle().dispatch(op);
    expect(calls).toBe(1);
    const project = rig.tasks("Unknown project")[0]!;
    expect(await rig.binding().readback(record(op))).toEqual({ found: true, canonicalId: project.id });
    rig.removeTask(project.id);
    expect(await rig.binding().readback(record(op))).toEqual({ found: false });
    const lookup = await rig.binding().lookup({ lifecycleVersion: "1.0.0", operationId: op, ownerRequestId: operationUuid(op) });
    expect(lookup.result).toMatchObject({ kind: "known", response: { result: { kind: "succeeded", evidence: { refs: [objectRef("balance", "project", project.id)] } } } });
    expect(rig.receipts()).toHaveLength(1);
  });
});
