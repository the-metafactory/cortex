export type Verdict = "conformant" | "refused" | "not-run";
export type ProbeKind = "destinations" | "query" | "observation" | "draft" | "action" | "readback" | "cloud-reader";

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

// glossary-ignore: host, run
/**
 * What one query binding answered on one connection the run's Mail source binds, read through the host query
 * runner. `pages` are the pages the host released to the reader, as it released them; `objects` holds each released
 * object's `value`, in order. `dataPolicy` is the read restriction the run published for the connection's
 * destinations, absent when no destination was listed and so none was published.
 */
export interface ConformanceMailQuery {
  connectionId: string;
  capabilityId: string;
  verdict: Verdict;
  code?: string;
  detail: string;
  dataPolicy?: "local" | "cloud";
  pages: unknown[];
  objects: unknown[];
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
  mailQueries?: ConformanceMailQuery[];
}

export const emptyOwnerCalls = (): OwnerCalls => ({ dispatch: 0, cancel: 0, lookup: 0, readback: 0 });
export const totalOwnerCalls = (calls: OwnerCalls): number => calls.dispatch + calls.cancel + calls.lookup + calls.readback;

export const conformant = (capabilityId: string, probe: ProbeKind, detail: string, released = 0): CapabilityReport => ({ capabilityId, probe, verdict: "conformant", detail, released });
export const refused = (capabilityId: string, probe: ProbeKind, code: string, detail: string): CapabilityReport => ({ capabilityId, probe, verdict: "refused", code, detail, released: 0 });
export const notRun = (capabilityId: string, probe: ProbeKind, code: string, detail: string): CapabilityReport => ({ capabilityId, probe, verdict: "not-run", code, detail, released: 0 });

export function overallVerdict(capabilities: readonly Pick<CapabilityReport, "verdict" | "code">[]): { status: Verdict; code?: string } {
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
  for (const query of report.mailQueries ?? []) lines.push(`  ${query.verdict.padEnd(10)} ${"mail query".padEnd(12)} ${query.capabilityId} on ${query.connectionId}${query.code ? ` [${query.code}]` : ""}  ${query.objects.length} object(s)`);
  lines.push(`  actions: ${report.actions.length === 0 ? "none" : report.actions.join(", ")}; owner calls: ${totalOwnerCalls(report.ownerCalls)}; network requests: ${report.networkRequests}; credential requests: ${report.credentialRequests}`);
  return lines.join("\n");
}

export const refusedBy = (capabilityId: string, probe: ProbeKind, why: { code: string; detail: string }): CapabilityReport => refused(capabilityId, probe, why.code, why.detail);
