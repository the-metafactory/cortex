import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { collect } from "./probe-desk-conformance-export";
import { hermeticTestEnv } from "./lib/test-home";

const ROOT = resolve(import.meta.dir, "..");
const TYPECHECK_TIMEOUT_MS = 60_000;

interface DeskApiExportResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  emitted: Record<string, string>;
}

/** Type-checks `consumer` as an out-of-tree package that only has `import type` from the Desk API export, and returns what the compiler emitted. */
export async function checkDeskApiExport(fixtureDir = join(import.meta.dir, "fixtures/desk-api-export")): Promise<DeskApiExportResult> {
  const root = await mkdtemp(join(tmpdir(), "desk-api-export-"));
  const packageDir = join(root, "consumer");
  try {
    await cp(resolve(fixtureDir), packageDir, { recursive: true, dereference: false });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "external-desk-api-probe", private: true, type: "module" }));
    await mkdir(join(packageDir, "node_modules/@the-metafactory"), { recursive: true });
    await symlink(ROOT, join(packageDir, "node_modules/@the-metafactory/cortex"));
    const home = join(root, "home");
    const tmp = join(root, "tmp");
    await mkdir(home);
    await mkdir(tmp);
    const out = join(packageDir, "out");
    const child = Bun.spawn([process.execPath, join(ROOT, "node_modules/typescript/bin/tsc"), "--skipLibCheck", "--module", "preserve", "--moduleResolution", "bundler", "--target", "esnext", "--strict", "--outDir", out, "consumer.ts"], {
      cwd: packageDir, env: hermeticTestEnv(process.env, { home, tmp }), stdout: "pipe", stderr: "pipe",
    });
    const result = await collect(child, TYPECHECK_TIMEOUT_MS);
    const emitted: Record<string, string> = {};
    try {
      for (const name of await readdir(out)) emitted[name] = await readFile(join(out, name), "utf8");
    } catch (_err) {
      return { ...result, emitted };
    }
    return { ...result, emitted };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function importsCortex(emitted: Record<string, string>): string[] {
  return Object.entries(emitted).filter(([, source]) => /cortex/.test(source)).map(([name]) => name);
}

if (import.meta.main) {
  const result = await checkDeskApiExport();
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const leaked = importsCortex(result.emitted);
  if (result.exitCode === 0 && Object.keys(result.emitted).length === 0) {
    process.stderr.write("The consumer compiled to nothing; the probe did not run.\n");
    process.exit(1);
  }
  if (leaked.length > 0) {
    process.stderr.write(`Compiled output imports Cortex: ${leaked.join(", ")}\n`);
    process.exit(1);
  }
  process.exit(result.exitCode);
}
