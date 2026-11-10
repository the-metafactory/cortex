// glossary-ignore: host, owner, run
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { authorityRig } from "../src/conversations/authority-fixtures";
import type { AuthorityState, RestrictionRecord } from "../src/conversations/authority-records";
import { handleDeskGraphRepositories } from "../src/surface/mc/api/desk-graph-repositories";
import { initDatabase } from "../src/surface/mc/db/init";
import { GraphScope, graphDestinationPermitted, permittedGraphDestinations, workGraphConnectionId, type GraphScopeStore } from "../src/surface/mc/desk/graph-repository-authority";
import { githubRef, gitlabRef, graphRepositoryRefs, isGraphRepositoryAllowed } from "../src/surface/mc/desk/graph-repositories";
import { GRAPH_REPOSITORIES_PATH } from "../src/surface/mc/desk/graph-repository-schema";
import { withTempHome } from "./probe-temp-home";

const NOW = Date.parse("2026-11-10T09:00:00.000Z");
const GITHUB = githubRef("jcfischer/desk");
const GITLAB = gitlabRef("gitlab.switch.ch", "claw/crisis-simulator");

function restrictions(state: AuthorityState): RestrictionRecord[] {
  const heads: RestrictionRecord[] = [];
  for (const records of Object.values(state.records)) {
    const head = records.at(-1);
    if (head?.kind === "restriction" && head.value.source.adapterId === "work-graph") heads.push(head.value);
  }
  return heads;
}

function tick(db: ReturnType<typeof initDatabase>, scope: GraphScope, ref: string, enabled: boolean): Promise<Response> {
  const path = `${GRAPH_REPOSITORIES_PATH}/${encodeURIComponent(ref)}`;
  return handleDeskGraphRepositories(new Request(`http://127.0.0.1${path}`, { method: "PUT", body: JSON.stringify({ enabled }) }), new URL(`http://127.0.0.1${path}`), db, { now: () => NOW, graphScope: () => scope });
}

await withTempHome(async home => {
  const rig = await authorityRig({ dir: join(home, "store") });
  const db = initDatabase(join(home, "mission-control.sqlite"));
  try {
    const connectionId = workGraphConnectionId(rig.principal.stack);
    const address = { connectionId, principalRef: rig.principal.principalRef };
    const scope = new GraphScope({ store: rig.service, stack: rig.principal.stack, principalRef: rig.principal.principalRef, now: () => NOW });
    assert.deepEqual(permittedGraphDestinations(await rig.service.inspectHostRecords(), address), []);
    assert.equal(await scope.admits(GITHUB), false);
    console.log("Empty table: no permitted destination, admission denies.");

    assert.equal((await tick(db, scope, GITHUB, true)).status, 200);
    assert.equal((await tick(db, scope, GITLAB, true)).status, 200);
    const ticked = await rig.service.inspectHostRecords();
    const held = restrictions(ticked);
    assert.equal(held.length, 2);
    assert.deepEqual(held.map(record => record.source.canonicalId).sort(), [GITHUB, GITLAB].sort());
    assert.ok(held.every(record => record.status === "active" && record.source.connectionId === connectionId && record.source.adapterId === "work-graph" && record.source.objectType === "repository"));
    assert.deepEqual(permittedGraphDestinations(ticked, address).map(source => source.canonicalId), graphRepositoryRefs(db));
    assert.equal(await scope.admits(GITHUB), true);
    assert.equal(isGraphRepositoryAllowed(db, GITHUB), true);
    console.log(`Ticked ${GITHUB} and ${GITLAB}: two active repository restrictions on the stack's work-graph connection, agreeing with the table.`);

    assert.equal((await tick(db, scope, GITHUB, false)).status, 200);
    const withdrawn = restrictions(await rig.service.inspectHostRecords());
    assert.equal(withdrawn.find(record => record.source.canonicalId === GITHUB)?.status, "revoked");
    assert.equal(await scope.admits(GITHUB), false);
    assert.equal(await scope.admits(GITLAB), true);
    assert.equal(isGraphRepositoryAllowed(db, GITHUB), false);
    console.log(`Unticked ${GITHUB}: the restriction is revoked before the response, admission denies, the other tick still admits.`);

    const unreachable: GraphScopeStore = { inspectHostRecords: () => rig.service.inspectHostRecords(), publishHostRecord: () => Promise.reject(new Error("the authority store is unavailable")) };
    const refused = new GraphScope({ store: unreachable, stack: rig.principal.stack, principalRef: rig.principal.principalRef, now: () => NOW });
    const before = graphRepositoryRefs(db);
    const failed = await tick(db, refused, GITHUB, true);
    assert.equal(failed.status, 503);
    assert.match(((await failed.json()) as { error: string }).error, /the authority store is unavailable/);
    assert.deepEqual(graphRepositoryRefs(db), before);
    assert.equal(isGraphRepositoryAllowed(db, GITHUB), false);
    console.log("Failed publication: the tick is not saved, the failure is reported, the table and the records still agree.");

    await rig.reopen();
    const reopened = new GraphScope({ store: rig.service, stack: rig.principal.stack, principalRef: rig.principal.principalRef, now: () => NOW });
    assert.equal(await reopened.admits(GITLAB), true);
    assert.equal(await reopened.admits(GITHUB), false);
    assert.deepEqual(permittedGraphDestinations(await rig.service.inspectHostRecords(), address).map(source => source.canonicalId), graphRepositoryRefs(db));
    console.log("Reopened store: the printed scope survives, still agreeing with the Settings table.");
  } finally {
    db.close();
    await rig.close();
  }
});
