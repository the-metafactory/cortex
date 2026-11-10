import { test, expect, spyOn } from "bun:test";
import { join } from "node:path";
import { openConversationHost } from "../../../conversations/host";
import { QueryRunner } from "../../../conversations/domain-adapters/reads/query";
import { createBalanceConnection } from "../desk/balance-connection";
import { balanceConnectionStack, BALANCE_PRINCIPAL } from "./fixtures/balance-connection";
import { loadBalanceState, saveBalanceState } from "../desk/balance-store";
import { balanceDestinations } from "../desk/balance-destinations";

const READ = "/api/desk/balance/read";

test("Balance reads queued behind a runner failure recover and release their own results", async () => {
  const stack = await balanceConnectionStack();
  const status = await openConversationHost({ dir: join(stack.dir, "queue-host"), stack: "test", label: "test", expectedLabel: "test", lanes: {}, turns: request => Promise.resolve({ text: "unused", session: request.session, resumed: false }) });
  if (status.state !== "ready") throw new Error(status.reason);
  const run = spyOn(QueryRunner.prototype, "run");
  try {
    const balance = createBalanceConnection({ host: status.host, db: stack.db, desk: () => stack.desk, stack: "test", isPrincipal: principal => principal === BALANCE_PRINCIPAL, secretRoot: join(stack.dir, "queue-secrets") });
    const [form] = await balance.setup.forms(BALANCE_PRINCIPAL);
    const configured = await balance.setup.configure(BALANCE_PRINCIPAL, { packageId: "balance", scope: {}, readCapabilityIds: form!.capabilities.map(item => item.capabilityId), writeCapabilityIds: [], readDestinations: [form!.destinations[0]!.ref], writeDestinations: [] });
    const connection = await balance.setup.enable(BALANCE_PRINCIPAL, configured.connectionId, configured.revision);
    const conversation = await status.host.create({ title: "Queued reads", policy: "local", links: [], origin: { kind: "web" } }, BALANCE_PRINCIPAL);
    const request = { conversationId: conversation.id, connectionId: connection.connectionId, destinations: connection.readDestinations, capabilityId: "balance.destinations" as const, input: {} };
    const failure = new Error("Injected runner failure");
    run.mockRejectedValueOnce(failure);
    const results = await Promise.allSettled([
      balance.read(BALANCE_PRINCIPAL, request),
      balance.read(BALANCE_PRINCIPAL, request),
      balance.read(BALANCE_PRINCIPAL, { ...request, capabilityId: "balance.task.read", input: { ref: { adapterId: "balance", connectionId: connection.connectionId, objectType: "task", canonicalId: "task-wing" } } }),
    ]);
    expect(results[0]).toEqual({ status: "rejected", reason: failure });
    expect(results[1]).toMatchObject({ status: "fulfilled", value: { result: { status: "ok" }, pages: [{ objects: expect.arrayContaining([expect.objectContaining({ ref: expect.objectContaining({ canonicalId: "project-glider" }) })]) }] } });
    expect(results[2]).toMatchObject({ status: "fulfilled", value: { result: { status: "ok" }, pages: [{ objects: [expect.objectContaining({ value: expect.objectContaining({ title: "Cut the wing" }), evidence: expect.objectContaining({ evidenceId: "balance.task.task-wing" }) })] }] } });
    expect(run).toHaveBeenCalledTimes(3);
  } finally {
    run.mockRestore();
    await status.host.close();
    await stack.close();
  }
});

test("the enabled Balance connection feeds My Day from the durable observation projection", async () => {
  const stack = await balanceConnectionStack();
  try {
    const catalog = await stack.http("/api/desk/connections");
    expect(catalog.body.packages[0].capabilities.map((item: { capabilityId: string }) => item.capabilityId)).toContain("balance.task.observation");
    const connection = await stack.enable();
    const day = await stack.http("/api/desk/my-day");
    expect(day.status).toBe(200);
    expect(day.body.observation).toEqual({ status: "fresh", observedAt: expect.any(String) });
    expect(day.body.outline).toEqual(loadBalanceState(stack.db)!.outline);
    const desk = await stack.http("/api/desk");
    expect(desk.status).toBe(200);
    expect(desk.body.myDay.observation).toMatchObject({ status: "fresh" });
    expect(desk.body.myDay.outline).toEqual(loadBalanceState(stack.db)!.outline);
    expect(desk.body.items.every((item: { kind: string }) => item.kind !== "adapter")).toBe(true);
    await stack.reopen();
    const reopened = await stack.http("/api/desk/my-day");
    expect(reopened.body.observation).toMatchObject({ status: "fresh" });
    expect(reopened.body.outline).toEqual(loadBalanceState(stack.db)!.outline);
    const disabled = await stack.http(`/api/desk/connections/${connection.connectionId}/disable`, { expectedRevision: connection.revision });
    expect(disabled.body.connection.state).toBe("disabled");
    const off = await stack.http("/api/desk/my-day");
    expect(off.body.observation).toBeNull();
  } finally { await stack.close(); }
});

