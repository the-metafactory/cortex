import { randomUUID } from "node:crypto";
import { afterEach, expect, spyOn, test } from "bun:test";
import { observationBinding, observationRig, observationViews, syntheticDeletion, syntheticObservation } from "../reads/observation-fixtures";
import { ObservationScheduler } from "../reads/observation-scheduler";
import { ObservationRetryAfter } from "../reads/observations";
import type { ObservationBatch } from "../reads/observation-types";
import { objectRef } from "../fixtures";
import { ReadBindings } from "../reads/bindings";

const opened: Awaited<ReturnType<typeof observationRig>>[] = [];
const schedulers: ObservationScheduler[] = [];
afterEach(async () => { for (const scheduler of schedulers.splice(0)) scheduler.close(); await Promise.all(opened.splice(0).map(item => item.rig.close())); });
async function open(binding = observationBinding) { const item = await observationRig(binding); opened.push(item); return item; }
async function check(item: Awaited<ReturnType<typeof open>>, batch?: unknown, mode: "poll" | "subscription" | "resync" | "reconcile" = "poll") { if (batch !== undefined) item.hooks.fetch = () => Promise.resolve(batch); return item.store.check(item.rig.context, item.source, item.rig.sink, mode); }
const schedule = (item: Awaited<ReturnType<typeof open>>, mode: "poll" | "subscription" = "poll", boundedResync = false) => {
  const scheduler = new ObservationScheduler(item.store, item.time.clock);
  schedulers.push(scheduler);
  scheduler.configure({ context: item.rig.context, source: item.source, sink: item.rig.sink, mode, boundedResync });
  return scheduler;
};
async function flush() { for (let i = 0; i < 20; i++) await Bun.sleep(1); }

test("push and poll deduplicate one current object and evidence across durable reopen", async () => {
  const item = await open();
  expect((await check(item)).changed).toBe(1);
  expect((await check(item, undefined, "subscription")).changed).toBe(0);
  expect(await observationViews(item)).toMatchObject([{ evidenceCount: 1, value: { title: "Synthetic task" } }]);
  await item.rig.reopen();
  expect(await item.store.checkpoint(item.rig.context, item.source, item.rig.sink)).toBe("synthetic protected checkpoint");
  expect((await check(item)).changed).toBe(0);
  expect((await observationViews(item))[0]?.evidenceCount).toBe(1);
  expect(JSON.stringify(item.rig.calls.sends)).not.toContain("protected checkpoint");
});

test("evidence id payload collisions quarantine instead of overwrite", async () => {
  const item = await open();
  await check(item);
  expect((await check(item, syntheticObservation("task-example", "Conflicting title"))).quarantined).toBe(1);
  expect(await observationViews(item)).toMatchObject([{ value: { title: "Synthetic task" }, status: "conflicted", quarantinedEvidence: 2 }]);
  await item.rig.reopen();
  expect(await observationViews(item)).toMatchObject([{ value: { title: "Synthetic task" }, status: "conflicted" }]);
  expect(await item.store.checkpoint(item.rig.context, item.source, item.rig.sink)).toBeUndefined();
});

test("digest-only A B A reconciles returning content and retains distinct evidence", async () => {
  const binding = structuredClone(observationBinding);
  delete binding.observation!.ordering;
  const item = await open(binding);
  const a = syntheticObservation();
  const b = syntheticObservation("task-example", "B");
  for (const batch of [a, b]) for (const event of batch.events) { delete event.evidenceId; delete event.revision; }
  await check(item, a);
  await check(item, b);
  expect(await observationViews(item)).toMatchObject([{ status: "conflicted", value: { title: "Synthetic task" } }]);
  await check(item, b, "reconcile");
  expect(await observationViews(item)).toMatchObject([{ value: { title: "B" } }]);
  await check(item, a);
  expect(await observationViews(item)).toMatchObject([{ status: "conflicted", value: { title: "B" } }]);
  await check(item, a, "reconcile");
  expect(await observationViews(item)).toMatchObject([{ value: { title: "Synthetic task" } }]);
});

