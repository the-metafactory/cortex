// CI gate for scripts/__tests__/dashboard-build.sh: postinstall and postupgrade
// must build the Mission Control dashboard (cortex#2770).
import { expect, it } from "bun:test";

it("install and upgrade hooks build the Mission Control dashboard", () => {
  const suite = Bun.spawnSync(["bash", `${import.meta.dir}/dashboard-build.sh`]);
  const report = suite.stdout.toString() + suite.stderr.toString();
  expect({ exitCode: suite.exitCode, summary: report.trim().split("\n").at(-1) }).toEqual({ exitCode: 0, summary: "11 passed, 0 failed" });
});
