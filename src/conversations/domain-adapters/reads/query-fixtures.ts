import { authorityRig } from "../../authority-fixtures";
import { DomainAdapterRegistry } from "../registry";
import { balanceDeclaration, fixtureBindings, objectRef, objectSchema } from "../fixtures";
import type { QueryClock } from "./query";
import type { QueryPage, QuerySource } from "./query-types";
import { ReadBindingSchema } from "./types";
import { AT } from "../operations/fixtures";

export const queryBinding = ReadBindingSchema.parse({ version: "1.0.0", adapterId: "balance", capabilityId: "balance.object.read", mode: "query", objectType: "task", inputSchemaRef: { schemaId: "balance.task.create.input", version: "1.0.0" }, outputSchemaRef: { schemaId: "balance.query.output", version: "1.0.0" }, destinationType: "area", display: { title: "/title" }, query: { objectsPointer: "/items", ordering: "provider", stableSnapshot: true } });
export const queryArea = objectRef("balance", "area", "area-example");
export function queryRegistry(outputVersion = "1.0.0") {
  const registry = new DomainAdapterRegistry();
  const declaration = balanceDeclaration();
  const creation = declaration.capabilities[0];
  if (!creation) throw new Error("Synthetic creation declaration missing.");
  const outputSchemaRef = { ...queryBinding.outputSchemaRef, version: outputVersion };
  declaration.schemas.push({ ...outputSchemaRef, schema: objectSchema({ items: { type: "array", items: { $ref: `urn:desk-schema:balance.task.create.input:1.0.0` } } }) as (typeof declaration.schemas)[number]["schema"] });
  declaration.capabilities.push({ ...creation, kind: "query", capabilityId: queryBinding.capabilityId, outputSchemaRef });
  const registered = registry.register(declaration, fixtureBindings(declaration));
  if (!registered.ok) throw new Error(registered.error.code);
  return registry;
}
export function syntheticQueryPage(ids = ["task-0"], cursor?: string, stable = true): QueryPage {
  return structuredClone({ readVersion: "1.0.0", payload: { items: ids.map(id => ({ title: id, area: queryArea })) }, annotations: ids.map((id, index) => ({ pointer: `/items/${index}`, ref: objectRef("balance", "task", id), schemaRef: queryBinding.inputSchemaRef, destination: queryArea, position: index, evidence: { evidenceId: `evidence-${id}`, revision: "1", observedAt: AT } })), observedAt: AT, ordering: "provider", snapshot: stable ? { kind: "stable", id: "snapshot-example" } : { kind: "live" }, ...(cursor === undefined ? {} : { cursor }) });
}
export async function queryRig(clock?: QueryClock, policy: "local" | "cloud" = "local") {
  const rig = await authorityRig({}, policy, { registry: queryRegistry(), binding: queryBinding });
  const source: QuerySource = { adapterId: "balance", connectionId: rig.connection.connectionId, capabilityId: queryBinding.capabilityId, inputSchemaRef: queryBinding.inputSchemaRef, destinations: [queryArea], input: { area: queryArea, title: "synthetic query" } };
  rig.hooks.query = () => Promise.resolve(syntheticQueryPage());
  return { rig, source, get runner() { return rig.host.readQueries(rig.registry, rig.bindings, clock); } };
}
export function controlledQueryClock() {
  let now = Date.parse(AT);
  const timers = new Set<{ at: number; callback: () => void }>();
  const clock: QueryClock = { now: () => now, setTimer(callback, ms) { const timer = { at: now + ms, callback }; timers.add(timer); return () => { timers.delete(timer); }; } };
  return { clock, advance(ms: number) { now += ms; for (const timer of [...timers]) if (timer.at <= now) { timers.delete(timer); timer.callback(); } } };
}