test("trusted owner ordering rejects older revisions and equal conflicting values", async () => {
  const item = await open();
  await check(item, syntheticObservation("task-example", "New", "10", "new"));
  await check(item, syntheticObservation("task-example", "Old", "2", "old"));
  expect(await observationViews(item)).toMatchObject([{ value: { title: "New" }, status: "fresh" }]);
  await check(item, syntheticObservation("task-example", "Same revision conflict", "10", "conflict"));
  expect(await observationViews(item)).toMatchObject([{ value: { title: "New" }, status: "conflicted" }]);
});

test("opaque revisions never acquire lexical order", async () => {
  const item = await open();
  await check(item, syntheticObservation("task-example", "A", "z", "a"));
  await check(item, syntheticObservation("task-example", "B", "aa", "b"));
  expect(await observationViews(item)).toMatchObject([{ value: { title: "A" }, status: "conflicted" }]);
  await check(item, syntheticObservation("task-example", "B", "aa", "b"), "reconcile");
  expect(await observationViews(item)).toMatchObject([{ value: { title: "B" }, status: "fresh" }]);
});

test("failed attempt preserves success time; quiet subscription is stale; denial survives reopen", async () => {
  const item = await open();
  await check(item);
  const success = item.time.clock.now();
  item.time.advance(720000);
  item.hooks.fetch = () => Promise.reject(new Error("Synthetic failure"));
  expect((await check(item)).status).toBe("unavailable");
  expect(await observationViews(item)).toMatchObject([{ status: "stale", lastSuccessAt: success, lastAttemptAt: success + 720000 }]);
  await check(item, { version: "1.0.0", payload: { items: [] }, events: [], coverage: "none", gap: false }, "subscription");
  expect(await observationViews(item)).toMatchObject([{ status: "stale", lastSuccessAt: success }]);
  item.rig.policy.readsAllowed = false;
  expect((await item.store.read(item.rig.context, item.source, item.rig.sink)).kind).toBe("withheld");
  await item.rig.reopen();
  expect((await item.store.read(item.rig.context, item.source, item.rig.sink)).kind).toBe("withheld");
});

test("owner deletion leaves linked metadata only; absence and failure never delete", async () => {
  const item = await open();
  await check(item);
  await item.store.link(item.source, objectRef("balance", "task", "task-example"), "conversation-example");
  for (const absent of [null, { found: false }, { objects: [] }, { version: "1.0.0", payload: { items: [] }, events: [], coverage: "objects", gap: false }]) {
    await check(item, absent);
    expect(await observationViews(item)).toHaveLength(1);
  }
  await check(item, syntheticDeletion());
  expect(await observationViews(item)).toHaveLength(0);
  expect(await observationViews(item, true)).toMatchObject([{ kind: "deleted", evidenceId: "deletion-task-example" }]);
  expect(JSON.stringify(await observationViews(item, true))).not.toContain("Synthetic task");
  await item.rig.reopen();
  expect(await observationViews(item, true)).toHaveLength(1);
  await item.store.link(item.source, objectRef("balance", "task", "task-example"), "conversation-example", false);
  expect(await observationViews(item, true)).toHaveLength(0);
  expect(await item.store.checkpoint(item.rig.context, item.source, item.rig.sink)).toBeUndefined();
  await check(item, syntheticObservation(), "subscription");
  expect(await observationViews(item)).toHaveLength(0);
});

test("retention evicts oldest verified unlinked object and expires content without deletion", async () => {
  const binding = structuredClone(observationBinding);
  binding.observation!.retention.objects = 2;
  binding.observation!.retention.contentMs = 1000;
  const item = await open(binding);
  await check(item, syntheticObservation("linked", "Linked", "1", "linked"));
  await item.store.link(item.source, objectRef("balance", "task", "linked"), "receipt-example");
  item.time.advance(1);
  await check(item, syntheticObservation("old", "Old", "1", "old"));
  item.time.advance(1);
  await check(item, syntheticObservation("new", "New", "1", "new"));
  expect((await observationViews(item)).map(row => row.ref.canonicalId).sort()).toEqual(["linked", "new"]);
  expect(await item.store.checkpoint(item.rig.context, item.source, item.rig.sink)).toBeUndefined();
  item.time.advance(1000);
  expect(await observationViews(item, true)).toHaveLength(0);
  await item.rig.reopen();
  expect(await observationViews(item, true)).toHaveLength(0);
});

