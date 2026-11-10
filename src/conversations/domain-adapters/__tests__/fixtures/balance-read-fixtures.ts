import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { DEFAULT_SETTINGS, type AppState, type OutlineNode } from "../../../../balance";
import { authorityRig } from "../../../authority-fixtures";
import { initDatabase } from "../../../../surface/mc/db/init";
import { loadBalanceState, saveBalanceState } from "../../../../surface/mc/desk/balance-store";
import type { DeskArea } from "../../../../surface/mc/desk/types";
import { objectRef } from "../../fixtures";
import { DomainAdapterRegistry } from "../../registry";
import { ReadBindings } from "../../reads/bindings";
import type { QueryFetchRequest, QueryPage, QueryResult } from "../../reads/query-types";
import type { QueryRunner } from "../../reads/query";
import type { Json } from "../../operations/types";
import type { ReadBinding } from "../../reads/types";
import { createBalanceReadAdapter } from "../../balance/read";

export const BALANCE_CONNECTION = "connection-example";
export const LAB_AREA = objectRef("balance", "area", "area-example");
export const HOME_AREA = objectRef("balance", "area", "area-home");

const leaf = (id: string, title: string, extra: Partial<OutlineNode> = {}): OutlineNode => ({ id, title, weight: 50, ordering: "parallel", children: [], effort: 1, ...extra });

export function releasedObjects(value: Json | undefined): { ref: { canonicalId: string }; value: Record<string, unknown> }[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("released value is not an object");
  const held = (value as { objects?: unknown }).objects;
  if (!Array.isArray(held)) throw new Error("released value has no objects");
  return held as { ref: { canonicalId: string }; value: Record<string, unknown> }[];
}

export function tasksIn(state: AppState, areaId: string): OutlineNode[] {
  const found: OutlineNode[] = [];
  const root = state.outline.children.find(node => node.id === `area:${areaId}`);
  const visit = (node: OutlineNode): void => {
    if (node.children.length === 0) found.push(node);
    else for (const child of node.children) visit(child);
  };
  if (root) for (const child of root.children) visit(child);
  return found;
}

export function balanceReadState(): AppState {
  return {
    outline: {
      id: "desk:outline", title: "Outline", weight: 100, ordering: "parallel", children: [
        {
          id: "area:area-example", title: "Lab", weight: 60, ordering: "parallel", children: [
            { id: "project-glider", title: "Glider", weight: 50, ordering: "parallel", children: [leaf("task-wing", "Cut the wing", { effort: 2, dueDate: "2026-12-01", note: "Use paper" }), leaf("task-done", "Fold the body", { effort: 1, done: true })] },
            leaf("task-glue", "Buy glue"),
          ],
        },
        { id: "area:area-home", title: "Home", weight: 40, ordering: "parallel", children: [leaf("task-garden", "Water the garden", { dueDate: "2026-11-20" })] },
      ],
    },
    log: [],
    settings: { ...DEFAULT_SETTINGS },
    dayState: null,
    history: { deficits: {}, lastSurfaced: {} },
  };
}

export interface BalanceReadRig {
  readonly dir: string;
  readonly db: Database;
  readonly areas: DeskArea[];
  readonly adapter: ReturnType<typeof createBalanceReadAdapter>;
  readonly registry: DomainAdapterRegistry;
  readonly rig: Awaited<ReturnType<typeof authorityRig>>;
  readonly destinationsBinding: ReadBinding;
  readonly taskQueryBinding: ReadBinding;
  readonly taskReadBinding: ReadBinding;
  readonly runner: QueryRunner;
  destinations(): Promise<QueryPage>;
  taskQuery(input?: unknown, destinations?: readonly typeof LAB_AREA[]): Promise<{ result: QueryResult; released: Json | undefined }>;
  taskRead(canonicalId: string, area?: typeof LAB_AREA, destinations?: readonly typeof LAB_AREA[]): Promise<{ result: QueryResult; released: Json | undefined }>;
  removeTask(canonicalId: string): void;
  removeArea(canonicalId: string): void;
  allowHome(): Promise<void>;
  close(): Promise<void>;
}

