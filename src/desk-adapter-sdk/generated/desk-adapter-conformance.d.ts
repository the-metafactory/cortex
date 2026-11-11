
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
export declare const DESK_ADAPTER_SDK_VERSION = "1.4.0";
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
/** Drives one local Desk adapter package through the production Cortex runtime seams and reports each capability. */
export declare function runConformance(packageDir: string, tempParent?: string): Promise<ConformanceReport>;

export {};
