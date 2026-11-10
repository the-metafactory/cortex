import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { enableConnection, listConnections, connectionSetupRig, SYNTHETIC_TOKEN, type ConnectionSetupRig } from "../../connection-setup-fixtures";
import { syntheticDiagnostics } from "../diagnostics-fixtures";
import type { ConnectionView } from "../../connection-setup";
import { validateEnvelope } from "../../../bus/myelin/envelope-validator";
import { ADAPTER_EVENT_CAPACITY, DIAGNOSTIC_EVENT_KEYS, DIAGNOSTIC_EVENT_NAMES } from "../diagnostics";
import { eventFixture, prepareOperationFixture, registryFixture } from "../operations/fixtures";
import { queryBinding, queryRig, syntheticQueryPage } from "../reads/query-fixtures";

const rigs: ConnectionSetupRig[] = [];

afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });

async function openRig(): Promise<ConnectionSetupRig> {
  const rig = await connectionSetupRig();
  rigs.push(rig);
  return rig;
}

async function listed(rig: ConnectionSetupRig): Promise<Map<string, ConnectionView>> {
  return new Map((await listConnections(rig)).map(item => [item.connectionId, item]));
}

const statusEvent = (connectionId: string, state: "available" | "unavailable" | "stale" | "fenced", errorCode?: string) => ({ event: "desk.adapter.connection_status", adapterId: "balance", connectionId, state, ...(errorCode ? { errorCode } : {}) });
const busClient = (): { published: unknown[]; publish(envelope: unknown): boolean } => ({ published: [], publish(envelope: unknown): boolean { if (!validateEnvelope(envelope).ok) return false; this.published.push(envelope); return true; } });

describe("adapter diagnostics store", () => {
  test("stores one strict event per kind with only opaque identifiers, capability, state and an error code", async () => {
    const rig = await openRig();
    const diagnostics = rig.host().adapterDiagnostics();
    const connectionId = "connection-example";
    const allowed = new Set<string>(DIAGNOSTIC_EVENT_KEYS);
    const events = [
      statusEvent(connectionId, "available"),
      { event: "desk.adapter.query_refused", adapterId: "balance", connectionId, capabilityId: "balance.object.read", state: "refused", errorCode: "denied" },
      { event: "desk.adapter.query_partial", adapterId: "balance", connectionId, capabilityId: "balance.object.read", state: "partial", errorCode: "budget_exhausted" },
      { event: "desk.adapter.operation_state", adapterId: "balance", connectionId, capabilityId: "balance.task.create", state: "failed", errorCode: "owner_failed" },
      { event: "desk.adapter.trigger_fired", adapterId: "balance", connectionId, capabilityId: "balance.task.create", state: "fenced", errorCode: "canary_secret_leaked" },
    ];
    for (const event of events) expect((await diagnostics.record(event)).stored).toBe(true);
    const stored = await diagnostics.events(connectionId);
    expect(stored.map(item => item.event)).toEqual([...DIAGNOSTIC_EVENT_NAMES]);
    expect(stored.every(item => Object.keys(item).every(key => allowed.has(key)))).toBe(true);
    expect(stored.every(item => typeof item.at === "string")).toBe(true);
  });

  test("refuses an event carrying any other field and logs the refusal without the value", async () => {
    const rig = await openRig();
    const diagnostics = rig.host().adapterDiagnostics();
    const logged: string[] = [];
    const report = spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    try {
      const refused = await diagnostics.record({ event: "desk.adapter.query_refused", adapterId: "balance", connectionId: "connection-example", state: "refused", errorCode: "denied", message: "owner@example.test", account: "synthetic-account" });
      expect(refused).toEqual({ stored: false, code: "invalid_event" });
      expect(await diagnostics.events("connection-example")).toEqual([]);
      expect(logged.some(line => line.includes("refused"))).toBe(true);
      expect(logged.join("\n")).not.toContain("owner@example.test");
      expect(logged.join("\n")).not.toContain("synthetic-account");
    } finally { report.mockRestore(); }
  });

  test("keeps the newest 500 events and leaves the current status untouched when the oldest is removed", async () => {
    const rig = await openRig();
    const diagnostics = rig.host().adapterDiagnostics();
    const connectionId = "connection-example";
    expect((await diagnostics.record(statusEvent(connectionId, "available"))).stored).toBe(true);
    for (let index = 0; index < ADAPTER_EVENT_CAPACITY; index++) {
      expect((await diagnostics.record({ event: "desk.adapter.query_refused", adapterId: "balance", connectionId, state: "refused", errorCode: "denied" })).stored).toBe(true);
    }
    const stored = await diagnostics.events(connectionId);
    expect(stored).toHaveLength(ADAPTER_EVENT_CAPACITY);
    expect(stored.some(item => item.event === "desk.adapter.connection_status")).toBe(false);
    expect(await diagnostics.status(connectionId)).toMatchObject({ state: "available", reason: null });
  });

  test("a first event that is not a connection report keeps the caller's enabled status", async () => {
    const rig = await openRig();
    const diagnostics = rig.host().adapterDiagnostics();
    const connectionId = "connection-example";
    expect((await diagnostics.record({ event: "desk.adapter.operation_state", adapterId: "balance", connectionId, state: "dispatching" })).stored).toBe(true);
    expect(await diagnostics.status(connectionId)).toMatchObject({ state: "unavailable", reason: "not_reported" });
    expect(await diagnostics.status(connectionId, { state: "available", lastSuccessAt: null, lastAttemptAt: null, reason: null })).toMatchObject({ state: "available", reason: null });
    expect((await diagnostics.status(connectionId, { state: "available", lastSuccessAt: null, lastAttemptAt: null, reason: null })).lastAttemptAt).not.toBeNull();
  });

  test("records no bus publication for any event", async () => {
    const rig = await openRig();
    const diagnostics = rig.host().adapterDiagnostics();
    const bus = busClient();
    await diagnostics.record(statusEvent("connection-example", "available"));
    await diagnostics.record({ event: "desk.adapter.query_partial", adapterId: "balance", connectionId: "connection-example", state: "partial" });
    const stored = await diagnostics.events("connection-example");
    expect(stored).toHaveLength(2);
    expect(stored.map(event => bus.publish(event))).toEqual([false, false]);
    expect(bus.published).toEqual([]);
  });
});

