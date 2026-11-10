// glossary-ignore: host, owner
import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { authorityRig } from "../../../conversations/authority-fixtures";
import type { AuthorityState, RestrictionRecord } from "../../../conversations/authority-records";
import { handleDeskGraphRepositories } from "../api/desk-graph-repositories";
import { initDatabase } from "../db/init";
import { GRAPH_SCOPE_ADAPTER_ID, GRAPH_SCOPE_OBJECT_TYPE, GRAPH_SCOPE_RESOLVER_BINDING, GraphScope, graphDestinationPermitted, graphScopeSource, permittedGraphDestinations, workGraphConnectionId, type GraphScopeStore } from "../desk/graph-repository-authority";
import { githubRef, gitlabRef, graphRepositoryRefs, isGraphRepositoryAllowed } from "../desk/graph-repositories";
import { GRAPH_REPOSITORIES_PATH } from "../desk/graph-repository-schema";

const NOW = Date.parse("2026-11-10T09:00:00.000Z");
const REF = githubRef("jcfischer/desk");
const OTHER = gitlabRef("gitlab.switch.ch", "claw/crisis-simulator");

type Rig = Awaited<ReturnType<typeof authorityRig>>;
const opened = new Set<Rig>();
const databases = new Set<Database>();
afterEach(async () => {
  for (const db of databases) db.close();
  databases.clear();
  await Promise.all([...opened].map(rig => rig.close()));
  opened.clear();
});

interface Bench {
  rig: Rig;
  db: Database;
  scope: GraphScope;
  connectionId: string;
  address: { connectionId: string; principalRef: string };
}

async function bench(store?: GraphScopeStore): Promise<Bench> {
  const rig = await authorityRig();
  opened.add(rig);
  const db = initDatabase(":memory:");
  databases.add(db);
  const connectionId = workGraphConnectionId(rig.principal.stack);
  const scope = new GraphScope({ store: store ?? rig.service, stack: rig.principal.stack, principalRef: rig.principal.principalRef, now: () => NOW });
  return { rig, db, scope, connectionId, address: { connectionId, principalRef: rig.principal.principalRef } };
}

function restrictionHeads(state: AuthorityState): RestrictionRecord[] {
  const heads: RestrictionRecord[] = [];
  for (const records of Object.values(state.records)) {
    const head = records.at(-1);
    if (head?.kind === "restriction" && head.value.source.adapterId === GRAPH_SCOPE_ADAPTER_ID) heads.push(head.value);
  }
  return heads;
}

function restrictionRevisions(state: AuthorityState): RestrictionRecord[] {
  return Object.values(state.records).flatMap(records => records.flatMap(record => (record.kind === "restriction" && record.value.source.adapterId === GRAPH_SCOPE_ADAPTER_ID ? [record.value] : [])));
}

const put = (db: Database, scope: GraphScope | null, ref: string, enabled: boolean, now = NOW): Promise<Response> => {
  const path = `${GRAPH_REPOSITORIES_PATH}/${encodeURIComponent(ref)}`;
  return handleDeskGraphRepositories(new Request(`http://127.0.0.1${path}`, { method: "PUT", body: JSON.stringify({ enabled }) }), new URL(`http://127.0.0.1${path}`), db, { now: () => now, graphScope: () => scope });
};

const enabledAt = (db: Database, ref: string): number | null => db.query<{ enabled_at: number }, [string]>("SELECT enabled_at FROM desk_graph_repositories WHERE ref = ?").get(ref)?.enabled_at ?? null;

const tick = (db: Database, ref: string, at: number): void => { db.query("INSERT INTO desk_graph_repositories (ref, enabled_at) VALUES (?, ?)").run(ref, at); };

test("ticking a repository publishes its exact ref as one active restriction on the stack's work-graph connection", async () => {
  const { rig, db, scope, connectionId, address } = await bench();
  const res = await put(db, scope, REF, true);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ref: REF, enabled: true });
  expect(graphRepositoryRefs(db)).toEqual([REF]);
  expect(isGraphRepositoryAllowed(db, REF)).toBe(true);
  const state = await rig.service.inspectHostRecords();
  const held = restrictionHeads(state);
  expect(held).toHaveLength(1);
  expect(held[0]).toMatchObject({
    version: 1, status: "active", revision: "1",
    source: { adapterId: GRAPH_SCOPE_ADAPTER_ID, connectionId, objectType: GRAPH_SCOPE_OBJECT_TYPE, canonicalId: REF },
    readScope: [rig.principal.principalRef], resolverBinding: GRAPH_SCOPE_RESOLVER_BINDING,
    audiences: ["web", "model", "view"], egress: "cloud",
  });
  expect(permittedGraphDestinations(state, address)).toEqual([graphScopeSource(REF, connectionId)]);
  expect(permittedGraphDestinations(state, address).map(source => source.canonicalId)).toEqual(graphRepositoryRefs(db));
  expect(await scope.admits(REF)).toBe(true);
});

