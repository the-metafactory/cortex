import { readFileSync } from "node:fs";

export const SDK_BARREL = "src/surface-sdk/index.ts";
export const SDK_DTS = "src/surface-sdk/generated/surface-sdk.d.ts";

export interface PinException {
  pin: string;
  reason: string;
  expires: string;
}

export const PIN_EXCEPTIONS: Record<string, PinException> = {};

const COMMIT_PIN = /#[0-9a-f]{7,40}$/;
const GIT_SPEC = /^(github:|git\+|git:|https?:\/\/.*\.git)/;

export function untaggedGitPins(
  deps: Record<string, string>,
  exceptions: Record<string, PinException>,
  today: string,
): string[] {
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(deps)) {
    if (!GIT_SPEC.test(spec)) continue;
    const exception = exceptions[name];
    if (exception?.pin === spec && exception.expires >= today) continue;
    if (exception?.pin === spec) problems.push(`${name}: exception expired ${exception.expires} (${exception.reason})`);
    else if (COMMIT_PIN.test(spec) || !spec.includes("#")) problems.push(`${name}: ${spec} is not a release tag`);
  }
  return problems;
}

export function sdkVersion(source: string): string | undefined {
  return /export (?:declare )?const SURFACE_SDK_VERSION = "([^"]+)"/.exec(source)?.[1];
}

export function contractShape(dts: string): string {
  return dts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line !== "" && !line.includes("SURFACE_SDK_VERSION"))
    .join("\n");
}

export function sdkBumpMissing(baseDts: string, headDts: string): boolean {
  return contractShape(baseDts) !== contractShape(headDts) && sdkVersion(baseDts) === sdkVersion(headDts);
}

function gitShow(ref: string, path: string): string | undefined {
  const run = Bun.spawnSync(["git", "show", `${ref}:${path}`], { stdout: "pipe", stderr: "pipe" });
  return run.exitCode === 0 ? run.stdout.toString() : undefined;
}

if (import.meta.main) {
  const baseRef = process.env.RELEASE_PINS_BASE_REF ?? "origin/main";
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const problems = untaggedGitPins(
    { ...pkg.dependencies, ...pkg.devDependencies },
    PIN_EXCEPTIONS,
    new Date().toISOString().slice(0, 10),
  ).map((p) => `${p}. Pin a released tag (#vX.Y.Z), never a branch or commit.`);

  const baseDts = gitShow(baseRef, SDK_DTS);
  if (baseDts === undefined) {
    console.error(`release pins: cannot read ${SDK_DTS} at ${baseRef}. Fetch it first: git fetch origin main`);
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
