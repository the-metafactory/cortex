import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { hermeticTestEnv } from "./lib/test-home";

const ROOT = resolve(import.meta.dir, "..");
const FIXTURES = join(ROOT, "src/conversations/domain-adapters/__tests__/fixtures/conformance-packages");
const GREENHOUSE = join(FIXTURES, "greenhouse");
const CONSUMER_TIMEOUT_MS = 15_000;
const TYPECHECK_TIMEOUT_MS = 60_000;
const CONSUMERS = ["run.ts", "run-mail.ts"] as const;
/** `run.ts` runs the capability and failure checks; `run-mail.ts` runs the synthetic `tideway` Mail read package with listed mail on three connections. */
export type ConformanceConsumer = (typeof CONSUMERS)[number];

export async function collect(proc: Subprocess<"ignore", "pipe", "pipe">, timeoutMs = CONSUMER_TIMEOUT_MS): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode: timedOut ? 124 : exitCode, stdout, stderr: timedOut ? `${stderr}\nConformance subprocess timed out after ${timeoutMs} ms.` : stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function runExternalConsumer(fixtureDir: string, argv: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), "desk-conformance-export-"));
  const packageDir = join(root, "adapter");
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  try {
    await cp(resolve(fixtureDir), packageDir, { recursive: true, dereference: false });
    for (const consumer of CONSUMERS) await cp(join(import.meta.dir, "fixtures/desk-conformance-export", consumer), join(packageDir, consumer));
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "external-desk-adapter-probe", private: true, type: "module" }));
    await mkdir(join(packageDir, "node_modules/@the-metafactory"), { recursive: true });
    await symlink(ROOT, join(packageDir, "node_modules/@the-metafactory/cortex"));
    await mkdir(home);
    await mkdir(tmp);
    const env = hermeticTestEnv(process.env, { home, tmp });
    const child = Bun.spawn([process.execPath, ...argv], {
      cwd: packageDir, env, stdout: "pipe", stderr: "pipe",
    });
    return await collect(child, timeoutMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function checkConformanceExportTypes(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await runExternalConsumer(GREENHOUSE, [join(ROOT, "node_modules/typescript/bin/tsc"), "--noEmit", "--skipLibCheck", "--module", "preserve", "--moduleResolution", "bundler", "--target", "esnext", "--types", join(ROOT, "node_modules/@types/bun"), ...CONSUMERS], TYPECHECK_TIMEOUT_MS);
}

export async function probeConformanceExport(fixtureDir = GREENHOUSE, consumer: ConformanceConsumer = "run.ts"): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await runExternalConsumer(fixtureDir, [consumer], CONSUMER_TIMEOUT_MS);
}

if (import.meta.main) {
  const mail = process.argv.includes("--mail");
  const fixture = process.argv.slice(2).find(arg => !arg.startsWith("--"));
  const result = process.argv[2] === "--typecheck" ? await checkConformanceExportTypes() : await probeConformanceExport(fixture, mail ? "run-mail.ts" : "run.ts");
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
