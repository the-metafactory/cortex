import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { contractShape } from "./check-release-pins";
import { gitShow, resolveBaseRef } from "./lib/git";

export const DESK_SDK_BARREL = "src/desk-sdk/index.ts";
export const DESK_SDK_VERSION_FILE = "src/desk-sdk/version.ts";
export const CONFORMANCE_BARREL = "src/desk-adapter-sdk/conformance.ts";
export const CONFORMANCE_DTS = "src/desk-adapter-sdk/generated/desk-adapter-conformance.d.ts";
export const DESK_SDK_DTS = "src/desk-sdk/generated/desk-sdk.d.ts";

export function deskSdkVersion(source: string): string | undefined {
  return /export (?:declare )?const DESK_ADAPTER_SDK_VERSION = "([^"]+)"/.exec(source)?.[1];
}

export function deskContractShape(dts: string): string {
  return contractShape(dts, "DESK_ADAPTER_SDK_VERSION");
}

export function deskSdkBumpMissing(baseDts: string, headDts: string, baseConformanceDts = "", headConformanceDts = ""): boolean {
  return (deskContractShape(baseDts) !== deskContractShape(headDts) || deskContractShape(baseConformanceDts) !== deskContractShape(headConformanceDts)) && deskSdkVersion(baseDts) === deskSdkVersion(headDts);
}

if (import.meta.main) {
  const problems: string[] = [];
  const generated = spawnSync("bun", ["run", "desk:dts:check"], { stdio: "inherit" });
  if (generated.status !== 0) problems.push(`Desk SDK declaration artifacts are not in sync; run bun run desk:dts and commit both generated files.`);

  const baseRef = resolveBaseRef("DESK_SDK_BASE_REF", "desk sdk");
  const baseDts = gitShow(baseRef, DESK_SDK_DTS);
  const headDts = readFileSync(DESK_SDK_DTS, "utf8");
  const conformanceDts = readFileSync(CONFORMANCE_DTS, "utf8");
  if (baseDts !== undefined && deskSdkBumpMissing(baseDts, headDts, gitShow(baseRef, CONFORMANCE_DTS), conformanceDts)) {
    problems.push(`The Desk SDK or conformance harness changed its exported contract against ${baseRef} but DESK_ADAPTER_SDK_VERSION is still ${deskSdkVersion(baseDts) ?? "?"}. Bump it in ${DESK_SDK_VERSION_FILE} (minor for an addition, major for a break), then bun run desk:dts.`);
  }

  const barrel = readFileSync(DESK_SDK_BARREL, "utf8");
  const barrelVersion = deskSdkVersion(readFileSync(DESK_SDK_VERSION_FILE, "utf8"));
  if (!barrelVersion || !/^[1-9]\d*\.\d+\.\d+$/.test(barrelVersion)) problems.push(`${DESK_SDK_VERSION_FILE} must declare a SemVer DESK_ADAPTER_SDK_VERSION; found ${barrelVersion ?? "none"}.`);
  if (!/export \{ DESK_ADAPTER_SDK_VERSION \} from "\.\/version";/.test(barrel)) problems.push(`${DESK_SDK_BARREL} must re-export DESK_ADAPTER_SDK_VERSION from ./version.`);
  if (deskSdkVersion(conformanceDts) !== barrelVersion) problems.push(`${CONFORMANCE_DTS} does not declare the SDK version.`);
  if (deskSdkVersion(headDts) !== barrelVersion) problems.push(`${DESK_SDK_DTS} does not declare the SDK's DESK_ADAPTER_SDK_VERSION.`);

  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { exports?: Record<string, { types?: string; default?: string }> };
  const exported = pkg.exports?.["./desk-sdk"];
  if (exported?.types !== `./${DESK_SDK_DTS}` || exported?.default !== `./${DESK_SDK_BARREL}`) problems.push(`package.json exports["./desk-sdk"] must point at ${DESK_SDK_DTS} and ${DESK_SDK_BARREL}.`);

  const conformanceExport = pkg.exports?.["./desk-adapter-conformance"];
  if (conformanceExport?.types !== `./${CONFORMANCE_DTS}` || conformanceExport?.default !== `./${CONFORMANCE_BARREL}`) problems.push(`package.json exports["./desk-adapter-conformance"] must point at ${CONFORMANCE_DTS} and ${CONFORMANCE_BARREL}.`);

  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  process.stdout.write("✅ desk-sdk version and declaration contract are consistent.\n");
}