test("unticking withdraws the restriction before the response returns, and a later admission denies", async () => {
  const { rig, db, scope, address } = await bench();
  expect((await put(db, scope, REF, true)).status).toBe(200);
  const res = await put(db, scope, REF, false);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ref: REF, enabled: false });
  const state = await rig.service.inspectHostRecords();
  expect(restrictionHeads(state)).toHaveLength(1);
  expect(restrictionHeads(state)[0]).toMatchObject({ status: "revoked", revision: "2" });
  expect(restrictionRevisions(state).flat()).toHaveLength(2);
  expect(graphDestinationPermitted(state, address, REF)).toBe(false);
  expect(await scope.admits(REF)).toBe(false);
  expect(await scope.permitted()).toEqual([]);
  expect(graphRepositoryRefs(db)).toEqual([]);
  expect(isGraphRepositoryAllowed(db, REF)).toBe(false);
});

test("a failed publication saves no tick and reports the failure", async () => {
  const { rig, db } = await bench();
  const unreachable: GraphScopeStore = { inspectHostRecords: () => rig.service.inspectHostRecords(), publishHostRecord: () => Promise.reject(new Error("the authority store is unavailable")) };
  const scope = new GraphScope({ store: unreachable, stack: rig.principal.stack, principalRef: rig.principal.principalRef, now: () => NOW });
  const res = await put(db, scope, REF, true);
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toContain("the authority store is unavailable");
  expect(graphRepositoryRefs(db)).toEqual([]);
  expect(enabledAt(db, REF)).toBeNull();
  expect(isGraphRepositoryAllowed(db, REF)).toBe(false);
  expect(restrictionHeads(await rig.service.inspectHostRecords())).toEqual([]);
});

test("a failed publication restores an untick it could not withdraw", async () => {
  const { rig, db, scope } = await bench();
  expect((await put(db, scope, REF, true)).status).toBe(200);
  const unreachable: GraphScopeStore = { inspectHostRecords: () => rig.service.inspectHostRecords(), publishHostRecord: () => Promise.reject(new Error("the authority store is unavailable")) };
  const failing = new GraphScope({ store: unreachable, stack: rig.principal.stack, principalRef: rig.principal.principalRef, now: () => NOW });
  const res = await put(db, failing, REF, false);
  expect(res.status).toBe(503);
  expect(graphRepositoryRefs(db)).toEqual([REF]);
  expect(enabledAt(db, REF)).toBe(NOW);
  expect(isGraphRepositoryAllowed(db, REF)).toBe(true);
  expect(await scope.admits(REF)).toBe(true);
});

test("a publication that fails midway leaves the table and the records agreeing on the scope they held before the change", async () => {
  const { rig, db, scope, address } = await bench();
  tick(db, OTHER, NOW - 1_000);
  tick(db, REF, NOW - 500);
  await scope.publish([OTHER]);
  let calls = 0;
  const flaky: GraphScopeStore = {
    inspectHostRecords: () => rig.service.inspectHostRecords(),
    publishHostRecord: async (record, expected) => { calls += 1; if (calls === 2) throw new Error("the second publication failed"); await rig.service.publishHostRecord(record, expected); },
  };
  const failing = new GraphScope({ store: flaky, stack: rig.principal.stack, principalRef: rig.principal.principalRef, now: () => NOW });
  const res = await put(db, failing, OTHER, false);
  expect(res.status).toBe(503);
  expect(graphRepositoryRefs(db)).toEqual([OTHER, REF].sort());
  const state = await rig.service.inspectHostRecords();
  expect(permittedGraphDestinations(state, address).map(source => source.canonicalId)).toEqual(graphRepositoryRefs(db));
  expect(await scope.admits(OTHER)).toBe(true);
  expect(await scope.admits(REF)).toBe(true);
});

