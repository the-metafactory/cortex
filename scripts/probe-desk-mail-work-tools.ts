import { strict as assert } from "node:assert";
import { assertMailPolicyRace, assertMailWorkPolicies, callMailWorkTool, openMailWorkRig } from "../src/conversations/domain-adapters/__tests__/fixtures/mail-work-tools-fixtures";
import { withTempHome } from "./probe-temp-home";

await withTempHome(async () => {
  for (const policy of ["local", "cloud"] as const) {
    const rig = await openMailWorkRig(policy);
    try {
      await assertMailWorkPolicies(rig);
      console.log(`${policy}: connection policies, permitted fields, distinct sources, Mail text passthrough and zero owner effects during direct tool reads passed`);
      if (policy === "cloud") {
        for (const name of ["work_search", "work_read"] as const) {
          for (const fetchNumber of [1, 2]) await assertMailPolicyRace(rig, name, fetchNumber);
        }
        console.log("cloud: policy changes during fetch and final reread withhold Mail");
        const populated = await callMailWorkTool(rig, "work_search", { kinds: ["mail"] });
        const before = rig.rig.calls.read;
        rig.listings.splice(0);
        const empty = await callMailWorkTool(rig, "work_search", { kinds: ["mail"] });
        assert.deepEqual(empty, populated);
        assert.deepEqual(empty.json.results, []);
        assert.equal(empty.json.status, "denied");
        assert.equal(rig.rig.calls.read, before);
        console.log("cloud: empty and populated local accounts are indistinguishable and never fetched");
      }
    } finally { await rig.close(); }
  }
});
