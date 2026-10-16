import { readFileSync } from "node:fs";
import { gitShow, resolveBaseRef } from "./lib/git";

export const SDK_BARREL = "src/surface-sdk/index.ts";
export const SDK_DTS = "src/surface-sdk/generated/surface-sdk.d.ts";

export interface PinException {
  pin: string;
  reason: string;
  expires: string;
}

export const PIN_EXCEPTIONS: Record<string, PinException> = {};

const RELEASE_TAG = /#(?:semver:.+|v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const GIT_SPEC = /^(github:|git\+|git:|https?:\/\/.*\.git)/;

export function isGitSpec(spec: string): boolean {
  return GIT_SPEC.test(spec);
}

export function untaggedGitPins(
  deps: Record<string, string>,
  exceptions: Record<string, PinException>,
  today: string,
): string[] {
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(deps)) {
    if (!isGitSpec(spec)) continue;
    const exception = exceptions[name];
    if (exception?.pin === spec && exception.expires >= today) continue;
    if (exception?.pin === spec) problems.push(`${name}: exception expired ${exception.expires} (${exception.reason})`);
    else if (!RELEASE_TAG.test(spec)) problems.push(`${name}: ${spec} is not a release tag`);
  }
  return problems;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A tag can be moved; bun.lock must hold the commit it resolved to and that tarball's integrity hash. */
export function unlockedGitDeps(deps: Record<string, string>, lockText: string): string[] {
  return Object.entries(deps)
    .filter(([, spec]) => isGitSpec(spec))
    .filter(([name]) => {
      const entry = new RegExp(`^\\s*"${escapeRegExp(name)}": \\["${escapeRegExp(name)}@[^"]*#[0-9a-f]{7,40}"[^\\n]*"sha512-`, "m");
      return !entry.test(lockText);
    })
    .map(([name]) => `${name}: bun.lock does not fix it to a commit with an integrity hash; run bun install and commit bun.lock`);
}

export function sdkVersion(source: string): string | undefined {
  return /export (?:declare )?const SURFACE_SDK_VERSION = "([^"]+)"/.exec(source)?.[1];
}

export function contractShape(dts: string): string {
  return dts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//") && !line.includes("SURFACE_SDK_VERSION"))
    .join("\n");
}

export function sdkBumpMissing(baseDts: string, headDts: string): boolean {
  return contractShape(baseDts) !== contractShape(headDts) && sdkVersion(baseDts) === sdkVersion(headDts);
}

if (import.meta.main) {
  const baseRef = resolveBaseRef("RELEASE_PINS_BASE_REF", "release pins");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const problems = [
    ...untaggedGitPins(deps, PIN_EXCEPTIONS, new Date().toISOString().slice(0, 10)).map(
      (p) => `${p}. Pin a released tag (#vX.Y.Z), never a branch or commit.`,
    ),
    ...unlockedGitDeps(deps, readFileSync("bun.lock", "utf8")),
  ];

  const baseDts = gitShow(baseRef, SDK_DTS);
  if (baseDts === undefined) {
    console.error(`release pins: ${SDK_DTS} is missing at ${baseRef}`);
    process.exit(2);
  }
  if (sdkBumpMissing(baseDts, readFileSync(SDK_DTS, "utf8"))) {
    problems.push(
      `${SDK_DTS} changed its exported contract against ${baseRef} but SURFACE_SDK_VERSION is still ${sdkVersion(baseDts) ?? "?"}. ` +
        `Bump it in ${SDK_BARREL} (minor for an addition, major for a break), then bun run sdk:dts.`,
    );
  }

  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
}
