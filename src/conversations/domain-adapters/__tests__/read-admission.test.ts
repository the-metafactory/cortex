import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DomainAdapterRegistry } from "../registry";
import { objectRef } from "../fixtures";
import { ReadBindings } from "../reads/bindings";
import { registryFixture } from "../operations/fixtures";
import type { RestrictionRecord } from "../../authority-records";
import { authorityRig } from "../../authority-fixtures";

type Rig = Awaited<ReturnType<typeof authorityRig>>;
const opened = new Set<Rig>();
afterEach(async () => { await Promise.all([...opened].map(rig => rig.close())); opened.clear(); });

const AREA = objectRef("balance", "area", "area-example");
const OTHER_AREA = objectRef("balance", "area", "area-other");
const TASK_SCHEMA = { schemaId: "balance.task.create.input", version: "1.0.0" };
const QUERY = { capabilityId: "balance.object.read", input: { area: AREA, title: "query" } };
const task = (index: number, destination: typeof AREA | null = AREA) => ({ ref: objectRef("balance", "task", `task-${index}`), schemaRef: TASK_SCHEMA, ...(destination ? { destination } : {}), value: { area: AREA, title: `Task ${index}` } });
const pageOf = (count: number) => ({ objects: Array.from({ length: count }, (_, index) => task(index)) });
const request = (rig: Rig, destinations = [AREA]) => ({ connectionId: rig.connection.connectionId, destinations, ...QUERY });
async function open(policy: "local" | "cloud" = "local"): Promise<Rig> { const rig = await authorityRig({}, policy); opened.add(rig); return rig; }
async function admit(rig: Rig, destinations = [AREA]) { return rig.service.admitRead(rig.context, request(rig, destinations), rig.sink); }
async function recordCount(rig: Rig): Promise<number> { const state = await rig.service.inspectHostRecords(); return state.decisions.length + state.policies.length + state.confirmations.length + state.admissions.length + Object.keys(state.evidence).length + Object.keys(state.outbox).length + Object.values(state.records).reduce((sum, records) => sum + records.length, 0); }
const revoked = (record: RestrictionRecord): RestrictionRecord => ({ ...record, status: "revoked", revision: String(Number(record.revision) + 1) });
const objectRestriction = (rig: Rig, ref: typeof AREA, overrides: Partial<RestrictionRecord>): RestrictionRecord => ({ ...rig.objectRestriction, restrictionRef: randomUUID(), source: ref, ...overrides });
async function widen(rig: Rig, destinations = [AREA, OTHER_AREA]): Promise<void> { await rig.service.publishHostRecord({ kind: "connection", value: { ...rig.connection, connectionRevision: "2", readDestinations: destinations } }, 1); }
async function expectNoEffect(rig: Rig, projection: { kind: string }): Promise<void> {
  expect(projection.kind).toBe("withheld");
  expect(rig.calls.read).toBe(0);
  expect(rig.calls.sends).toHaveLength(0);
}

