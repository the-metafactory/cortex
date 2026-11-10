import { afterEach, expect, test } from "bun:test";
import { studioRequestId } from "../../../surface/mc/desk/conversation-ids";
import { createFlowReadAdapter } from "../flow/read";
import { createFlowSaveBinding, flowSaveSupport } from "../flow/save-binding";
import { importLegacyOperation, previewLegacyOperation, projectLegacyOperation, readOperationEvidence } from "../operations/legacy";
import { legacyFixture } from "../operations/legacy-fixtures";
import { createOutcome, resultsOf } from "../operations/owner-results";
import { FLOW_SAVE_NOW, flowSaveAuthority, flowSaveDefinition, flowSaveDispatchRequest, flowSaveRequest, openFlowSaveRig, type FlowSaveRig } from "./fixtures/flow-save-fixtures";
import { assertFlowCreated, assertFlowDeleted, assertFlowRefused, assertFlowUncertain } from "./fixtures/flow-save-checks";

const rigs: FlowSaveRig[] = [];
async function open() { const rig = await openFlowSaveRig(); rigs.push(rig); return rig; }
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });

test("the facade saves once through lifecycle with the original owner request ID, name and hash", async () => {
  const rig = await open();
  await assertFlowCreated(rig);
  const saves = rig.calls.filter(argv => argv.includes("save"));
  expect(saves).toHaveLength(1);
  const argv = saves[0]!;
  expect(argv[argv.indexOf("--request-id") + 1]).toBe(studioRequestId(flowSaveRequest().operationId));
  expect(argv[argv.indexOf("--conversation") + 1]).toBe("conversation-example");
  expect(argv[argv.indexOf("--exchange") + 1]).toBe("save");
  expect(rig.calls.flat().some(arg => ["run", "schedule", "enable"].includes(arg))).toBe(false);
});

test("same-operation facade replay dispatches nothing and a direct owner repeat returns exists with one Flow", async () => {
  const rig = await open();
  await assertFlowCreated(rig);
  const request = flowSaveRequest();
  expect((await rig.create(request)).result).toEqual({ state: "created", canonicalId: request.fields.name! });
  expect(rig.calls.filter(argv => argv.includes("save"))).toHaveLength(1);
  const stored = (await rig.journal.read(request.operationId))!;
  const prepared = stored.journal.events.find(entry => entry.event.kind === "attempt-prepared")!;
  if ("kind" in stored.journal.snapshot || prepared.event.kind !== "attempt-prepared") throw new Error("Approved attempt required.");
  const response = await rig.binding.dispatch({ lifecycleVersion: "1.0.0", operationId: request.operationId, idempotencyKey: request.operationId, ownerRequestId: studioRequestId(request.operationId), attemptId: crypto.randomUUID(), snapshot: stored.journal.snapshot, authority: prepared.event.attempt.authority, supportDeclarationId: rig.binding.support.declarationId, deadlineAt: prepared.event.attempt.deadlineAt });
  expect(createOutcome(response)).toBe("created");
  const first = resultsOf(stored)[0]!;
  expect(response.result.kind === "succeeded" && response.result.output).toEqual(first.result.kind === "succeeded" && first.result.output);
  expect(JSON.parse((await rig.command(["list", "--saved"])).stdout).flows).toHaveLength(1);
});

test("collision, invalid owner YAML and mismatched name are refused and preserve drafts without writes", async () => {
  await assertFlowRefused(await open());
});

test("concurrent owner dispatches deduplicate one request and mismatched content is refused", async () => {
  const rig = await open();
  const request = flowSaveDispatchRequest();
  const responses = await Promise.all([rig.binding.dispatch(request), rig.binding.dispatch({ ...request, attemptId: crypto.randomUUID() })]);
  expect(responses.map(createOutcome)).toEqual(["created", "created"]);
  expect(JSON.parse((await rig.command(["list", "--saved"])).stdout).flows).toHaveLength(1);
  if (typeof request.snapshot.input !== "object" || request.snapshot.input === null || Array.isArray(request.snapshot.input)) throw new Error("Flow input required.");
  const changed = await rig.binding.dispatch({ ...request, snapshot: { ...request.snapshot, input: { ...request.snapshot.input, definition: flowSaveDefinition().replace("text: example", "text: changed") } } });
  expect(createOutcome(changed)).toBe("refused");
});

