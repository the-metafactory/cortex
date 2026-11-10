import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");

export interface SdkDtsOptions {
  entry: string;
  artifact: string;
  label: string;
  header: string;
}

function generate(options: SdkDtsOptions): string {
  const bin = join(repoRoot, "node_modules/.bin/dts-bundle-generator");
  const outTmp = join(repoRoot, dirname(options.artifact), `.${options.label}.gen.tmp.d.ts`);
  mkdirSync(dirname(outTmp), { recursive: true });
  const res = spawnSync("node", [bin, "--no-check", "--no-banner", "--silent", "-o", outTmp, "--", options.entry], { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] });
  if (res.status !== 0) {
    process.stderr.write(`dts-bundle-generator failed (exit ${res.status})\n`);
    process.exit(res.status ?? 1);
  }
  const body = readFileSync(outTmp, "utf8").trimStart();
  spawnSync("rm", ["-f", outTmp]);
  return options.header + "\n" + body;
}

export function runSdkDts(options: SdkDtsOptions): void {
  const generated = generate(options);
  const artifact = join(repoRoot, options.artifact);
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(artifact, "utf8");
    } catch {
      current = "";
    }
    if (current !== generated) {
      process.stderr.write(`\n❌ ${options.artifact} is out of sync with ${options.entry}.\n   Run \`bun run ${options.label}:dts\` and commit the result.\n\n`);
      process.exit(1);
    }
    process.stdout.write(`✅ ${options.label} .d.ts artifact is in sync.\n`);
    return;
  }
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, generated);
  process.stdout.write(`✅ wrote ${options.artifact}\n`);
}
