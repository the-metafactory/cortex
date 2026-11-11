import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { findNode, type AppState, type OutlineNode } from "../../../../balance";
import { leaf, outlineState, removeOutlineNode, savedNode } from "./balance-shared";
export { leaf, savedNode } from "./balance-shared";
import { authorityRig } from "../../../authority-fixtures";
import { initDatabase } from "../../../../surface/mc/db/init";
import { loadBalanceState, saveBalanceState } from "../../../../surface/mc/desk/balance-store";
import { loadMeta, saveMeta } from "../../../../surface/mc/desk/balance-sync";
import type { DeskArea } from "../../../../surface/mc/desk/types";
import { objectRef } from "../../fixtures";
import { DomainAdapterRegistry } from "../../registry";
import { ReadBindings } from "../../reads/bindings";
import type { ObservationView } from "../../reads/observation-types";
import type { ObservationCheck, ObservationStore } from "../../reads/observations";
import { controlledQueryClock } from "../../reads/query-fixtures";
import type { ReleaseProjection } from "../../../authority";
import type { QueryFetchRequest, QueryPage, QueryResult } from "../../reads/query-types";
import type { QuerySource } from "../../reads/query-types";
import type { QueryRunner } from "../../reads/query";
import type { Json } from "../../operations/types";
import type { ReadBinding } from "../../reads/types";
import type { ObjectReference } from "../../types";
import { createBalanceReadAdapter } from "../../balance/read";
import { BALANCE_TASK_OBSERVATION_CAPABILITY_ID, createBalanceObservationAdapter } from "../../balance/observation";
import { createBalanceDayReader, releasedObservationViews, type BalanceDayReader } from "../../../../surface/mc/desk/balance-day";
import type { AdapterAttentionSession } from "../../../../surface/mc/desk/adapter-items";

export const BALANCE_CONNECTION = "connection-example";
export const LAB_AREA = objectRef("balance", "area", "area-example");
export const HOME_AREA = objectRef("balance", "area", "area-home");
export const LAB_TASK_IDS = ["task-wing", "task-done", "task-glue"] as const;
export const OBSERVED_TASK_IDS = [...LAB_TASK_IDS, "task-studio"] as const;

export function releasedObjects(value: Json | undefined): { ref: { canonicalId: string }; value: Record<string, unknown> }[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("released value is not an object");
  const held = (value as { objects?: unknown }).objects;
  if (!Array.isArray(held)) throw new Error("released value has no objects");
  return held as { ref: { canonicalId: string }; value: Record<string, unknown> }[];
}

export function balanceReadState(): AppState {
  return outlineState([
    {
      id: "area:area-example", title: "Lab", weight: 60, ordering: "parallel", children: [
        { id: "project-glider", title: "Glider", weight: 50, ordering: "parallel", children: [leaf("task-wing", "Cut the wing", { effort: 2, dueDate: "2026-12-01", note: "Use paper" }), leaf("task-done", "Fold the body", { effort: 1, done: true })] },
        leaf("task-glue", "Buy glue"),
        { id: "project-empty", title: "Empty project", weight: 50, ordering: "parallel", children: [] },
        { id: "studio-response:thread-1", title: "Studio thread", weight: 50, ordering: "parallel", children: [leaf("task-studio", "Studio answer")] },
      ],
    },
    { id: "area:area-home", title: "Home", weight: 40, ordering: "parallel", children: [leaf("task-garden", "Water the garden", { dueDate: "2026-11-20" })] },
  ]);
}

export function seedStudioThread(db: Database, projectId = "studio-response:thread-1", slug = "thread-1"): void {
  saveMeta(db, { ...loadMeta(db), studio: [{ namespace: "fixture", source: `id:${slug}`, slug, projectId, response: 0, pending: null }] });
}

