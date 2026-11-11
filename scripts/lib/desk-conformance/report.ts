export type Verdict = "conformant" | "refused" | "not-run";
export type ProbeKind = "destinations" | "query" | "observation" | "draft" | "action" | "readback";

export interface CapabilityReport {
  capabilityId: string;
  probe: ProbeKind;
  verdict: Verdict;
  code?: string;
  detail: string;
  released: number;
}

export interface OwnerCalls {
  dispatch: number;
  cancel: number;
  lookup: number;
  readback: number;
}

export interface ConformanceReport {
  packageDir: string;
  packageId?: string;
  adapterId?: string;
  status: Verdict;
  code?: string;
  reason?: string;
  capabilities: CapabilityReport[];
  actions: string[];
  ownerCalls: OwnerCalls;
  networkRequests: number;
  credentialRequests: number;
}

export const emptyOwnerCalls = (): OwnerCalls => ({ dispatch: 0, cancel: 0, lookup: 0, readback: 0 });
export const totalOwnerCalls = (calls: OwnerCalls): number => calls.dispatch + calls.cancel + calls.lookup + calls.readback;

export const conformant = (capabilityId: string, probe: ProbeKind, detail: string, released = 0): CapabilityReport => ({ capabilityId, probe, verdict: "conformant", detail, released });
export const refused = (capabilityId: string, probe: ProbeKind, code: string, detail: string): CapabilityReport => ({ capabilityId, probe, verdict: "refused", code, detail, released: 0 });
export const notRun = (capabilityId: string, probe: ProbeKind, code: string, detail: string): CapabilityReport => ({ capabilityId, probe, verdict: "not-run", code, detail, released: 0 });

export function overallVerdict(capabilities: readonly CapabilityReport[]): { status: Verdict; code?: string } {
  const refusal = capabilities.find(item => item.verdict === "refused");
  if (refusal) return { status: "refused", ...(refusal.code === undefined ? {} : { code: refusal.code }) };
  const skipped = capabilities.find(item => item.verdict === "not-run");
  if (skipped) return { status: "not-run", ...(skipped.code === undefined ? {} : { code: skipped.code }) };
  return { status: "conformant" };
}

export function formatReport(report: ConformanceReport): string {
  const lines = [`${report.status.toUpperCase()}${report.code ? ` ${report.code}` : ""}  ${report.packageId ?? report.packageDir}`];
  if (report.reason) lines.push(`  ${report.reason}`);
  for (const item of report.capabilities) lines.push(`  ${item.verdict.padEnd(10)} ${item.probe.padEnd(12)} ${item.capabilityId}${item.code ? ` [${item.code}]` : ""}  ${item.detail}`);
  lines.push(`  actions: ${report.actions.length === 0 ? "none" : report.actions.join(", ")}; owner calls: ${totalOwnerCalls(report.ownerCalls)}; network requests: ${report.networkRequests}; credential requests: ${report.credentialRequests}`);
  return lines.join("\n");
}

export const refusedBy = (capabilityId: string, probe: ProbeKind, why: { code: string; detail: string }): CapabilityReport => refused(capabilityId, probe, why.code, why.detail);
