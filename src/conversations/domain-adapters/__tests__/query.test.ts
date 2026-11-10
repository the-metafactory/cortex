import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { controlledQueryClock, queryBinding, queryRig, syntheticQueryPage } from "../reads/query-fixtures";
import { QueryRequestSchema, type QueryRequest } from "../reads/query-types";
import { ReadBindings } from "../reads/bindings";
import type { Json } from "../operations/types";
import type { ReadBinding } from "../reads/types";
import type { Session, CommitPublication } from "@earendil-works/pi-durable";
import { QueryStore, type StoredQuery } from "../reads/query-store";
import { queryRegistry } from "../reads/query-fixtures";

const opened: Awaited<ReturnType<typeof queryRig>>[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(item => item.rig.close())); });
async function open(clock?: ReturnType<typeof controlledQueryClock>["clock"]) { const item = await queryRig(clock); opened.push(item); return item; }
async function begin(item: Awaited<ReturnType<typeof open>>) { return item.runner.create(item.rig.context, [item.source], item.rig.sink); }
const resume = (request: QueryRequest, continuation: string | undefined): QueryRequest => ({ ...request, continuation });
const objects = (value: Json | undefined): { ref: { canonicalId: string } }[] => (value as { objects: { ref: { canonicalId: string } }[] }).objects;
function rebind(item: Awaited<ReturnType<typeof open>>, binding: ReadBinding) { const next = new ReadBindings(item.rig.registry); expect(next.register(binding, { adapterId: "balance", connectionId: item.source.connectionId, readCapabilityIds: [item.source.capabilityId] }).ok).toBe(true); item.rig.bindings.readBindings = next; }

test("failed durable setup releases active ownership so the query can be retried", async () => {
  const item = await open();
  const request = await begin(item);
  const failed = spyOn(QueryStore.prototype, "change").mockRejectedValueOnce(new Error("Synthetic commit failure."));
  try {
    await expect(item.runner.run(item.rig.context, request, item.rig.sink)).rejects.toThrow("Synthetic commit failure.");
  } finally { failed.mockRestore(); }
  expect((await item.runner.run(item.rig.context, request, item.rig.sink)).status).toBe("ok");
  expect(item.rig.calls.read).toBe(1);
});

test("query service configuration is fixed and rejects changed dependencies", async () => {
  const time = controlledQueryClock();
  const item = await open(time.clock);
  const runner = item.runner;
  expect(item.rig.host.readQueries(item.rig.registry, item.rig.bindings, time.clock)).toBe(runner);
  for (const [registry, bindings, clock] of [
    [queryRegistry(), item.rig.bindings, time.clock],
    [item.rig.registry, { ...item.rig.bindings }, time.clock],
    [item.rig.registry, item.rig.bindings, controlledQueryClock().clock],
    [item.rig.registry, item.rig.bindings, undefined],
  ] as const) expect(() => item.rig.host.readQueries(registry, bindings, clock)).toThrow();
});

test("closed host-generated envelope and exact input pin are checked before fetch", async () => {
  const item = await open();
  const request = await begin(item);
  for (const raw of [{ ...request, privateContext: "forged" }, { ...request, queryId: randomUUID() }, { ...request, sources: [{ ...item.source, input: { title: "missing area" } }] }, { ...request, sources: [{ ...item.source, inputSchemaRef: { ...item.source.inputSchemaRef, version: "1.0.1" } }] }]) {
    expect((await item.runner.run(item.rig.context, raw, item.rig.sink)).restartRequired).toBe(true);
  }
  expect(item.rig.calls.read).toBe(0);
  expect((await item.runner.run(item.rig.context, request, item.rig.sink)).status).toBe("ok");
  expect(item.rig.calls.read).toBe(1);
  expect(QueryRequestSchema.safeParse({ ...request, readVersion: "2.0.0" }).success).toBe(false);
});

test("protected exact cursor survives durable reopen and never reaches a sink or result", async () => {
  const item = await open();
  const cursor = " secret provider cursor \n /+?=\u0000 ";
  const seen: (string | undefined)[] = [];
  item.rig.hooks.query = request => { seen.push(request.cursor); return Promise.resolve(syntheticQueryPage([seen.length === 1 ? "a" : "b"], seen.length === 1 ? cursor : undefined)); };
  const request = await begin(item);
  const page1 = await item.runner.run(item.rig.context, request, item.rig.sink);
  expect(page1.continuation).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify([page1, item.rig.calls.sends])).not.toContain("provider cursor");
  await item.rig.reopen();
  const page2 = await item.runner.run(item.rig.context, resume(request, page1.continuation), item.rig.sink);
  expect(page2.status).toBe("ok");
  expect(seen).toEqual([undefined, cursor]);
  expect(page2.continuation).toBeUndefined();
  expect((await item.runner.run(item.rig.context, resume(request, page1.continuation), item.rig.sink)).restartRequired).toBe(true);
});

