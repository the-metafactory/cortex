import { afterEach, describe, expect, test } from "bun:test";
import { AuthorityPublication } from "../../../../conversations/authority-publication";
import { journalStoreTestFixture } from "../../../../conversations/domain-adapters/__tests__/journal-store";
import { importLegacyOperation, previewLegacyOperation, readLegacyImportWatermark, readOperationEvidence } from "../../../../conversations/domain-adapters/operations/legacy";
import { legacyContext, legacyFixture } from "../../../../conversations/domain-adapters/operations/legacy-fixtures";
import { syntheticWriterPlan, syntheticWriterSteps } from "../../../../conversations/domain-adapters/operations/writer-fixtures";
import { WriterAuthority, writerLease, type WriterCutoverSteps, type WriterPlan } from "../../../../conversations/domain-adapters/operations/writer-authority";
import { AT } from "../../../../conversations/domain-adapters/operations/fixtures";
import { BALANCE_CREATE_CONTRACTS } from "../../../../conversations/domain-adapters/balance/create-contracts";
import { balanceCreateRoute, balanceCreateRouteOf, routedBalanceCreateWriter as routedBalanceTaskWriter, type BalanceCreateCutover as BalanceTaskCutover, type BalanceCreateCutoverActive as BalanceTaskCutoverActive } from "../balance-create-cutover";
import type { CreateRequest, OwnerWriter } from "../../../../conversations/types";

const { open } = journalStoreTestFixture();
const hosts: Awaited<ReturnType<typeof open>>[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.close())); });

const BINDING = { stack: "test", owner: "balance-task", adapterId: "balance", connectionId: "connection-cutover", capabilityId: "balance.task.create" };
const createRequest = (operationId: string, kind: "task" | "project"): CreateRequest => ({ operationId, type: `balance-${kind}`, fields: { area: "area-example", title: "After cutover" }, activation: "none", signal: new AbortController().signal, provenance: { conversationId: "conversation-example", proposalId: "proposal-example", revision: 1, operationId, entryId: null, link: "?desk=conversation&conversation=conversation-example" } });

function countingWriter(result: "legacy" | "lifecycle"): OwnerWriter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    create: () => { calls.push(result); return Promise.resolve({ state: "created", canonicalId: `${result}-task` }); },
    readback: () => { calls.push(result); return Promise.resolve({ found: true, canonicalId: `${result}-task` }); },
    grantBinding: () => { calls.push(result); return Promise.resolve({ connectionId: BINDING.connectionId, destinations: [{ objectType: "area", canonicalId: "area-example" }] }); },
  };
}

async function authority(label: string, kind: "task" | "project"): Promise<{ host: Awaited<ReturnType<typeof open>>; writers: WriterAuthority; plan: WriterPlan }> {
  const host = await open();
  hosts.push(host);
  return { host, writers: new WriterAuthority(host.engine, new AuthorityPublication()), plan: { ...syntheticWriterPlan({ ...BINDING, owner: `balance-${kind}`, capabilityId: `balance.${kind}.create` }), cutoverId: label } };
}

function failing(stage: "stop" | "enable"): WriterCutoverSteps {
  const steps = syntheticWriterSteps();
  const refusal = () => Promise.reject(new Error(`synthetic ${stage} refused`));
  return { ...steps, ...(stage === "stop" ? { stop: refusal } : { enable: refusal }) };
}