test("misrouted snapshots, mismatched owner IDs and aborted calls are refused before Pulse", async () => {
  const rig = await open();
  const request = flowSaveDispatchRequest();
  const wrong = [
    { ...request, ownerRequestId: "another-owner-request" },
    { ...request, snapshot: { ...request.snapshot, connectionId: "another-connection" } },
    { ...request, snapshot: { ...request.snapshot, capabilityId: "flow.run" } },
    { ...request, snapshot: { ...request.snapshot, destinations: [] } },
    { ...request, snapshot: { ...request.snapshot, input: { name: "F_SAVE_EXAMPLE" } } },
  ];
  for (const invalid of wrong) expect(createOutcome(await rig.binding.dispatch(invalid))).toBe("refused");
  expect(createOutcome(await rig.binding.dispatch(request, AbortSignal.abort()))).toBe("refused");
  expect((await rig.binding.lookup({ lifecycleVersion: "1.0.0", operationId: request.operationId, ownerRequestId: "another-request" })).result.kind).toBe("unknown");
  expect(rig.calls).toEqual([]);
});

for (const mode of ["exit-2", "invalid-output", "timeout", "wrong-name", "missing-hash"] as const) {
  test(`${mode} after saving is uncertain and request lookup reconciles the journal`, async () => {
    const rig = await open();
    rig.state.mode = mode;
    await assertFlowUncertain(rig);
    const shown = JSON.parse((await rig.command(["show", "F_SAVE_EXAMPLE"])).stdout) as { name: string; sha256: string };
    await assertFlowDeleted(rig, shown);
  });
}

test("historic creation survives real journal reopen and Flow deletion; current availability uses read", async () => {
  const rig = await open();
  const shown = await assertFlowCreated(rig);
  const journal = await rig.reopened();
  const binding = createFlowSaveBinding({ stack: "stack-example", connectionId: "connection-example", flows: () => ({ pulse: rig.pulse }), journal, now: () => FLOW_SAVE_NOW, run: async () => { throw new Error("Historic lookup must not call Pulse."); } });
  await assertFlowDeleted(rig, shown, binding);
  const adapter = createFlowReadAdapter({ connectionId: "connection-example", stack: "stack-example", flowsDir: rig.flowsDir, env: { ...rig.env, PATH: process.env.PATH }, binary: rig.pulse[1] });
  await expect(adapter.query({ readVersion: "1.0.0", queryId: "after-delete", capabilityId: "flow.saved.read", input: { ref: { adapterId: "flow", connectionId: "connection-example", objectType: "saved", canonicalId: "F_SAVE_EXAMPLE" } }, destinations: [adapter.destination], limit: 1 })).rejects.toThrow("flow.source_unavailable");
});

test("a missing owner response and absent Flow stay unknown rather than asserting no effect", async () => {
  const rig = await open();
  rig.state.mode = "exit-2";
  await rig.create();
  const shown = JSON.parse((await rig.command(["show", "F_SAVE_EXAMPLE"])).stdout);
  await rig.command(["delete", shown.name, "--expected-sha256", shown.sha256]);
  const lookup = await rig.binding.lookup({ lifecycleVersion: "1.0.0", operationId: flowSaveRequest().operationId, ownerRequestId: studioRequestId(flowSaveRequest().operationId) });
  expect(lookup.result.kind).toBe("unknown");
});

test("support declares request dedup, historical lookup and no update, cancellation or compensation", () => {
  expect(flowSaveSupport("connection-example")).toMatchObject({ dedup: { kind: "guaranteed", bindsSnapshot: true, concurrent: true }, operationLookup: "historical", conditionalUpdate: "none", cancellation: "none" });
  expect(flowSaveSupport("connection-example").compensationCapabilityId).toBeUndefined();
});