test("whole payload, annotation pointers, scope, identities and display are atomic", async () => {
  const mutations: ((page: ReturnType<typeof syntheticQueryPage>) => void)[] = [
    page => { (page.payload as { items: unknown[] }).items.push({ invalid: "private" }); },
    page => { page.annotations[0]!.pointer = "/missing"; },
    page => { page.annotations[0]!.ref.connectionId = "other-account"; },
    page => { page.annotations[0]!.destination.canonicalId = "other-area"; },
    page => { page.annotations[0]!.schemaRef.version = "9.0.0"; },
    page => { page.annotations.push({ ...page.annotations[0]! }); },
    page => { (page.payload as { items: { title: unknown }[] }).items[0]!.title = 9; },
  ];
  for (const mutate of mutations) {
    const item = await open();
    const page = syntheticQueryPage(["valid", "invalid"]);
    mutate(page);
    item.rig.hooks.query = () => Promise.resolve(page);
    const result = await item.runner.run(item.rig.context, await begin(item), item.rig.sink);
    expect(result.noMatch).toBe(false);
    expect(result.groups[0]?.status).toBe("unavailable");
    expect(item.rig.calls.sends).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("invalid");
  }
});

test("continuations reject changed policy context, connection, restriction, binding pin, input, principal and expiry", async () => {
  const changes: ((item: Awaited<ReturnType<typeof open>>) => Promise<void>)[] = [
    async item => { item.rig.policy.contextRevision = "changed"; },
    async item => { item.rig.policy.work = { changed: true }; },
    async item => { await item.rig.service.publishHostRecord({ kind: "connection", value: { ...item.rig.connection, connectionRevision: "2", accountScope: { changed: true } } }, 1); },
    async item => { await item.rig.service.publishHostRecord({ kind: "restriction", value: { ...item.rig.objectRestriction, revision: "2", audiences: ["web"] } }, 1); },
    async item => { rebind(item, { ...queryBinding, display: { title: "/area/canonicalId" } }); },
    async item => { item.rig.hooks.sessionEnabled = false; },
  ];
  for (const change of changes) {
    const item = await open();
    item.rig.hooks.query = () => Promise.resolve(syntheticQueryPage(["a"], "private"));
    const request = await begin(item);
    const first = await item.runner.run(item.rig.context, request, item.rig.sink);
    await change(item);
    expect((await item.runner.run(item.rig.context, resume(request, first.continuation), item.rig.sink)).restartRequired).toBe(true);
    expect(item.rig.calls.read).toBe(1);
  }
  const time = controlledQueryClock();
  const item = await open(time.clock);
  item.rig.hooks.query = () => Promise.resolve(syntheticQueryPage(["a"], "private"));
  const request = await begin(item);
  const first = await item.runner.run(item.rig.context, request, item.rig.sink);
  time.advance(600000);
  expect((await item.runner.run(item.rig.context, resume(request, first.continuation), item.rig.sink)).restartRequired).toBe(true);
});

test("binding changes and revocation during fetch prevent sink entry", async () => {
  for (const kind of ["binding", "restriction", "object"] as const) {
    const item = await open();
    item.rig.hooks.query = async () => {
      if (kind === "binding") rebind(item, { ...queryBinding, display: { title: "/area/canonicalId" } });
      else if (kind === "restriction") await item.rig.service.publishHostRecord({ kind: "restriction", value: { ...item.rig.objectRestriction, revision: "2", status: "revoked" } }, 1);
      else await item.rig.service.publishHostRecord({ kind: "restriction", value: { ...item.rig.objectRestriction, restrictionRef: randomUUID(), source: syntheticQueryPage().annotations[0]!.ref, audiences: [], revision: "1" } }, 0);
      return syntheticQueryPage();
    };
    const result = await item.runner.run(item.rig.context, await begin(item), item.rig.sink);
    expect(item.rig.calls.sends).toHaveLength(0);
    expect(result.noMatch).toBe(false);
  }
});

