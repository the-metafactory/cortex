import { describe, expect, test } from "bun:test";
import { DomainAdapterRegistry } from "../domain-adapters/registry";
import type { Availability } from "../domain-adapters/types";
import { ToolHost, type ToolSession } from "../tools/capabilities";
import { adapterCommunicationConnector } from "../tools/adapter-communication-connector";
import type { CommunicationConnector } from "../tools/communications";

const NOW = Date.parse("2026-11-13T10:00:00Z");
const ADAPTER = "fakemail";
interface Capability { id: string; kind: "query" | "action" }
const ref = (schemaId: string) => ({ schemaId, version: "1.0.0" });
const OBJECT_SCHEMA = { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false };
const QUERY_INPUT = { type: "object", required: ["query"], properties: { query: { type: "string", maxLength: 50 } }, additionalProperties: false };

const declaration = (capabilities: Capability[]) => ({
  adapterId: ADAPTER, label: "Fake mail", contractRange: "^1.0.0",
  schemas: [{ schemaId: "q-in", version: "1.0.0", schema: QUERY_INPUT }, { schemaId: "any", version: "1.0.0", schema: OBJECT_SCHEMA }],
  objectTypes: [{ objectType: "message", label: "Message", schemaRef: ref("any"), relationships: [] }],
  capabilities: capabilities.map(capability => ({ capabilityId: `${ADAPTER}.${capability.id}`, label: `Label ${capability.id}`, kind: capability.kind, objectTypes: ["message"], inputSchemaRef: ref(capability.kind === "query" ? "q-in" : "any"), outputSchemaRef: ref("any"), errorSchemaRef: ref("any") })),
});

function rig(capabilities: Capability[] | null, options: { availability?: Record<string, Availability>; allowed?: boolean } = {}) {
  const registry = new DomainAdapterRegistry();
  const handlers = Object.fromEntries((capabilities ?? []).filter(capability => capability.kind === "query").map(capability => [`${ADAPTER}.${capability.id}`, () => { throw new Error("never called by the registry"); }]));
  if (capabilities) expect(registry.register(declaration(capabilities), { handlers, observations: {} }).ok).toBe(true);
  const ran: string[] = [];
  const checked: string[] = [];
  const connector = adapterCommunicationConnector({
    registry, adapterId: ADAPTER, connectorId: "mail", family: "email", service: "Fake mail",
    availability: () => options.availability ?? {},
    scopes: () => [{ id: "acct", label: "Account", policy: "cloud" }],
    authorize: (principal, scope) => { checked.push(`${principal}:${scope}`); return Promise.resolve(options.allowed ?? true); },
    status: () => Promise.resolve({ state: "available" }),
    run: (capabilityId, scope) => { ran.push(`${capabilityId}:${scope}`); return Promise.resolve({ items: [{ id: "m1" }], next: null, observedAt: NOW }); },
  });
  const connectors: CommunicationConnector[] = connector ? [connector] : [];
  const state: ToolSession = { principal: "p", conversationId: "c", transport: "web", route: "cloud", policy: "cloud", scope: [] };
  const host = new ToolHost({ config: () => undefined, session: () => Promise.resolve(state), communications: { connectors: () => connectors, now: () => NOW, remember: () => Promise.resolve(true) } });
  const surface = host.surface("c", state.route, () => Promise.resolve());
  const call = async (name: string, input: unknown) => {
    const out = await surface.call("id", name, input, new AbortController().signal);
    const body = out.text.indexOf("\n") + 1;
    return JSON.parse(out.text.slice(body, out.text.indexOf("\n</tool-result>"))) as Record<string, any>;
  };
  return { call, ran, checked };
}

describe("Mail capabilities discovered from the loaded adapter", () => {
  test("lists exactly the capabilities the adapter declares", async () => {
    const r = rig([{ id: "search", kind: "query" }, { id: "list", kind: "query" }, { id: "move", kind: "action" }]);
    const json = await r.call("communication_discover", { family: "email" });
    const service = json.families[0].services[0];
    expect(service.operations.map((operation: any) => operation.id).sort()).toEqual(["fakemail.list", "fakemail.search"]);
    expect(service.operations.find((operation: any) => operation.id === "fakemail.search").input).toMatchObject({ required: ["query"] });
    expect(service.actions.map((action: any) => action.id)).toEqual(["fakemail.move"]);
    expect(service.unavailableOperations).toEqual([]);
  });

  test("a capability the adapter does not declare is unavailable and runs nothing", async () => {
    const r = rig([{ id: "search", kind: "query" }]);
    const json = await r.call("communication_read", { connector: "mail", scope: "acct", operation: "fakemail.trash", input: {} });
    expect(json.status).toBe("unavailable");
    expect(r.ran).toEqual([]);
    expect(r.checked).toEqual([]);
  });

  test("a declared capability the connection marks unavailable is shown as unavailable and not run", async () => {
    const availability: Record<string, Availability> = { "fakemail.search": { state: "unavailable", code: "no-restore", message: "The connection cannot restore." } };
    const r = rig([{ id: "search", kind: "query" }, { id: "list", kind: "query" }], { availability });
    const service = (await r.call("communication_discover", { family: "email" })).families[0].services[0];
    expect(service.operations.map((operation: any) => operation.id)).toEqual(["fakemail.list"]);
    expect(service.unavailableOperations).toEqual([{ id: "fakemail.search", summary: "Label search", availability: "unavailable", reason: "The connection cannot restore." }]);
    const read = await r.call("communication_read", { connector: "mail", scope: "acct", operation: "fakemail.search", input: { query: "x" } });
    expect(read.status).toBe("unavailable");
    expect(r.ran).toEqual([]);
  });

  test("the host checks account access before anything runs, and denial runs nothing", async () => {
    const denied = rig([{ id: "search", kind: "query" }], { allowed: false });
    expect((await denied.call("communication_read", { connector: "mail", scope: "acct", operation: "fakemail.search", input: { query: "x" } })).status).toBe("denied");
    expect(denied.checked.length).toBeGreaterThan(0);
    expect(denied.ran).toEqual([]);
    const allowed = rig([{ id: "search", kind: "query" }]);
    const json = await allowed.call("communication_read", { connector: "mail", scope: "acct", operation: "fakemail.search", input: { query: "x" } });
    expect(json.status).toBe("ok");
    expect(allowed.ran).toEqual(["fakemail.search:acct"]);
  });

  test("input that breaks the declared schema is refused before the adapter runs", async () => {
    const r = rig([{ id: "search", kind: "query" }]);
    const json = await r.call("communication_read", { connector: "mail", scope: "acct", operation: "fakemail.search", input: { query: 5 } });
    expect(json.status).toBe("invalid-input");
    expect(r.ran).toEqual([]);
  });

  test("with no Mail adapter loaded no Mail capability is offered", async () => {
    const r = rig(null);
    const json = await r.call("communication_discover", { family: "email" });
    expect(json.families[0]).toMatchObject({ family: "email", services: [], availability: "not-installed" });
    const read = await r.call("communication_read", { connector: "mail", scope: "acct", operation: "fakemail.search", input: {} });
    expect(read.status).toBe("denied");
    expect(r.ran).toEqual([]);
  });
});
