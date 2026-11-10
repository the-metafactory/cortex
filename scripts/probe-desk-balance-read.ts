import { strict as assert } from "node:assert";
import { withTempHome } from "./probe-temp-home";
import { balanceDestinations } from "../src/surface/mc/desk/balance-destinations";
import { loadBalanceState } from "../src/surface/mc/desk/balance-store";
import { HOME_AREA, LAB_AREA, LAB_TASK_IDS, leaf, openBalanceReadRig, releasedObjects, savedNode } from "../src/conversations/domain-adapters/__tests__/fixtures/balance-read-fixtures";

await withTempHome(async () => {
  const rig = await openBalanceReadRig();
  try {
    const initial = loadBalanceState(rig.db);
    assert.ok(initial);
    const expected = balanceDestinations(initial.outline, rig.areas);
    const destinations = await rig.destinations();
    assert.deepEqual(destinations.annotations.map(annotation => annotation.ref.canonicalId), expected.map(destination => destination.project ? destination.id : destination.area));
    assert.deepEqual((destinations.payload as { items: { label: string }[] }).items.map(item => item.label), expected.map(destination => destination.label));
    console.log("destinations: configured areas and open projects use canonical identities, never titles");

    rig.addTask("project-glider", leaf("task-probe", "Probe task", { dueDate: "2026-12-24" }));
    const state = loadBalanceState(rig.db);
    assert.ok(state);
    const queried = await rig.taskQuery();
    assert.equal(queried.result.status, "ok");
    const queriedObjects = releasedObjects(queried.released);
    assert.deepEqual(queriedObjects.map(object => object.ref.canonicalId), ["task-probe", ...LAB_TASK_IDS]);
    for (const object of queriedObjects) {
      const saved = savedNode(state, object.ref.canonicalId);
      assert.equal(object.value.title, saved.title);
      assert.equal(object.value.status, saved.done === true ? "done" : "open");
      assert.equal(object.value.dueDate, saved.dueDate ?? null);
      assert.deepEqual(object.value.area, LAB_AREA);
    }
    console.log("task query: released objects match loadBalanceState");

    const read = await rig.taskRead("task-probe");
    assert.equal(read.result.status, "ok");
    const [task] = releasedObjects(read.released);
    const saved = savedNode(state, "task-probe");
    assert.equal(task?.ref.canonicalId, "task-probe");
    assert.equal(task?.value.title, saved.title);
    assert.equal(task?.value.dueDate, saved.dueDate);
    console.log("task read: released object matches loadBalanceState");

    const paged: string[] = [];
    let step = await rig.taskQuery({ area: LAB_AREA, limit: 1 });
    assert.equal(step.result.groups[0]?.coverage, "more");
    paged.push(...releasedObjects(step.released).map(object => object.ref.canonicalId));
    while (step.result.continuation) {
      step = await rig.continueTaskQuery(step);
      paged.push(...releasedObjects(step.released).map(object => object.ref.canonicalId));
    }
    assert.equal(step.result.groups[0]?.coverage, "exhausted");
    assert.deepEqual(paged, ["task-probe", ...LAB_TASK_IDS]);
    const reopened = await rig.taskQuery({ area: LAB_AREA, limit: 1 });
    rig.addTask("project-glider", leaf("task-inserted", "Inserted first"));
    const shifted = await rig.continueTaskQuery(reopened);
    assert.equal(shifted.result.restartRequired, true);
    assert.equal(shifted.released, undefined);
    console.log("stable snapshot: pages agree until the projection changes, then the continuation restarts");

    rig.removeTask("task-probe");
    const deleted = await rig.taskRead("task-probe");
    assert.equal(deleted.result.status, "unavailable");
    assert.equal(deleted.released, undefined);
    assert.ok(!JSON.stringify(deleted.result).includes("Probe task"));
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