test("live Balance setup enables without credentials, reads annotated owner data, survives reopen and disables without changing legacy Balance", async () => {
  const stack = await balanceConnectionStack();
  try {
    const catalog = await stack.http("/api/desk/connections");
    expect(catalog.status).toBe(200);
    expect(catalog.body.connections).toEqual([]);
    expect(catalog.body.packages[0]).toMatchObject({ packageId: "balance", authKind: "local", slots: [] });
    expect(catalog.body.packages[0].capabilities.every((item: { access: string }) => item.access === "read")).toBe(true);
    const connection = await stack.enable();
    expect(connection.state).toBe("enabled");
    expect(connection.slots).toEqual([]);
    expect(connection.writeCapabilityIds).toEqual([]);
    expect(connection.readDestinations[0]?.connectionId).toBe(connection.connectionId);
    const conversation = await stack.host.create({ title: "Balance read", policy: "local", links: [], origin: { kind: "web" } }, BALANCE_PRINCIPAL);
    const request = { conversationId: conversation.id, connectionId: connection.connectionId, destinations: connection.readDestinations, capabilityId: "balance.destinations", input: {} };
    const destinations = await stack.http(READ, request);
    expect(destinations.status).toBe(200);
    expect(destinations.body.result.status).toBe("ok");
    const expected = balanceDestinations(loadBalanceState(stack.db)!.outline, stack.desk.areas).filter(item => item.area === "area-example");
    expect(destinations.body.pages[0].objects.map((item: { value: { label: string } }) => item.value.label)).toEqual(expected.map(item => item.label));
    expect(destinations.body.pages[0].objects[1]).toMatchObject({ ref: { objectType: "project", canonicalId: "project-glider" }, evidence: { evidenceId: "balance.destination.project.project-glider" } });
    const task = { ...request, capabilityId: "balance.task.read", input: { ref: { adapterId: "balance", connectionId: connection.connectionId, objectType: "task", canonicalId: "task-wing" } } };
    const read = await stack.http(READ, task);
    expect(read.status).toBe(200);
    expect(read.body.pages[0].objects[0]).toMatchObject({ ref: task.input.ref, destination: connection.readDestinations[0], value: { title: "Cut the wing", status: "open", dueDate: "2026-12-01" }, evidence: { evidenceId: "balance.task.task-wing" } });
    const concurrent = await Promise.all([stack.http(READ, task), stack.http(READ, request)]);
    expect(concurrent.map(item => item.status)).toEqual([200, 200]);
    await stack.reopen();
    expect((await stack.http("/api/desk/connections")).body.connections[0].state).toBe("enabled");
    expect((await stack.http(READ, task)).body.result.status).toBe("ok");
    const before = loadBalanceState(stack.db);
    const disabled = await stack.http(`/api/desk/connections/${connection.connectionId}/disable`, { expectedRevision: connection.revision });
    expect(disabled.body.connection.state).toBe("disabled");
    expect((await stack.http(READ, task)).status).toBe(403);
    expect(loadBalanceState(stack.db)).toEqual(before);
    expect((await stack.http("/api/desk/my-day")).status).toBe(200);
  } finally { await stack.close(); }
});