describe("adapter connection status in Desk Settings", () => {
  test("shows available, unavailable, stale and fenced with last success, last attempt and a safe reason", async () => {
    const rig = await openRig();
    const { available, stale, fenced, unavailable, fenceTarget, recent, older } = await syntheticDiagnostics(rig);
    const views = await listed(rig);
    const status = (connectionId: string) => views.get(connectionId)?.status;
    expect(status(available.connectionId)).toMatchObject({ state: "available", reason: null, lastSuccessAt: recent });
    expect(status(available.connectionId)?.lastAttemptAt).not.toBeNull();
    expect(status(stale.connectionId)).toMatchObject({ state: "stale", reason: "last_success_too_old", lastSuccessAt: older });
    expect(status(fenced.connectionId)).toMatchObject({ state: "fenced", reason: "duplicate_owner_object" });
    expect(status(unavailable.connectionId)).toMatchObject({ state: "unavailable", reason: "disabled" });
    await rig.host().lifecycleFences().lift(fenceTarget, { principal: "principal-example", reason: "The owner reconciled the duplicate object." });
    const lifted = await listed(rig);
    expect(lifted.get(fenced.connectionId)?.status).toMatchObject({ state: "available", reason: null });
    expect(JSON.stringify([...views.values()])).not.toContain(SYNTHETIC_TOKEN);
  });

  test("records status, query, operation and trigger events on the host store", async () => {
    const rig = await openRig();
    const diagnostics = rig.host().adapterDiagnostics();
    const connection = await enableConnection(rig);
    await rig.host().lifecycleFences().trigger({ kind: "readback_failed", target: { adapterId: connection.packageId, connectionId: connection.connectionId, capabilityId: "example.object.read" } });
    const events = await diagnostics.events(connection.connectionId);
    expect(events.map(item => item.event)).toContain("desk.adapter.connection_status");
    expect(events.map(item => item.event)).toContain("desk.adapter.trigger_fired");
    expect(events.find(item => item.event === "desk.adapter.connection_status")).toMatchObject({ state: "available" });
    expect(await diagnostics.status(connection.connectionId)).toMatchObject({ state: "available" });
  });

  test("records one operation-state event per journaled state change", async () => {
    const rig = await openRig();
    const journal = rig.host().lifecycleJournal(registryFixture());
    const { approval, attempt } = await prepareOperationFixture(journal);
    await journal.append(approval.operationId, 2, eventFixture(3, { kind: "wait-expired", attemptId: attempt.attemptId, reason: { code: "deadline_exceeded", message: "Synthetic timeout." } }));
    const events = (await rig.host().adapterDiagnostics().events(approval.snapshot.connectionId)).filter(item => item.event === "desk.adapter.operation_state");
    expect(events.map(item => item.state)).toEqual(["dispatching", "uncertain"]);
    expect(events.at(-1)).toMatchObject({ errorCode: "deadline_exceeded", adapterId: approval.snapshot.adapterId });
  });
});

