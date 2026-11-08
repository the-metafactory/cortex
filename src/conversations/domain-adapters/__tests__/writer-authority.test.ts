import { afterEach, expect, test } from "bun:test";
import { WriterAuthority, writerBindingKey, writerLease } from "../operations/writer-authority";
import { syntheticWriterPlan, syntheticWriterSteps } from "../operations/writer-fixtures";
import { AuthorityPublication } from "../../authority-publication";
import { journalStoreTestFixture } from "./journal-store";
import { authorityRig } from "../../authority-fixtures";

const { open } = journalStoreTestFixture();
const binding = { stack: "test", owner: "synthetic-owner", adapterId: "balance", connectionId: "connection-example", capabilityId: "balance.task.create" };
const rigs: Awaited<ReturnType<typeof authorityRig>>[] = [];
afterEach(async () => { await Promise.all(rigs.splice(0).map(rig => rig.close())); });

test("writer histories persist monotonic epochs, exact binding and idempotent activation", async () => {
  const host = await open();
  let writers = new WriterAuthority(host.engine, new AuthorityPublication());
  const plan = syntheticWriterPlan(binding);
  const begun = await writers.begin(plan, 0);
  expect(await writers.current(writerLease(begun), binding)).toBe(false);
  const active = await writers.resume(begun.bindingKey, syntheticWriterSteps());
  expect(await writers.begin(plan, 0)).toEqual(active);
  expect(await writers.resume(begun.bindingKey, syntheticWriterSteps())).toEqual(active);
  expect(await writers.current(writerLease(active), binding)).toBe(true);
  expect(await writers.current(writerLease(active), { ...binding, connectionId: "other" })).toBe(false);
  expect(await writers.current({ ...writerLease(active), epoch: 0 }, binding)).toBe(false);
  expect(await writers.current({ ...writerLease(active), instanceId: "stale" }, binding)).toBe(false);
  await host.close();
  const reopened = await open(host.dir);
  writers = new WriterAuthority(reopened.engine, new AuthorityPublication());
  expect(await writers.read(active.bindingKey)).toEqual(active);
  expect(await writers.legacyAllowed({ ...binding, connectionId: "other" }, true)).toBe(false);
  await expect(writers.begin({ ...plan, cutoverId: "stale" }, 0)).rejects.toThrow("revision");
  const next = await writers.begin({ ...plan, cutoverId: "second" }, active.revision);
  expect(await writers.current(writerLease(active), binding)).toBe(false);
  const second = await writers.resume(next.bindingKey, syntheticWriterSteps());
  expect(second.epoch).toBe(active.epoch + 1);
  expect(Object.values((await writers.inspect()).records)[0]!.length).toBeGreaterThan(10);
});

for (const stage of ["disable", "stop", "drain", "verify", "import", "acquire", "enable", "active"] as const) {
  test(`crash after durable ${stage} phase resumes with one epoch and no automatic rollback`, async () => {
    const host = await open();
    let crashed = false;
    const faultEngine = {
      snapshot: host.engine.snapshot.bind(host.engine),
      commit: async (...args: any[]) => {
        const result = await (host.engine.commit as any)(...args);
        if (!crashed && result?.stage === stage) { crashed = true; throw new Error("synthetic power loss"); }
        return result;
      },
    };
    const writers = new WriterAuthority(faultEngine, new AuthorityPublication());
    const plan = syntheticWriterPlan(binding);
    try { const begun = await writers.begin(plan, 0); await writers.resume(begun.bindingKey, syntheticWriterSteps()); } catch (error) { expect(String(error)).toContain("power loss"); }
    expect(crashed).toBe(true);
    await host.close();
    const reopened = await open(host.dir);
    const resumed = new WriterAuthority(reopened.engine, new AuthorityPublication());
    const record = await resumed.read(writerBindingKey(binding));
    expect(record?.stage).toBe(stage);
    if (stage !== "active") expect(await resumed.current(writerLease(record!), binding)).toBe(false);
    const active = await resumed.resume(writerBindingKey(binding), syntheticWriterSteps());
    expect(active.epoch).toBe(1);
    expect(active.phase).toBe("active");
  });
}