test("provider order, canonical tie-break and dedup survive pages without raw-payload bypass", async () => {
  const item = await open();
  let count = 0;
  item.rig.hooks.query = () => {
    const page = syntheticQueryPage(count++ === 0 ? ["b", "a", "b"] : ["b", "c"], count === 1 ? "cursor" : undefined);
    page.annotations.forEach(entry => { entry.position = 1; });
    return Promise.resolve(page);
  };
  const request = await begin(item);
  const first = await item.runner.run(item.rig.context, request, item.rig.sink);
  expect(objects(item.rig.calls.sends[0]).map(item => item.ref.canonicalId)).toEqual(["a", "b"]);
  const second = await item.runner.run(item.rig.context, resume(request, first.continuation), item.rig.sink);
  expect(second.status).toBe("ok");
  expect(objects(item.rig.calls.sends[1]).map(item => item.ref.canonicalId)).toEqual(["c"]);
  expect(JSON.stringify(second)).not.toContain('"payload"');
});

test("only exhausted stable empty queries report no-match; empty continuation and live pages do not", async () => {
  for (const [cursor, stable, expected] of [[undefined, true, true], ["cursor", true, false], [undefined, false, false]] as const) {
    const item = await open();
    item.rig.hooks.query = () => Promise.resolve(syntheticQueryPage([], cursor, stable));
    const result = await item.runner.run(item.rig.context, await begin(item), item.rig.sink);
    expect(result.noMatch).toBe(expected);
  }
});

test("model continuation uses one 60-item invocation budget without a separate page cap", async () => {
  const item = await open();
  let count = 0;
  item.rig.hooks.query = () => Promise.resolve(syntheticQueryPage([`item-${count++}`], "cursor"));
  const invocation = item.runner.invocation();
  let request = await begin(item);
  for (let page = 0; page < 60; page++) {
    const result = await item.runner.run(item.rig.context, request, item.rig.sink, invocation);
    expect(result.continuation).toBeDefined();
    request = resume(request, result.continuation);
  }
  const stopped = await item.runner.run(item.rig.context, request, item.rig.sink, invocation);
  expect(stopped.groups[0]?.status).toBe("not-attempted");
  expect(stopped.noMatch).toBe(false);
  expect(item.rig.calls.read).toBe(60);
  const more = await item.runner.run(item.rig.context, resume(request, stopped.continuation), item.rig.sink);
  expect(more.status).toBe("partial");
  expect(objects(item.rig.calls.sends.at(-1))).toHaveLength(1);
});

test("20-item pages, 1 MiB and tighter binding limits fail closed", async () => {
  for (const kind of ["items", "bytes", "tight"] as const) {
    const item = await open();
    if (kind === "tight") rebind(item, { ...queryBinding, query: { ...queryBinding.query!, limits: { items: 1, bytes: 10000, pageMs: 100 } } });
    item.rig.hooks.query = request => {
      expect(request.limit).toBe(kind === "tight" ? 1 : 20);
      return Promise.resolve(syntheticQueryPage(kind === "bytes" ? ["x".repeat(1048576)] : Array.from({ length: kind === "tight" ? 2 : 21 }, (_, index) => String(index))));
    };
    const result = await item.runner.run(item.rig.context, await begin(item), item.rig.sink);
    expect(result.noMatch).toBe(false);
    expect(item.rig.calls.sends).toHaveLength(0);
  }
});

test("cancellation during page 2 aborts the connector, retains page 1 and suppresses a late response", async () => {
  const item = await open();
  item.rig.hooks.query = () => Promise.resolve(syntheticQueryPage(["page-1"], "cursor"));
  const request = await begin(item);
  const first = await item.runner.run(item.rig.context, request, item.rig.sink);
  const entered = Promise.withResolvers<AbortSignal>();
  const late = Promise.withResolvers<unknown>();
  item.rig.hooks.query = (_request, signal) => { entered.resolve(signal); return late.promise; };
  const pending = item.runner.run(item.rig.context, resume(request, first.continuation), item.rig.sink);
  const signal = await entered.promise;
  expect((await item.runner.cancel(request.queryId)).status).toBe("cancelled");
  expect(signal.aborted).toBe(true);
  expect((await pending).status).toBe("cancelled");
  late.resolve(syntheticQueryPage(["late-private"]));
  await Bun.sleep(10);
  expect(item.rig.calls.sends).toHaveLength(1);
  expect(JSON.stringify(item.rig.calls.sends)).toContain("page-1");
  expect((await item.runner.run(item.rig.context, resume(request, first.continuation), item.rig.sink)).restartRequired).toBe(true);
});