interface BalanceReadStepArgs { readonly capabilityId: string; readonly input: unknown; readonly destinations: readonly ObjectReference[]; readonly binding: ReadBinding }
export interface BalanceReadStep { readonly result: QueryResult; readonly released: Json | undefined; readonly request: Awaited<ReturnType<QueryRunner["create"]>>; readonly args: BalanceReadStepArgs }

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
  readonly observationBinding: ReadBinding;
  readonly time: ReturnType<typeof controlledQueryClock>;
  readonly source: QuerySource;
  readonly runner: QueryRunner;
  store(): ObservationStore;
  check(mode?: "poll" | "reconcile"): Promise<ObservationCheck>;
  read(history?: boolean): Promise<ReleaseProjection<Json>>;
  views(history?: boolean): Promise<ObservationView[]>;
  day(refresh?: boolean): Promise<import("../../../../surface/mc/desk/balance-day").BalanceDayProjection | null>;
  reader(): BalanceDayReader;
  attentionAccess(): Promise<AdapterAttentionSession | null>;
  unavailable(value: boolean): void;
  destinations(): Promise<QueryPage>;
  taskQuery(input?: unknown, destinations?: readonly ObjectReference[]): Promise<BalanceReadStep>;
  continueTaskQuery(step: BalanceReadStep): Promise<BalanceReadStep>;
  taskRead(canonicalId: string, area?: typeof LAB_AREA, destinations?: readonly ObjectReference[]): Promise<BalanceReadStep>;
  addTask(parentId: string, node: OutlineNode): void;
  removeTask(canonicalId: string): void;
  removeArea(canonicalId: string): void;
  allowHome(): Promise<void>;
  close(): Promise<void>;
}

const tracked: BalanceReadRig[] = [];

export async function openTrackedBalanceReadRig(): Promise<BalanceReadRig> {
  const rig = await openBalanceReadRig();
  tracked.push(rig);
  return rig;
}

export async function closeTrackedBalanceReadRigs(): Promise<void> {
  await Promise.all(tracked.splice(0).map(rig => rig.close()));
}