test("Balance browser reads enforce identity, host, destination, capability and current area policy", async () => {
  const stack = await balanceConnectionStack();
  try {
    const connection = await stack.enable();
    const conversation = await stack.host.create({ title: "Balance read", policy: "cloud", links: [], origin: { kind: "web" } }, BALANCE_PRINCIPAL);
    const request = { conversationId: conversation.id, connectionId: connection.connectionId, destinations: connection.readDestinations, capabilityId: "balance.destinations", input: {} };
    expect((await stack.http(READ, request, { "cf-access-authenticated-user-email": "another-principal" })).status).toBe(403);
    expect((await stack.http(READ, request, { origin: "https://foreign.example.test" })).status).toBe(403);
    expect((await stack.http(READ, { ...request, capabilityId: "balance.task.create" })).status).toBe(400);
    expect((await stack.http(READ, { ...request, destinations: [{ ...connection.readDestinations[0], canonicalId: "area-home" }] })).status).toBe(403);
    expect((await stack.http(READ, { ...request, destinations: [{ ...connection.readDestinations[0], connectionId: "another-connection" }] })).status).toBe(403);
    const other = await stack.host.create({ title: "Other", policy: "local", links: [], origin: { kind: "web" } }, "another-principal");
    expect((await stack.http(READ, { ...request, conversationId: other.id })).status).toBe(403);
    stack.desk.areas.splice(0, 1);
    expect((await stack.http(READ, request)).status).toBe(403);
  } finally { await stack.close(); }
});

for (const count of [25, 65]) test(`Balance destination pages stay bounded with ${count} projects and retain scoped mixed-type annotations`, async () => {
  const stack = await balanceConnectionStack();
  try {
    const state = loadBalanceState(stack.db)!;
    const area = state.outline.children[0]!;
    for (let index = 0; index < count; index++) area.children.push({ id: `project-page-${index}`, title: `Project ${index}`, weight: 50, ordering: "parallel", children: [] });
    saveBalanceState(stack.db, state);
    const connection = await stack.enable();
    const conversation = await stack.host.create({ title: "Paged destinations", policy: "local", links: [], origin: { kind: "web" } }, BALANCE_PRINCIPAL);
    const read = await stack.http(READ, { conversationId: conversation.id, connectionId: connection.connectionId, capabilityId: "balance.destinations", input: {}, destinations: connection.readDestinations });
    expect(read.status).toBe(200);
    expect(read.body.result.status).toBe(count > 60 ? "partial" : "ok");
    expect(read.body.pages).toHaveLength(count > 60 ? 3 : 2);
    expect(read.body.result.continuation).toBeUndefined();
    if (count > 60) expect(read.body.result.restartRequired).toBe(true);
    expect(read.body.pages.every((page: { objects: unknown[] }) => page.objects.length <= 20)).toBe(true);
    const expected = balanceDestinations(state.outline, stack.desk.areas).filter(item => item.area === "area-example");
    expect(read.body.pages.flatMap((page: { objects: { ref: { canonicalId: string } }[] }) => page.objects.map(item => item.ref.canonicalId))).toEqual(expected.slice(0, 60).map(item => item.project ? item.id : item.area));
  } finally { await stack.close(); }
});

test("Balance setup rejects stack scope overrides, writes, foreign refs and aliased duplicates, and preserves qualified refs on reconfiguration", async () => {
  const stack = await balanceConnectionStack();
  try {
    const catalog = (await stack.http("/api/desk/connections")).body.packages[0];
    expect(catalog.scopeFields).toEqual([]);
    const body = { packageId: "balance", scope: {}, readCapabilityIds: ["balance.destinations"], writeCapabilityIds: [], readDestinations: [catalog.destinations[0].ref], writeDestinations: [] };
    expect((await stack.http("/api/desk/connections", { ...body, scope: { stack: "other-stack" } })).status).toBe(400);
    expect((await stack.http("/api/desk/connections", { ...body, writeCapabilityIds: ["balance.task.create"] })).status).toBe(400);
    expect((await stack.http("/api/desk/connections", { ...body, readDestinations: [{ ...body.readDestinations[0], connectionId: "foreign-connection" }] })).status).toBe(400);
    const enabled = await stack.enable();
    const edit = { ...body, connectionId: enabled.connectionId, expectedRevision: enabled.revision, readCapabilityIds: enabled.readCapabilityIds, readDestinations: enabled.readDestinations };
    expect((await stack.http("/api/desk/connections", { ...edit, readDestinations: [...edit.readDestinations, catalog.destinations[0].ref] })).status).toBe(400);
    const updated = await stack.http("/api/desk/connections", edit);
    expect(updated.status).toBe(200);
    expect(updated.body.connection.state).toBe("enabled");
    expect(updated.body.connection.readDestinations).toEqual(enabled.readDestinations);
  } finally { await stack.close(); }
});
