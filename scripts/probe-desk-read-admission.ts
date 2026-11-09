import { strict as assert } from "node:assert";
import { join } from "node:path";
import { authorityRig } from "../src/conversations/authority-fixtures";
import { objectRef } from "../src/conversations/domain-adapters/fixtures";
import { withTempHome } from "./probe-temp-home";

await withTempHome(async home => {
  const rig = await authorityRig({ dir: join(home, "store") });
  try {
    const area = objectRef("balance", "area", "area-example");
    const request = { connectionId: rig.connection.connectionId, capabilityId: "balance.object.read", destinations: [area], input: { area, title: "query" } };
    rig.hooks.read = () => Promise.resolve({ objects: [{ ref: objectRef("balance", "task", "first-seen"), schemaRef: { schemaId: "balance.task.create.input", version: "1.0.0" }, destination: area, value: { area, title: "First seen" } }] });
    assert.equal((await rig.service.admitRead(rig.context, request, rig.sink)).kind, "released");
    assert.equal(rig.calls.read, 1);
    assert.equal(rig.calls.sends.length, 1);
    await rig.reopen();
    await rig.service.publishHostRecord({ kind: "restriction", value: { ...rig.objectRestriction, status: "revoked", revision: "2" } }, 1);
    assert.equal((await rig.service.admitRead(rig.context, request, rig.sink)).kind, "withheld");
    assert.equal(rig.calls.read, 1);
    assert.equal(rig.calls.sends.length, 1);
    console.log("Synthetic read admission: permitted destination admitted one read; first-seen object released; revoked destination restriction made zero further connector and sink calls.");
  } finally { await rig.close(); }
});
