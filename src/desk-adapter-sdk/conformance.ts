import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { guardNetwork } from "./conformance/network";
import type { ConformanceReport } from "./conformance/report";
import { executePackage } from "./conformance/run";

export { DESK_ADAPTER_SDK_VERSION } from "../desk-sdk/version";
export { formatReport, type CapabilityReport, type ConformanceReport, type OwnerCalls, type ProbeKind, type Verdict } from "./conformance/report";
export { FAILURE_SCENARIOS, formatFailureReport, runFailureScenarios, type CompanionReport, type FailureOptions, type FailureReport, type ScenarioName, type ScenarioReport, type ScenarioVerdict } from "./conformance/failures";

/** Drives one local Desk adapter package through the production Cortex runtime seams and reports each capability. */
export async function runConformance(packageDir: string, tempParent = tmpdir()): Promise<ConformanceReport> {
  const temp = await mkdtemp(join(tempParent, "desk-conformance-"));
  const guard = guardNetwork();
  try {
    const outcome = await executePackage(resolve(packageDir), temp);
    return { ...outcome, networkRequests: guard.count() };
  } finally {
    guard.release();
    await rm(temp, { recursive: true, force: true });
  }
}