test("an empty table permits no destination at all", async () => {
  const { rig, scope, address } = await bench();
  const state = await rig.service.inspectHostRecords();
  expect(permittedGraphDestinations(state, address)).toEqual([]);
  for (const ref of [REF, OTHER, "", "github:github.com/"]) expect(graphDestinationPermitted(state, address, ref)).toBe(false);
  expect(await scope.permitted()).toEqual([]);
  expect(await scope.admits(REF)).toBe(false);
});

test("the legacy exact-string check keeps governing the legacy writer on its own table", async () => {
  const { db, scope } = await bench();
  await scope.publish([REF]);
  expect(await scope.admits(REF)).toBe(true);
  expect(isGraphRepositoryAllowed(db, REF)).toBe(false);
  tick(db, REF, NOW);
  expect(isGraphRepositoryAllowed(db, REF)).toBe(true);
  for (const other of ["github:github.com/JCFischer/desk", "github:github.com/jcfischer/desk/", " github:github.com/jcfischer/desk", "github.com/jcfischer/desk"]) expect(isGraphRepositoryAllowed(db, other)).toBe(false);
  db.query("DELETE FROM desk_graph_repositories WHERE ref = ?").run(REF);
  expect(await scope.admits(REF)).toBe(true);
  expect(isGraphRepositoryAllowed(db, REF)).toBe(false);
});

test("repeating a tick or an untick publishes no further revision", async () => {
  const { rig, db, scope } = await bench();
  await put(db, scope, REF, true);
  await put(db, scope, REF, true, NOW + 1_000);
  expect(restrictionRevisions(await rig.service.inspectHostRecords())).toHaveLength(1);
  expect(restrictionHeads(await rig.service.inspectHostRecords())[0]).toMatchObject({ status: "active", revision: "1" });
  await put(db, scope, REF, false);
  await put(db, scope, REF, false, NOW + 2_000);
  expect(restrictionRevisions(await rig.service.inspectHostRecords())).toHaveLength(2);
  expect(restrictionHeads(await rig.service.inspectHostRecords())[0]).toMatchObject({ status: "revoked", revision: "2" });
});

test("a change publishes every ticked ref, including ticks stored before the host supplied a scope", async () => {
  const { rig, db, scope, address } = await bench();
  tick(db, OTHER, NOW - 1_000);
  expect((await put(db, scope, REF, true)).status).toBe(200);
  const state = await rig.service.inspectHostRecords();
  expect(graphRepositoryRefs(db)).toEqual([OTHER, REF].sort());
  expect(permittedGraphDestinations(state, address).map(source => source.canonicalId)).toEqual(graphRepositoryRefs(db));
  expect(restrictionHeads(state).every(record => record.status === "active")).toBe(true);
  expect((await put(db, scope, OTHER, false)).status).toBe(200);
  const narrowed = await rig.service.inspectHostRecords();
  expect(permittedGraphDestinations(narrowed, address).map(source => source.canonicalId)).toEqual([REF]);
  expect(restrictionHeads(narrowed).filter(record => record.status === "active")).toHaveLength(1);
});

test("a repository scope grants only the principal and the stack connection it was published for", async () => {
  const { rig, db, scope, connectionId } = await bench();
  expect((await put(db, scope, REF, true)).status).toBe(200);
  const state = await rig.service.inspectHostRecords();
  expect(graphDestinationPermitted(state, { connectionId, principalRef: randomUUID() }, REF)).toBe(false);
  expect(graphDestinationPermitted(state, { connectionId: workGraphConnectionId("another-stack"), principalRef: rig.principal.principalRef }, REF)).toBe(false);
  expect(graphDestinationPermitted(state, { connectionId, principalRef: rig.principal.principalRef }, REF)).toBe(true);
});

test("the stack's work-graph connection identity is stable and belongs to that stack alone", () => {
  expect(workGraphConnectionId("test")).toBe(workGraphConnectionId("test"));
  expect(workGraphConnectionId("test")).not.toBe(workGraphConnectionId("another-stack"));
  expect(workGraphConnectionId("test")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("without a graph scope the route saves the tick on its table alone", async () => {
  const { db } = await bench();
  expect((await put(db, null, REF, true)).status).toBe(200);
  expect(graphRepositoryRefs(db)).toEqual([REF]);
  expect(isGraphRepositoryAllowed(db, REF)).toBe(true);
  expect((await put(db, null, REF, false)).status).toBe(200);
  expect(graphRepositoryRefs(db)).toEqual([]);
});
