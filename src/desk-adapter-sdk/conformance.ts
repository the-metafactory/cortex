import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MailReadSource } from "../conversations/domain-adapters/mail-read-source";
import { guardNetwork } from "./conformance/network";
import type { ConformanceReport } from "./conformance/report";
import { executePackage } from "./conformance/run";

export { DESK_ADAPTER_SDK_VERSION } from "../desk-sdk/version";
export { CONFORMANCE_CONNECTION_ID } from "./conformance/connection";
export type { MailConnectionBinding, MailReadSource, MailSourceItem, MailSourceListing } from "../conversations/domain-adapters/mail-read-source";
export { formatReport, type CapabilityReport, type ConformanceReport, type OwnerCalls, type ProbeKind, type Verdict } from "./conformance/report";
export { FAILURE_SCENARIOS, formatFailureReport, runFailureScenarios, type CompanionReport, type FailureOptions, type FailureReport, type ScenarioName, type ScenarioReport, type ScenarioVerdict } from "./conformance/failures";

// glossary-ignore: host, run
/**
 * Options for one conformance run. `tempParent` is where the run's temporary store is made (the system temp
 * directory by default). `mail` is a fake Mail source the run's host reads listed mail from: a binding for the
 * package's adapter and `CONFORMANCE_CONNECTION_ID` makes `host.mail.listed()` serve that connection inside the
 * query and observation probes, and the binding's `dataPolicy` sets the read restriction the host publishes for the
 * connection's destinations, as `mailReadRestriction` does.
 */
export interface ConformanceOptions {
  tempParent?: string;
  mail?: MailReadSource;
}

/** Drives one local Desk adapter package through the production Cortex runtime seams and reports each capability. */
export async function runConformance(packageDir: string, options: string | ConformanceOptions = {}): Promise<ConformanceReport> {
  const { tempParent = tmpdir(), mail } = typeof options === "string" ? { tempParent: options } : options;
  const temp = await mkdtemp(join(tempParent, "desk-conformance-"));
  const guard = guardNetwork();
  try {
    const outcome = await executePackage(resolve(packageDir), temp, mail);
    return { ...outcome, networkRequests: guard.count() };
  } finally {
    guard.release();
    await rm(temp, { recursive: true, force: true });
  }
}