test("registration accepts only an exact strict binding and never fetches a remote schema", () => {
  const fetchSpy = spyOn(globalThis, "fetch");
  const registry = registryFixture();
  const bindings = new ReadBindings(registry);
  const connector = { adapterId: "balance", connectionId: "connection-example", readCapabilityIds: ["balance.object.read"] };
  const binding = { version: "1.0.0", adapterId: "balance", capabilityId: "balance.object.read", mode: "query", objectType: "task", inputSchemaRef: TASK_SCHEMA, outputSchemaRef: { schemaId: "balance.task.create.output", version: "1.0.0" }, destinationType: "area", display: { title: "/title" } };
  const rejected: [unknown, typeof connector, string][] = [
    [{ ...binding, version: "2.0.0" }, connector, "unsupported_binding_version"],
    [{ ...binding, extra: true }, connector, "invalid_binding"],
    [{ ...binding, capabilityId: "balance.unknown.read" }, connector, "binding_mismatch"],
    [{ ...binding, capabilityId: "balance.task.create" }, connector, "binding_mismatch"],
    [{ ...binding, mode: "poll" }, connector, "binding_mismatch"],
    [{ ...binding, inputSchemaRef: { ...TASK_SCHEMA, version: "1.0.1" } }, connector, "binding_mismatch"],
    [{ ...binding, outputSchemaRef: { schemaId: "balance.other", version: "1.0.0" } }, connector, "binding_mismatch"],
    [{ ...binding, objectType: "undeclared" }, connector, "binding_mismatch"],
    [{ ...binding, destinationType: "undeclared" }, connector, "binding_mismatch"],
    [binding, { ...connector, readCapabilityIds: [] }, "connector_mismatch"],
    [binding, { ...connector, adapterId: "other" }, "connector_mismatch"],
  ];
  for (const [raw, trusted, code] of rejected) {
    const result = bindings.register(raw, trusted);
    expect(result.ok ? "ok" : result.error.code).toBe(code);
  }
  expect(bindings.lookup("balance", "connection-example", "balance.object.read")).toEqual({ state: "unavailable", code: "binding_missing" });
  expect(bindings.register(binding, connector).ok).toBe(true);
  expect(bindings.register(binding, connector).ok).toBe(false);
  expect(bindings.lookup("balance", "connection-example", "balance.object.read").state).toBe("available");
  expect(bindings.lookup("balance", "other-connection", "balance.object.read").state).toBe("unavailable");
  expect(new ReadBindings(new DomainAdapterRegistry()).register(binding, connector).ok).toBe(false);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

test("a permitted destination admits the read and releases first-seen objects without growing authority records", async () => {
  const rig = await open();
  const sent: unknown[] = [];
  rig.hooks.read = () => Promise.resolve(pageOf(1));
  const before = await recordCount(rig);
  const single = await admit(rig);
  expect(single.kind).toBe("released");
  const afterOne = await recordCount(rig);
  rig.hooks.read = () => Promise.resolve(pageOf(40));
  const many = await admit(rig);
  expect(many.kind).toBe("released");
  const afterMany = await recordCount(rig);
  expect(afterMany - afterOne).toBeLessThanOrEqual(afterOne - before);
  expect(afterOne - before).toBeGreaterThan(0);
  expect(rig.calls.read).toBe(2);
  expect(rig.calls.sends).toHaveLength(2);
  sent.push(...rig.calls.sends);
  expect(JSON.stringify(sent[1])).toContain("task-39");
  expect((await rig.service.inspectHostRecords()).decisions.some(item => item.purpose === "read" && item.allowed)).toBe(true);
  await rig.reopen();
  expect(await recordCount(rig)).toBe(afterMany);
});

test("an undeclared capability, foreign destination, or unavailable binding denies with zero connector calls", async () => {
  const rig = await open();
  expect((await admit(rig, [OTHER_AREA])).kind).toBe("withheld");
  expect((await admit(rig, [AREA, OTHER_AREA])).kind).toBe("withheld");
  expect((await rig.service.admitRead(rig.context, { ...request(rig), capabilityId: "balance.task.create" }, rig.sink)).kind).toBe("withheld");
  expect((await rig.service.admitRead(rig.context, { ...request(rig), input: { title: "missing area" } }, rig.sink)).kind).toBe("withheld");
  expect((await rig.service.admitRead(rig.context, { ...request(rig), destinations: [{ ...AREA, canonicalId: "AREA-EXAMPLE" }] }, rig.sink)).kind).toBe("withheld");
  expect((await rig.service.admitRead(rig.context, { ...request(rig), destinations: [] }, rig.sink)).kind).toBe("withheld");
  await rig.service.publishHostRecord({ kind: "connection", value: { ...rig.connection, connectionRevision: "2", readCapabilityIds: [] } }, 1);
  await expectNoEffect(rig, await admit(rig));
});

test("a missing, inactive or ambiguous destination restriction denies with zero connector calls", async () => {
  const rig = await open();
  await widen(rig);
  await expectNoEffect(rig, await admit(rig, [OTHER_AREA]));
  const added = objectRestriction(rig, OTHER_AREA, { revision: "1" });
  await rig.service.publishHostRecord({ kind: "restriction", value: added }, 0);
  const second = objectRestriction(rig, OTHER_AREA, { revision: "1" });
  await rig.service.publishHostRecord({ kind: "restriction", value: second }, 0);
  await expectNoEffect(rig, await admit(rig, [OTHER_AREA]));
  await rig.service.publishHostRecord({ kind: "restriction", value: revoked(rig.objectRestriction) }, 1);
  await expectNoEffect(rig, await admit(rig));
});

test("a tighter per-object restriction withholds only that object and a wider one never widens the ceiling", async () => {
  const rig = await open("cloud");
  const discord = await rig.service.authenticate("discord-session");
  if (!discord) throw new Error("Synthetic Discord session is unavailable.");
  const tighter = objectRestriction(rig, task(1).ref, { audiences: ["web", "view"], revision: "1" });
  const local = objectRestriction(rig, task(2).ref, { egress: "local", revision: "1" });
  await rig.service.publishHostRecord({ kind: "restriction", value: tighter }, 0);
  await rig.service.publishHostRecord({ kind: "restriction", value: local }, 0);
  rig.hooks.read = () => Promise.resolve(pageOf(4));
  const toDiscord = await rig.service.admitRead(discord, request(rig), { kind: "discord", conversationId: rig.sink.conversationId });
  expect(toDiscord.kind).toBe("released");
  const titles = (value: unknown): string[] => (value as { objects: { value: { title: string } }[] }).objects.map(object => object.value.title);
  expect(titles(toDiscord.kind === "released" ? toDiscord.value : {})).toEqual(["Task 0", "Task 3"]);
  const toWeb = await admit(rig);
  expect(titles(toWeb.kind === "released" ? toWeb.value : {})).toEqual(["Task 0", "Task 1", "Task 3"]);

  await rig.service.publishHostRecord({ kind: "restriction", value: { ...rig.objectRestriction, audiences: ["web"], revision: "2" } }, 1);
  const wide = objectRestriction(rig, task(0).ref, { audiences: ["web", "discord", "model", "view"], revision: "1" });
  await rig.service.publishHostRecord({ kind: "restriction", value: wide }, 0);
  const calls = rig.calls.read;
  expect((await rig.service.admitRead(discord, request(rig), { kind: "discord", conversationId: rig.sink.conversationId })).kind).toBe("withheld");
  expect(rig.calls.read).toBe(calls);
});

test("objects without a permitted destination are withheld while the page stays releasable", async () => {
  const rig = await open();
  rig.hooks.read = () => Promise.resolve({ objects: [task(0), task(1, null), task(2, OTHER_AREA), { ...task(3), value: { title: "" } }] });
  const result = await admit(rig);
  expect(result.kind).toBe("released");
  expect(JSON.stringify(result)).toContain("Task 0");
  expect(JSON.stringify(result)).not.toContain("Task 1");
  expect(JSON.stringify(result)).not.toContain("Task 2");
});

test("revocation before admission and between fetch and release yields zero sink entries and no reusable decision", async () => {
  const rig = await open();
  rig.hooks.read = async () => { await rig.service.publishHostRecord({ kind: "restriction", value: revoked(rig.objectRestriction) }, 1); return pageOf(3); };
  const mid = await admit(rig);
  expect(mid.kind).toBe("withheld");
  expect(rig.calls.read).toBe(1);
  expect(rig.calls.sends).toHaveLength(0);
  const priorDecisions = (await rig.service.inspectHostRecords()).decisions.filter(item => item.allowed).length;
  expect(priorDecisions).toBeGreaterThan(0);
  expect((await admit(rig)).kind).toBe("withheld");
  expect(rig.calls.read).toBe(1);
  expect(rig.calls.sends).toHaveLength(0);

  const fresh = await open();
  await fresh.service.publishHostRecord({ kind: "restriction", value: revoked(fresh.objectRestriction) }, 1);
  await expectNoEffect(fresh, await admit(fresh));
});

test("readback and operation lookup keep their behaviour: an object without an exact restriction stays withheld", async () => {
  const rig = await open();
  const ref = objectRef("balance", "task", "task-0");
  const projection = await rig.service.readback(rig.context, { lifecycleVersion: "1.0.0", ref }, rig.sink);
  expect(projection.kind).toBe("withheld");
  expect(rig.calls.readback).toBe(0);
  expect(rig.calls.sends).toHaveLength(0);
});