describe.each(["task", "project"] as const)("Balance %s cutover route", kind => {
  const contract = BALANCE_CREATE_CONTRACTS[kind];
  const owner = contract.owner;
  const BINDING = { stack: "test", owner, adapterId: "balance", connectionId: "connection-cutover", capabilityId: `balance.${kind}.create` };
  const request = (operationId: string) => createRequest(operationId, kind);
  const balanceTaskRoute = (writers: import("../balance-create-cutover").BalanceCreateWriterAuthority, stack: string) => balanceCreateRoute(writers, stack, contract);
  const balanceTaskRouteOf = (state: Parameters<typeof balanceCreateRouteOf>[0], stack: string) => balanceCreateRouteOf(state, stack, contract);
  test("without a writer record creation stays on the legacy writer and a cutover record with mutation disabled never falls back to it", async () => {
    const { host, writers, plan } = await authority("begun", kind);
    expect(await balanceTaskRoute(writers, "test")).toEqual({ kind: "legacy" });
    expect(await balanceTaskRoute(writers, "other-stack")).toEqual({ kind: "legacy" });
    const begun = await writers.begin(plan, 0);
    const route = await balanceTaskRouteOf(await writers.inspect(), "test");
    expect(route.kind).toBe("disabled");
    expect(route.kind === "disabled" && route.reason).toContain("waits at disable");
    expect(await writers.current(writerLease(begun), BINDING)).toBe(false);
    const legacy = countingWriter("legacy");
    const lifecycle = countingWriter("lifecycle");
    const cutover: BalanceTaskCutover = { route: () => balanceTaskRoute(writers, "test"), writer: () => lifecycle };
    const routed = routedBalanceTaskWriter({ legacy, cutover });
    expect(await routed.create(request("conversation-example:proposal-example:1"))).toEqual({ state: "failed", error: `${route.kind === "disabled" ? route.reason : ""} Nothing was created.` });
    expect(await routed.readback({ operationId: "conversation-example:proposal-example:1", conversationId: "conversation-example", proposalId: "proposal-example", revision: 1, owner, state: "running", history: [] })).toBeNull();
    expect(legacy.calls).toEqual([]);
    expect(lifecycle.calls).toEqual([]);
    expect(host.journal).toBeDefined();
  });

  test("a refused step leaves mutation disabled on the durable record and a managed restart cannot be leased", async () => {
    const { writers, plan } = await authority("refused", kind);
    const begun = await writers.begin(plan, 0);
    await expect(writers.resume(begun.bindingKey, failing("stop"))).rejects.toThrow("synthetic stop refused");
    const record = await writers.read(begun.bindingKey);
    expect(record?.phase).toBe("disabled");
    expect(record?.failures.at(-1)?.stage).toBe("stop");
    expect(await writers.current(writerLease(record!), BINDING)).toBe(false);
    const route = await balanceTaskRoute(writers, "test");
    expect(route.kind).toBe("disabled");
    expect(route.kind === "disabled" && route.reason).toContain("stopped at stop: synthetic stop refused");
    const legacy = countingWriter("legacy");
    const lifecycle = countingWriter("lifecycle");
    const routed = routedBalanceTaskWriter({ legacy, cutover: { route: () => balanceTaskRoute(writers, "test"), writer: () => lifecycle } });
    expect((await routed.create(request("conversation-example:proposal-example:1"))).state).toBe("failed");
    expect(legacy.calls).toEqual([]);
  });

  test("an active cutover hands creation, readback and the grant binding to the lifecycle writer only", async () => {
    const { writers, plan } = await authority("active", kind);
    const begun = await writers.begin(plan, 0);
    const record = await writers.resume(begun.bindingKey, syntheticWriterSteps());
    expect(record.phase).toBe("active");
    const route = await balanceTaskRoute(writers, "test");
    expect(route.kind).toBe("active");
    expect(route.kind === "active" && route.connectionId).toBe(BINDING.connectionId);
    expect(route.kind === "active" && await writers.current(route.lease, BINDING)).toBe(true);
    const legacy = countingWriter("legacy");
    const lifecycle = countingWriter("lifecycle");
    const routed = routedBalanceTaskWriter({ legacy, cutover: { route: () => balanceTaskRoute(writers, "test"), writer: (_route: BalanceTaskCutoverActive) => lifecycle } });
    expect(await routed.create(request("conversation-example:proposal-example:1"))).toEqual({ state: "created", canonicalId: "lifecycle-task" });
    expect(await routed.readback({ operationId: "conversation-example:proposal-example:1", conversationId: "conversation-example", proposalId: "proposal-example", revision: 1, owner, state: "running", history: [] })).toEqual({ found: true, canonicalId: "lifecycle-task" });
    expect(await routed.grantBinding?.({ area: "area-example", title: "After cutover" })).toEqual({ connectionId: BINDING.connectionId, destinations: [{ objectType: "area", canonicalId: "area-example" }] });
    expect(legacy.calls).toEqual([]);
    expect(lifecycle.calls).toEqual(["lifecycle", "lifecycle", "lifecycle"]);
  });

  test("a read-only downgrade disables mutation and keeps the imported sidecar evidence intact", async () => {
    const { host, writers, plan } = await authority("downgrade", kind);
    const begun = await writers.begin(plan, 0);
    const active = await writers.resume(begun.bindingKey, syntheticWriterSteps());
    const source = legacyFixture("running", kind);
    const context = legacyContext(source);
    const preview = previewLegacyOperation(source, context);
    const sourceEntry = { operationId: preview.source.record.operationId, sourceDigest: preview.sourceDigest };
    const imported = await importLegacyOperation(host.journal, source, context, AT);
    expect(imported.journal.state).toBe("uncertain");
    expect(imported.retryBlocked).toBe(true);
    const evidence = readOperationEvidence(imported);
    expect(evidence.kind).toBe("legacy");
    expect(evidence.kind === "legacy" && evidence.retryAllowed).toBe(false);
    const watermark = await readLegacyImportWatermark(host.journal, [sourceEntry]);
    expect(watermark.sources).toEqual([sourceEntry]);

    const retired = await writers.begin({ ...plan, cutoverId: "read-only" }, active.revision);
    expect(retired.phase).toBe("disabled");
    expect(await writers.current(writerLease(active), BINDING)).toBe(false);
    const route = await balanceTaskRoute(writers, "test");
    expect(route.kind).toBe("disabled");
    const after = readOperationEvidence(await host.journal.read(imported.journal.operationId));
    expect(after).toEqual(evidence);
    expect(await readLegacyImportWatermark(host.journal, [sourceEntry])).toEqual(watermark);
  });
  test("unreadable state and incomplete or conflicting identities keep creation disabled", async () => {
    expect((await balanceTaskRoute({ inspect: () => Promise.reject(new Error("unreadable")) }, "test")).kind).toBe("disabled");
    expect(balanceTaskRouteOf({ records: {}, ownerFences: [JSON.stringify(["test", owner])] }, "test").kind).toBe("disabled");
    const { writers, plan } = await authority("unknown-mapping", kind);
    const started = await writers.begin({ ...plan, binding: { ...plan.binding, capabilityId: "balance.unknown" } }, 0);
    await writers.resume(started.bindingKey, syntheticWriterSteps());
    expect((await balanceTaskRoute(writers, "test")).kind).toBe("disabled");
    expect((await balanceCreateRoute(writers, "test", BALANCE_CREATE_CONTRACTS[kind === "task" ? "project" : "task"])).kind).toBe("legacy");
  });

});