test("page timeout and the shared 30-second deadline abort without releasing late data", async () => {
  const time = controlledQueryClock();
  const item = await open(time.clock);
  const entered = Promise.withResolvers<AbortSignal>();
  const late = Promise.withResolvers<unknown>();
  item.rig.hooks.query = (_request, signal) => { entered.resolve(signal); return late.promise; };
  const pending = item.runner.run(item.rig.context, await begin(item), item.rig.sink);
  const signal = await entered.promise;
  time.advance(10000);
  expect((await pending).groups[0]?.reason?.code).toBe("deadline_exceeded");
  expect(signal.aborted).toBe(true);
  late.resolve(syntheticQueryPage(["late"]));
  await Bun.sleep(10);
  expect(item.rig.calls.sends).toHaveLength(0);
  const invocation = item.runner.invocation();
  time.advance(30000);
  const stopped = await item.runner.run(item.rig.context, await begin(item), item.rig.sink, invocation);
  expect(stopped.groups[0]?.status).toBe("not-attempted");
  expect(item.rig.calls.read).toBe(1);
});

test("selected source groups share 60 items and two fetches, leaving untouched sources explicit", async () => {
  const item = await open();
  const sources = Array.from({ length: 5 }, (_, index) => ({ ...item.source, input: { ...item.source.input as object, title: `source-${index}` } }));
  const waiting: { release: (value: unknown) => void; title: string }[] = [];
  const firstTwo = Promise.withResolvers<undefined>();
  const third = Promise.withResolvers<undefined>();
  let active = 0;
  let peak = 0;
  item.rig.hooks.query = request => {
    active++;
    peak = Math.max(peak, active);
    const title = (request.input as { title: string }).title;
    const pending = Promise.withResolvers<unknown>();
    waiting.push({ release: pending.resolve, title });
    if (waiting.length === 2) firstTwo.resolve(undefined);
    if (waiting.length === 3) third.resolve(undefined);
    return pending.promise.finally(() => { active--; });
  };
  const request = await item.runner.create(item.rig.context, sources, item.rig.sink);
  const running = item.runner.run(item.rig.context, request, item.rig.sink);
  await firstTwo.promise;
  expect(active).toBe(2);
  waiting[0]!.release(syntheticQueryPage(Array.from({ length: 20 }, (_, i) => `a-${i}`)));
  await third.promise;
  waiting[1]!.release(syntheticQueryPage(Array.from({ length: 20 }, (_, i) => `b-${i}`)));
  waiting[2]!.release(syntheticQueryPage(Array.from({ length: 20 }, (_, i) => `c-${i}`)));
  const result = await running;
  expect(peak).toBe(2);
  expect(item.rig.calls.read).toBe(3);
  expect(result.groups.map(group => group.status)).toEqual(["ok", "ok", "ok", "not-attempted", "not-attempted"]);
  expect(result.noMatch).toBe(false);
  expect(result.continuation).toBeDefined();
  await expect(item.runner.create(item.rig.context, Array.from({ length: 11 }, (_, index) => ({ ...item.source, connectionId: `connection-${index}` })), item.rig.sink)).rejects.toThrow();
});

test("denied selections expose no hidden source names or counts while failures preserve other groups", async () => {
  const item = await open();
  const hidden = { ...item.source, connectionId: "hidden-account", destinations: [{ ...item.source.destinations[0]!, canonicalId: "hidden-project" }] };
  const failed = { ...item.source, input: { ...item.source.input as object, title: "failure" } };
  item.rig.hooks.query = request => (request.input as { title: string }).title === "failure" ? Promise.reject(new Error("hidden provider account and private cursor")) : Promise.resolve(syntheticQueryPage([]));
  const request = await item.runner.create(item.rig.context, [item.source, hidden, failed], item.rig.sink);
  const result = await item.runner.run(item.rig.context, request, item.rig.sink);
  expect(result.status).toBe("partial");
  expect(result.restricted).toBe(true);
  expect(result.groups.map(group => group.status)).toEqual(["ok", "unavailable"]);
  expect(result.noMatch).toBe(false);
  expect(JSON.stringify(result)).not.toContain("hidden");
  expect(JSON.stringify(result)).not.toContain("count");
});