test("dedup capacity and age invalidate checkpoints and fence replay", async () => {
  for (const age of [false, true]) {
    const binding = structuredClone(observationBinding);
    binding.observation!.retention.evidence = 1;
    binding.observation!.retention.evidenceMs = 1000;
    const item = await open(binding);
    await check(item);
    if (age) item.time.advance(1001);
    else await check(item, syntheticObservation("other", "Other", "1", "other"));
    expect(await item.store.checkpoint(item.rig.context, item.source, item.rig.sink)).toBeUndefined();
    await item.rig.reopen();
    await check(item, syntheticObservation("replay", "Replay", "1", "replay"), "subscription");
    expect((await observationViews(item)).some(row => row.ref.canonicalId === "replay")).toBe(false);
  }
});

test("invalid schemas scope and provenance fail before persistence", async () => {
  const mutations: ((batch: ObservationBatch) => void)[] = [
    batch => { batch.events[0]!.ref.connectionId = "other-connection"; },
    batch => { batch.events[0]!.destination.canonicalId = "other-area"; },
    batch => { batch.events[0]!.schemaRef.version = "9.0.0"; },
    batch => { batch.payload = { items: [], unmapped: "private" }; },
    batch => { batch.events.push(batch.events[0]!); },
  ];
  for (const mutate of mutations) {
    const item = await open();
    const batch = syntheticObservation();
    mutate(batch);
    expect((await check(item, batch)).status).toBe("unavailable");
    expect(await observationViews(item)).toHaveLength(0);
  }
});

test("current destination restrictions gate cached details and connector entry", async () => {
  const item = await open();
  await check(item);
  item.rig.hooks.restriction = record => Promise.resolve({ ...record, status: "revoked" });
  expect((await item.store.read(item.rig.context, item.source, item.rig.sink)).kind).toBe("withheld");
  expect((await check(item)).status).toBe("denied");
  expect(item.requests).toHaveLength(1);
});

test("account changes invalidate resume and cached content", async () => {
  const item = await open();
  await check(item);
  await item.rig.service.publishHostRecord({ kind: "connection", value: { ...item.rig.connection, connectionRevision: "2", accountScope: { account: "other" } } }, 1);
  expect(await item.store.checkpoint(item.rig.context, item.source, item.rig.sink)).toBeUndefined();
  expect((await item.store.read(item.rig.context, item.source, item.rig.sink)).kind).toBe("withheld");
});

test("scheduler is off before configuration, defaults to 60 seconds and coalesces", async () => {
  const item = await open();
  const scheduler = new ObservationScheduler(item.store, item.time.clock);
  schedulers.push(scheduler);
  item.time.advance(60000);
  expect(item.requests).toHaveLength(0);
  scheduler.configure({ context: item.rig.context, source: item.source, sink: item.rig.sink, mode: "poll" });
  item.time.advance(59999);
  expect(item.requests).toHaveLength(0);
  const pending = Promise.withResolvers<unknown>();
  item.hooks.fetch = () => pending.promise;
  item.time.advance(1);
  await flush();
  const one = scheduler.refresh(item.source.connectionId);
  const two = scheduler.refresh(item.source.connectionId);
  expect(one).toBe(two);
  expect(item.requests).toHaveLength(1);
  pending.resolve(syntheticObservation());
  expect((await one).status).toBe("ok");
  scheduler.disable(item.source.connectionId);
  item.time.advance(60000);
  expect(item.requests).toHaveLength(1);
});

test("dropped subscription retries matching checkpoint at 1 5 30 seconds then unavailable", async () => {
  const item = await open();
  await check(item);
  await item.rig.reopen();
  item.hooks.fetch = () => Promise.reject(new Error("Synthetic dropped stream"));
  const scheduler = schedule(item, "subscription");
  expect((await scheduler.refresh(item.source.connectionId)).status).toBe("unavailable");
  for (const delay of [1000, 5000, 30000]) { item.time.advance(delay - 1); await flush(); const count = item.requests.length; item.time.advance(1); await flush(); expect(item.requests.length).toBe(count + 1); }
  expect(item.requests.slice(1).map(request => request.checkpoint)).toEqual(Array(4).fill("synthetic protected checkpoint"));
  expect(await observationViews(item)).toMatchObject([{ status: "unavailable" }]);
  const count = item.requests.length;
  item.time.advance(120000);
  await flush();
  expect(item.requests).toHaveLength(count);
});

