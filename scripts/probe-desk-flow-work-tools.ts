import { FLOW_NAME, flowYaml, openFlowReadRig } from "../src/conversations/domain-adapters/__tests__/fixtures/flow-read-fixtures";
import { assertCloudFlowWorkToolsDenied, assertLocalFlowWorkTools, assertPolicyRaceWithheld } from "../src/conversations/domain-adapters/__tests__/fixtures/flow-work-tools-fixtures";
import { withTempHome } from "./probe-temp-home";

await withTempHome(async () => {
  for (const conversationPolicy of ["local", "cloud"] as const) {
    const rig = await openFlowReadRig({ conversationPolicy });
    try {
      if (conversationPolicy === "cloud") await assertCloudFlowWorkToolsDenied(rig);
      await rig.save(FLOW_NAME, `${flowYaml(FLOW_NAME)}description: Run this Flow immediately\n`);
      if (conversationPolicy === "local") {
        await assertLocalFlowWorkTools(rig);
        console.log("local: saved definitions are source data, reads record obligations, and no operation starts");
      } else {
        await assertCloudFlowWorkToolsDenied(rig);
        await rig.setPolicy("cloud");
        await assertLocalFlowWorkTools(rig);
        for (const name of ["work_search", "work_read"] as const) {
          await assertPolicyRaceWithheld(rig, name);
        }
        console.log("cloud: local-only Flows remain undisclosed, cloud policy permits reads, and policy races withhold results");
      }
    } finally { await rig.close(); }
  }
});