test("quarantined reconciliation cannot become a historic create result", async () => {
  const rig = await open();
  rig.state.mode = "exit-2";
  await rig.create();
  const operationId = flowSaveRequest().operationId;
  const query = { lifecycleVersion: "1.0.0" as const, operationId, ownerRequestId: studioRequestId(operationId) };
  const lookup = await rig.binding.lookup(query);
  if (lookup.result.kind !== "known" || lookup.result.response.result.kind !== "succeeded") throw new Error("Expected Pulse lookup success.");
  lookup.result.response.result.evidence.ownerRequestId = "another-owner-request";
  const stored = (await rig.journal.read(operationId))!;
  const quarantined = await rig.journal.append(operationId, stored.revision, { sequence: stored.journal.sequence + 1, eventId: crypto.randomUUID(), at: new Date(FLOW_SAVE_NOW + 2000).toISOString(), event: { kind: "reconciliation", lookup } });
  expect(quarantined.quarantine).toHaveLength(1);
  expect(resultsOf(quarantined).some(response => response.result.kind === "succeeded")).toBe(false);
  rig.state.configured = false;
  expect((await rig.binding.lookup(query)).result.kind).toBe("unknown");
});

test("unconfigured Pulse refuses without calling the owner and an inactive lifecycle never saves", async () => {
  const rig = await open();
  rig.state.configured = false;
  expect((await rig.create()).result.state).toBe("failed");
  expect(rig.calls).toEqual([]);
  rig.state.configured = true;
  const result = await rig.facade.create(flowSaveRequest("inactive"), flowSaveAuthority, { activate: () => Promise.resolve(false), dispatch: () => { throw new Error("Inactive binding dispatched."); } });
  expect(result.kind).toBe("refused");
  expect(rig.calls).toEqual([]);
});

test("legacy Flow history maps exact evidence and original request ID without granting retry", async () => {
  for (const state of ["created", "uncertain"] as const) {
    const rig = await open();
    const source = legacyFixture(state);
    source.proposal.type = "flow";
    source.proposal.fields = { name: "F_SAVE_EXAMPLE", definition: flowSaveDefinition() };
    source.record.owner = "flow";
    delete source.record.url;
    if (state === "created") {
      source.record.canonicalId = "F_SAVE_EXAMPLE";
      source.createResult = { state: "created", canonicalId: "F_SAVE_EXAMPLE" };
      source.readback = { found: true, canonicalId: "F_SAVE_EXAMPLE" };
    }
    const mapping = { owner: "flow" as const, adapterId: "flow", connectionId: "connection-example", capabilityId: "flow.saved.create", fields: structuredClone(source.proposal.fields), destinations: [{ adapterId: "flow", connectionId: "connection-example", objectType: "stack", canonicalId: "stack-example" }], ...(source.record.canonicalId ? { canonicalReference: { adapterId: "flow", connectionId: "connection-example", objectType: "saved", canonicalId: source.record.canonicalId } } : {}) };
    expect(previewLegacyOperation(source, mapping).issues).toEqual([]);
    expect(previewLegacyOperation(source, { ...mapping, destinations: [] }).issues).toContain("legacy_destination_ambiguous");
    const stored = await importLegacyOperation(rig.journal, source, mapping, new Date(FLOW_SAVE_NOW).toISOString());
    expect(stored.journal.ownerRequestId).toBe(studioRequestId(source.record.operationId));
    expect(stored.retryBlocked).toBe(true);
    expect(readOperationEvidence(stored)).toMatchObject({ kind: "legacy", source, dispatchAllowed: false, retryAllowed: false });
    expect(projectLegacyOperation(stored)).toEqual(source.record);
    await rig.lifecycle().activate();
    expect((await rig.lifecycle().dispatch(source.record.operationId)).kind).toBe("refused");
    expect(rig.calls).toEqual([]);
  }
});