export async function openBalanceReadRig(): Promise<BalanceReadRig> {
  const areas: DeskArea[] = [{ id: "area-example", label: "Lab", color: "#2563eb" }, { id: "area-home", label: "Home", color: "#059669" }];
  let db: Database | null = null;
  const adapter = createBalanceReadAdapter({ connectionId: BALANCE_CONNECTION, state: () => db ? loadBalanceState(db) : null, areas: () => areas, now: () => new Date("2026-11-01T00:00:00.000Z") });
  const registry = new DomainAdapterRegistry();
  const registered = registry.register(adapter.declaration, adapter.bindings);
  if (!registered.ok) throw new Error(registered.error.code);
  const [destinationsBinding, taskQueryBinding, taskReadBinding] = adapter.readBindings;
  if (!destinationsBinding || !taskQueryBinding || !taskReadBinding) throw new Error("balance binding fixture incomplete");
  const rig = await authorityRig({}, "local", { registry, binding: taskQueryBinding, capabilityIds: adapter.readBindings.map(binding => binding.capabilityId) });
  db = initDatabase(join(rig.dir, "desk.sqlite"));
  saveBalanceState(db, balanceReadState());
  const readBindings = new ReadBindings(registry);
  const connector = { adapterId: "balance", connectionId: BALANCE_CONNECTION, readCapabilityIds: adapter.readBindings.map(binding => binding.capabilityId) };
  for (const binding of adapter.readBindings) {
    const added = readBindings.register(binding, connector);
    if (!added.ok) throw new Error(added.error.code);
  }
  rig.bindings.readBindings = readBindings;
  const updated = { ...rig.connection, connectionRevision: "2", readCapabilityIds: adapter.readBindings.map(binding => binding.capabilityId), readDestinations: [LAB_AREA] };
  Object.assign(rig.connection, updated);
  await rig.service.publishHostRecord({ kind: "connection", value: updated }, 1);
  rig.hooks.query = (request: QueryFetchRequest) => adapter.query(request);
  const runner = rig.host.readQueries(registry, rig.bindings);
  const stored = (): AppState => {
    const state = db ? loadBalanceState(db) : null;
    if (!state) throw new Error("balance state unavailable");
    return state;
  };
  const run = async (capabilityId: string, input: unknown, destinations: readonly typeof LAB_AREA[], binding: ReadBinding): Promise<{ result: QueryResult; released: Json | undefined }> => {
    const previous = rig.calls.sends.length;
    const request = await runner.create(rig.context, [{ adapterId: "balance", connectionId: BALANCE_CONNECTION, capabilityId, inputSchemaRef: binding.inputSchemaRef, destinations: [...destinations], input: input as Json }], rig.sink);
    const result = await runner.run(rig.context, request, rig.sink);
    const released = rig.calls.sends.length > previous ? rig.calls.sends[rig.calls.sends.length - 1] : undefined;
    return { result, released };
  };
  const remove = (node: OutlineNode, id: string): boolean => {
    const index = node.children.findIndex(child => child.id === id);
    if (index >= 0) { node.children.splice(index, 1); return true; }
    return node.children.some(child => remove(child, id));
  };
  return {
    dir: rig.dir,
    get db() { if (!db) throw new Error("balance database unavailable"); return db; },
    areas,
    adapter,
    registry,
    rig,
    destinationsBinding,
    taskQueryBinding,
    taskReadBinding,
    runner,
    async destinations() {
      const handler = adapter.bindings.handlers["balance.destinations"];
      if (!handler) throw new Error("balance destinations handler missing");
      return await Promise.resolve(handler({}, {})) as QueryPage;
    },
    taskQuery(input = { area: LAB_AREA }, destinations = [LAB_AREA]) {
      return run("balance.task.query", input, destinations, taskQueryBinding);
    },
    taskRead(canonicalId, area = LAB_AREA, destinations = [LAB_AREA]) {
      return run("balance.task.read", { ref: { ...area, objectType: "task", canonicalId } }, destinations, taskReadBinding);
    },
    removeTask(canonicalId) {
      if (!db) throw new Error("balance database unavailable");
      const state = stored();
      if (!remove(state.outline, canonicalId)) throw new Error("balance task fixture missing");
      saveBalanceState(db, state);
    },
    removeArea(canonicalId) {
      const index = areas.findIndex(area => area.id === canonicalId);
      if (index < 0) throw new Error("balance area fixture missing");
      areas.splice(index, 1);
    },
    async allowHome() {
      await rig.service.publishHostRecord({ kind: "restriction", value: { ...rig.objectRestriction, restrictionRef: randomUUID(), source: HOME_AREA, revision: "1" } }, 0);
      const widened = { ...rig.connection, connectionRevision: "3", readDestinations: [LAB_AREA, HOME_AREA] };
      Object.assign(rig.connection, widened);
      await rig.service.publishHostRecord({ kind: "connection", value: widened }, 2);
    },
    async close() {
      db?.close();
      await rig.close();
    },
  };
}