test("Retry-After and bounded explicit resync preserve gap semantics", async () => {
  const item = await open();
  await check(item);
  const scheduler = schedule(item, "subscription");
  item.hooks.fetch = () => Promise.reject(new ObservationRetryAfter(12000));
  await scheduler.refresh(item.source.connectionId);
  const count = item.requests.length;
  item.time.advance(11999);
  await flush();
  expect(item.requests).toHaveLength(count);
  item.time.advance(1);
  await flush();
  expect(item.requests).toHaveLength(count + 1);
  scheduler.close();
  await check(item, syntheticObservation("gap", "Gap", "1", "gap"), "subscription");
  expect((await observationViews(item)).some(row => row.ref.canonicalId === "gap")).toBe(false);
  const repair = schedule(item, "subscription", true);
  await item.store.gap(item.source);
  item.hooks.fetch = () => Promise.resolve(syntheticObservation());
  expect(await observationViews(item)).toMatchObject([{ status: "stale" }]);
  expect((await repair.refresh(item.source.connectionId)).status).toBe("ok");
  expect(item.requests.slice(-2).map(request => request.mode)).toEqual(["resync", "subscription"]);
  expect(await item.store.needsResync(item.rig.context, item.source, item.rig.sink)).toBe(false);
  expect(await observationViews(item)).toMatchObject([{ status: "fresh" }]);
});

test.each(["checkpoint", "gap", "poll"] as const)("scheduler recovers after a transient %s store error", async failure => {
  const item = await open();
  await check(item);
  const scheduler = schedule(item, failure === "poll" ? "poll" : "subscription");
  const fault = new Error("Synthetic transient durable-store failure");
  const mock = failure === "poll" ? spyOn(item.store, "check").mockRejectedValueOnce(fault) : spyOn(item.store, failure).mockRejectedValueOnce(fault);
  if (failure === "gap") item.hooks.fetch = () => Promise.reject(new Error("Synthetic dropped stream"));
  try {
    expect((await scheduler.refresh(item.source.connectionId)).status).toBe("unavailable");
    item.hooks.fetch = () => Promise.resolve(syntheticObservation());
    const count = item.requests.length;
    const delay = failure === "poll" ? 60000 : 1000;
    item.time.advance(delay - 1);
    await flush();
    expect(item.requests).toHaveLength(count);
    item.time.advance(1);
    await flush();
    expect(item.requests).toHaveLength(count + 1);
    expect(mock).toHaveBeenCalled();
  } finally { mock.mockRestore(); }
});

test("fetch timeout suppresses abort-ignoring late observations", async () => {
  const item = await open();
  const pending = Promise.withResolvers<unknown>();
  const entered = Promise.withResolvers<AbortSignal>();
  item.hooks.fetch = (_request, signal) => { entered.resolve(signal); return pending.promise; };
  const checking = check(item);
  const signal = await entered.promise;
  item.time.advance(10000);
  expect((await checking).status).toBe("unavailable");
  expect(signal.aborted).toBe(true);
  pending.resolve(syntheticObservation());
  await flush();
  expect(await observationViews(item)).toHaveLength(0);
});

test("unsupported observation binding is inactive and service dependencies are fixed", async () => {
  const item = await open();
  const bindings = new ReadBindings(item.rig.registry);
  expect(bindings.register({ ...observationBinding, mode: "query" }, { adapterId: "balance", connectionId: item.source.connectionId, readCapabilityIds: [item.source.capabilityId] }).ok).toBe(false);
  expect(item.rig.host.readObservations(item.rig.registry, item.rig.bindings, item.time.clock)).toBe(item.store);
  expect(() => item.rig.host.readObservations(item.rig.registry, item.rig.bindings)).toThrow();
});