export async function openBalanceReadRig(): Promise<BalanceReadRig> {
  const areas: DeskArea[] = [{ id: "area-example", label: "Lab", color: "#2563eb" }, { id: "area-home", label: "Home", color: "#059669" }];
  const allowed: ObjectReference[] = [LAB_AREA];
  let db: Database | null = null;
  let reading = true;
  const readState = (): AppState | null => db ? loadBalanceState(db) : null;
  const observedState = (): AppState | null => reading ? readState() : null;
  const now = (): Date => new Date("2026-11-01T00:00:00.000Z");
  const adapter = createBalanceReadAdapter({ connectionId: BALANCE_CONNECTION, state: readState, areas: () => areas, now });
  const observation = createBalanceObservationAdapter({ connectionId: BALANCE_CONNECTION, state: observedState, areas: () => areas, now });
  const registry = new DomainAdapterRegistry();
  const registered = registry.register(observation.declaration, observation.bindings);
  if (!registered.ok) throw new Error(registered.error.code);
  const [destinationsBinding, taskQueryBinding, taskReadBinding] = adapter.readBindings;
  const observationBinding = observation.readBindings.find(binding => binding.capabilityId === BALANCE_TASK_OBSERVATION_CAPABILITY_ID);
  const time = controlledQueryClock();
  if (!destinationsBinding || !taskQueryBinding || !taskReadBinding || !observationBinding) throw new Error("balance binding fixture incomplete");
  const rig = await authorityRig({}, "local", { registry, binding: taskQueryBinding, capabilityIds: observation.readBindings.map(binding => binding.capabilityId), observation: observation.connector });
  db = initDatabase(join(rig.dir, "desk.sqlite"));
  saveBalanceState(db, balanceReadState());
  const readBindings = new ReadBindings(registry);
  const connector = { adapterId: "balance", connectionId: BALANCE_CONNECTION, readCapabilityIds: observation.readBindings.map(binding => binding.capabilityId) };
  for (const binding of observation.readBindings) {
    const added = readBindings.register(binding, connector);
    if (!added.ok) throw new Error(added.error.code);
  }
  rig.bindings.readBindings = readBindings;
  const updated = { ...rig.connection, connectionRevision: "2", readCapabilityIds: observation.readBindings.map(binding => binding.capabilityId), readDestinations: [LAB_AREA] };
  Object.assign(rig.connection, updated);
  await rig.service.publishHostRecord({ kind: "connection", value: updated }, 1);
  rig.hooks.query = (request: QueryFetchRequest) => adapter.query(request);
  const runner = rig.host.readQueries(registry, rig.bindings);
  const stored = (): AppState => {
    const state = db ? loadBalanceState(db) : null;
    if (!state) throw new Error("balance state unavailable");
    return state;
  };
  const save = (state: AppState): void => {
    if (!db) throw new Error("balance database unavailable");
    saveBalanceState(db, state);
  };
  const observationSource = (): QuerySource => ({ adapterId: "balance", connectionId: BALANCE_CONNECTION, capabilityId: BALANCE_TASK_OBSERVATION_CAPABILITY_ID, inputSchemaRef: observationBinding.inputSchemaRef, destinations: allowed.filter(destination => areas.some(area => area.id === destination.canonicalId)), input: {} });
  const attention = (): AdapterAttentionSession | null => observationSource().destinations.length === 0 ? null : ({
    feature: { enabled: true, store: rig.host.readObservations(registry, rig.bindings, time.clock), bindings: readBindings, context: rig.context, sink: rig.sink, sources: [observationSource()] },
    close: () => undefined,
  });
  const observationReader = (): BalanceDayReader => createBalanceDayReader({
    check: mode => rig.host.readObservations(registry, rig.bindings, time.clock).check(rig.context, observationSource(), rig.sink, mode),
    async views() {
      const released = await rig.host.readObservations(registry, rig.bindings, time.clock).read(rig.context, observationSource(), rig.sink);
      return released.kind === "released" ? releasedObservationViews(released.value) : null;
    },
  });
  const run = async (args: BalanceReadStepArgs, resume?: { request: BalanceReadStep["request"]; continuation: string }): Promise<BalanceReadStep> => {
    const previous = rig.calls.sends.length;
    const request = resume?.request ?? await runner.create(rig.context, [{ adapterId: "balance", connectionId: BALANCE_CONNECTION, capabilityId: args.capabilityId, inputSchemaRef: args.binding.inputSchemaRef, destinations: [...args.destinations], input: args.input as Json }], rig.sink);
    const result = await runner.run(rig.context, resume ? { ...request, continuation: resume.continuation } : request, rig.sink);
    const released = rig.calls.sends.length > previous ? rig.calls.sends[rig.calls.sends.length - 1] : undefined;
    return { result, released, request, args };
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
    observationBinding,
    time,
    get source() { return observationSource(); },
    runner,
    store: () => rig.host.readObservations(registry, rig.bindings, time.clock),
    check(mode = "poll") { return rig.host.readObservations(registry, rig.bindings, time.clock).check(rig.context, observationSource(), rig.sink, mode); },
    read(history = false) { return rig.host.readObservations(registry, rig.bindings, time.clock).read(rig.context, observationSource(), rig.sink, history); },
    async views(history = false) {
      const released = await rig.host.readObservations(registry, rig.bindings, time.clock).read(rig.context, observationSource(), rig.sink, history);
      if (released.kind !== "released") throw new Error("balance observations withheld");
      return [...releasedObservationViews(released.value) ?? []];
    },
    async day(refresh = false) {
      if (observationSource().destinations.length === 0) return null;
      return await observationReader().projection(refresh);
    },
    reader: () => observationReader(),
    attentionAccess: () => Promise.resolve(attention()),
    unavailable(value) { reading = !value; },
    async destinations() {
      const handler = adapter.bindings.handlers["balance.destinations"];
      if (!handler) throw new Error("balance destinations handler missing");
      return await Promise.resolve(handler({}, {})) as QueryPage;
    },
    taskQuery(input = { area: LAB_AREA }, destinations = [LAB_AREA]) {
      return run({ capabilityId: "balance.task.query", input, destinations, binding: taskQueryBinding });
    },
    continueTaskQuery(step) {
      const continuation = step.result.continuation;
      if (!continuation) throw new Error("balance query has no continuation");
      return run(step.args, { request: step.request, continuation });
    },
    taskRead(canonicalId, area = LAB_AREA, destinations = [LAB_AREA]) {
      return run({ capabilityId: "balance.task.read", input: { ref: { ...area, objectType: "task", canonicalId } }, destinations, binding: taskReadBinding });
    },
    addTask(parentId, node) {
      const state = stored();
      const parent = findNode(state.outline, parentId);
      if (!parent) throw new Error("balance fixture parent missing");
      parent.children.unshift(node);
      save(state);
    },
    removeTask(canonicalId) {
      const state = stored();
      if (!removeOutlineNode(state.outline, canonicalId)) throw new Error("balance task fixture missing");
      save(state);
    },
    removeArea(canonicalId) {
      const index = areas.findIndex(area => area.id === canonicalId);
      if (index < 0) throw new Error("balance area fixture missing");
      areas.splice(index, 1);
    },
    async allowHome() {
      allowed.push(HOME_AREA);
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
