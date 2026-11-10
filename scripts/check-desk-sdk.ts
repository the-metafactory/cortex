import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gitShow, resolveBaseRef } from "./lib/git";

export const DESK_SDK_BARREL = "src/desk-sdk/index.ts";
export const DESK_SDK_VERSION_FILE = "src/desk-sdk/version.ts";
export const DESK_SDK_DTS = "src/desk-sdk/generated/desk-sdk.d.ts";

export function deskSdkVersion(source: string): string | undefined {
  return /export (?:declare )?const DESK_ADAPTER_SDK_VERSION = "([^"]+)"/.exec(source)?.[1];
}

export function deskContractShape(dts: string): string {
  return dts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line !== "" && !line.startsWith("//") && !line.includes("DESK_ADAPTER_SDK_VERSION"))
    .join("\n");
}

export function deskSdkBumpMissing(baseDts: string, headDts: string): boolean {
  return deskContractShape(baseDts) !== deskContractShape(headDts) && deskSdkVersion(baseDts) === deskSdkVersion(headDts);
}

if (import.meta.main) {
  const problems: string[] = [];
  const generated = spawnSync("bun", ["run", "desk:dts:check"], { stdio: "inherit" });
  if (generated.status !== 0) problems.push(`${DESK_SDK_DTS} is not in sync with ${DESK_SDK_BARREL}; run bun run desk:dts and commit the result.`);

  const baseRef = resolveBaseRef("DESK_SDK_BASE_REF", "desk sdk");
  const baseDts = gitShow(baseRef, DESK_SDK_DTS);
  const headDts = readFileSync(DESK_SDK_DTS, "utf8");
  if (baseDts !== undefined && deskSdkBumpMissing(baseDts, headDts)) {
    problems.push(`${DESK_SDK_DTS} changed its exported contract against ${baseRef} but DESK_ADAPTER_SDK_VERSION is still ${deskSdkVersion(baseDts) ?? "?"}. Bump it in ${DESK_SDK_BARREL} (minor for an addition, major for a break), then bun run desk:dts.`);
  }

  const barrel = readFileSync(DESK_SDK_BARREL, "utf8");
  const barrelVersion = deskSdkVersion(readFileSync(DESK_SDK_VERSION_FILE, "utf8"));
  if (!barrelVersion || !/^[1-9]\d*\.\d+\.\d+$/.test(barrelVersion)) problems.push(`${DESK_SDK_VERSION_FILE} must declare a SemVer DESK_ADAPTER_SDK_VERSION; found ${barrelVersion ?? "none"}.`);
  if (!/export \{ DESK_ADAPTER_SDK_VERSION \} from "\.\/version";/.test(barrel)) problems.push(`${DESK_SDK_BARREL} must re-export DESK_ADAPTER_SDK_VERSION from ./version.`);
  if (deskSdkVersion(headDts) !== barrelVersion) problems.push(`${DESK_SDK_DTS} does not declare the SDK's DESK_ADAPTER_SDK_VERSION.`);

  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { exports?: Record<string, { types?: string; default?: string }> };
  const exported = pkg.exports?.["./desk-sdk"];
  if (exported?.types !== `./${DESK_SDK_DTS}` || exported?.default !== `./${DESK_SDK_BARREL}`) problems.push(`package.json exports["./desk-sdk"] must point at ${DESK_SDK_DTS} and ${DESK_SDK_BARREL}.`);

  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  process.stdout.write("✅ desk-sdk version and declaration contract are consistent.\n");
}