test("authority connector and cancellation require current durable lease even when supplemental writer policy allows", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  const writers = rig.host.lifecycleWriters();
  const current = await writers.read(rig.lease.bindingKey);
  expect(current).not.toBeNull();
  await writers.begin({ ...current!.plan, cutoverId: "retirement" }, current!.revision);
  rig.hooks.writer = async () => true;
  expect((await rig.service.dispatch(rig.context, request, rig.lease)).kind).toBe("denied");
  expect(rig.calls.dispatch).toBe(0);
  await rig.reopen();
  expect((await rig.service.dispatch(rig.context, request, rig.lease)).kind).toBe("denied");
  expect(rig.calls.dispatch).toBe(0);
});

test("unknown writer, unmanaged inventory, unsupported watermark and mutation downgrade refuse activation", async () => {
  const host = await open();
  const writers = new WriterAuthority(host.engine, new AuthorityPublication());
  await expect(writers.resume("unknown", syntheticWriterSteps())).rejects.toThrow("Unknown writer");
  const plan = syntheticWriterPlan(binding);
  const record = await writers.begin({ ...plan, entries: plan.entries.map(entry => ({ ...entry, kind: "unmanaged" })) }, 0);
  await expect(writers.resume(record.bindingKey, syntheticWriterSteps())).rejects.toThrow("Unmanaged writer");
  expect((await writers.read(record.bindingKey))?.phase).toBe("disabled");
  const next = await writers.begin({ ...plan, cutoverId: "managed" }, (await writers.read(record.bindingKey))!.revision);
  const steps = syntheticWriterSteps();
  await expect(writers.resume(next.bindingKey, { ...steps, watermark: async () => { throw new Error("watermark unavailable"); } })).rejects.toThrow("watermark unavailable");
  expect(await writers.current(writerLease(next), binding)).toBe(false);
  const active = await writers.resume(next.bindingKey, steps);
  await expect(writers.begin({ ...plan, cutoverId: "downgrade", implementation: { ...plan.implementation, version: "0.1.0" } }, active.revision)).rejects.toThrow("downgrade");
  expect(await writers.read(active.bindingKey)).toEqual(active);
});

test("retired durable writer cannot enter the cancellation connector with fresh cancellation confirmation", async () => {
  const rig = await authorityRig(); rigs.push(rig);
  const request = await rig.prepare();
  const cancelId = crypto.randomUUID();
  const confirmed = await rig.service.confirmCancellation(rig.context, request.operationId, cancelId);
  if (confirmed.kind !== "allowed") throw new Error("Synthetic cancellation confirmation unavailable.");
  const current = (await rig.host.lifecycleWriters().read(rig.lease.bindingKey))!;
  await rig.host.lifecycleWriters().begin({ ...current.plan, cutoverId: "retire-cancellation" }, current.revision);
  rig.hooks.writer = async () => true;
  expect((await rig.service.cancel(rig.context, { lifecycleVersion: "1.0.0", operationId: request.operationId, cancelId, authority: confirmed.authority, requestedAt: "2026-11-01T00:00:00.000Z" }, rig.lease)).kind).toBe("denied");
  expect(rig.calls.cancel).toBe(0);
});

test("legacy owner entry remains disabled for every connection across host restart", async () => {
  let calls = 0;
  const rig = await authorityRig(); rigs.push(rig);
  await rig.host.attachSources({ resolvers: {}, readbacks: {}, writers: { "balance-task": { create: async () => { calls++; return { state: "created", canonicalId: "synthetic-object" }; }, readback: async () => null } } });
  const plan = syntheticWriterPlan({ ...binding, owner: "balance-task" });
  await rig.host.lifecycleWriters().begin(plan, 0);
  const request = { operationId: "legacy-synthetic", type: "balance-task" as const, fields: {}, activation: "none" as const, signal: new AbortController().signal, provenance: { conversationId: "synthetic", proposalId: "synthetic", revision: 1, operationId: "legacy-synthetic", entryId: null, link: "synthetic" } };
  expect((await rig.host.writers["balance-task"]!.create(request)).state).toBe("failed");
  expect(calls).toBe(0);
  expect(await rig.host.lifecycleWriters().legacyAllowed({ ...plan.binding, connectionId: "other-account" }, false)).toBe(false);
  await rig.reopen();
  expect(await rig.host.lifecycleWriters().legacyOwnerAllowed(binding.stack, "balance-task")).toBe(false);
});
