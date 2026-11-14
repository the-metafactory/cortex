
/** One mail as a Mail source listed it. A native `SourceReading` mail entry satisfies this shape. */
export interface MailSourceItem {
	readonly id: string;
	readonly account?: string;
	readonly from: {
		readonly name?: string;
		readonly address: string;
	};
	readonly subject: string;
	readonly receivedAt: string;
	readonly unread: boolean;
	readonly firstParagraph?: string;
}
/** One Mail source's last listing, as the host's source cache holds it; `error` is set when that run failed. */
export interface MailSourceListing {
	readonly id: string;
	readonly readAt: number;
	readonly error: string | null;
	readonly mail: readonly MailSourceItem[];
}
/** The host's binding of one adapter connection to one Mail source and one account (cortex#3294 Q7). */
export interface MailConnectionBinding {
	readonly adapterId: string;
	readonly connectionId: string;
	readonly sourceId: string;
	readonly account: string;
	readonly dataPolicy?: "local" | "cloud";
}
/** What the host supplies the loader so out-of-tree adapters can read listed mail. */
export interface MailReadSource {
	connections(): readonly MailConnectionBinding[];
	listings(): readonly MailSourceListing[];
}
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
export declare function formatReport(report: ConformanceReport): string;
export declare const DESK_ADAPTER_SDK_VERSION = "1.6.0";
/** The connection id every conformance run uses for the package's one synthetic connection. */
export declare const CONFORMANCE_CONNECTION_ID = "conformance-connection";
export type ScenarioVerdict = "isolated" | "failed";
export declare const FAILURE_SCENARIOS: readonly [
	"module-load",
	"owner-success",
	"owner-timeout",
	"owner-invalid-output",
	"owner-exit",
	"duplicate-delivery",
	"restart-after-success",
	"crash-before-result",
	"revoked-query",
	"revoked-write"
];
export type ScenarioName = (typeof FAILURE_SCENARIOS)[number];
export interface ScenarioReport {
	scenario: ScenarioName;
	verdict: ScenarioVerdict;
	code?: string;
	detail: string;
	operation?: string;
	ownerCalls: OwnerCalls;
	released: number;
	networkRequests: number;
}
export interface CompanionReport {
	packageDir: string;
	adapterId?: string;
	status: Verdict | "not-run";
	code?: string;
	samePackage: boolean;
}
export interface FailureReport {
	packageDir: string;
	packageId?: string;
	adapterId?: string;
	status: ScenarioVerdict;
	code?: string;
	reason?: string;
	scenarios: ScenarioReport[];
	companion: CompanionReport;
	networkRequests: number;
}
export interface FailureOptions {
	companionDir?: string;
}
/** Drives one package through the named failure scenarios and reports each as isolated or failed. */
export declare function runFailureScenarios(packageDir: string, options?: FailureOptions): Promise<FailureReport>;
export declare function formatFailureReport(report: FailureReport): string;
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
export declare function runConformance(packageDir: string, options?: string | ConformanceOptions): Promise<ConformanceReport>;

export {};
