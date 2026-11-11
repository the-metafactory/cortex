import { DESK_ADAPTER_SDK_VERSION, runConformance, runFailureScenarios, type ConformanceReport, type FailureReport } from "@the-metafactory/cortex/desk-adapter-conformance";

const capabilities: ConformanceReport = await runConformance(import.meta.dir);
const failures: FailureReport = await runFailureScenarios(import.meta.dir);
console.log(JSON.stringify({ sdkVersion: DESK_ADAPTER_SDK_VERSION, capabilities, failures }));
process.exit(capabilities.status === "conformant" && failures.status === "isolated" ? 0 : 1);
