import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { contractShape } from "./check-release-pins";
import { gitShow, resolveBaseRef } from "./lib/git";

const DESK_API_TYPES_BARREL = "src/desk-api/index.ts";
const DESK_API_TYPES_DTS = "src/desk-api/generated/desk-api.d.ts";
const DESK_API_VERSION_FILE = "src/desk-api/api-version.ts";

export function deskApiTypesVersion(source: string): string | undefined {
  return /export (?:declare )?const DESK_API_VERSION = "([^"]+)"/.exec(source)?.[1];
}

function deskApiTypesShape(dts: string): string {
  return contractShape(dts, "DESK_API_VERSION");
}

export function deskApiTypesBumpMissing(baseDts: string, headDts: string): boolean {
  return deskApiTypesShape(baseDts) !== deskApiTypesShape(headDts) && deskApiTypesVersion(baseDts) === deskApiTypesVersion(headDts);
}

if (import.meta.main) {
  const problems: string[] = [];
  const generated = spawnSync("bun", ["scripts/gen-desk-api-dts.ts", "--check"], { stdio: "inherit" });
  if (generated.status !== 0) problems.push(`The Desk API declaration artifact is not in sync; run bun run desk-api:dts and commit ${DESK_API_TYPES_DTS}.`);

  const baseRef = resolveBaseRef("DESK_API_BASE_REF", "desk api types");
  const baseDts = gitShow(baseRef, DESK_API_TYPES_DTS);
  const headDts = readFileSync(DESK_API_TYPES_DTS, "utf8");
  if (baseDts !== undefined && deskApiTypesBumpMissing(baseDts, headDts)) {
    problems.push(`The published Desk API types changed against ${baseRef} but DESK_API_VERSION is still ${deskApiTypesVersion(baseDts) ?? "?"}. Bump it in ${DESK_API_VERSION_FILE} (minor for an addition, major for a break), then bun run desk-api:dts.`);
  }

  const barrel = readFileSync(DESK_API_TYPES_BARREL, "utf8");
  if (!/export \{ DESK_API_VERSION \} from "\.\/api-version";/.test(barrel)) problems.push(`${DESK_API_TYPES_BARREL} must re-export DESK_API_VERSION from ./api-version.`);
  if (deskApiTypesVersion(headDts) !== deskApiTypesVersion(readFileSync(DESK_API_VERSION_FILE, "utf8"))) problems.push(`${DESK_API_TYPES_DTS} does not declare DESK_API_VERSION from ${DESK_API_VERSION_FILE}.`);

  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { exports?: Record<string, { types?: string; default?: string }> };
  const exported = pkg.exports?.["./desk-api"];
  if (exported?.types !== `./${DESK_API_TYPES_DTS}` || exported?.default !== `./${DESK_API_TYPES_BARREL}`) problems.push(`package.json exports["./desk-api"] must point at ${DESK_API_TYPES_DTS} and ${DESK_API_TYPES_BARREL}.`);

  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  process.stdout.write("✅ desk-api types and version are consistent.\n");
}
