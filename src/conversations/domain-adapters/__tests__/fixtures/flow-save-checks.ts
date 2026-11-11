import { strict as assert } from "node:assert";
import { studioRequestId } from "../../../conversation-ids";
import type { FlowSaveBinding } from "../../flow/save-binding";
import { resultsOf } from "../../operations/owner-results";
import { flowSaveDefinition, flowSaveRequest, FLOW_SAVE_NOW, type FlowSaveRig } from "./flow-save-fixtures";

const lookup = (rig: FlowSaveRig, binding = rig.binding) => binding.lookup({ lifecycleVersion: "1.0.0", operationId: flowSaveRequest().operationId, ownerRequestId: studioRequestId(flowSaveRequest().operationId) });

export async function assertFlowCreated(rig: FlowSaveRig) {
  const outcome = await rig.create();
  assert.deepEqual(outcome.result, { state: "created", canonicalId: "F_SAVE_EXAMPLE" });
  assert.equal(outcome.kind, "dispatched");
  const stored = await rig.journal.read(flowSaveRequest().operationId);
  assert.ok(stored);
  assert.equal(stored.journal.state, "succeeded");
  const response = resultsOf(stored).at(-1);
  assert.ok(response?.result.kind === "succeeded");
  const shown = JSON.parse((await rig.command(["show", "F_SAVE_EXAMPLE"])).stdout) as { name: string; sha256: string };
  assert.deepEqual(response.result.evidence.receipt, { name: shown.name, sha256: shown.sha256 });
  assert.deepEqual(response.result.output, { ref: { adapterId: "flow", connectionId: "connection-example", objectType: "saved", canonicalId: shown.name }, name: shown.name, sha256: shown.sha256 });
  assert.equal(await rig.savedCount(), 1);
  return shown;
}

export async function assertFlowRefused(rig: FlowSaveRig) {
  await assertFlowCreated(rig);
  const cases = [
    { id: "collision", fields: { name: "F_SAVE_EXAMPLE", definition: flowSaveDefinition().replace("text: example", "text: different") }, reason: /already named/ },
    { id: "invalid", fields: { name: "F_INVALID", definition: "name: F_INVALID\nactions: wrong\n" }, reason: /actions/i },
    { id: "mismatch", fields: { name: "F_MISMATCH", definition: flowSaveDefinition("F_OTHER") }, reason: /name.*differ/ },
    { id: "malformed", fields: { name: "F_MALFORMED", definition: "name: [" }, reason: /YAML mapping/ },
  ];
  for (const { id, fields, reason } of cases) {
    const request = flowSaveRequest(id, fields);
    const before = structuredClone(request.fields);
    const outcome = await rig.create(request);
    assert.equal(outcome.result.state, "failed");
    assert.ok(outcome.result.state === "failed");
    assert.match(outcome.result.error, reason);
    assert.deepEqual(request.fields, before);
    const stored = await rig.journal.read(request.operationId);
    assert.ok(stored);
    const response = resultsOf(stored).at(-1);
    assert.ok(response?.result.kind === "failed");
    assert.equal(response.result.evidence.kind, "no-effect");
    assert.ok(typeof response.result.evidence.receipt === "object" && response.result.evidence.receipt !== null && "draftKept" in response.result.evidence.receipt && response.result.evidence.receipt.draftKept === true);
  }
  assert.equal(await rig.savedCount(), 1);
}

export async function assertFlowUncertain(rig: FlowSaveRig) {
  const outcome = await rig.create();
  assert.equal(outcome.kind, "dispatched");
  const id = flowSaveRequest().operationId;
  const stored = await rig.journal.read(id);
  assert.ok(stored);
  assert.equal(stored.journal.state, "uncertain");
  const found = await lookup(rig);
  assert.equal(found.result.kind, "known");
  assert.ok(found.result.kind === "known" && found.result.response.result.kind === "succeeded");
  assert.ok(rig.calls.at(-1)?.includes("--request-id"));
  const reconciled = await rig.journal.append(id, stored.revision, { sequence: stored.journal.sequence + 1, eventId: crypto.randomUUID(), at: new Date(FLOW_SAVE_NOW + 2000).toISOString(), event: { kind: "reconciliation", lookup: found } });
  assert.equal(reconciled.journal.state, "succeeded");
  assert.equal(reconciled.outbox.length, 1);
  assert.equal(await rig.savedCount(), 1);
  return found;
}

export async function assertFlowDeleted(rig: FlowSaveRig, shown: { name: string; sha256: string }, binding: FlowSaveBinding = rig.binding) {
  assert.equal((await rig.command(["delete", shown.name, "--expected-sha256", shown.sha256])).code, 0);
  const found = await lookup(rig, binding);
  assert.ok(found.result.kind === "known" && found.result.response.result.kind === "succeeded");
  assert.deepEqual(found.result.response.result.evidence.receipt, { name: shown.name, sha256: shown.sha256 });
  assert.equal((await rig.command(["show", shown.name])).code, 1);
  assert.equal(await rig.savedCount(), 0);
}

export async function assertFlowReplayBlockedAfterDeletion(rig: FlowSaveRig) {
  rig.state.mode = "exit-2";
  await rig.create();
  const id = flowSaveRequest().operationId;
  const shown = JSON.parse((await rig.command(["show", "F_SAVE_EXAMPLE"])).stdout) as { name: string; sha256: string };
  assert.equal((await rig.command(["delete", shown.name, "--expected-sha256", shown.sha256])).code, 0);
  const found = await lookup(rig);
  assert.equal(found.result.kind, "unknown");
  const stored = await rig.journal.read(id);
  assert.ok(stored);
  const reserved = await rig.journal.reserveLookup(id, stored.revision, new Date(FLOW_SAVE_NOW + 2000).toISOString());
  await rig.journal.append(id, reserved.revision, { sequence: reserved.journal.sequence + 1, eventId: crypto.randomUUID(), at: new Date(FLOW_SAVE_NOW + 2000).toISOString(), event: { kind: "reconciliation", lookup: found } });
  rig.state.now = FLOW_SAVE_NOW + 4000;
  rig.state.mode = "normal";
  const retried = await rig.retry(id);
  assert.equal(retried.kind, "not-eligible");
  assert.ok(retried.kind === "not-eligible");
  assert.equal(retried.reason.code, "dedup_unavailable");
  assert.equal(rig.calls.filter(argv => argv.includes("save")).length, 1);
  assert.equal(await rig.savedCount(), 0);
  assert.equal((await rig.journal.read(id))?.journal.state, "uncertain");
}