test("changed snapshot, conflicting revisions and untrusted stable-snapshot claims require restart", async () => {
  for (const kind of ["snapshot", "revision", "attestation"] as const) {
    const item = await open();
    if (kind === "attestation") rebind(item, { ...queryBinding, query: { ...queryBinding.query!, stableSnapshot: false } });
    let calls = 0;
    item.rig.hooks.query = () => {
      const page = syntheticQueryPage(["same"], "cursor");
      if (calls++ > 0) {
        if (kind === "snapshot") page.snapshot = { kind: "stable", id: "different" };
        else page.annotations[0]!.evidence.revision = "different";
      }
      return Promise.resolve(page);
    };
    const request = await begin(item);
    const first = await item.runner.run(item.rig.context, request, item.rig.sink);
    if (kind === "attestation") expect(item.rig.calls.sends).toHaveLength(0);
    else {
      const second = await item.runner.run(item.rig.context, resume(request, first.continuation), item.rig.sink);
      expect(second.groups[0]?.status).toBe("unavailable");
      expect(second.continuation).toBeUndefined();
      expect(item.rig.calls.sends).toHaveLength(1);
    }
  }
});

test("30-second budget also bounds current-policy resolution with no fetch after timeout", async () => {
  const time = controlledQueryClock();
  const item = await open(time.clock);
  const request = await begin(item);
  const entered = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  item.rig.hooks.policy = () => { entered.resolve(undefined); return gate.promise; };
  const pending = item.runner.run(item.rig.context, request, item.rig.sink);
  await entered.promise;
  time.advance(30000);
  expect((await pending).reason?.code).toBe("deadline_exceeded");
  gate.resolve(undefined);
  await Bun.sleep(10);
  expect(item.rig.calls.read).toBe(0);
});

test("a permitted source lacking the query protocol is explicitly unsupported", async () => {
  const item = await open();
  const { query: _query, ...legacy } = queryBinding;
  rebind(item, legacy);
  const result = await item.runner.run(item.rig.context, await begin(item), item.rig.sink);
  expect(result.status).toBe("unsupported");
  expect(result.groups[0]?.status).toBe("unsupported");
  expect(item.rig.calls.read).toBe(0);
  expect(result.noMatch).toBe(false);
});

test("every released annotation resolves after canonical sorting and deduplication", async () => {
  const item = await open();
  item.rig.hooks.query = () => Promise.resolve(syntheticQueryPage(["b", "b", "a"]));
  const result = await item.runner.run(item.rig.context, await begin(item), item.rig.sink);
  const page = item.rig.calls.sends[0];
  expect(JSON.stringify(result)).not.toContain("objects");
  expect(page).toBeDefined();
  const entries = (page as { objects: { pointer: string; value: Json }[] }).objects;
  const { readPointer } = await import("../reads/query-validation");
  for (const entry of entries) expect(readPointer(page as Json, entry.pointer)).toEqual(entry.value);
});

test("timed-out sinks cannot refund already released items to a model invocation", async () => {
  const time = controlledQueryClock();
  const item = await open(time.clock);
  const invocation = item.runner.invocation();
  const entered = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  item.rig.hooks.sink = () => { entered.resolve(undefined); return gate.promise; };
  item.rig.hooks.query = () => Promise.resolve(syntheticQueryPage(Array.from({ length: 20 }, (_, i) => `a-${i}`)));
  const pending = item.runner.run(item.rig.context, await begin(item), item.rig.sink, invocation);
  await entered.promise;
  time.advance(10000);
  expect((await pending).groups[0]?.reason?.code).toBe("deadline_exceeded");
  gate.resolve(undefined);
  item.rig.hooks.sink = undefined;
  for (let i = 0; i < 3; i++) await item.runner.run(item.rig.context, await begin(item), item.rig.sink, invocation);
  expect(item.rig.calls.read).toBe(3);
  expect(item.rig.calls.sends).toHaveLength(3);
});

test("cancellation in durable setup aborts before any fetch or release", async () => {
  const item = await open();
  const request = await begin(item);
  const original = QueryStore.prototype.change;
  const entered = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  const intercepted = spyOn(QueryStore.prototype, "change").mockImplementationOnce(async function <T>(this: QueryStore, queryId: string, change: (query: StoredQuery | undefined) => T) {
    const result = await original.bind(this)<T>(queryId, change);
    entered.resolve(undefined);
    await gate.promise;
    return result;
  });
  try {
    const pending = item.runner.run(item.rig.context, request, item.rig.sink);
    await entered.promise;
    await item.runner.cancel(request.queryId);
    gate.resolve(undefined);
    expect((await pending).status).toBe("cancelled");
    expect(item.rig.calls.read).toBe(0);
    expect(item.rig.calls.sends).toHaveLength(0);
  } finally { intercepted.mockRestore(); }
});

