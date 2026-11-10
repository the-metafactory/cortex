import { strict as assert } from "node:assert";
import { withTempHome } from "./probe-temp-home";
import { balanceDestinations } from "../src/surface/mc/desk/balance-destinations";
import { loadBalanceState } from "../src/surface/mc/desk/balance-store";
import { HOME_AREA, openBalanceReadRig, releasedObjects, tasksIn } from "../src/conversations/domain-adapters/__tests__/fixtures/balance-read-fixtures";

await withTempHome(async () => {
  const rig = await openBalanceReadRig();
  try {
    const state = loadBalanceState(rig.db);
    assert.ok(state);
    const expected = balanceDestinations(state.outline, rig.areas);
    const destinations = await rig.destinations();
    assert.deepEqual(destinations.annotations.map(annotation => annotation.ref.canonicalId), expected.map(destination => destination.project ? destination.id : destination.area));
    assert.deepEqual((destinations.payload as { items: { label: string }[] }).items.map(item => item.label), expected.map(destination => destination.label));
    console.log("destinations: configured areas and open projects use canonical identities, never titles");

    const queried = await rig.taskQuery();
    assert.equal(queried.result.status, "ok");
    const saved = tasksIn(state, "area-example");
    const queriedObjects = releasedObjects(queried.released);
    assert.deepEqual(queriedObjects.map(object => object.ref.canonicalId), saved.map(node => node.id));
    assert.deepEqual(queriedObjects.map(object => [object.value.title, object.value.status, object.value.dueDate]), saved.map(node => [node.title, node.done ? "done" : "open", node.dueDate ?? null]));
    console.log("task query: released objects match loadBalanceState");

    const read = await rig.taskRead("task-wing");
    assert.equal(read.result.status, "ok");
    const [task] = releasedObjects(read.released);
    assert.equal(task?.ref.canonicalId, "task-wing");
    assert.equal(task?.value.title, saved.find(node => node.id === "task-wing")?.title);
    console.log("task read: released object matches loadBalanceState");

    rig.removeTask("task-wing");
    const deleted = await rig.taskRead("task-wing");
    assert.equal(deleted.result.status, "unavailable");
    assert.equal(deleted.released, undefined);
    assert.ok(!JSON.stringify(deleted.result).includes("Cut the wing"));
    console.log("deleted task: unavailable and no historic operation evidence");

    await rig.allowHome();
    rig.removeArea("area-home");
    const removed = await rig.taskQuery({ area: HOME_AREA }, [HOME_AREA]);
    assert.equal(removed.result.status, "unavailable");
    assert.equal(removed.released, undefined);
    assert.ok(!JSON.stringify(removed.result).includes("Water the garden"));
    console.log("removed area: read unavailable with no name or count");
  } finally {
    await rig.close();
  }
});