test("identical titles on two connections remain distinct through the same host and reopen", async () => {
  const item = await open();
  await check(item);
  const connectionId = "second-connection";
  const destination = { ...item.source.destinations[0]!, connectionId };
  const source = { ...item.source, connectionId, destinations: [destination], input: { title: "Synthetic observation", area: destination } };
  expect(item.rig.readBindings.register(observationBinding, { adapterId: "balance", connectionId, readCapabilityIds: [source.capabilityId] }).ok).toBe(true);
  await item.rig.service.publishHostRecord({ kind: "connection", value: { ...item.rig.connection, connectionId, readDestinations: [destination] } }, 0);
  await item.rig.service.publishHostRecord({ kind: "restriction", value: { ...item.rig.objectRestriction, restrictionRef: randomUUID(), source: destination } }, 0);
  const batch = syntheticObservation();
  batch.events[0]!.ref.connectionId = connectionId;
  batch.events[0]!.destination = destination;
  batch.payload = { items: [{ title: "Synthetic task", area: destination }] };
  item.hooks.fetch = () => Promise.resolve(batch);
  expect((await item.store.check(item.rig.context, source, item.rig.sink)).status).toBe("ok");
  await item.rig.reopen();
  expect(await observationViews(item)).toMatchObject([{ ref: { connectionId: item.source.connectionId }, value: { title: "Synthetic task" } }]);
  expect(await item.store.read(item.rig.context, source, item.rig.sink)).toMatchObject({ kind: "released", value: { objects: [{ ref: { connectionId }, value: { title: "Synthetic task" } }] } });
});

test("current policy changes during connector work suppress late persistence and release", async () => {
  const item = await open();
  const entered = Promise.withResolvers<undefined>();
  const pending = Promise.withResolvers<unknown>();
  item.hooks.fetch = () => { entered.resolve(undefined); return pending.promise; };
  const checking = check(item);
  await entered.promise;
  item.rig.policy.releaseAllowed = false;
  pending.resolve(syntheticObservation());
  expect((await checking).status).not.toBe("ok");
  item.rig.policy.releaseAllowed = true;
  expect(await observationViews(item)).toHaveLength(0);
  expect(item.rig.calls.sends).toHaveLength(1);
});

test("expired content can be reverified unchanged without a new domain event", async () => {
  const item = await open();
  await check(item);
  item.time.advance(86400000);
  expect(await observationViews(item)).toHaveLength(0);
  await check(item);
  expect(await observationViews(item)).toMatchObject([{ value: { title: "Synthetic task" }, evidenceCount: 1 }]);
});

test("configured bounded resync repairs a gap without declaring missing objects deleted", async () => {
  const item = await open();
  await check(item);
  await item.store.gap(item.source);
  const scheduler = schedule(item, "subscription", true);
  item.time.advance(1);
  item.hooks.fetch = request => Promise.resolve(request.mode === "resync" ? syntheticObservation("checked", "Checked", "1", "checked") : { version: "1.0.0", payload: { items: [] }, events: [], gap: false, coverage: "none" });
  await scheduler.refresh(item.source.connectionId);
  expect(item.requests.map(request => request.mode)).toEqual(["poll", "resync", "subscription"]);
  expect((await observationViews(item)).sort((a, b) => a.ref.canonicalId.localeCompare(b.ref.canonicalId))).toMatchObject([{ status: "fresh", ref: { canonicalId: "checked" } }, { status: "stale", ref: { canonicalId: "task-example" } }]);
});

test("default object and evidence budgets support bounded reads and durable reopen", async () => {
  const item = await open();
  for (let revision = 1; revision <= 10; revision++) for (let offset = 0; offset < 1000; offset += 20) {
    const batches = Array.from({ length: 20 }, (_, index) => syntheticObservation(`task-${offset + index}`, "Synthetic task", String(revision), `evidence-${revision}-${offset + index}`));
    const first = batches[0]!;
    const payloads = batches.map(batch => (batch.payload as { items: unknown[] }).items[0]);
    const batch = { ...first, payload: { items: payloads }, events: batches.map((entry, index) => ({ ...entry.events[0]!, pointer: `/items/${index}` })) };
    expect((await check(item, batch)).status).toBe("ok");
    item.time.advance(1);
  }
  const reading = performance.now();
  const full = await observationViews(item);
  expect(performance.now() - reading).toBeLessThan(2000);
  expect(full).toHaveLength(1000);
  expect(full.every(row => row.evidenceCount === 10 && row.quarantinedEvidence === 0)).toBe(true);
  await item.store.link(item.source, objectRef("balance", "task", "task-0"), "receipt-example");
  await check(item, syntheticObservation("overflow", "Synthetic task", "1", "overflow"));
  const before = await observationViews(item);
  expect(before).toHaveLength(1000);
  expect(before.some(row => row.ref.canonicalId === "task-0")).toBe(true);
  expect(before.filter(row => Array.from({ length: 20 }, (_, index) => `task-${index}`).includes(row.ref.canonicalId))).toHaveLength(19);
  const started = performance.now();
  await item.rig.reopen();
  expect(await observationViews(item)).toHaveLength(1000);
  expect(performance.now() - started).toBeLessThan(5000);
}, 120000);