test("runner returns no earlier payload after a second source revokes current access", async () => {
  const item = await open();
  const released = Promise.withResolvers<undefined>();
  item.rig.hooks.sink = () => { released.resolve(undefined); return Promise.resolve(); };
  item.rig.hooks.query = async request => {
    if ((request.input as { title: string }).title === "second") {
      await released.promise;
      await item.rig.service.publishHostRecord({ kind: "restriction", value: { ...item.rig.objectRestriction, revision: "2", status: "revoked" } }, 1);
    }
    return syntheticQueryPage(["protected-object-title"]);
  };
  const source2 = { ...item.source, input: { ...item.source.input as object, title: "second" } };
  const request = await item.runner.create(item.rig.context, [item.source, source2], item.rig.sink);
  const result = await item.runner.run(item.rig.context, request, item.rig.sink);
  expect(item.rig.calls.sends).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("protected-object-title");
  expect(JSON.stringify(result)).not.toContain("payload");
  expect(result.noMatch).toBe(false);
});

test("changing continuation input invalidates the old token and requires explicit restart", async () => {
  const item = await open();
  item.rig.hooks.query = () => Promise.resolve(syntheticQueryPage(["first"], "cursor"));
  const request = await begin(item);
  const first = await item.runner.run(item.rig.context, request, item.rig.sink);
  const changed = { ...request, continuation: first.continuation, sources: [{ ...item.source, input: { ...item.source.input as object, title: "changed" } }] };
  expect((await item.runner.run(item.rig.context, changed, item.rig.sink)).restartRequired).toBe(true);
  expect((await item.runner.run(item.rig.context, resume(request, first.continuation), item.rig.sink)).restartRequired).toBe(true);
  expect(item.rig.calls.read).toBe(1);
});

test("an already expired invocation never waits on stalled policy resolution", async () => {
  const time = controlledQueryClock();
  const item = await open(time.clock);
  const request = await begin(item);
  const invocation = item.runner.invocation();
  time.advance(30000);
  const gate = Promise.withResolvers<undefined>();
  item.rig.hooks.policy = () => gate.promise;
  const result = await item.runner.run(item.rig.context, request, item.rig.sink, invocation);
  expect(result.groups[0]?.status).toBe("not-attempted");
  expect(result.reason?.code).toBe("deadline_exceeded");
  gate.resolve(undefined);
  await Bun.sleep(10);
  expect(item.rig.calls.read).toBe(0);
});


test("page persistence changes only its query document without a maintenance commit", async () => {
  const item = await open();
  const request = await begin(item);
  const other = await begin(item);
  const publications: CommitPublication[] = [];
  const { engine } = item.rig.host as unknown as { engine: Pick<Session, "subscribeCommits"> };
  const unsubscribe = engine.subscribeCommits(publication => { publications.push(publication); });
  const sweep = spyOn(QueryStore.prototype, "sweep");
  try {
    expect((await item.runner.run(item.rig.context, request, item.rig.sink)).status).toBe("ok");
    const commits = publications.flatMap(publication => publication.changes.flatMap(change => change.type === "document" && change.record.kind === "cortex.read-query" ? [change] : []));
    expect(commits).toHaveLength(2);
    expect(new Set(commits.map(change => change.record.id)).size).toBe(1);
    expect(sweep).not.toHaveBeenCalled();
  } finally { unsubscribe(); sweep.mockRestore(); }
  await item.rig.reopen();
  expect((await item.runner.run(item.rig.context, other, item.rig.sink)).status).toBe("ok");
});

test("expiry removes one query without losing a later query across reopen", async () => {
  const time = controlledQueryClock();
  const item = await open(time.clock);
  item.rig.hooks.query = () => Promise.resolve(syntheticQueryPage(["first"], "protected"));
  const first = await begin(item);
  const firstPage = await item.runner.run(item.rig.context, first, item.rig.sink);
  time.advance(300000);
  const second = await begin(item);
  const secondPage = await item.runner.run(item.rig.context, second, item.rig.sink);
  time.advance(300000);
  await item.rig.reopen();
  expect((await item.runner.run(item.rig.context, resume(first, firstPage.continuation), item.rig.sink)).restartRequired).toBe(true);
  expect((await item.runner.run(item.rig.context, resume(second, secondPage.continuation), item.rig.sink)).continuation).toBeDefined();
  expect(item.rig.calls.read).toBe(3);
});