describe("adapter query diagnostics", () => {
  test("records a refused query with only opaque source identity and an error code", async () => {
    const item = await queryRig();
    const broken = syntheticQueryPage(["valid"]);
    broken.annotations[0]!.pointer = "/missing";
    item.rig.hooks.query = () => Promise.resolve(broken);
    const request = await item.runner.create(item.rig.context, [item.source], item.rig.sink);
    const result = await item.runner.run(item.rig.context, request, item.rig.sink);
    expect(result.status).toBe("unavailable");
    const events = await item.rig.host.adapterDiagnostics().events(item.source.connectionId);
    const refused = events.filter(entry => entry.event === "desk.adapter.query_refused");
    expect(refused).toHaveLength(1);
    expect(Object.keys(refused[0] ?? {}).sort()).toEqual(["adapterId", "at", "capabilityId", "connectionId", "errorCode", "event", "state"]);
    expect((await item.rig.host.adapterDiagnostics().status(item.source.connectionId)).lastAttemptAt).not.toBeNull();
  });

  test("records a partial query once even when one source fails", async () => {
    const item = await queryRig();
    const failed = { ...item.source, input: { ...item.source.input as object, title: "failure" } };
    item.rig.hooks.query = request => (request.input as { title: string }).title === "failure" ? Promise.reject(new Error("synthetic provider failure")) : Promise.resolve(syntheticQueryPage([]));
    const request = await item.runner.create(item.rig.context, [item.source, failed], item.rig.sink);
    const result = await item.runner.run(item.rig.context, request, item.rig.sink);
    expect(result.status).toBe("partial");
    const events = (await item.rig.host.adapterDiagnostics().events(item.source.connectionId)).filter(entry => entry.event === "desk.adapter.query_partial");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ state: "partial", adapterId: "balance", connectionId: item.source.connectionId, capabilityId: queryBinding.capabilityId });
  });

  test("records a partial query on the connection whose source failed, not the first source", async () => {
    const item = await queryRig(undefined, "local", { secondConnection: true });
    if (!item.secondSource) throw new Error("Synthetic second connection missing.");
    const failing = { ...item.secondSource, input: { ...item.secondSource.input as object, title: "failure" } };
    item.rig.hooks.query = request => (request.input as { title: string }).title === "failure" ? Promise.reject(new Error("synthetic provider failure")) : Promise.resolve(syntheticQueryPage([]));
    const request = await item.runner.create(item.rig.context, [item.source, failing], item.rig.sink);
    const result = await item.runner.run(item.rig.context, request, item.rig.sink);
    expect(result.status).toBe("partial");
    const diagnostics = item.rig.host.adapterDiagnostics();
    expect((await diagnostics.events(item.source.connectionId)).filter(entry => entry.event === "desk.adapter.query_partial")).toEqual([]);
    const failed = (await diagnostics.events(failing.connectionId)).filter(entry => entry.event === "desk.adapter.query_partial");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ state: "partial", connectionId: failing.connectionId, capabilityId: queryBinding.capabilityId });
    expect((await diagnostics.status(failing.connectionId)).lastAttemptAt).not.toBeNull();
  });
});