test("all-linked capacity fails without discarding links or advancing a replay checkpoint", async () => {
  const binding = structuredClone(observationBinding);
  binding.observation!.retention.objects = 1;
  const item = await open(binding);
  await check(item);
  await item.store.link(item.source, objectRef("balance", "task", "task-example"), "receipt-example");
  expect((await check(item, syntheticObservation("overflow", "Overflow", "1", "overflow"))).status).toBe("unavailable");
  expect(await observationViews(item)).toMatchObject([{ ref: { canonicalId: "task-example" } }]);
  expect(await item.store.checkpoint(item.rig.context, item.source, item.rig.sink)).toBeUndefined();
});

test("checkpoint expiry and binding changes survive reopen as a stale gap", async () => {
  for (const changed of ["expiry", "binding"] as const) {
    const item = await open();
    const batch = syntheticObservation();
    batch.checkpoint!.expiresAt = item.time.clock.now() + 100;
    await check(item, batch);
    if (changed === "expiry") item.time.advance(101);
    else {
      const binding = structuredClone(observationBinding);
      binding.observation!.staleMs = 1000;
      const bindings = new ReadBindings(item.rig.registry);
      expect(bindings.register(binding, { adapterId: "balance", connectionId: item.source.connectionId, readCapabilityIds: [item.source.capabilityId] }).ok).toBe(true);
      item.rig.bindings.readBindings = bindings;
    }
    await item.rig.reopen();
    expect(await item.store.checkpoint(item.rig.context, item.source, item.rig.sink)).toBeUndefined();
    await check(item, syntheticObservation("replay", "Replay", "1", "replay"), "subscription");
    expect((await item.store.read(item.rig.context, item.source, item.rig.sink)).kind).toBe(changed === "expiry" ? "released" : "withheld");
  }
});

test("current object restrictions tighten destination permission and protect deleted history", async () => {
  const item = await open();
  await check(item);
  const ref = objectRef("balance", "task", "task-example");
  await item.store.link(item.source, ref, "conversation-example");
  await check(item, syntheticDeletion());
  await item.rig.service.publishHostRecord({ kind: "restriction", value: { ...item.rig.objectRestriction, restrictionRef: randomUUID(), source: ref, audiences: ["model"], revision: "1" } }, 0);
  expect((await item.store.read(item.rig.context, item.source, item.rig.sink, true)).kind).toBe("withheld");
  await item.rig.reopen();
  expect((await item.store.read(item.rig.context, item.source, item.rig.sink, true)).kind).toBe("withheld");
});

test("cache expiry during the final policy awaits withholds before sink entry", async () => {
  const binding = structuredClone(observationBinding);
  binding.observation!.retention.contentMs = 1000;
  const item = await open(binding);
  await check(item);
  await item.rig.service.publishHostRecord({ kind: "restriction", value: { ...item.rig.objectRestriction, restrictionRef: randomUUID(), source: objectRef("balance", "task", "task-example") } }, 0);
  let objectChecks = 0;
  item.rig.hooks.restriction = record => {
    if (record.source.objectType === "task" && ++objectChecks === 1) item.time.advance(1000);
    return Promise.resolve(record);
  };
  expect((await item.store.read(item.rig.context, item.source, item.rig.sink)).kind).toBe("withheld");
  expect(item.rig.calls.sends).toHaveLength(0);
});

test("host close aborts pending observations and closed-store work never reaches the reopened projection", async () => {
  const item = await open();
  const entered = Promise.withResolvers<AbortSignal>();
  const pending = Promise.withResolvers<unknown>();
  item.hooks.fetch = (_request, signal) => { entered.resolve(signal); return pending.promise; };
  const checking = check(item);
  const signal = await entered.promise;
  await item.rig.reopen();
  expect(signal.aborted).toBe(true);
  expect((await checking).status).toBe("unavailable");
  pending.resolve(syntheticObservation());
  await flush();
  expect(await observationViews(item)).toHaveLength(0);
});
